# AkiCourt Toritsu

都立公園のテニスコート空き状況を検索する補助ツール。Vue 3 + TypeScript + Vite、Fastifyを使用。現在はAPI接続確認と、少数公園のHTTP取得検証まで実装済み。

## Dockerで起動

リポジトリのルートで実行する。DockerとComposeが必要。

```sh
docker compose -f compose.dev.yaml up -d --build --wait --wait-timeout 300
```

Web：http://127.0.0.1:17590 ／ API：http://127.0.0.1:17591/health

`.env`は不要。設定を保存する場合は`.env.example`を`.env`へコピーする。並行開発ではプロジェクト名と両ポートを変える。

```sh
COMPOSE_PROJECT_NAME=akicourt-toritsu-second WEB_PORT=17690 API_PORT=17691 \
  docker compose -f compose.dev.yaml up -d --build --wait --wait-timeout 300
```

```sh
docker compose -f compose.dev.yaml logs --tail 100
docker compose -f compose.dev.yaml down
```

カスタム設定で起動した場合、停止・ログ確認にも同じ設定を使う。公開先は127.0.0.1限定。起動時に`npm ci`を実行し、依存物はホストと分離する。

## ホストで起動

Node.js 24.18.0（`.nvmrc`）を使用。各アプリで`npm ci`を実行後、別ターミナルで起動する。Dockerと同じポートを同時に使わない。

```sh
# apps/api
PORT=17591 npm run dev
# apps/web
WEB_PORT=17590 API_PROXY_TARGET=http://127.0.0.1:17591 npm run dev
```

## 確認

画面の「API接続を確認」で疎通を確認する。`/api/*`の転送はViteの開発プロキシを使用。

```sh
# apps/web
npm run build
npm run test:unit -- --run
npx --no-install eslint .
npx --no-install oxlint .
# apps/api
npm run type-check
npm run build:ts
npm test
```

## 空き情報の取得検証

`apps/api`で実行する。公式へ通信するため、繰り返しの実行は避ける。

```sh
npm run acquire -- 2026-10-10 1280:grass 1310:hard
```

日付は検索開始日、対象は`公園ID:grass`（人工芝）または`:hard`。最大2対象・各7日、直列で2秒間隔、45秒タイムアウト、一時エラーの再試行は1回まで。日付は確認したい日に変更する。結果と取得時刻・通信時間をJSONで出力し、失敗があれば終了コード1を返す。失敗を空きなしと扱わず、未対応の公式状態も失敗として報告する。ブラウザ操作・予約操作は行わない。

機能開発はdevelopからfeatureブランチを作り、develop向けPRでレビューする。検索UI・DB・定期取得・本番公開は未実装。
