/**
 * 栄養推測ロジックのローカルテスト。
 * gas/Code.gs の「栄養推測 (pure)」区間を抽出して Node で実行する。
 * 実行: node tests/nutrition.test.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
const start = code.indexOf('// ===== 栄養推測 (pure) START =====');
const end = code.indexOf('// ===== 栄養推測 (pure) END =====');
if (start === -1 || end === -1) {
  console.error('FAIL: pure区間のマーカーが見つかりません');
  process.exit(1);
}
const pure = code.slice(start, end);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(pure + '\n;this.__exp = { classifyFoodItem, buildNutrition };', sandbox);
const { classifyFoodItem, buildNutrition } = sandbox.__exp;

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.log('FAIL: ' + label + '\n  expected: ' + e + '\n  actual:   ' + a); }
}

// ---- 分類テスト（仕様書 §4.4 + 紛らわしいケース） ----
const classifyCases = [
  ['国産豚こま切れ 300g', 'meat'],
  ['サバ水煮缶', 'fish'],
  ['絹ごし豆腐', 'soy'],
  ['納豆 3パック', 'soy'],
  ['豆乳 1000ml', 'soy'],
  ['牛乳 1000ml', 'dairy'],
  ['牛肉切り落とし', 'meat'],
  ['冷凍ほうれん草', 'veg_green'],
  ['ブロッコリー', 'veg_green'],
  ['もやし', 'veg_other'],
  ['わかめ', 'veg_other'],
  ['バナナ', 'fruit'],
  ['卵 10個', 'egg'],
  ['米 5kg', 'staple'],
  ['幕の内弁当', 'composite'],
  ['カップヌードル', 'composite'],
  ['卵サンド', 'composite'],
  ['洗濯洗剤', 'excluded'],
  ['しょうゆ', 'excluded'],
  ['ポテトチップス', 'excluded'],
  // 紛らわしいケース
  ['サラダチキン', 'meat'],
  ['魚肉ソーセージ', 'composite'],
  ['味噌汁', 'composite'],
  ['味噌', 'excluded'],
  ['カキフライ', 'composite'],
  ['ツナ缶', 'fish'],
  ['ヨーグルト', 'dairy'],
  ['鶏むね肉', 'meat'],
  ['にんじん', 'veg_green'],
  ['キャベツ', 'veg_other'],
  ['ｻﾊﾞ缶', 'fish'], // 半角カナ→全角化
  ['ごぼう茶', 'excluded'],
];
classifyCases.forEach(function([name, expected]) {
  check('classify: ' + name, classifyFoodItem(name), expected);
});

// ---- 集計テスト ----
const TODAY = '2026-11-01'; // 窓は 2026-10-19 〜 2026-11-01
function exp(date, store, amount, category, note) {
  return { date, store, amount, category, note: note || '' };
}
function item(date, store, name, qty, manual) {
  return { date, store, name, qty: qty || 1, manual: manual || '' };
}
function group(n, id) { return n.groups.find(function(g) { return g.id === id; }); }

// A: カバレッジ不足（4件中1件のみ品目あり）→ 不足を出さない
{
  const expenses = [
    exp('2026-10-25', 'スーパー', 2000, '食費'),
    exp('2026-10-27', 'スーパー', 1500, '食費'),
    exp('2026-10-29', 'スーパー', 1800, '食費'),
    exp('2026-10-31', 'スーパー', 1200, '食費'),
  ];
  const items = [item('2026-10-25', 'スーパー', '豚こま')];
  const n = buildNutrition(expenses, items, TODAY);
  check('A: coverage ratio', n.coverage.ratio, 0.25);
  check('A: deficits empty', n.deficits, []);
}

// B: カバレッジ十分・魚ゼロ → 魚が不足1位。同日複数行は1日、数量3以上は+1日補正
{
  const expenses = [
    exp('2026-10-20', 'スーパー', 3000, '食費'),
    exp('2026-10-24', 'スーパー', 3000, '食費'),
    exp('2026-10-28', 'スーパー', 3000, '食費'),
    exp('2026-11-01', 'スーパー', 3000, '食費'),
  ];
  const items = [
    item('2026-10-20', 'スーパー', '豚こま'), item('2026-10-20', 'スーパー', '鶏むね肉'), // meat 同日2行 → 1日
    item('2026-10-24', 'スーパー', '牛肉'),                                              // meat 2日目
    item('2026-10-20', 'スーパー', 'ほうれん草'), item('2026-10-24', 'スーパー', 'にんじん'),
    item('2026-10-28', 'スーパー', 'ブロッコリー'),                                        // veg_green 3日 = 充足
    item('2026-10-20', 'スーパー', '納豆', 3),                                             // soy 数量3 → 2日分
    item('2026-10-24', 'スーパー', '卵'),                                                  // egg 1日 = 充足
    item('2026-10-20', 'スーパー', '米'), item('2026-10-28', 'スーパー', '食パン'),        // staple 2日 = 充足
    item('2026-10-20', 'スーパー', '牛乳'), item('2026-10-28', 'スーパー', 'ヨーグルト'),  // dairy 2日 = 充足
    item('2026-10-24', 'スーパー', 'バナナ'),                                              // fruit 1日 = 充足
    item('2026-10-20', 'スーパー', 'もやし'), item('2026-10-24', 'スーパー', 'キャベツ'),
    item('2026-11-01', 'スーパー', '牛乳'), // 11-01の買い物にも品目あり（カバレッジ用）
    item('2026-10-28', 'スーパー', '玉ねぎ'),                                              // veg_other 3日 = 充足
  ];
  const n = buildNutrition(expenses, items, TODAY);
  check('B: coverage ratio', n.coverage.ratio, 1);
  check('B: meat days (same-day dedup)', group(n, 'meat').days, 2);
  check('B: soy days (bulk bonus)', group(n, 'soy').days, 2);
  check('B: fish status', group(n, 'fish').status, 'zero');
  check('B: deficits[0] is fish', n.deficits.length > 0 ? n.deficits[0].id : null, 'fish');
  check('B: deficits length <= 2', n.deficits.length <= 2, true);
}

// C: 外食のみ → 不足なし・外食件数だけ記録
{
  const expenses = [
    exp('2026-10-26', '食堂', 900, '外食'),
    exp('2026-10-30', 'ラーメン屋', 1100, '外食'),
  ];
  const n = buildNutrition(expenses, [], TODAY);
  check('C: eatingOutCount', n.eatingOutCount, 2);
  check('C: foodExpenseCount', n.coverage.foodExpenseCount, 0);
  check('C: deficits empty', n.deficits, []);
}

// D: 備考のカンマ区切り品目を取り込む
{
  const expenses = [exp('2026-10-31', 'スーパー', 2500, '食費', '米,豚こま,ほうれん草,納豆')];
  const n = buildNutrition(expenses, [], TODAY);
  check('D: withItems via note', n.coverage.withItemsCount, 1);
  check('D: staple days', group(n, 'staple').days, 1);
  check('D: soy days', group(n, 'soy').days, 1);
  // 通常の文章の備考は取り込まない
  const expenses2 = [exp('2026-10-31', 'スーパー', 2500, '食費', '母と買い物に行った')];
  const n2 = buildNutrition(expenses2, [], TODAY);
  check('D2: prose note ignored', n2.coverage.withItemsCount, 0);
}

// E: 手直し（分類列）が辞書より優先される
{
  const expenses = [exp('2026-10-31', 'スーパー', 2500, '食費')];
  const items = [item('2026-10-31', 'スーパー', 'ごぼう茶', 1, 'fish')];
  const n = buildNutrition(expenses, items, TODAY);
  check('E: manual override', group(n, 'fish').count, 1);
  check('E: unclassified empty', n.unclassified, []);
}

// F: 返品行に対応する品目は落とす / G: 窓の境界
{
  const expenses = [
    exp('2026-10-31', 'スーパー', 2500, '食費'),
    exp('2026-10-31', 'スーパー', -500, '食費'),
  ];
  const items = [item('2026-10-31', 'スーパー', '豚こま')];
  const n = buildNutrition(expenses, items, TODAY);
  check('F: returned items dropped', group(n, 'meat').count, 0);

  const items2 = [
    item('2026-10-18', 'スーパー', '豚こま'), // 窓の前日 → 対象外
    item('2026-10-19', 'スーパー', '豚こま'), // 窓の初日 → 対象
  ];
  const n2 = buildNutrition([exp('2026-10-19', 'スーパー', 1000, '食費')], items2, TODAY);
  check('G: window boundary', group(n2, 'meat').count, 1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
