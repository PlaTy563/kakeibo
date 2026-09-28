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
 * Web App エントリポイント
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  // 0. アクセスキーチェック（全リクエスト共通）
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

  // 2. GitHub Pagesなど外部フロントエンドからのJSON APIリクエスト（?month=2026年9月 または パラメータなし/json）
  if (params.month || params.type === 'json' || params.type === 'api' || params.format === 'json') {
    const targetMonth = params.month || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy年M月');
    const data = getDashboardData(targetMonth);
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 3. ブラウザから直接アクセスされた場合のみHTMLダッシュボードを描画（フォールバック）
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
 * 数値パース用関数
 */
function parseNum(val) {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  if (Array.isArray(val)) val = val[0];
  const cleaned = String(val).replace(/[^\d.-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

/**
 * 日付から日本の祝日判定
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
 * カネスエの1シフト給与計算（1分単位スライスによる厳密計算）
 * 基本時給: 1,050円
 * 17:00〜18:00: +50円 (1,100円)
 * 18:00〜22:00: +100円 (1,150円)
 * 22:00以降: 深夜割増 +25% (基本1,050の25%増 = 1,313円)
 * 日祝一律: +100円 (時間帯加給と重複適用)
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
 * 規定時給: 1,400円/時
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
 * 指定年月のGoogleカレンダーからカネスエ・TAの予定を抽出し、給与を自動計算
 * @param {number} year 
 * @param {number} month (1-12)
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

  // 祝日キャッシュ（同月内の判定高速化）
  const holidayCache = {};

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.isAllDayEvent()) continue;

    const title = ev.getTitle() || '';
    const evStart = ev.getStartTime();
    const evEnd = ev.getEndTime();

    // 1. カネスエ判定
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
    }
    // 2. TA判定
    else {
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
 * カレンダーから計算した給与を「収入明細」シートに自動反映（Upsert）
 * @param {string} targetYmStr 'YYYY-MM' または 'YYYY年M月'（省略時は当月）
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

  // カレンダーから計算
  const calcResult = getCalendarIncomeForMonth(year, month);
  const ss = getSpreadsheet();
  let incomeSheet = ss.getSheetByName('収入明細');

  if (!incomeSheet) {
    incomeSheet = ss.insertSheet('収入明細');
    incomeSheet.appendRow(['日付', '収入源', '金額', '種別', '確定状況', '備考']);
  }

  const values = incomeSheet.getDataRange().getValues();

  // 対象行のUpsert対象
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

  updates.forEach(function(item) {
    if (item.wage === 0) return;

    let foundRowIndex = -1;
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

      if (rowDateStr.indexOf(ymPadded) === 0 && rowSource === item.source) {
        if (rowStatus === '確定') {
          foundRowIndex = -2;
          break;
        }
        foundRowIndex = r + 1;
        break;
      }
    }

    if (foundRowIndex > 0) {
      incomeSheet.getRange(foundRowIndex, 3).setValue(item.wage);
      incomeSheet.getRange(foundRowIndex, 5).setValue('見込');
      incomeSheet.getRange(foundRowIndex, 6).setValue(item.note);
      results.push('Updated ' + item.source + ' in row ' + foundRowIndex + ' (¥' + item.wage + ')');
    } else if (foundRowIndex === -1) {
      incomeSheet.appendRow([
        entryDateStr,
        item.source,
        item.wage,
        '給与',
        '見込',
        item.note
      ]);
      results.push('Inserted ' + item.source + ' (¥' + item.wage + ')');
    } else {
      results.push('Skipped ' + item.source + ' (確定済み)');
    }
  });

  return { ym: ymPadded, calcResult: calcResult, logs: results };
}

/**
 * ダッシュボードシートの安全な更新（セル破壊防止リファクタリング）
 */
function syncDashboardSheet(targetMonth) {
  const data = getDashboardData(targetMonth);
  const ss = getSpreadsheet();
  const dashSheet = ss.getSheetByName('ダッシュボード') || ss.getSheetByName('月別サマリー');
  if (!dashSheet) return;

  const values = dashSheet.getDataRange().getValues();

  // 見出しセルを柔軟に特定して安全に値を更新
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
 * 指定年月のダッシュボードデータ動的集計関数（支出・収入・貯金積立を統合）
 */
function getDashboardData(targetMonth) {
  if (!targetMonth) targetMonth = '2026年9月';

  const mMatch = targetMonth.match(/(\d{4})年(\d{1,2})月/);
  const targetYm = mMatch ? (mMatch[1] + '-' + (mMatch[2].length === 1 ? '0' + mMatch[2] : mMatch[2])) : '2026-09';

  const ss = getSpreadsheet();

  // 1. 基本予算マスターの取得
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

  // 2. 支出明細シートから集計
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

  // 3. 収入明細シートから集計
  const incomeSheet = ss.getSheetByName('収入明細');
  const incomeValues = incomeSheet ? incomeSheet.getDataRange().getValues() : [];
  const incomes = [];
  let totalIncome = 0;
  let confirmedIncome = 0;
  let estimatedIncome = 0;

  for (let r = 1; r < incomeValues.length; r++) {
    const row = incomeValues[r];
    const dateVal = row[0];
    const source = String(row[1] || '').trim();
    const amt = parseNum(row[2]);
    const type = String(row[3] || '').trim();
    const status = String(row[4] || '確定').trim();
    const note = String(row[5] || '').trim();

    if (!dateVal && amt === 0) continue;

    let dateStr = '';
    if (dateVal instanceof Date) {
      dateStr = Utilities.formatDate(dateVal, 'Asia/Tokyo', 'yyyy-MM-dd');
    } else {
      dateStr = String(dateVal).trim();
    }

    if (dateStr.indexOf(targetYm) !== 0) continue;

    totalIncome += amt;
    if (status === '確定') {
      confirmedIncome += amt;
    } else {
      estimatedIncome += amt;
    }

    incomes.push({
      date: dateStr,
      source: source,
      amount: amt,
      type: type,
      status: status,
      note: note
    });
  }

  // 4. 貯金・積立管理シートから集計
  const savingSheet = ss.getSheetByName('貯金・積立管理');
  const savingValues = savingSheet ? savingSheet.getDataRange().getValues() : [];
  const savings = [];
  let totalSaved = 0;
  let totalTarget = 0;
  let monthlySavingTotal = 0;

  for (let s = 1; s < savingValues.length; s++) {
    const row = savingValues[s];
    const name = String(row[0] || '').trim();
    if (!name) continue;

    const targetAmt = parseNum(row[1]);
    const currentAmt = parseNum(row[2]);
    const monthlyTarget = parseNum(row[3]);
    const eta = String(row[4] || '').trim();
    const note = String(row[5] || '').trim();

    const progressRate = targetAmt > 0 ? (currentAmt / targetAmt) * 100 : 0;
    totalSaved += currentAmt;
    totalTarget += targetAmt;
    monthlySavingTotal += monthlyTarget;

    savings.push({
      name: name,
      targetAmount: targetAmt,
      currentAmount: currentAmt,
      monthlyTarget: monthlyTarget,
      progressRate: Math.min(100, Math.round(progressRate * 10) / 10),
      eta: eta,
      note: note
    });
  }

  // 5. 当月収支の算出
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
    incomes: incomes,
    netBalance: netBalance,
    livingBalance: livingBalance,
    savings: savings,
    totalSaved: totalSaved,
    totalTarget: totalTarget,
    monthlySavingTotal: monthlySavingTotal
  };
}