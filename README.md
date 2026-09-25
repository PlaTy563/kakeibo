# 家計簿ダッシュボード（GitHub Pages + GAS API）

スプレッドシートの家計簿データを GAS(Google Apps Script) が JSON API として提供し、
このリポジトリの `index.html`（GitHub Pages）がそれを `fetch()` して描画する構成です。

- Googleの警告バナーが出ない（GASのページを直接開かないため）
- ログイン不要で誰でも開ける
- PWAとしてホーム画面に追加すると、アドレスバーのない全画面アプリとして起動する

## 構成

- `index.html` … フロントエンド本体（GitHub Pagesで公開）
- `manifest.json` … PWA用マニフェスト（ホーム画面追加・全画面表示用）
- `sw.js` … Service Worker（アプリの殻をキャッシュ。GASへのAPIリクエストはキャッシュしない）
- `icons/` … PWAアイコン（通常用・maskable用 各192px/512px）
- `gas/Code.gs` … GAS側 `doGet` のバックアップ/参照コード（実際の反映は手動）

## セットアップ手順

### 1. GAS側をJSON API専用にする

Apps Script エディタで `Code.gs` の `doGet(e)` を `gas/Code.gs` の内容に置き換え、
「デプロイ」→「デプロイを管理」から**新しいバージョン**としてデプロイし直してください
（URLの末尾が `/exec` のものを使います）。

> 既存の `getDashboardData` / `parseNum` などのロジックはそのまま変更不要です。

### 2. `index.html` のAPI URLを確認

`index.html` 内の `GAS_API_URL` が、上記でデプロイしたWebアプリURL（`/exec`で終わるもの）と
一致しているか確認してください。

### 3. GitHub Pages を有効化

1. リポジトリの **Settings** → **Pages** を開く
2. **Branch** をこのファイル一式が入っているブランチ（例: `main`）、フォルダを `/ (root)` にして **Save**
3. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` が公開されます

### 4. スマホでホーム画面に追加

公開されたURLをスマホのブラウザ（Chrome推奨）で開き、「ホーム画面に追加」を選択すると、
アドレスバーのない全画面PWAとしてインストールされます。
