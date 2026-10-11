# AkiCourt Toritsu

都立公園のテニスコート空き状況を検索する補助ツール。Vue 3 + TypeScript + Vite、Fastifyを使用。公式のテニス選択肢（人工芝27対象・ハード4対象）を種目ごとの公式順で表示する。選択は最大5対象。

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

画面は検索・更新APIへ接続する。疎通確認は`GET /health`を使用する。`/api/*`の転送はViteの開発プロキシを使用。

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

## CI・依存更新

GitHub Actionsの`CI`はmain・developへのpushとすべてのPRで実行する。Node.jsは`.nvmrc`を参照し、Webのlint・型チェック・ビルド・単体テストと、APIの型チェック・ビルド・単体テスト・PostgreSQL 18での統合テストを検証する。lintは自動修正を行わない。CIの依存インストールには`npm ci --ignore-scripts`を使い、依存パッケージのライフサイクルスクリプトを実行しない。テストでは公式サイトへの実通信を行わない。

Dependabotは毎週月曜9:00（日本時間）にnpm・GitHub Actions・Dockerfile・Composeの依存更新を確認し、develop向けPRを作成する。通常の依存更新は公開から7日間のクールダウンを設け、新規リリース直後の不正なパッケージ混入リスクを抑える。クールダウンはセキュリティ更新には適用されない。npmとDocker関連のminor・patch更新をまとめ、major更新は個別にレビューする。Dependabotを有効にするには`.github/dependabot.yml`をリポジトリのデフォルトブランチにも反映する。

## 検索・更新API

```sh
curl -sS http://127.0.0.1:17590/api/availability/search -H 'Content-Type: application/json' -d '{"targets":[{"parkId":"1280","surface":"grass"}]}'
```

日付省略時は日本時間の本日から7日間。検索は保存済み情報のみを返す。`POST /api/availability/updates`へ同じ対象・期間を送り、返された`jobId`を`GET /api/availability/updates/:jobId`で確認する。更新には稼働中のワーカーが必要（停止中は503）。祝日条件に必要な年の登録が未完了なら503を返す。[祝日データの登録・更新手順](docs/祝日データ.md)を参照（2026・2027年を同梱）。

公式への取得は更新APIまたは`storage enqueue`で登録し、ワーカーで実行する。DBの重複・停止制御を通らない旧検証CLIは削除済み。取得処理の検証は自動テストを利用する。

期間以外の検索条件は変更時にブラウザ内へ自動保存する。画面を開くと期間は常に日本時間の本日から7日間（終了日は6日後）になる。公園は名前検索付きの選択画面で最大5対象を指定する。時間帯は開始時刻を複数選択でき、選択なしは時間指定なし。開始時刻の絞り込みは、検索APIが返す検証済みの保存枠に対して画面側で行う（取得範囲は変更しない）。終了時刻は公園・季節により異なるため、取得値をそのまま表示する。公式サイトへは画面上部の共通リンクから別タブで移動する。検索条件の引き継ぎや枠のコピーは行わず、予約操作は公式側で行う。

機能開発はdevelopからfeatureブランチを作り、develop向けPRでレビューする。定期取得・本番公開は未実装。公式の「空き」「予約あり」「受付期間外」「保守日」に対応し、未知の状態は取得失敗とする。選択肢の照合と全対象の実取得確認は別であり、全公園・全状態と、公式の検索可能日の最遠上限は未確認。
