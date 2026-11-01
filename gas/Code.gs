/**
 * 家計簿管理システム（支出・収入・貯金・カレンダー連携）
 * Google Apps Script バックエンド
 */

const BUDGET_CONFIG = {
  ACCESS_KEY: 'dd9cc131a5fa196f6d210e3ec6722668',
  SPREADSHEET_ID: '1VtdKwv2kQjPIMa_RNtY7Gdah_i02M5JDhyHtTq9RCa0',
  
  // バイト・TA給与計算設定
  KANESUE: {
    NAME: 'カネスエ',
    KEYWORD: 'カネスエ',
    BASE_HOURLY: 1050,
    ADD_17_18: 50,          // 17:00-18:00 (+50円)
    ADD_18_22: 100,         // 18:00-22:00 (+100円)
    LATE_NIGHT_RATE: 0.25,  // 22:00以降 深夜割増 +25% (1050 * 1.25 = 1,313円)
    SUNDAY_HOLIDAY_ADD: 100 // 日祝一律 +100円 (時間帯加給と重複適用)
  },
  TA: {
    NAME: '名大TA',
    KEYWORDS: ['TA', '演習', '講義補助'],
    HOURLY_WAGE: 1400       // 規定時給（1,400円/時）
  },
  
  // 基本予算デフォルト設定
  DEFAULT_BUDGET: {
    '食費': 30000,
    '自由（娯楽・雑費）': 25000,
    '家賃': 30000,
    '光熱費': 8000,
    'サブスク': 5000
  },
  LIVING_BUDGET_TOTAL: 98000
};

/**
 * スプレッドシート取得（コンテナバインド & スタンドアロン両対応）
 */
function getSpreadsheet() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(BUDGET_CONFIG.SPREADSHEET_ID);
  } catch (e) {
    return SpreadsheetApp.openById(BUDGET_CONFIG.SPREADSHEET_ID);
  }
}

/**
 * 数値パース用関数（Date型が混入しても誤変換しない堅牢仕様）
 */
function parseNum(val) {
  if (val instanceof Date) return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  if (Array.isArray(val)) val = val[0];
  const cleaned = String(val).replace(/[^\d.-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

/**
 * 同一収入源判定（「カネスエ」と「アルバイト」を同種として判定）
 */
function isSameIncomeSource(s1, s2) {
  const normalize = function(s) { return String(s || '').trim().toLowerCase(); };
  const n1 = normalize(s1);
  const n2 = normalize(s2);
  if (n1 === n2) return true;
  
  const isPartTime = function(s) {
    return s.indexOf('カネスエ') !== -1 || s.indexOf('アルバイト') !== -1 || s.indexOf('バイト') !== -1;
  };
  if (isPartTime(n1) && isPartTime(n2)) return true;

  const isTa = function(s) {
    return s.indexOf('ta') !== -1 || s.indexOf('演習') !== -1 || s.indexOf('講義補助') !== -1;
  };
  if (isTa(n1) && isTa(n2)) return true;

  return false;
}

/**
 * 確定状況の正規化判定（「銀行振込」「確定」「済」などは確定扱い）
 */
function isConfirmedStatus(statusStr) {
  const s = String(statusStr || '').trim();
  if (!s) return true; // 省略時は確定扱い
  if (s.indexOf('確定') !== -1 || s.indexOf('振込') !== -1 || s.indexOf('済') !== -1) {
    return true;
  }
  return false;
}

/**
 * Web App エントリポイント
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  // 0. アクセスキーチェック
  if (params.key !== BUDGET_CONFIG.ACCESS_KEY) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // カレンダー同期トリガーAPI (?type=sync)
  if (params.type === 'sync') {
    const today = new Date();
    const ymStr = params.month || Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy-MM');
    const syncRes = syncCalendarIncome(ymStr);
    return ContentService.createTextOutput(JSON.stringify({ success: true, result: syncRes }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 1. Androidウィジェット(KWGT)からのAPIリクエスト判定
  if (params.type === 'widget') {
    const today = new Date();
    const ymStr = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy年M月');
    const data = getDashboardData(ymStr);

    const foodCat = (data.categories || []).find(function(c) { return c.name === '食費'; }) || {};
    const freeCat = (data.categories || []).find(function(c) { return c.name.indexOf('自由') !== -1; }) || {};

    const widgetPayload = {
      month: data.month,
      remaining: data.livingRemaining,
      remainingFormatted: '¥' + Math.round(data.livingRemaining).toLocaleString('ja-JP'),
      actual: data.livingActual,
      actualFormatted: '¥' + Math.round(data.livingActual).toLocaleString('ja-JP'),
      budget: data.livingBudget,
      usage: (data.livingUsage || 0).toFixed(1) + '%',
      usageNum: Math.round(data.livingUsage || 0),
      foodRemaining: foodCat.remaining !== undefined ? foodCat.remaining : 0,
      foodRemainingFormatted: '¥' + Math.round(foodCat.remaining || 0).toLocaleString('ja-JP'),
      freeRemaining: freeCat.remaining !== undefined ? freeCat.remaining : 0,
      specialActual: data.specialActual || 0,
      totalIncome: data.totalIncome || 0,
      totalIncomeFormatted: '¥' + Math.round(data.totalIncome || 0).toLocaleString('ja-JP'),
      netBalance: data.netBalance || 0,
      netBalanceFormatted: (data.netBalance >= 0 ? '+¥' : '-¥') + Math.round(Math.abs(data.netBalance || 0)).toLocaleString('ja-JP'),
      totalSaved: data.totalSaved || 0,
      totalSavedFormatted: '¥' + Math.round(data.totalSaved || 0).toLocaleString('ja-JP'),
      updatedAt: Utilities.formatDate(today, 'Asia/Tokyo', 'HH:mm')
    };

    return ContentService.createTextOutput(JSON.stringify(widgetPayload))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 2. 外部フロントエンド（GitHub Pages等）からのJSON APIリクエスト
  if (params.month || params.type === 'json' || params.type === 'api' || params.format === 'json') {
    const targetMonth = params.month || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy年M月');
    const data = getDashboardData(targetMonth);
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 3. ブラウザ直接アクセス時HTMLダッシュボード描画
  const template = HtmlService.createTemplateFromFile('index');
  const now = new Date();
  const defaultYm = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy年M月');
  template.initialData = JSON.stringify(getDashboardData(defaultYm));
  return template.evaluate()
    .setTitle('支出・予算・収入ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 日本の祝日判定
 */
function isJapaneseHoliday(date) {
  try {
    const cal = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
    if (!cal) return false;
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);
    const events = cal.getEvents(start, end);
    return events.length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * カネスエの1シフト給与計算（1分単位スライス厳密計算）
 */
function calculateKanesueShiftWage(startTime, endTime, isHolidayOrSunday) {
  let totalWage = 0;
  let cur = new Date(startTime.getTime());
  const end = new Date(endTime.getTime());
  let totalMinutes = 0;

  while (cur < end) {
    const hours = cur.getHours();
    let hourlyWage = BUDGET_CONFIG.KANESUE.BASE_HOURLY;

    if (hours >= 22 || hours < 5) {
      hourlyWage = Math.round(BUDGET_CONFIG.KANESUE.BASE_HOURLY * (1 + BUDGET_CONFIG.KANESUE.LATE_NIGHT_RATE));
    } else if (hours >= 18) {
      hourlyWage += BUDGET_CONFIG.KANESUE.ADD_18_22;
    } else if (hours >= 17) {
      hourlyWage += BUDGET_CONFIG.KANESUE.ADD_17_18;
    }

    if (isHolidayOrSunday) {
      hourlyWage += BUDGET_CONFIG.KANESUE.SUNDAY_HOLIDAY_ADD;
    }

    totalWage += hourlyWage / 60;
    totalMinutes++;
    cur.setMinutes(cur.getMinutes() + 1);
  }

  return {
    wage: Math.round(totalWage),
    totalMinutes: totalMinutes
  };
}

/**
 * TAの1シフト給与計算
 */
function calculateTAShiftWage(startTime, endTime) {
  const diffMinutes = Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60));
  const wage = Math.round(diffMinutes * (BUDGET_CONFIG.TA.HOURLY_WAGE / 60));
  return {
    wage: wage,
    totalMinutes: diffMinutes
  };
}

/**
 * Googleカレンダーから予定を抽出して給与計算
 */
function getCalendarIncomeForMonth(year, month) {
  const startDate = new Date(year, month - 1, 1, 0, 0, 0);
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = new Date(year, month - 1, lastDay, 23, 59, 59);

  let calendar = null;
  try {
    calendar = CalendarApp.getDefaultCalendar();
  } catch (e) {
    Logger.log('カレンダー取得エラー: ' + e.message);
    return { kanesue: { wage: 0, minutes: 0, count: 0 }, ta: { wage: 0, minutes: 0, count: 0 } };
  }

  const events = calendar.getEvents(startDate, endDate);

  let kanesueTotalWage = 0;
  let kanesueTotalMinutes = 0;
  let kanesueCount = 0;

  let taTotalWage = 0;
  let taTotalMinutes = 0;
  let taCount = 0;

  const holidayCache = {};

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.isAllDayEvent()) continue;

    const title = ev.getTitle() || '';
    const evStart = ev.getStartTime();
    const evEnd = ev.getEndTime();

    if (title.indexOf(BUDGET_CONFIG.KANESUE.KEYWORD) !== -1) {
      const dateKey = Utilities.formatDate(evStart, 'Asia/Tokyo', 'yyyy-MM-dd');
      if (holidayCache[dateKey] === undefined) {
        holidayCache[dateKey] = (evStart.getDay() === 0) || isJapaneseHoliday(evStart);
      }
      const isSunOrHol = holidayCache[dateKey];
      const shiftRes = calculateKanesueShiftWage(evStart, evEnd, isSunOrHol);
      kanesueTotalWage += shiftRes.wage;
      kanesueTotalMinutes += shiftRes.totalMinutes;
      kanesueCount++;
    } else {
      let isTa = false;
      for (let k = 0; k < BUDGET_CONFIG.TA.KEYWORDS.length; k++) {
        if (title.indexOf(BUDGET_CONFIG.TA.KEYWORDS[k]) !== -1) {
          isTa = true;
          break;
        }
      }
      if (isTa) {
        const taRes = calculateTAShiftWage(evStart, evEnd);
        taTotalWage += taRes.wage;
        taTotalMinutes += taRes.totalMinutes;
        taCount++;
      }
    }
  }

  return {
    kanesue: {
      wage: kanesueTotalWage,
      minutes: kanesueTotalMinutes,
      count: kanesueCount,
      hoursText: Math.floor(kanesueTotalMinutes / 60) + '時間' + (kanesueTotalMinutes % 60) + '分'
    },
    ta: {
      wage: taTotalWage,
      minutes: taTotalMinutes,
      count: taCount,
      hoursText: Math.floor(taTotalMinutes / 60) + '時間' + (taTotalMinutes % 60) + '分'
    }
  };
}

/**
 * カレンダーから計算した給与を「収入明細」シートに自動反映（重複排除・自動クリーンアップ付きUpsert）
 */
function syncCalendarIncome(targetYmStr) {
  let year, month;
  if (!targetYmStr) {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  } else {
    const m = targetYmStr.match(/(\d{4})[-年](\d{1,2})/);
    if (m) {
      year = parseInt(m[1], 10);
      month = parseInt(m[2], 10);
    } else {
      const now = new Date();
      year = now.getFullYear();
      month = now.getMonth() + 1;
    }
  }

  const ymPadded = year + '-' + (month < 10 ? '0' + month : month);
  const lastDay = new Date(year, month, 0).getDate();
  const entryDateStr = ymPadded + '-' + (lastDay < 10 ? '0' + lastDay : lastDay);

  const calcResult = getCalendarIncomeForMonth(year, month);
  const ss = getSpreadsheet();
  let incomeSheet = ss.getSheetByName('収入明細');

  if (!incomeSheet) {
    incomeSheet = ss.insertSheet('収入明細');
    incomeSheet.appendRow(['日付', '収入源', '金額', '種別', '確定状況', '備考']);
  }

  const values = incomeSheet.getDataRange().getValues();

  const updates = [
    {
      source: 'カネスエ',
      wage: calcResult.kanesue.wage,
      note: 'カレンダー自動算出: ' + calcResult.kanesue.count + 'シフト (' + calcResult.kanesue.hoursText + ')'
    },
    {
      source: '名大TA',
      wage: calcResult.ta.wage,
      note: 'カレンダー自動算出: ' + calcResult.ta.count + 'コマ/回 (' + calcResult.ta.hoursText + ')'
    }
  ];

  const results = [];
  const rowsToDelete = [];

  updates.forEach(function(item) {
    if (item.wage === 0) return;

    let hasConfirmedRow = false;
    let estimateRowIndices = [];

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      let rowDateStr = '';
      if (row[0] instanceof Date) {
        rowDateStr = Utilities.formatDate(row[0], 'Asia/Tokyo', 'yyyy-MM-dd');
      } else {
        rowDateStr = String(row[0] || '').trim();
      }
      const rowSource = String(row[1] || '').trim();
      const rowStatus = String(row[4] || '').trim();

      // 同じ年月かつ同種の収入源（「カネスエ」と「アルバイト」を同種と判定）
      if (rowDateStr.indexOf(ymPadded) === 0 && isSameIncomeSource(rowSource, item.source)) {
        if (isConfirmedStatus(rowStatus)) {
          hasConfirmedRow = true;
        } else {
          estimateRowIndices.push(r + 1); // 1-indexed
        }
      }
    }

    // すでに手動等で確定済み（銀行振込含む）行がある場合：
    // 重複して見込行が存在しているなら、その見込行を削除して確定側に一本化！
    if (hasConfirmedRow) {
      estimateRowIndices.forEach(function(idx) {
        rowsToDelete.push(idx);
      });
      results.push('Skipped ' + item.source + ' (すでに確定済み給与があるため見込重複を排除)');
    } else if (estimateRowIndices.length > 0) {
      // 最初の見込行を最新計算値で更新
      const firstIdx = estimateRowIndices[0];
      incomeSheet.getRange(firstIdx, 3).setValue(item.wage);
      incomeSheet.getRange(firstIdx, 5).setValue('見込');
      incomeSheet.getRange(firstIdx, 6).setValue(item.note);
      results.push('Updated ' + item.source + ' in row ' + firstIdx + ' (¥' + item.wage + ')');

      // 2件目以降の見込重複行があれば削除対象へ
      for (let d = 1; d < estimateRowIndices.length; d++) {
        rowsToDelete.push(estimateRowIndices[d]);
      }
    } else {
      // 確定も既存見込もなければ新規追加
      incomeSheet.appendRow([
        entryDateStr,
        item.source,
        item.wage,
        '給与',
        '見込',
        item.note
      ]);
      results.push('Inserted ' + item.source + ' (¥' + item.wage + ')');
    }
  });

  // 重複行を下から順に削除
  rowsToDelete.sort(function(a, b) { return b - a; });
  const uniqueRowsToDelete = Array.from(new Set(rowsToDelete));
  uniqueRowsToDelete.forEach(function(rowIdx) {
    try {
      incomeSheet.deleteRow(rowIdx);
      results.push('Deleted duplicate estimate row: ' + rowIdx);
    } catch (e) {}
  });

  return { ym: ymPadded, calcResult: calcResult, logs: results };
}

/**
 * ダッシュボードシートの安全な更新
 */
function syncDashboardSheet(targetMonth) {
  const data = getDashboardData(targetMonth);
  const ss = getSpreadsheet();
  const dashSheet = ss.getSheetByName('ダッシュボード') || ss.getSheetByName('月別サマリー');
  if (!dashSheet) return;

  const values = dashSheet.getDataRange().getValues();

  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      const cellText = String(values[r][c] || '').trim();

      if (cellText === '総収入') {
        dashSheet.getRange(r + 1, c + 2).setValue(data.totalIncome);
      } else if (cellText === '当月収支' || cellText === '実質収支') {
        dashSheet.getRange(r + 1, c + 2).setValue(data.netBalance);
      } else if (cellText === '総支出') {
        dashSheet.getRange(r + 1, c + 2).setValue(data.totalOutflow);
      } else if (cellText === '生活費実績') {
        dashSheet.getRange(r + 1, c + 2).setValue(data.livingActual);
      } else if (cellText === '特別費実績') {
        dashSheet.getRange(r + 1, c + 2).setValue(data.specialActual);
      }
    }
  }
}

/**
 * 定期実行用トリガー関数（日次/週次）
 */
function autoSyncDaily() {
  const today = new Date();
  const ymStr = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy-MM');
  syncCalendarIncome(ymStr);
  syncDashboardSheet();
}

/**
 * ダッシュボードデータ動的集計関数（支出・収入・貯金積立を完全統合＆重複排除）
 */
function getDashboardData(targetMonth) {
  if (!targetMonth) targetMonth = '2026年9月';

  const mMatch = targetMonth.match(/(\d{4})年(\d{1,2})月/);
  const targetYm = mMatch ? (mMatch[1] + '-' + (mMatch[2].length === 1 ? '0' + mMatch[2] : mMatch[2])) : '2026-09';

  const ss = getSpreadsheet();

  // 1. 基本予算マスター
  const summarySheet = ss.getSheetByName('ダッシュボード') || ss.getSheetByName('月別サマリー');
  const sumValues = summarySheet ? summarySheet.getDataRange().getValues() : [];
  const budgetConfig = Object.assign({}, BUDGET_CONFIG.DEFAULT_BUDGET);

  for (let i = 0; i < sumValues.length; i++) {
    if (sumValues[i][0] === 'カテゴリ' && sumValues[i][1] === '予算') {
      for (let r = i + 1; r < sumValues.length; r++) {
        const catName = String(sumValues[r][0] || '').trim();
        const bVal = parseNum(sumValues[r][1]);
        if (catName && bVal > 0) {
          budgetConfig[catName] = bVal;
        }
      }
      break;
    }
  }

  // 2. 支出明細
  const detailSheet = ss.getSheetByName('支出明細');
  const detailValues = detailSheet ? detailSheet.getDataRange().getValues() : [];
  const expenses = [];

  const catActuals = {
    '食費': 0,
    '自由（娯楽・雑費）': 0,
    '家賃': 0,
    '光熱費': 0,
    'サブスク': 0
  };
  let specialActual = 0;

  for (let i = 1; i < detailValues.length; i++) {
    const row = detailValues[i];
    const dateVal = row[0];
    const store = String(row[1] || '').trim();
    const amt = parseNum(row[2]);
    const cat = String(row[3] || '').trim();
    const method = String(row[4] || '').trim();
    const note = String(row[7] || '').trim();

    if (!dateVal && amt === 0) continue;

    let dateStr = '';
    if (dateVal instanceof Date) {
      dateStr = Utilities.formatDate(dateVal, 'Asia/Tokyo', 'yyyy-MM-dd');
    } else {
      dateStr = String(dateVal).trim();
    }

    if (dateStr.indexOf(targetYm) !== 0) continue;

    let parentCat = cat;
    if (cat === '食費' || cat === '外食') {
      parentCat = '食費';
      catActuals['食費'] += amt;
    } else if (['日用品', 'その他', '衣服・美容', '研究・書籍'].indexOf(cat) !== -1) {
      parentCat = '自由（娯楽・雑費）';
      catActuals['自由（娯楽・雑費）'] += amt;
    } else if (cat.indexOf('特別費') !== -1) {
      parentCat = '特別費';
      specialActual += amt;
    } else if (cat === '家賃') {
      catActuals['家賃'] += amt;
    } else if (cat === '光熱費' || cat.indexOf('水道光熱') !== -1) {
      catActuals['光熱費'] += amt;
    } else if (cat === 'サブスク') {
      catActuals['サブスク'] += amt;
    }

    expenses.push({
      date: dateStr,
      store: store,
      amount: amt,
      category: cat,
      parentCat: parentCat,
      method: method,
      note: note
    });
  }

  // 9月の家賃固定費の補完
  if (targetYm === '2026-09' && catActuals['家賃'] === 0) {
    catActuals['家賃'] = 28270;
  }

  const categoryNames = ['食費', '自由（娯楽・雑費）', '家賃', '光熱費', 'サブスク'];
  const categories = categoryNames.map(function(name) {
    const budget = budgetConfig[name] || 0;
    const actual = catActuals[name] || 0;
    const remaining = budget - actual;
    const usage = budget > 0 ? (actual / budget) * 100 : 0;
    return {
      name: name,
      budget: budget,
      actual: actual,
      remaining: remaining,
      usage: usage
    };
  });

  const livingBudget = BUDGET_CONFIG.LIVING_BUDGET_TOTAL;
  const livingActual = categories.reduce(function(sum, c) { return sum + c.actual; }, 0);
  const totalOutflow = livingActual + specialActual;

  // 3. 収入明細（二重計上防止ロジック）
  const incomeSheet = ss.getSheetByName('収入明細');
  const incomeValues = incomeSheet ? incomeSheet.getDataRange().getValues() : [];
  const rawIncomes = [];

  for (let r = 1; r < incomeValues.length; r++) {
    const row = incomeValues[r];
    const dateVal = row[0];
    const source = String(row[1] || '').trim();
    const amt = parseNum(row[2]);
    const type = String(row[3] || '').trim();
    const rawStatus = String(row[4] || '').trim();
    const note = String(row[5] || '').trim();

    if (!dateVal && amt === 0) continue;

    let dateStr = '';
    if (dateVal instanceof Date) {
      dateStr = Utilities.formatDate(dateVal, 'Asia/Tokyo', 'yyyy-MM-dd');
    } else {
      dateStr = String(dateVal).trim();
    }

    if (dateStr.indexOf(targetYm) !== 0) continue;

    const isConfirmed = isConfirmedStatus(rawStatus);

    rawIncomes.push({
      date: dateStr,
      source: source,
      amount: amt,
      type: type,
      status: isConfirmed ? '確定' : '見込',
      rawStatus: rawStatus,
      isConfirmed: isConfirmed,
      note: note
    });
  }

  // 同一月内の「バイト/カネスエ」や「TA」の重複を判定
  // すでに「確定」がある場合、同種の「見込」は二重計上から除外！
  const confirmedPartTime = rawIncomes.find(function(x) {
    return x.isConfirmed && (x.source.indexOf('カネスエ') !== -1 || x.source.indexOf('アルバイト') !== -1 || x.source.indexOf('バイト') !== -1);
  });
  const confirmedTA = rawIncomes.find(function(x) {
    return x.isConfirmed && (x.source.indexOf('TA') !== -1 || x.source.indexOf('演習') !== -1);
  });

  const filteredIncomes = rawIncomes.filter(function(item) {
    // 確定済みバイトがあるのに、見込バイト（カレンダー自動算出など）があれば除外
    if (!item.isConfirmed && confirmedPartTime && (item.source.indexOf('カネスエ') !== -1 || item.source.indexOf('アルバイト') !== -1 || item.source.indexOf('バイト') !== -1)) {
      return false;
    }
    // 確定済みTAがあるのに、見込TAがあれば除外
    if (!item.isConfirmed && confirmedTA && (item.source.indexOf('TA') !== -1 || item.source.indexOf('演習') !== -1)) {
      return false;
    }
    return true;
  });

  let totalIncome = 0;
  let confirmedIncome = 0;
  let estimatedIncome = 0;

  filteredIncomes.forEach(function(item) {
    totalIncome += item.amount;
    if (item.isConfirmed) {
      confirmedIncome += item.amount;
    } else {
      estimatedIncome += item.amount;
    }
  });

  // 4. 貯金・積立管理（ヘッダー動的マッピング & 正しい列パース）
  const savingSheet = ss.getSheetByName('貯金・積立管理');
  const savingValues = savingSheet ? savingSheet.getDataRange().getValues() : [];
  const savings = [];
  let totalSaved = 0;
  let totalTarget = 0;
  let monthlySavingTotal = 0;

  if (savingValues.length > 0) {
    const headers = savingValues[0].map(function(h) { return String(h || '').trim(); });
    
    let nameIdx = headers.findIndex(function(h) { return /項目|目的|名前/.test(h); });
    let targetIdx = headers.findIndex(function(h) { return /目標金額|目標額/.test(h); });
    let currentIdx = headers.findIndex(function(h) { return /現在積立額|現在積立|現在額|積立額/.test(h); });
    let etaIdx = headers.findIndex(function(h) { return /目標日|達成予定|期日|期限/.test(h); });
    let remainIdx = headers.findIndex(function(h) { return /残必要額|残り|残額/.test(h); });
    let rateIdx = headers.findIndex(function(h) { return /達成率|進捗率/.test(h); });
    let monthlyIdx = headers.findIndex(function(h) { return /毎月積立目安|毎月目安|月額/.test(h); });

    // スプレッドシートの実態に基づくフォールバック: [目的, 目標額, 目標日, 現在積立額, 残必要額, 達成率]
    if (nameIdx === -1) nameIdx = 0;
    if (targetIdx === -1) targetIdx = 1;
    if (etaIdx === -1) etaIdx = 2;
    if (currentIdx === -1) currentIdx = 3;
    if (remainIdx === -1) remainIdx = 4;
    if (rateIdx === -1) rateIdx = 5;

    for (let s = 1; s < savingValues.length; s++) {
      const row = savingValues[s];
      const name = String(row[nameIdx] || '').trim();
      if (!name) continue;

      const targetAmt = parseNum(row[targetIdx]);
      const currentAmt = parseNum(row[currentIdx]);
      const monthlyTarget = monthlyIdx !== -1 ? parseNum(row[monthlyIdx]) : 0;

      let eta = '';
      if (etaIdx !== -1 && row[etaIdx]) {
        if (row[etaIdx] instanceof Date) {
          eta = Utilities.formatDate(row[etaIdx], 'Asia/Tokyo', 'yyyy/MM/dd');
        } else {
          eta = String(row[etaIdx]).trim();
        }
      }

      let progressRate = 0;
      if (rateIdx !== -1 && row[rateIdx] !== undefined && row[rateIdx] !== '') {
        const rVal = parseNum(row[rateIdx]);
        progressRate = (rVal <= 1 && rVal > 0) ? (rVal * 100) : rVal;
      } else if (targetAmt > 0) {
        progressRate = (currentAmt / targetAmt) * 100;
      }

      totalSaved += currentAmt;
      totalTarget += targetAmt;
      monthlySavingTotal += monthlyTarget;

      let noteText = '';
      if (remainIdx !== -1 && row[remainIdx]) {
        noteText = '残り ¥' + parseNum(row[remainIdx]).toLocaleString('ja-JP');
      }

      savings.push({
        name: name,
        targetAmount: targetAmt,
        currentAmount: currentAmt,
        monthlyTarget: monthlyTarget,
        progressRate: Math.min(100, Math.round(progressRate * 10) / 10),
        eta: eta,
        note: noteText
      });
    }
  }

  // 4.5 栄養推測（直近14日・月次集計とは独立。失敗してもダッシュボード本体は壊さない）
  let nutrition = null;
  try {
    nutrition = getNutritionInfo(ss, detailValues);
  } catch (e) {
    nutrition = {
      windowDays: NUTRITION_WINDOW_DAYS, error: true,
      coverage: { foodExpenseCount: 0, withItemsCount: 0, ratio: 0 },
      eatingOutCount: 0, groups: [], deficits: [], unclassified: []
    };
  }

  // 5. 当月収支
  const netBalance = totalIncome - totalOutflow;
  const livingBalance = totalIncome - livingActual;

  return {
    month: targetMonth,
    updatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm'),
    livingBudget: livingBudget,
    livingActual: livingActual,
    livingRemaining: livingBudget - livingActual,
    livingUsage: livingBudget > 0 ? (livingActual / livingBudget) * 100 : 0,
    specialActual: specialActual,
    totalOutflow: totalOutflow,
    categories: categories,
    expenses: expenses,
    totalIncome: totalIncome,
    confirmedIncome: confirmedIncome,
    estimatedIncome: estimatedIncome,
    incomes: filteredIncomes,
    netBalance: netBalance,
    livingBalance: livingBalance,
    savings: savings,
    totalSaved: totalSaved,
    totalTarget: totalTarget,
    monthlySavingTotal: monthlySavingTotal,
    nutrition: nutrition
  };
}
// ===== 栄養推測 (pure) START =====
// レシート（購入品目）から食品群の偏りを推測する機能。
// 仕様: workspace/kakeibo-nutrition/SPEC_v0.1.md
// この区間は SpreadsheetApp / Utilities に依存しない純粋関数のみで構成し、
// ローカルでテストできるようにする（tests/nutrition.test.js がこの区間を抽出して実行する）。

const NUTRITION_WINDOW_DAYS = 14;
const NUTRITION_COVERAGE_MIN = 0.5;

const FOOD_GROUPS = [
  { id: 'staple',    label: '主食',                 target: 2, suggestion: '米や食パンなど主食を1つ買い足す' },
  { id: 'meat',      label: '肉',                   target: 2, suggestion: '鶏むね肉など安い肉を1パック' },
  { id: 'fish',      label: '魚介',                 target: 2, suggestion: 'サバ缶か鮭の切り身を1つ。缶詰なら買い置きできる' },
  { id: 'egg',       label: '卵',                   target: 1, suggestion: '卵1パック。安くて使い回しがきく' },
  { id: 'soy',       label: '大豆製品',             target: 2, suggestion: '納豆か豆腐を1つ。賞味期限が短い豆腐より納豆が楽' },
  { id: 'veg_green', label: '緑黄色野菜',           target: 3, suggestion: '冷凍ほうれん草かブロッコリー。冷凍なら無駄にならない' },
  { id: 'veg_other', label: 'その他野菜・きのこ・海藻', target: 3, suggestion: 'もやし・キャベツ等の安い野菜を1つ' },
  { id: 'fruit',     label: '果物',                 target: 1, suggestion: 'バナナ1房。最も安くて手間ゼロ' },
  { id: 'dairy',     label: '乳製品',               target: 2, suggestion: 'ヨーグルトか牛乳を1つ' },
  { id: 'composite', label: '複合食品',             target: 0, suggestion: '' }
];

// 不足表示の優先順（同条件なら「次の一手」が実行しやすい群を先に）
const FOOD_DEFICIT_PRIORITY = ['fish', 'veg_green', 'soy', 'dairy', 'fruit', 'egg', 'meat', 'veg_other', 'staple'];

// 非食品（日用品など）。最優先で除外する
const FOOD_EXCLUDE_HARD = [
  '洗剤', 'シャンプー', 'リンス', 'トリートメント', 'ティッシュ', 'トイレットペーパー', '電池',
  'ゴミ袋', 'ごみ袋', 'ラップ', 'アルミホイル', 'スポンジ', 'ハンドソープ', 'ボディソープ',
  '歯磨き', '歯ブラシ', 'マスク', '除菌', '漂白', '柔軟剤', '石鹸', '石けん', 'ウェット',
  'ドッグフード', 'キャットフード', 'ペットフード', '猫砂', '消臭', '芳香剤', '殺虫', '絆創膏'
];

// 複合食品（弁当・総菜・インスタント等）。中身が分からないので群には数えない
const FOOD_COMPOSITE = [
  '弁当', '幕の内', 'のり弁', 'おにぎり', 'サンドイッチ', 'サンド', 'カップ麺', 'カップヌードル',
  'インスタント', 'レトルト', '魚肉ソーセージ', 'ピザ', '餃子', '焼売', 'シュウマイ', '春巻き',
  '総菜', '惣菜', '唐揚げ', 'から揚げ', 'コロッケ', 'とんかつ', 'トンカツ', 'ハンバーグ',
  'ポテトサラダ', 'マカロニサラダ', '豚汁', '味噌汁', 'けんちん汁', '冷凍餃子', '冷凍パスタ',
  'フライ', '肉まん', '豚まん',
  '冷凍ピザ', 'グラタン', 'ドリア', 'チャーハン', '炒飯', '焼きそば', 'ナポリタン', 'ミートソース'
];

// 調味料・菓子・飲料。複合食品の判定の後に除外する（「味噌汁」を味噌より先に複合へ回すため）
const FOOD_EXCLUDE_SOFT = [
  '醤油', 'しょうゆ', '味噌', '塩', '砂糖', 'みりん', '料理酒', '酢', 'ソース', 'ケチャップ',
  'マヨネーズ', 'ドレッシング', 'サラダ油', 'ごま油', 'オリーブオイル', 'めんつゆ', 'だし', '出汁',
  'コンソメ', 'カレールー', '香辛料', 'スパイス', 'わさび', 'からし', '七味', '胡椒', 'コショウ',
  'チョコ', 'クッキー', 'ポテトチップス', 'チップス', 'スナック', 'キャンディ', '飴', 'ガム',
  'プリン', 'ゼリー', 'アイス', 'アイスクリーム', 'ケーキ', 'ドーナツ', '菓子', 'メロンパン',
  '菓子パン', 'あんパン', 'カレーパン', 'ジャム', 'はちみつ', '蜂蜜',
  'コーヒー', '紅茶', '緑茶', '麦茶', '烏龍茶', 'ウーロン茶', 'お茶', 'ジュース', 'コーラ',
  'サイダー', '炭酸', 'ビール', 'ワイン', '日本酒', '焼酎', 'チューハイ', 'ハイボール',
  'エナジードリンク', 'ミネラルウォーター', '天然水', '米油', '鶏ガラ', 'ごぼう茶', 'コーン茶'
];

// 群別キーワード辞書。最長一致で判定するので、紛らわしい語は長い形で登録する
const FOOD_DICT = {
  staple: [
    '食パン', 'うどん', 'そば', '蕎麦', 'パスタ', 'スパゲッティ', 'スパゲティ', 'オートミール',
    'シリアル', 'グラノーラ', '米粉', '白米', '玄米', 'もち米', '餅', 'ご飯', 'ごはん',
    'ラーメン', '中華麺', 'そうめん', '素麺', 'ひやむぎ', '冷麦', 'パン', '米'
  ],
  meat: [
    'サラダチキン', '豚こま', '豚バラ', '豚ロース', '豚ヒレ', '豚肉', '牛肉', '牛こま', '牛バラ',
    '鶏むね', '鶏もも', '鶏肉', '手羽', 'ささみ', 'ササミ', '砂肝', 'ひき肉', '挽き肉', '合いびき',
    '合挽き', 'ミンチ', 'ハム', 'ベーコン', 'ソーセージ', 'ウインナー', 'ウィンナー', 'チャーシュー',
    'ローストビーフ', 'スペアリブ', 'レバー', 'ホルモン', '焼肉', 'ステーキ肉', 'しゃぶしゃぶ肉',
    '豚', '鶏'
  ],
  fish: [
    '魚肉', '鮭', 'サケ', 'サーモン', 'サバ', '鯖', 'アジ', '鯵', 'イワシ', '鰯', 'サンマ', '秋刀魚',
    'ブリ', '鰤', 'マグロ', '鮪', 'カツオ', '鰹', 'ツナ', 'シーチキン', 'タラ', '鱈', 'カレイ',
    'ヒラメ', 'タイ', '鯛', 'イカ', 'タコ', 'エビ', '海老', 'カニ', '蟹', 'ホタテ', '帆立',
    'アサリ', 'シジミ', 'ハマグリ', 'ちくわ', 'チクワ', 'かまぼこ', 'カマボコ', 'はんぺん',
    'さつま揚げ', 'しらす', 'シラス', 'ちりめん', '明太子', 'たらこ', 'タラコ', 'いくら', 'イクラ',
    'ししゃも', 'シシャモ', 'サワラ', '鰆', 'アユ', '鮎', '穴子', 'ウナギ', '鰻', 'キス', 'ワカサギ',
    '刺身', '切り身', '干物', '塩鮭', '鮭フレーク'
  ],
  egg: ['卵', 'たまご', 'タマゴ', 'エッグ', 'うずら'],
  soy: [
    '豆乳', '納豆', '豆腐', '絹ごし', '木綿豆腐', '厚揚げ', '油揚げ', '枝豆', 'エダマメ',
    '大豆', 'おから', '高野豆腐', 'がんも', '湯葉', 'きなこ', '黄粉'
  ],
  veg_green: [
    'ほうれん草', 'ホウレン草', 'ブロッコリー', 'にんじん', 'ニンジン', '人参', 'ピーマン',
    'パプリカ', 'かぼちゃ', 'カボチャ', '南瓜', 'トマト', 'ミニトマト', '小松菜', 'チンゲン菜',
    'ニラ', 'オクラ', 'アスパラ', '春菊', 'しそ', '大葉', 'モロヘイヤ', 'ツルムラサキ', '菜の花',
    'ブロッコリースプラウト', 'グリーンリーフ', 'サニーレタス', '水菜', 'ルッコラ', 'ケール', '芽キャベツ'
  ],
  veg_other: [
    'カット野菜', 'もやし', 'モヤシ', 'キャベツ', 'レタス', 'きゅうり', 'キュウリ', '大根', 'ダイコン',
    '玉ねぎ', 'タマネギ', '玉葱', 'じゃがいも', 'ジャガイモ', '馬鈴薯', '白菜', 'ハクサイ', 'なす',
    'ナス', 'ねぎ', 'ネギ', '長ねぎ', '長ネギ', 'ごぼう', 'ゴボウ', 'れんこん', 'レンコン',
    'さつまいも', 'サツマイモ', '里芋', 'ながいも', '長芋', '山芋', 'セロリ', 'カリフラワー',
    'とうもろこし', 'トウモロコシ', 'コーン', 'しいたけ', 'シイタケ', '椎茸', 'しめじ', 'シメジ',
    'えのき', 'エノキ', 'まいたけ', 'マイタケ', 'エリンギ', 'なめこ', 'ナメコ', 'きのこ', 'キノコ',
    'わかめ', 'ワカメ', 'ひじき', 'ヒジキ', 'のり', '海苔', '昆布', 'もずく', 'モズク', 'めかぶ',
    '海藻', '大豆もやし', 'かいわれ', '豆苗', 'ズッキーニ', 'みょうが', '生姜', 'しょうが', 'にんにく'
  ],
  fruit: [
    'バナナ', 'りんご', 'リンゴ', '林檎', 'みかん', 'ミカン', 'オレンジ', 'レモン', 'キウイ',
    'いちご', 'イチゴ', '苺', 'ぶどう', 'ブドウ', '葡萄', '梨', 'なし', '桃', 'モモ', 'メロン',
    'スイカ', '西瓜', 'パイナップル', 'パイン', 'マンゴー', 'さくらんぼ', 'サクランボ', '柿', 'カキ',
    'ブルーベリー', 'グレープフルーツ', 'シャインマスカット', 'マスカット', 'キンカン', '金柑',
    'びわ', 'いちじく', 'ラズベリー', 'ベリー'
  ],
  dairy: [
    '牛乳', 'ヨーグルト', 'チーズ', 'バター', '生クリーム', 'ホイップ', '練乳', '粉ミルク',
    'モッツァレラ', 'パルメザン', 'ゴーダ', 'カマンベール', 'クリームチーズ', 'ミルク'
  ]
};

// 最長一致用のフラットな辞書（初期化時に長さ降順ソート）
const FOOD_DICT_FLAT = (function() {
  const entries = [];
  Object.keys(FOOD_DICT).forEach(function(groupId) {
    FOOD_DICT[groupId].forEach(function(kw) { entries.push({ kw: kw, group: groupId }); });
  });
  entries.sort(function(a, b) { return b.kw.length - a.kw.length; });
  return entries;
})();

const FOOD_GROUP_BY_ID = (function() {
  const map = {};
  FOOD_GROUPS.forEach(function(g) { map[g.id] = g; });
  return map;
})();

function normalizeFoodName(rawName) {
  let s = String(rawName || '').trim();
  if (!s) return '';
  try { s = s.normalize('NFKC'); } catch (e) { /* 古いランタイムではそのまま */ }
  s = s.replace(/[\s　・,，、]/g, '');
  return s;
}

function containsAny_(name, keywords) {
  for (let i = 0; i < keywords.length; i++) {
    if (name.indexOf(keywords[i]) !== -1) return true;
  }
  return false;
}

/**
 * 品目名を食品群に分類する。
 * 戻り値: 群ID / 'composite' / 'excluded' / 'unclassified'
 * 優先順位: 非食品(強) → 複合食品 → 調味料・菓子・飲料(弱) → 群辞書の最長一致
 */
function classifyFoodItem(rawName) {
  const name = normalizeFoodName(rawName);
  if (!name) return 'unclassified';
  // 例外: サラダチキンは「サラダ」を含むが肉として数える
  if (name.indexOf('サラダチキン') !== -1) return 'meat';
  if (containsAny_(name, FOOD_EXCLUDE_HARD)) return 'excluded';
  if (containsAny_(name, FOOD_COMPOSITE)) return 'composite';
  if (containsAny_(name, FOOD_EXCLUDE_SOFT)) return 'excluded';
  for (let i = 0; i < FOOD_DICT_FLAT.length; i++) {
    if (name.indexOf(FOOD_DICT_FLAT[i].kw) !== -1) return FOOD_DICT_FLAT[i].group;
  }
  return 'unclassified';
}

// 'yyyy-MM-dd' に日数を加減する（UTC基準で計算し、文字列比較可能な形式で返す）
function nutritionDateAdd_(dateStr, deltaDays) {
  const parts = String(dateStr).split('-');
  const d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10) + deltaDays));
  const y = d.getUTCFullYear();
  const m = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  const day = ('0' + d.getUTCDate()).slice(-2);
  return y + '-' + m + '-' + day;
}

// 備考欄がカンマ区切りの品目リストらしい場合にトークンへ分解する。通常の文章は対象にしない
function parseNoteItems_(note) {
  const s = String(note || '').trim();
  if (!s) return [];
  const hasComma = /[,，]/.test(s);
  const hasJpComma = s.indexOf('、') !== -1 && s.length <= 50 && s.indexOf('。') === -1;
  if (!hasComma && !hasJpComma) return [];
  return s.split(/[,，、]/).map(function(t) { return t.trim(); })
    .filter(function(t) { return t.length >= 1 && t.length <= 30; });
}

/**
 * 栄養集計の本体（純粋関数）。
 * expenses: [{date:'yyyy-MM-dd', store, amount, category, note}]
 * items:    [{date:'yyyy-MM-dd', store, name, qty, manual}]  manualは群IDまたは群ラベル（手直し優先）
 * todayStr: 'yyyy-MM-dd'（Asia/Tokyoの今日）
 */
function buildNutrition(expenses, items, todayStr) {
  const windowDays = NUTRITION_WINDOW_DAYS;
  const fromStr = nutritionDateAdd_(todayStr, -(windowDays - 1));
  const inWindow = function(dateStr) {
    return dateStr && dateStr >= fromStr && dateStr <= todayStr;
  };

  // 返品行（マイナス金額）のキー。対応する品目は集計から落とす
  const returnKeys = {};
  (expenses || []).forEach(function(e) {
    if (e && e.amount < 0) returnKeys[e.date + '|' + e.store] = true;
  });

  // カバレッジ: 直近14日の「食費（外食除く）」支出のうち、品目データがある割合
  let foodExpenseCount = 0;
  let withItemsCount = 0;
  let eatingOutCount = 0;
  const itemKeys = {};
  (items || []).forEach(function(it) {
    if (it && it.date && it.store) itemKeys[it.date + '|' + it.store] = true;
  });

  // 集計用の品目リスト（購入品目シート＋備考パース）
  const allItems = [];
  (items || []).forEach(function(it) {
    if (!it || !inWindow(it.date) || !it.name) return;
    if (returnKeys[it.date + '|' + it.store]) return;
    allItems.push({ date: it.date, name: it.name, qty: it.qty > 0 ? it.qty : 1, manual: it.manual || '' });
  });

  (expenses || []).forEach(function(e) {
    if (!e || !inWindow(e.date)) return;
    if (e.category === '外食') { eatingOutCount++; return; }
    if (e.category !== '食費' || e.amount < 0) return;
    foodExpenseCount++;
    const noteItems = parseNoteItems_(e.note);
    if (itemKeys[e.date + '|' + e.store] || noteItems.length > 0) withItemsCount++;
    noteItems.forEach(function(token) {
      allItems.push({ date: e.date, name: token, qty: 1, manual: '' });
    });
  });

  const coverageRatio = foodExpenseCount > 0 ? withItemsCount / foodExpenseCount : 0;

  // 群ごとの集計
  const stats = {};
  FOOD_GROUPS.forEach(function(g) {
    stats[g.id] = { daysSet: {}, qtyByDate: {}, count: 0 };
  });
  const unclassifiedMap = {};

  allItems.forEach(function(it) {
    let groupId = '';
    const manual = String(it.manual || '').trim();
    if (manual) {
      if (FOOD_GROUP_BY_ID[manual]) groupId = manual;
      else {
        FOOD_GROUPS.forEach(function(g) { if (g.label === manual) groupId = g.id; });
      }
    }
    if (!groupId) groupId = classifyFoodItem(it.name);
    if (groupId === 'excluded') return;
    if (groupId === 'unclassified') {
      const key = String(it.name).trim();
      unclassifiedMap[key] = (unclassifiedMap[key] || 0) + 1;
      return;
    }
    const st = stats[groupId];
    if (!st) return;
    st.count++;
    st.daysSet[it.date] = true;
    st.qtyByDate[it.date] = (st.qtyByDate[it.date] || 0) + it.qty;
  });

  const groups = FOOD_GROUPS.map(function(g) {
    const st = stats[g.id];
    const distinctDays = Object.keys(st.daysSet).length;
    // まとめ買い補正: 同一群を同一日に数量3以上買った日は2日分として数える
    let bonus = 0;
    Object.keys(st.qtyByDate).forEach(function(d) { if (st.qtyByDate[d] >= 3) bonus++; });
    const days = Math.min(windowDays, distinctDays + bonus);
    let status = 'ok';
    if (g.target === 0) status = 'info';
    else if (days === 0) status = 'zero';
    else if (days < g.target) status = 'low';
    return { id: g.id, label: g.label, days: days, count: st.count, target: g.target, status: status };
  });

  // 不足判定（カバレッジ不足のときは出さない）
  const deficits = [];
  if (coverageRatio >= NUTRITION_COVERAGE_MIN) {
    const candidates = groups.filter(function(g) {
      return g.target > 0 && (g.status === 'zero' || g.status === 'low');
    });
    candidates.sort(function(a, b) {
      const za = a.status === 'zero' ? 0 : 1;
      const zb = b.status === 'zero' ? 0 : 1;
      if (za !== zb) return za - zb;
      const ra = a.days / a.target;
      const rb = b.days / b.target;
      if (ra !== rb) return ra - rb;
      return FOOD_DEFICIT_PRIORITY.indexOf(a.id) - FOOD_DEFICIT_PRIORITY.indexOf(b.id);
    });
    candidates.slice(0, 2).forEach(function(g) {
      const def = FOOD_GROUP_BY_ID[g.id];
      deficits.push({
        id: g.id,
        label: g.label,
        status: g.status,
        message: g.status === 'zero'
          ? (g.label + 'を買った形跡が' + windowDays + '日ありません')
          : (g.label + 'が少なめです（' + g.days + '日／目標' + g.target + '日）'),
        suggestion: def ? def.suggestion : ''
      });
    });
  }

  const unclassified = Object.keys(unclassifiedMap).map(function(name) {
    return { name: name, count: unclassifiedMap[name] };
  }).sort(function(a, b) { return b.count - a.count; }).slice(0, 20);

  return {
    windowDays: windowDays,
    from: fromStr,
    to: todayStr,
    coverage: {
      foodExpenseCount: foodExpenseCount,
      withItemsCount: withItemsCount,
      ratio: Math.round(coverageRatio * 100) / 100
    },
    eatingOutCount: eatingOutCount,
    groups: groups,
    deficits: deficits,
    unclassified: unclassified
  };
}
// ===== 栄養推測 (pure) END =====

/**
 * スプレッドシートから栄養情報を取得する（GAS依存のラッパー）。
 * 「購入品目」シートが無ければヘッダー付きで自動作成する（収入明細の自動作成と同じ流儀）。
 * detailValues は「支出明細」の全行（getDashboardData が読み済みのものを使い回す）。
 */
function getNutritionInfo(ss, detailValues) {
  let itemSheet = ss.getSheetByName('購入品目');
  if (!itemSheet) {
    itemSheet = ss.insertSheet('購入品目');
    itemSheet.appendRow(['日付', '店名', '品目名', '数量', '金額', '分類']);
  }
  const itemValues = itemSheet.getDataRange().getValues();

  const toDateStr = function(v) {
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
    return String(v || '').trim();
  };

  const expenses = [];
  for (let i = 1; i < detailValues.length; i++) {
    const row = detailValues[i];
    expenses.push({
      date: toDateStr(row[0]),
      store: String(row[1] || '').trim(),
      amount: parseNum(row[2]),
      category: String(row[3] || '').trim(),
      note: String(row[7] || '').trim()
    });
  }

  const items = [];
  for (let r = 1; r < itemValues.length; r++) {
    const row = itemValues[r];
    const name = String(row[2] || '').trim();
    if (!name) continue;
    items.push({
      date: toDateStr(row[0]),
      store: String(row[1] || '').trim(),
      name: name,
      qty: parseNum(row[3]),
      manual: String(row[5] || '').trim()
    });
  }

  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  return buildNutrition(expenses, items, todayStr);
}
