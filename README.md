# Acid Tabs CSV チェッカー

[Acid Tabs](https://chromewebstore.google.com/detail/acid-tabs/hgceopemmcmigbmhphbcgkeffommpjfc) の CSV 設定を、**保存せずに検証する** Web アプリです。

CSV をブラウザから読み込むと、サーバーのメモリ上で解析し、DNS・HTTP の疎通、重複 URL、ワイルドカードや特殊 URL をチェックします。チェック結果は画面表示とレポートのダウンロードのみで、CSV や結果をディスク・DB・ブラウザストレージに保存しません。

ローカルでもコンテナでも同じイメージで動作し、Vercel / Azure / Google Cloud Run にデプロイできます。

## 特徴

- **ステートレス** — アップロードされた CSV を保存しない。履歴も残さない
- **DNS 解決 + HTTP アクセス + www ドメイン** — リンク切れや接続失敗を検出し、必要に応じて `www.` 付きも確認して結果一覧に表示
- **重複 URL の検出** — スキーム・大文字小文字・末尾スラッシュを正規化して比較
- **特殊 URL の分類** — ワイルドカード、`chrome://` などの特殊スキーム、ローカルホスト、プライベート IP を自動チェック対象外として一覧化
- **構造チェック** — 列数、絵文字、色、空の URL 群を検証
- **レポート出力** — JSON / CSV / Markdown でダウンロード
- **削除後の CSV 生成** — 結果にチェックを入れた URL だけを除いた Acid Tabs 形式の CSV をダウンロード / コピー
- **依存パッケージなし** — Node.js の標準機能だけで動作
- **SSRF 対策** — プライベート / 予約済みアドレスへの接続を常時ブロック

## クイックスタート（Node.js）

Node.js 20 以上が必要です。

```bash
npm start
```

`http://127.0.0.1:3000` を開き、CSV をドラッグ & ドロップします。`npm install` は不要です。

「サンプル CSV を試す」ボタンで、同梱の `public/sample.csv` を読み込めます。

## Docker で実行

```bash
docker compose up --build
```

`http://127.0.0.1:8080` で利用できます。`compose.yaml` は読み取り専用ファイルシステム・全ケイパビリティ削除・`no-new-privileges` で起動します。

Docker を直接使う場合:

```bash
docker build -t acid-tabs-checker .
docker run --rm -p 8080:8080 \
  -e HOST=0.0.0.0 \
  -e PORT=8080 \
  acid-tabs-checker
```

## デプロイ

成果物は Docker イメージ 1 つです。どの環境でも `HOST=0.0.0.0` と `PORT` を明示し、公開環境では `APP_ENV=deployed` を設定してください。

`APP_ENV=deployed`（または Vercel 上）では、次の制限が有効になります。

- HTTP チェックの接続先ポートを `80` / `443` に限定
- UI のプライバシーバッジを「公開環境で実行中」に切り替え

### Vercel（Container Runtime / beta）

ルートの `Dockerfile` を Vercel Functions の Container Runtime で動かします。`vercel.json` で `framework: "container"` を指定しています。

```bash
npm i -g vercel
vercel login

# 既存プロジェクトで別フレームワークとして検出された場合
vercel project update --framework container --yes

# Vercel の既定ポートは 80 のため、このイメージが待ち受ける 8080 を指定する
vercel env add PORT production   # 値: 8080

vercel --prod
```

- Hobby プランでは実行時間 300 秒、リクエスト / レスポンスボディ 4.5MB が上限です。アプリ側のボディ上限は 4MB にしています。
- Vercel は `VERCEL=1` を自動設定するため、`APP_ENV` の指定は不要です。
- 停止時は `SIGTERM` のあと 30 秒で強制終了されます。サーバーは graceful shutdown に対応しています。
- 公開する場合は Vercel Deployment Protection などでアクセス制御することを推奨します。

### Azure Container Apps

無料枠（サブスクリプション単位）の目安: 180,000 vCPU 秒 / 360,000 GiB 秒 / 200 万リクエスト月、scale-to-zero 対応。ACR Basic（約 $5/月）と Log Analytics は別課金です。

```bash
az login
az group create -n rg-acid-tabs -l japaneast
az containerapp env create -n acid-tabs-env -g rg-acid-tabs -l japaneast

ACR=<世界で一意な名前>
az acr create -n "$ACR" -g rg-acid-tabs --sku Basic
az acr build -r "$ACR" -t acid-tabs-checker:latest .

az containerapp create \
  -n acid-tabs-checker \
  -g rg-acid-tabs \
  --environment acid-tabs-env \
  --image "$ACR.azurecr.io/acid-tabs-checker:latest" \
  --registry-server "$ACR.azurecr.io" \
  --registry-username "$ACR" \
  --registry-password "$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 1 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --env-vars HOST=0.0.0.0 PORT=8080 APP_ENV=deployed
```

本番では ACR の管理者ユーザーではなく、マネージド ID（AcrPull）の利用を推奨します。公開する場合は Easy Auth などでアクセス制御してください。

### Azure App Service（F1 / 無料枠）

F1 は 60 CPU 分/日、1GB RAM、Always On 不可、SLA なしです。コールドスタートと 1 日の CPU 上限に注意してください。以下の例では、Container Apps の手順で作成した ACR を使います。

```bash
az appservice plan create -n acid-tabs-plan -g rg-acid-tabs --is-linux --sku F1
az webapp create -n <世界で一意な名前> -g rg-acid-tabs --plan acid-tabs-plan \
  --deployment-container-image-name "$ACR.azurecr.io/acid-tabs-checker:latest"

az webapp config appsettings set -n <世界で一意な名前> -g rg-acid-tabs --settings \
  WEBSITES_PORT=8080 \
  HOST=0.0.0.0 \
  PORT=8080 \
  APP_ENV=deployed
```

`WEBSITES_PORT` は App Service がコンテナ内の待ち受けポートを認識するために必要です。プライベートレジストリの認証情報は `az webapp config container set` で設定してください。

### Google Cloud Run

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>

gcloud run deploy acid-tabs-checker \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 2 \
  --timeout 900 \
  --set-env-vars HOST=0.0.0.0,PORT=8080,APP_ENV=deployed
```

無料枠の目安: 200 万リクエスト/月、180,000 vCPU 秒/月、360,000 GiB 秒/月。`--source .` は Cloud Build を使用するため、別途課金が発生する場合があります。公開する場合は Cloud Run の IAM 認証を有効にしてください。

## 使い方

1. Acid Tabs からエクスポートした CSV を読み込む（ドラッグ & ドロップ、ファイル選択、貼り付け）
2. カテゴリ数・URL 数・重複・特殊 URL の内訳を確認する
3. DNS / HTTP / www ドメインのチェック有無、タイムアウト、並列数を設定して「チェック開始」
4. 結果を状態別に絞り込み、URL をクリックして新しいタブで開く
5. 削除したい URL にチェックを入れ、削除後の CSV をダウンロードまたはコピーする
6. 必要ならレポートを JSON / CSV / Markdown でダウンロードする

チェック中は完了した URL から順に表示されます。「中止」で途中停止でき、その時点までの結果は保持されます（保存はされません）。

## チェック内容

既定値はタイムアウト 10 秒、並列数 30 です。並列数は 6 から開始し、6 件完了するごとに 6 ずつ増えて指定値（最大 30）になります。

| 項目 | 内容 |
| --- | --- |
| DNS | ホスト名が解決できるか。失敗した場合は HTTP チェックをスキップ |
| HTTP | `HEAD` でアクセスし、404/405/410/501 の場合は `GET` で再試行 |
| パス付き URL | 404/410 の場合、同じドメインのトップページも確認し、詳細に状態を補足（判定はリンク切れのまま） |
| www 付き URL | 元 URL が DNS 失敗・接続失敗・404/410・5xx のときだけ `www.` を付けた URL も確認し、結果一覧の WWW 列に表示。2xx / 3xx の場合は詳細にも補足（判定は元 URL のまま） |
| リダイレクト | 最大 5 ホップまで手動で追跡し、各ホップで接続先を再検証 |
| 重複 | ホスト名・パス・クエリを正規化してカテゴリ間の重複を検出 |
| ワイルドカード | `*.aws`、`blog.*`、`http*://localhost` などは通信せず対象外 |
| 特殊スキーム | `chrome://`、`about:`、`file:` などは通信せず対象外 |
| ローカル | `localhost`、`*.local`、`*.home`、プライベート IP は通信せず対象外 |
| 構造 | 3 列になっていない行、空の絵文字・色・URL 群を検出 |

HTTP ステータスの扱い:

- `2xx` / `3xx` — OK
- `401` / `403` / `429` / その他 `4xx` — 注意（到達はしている）
- `404` / `410` — リンク切れ
- `5xx` — エラー
- タイムアウト・接続失敗 — エラー

### www 付き URL の確認

元 URL が失敗したときだけ、ホスト名の先頭に `www.` を付けた URL も確認します。確認結果は結果一覧の WWW 列に表示されます。2xx / 3xx が返った場合は、元の状態を変えずに詳細へ `www 付きでは応答あり (HTTP 200)` のように追記します。「www ドメイン」のチェックをオフにすると、この追加確認は行いません。

- 対象: DNS 解決失敗、接続失敗、`404` / `410`、`5xx`
- 対象外: 元 URL が OK / 注意、IP リテラル、`localhost`、すでに `www.` で始まるホスト、SSRF でブロックされた接続先
- タイムアウト: 元 URL のタイムアウト設定と 3 秒の小さい方
- 追加の確認でも SSRF 対策とリダイレクト検証は同じように行う

`www` 付きの確認結果は補足情報です。元 URL の状態（リンク切れ・エラーなど）は変わりません。

## セキュリティ

チェック対象 URL へのアクセスは、ローカル実行でも常に次の検証を通します。

- `http:` / `https:` 以外のスキームを拒否
- URL に含まれる認証情報（`user:pass@`）を拒否
- プライベート / ループバック / リンクルーカル / CGNAT / マルチキャスト / ドキュメント用などの予約済みアドレスを拒否
- DNS 解決結果の**すべての IP** を検査（1 つでも非公開アドレスなら拒否）
- リダイレクト先も毎回再検証し、最大 5 ホップで打ち切り
- 公開環境（`APP_ENV=deployed` / Vercel）では接続ポートを `80` / `443` に限定

## CSV 形式

```text
絵文字, space-separated-urls, color
```

例:

```csv
⭐, example.com github.com, yellow
🎵, soundcloud.com bandcamp.com, green
📝, blog.* qiita.com zenn.dev, pink
```

- URL はスペース区切り
- 1 カテゴリ = 1 行
- 行内の URL にカンマが含まれていても、最初と最後のカンマで列を判定する
- ワイルドカード（`*` を含むもの）は意図的なパターンとして保持し、チェック対象外にする

## レポート

結果画面の下部からダウンロードできます。

- **JSON** — 解析結果、チェック結果、構造エラー、重複グループをすべて含む
- **CSV** — 1 URL = 1 行（Excel 向けに BOM 付き）
- **Markdown** — サマリ、問題のある URL、重複 URL の一覧

レポートはブラウザ内で生成され、サーバーには保存されません。

## 削除後の CSV

結果一覧の「削除」列にチェックを入れると、その URL だけを元の CSV から取り除いた Acid Tabs 形式の CSV を生成できます。

- チェックできるのは OK / 注意 / リンク切れ / エラー の URL
- ワイルドカード、特殊スキーム、localhost、プライベート IP などの「対象外」はチェック不可
- カテゴリ内の URL をすべて削除した場合、その行は出力しない
- カテゴリ順・URL 順・絵文字・色は元の CSV を維持
- 「問題ありを選択」「表示中を選択」「選択解除」で一括操作できる
- ダウンロードとクリップボードへのコピーの両方に対応

```csv
# 元の CSV
⭐, example.com broken.com, yellow
🎵, soundcloud.com, green

# broken.com をチェックして生成
⭐, example.com, yellow
🎵, soundcloud.com, green
```

削除後の CSV はブラウザ内で生成され、サーバーには送信・保存されません。レポートの CSV（1 URL = 1 行）とは形式が異なり、こちらは Acid Tabs に再インポートできる形式です。

## プライバシー

- 読み込んだ CSV はサーバーのメモリ上でのみ処理します
- ディスク、データベース、`localStorage` / `sessionStorage` / IndexedDB には保存しません
- サーバーはデフォルトで `127.0.0.1` にのみバインドします
- 外部アクセスは、チェック対象の URL（DNS / HTTP）だけです
- アクセス解析や外部 CDN は使用していません
- 公開環境では、CSV はブラウザから HTTPS でそのサーバーへ送信されます。処理後に保存されることはありません
- 公開環境の UI ではバッジが「公開環境で実行中」に変わります

## API

ブラウザ UI が利用する API です。CSV はリクエストボディで受け取り、保存しません。

### `POST /api/analyze`

```json
{ "csv": "⭐, example.com, yellow" }
```

CSV を解析してカテゴリ、URL、重複、構造エラーを返します。

### `POST /api/check`

```json
{
  "csv": "⭐, example.com, yellow",
  "options": {
    "dns": true,
    "http": true,
    "www": true,
    "timeoutMs": 10000,
    "concurrency": 30
  }
}
```

`application/x-ndjson` でストリーミングします。

- `{"type":"analysis", ...}` — 解析結果
- `{"type":"start", ...}` — チェック開始
- `{"type":"result", ...}` — URL ごとの結果と進捗
- `{"type":"done", ...}` — 完了サマリ

### `GET /api/health`

```json
{ "ok": true, "mode": "local" }
```

`mode` は `local` または `deployed` です。

## 設定

環境変数で変更できます。

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート（Docker イメージでは `8080`） |
| `HOST` | `127.0.0.1` | 待ち受けホスト（コンテナでは `0.0.0.0` を明示） |
| `APP_ENV` | （なし） | `deployed` で公開環境向けの制限を有効化 |

アプリ側のリクエストボディ上限は 4MB です。

## 開発

```bash
npm test      # node:test によるユニットテスト
npm run dev   # ファイル変更で自動再起動

npm run docker:build
npm run docker:run
npm run docker:up
```

## 構成

```text
public/
  index.html      UI
  app.js          フロントエンド（状態はメモリのみ）
  clean.js        削除後 CSV の生成（DOM 非依存）
  styles.css      スタイル
  favicon.svg     アイコン
  sample.csv      サンプルデータ
src/
  server.js       HTTP サーバー / 静的配信 / ストリーミング API
  parse.js        CSV 解析・分類・重複検出
  check.js        DNS / HTTP チェック・リダイレクト追跡
  ssrf.js         接続先の検証（SSRF 対策）
test/
  parse.test.js
  check.test.js
  ssrf.test.js
  clean.test.js
Dockerfile
compose.yaml
vercel.json
```

チェックしたい CSV はアプリに読み込むだけで、リポジトリには置かないでください。
