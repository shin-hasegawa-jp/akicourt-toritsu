# API

Fastify + TypeScript。`GET /health`で疎通確認。起動・ポート指定・Docker・検証は[ルートREADME](../../README.md)を参照。

公園一覧の整合性チェックは、取得ワーカーを停止してから `npm run storage -- check-parks` で手動実行します（`DATABASE_URL` が必要）。公式の人工芝・ハード一覧とDBの公園情報を比較し、追加・未掲載・名称変更・無効化済み対象の掲載をJSONで報告します。公園情報は自動変更しません。未掲載は一時休止の可能性もあるため、削除前に確認してください。通常の空き情報取得では公園一覧へアクセスしません。

## コード品質チェック

`npm run format` で `src`・`test`・`scripts` を整形し、`npm run format:check` で差分を検査します。Prettierの設定はwebと同じです。

`npm run lint` はNode向けのOxlintと型情報を使うESLintを実行します。`npm run lint:fix` で自動修正できます。ESLintは未処理のPromise（`void`による無視も含む）、同期コールバックへのPromiseの誤用、Promise以外へのawaitを検出します。`node:test`のテスト登録はテストランナーが失敗を管理するため例外ですが、テスト内部の非同期処理は検査対象です。

CIではformat・lint・型チェック・テストを実行し、ファイルの自動修正は行いません。

`DATABASE_URL`を設定したAPIは起動時にマイグレーションと祝日・公園マスターの同期を行います。祝日は`src/storage/holiday-calendar.ts`、公園は`src/storage/park-options.ts`を編集します。同期完了までリクエストを受け付けず、失敗時は起動しません。事前実行には`npm run storage -- prepare`を使います。公式一覧との照合コマンドは読み取り専用です。
