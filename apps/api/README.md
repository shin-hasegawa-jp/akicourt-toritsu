# API

Fastify + TypeScript。`GET /health`で疎通確認。起動・ポート指定・Docker・検証は[ルートREADME](../../README.md)を参照。

## コード品質チェック

`npm run format` で `src`・`test`・`scripts` を整形し、`npm run format:check` で差分を検査します。Prettierの設定はwebと同じです。

`npm run lint` はNode向けのOxlintと型情報を使うESLintを実行します。`npm run lint:fix` で自動修正できます。ESLintは未処理のPromise（`void`による無視も含む）、同期コールバックへのPromiseの誤用、Promise以外へのawaitを検出します。`node:test`のテスト登録はテストランナーが失敗を管理するため例外ですが、テスト内部の非同期処理は検査対象です。

CIではformat・lint・型チェック・テストを実行し、ファイルの自動修正は行いません。

## 保存先・参照データ

保存先はFirestore。祝日は`src/storage/holiday-calendar.ts`、公園は`src/storage/park-options.ts`で管理し、レビュー後に`seed-reference-data`で明示的に反映する。初期投入・運用コマンドは[ルートREADME](../../README.md)、祝日の更新方法は[祝日データ](../../docs/祝日データ.md)を参照。

`GET /api/availability/parks`はFirestoreの登録済み公園一覧を返す。Webはこの一覧を使用し、公式への通信は行わない。
