# AkiCourt Toritsu

Vue 3 + TypeScript + Vite、Node.js + TypeScript + Fastifyによる検索補助ツール。現在は開発基盤とAPI接続確認まで実装済み。公式情報の取得・DB・検索機能は未実装。

## 構成

- `apps/web`：Vue画面。`/api/*`をVite開発プロキシでFastifyへ転送
- `apps/api`：Fastify。`GET /health`は`{"status":"ok"}`を返す
- Node.js：24.18.0（`.nvmrc`）。npm：検証時11.16.0。各アプリのロックファイルを管理
- 検証時：Vue 3.5.43、Fastify 5.12.5、TypeScript 6.0.3。正確な依存版はpackage-lock.jsonを参照

## ホストで起動

初期生成・依存追加/更新/削除は開発者が行う。既存依存を復元する場合は各アプリで`npm ci`を実行する。

別ターミナルでAPIとWebを起動する。

```sh
cd apps/api
npm run dev
```

```sh
cd apps/web
npm run dev
```

既定URLはWeb `http://127.0.0.1:17590`、API `http://127.0.0.1:17591`。

ポート変更時はAPIとWebプロキシの指定を揃える。

```sh
# apps/apiで実行
PORT=17691 npm run dev
# apps/webで実行
WEB_PORT=17690 API_PROXY_TARGET=http://127.0.0.1:17691 npm run dev
```

WebはstrictPortにより競合時に別ポートへ自動移動せず終了する。APIの待ち受けは既定で127.0.0.1。`npm run dev -- --port ...`では子プロセスへ指定が届かないため環境変数を使用する。

## Dockerで起動

DockerとComposeを用意し、リポジトリのルートで実行する。ホストのNode/npmは不要。

```sh
docker compose -f compose.dev.yaml up -d --build --wait --wait-timeout 300
```

`.env`は不要。既定値はプロジェクト名`akicourt-toritsu`、Web 17590、API 17591。ホスト起動と同時に同じポートを使用しない。

設定を保存する場合は`.env.example`を`.env`へコピーして編集する。`.env`はGit対象外。

```sh
cp .env.example .env
```

並行起動・worktreeごとにプロジェクト名と両ポートを変える。

```sh
COMPOSE_PROJECT_NAME=akicourt-toritsu-second WEB_PORT=17690 API_PORT=17691 \
  docker compose -f compose.dev.yaml up -d --build --wait --wait-timeout 300
```

Web→APIはコンテナ内の`http://api:3000`へプロキシするため、ホスト側ポートを変えても接続先のコード修正は不要。公開ポートは127.0.0.1に限定し、コンテナ内部では0.0.0.0で待ち受ける。

ソースはbind mountで変更を反映する。依存はアプリごとの名前付きボリューム、APIのdistも専用ボリュームに保存し、MacとLinuxの依存物・生成物を分ける。起動時に`npm ci`でロックファイルから依存を復元するため初回や再起動時は取得時間がかかる。依存操作後は対象サービスを再起動して同期する。

```sh
docker compose -f compose.dev.yaml logs --tail 100
docker compose -f compose.dev.yaml down
```

カスタム名で起動した場合は停止・ログ確認・再起動にも同じ環境変数（または.env）を使う。`down`は依存ボリュームを残す。削除が必要な場合だけ同じ対象を確認して`down --volumes`を使う。他プロジェクトのpruneは行わない。

## 動作確認

```sh
curl -i http://127.0.0.1:17591/health
curl -i http://127.0.0.1:17590/api/health
```

Webを開いて「API接続を確認」を押すと接続状態を表示する。通信中もメモを入力できる。API停止・応答不正・5秒のタイムアウト時には失敗表示となり、再試行できる。

```sh
# apps/web
npm run type-check
npm run build
npm run test:unit -- --run
npx --no-install eslint .
npx --no-install oxlint .
# apps/api
npm run type-check
npm run build:ts
npm test
```

Docker内の確認は同じプロジェクト指定で`docker compose -f compose.dev.yaml exec web ...`または`exec api ...`を使う。テストはモック/アプリ内注入による確認を含み、公式実データ・DB・本番の確認ではない。

Viteのプロキシは開発環境専用。本番は同一オリジンの`/api`をバックエンドへ転送する構成を別途決める。今回CORSや本番公開は追加しない。

## Gitとレビュー

developから`feature/<レビュー単位>-<説明>`を作成し、develop向けPRでレビューする。mainはリリース用。releaseからmainへ反映し、修正をdevelopへ戻す。並行作業時だけworktreeを分ける。

本PRの対象は01-3（開発設定）、01-4（最小接続）、01-5（Docker）。詳細と検証結果は`docs/開発基盤.md`を参照。依存追加・更新は開発者対応、マージは開発者が行う。
