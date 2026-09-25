/**
 * このファイルはリポジトリ側のバックアップ/参照用です。
 * 実際に動くのは Google Apps Script プロジェクト側のコードなので、
 * ここを編集しても自動では反映されません。
 * 変更したら Apps Script エディタにも同じ内容を貼り付けて
 * 「デプロイ」→「デプロイを管理」→ 新バージョンとして再デプロイしてください。
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  // 1. Androidウィジェット(KWGT)からのAPIリクエスト判定
  if (params.type === 'widget') {
    const today = new Date();
    // 現在年月のデータを取得（例: "2026年9月"）
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
      updatedAt: Utilities.formatDate(today, 'Asia/Tokyo', 'HH:mm')
    };

    return ContentService.createTextOutput(JSON.stringify(widgetPayload))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 2. GitHub Pagesなど外部フロントエンドからのJSON APIリクエスト（?month=2026年9月）
  if (params.month) {
    const data = getDashboardData(params.month);
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 3. ブラウザから直接アクセスされた場合のみHTMLダッシュボードを描画（フォールバック）
  const template = HtmlService.createTemplateFromFile('index');
  // 初回表示用データ（2026年9月）
  template.initialData = JSON.stringify(getDashboardData('2026年9月'));
  return template.evaluate()
    .setTitle('支出・予算進捗ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// 数値パース用関数
function parseNum(val) {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  if (Array.isArray(val)) val = val[0];
  const cleaned = String(val).replace(/[^\d.-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// 指定年月のダッシュボードデータおよび該当月明細を動的集計する関数
function getDashboardData(targetMonth) {
  if (!targetMonth) targetMonth = '2026年9月';

  // "2026年9月" -> "2026-09"
  const mMatch = targetMonth.match(/(\d{4})年(\d{1,2})月/);
  const targetYm = mMatch ? (mMatch[1] + '-' + (mMatch[2].length === 1 ? '0' + mMatch[2] : mMatch[2])) : '2026-09';

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. 基本予算マスターの取得（月別サマリーから）
  const summarySheet = ss.getSheetByName('月別サマリー');
  const sumValues = summarySheet ? summarySheet.getDataRange().getValues() : [];

  const budgetConfig = {
    '食費': 30000,
    '自由（娯楽・雑費）': 25000,
    '家賃': 30000,
    '光熱費': 8000,
    'サブスク': 5000
  };

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

  // 2. 支出明細シートから「該当月（targetYm）」の出費を集計
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

    // 選択された年月（targetYm）と前方一致するものだけを抽出
    if (dateStr.indexOf(targetYm) !== 0) continue;

    // カテゴリ振り分け判定
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

  // 3. カテゴリ配列の作成
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

  const livingBudget = 98000;
  const livingActual = categories.reduce(function(sum, c) { return sum + c.actual; }, 0);

  return {
    month: targetMonth,
    updatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm'),
    livingBudget: livingBudget,
    livingActual: livingActual,
    livingRemaining: livingBudget - livingActual,
    livingUsage: livingBudget > 0 ? (livingActual / livingBudget) * 100 : 0,
    specialActual: specialActual,
    totalOutflow: livingActual + specialActual,
    categories: categories,
    expenses: expenses
  };
}
