# API

Fastify + TypeScript。`GET /health`で疎通確認。起動・ポート指定・Docker・検証は[ルートREADME](../../README.md)を参照。

公園一覧の整合性チェックは、取得ワーカーを停止してから `npm run storage -- check-parks` で手動実行します（`DATABASE_URL` が必要）。公式の人工芝・ハード一覧とコード内の`src/storage/park-options.ts`を比較し、追加・未掲載・名称変更をJSONで報告します。公園情報は自動変更しません。未掲載は一時休止の可能性もあるため、削除前に確認してください。通常の空き情報取得では公園一覧へアクセスしません。

## コード品質チェック

`npm run format` で `src`・`test`・`scripts` を整形し、`npm run format:check` で差分を検査します。Prettierの設定はwebと同じです。

`npm run lint` はNode向けのOxlintと型情報を使うESLintを実行します。`npm run lint:fix` で自動修正できます。ESLintは未処理のPromise（`void`による無視も含む）、同期コールバックへのPromiseの誤用、Promise以外へのawaitを検出します。`node:test`のテスト登録はテストランナーが失敗を管理するため例外ですが、テスト内部の非同期処理は検査対象です。

CIではformat・lint・型チェック・テストを実行し、ファイルの自動修正は行いません。

`DATABASE_URL`を設定したAPIは起動時にマイグレーションと祝日・公園マスターの同期を行います。祝日は`src/storage/holiday-calendar.ts`、公園は`src/storage/park-options.ts`を編集します。同期完了までリクエストを受け付けず、失敗時は起動しません。事前実行には`npm run storage -- prepare`を使います。公式一覧との照合コマンドは公園マスターを書き換えません。

`GET /api/availability/parks` はコード内の公園カタログから、種目別の表示順・名称・初期選択を返します。Webはこの一覧を使用し、公園定義を持ちません。DB接続なしでも一覧を返し、公式への通信は行いません。

## 公園のDB同期確認

`npm run storage -- check-parks-db` はコードとDBの公園マスターを比較します（`DATABASE_URL` が必要）。公式へ通信せず、取得ワーカーの停止も不要です。コード内の対象がDBにない・名称が違う・無効になっている場合、またはコード外の公園が有効な場合は `synchronized: false` と差分を返し、終了コード1になります。一致時は終了コード0です。コードから外して無効化した履歴用の公園は `retainedDisabled` に表示し、同期不一致には含めません。DBを変更せず、同期前の状態をそのまま検査します。

`check-parks` の出力は `comparison: official-vs-code` と `codeCount` を使用します（旧 `localCount` と `disabledButListed` は削除）。DBの接続は公式への通信を制御するリース・停止状態の管理に引き続き必要です。公式一覧の差分は更新判断の材料として報告し、コマンドの終了コードは従来どおり取得成功時0です。未掲載を自動的に廃止と判断しません。
