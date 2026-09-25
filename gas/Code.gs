/**
 * このファイルはリポジトリ側のバックアップ/参照用です。
 * 実際に動くのは Google Apps Script プロジェクト側のコードなので、
 * ここを編集しても自動では反映されません。
 * 変更したら Apps Script エディタにも同じ内容を貼り付けて
 * 「デプロイ」→「デプロイを管理」→ 新バージョンとして再デプロイしてください。
 */
function doGet(e) {
  // CORS対策（GitHub Pagesからのデータ取得を許可）
  const targetMonth = (e && e.parameter && e.parameter.month) ? e.parameter.month : '2026年9月';
  const data = getDashboardData(targetMonth);

  // フロントエンド（GitHub Pages）向けにJSONを返却
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ※ parseNum や getDashboardData のロジックは既存のものをそのまま使用してください
