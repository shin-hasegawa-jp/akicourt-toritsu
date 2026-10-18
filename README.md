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

## Firestoreのローカル検証

Java・Firebase CLIをDocker内で動かす。ホストへのJava導入やGCPログインは不要。

```sh
docker compose -f compose.dev.yaml -f compose.firestore.yaml up -d --build --wait --wait-timeout 300
docker compose -f compose.dev.yaml -f compose.firestore.yaml exec -T api node scripts/check-firestore-emulator.cjs
```

APIコンテナからは`firestore:8080`、ホストからは`127.0.0.1:17593`へ接続する。ホスト側ポートは`FIRESTORE_PORT`で変更できる。プロジェクトは`demo-akicourt-local`固定。エミュレータ再起動でデータは消える。公園一覧・検索・更新・ジョブ参照APIはFirestoreを使用する。起動後に下記CLIで初期化・公園/祝日投入を行うと、公園一覧と未取得の検索結果を確認できる。DBなし起動はhealthのみ確認でき、保存情報のAPIは503を返す。ローカルのタスク配送・worker起動は後続対応のため、通常のローカル更新APIは503。偽dispatcherを用いた更新から保存・検索までの接続は統合テストで確認する。

Firestoreの管理操作はAPIコンテナ内のコンパイル済みCLIを使う。書込みは既定dry-runで、`--apply`を付けた時だけ反映する。 `repair-outbox`は登録待ちのqueuedジョブを最大10件確認し、`--apply`で再登録する。本物のCloud Tasksへの登録は本番設定（`TASKS_LOCATION`・`TASKS_QUEUE`・`TASKS_CALLER_SA`・`WORKER_URL`）が必要で、ローカルではdry-runのみ。

```sh
# 起動中のAPIコンテナで、まず変更内容を確認する
docker compose -f compose.dev.yaml -f compose.firestore.yaml exec -T api node dist/storage/firestore-cli.js initialize --project demo-akicourt-local --database '(default)'
# 初期化を反映（更新受付は停止状態）
docker compose -f compose.dev.yaml -f compose.firestore.yaml exec -T api node dist/storage/firestore-cli.js initialize --project demo-akicourt-local --database '(default)' --apply
# 公園・祝日を投入。--applyを外すとdry-run
docker compose -f compose.dev.yaml -f compose.firestore.yaml exec -T api node dist/storage/firestore-cli.js seed-reference-data --project demo-akicourt-local --database '(default)' --apply
docker compose -f compose.dev.yaml -f compose.firestore.yaml exec -T api node dist/storage/firestore-cli.js status --project demo-akicourt-local --database '(default)'
docker compose -f compose.dev.yaml -f compose.firestore.yaml exec -T api npm run test:firestore
# 停止
docker compose -f compose.dev.yaml -f compose.firestore.yaml down
```

参照データの投入は取得停止・所有者なしの状態で行う。初期化の再実行で停止理由やカウンターはリセットしない。不完全な初期状態では書き換えずエラーにする。テストは実行ごとの専用エミュレータDBを使い、既存のローカルデータを削除しない。

管理CLIの追加コマンド（上記コマンドの`initialize`部分を置き換える）：

| コマンド | 操作 |
| --- | --- |
| `status` | 停止理由・所有権解放・復元可否・待機期限を確認。Cookie本文は表示しない |
| `pause` / `resume` | 取得停止 / 再開。再開には所有権解放・有効DTO・待機期限経過が必要。別の停止解除コマンドは不要 |
| `acquisition-reset` | 取得停止・タスク破棄・未完了ジョブ終端化・所有権解放・セッション再作成・未処理数0への一括リセット |

通常の運用は`pause → 確認/作業 → resume`。取得が進まなくなったら、まず`acquisition-reset`をdry-runで実行し、対象プロジェクト/DB・取得専用キュー・対象件数を確認する。旧workerの終了を確認して`acquisition-reset --apply --confirm-worker-stopped`を適用し、表示された待機期限（最低15分、既存期限が先なら維持）後に`resume`する。リセット前に`pause`を実行する必要はない。リセットは公式通信を行わず、空き状況・公園・祝日・日次取得件数を保持する。`session-clear`・個別ジョブ修復・カウンター再計算は用意しない。

本番では`TASKS_LOCATION`・`TASKS_QUEUE`で指定した取得専用Cloud Tasksキューを停止・purgeする。`resume`はキューを再開してからDBの取得許可を戻す。管理CLIの実行者にはFirestore更新に加え、キューのpause/purge/resume権限が必要。ローカルエミュレータではCloud Tasks操作を省略し、結果に`local-emulator-skipped`と表示する。途中失敗時も取得を止めたままにし、`acquisition-reset`を再実行する。タスク破棄では実行中HTTPの終了を保証しないため、旧worker終了確認は省略しない。未完了ジョブが100件を超える場合は上限エラーで停止し、途中までの初期化を成功扱いしない。履歴整理は必要時に別途対応。

`invalid-home`は初期化を15分抑制し、全体を手動再開待ちにはしない。明示的なセッションタイムアウトは`1→3→4`で1回復旧する。他の公式応答エラーはログ・ジョブ失敗・15分抑制へまとめ、DBへ失敗を確定できればworkerは2xxで終了する。通信結果不明時は取得を停止し、DB障害等で状態確定できない場合は後続通信を止めて5xxを返す。ログはjobId・対象・段階・判定・実HTTPステータスのみで、Cookie・応答本文・生のSDK例外を含めない。

## ホストで起動

Node.js 24.18.0（`.nvmrc`）を使用。各アプリで`npm ci`を実行後、別ターミナルで起動する。Dockerと同じポートを同時に使わない。

```sh
# apps/api
PORT=17591 npm run dev
# apps/web
WEB_PORT=17590 API_PROXY_TARGET=http://127.0.0.1:17591 npm run dev
```

## 確認

画面は検索・更新APIへ接続する。疎通確認は`GET /health`または`GET /api/health`を使用する。`/api/*`の転送はViteの開発プロキシを使用。

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

## APIの受付と再試行

短時間枠はAPIインスタンスごとの固定60秒窓で、公園一覧60・検索60・ジョブ参照300・更新12リクエスト。上限時はDBへアクセスせず429とRetry-Afterを返す。再起動でリセットされ、複数インスタンスでは共有しない。公式取得の未処理数・日次上限はFirestore側で別途維持する。

API全体の待機は30秒、Firestore処理の待機は10秒、画面は35秒。Tasks登録は従来どおり個別最大5秒・全体10秒。時間切れは503 request_timeoutとし、発行済みSDK操作の取消しは保証しない。更新を再送すると同じ対象週の有効ジョブを再利用する。429・通信失敗時は進捗の自動確認を止め、画面の案内に従って手動で再試行する。更新停止時に利用者へworker起動操作は求めない。

## API／workerの起動

`npm start`はビルド後に`dist/server.js`を起動する。ローカルの`npm run dev`も同じ入口を監視起動する。公開APIは`/api/availability/*`、workerは`/tasks/acquire`だけを登録し、公開APIへworkerルートを載せない。Viteは`/api`を除去せずAPIへ転送する。

本番は`NODE_ENV=production`と`APP_ROLE=api`または`worker`を必須とし、`PORT`（既定8080）で0.0.0.0待受する。ローカルはapiが既定、PORT=17591・API_HOST=127.0.0.1で起動する（DockerはAPI_HOST=0.0.0.0）。本番workerはCloud Run IAMを必須とし、公開サービスとして配置しない。タスクヘッダーだけでは認証しない。ローカルworkerの保存応答/配送配線はFS-3cで追加するため、それまではworker起動を拒否し公式通信を始めない。

## 本番用の配布設定

API/worker共通イメージは`apps/api/Dockerfile`でビルドする。ビルド段階でTypeScriptをコンパイルし、実行段階は本番依存とdistを配置して非rootユーザーで起動する。

```sh
docker build --platform linux/amd64 -t akicourt-toritsu:release-check -f apps/api/Dockerfile apps/api
node apps/api/scripts/check-production-image.cjs akicourt-toritsu:release-check
```

検証スクリプトは外部ネットワークなし・読取専用の一時コンテナでAPI/workerのhealth、不正入力、ルート分離、SIGTERM終了を確認し、コンテナを削除する。実DBや公式取得の検証は含まない。

ルートの`firebase.json`はWebのdistを配信し、`/api/**`を東京の`akicourt-toritsu-api-prod`へ転送する。HTML・SPA fallback等はno-cache、APIパスはno-storeとする。FirestoreのRules/indexは`apps/api/firestore-emulator/`の既存ファイルを共用する。実プロジェクトへのHosting target設定・デプロイ・IAM確認はGCP構築時に行う。[Hosting設定の仕様](https://firebase.google.com/docs/hosting/full-config)。

## CI・依存更新

GitHub Actionsの`CI`はmain・developへのpushとすべてのPRで実行する。Node.jsは`.nvmrc`を参照し、Webのlint・型チェック・ビルド・単体テストと、APIの型チェック・ビルド・単体テスト・PostgreSQL 18での統合テストを検証する。FirestoreジョブではDockerエミュレータの起動・SDK疎通・初期投入/読取の統合テストも行う。Production imageジョブでは本番イメージをビルドし、外部通信なしでAPI/workerの起動確認を行う。lintは自動修正を行わない。CIの依存インストールには`npm ci --ignore-scripts`を使い、依存パッケージのライフサイクルスクリプトを実行しない。テストでは公式サイトへの実通信を行わない。

Dependabotは毎週月曜9:00（日本時間）にnpm・GitHub Actions・Dockerfile・Composeの依存更新を確認し、develop向けPRを作成する。通常の依存更新は公開から7日間のクールダウンを設け、新規リリース直後の不正なパッケージ混入リスクを抑える。クールダウンはセキュリティ更新には適用されない。npmとDocker関連のminor・patch更新をまとめ、major更新は個別にレビューする。Dependabotを有効にするには`.github/dependabot.yml`をリポジトリのデフォルトブランチにも反映する。

## 検索・更新API

```sh
curl -sS http://127.0.0.1:17590/api/availability/search -H 'Content-Type: application/json' -d '{"targets":[{"parkId":"1280","surface":"grass"}]}'
```

日付省略時は日本時間の本日から7日間。検索は保存済み情報のみを返す。`POST /api/availability/updates`へ同じ対象・期間を送り、返された`jobId`を`GET /api/availability/updates/:jobId`で確認する。更新にはCloud Tasksの本番設定とDBの更新許可が必要（停止中は503）。workerがscale-to-zeroでも受付可能。祝日条件に必要な年の登録が未完了なら503を返す。[祝日データの登録・更新手順](docs/祝日データ.md)を参照（2026・2027年を同梱）。

公式への取得は更新APIで登録し、タスク配送先のworkerで実行する。同じ対象週の再送は既存ジョブを再利用し、登録待ちの場合だけタスク登録を再試行する。公開APIは公式へ直接通信しない。旧PostgreSQLのコード・CLI・Compose・CIは段階的な除去待ちで、公開APIからは使用しない。

期間以外の検索条件は変更時にブラウザ内へ自動保存する。画面を開くと期間は常に日本時間の本日から7日間（終了日は6日後）になる。公園は名前検索付きの選択画面で最大5対象を指定する。時間帯は開始時刻を複数選択でき、選択なしは時間指定なし。開始時刻の絞り込みは、検索APIが返す検証済みの保存枠に対して画面側で行う（取得範囲は変更しない）。終了時刻は公園・季節により異なるため、取得値をそのまま表示する。公式サイトへは画面上部の共通リンクから別タブで移動する。検索条件の引き継ぎや枠のコピーは行わず、予約操作は公式側で行う。

機能開発はdevelopからfeatureブランチを作り、develop向けPRでレビューする。定期取得・本番公開は未実装。公式の「空き」「予約あり」「受付期間外」「保守日」に対応し、未知の状態は取得失敗とする。選択肢の照合と全対象の実取得確認は別であり、全公園・全状態と、公式の検索可能日の最遠上限は未確認。

## マスターデータの投入

APIの起動時にDBの同期・初期化は行わない。Firestore管理CLIで初回の`initialize`と`seed-reference-data`を明示実行する。公園・祝日の変更時も取得停止・所有権解放後にseedする。祝日の管理元は`apps/api/src/storage/holiday-calendar.ts`、公園は`apps/api/src/storage/park-options.ts`。画面の一覧はFirestoreの投入済みカタログから取得する。
