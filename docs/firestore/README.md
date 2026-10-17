# Firestore構成への実装変更・レビュー記録

2026-10-17 / FS-0 / Codex。設計レビュー用。アプリ実装・依存導入・GCP変更は未実施。
前提：GCP未デプロイ・空のDBから新規リリース。既存データ移行・二重DB運用は行わない。
基準コミット：`13d6b5e`（origin/develop）。元計画は隣接ノートの「インフラ/05_実装変更対応.md」。このディレクトリだけでPRをレビューできるよう契約を記録する。

| 単位 | 担当・前提 | 成果と完了条件 | 状態 |
| --- | --- | --- | --- |
| FS-0 | Codex設計、開発者依存導入 | 契約・データモデル・導入手順をレビュー可能にし、導入後lockfile確認 | 文書作成済み、承認・導入・lockfile確認待ち |
| FS-1 | Codex、FS-0承認と依存準備後 | Repository、保存検索、chunk公開、初期投入、Rules/index、エミュレータ境界・世代切替テスト | 未実施 |
| FS-2 | Codex、FS-1承認後 | outbox、Tasks、全体枠、worker、セッション保存、競合・中断・再配送テスト | 未実施 |
| FS-3 | Codex、FS-2承認後 | API/UI、制限・処理予算、コンテナ・Hosting、認証とルート分離 | 未実施 |
| FS-4 | Codex・開発者、FS-3承認とGCP準備後 | 実GCP、公式1対象、実機、復旧、時間・費用の引渡し | 未実施 |

- [契約・データモデル](contracts.md)：費用、整合性、既存UI互換がレビュー観点。
- [05の設計レビュー記録](review.md)：新規リリース前提への修正と残る実測事項。
- [依存導入・ローカル準備](setup.md)：開発者が実行し、Codexが差分とlockfileを確認する。

各単位はdevelopからfeatureブランチ、develop向けDraft PRに分ける。承認・マージ前に次の単位へ進まない。実装とレビュー承認は別に記録する。FS-2はFS-2a（outbox・全体枠・dispatcher）、FS-2b（セッションDTO・通信チェックポイント）、FS-2c（HTTP worker・lease・中断・復旧の結合）へ分け、この順で各PRを承認・マージして進める。FS-2cまで完了後にFS-3へ進む。FS-1のchunk公開試験は合成writerで行い、公式workerに依存させない。

## 現行コードとの差分

- `storage/database.ts`・`store.ts`・`availability-api/service.ts`はpg依存。検索はREPEATABLE READであり、一貫性を維持する。
- `plugins/reference-data.ts`が起動時にmigration・公園/祝日同期を行う。Firestore起動では実行せず、バージョン付き管理CLIへ移す。公園削除時の履歴保全、祝日完全性を継承する。
- `/availability/parks`も移行対象。公園カタログのAPI利用を維持する。
- `AcquisitionSession`はプロセス内のCookieJar・Set・Map。永続DTOと通信の前後フックが必要。
- Webの条件入力は5対象だが、`SearchSchema.scopes`・`UpdatesSchema.jobs`の上限は4。FS-3で10へ揃え、5対象の週跨ぎを検証する。
- 現行Viteは/apiを削除。FS-3でAPI自体を/api配下に統一する。

## 確認結果

文書内リンク・git diff --check・現行コードとAPI項目の照合を実施。SDKバージョン/Node要件はnpmレジストリを参照。Node v24.18.0は確認済み、Java未導入。依存とlockfileは変更していない。
型・ビルド・単体/エミュレータ・実DB・公式通信・ブラウザ・GCP/IAM/OIDCの検証は今回未実施。FS-0の文書確認を実装の動作確認として扱わない。
2026-10-17追記：新規リリース前提のレビューを実施し、データ移行/DB併存を除外、初期化・配送待ち判定・登録予算・FS-2分割を修正。詳細はreview.md。
レビュー承認：未確認。依存導入後のlockfile確認：未実施。
