# 家計簿ダッシュボード（GitHub Pages + GAS API）

スプレッドシートの家計簿データを GAS(Google Apps Script) が JSON API として提供し、
このリポジトリの `index.html`（GitHub Pages）がそれを `fetch()` して描画する構成です。

- Googleの警告バナーが出ない（GASのページを直接開かないため）
- ログイン不要で誰でも開ける
- PWAとしてホーム画面に追加すると、アドレスバーのない全画面アプリとして起動する
- 指紋/Face IDでロック解除（対応端末のみ）＋アクセスキーで、URLを知っただけの第三者からデータを保護

## 構成

- `index.html` … フロントエンド本体（GitHub Pagesで公開）。指紋/Face ID（WebAuthn）ロック画面を実装
- `manifest.json` … PWA用マニフェスト（ホーム画面追加・全画面表示用）
- `sw.js` … Service Worker（アプリの殻をキャッシュ。GASへのAPIリクエストはキャッシュしない）
- `icons/` … PWAアイコン（通常用・maskable用 各192px/512px）
- `gas/Code.gs` … GAS側 `doGet` のバックアップ/参照コード（実際の反映は手動）。`ACCESS_KEY` によるアクセス制限つき

## セキュリティについて

「アクセスできるユーザー：全員」でデプロイする関係上、2段階で保護しています。

1. **アクセスキー**: `gas/Code.gs` の `ACCESS_KEY` と `index.html` の `ACCESS_KEY` が一致しないリクエストは `doGet` が拒否します。
2. **指紋/Face ID（WebAuthn）**: 対応端末では、アプリを開くたびに端末の生体認証を要求するロック画面が表示されます。未対応端末（PCなど）では自動的にスキップされます。

> 注意: GitHub Pagesは公開リポジトリのため、`index.html`内の`ACCESS_KEY`は「ページのソースを表示」すれば誰でも読めます。したがってこれは本格的なサーバー側認証ではなく、「URLを知らない人・自動巡回からの誤アクセスを防ぐ」ための実用的な対策です。指紋認証はその端末の持ち主以外がロック画面を突破できないようにする、体感的なアプリロックとして機能します。より強固にしたい場合は、リポジトリを非公開にする（GitHub Pagesの公開範囲はプランに依存）などの対策を別途検討してください。

## セットアップ手順

### 1. GAS側をJSON API専用にする

Apps Script エディタで `Code.gs` を `gas/Code.gs` の内容に置き換え、
「デプロイ」→「デプロイを管理」から**新しいバージョン**としてデプロイし直してください
（URLの末尾が `/exec` のものを使います）。このとき、

- 次のユーザーとして実行: **自分**
- アクセスできるユーザー: **全員**

にしてください（「自分のみ」だとGitHub PagesやKWGTウィジェットからのアクセスがGoogleのログイン画面にリダイレクトされて失敗します）。

> 既存の `getDashboardData` / `parseNum` などのロジックはそのまま変更不要です。

### 2. `index.html` のAPI URLを確認

`index.html` 内の `GAS_API_URL` が、上記でデプロイしたWebアプリURL（`/exec`で終わるもの）と
一致しているか確認してください。

### 3. GitHub Pages を有効化

`.github/workflows/pages.yml` を追加済みなので、push するたびに自動でビルド・公開されます。
最初の1回だけ、公開方法を選ぶ操作が必要です。

1. リポジトリの **Settings** → **Pages** を開く
2. **Source** を **GitHub Actions** に変更（ブランチ/フォルダ選択の代わり）
3. `claude/adoring-faraday-ma3h0m` ブランチに push すると、Actionsタブでワークフローが実行され、
   数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` が公開されます
4. （後で `main` にマージした場合も、そのpushで自動的に再公開されます）

### 4. スマホでホーム画面に追加

公開されたURLをスマホのブラウザ（Chrome推奨）で開き、「ホーム画面に追加」を選択すると、
アドレスバーのない全画面PWAとしてインストールされます。初回起動時に指紋/Face ID登録を求められます。

### 5. KWGTウィジェットのURLを更新（要対応）

`ACCESS_KEY` チェックはウィジェット用リクエスト（`?type=widget`）にも適用されます。
KWGTの設定で使っているGAS URLの末尾に `&key=dd9cc131a5fa196f6d210e3ec6722668` を追加しないと、
ウィジェットが `{"error":"unauthorized"}` を受け取って表示が壊れます。

例: `https://script.google.com/macros/s/AKfycbx3lLYL-Sq3fbEZtsM0zXysujyMEp5qEeOX54WSsyX6gP5KhteWC2Wq-g9AyMyJyQbA/exec?type=widget&key=dd9cc131a5fa196f6d210e3ec6722668`
