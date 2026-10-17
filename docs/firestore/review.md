# 05_実装変更対応の設計レビュー

2026-10-17 / Codex / 対象：隣接ノート「インフラ/05_実装変更対応.md」と本PRのFS-0契約。GCP未デプロイ、既存データの移行不要、空のDBから新規リリースするという補足を適用する。実装・本番動作のレビュー完了を意味しない。

## 結論

Hosting＋公開API＋IAM限定worker＋Firestore＋Cloud Tasksの分離、要求時取得、公式通信の直列制御、outbox、旧結果保持の方針は採用目的に合う。ただし修正前は初回投入と既存環境移行が混ざり、初期化と正常な配送待ちの扱いが不足していた。本PRで下記を修正した。FS-0はレビュー・依存導入確認待ち、FS-1以降は未実施。

## 指摘と対応

| 重要度 | 指摘・影響 | 文書への反映 |
| --- | --- | --- |
| P1 | 初回リリースなのに、旧DBのexport/変換、停止/cooldown移行、backend併存、migration-checkを要求していた。不要な実装・検証と切替リスクが増える | データ移行を範囲外としFirestoreのみでリリース。旧コードは置換途中のみ残しFS-3までに整理。既存環境の切替ツールを作らない |
| P1 | 空DBの制御/カウンター/セッションを誰が作るか不明。欠損DTOを一律復旧待ちにすると初回取得できず、欠損を自動初期化すると稼働後の状態消失を見逃す | initialize CLIで停止状態と空DTOを原子的に作成、既存完全状態はno-op、不整合は停止。明示した初回空DTOのみhome取得を許可。seed→検索→IAM/Tasks→resume→1対象取得の順を定義 |
| P1 | FS-0案のsubmitted待機20分で復旧必須という判定は、同時配送1・1job最大830秒の正常待機を障害扱いし、画面pollを止める。20jobなら先行19件だけで約263分にもなる | queuedの経過時間だけではrecoveryRequiredにしない。長期待機はtask存在/キュー/試行履歴を運用者が照合。公開画面へ管理CLI操作を要求しない |
| P2 | 最大10jobで各task登録5秒を直列に待つと登録だけで50秒となりAPI予算45秒を超える。元05は全体予算のみで具体的な登録方針がなかった | 登録全体10秒・同時2件・個別最大5秒と残時間制御。保存確定後の未登録分はpendingで202、再送/手動CLIで補う。応答後処理は使わない |
| P2 | FS-2にoutbox/カウンター/セッション/worker/障害復旧が集中し、小さいPRという要求に合わない。FS-1のchunk公開試験がworkerに依存すると順序も逆転する | FS-2a/b/cに分割し個別承認。FS-1は合成writerで保存・公開を検証し、FS-2cで取得処理を結合する |
| P2 | 前回ノート更新でFS-2のDTO実装1項目が誤って完了表示だった。本文の「未実施」とも矛盾 | 未実施へ訂正。FS-0の文書作成と実装完了・承認を分けて記録 |

指摘箇所は修正済み。レビュー承認は別途必要。稼働後のDB消失・停止理由保全は必要な運用なので残すが、初回のデータ移行作業には含めない。過去の開発検証で公式拒否が未解決なら運用上確認することも、DB転送の要件とは分ける。

## 方針を維持した点

- 常駐workerを要求中のHTTP workerへ置換する方針はscale-to-zeroに合う。公式要求間隔はキュー設定だけに依存せず、全体lease/fenceと各HTTP前の確認で制御する。
- FirestoreとTasksは原子的に更新できないためoutboxを残す。重複配送・旧世代・登録後応答喪失を想定し、task名だけに排他を任せない。
- 同一読取snapshotとimmutable chunkで検索の整合性を維持する。新規アプリでも、欠損や失敗を「空きなし」に変えるのは避ける。
- Cookie再利用と通信の前後チェックポイントは実装負荷・DB操作量が大きいが、タスク間再利用と状態不明時の停止という採用要件に必要。固定IPや別DB、定期修復は今回増やさない。
- IAM/OIDC、Hosting経路、公式別インスタンスでの再利用はローカル合成試験では確認できないためFS-4へ残す。

## 実装時に解消する未確認事項

| 時期 | 未確認・合格条件 |
| --- | --- |
| FS-0導入後 | 選定SDKとlockfile、Java/エミュレータの準備。設計文書だけで完了にしない |
| FS-1 | 10scope・10,000枠のread-only transactionが45秒/サイズ予算内に収まること。chunk上限を超えたら明示エラーとし部分成功へ落とさない。JSON byte・文書size・index容量・wireを混同しない |
| FS-2 | 初期空DTOと欠損/期限切れの区別、通信後保存前終了・古いowner・内部retry停止、カウンター二重計上防止。lease競合だけの再配送で公式へ再通信しない |
| FS-2/3 | 10job登録遅延でも要求予算を守り、pendingを再送/修復できること。通常の長いqueuedで障害表示/poll停止をしないこと |
| FS-3 | 5対象週跨ぎ10scopeをAPI/UI双方が受理すること。現在Webの応答schema上限は4。/parksもFirestore版に対応し、起動時SQL同期を残さない |
| FS-4 | 実Firestoreの整合性/index、IAM/OIDC、Hosting、公式1対象と別タスク再利用、時間・操作量・費用。別IPでのCookie有効性は保証せず、実証できなければリリース受入を保留 |

受付制限値・32MiB等は設計初期値で、無料枠適合や実性能を保証する値ではない。未処理20件・直列取得は待ち時間が長くなり得る。通常利用の取得時間を測定し、公開前に上限と待機表示の妥当性を再確認する。

## 確認した根拠

現行のAPI/service、worker、AcquisitionSession、参照データ自動同期、公園API、WebのschemaとVite設定を照合。文書内リンク・差分を検査した。公式サイトへ通信せず、GCP操作・依存導入・アプリ実装は行っていない。

- [Cloud Tasksの順序・重複・遅延](https://cloud.google.com/tasks/docs/common-pitfalls)：FIFOを前提にせず、待機時間だけで配送消失を断定しない。
- [キューの制限と再試行](https://cloud.google.com/tasks/docs/configuring-queues)：同時配送と再試行は公式HTTP間隔の代替にはしない。
- [HTTP task作成](https://cloud.google.com/tasks/docs/creating-http-target-tasks)：taskごとのdeadlineとOIDC付き配送を設定する。
- [Firestore transactionの整合性](https://cloud.google.com/firestore/docs/transaction-data-contention)、[制限](https://cloud.google.com/firestore/quotas)：サイズ・時間・整合性を検証する根拠。
- [HostingとCloud Run](https://firebase.google.com/docs/hosting/cloud-run)：保持されるパスとHosting側の時間制約を実配信で確認する。
