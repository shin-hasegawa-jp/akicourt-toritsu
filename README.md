# AkiCourt Toritsu

都立公園のテニスコート空き状況を検索する補助ツール。Vue 3 + TypeScript + Vite、Fastifyを使用。現在はAPI接続確認と、少数公園のHTTP取得・DB保存まで実装済み。

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

DBを使う場合は`.env`に生成した16進数の`POSTGRES_PASSWORD`を設定し、`-f compose.db.yaml`を追加する。DBはホスト非公開。ホストNodeから接続する場合だけ`-f compose.db-host.yaml`も追加し、`DB_PORT`（既定17592）を指定する。DB付き環境の停止にも同じ`-f`指定を使う。

DB起動後、以下でスキーマ作成・更新要求・独立ワーカー起動を行う。更新は既定で日本時間の本日から7日間。ワーカーの起動後は公式へ通信するため、意図した時だけ起動する。

```sh
docker compose -f compose.dev.yaml -f compose.db.yaml exec -T api npm run storage -- migrate
docker compose -f compose.dev.yaml -f compose.db.yaml exec -T api npm run storage -- enqueue 1280:grass
docker compose -f compose.dev.yaml -f compose.db.yaml --profile acquisition up -d --build worker
# 停止（API・DBは維持）
docker compose -f compose.dev.yaml -f compose.db.yaml --profile acquisition stop worker
```

403/429では全体停止し、再起動しても通信を再開しない。原因確認・ワーカー停止後、上の`exec -T api npm run storage --`に`reset-block`を指定して解除する。同一週の再要求は成功・失敗とも15分間再利用する。`npm run test:db`は接続先DBの隔離スキーマで検証する（`DATABASE_URL`必須）。

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

`apps/api`でワーカー停止中に実行する。これはDBの制御を使わない検証CLI。公式へ通信するため、繰り返しの実行は避ける。

```sh
npm run acquire -- 2026-10-10 1280:grass 1310:hard
```

日付は検索開始日、対象は`公園ID:grass`（人工芝）または`:hard`。最大2対象・各7日、直列で2秒間隔、45秒タイムアウト、一時エラーの再試行は1回まで。日付は確認したい日に変更する。結果と取得時刻・通信時間をJSONで出力し、失敗があれば終了コード1を返す。失敗を空きなしと扱わず、未対応の公式状態も失敗として報告する。ブラウザ操作・予約操作は行わない。

機能開発はdevelopからfeatureブランチを作り、develop向けPRでレビューする。検索API・検索UI・定期取得・本番公開は未実装。
