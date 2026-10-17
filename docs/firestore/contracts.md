# FS-0 契約・データモデル

2026-10-17。GCP未デプロイの新規アプリを空のFirestoreから初回リリースする。既存DB・取得結果・ジョブ・Cookie・停止状態のデータ移行、二重DB対応、旧本番への切戻しは対象外。以下は承認対象の設計値で、現在の実装値ではない。利用者認証、定期取得、通知、固定IP/NAT、金額による自動停止は追加しない。

## 公開APIと画面

`/api/availability/search`・`/updates`・`/updates/:jobId`・`/parks`を公開する。利用者のAuthorizationは不要。APIとworkerは同一イメージでもAPP_ROLEで登録ルートを分離する。workerは`/health`と`/tasks/acquire`のみ、Cloud Run IAMでtask-callerのOIDCを要求する。task名ヘッダーを認証に使わない。公開APIにworker経路を登録しない。

入力、既存レスポンス項目、queued/running/succeeded/failed、最大5対象・日本時間7日・週跨ぎ10scope、全体10,000枠、曜日/祝日/時間、15分fresh/stale、失敗時の旧結果を維持する。祝日未登録は503。未取得・取得失敗・成功した空結果を区別する。保存済み条件の形式を変えない。

job応答（更新レスポンス内も同じ）に次を必須追加する。FS-3でAPIのJSON SchemaとWebのValibotを同時変更する。検索のlatestAttemptにもdispatchStateとrecoveryRequiredを追加する。

| 項目 | 契約 |
| --- | --- |
| dispatchState | pending / submitted / recovery_required。登録状態であり実行状態とは別 |
| recoveryRequired | boolean。運用者による復旧が必要か |

pendingは「取得要求を保存済み・配送登録待ち」、submittedのqueuedは「取得待ち」、runningは「取得中」。pendingが120秒継続、またはrunningのlease失効でrecoveryRequired=trueとし、画面には「登録確認が必要」「取得中断の確認が必要」と表示する。公開利用者へ管理CLI操作は求めない。submittedのqueuedは経過時間だけで復旧必須としない。単一配送で最大20jobが順に処理される場合、830秒×19件で約263分の待機も起こり得るため、20分固定で障害扱いしない。待機表示と緩やかなpollを継続し、運用者がtaskの存在・キュー状態・試行履歴を照合して消失等を確定した場合だけrecovery_requiredを保存する。FIFOや待ち時間の上限は保証しない。GETによるDB書込みは不要。submittedだけでtaskの存在を保証しない。

queued/runningが1件でもあれば202、全jobが終端済みなら200（既存契約。再利用した未完了jobも202）。登録遅延でも保存確定済みなら202。同じ更新再送は同じ有効jobを使いpending登録を再試行する。保存を確認できない要求は202にしない。応答喪失後も二重取得しない。停止中の新規更新は503・worker_unavailable。平常時のscale-to-zeroは受付可能。既存queuedが停止中に配送されたら公式通信せずfailed、errorCode=updates_disabledまたはaccess_blockedで終端化する。session_recovery_required・interruptedもfailedとして理由を表示し、独自の公開stateを増やさない。

検索・更新・job・parksの成功/エラー応答はCache-Control: no-store。HTMLはno-cacheで再検証し、ハッシュ付きassetsは長期immutableとする。Hostingの/・/index.html・SPA fallbackとrun.app直アクセスをFS-3/4で確認する。

429はerror.code=rate_limited / queue_capacity_exceeded / daily_job_limit_exceeded。Retry-Afterは正の整数秒（短時間枠は残り時間切上げ、queueは30秒、日次は翌JST日境界まで）。API予算超過は503・request_timeout、読取上限超過は503・search_capacity_exceeded、不完全snapshotは503・storage_unavailable。10,000枠超過時の既存エラー契約は維持し、黙って切り捨てない。

Webは更新の連打を無効化、jobを5秒以上の間隔で確認（10jobでも最大120参照/分）。状態の変わらないqueuedは5/15/30/60秒へ段階的に間隔を延ばし、runningへ変われば5秒へ戻す。画面が非表示の間は自動pollを停止し、再表示時に再確認する。429/503/ネットワーク失敗は5/10/20/40/60秒＋最大20%のjitterでバックオフ、Retry-Afterを下回らない。succeeded/failed、recoveryRequired=trueでは自動poll停止、再確認と更新の手動操作を残す。登録待ちを取得中と表示しない。timeout後の手動再要求も同じscopeを利用する。

## 制限と処理予算

| 設定名 | 初期値 | 範囲 |
| --- | --- | --- |
| API_SEARCH_PER_MINUTE | 60 | 検索・インスタンス全体 |
| API_JOB_READS_PER_MINUTE | 300 | job参照・インスタンス全体 |
| API_UPDATES_PER_MINUTE | 12 | 更新要求・インスタンス全体 |
| API_PARKS_PER_MINUTE | 60 | 公園一覧・インスタンス全体 |
| ACQUISITION_MAX_PENDING_JOBS | 20 | DB上の全未終端job、日付をまたぐ |
| ACQUISITION_DAILY_NEW_JOB_LIMIT | 100 | JST日付、新規jobのみ |
| API_REQUEST_BUDGET_MS | 45000 | ハンドラ受付から、workerは対象外 |

短時間枠はエンドポイント種別ごとの固定60秒窓で、単調時計を使いFirestore前に判定する。窓境界の集中は許容する。IP/転送ヘッダーは使わない。起動時に正の安全な整数として検証、未知roleや不正値は起動失敗。API最大2台の枠は共有されず、再起動でリセットする。金額上限ではない。1人が最大10jobをpollしても参照300/分内に収まる初期値とする。

更新要求内の全scopeを同じtransactionで判定し、新規分Nを数える。queueのN加算とJST当日のusageのN加算、scope/job作成を一括commit。1件でも上限を超えたら要求全体を429、部分受付しない。全件再利用はN=0で上限到達中も可能（全体停止時の新規受付は不可）。終端遷移時にqueueを一度だけ減算、日次数は減らさない。重複配送/失敗でも二重減算しない。CLIは更新停止・worker静止を確認し、全未終端jobとの照合からqueueを修復する。日次数は作成日時/計上日で再集計する。

最大10taskを各5秒ずつ直列登録すると45秒を超える。登録処理は要求全体で最大10秒、同時2件までとし、保存済みjobのpendingを残して予算内に202を返せるようにする。応答後の処理継続に依存せず、未登録分は同じ更新の再送または手動repair-outboxで補う。応答構築の残り時間も確保する。

45秒はコールドスタート/Hosting待機を含まない。残り時間をDB読み取り・transaction・Tasks登録へ渡す（個別RPCは最大10秒と残時間の小さい方、transaction最大3試行、Tasks登録最大5秒）。予算後に新規処理を開始しない。SDKの取消不能な既発行処理は後からcommitし得るので、Promise.raceだけで二重登録対策を済ませない。outboxで整合させ、短縮時計でFS-3テストする。

## データモデルと検索の整合性

時刻はFirestore Timestamp、公開JSONでは既存ISO形式。scope IDは`parkId_surface_YYYY-MM-DD`（検証済み週開始日）、job/snapshotはUUID。内部文書はschemaVersion=1。公式URLや配送先を利用者入力から組み立てない。

| 文書 | 主要フィールド・更新ルール |
| --- | --- |
| parkSurfaces/{id} | parkId,surface,name,enabled,officialOrder,version。削除は無効化し履歴維持 |
| holidayYears/{year} | 完全なdates,source,checksum,version。validateCalendar成功後に年単位で公開 |
| control/referenceData | activeVersion。公園/祝日の版切替を管理CLIで公開、未完の版を検索させない |
| scopes/{id} | latestSnapshotId,previousSnapshotId,latestJobId,cooldownUntil,publicationGeneration,observedAt |
| jobs/{id} | scopeId,state,dispatchState,generation,owner,fence,leaseUntil,attempts,計上日,進捗/時刻/安全なerrorCode |
| snapshots/{id} | scopeId,complete,chunkIds,chunkCount,totalSlots,checksum,observedAt,schemaVersion |
| snapshots/{id}/chunks/{id} | ordinal,施設と枠のpayload,checksum。公開後immutable |
| officialSessions/current | 下記DTOと所有権/復元状態 |
| control/acquisition | updatesEnabled,blockedReason,owner,leaseUntil,fence,nextRequestNotBefore,recoveryGeneration |
| usage/{JST日付} | newJobCount |
| control/queueCapacity | pendingJobCount |

初期投入は同梱公園/祝日から行い、同じversion/checksumはno-op。公園31文書・祝日・activeVersionを1transactionで公開し検索も同じ読取snapshotで照合する。版と内容が不一致なら503。起動時の自動migration/同期はFirestore側で廃止する。将来サイズが大きくなり1transactionで公開できない場合は別レビューでモデル変更する。

検索はread-only transactionの同一snapshotで公園/版・scope・最新job・manifest・chunk・必要年の祝日を取得する。参照が未公開・欠落・checksum不一致なら503。全10scopeを読んでからフィルタし、partial coverageは正常な未取得/過去失敗だけを示す。異世代混在や読取打切りをpartial成功にしない。

chunk payloadはUTF-8 JSONで256KiB以下、文書全体も公式サイズ計算で512KiB以下、単一slotが超える場合は保存失敗。1snapshot最大64chunk、検索最大640chunk、アプリ集計読取データ予算32MiBと時間45秒を別々に検査する。上限超過はsearch_capacity_exceeded。この32MiBは公式の10MiB API要求上限と同一ではない。実SDKのwire/文書サイズ・時間が制約内かをFS-1で検証し、合わなければ上限/モデルを再レビューする。10,000枠以下でも極端に大きな名称等は明示エラーとなり得る。

未公開snapshotへ全chunkを分割書込み、件数・順序・checksum検証後にcomplete確定、owner/fence/generationを条件としてscope参照/job成功/cooldown/queue減算をtransactionで公開する。chunk失敗時は旧latestを維持。管理削除は最新＋直前世代、cooldown/未終端参照を保護。終端job7日、孤立chunkと旧snapshotは参照外となって24時間後から削除可。検索snapshotと競合した欠落は予算内で検索全体を1回再試行し、解消しなければ503。削除はdry-runと直前参照再チェック、セッション/停止理由は履歴削除から除外。

## Index・サイズ・操作量の測定

FS-1でfirestore.rulesはクライアント直接アクセス全拒否（サーバーSDKはIAM）、firestore.indexes.jsonに以下を定義する。初期は管理CLIの全走査を許容し、不要な複合indexは作らない。

- chunks.payload、holidayYears.dates、officialSessionsのcookieJar/prepared/targetsは単一field indexを除外。検索しないsnapshot.chunkIdsも除外。
- APIは既知IDのget/getAll、parkSurfacesは最大31件の一覧読取。outboxはjobsのdispatchStateで絞り、経過時間をCLIで検査。jobsのstate/dispatchState/createdAtは単一field indexを維持する。親snapshot削除でsubcollectionは消えないためchunkを明示削除。
- 文書サイズとindex領域を分け、公式のstorage-size算式で日本語・長いID・配列・名前pathを測る。JSONバイト数だけで1MiB適合と報告しない。index除外設定を実DBで確認する。
- FS-1合成データ：0/1/10,000/10,001枠、10scope、各最大chunk、chunk分割点、日本語長文、公開と検索/削除の競合。文書ごとの最大byte、検索全体byte、read/write/delete回数、RPC/transaction再試行回数、所要時間を保存。
- read回数の目安は公園31＋版1＋scope10＋job10＋manifest10＋chunk数C＋祝日年Y＝62+C+Y（未存在参照や再試行・管理走査も別加算）。job pollは1文書/回。無料枠内と保証しない。
- 公式HTTP1回ごとに前後チェックポイントの最低2transactionが増える。各transactionで読んだcontrol/job/session、更新した文書数を記録し、heartbeat・lease・間隔待機・再試行を含めjob別に集計する。Cookie/URL本文は出さない。
- FS-4の専用GCPで実SDKの最大データ読取・index・請求メトリクスを照合。エミュレータでIAM・課金・本番制限の実証とはしない。日次の検索/poll/新規job数と実測操作量から費用を算出し、無料枠試算と実績を分ける。

## セッションDTO・所有権・中断

DTO v1はcookieJar（tough-cookieのserialize結果）、initialized、prepared（重複なし文字列配列）、targets（parkId/surface別の名称/施設配列）、initializationRetryAt/Error、sessionGeneration、revision、lastUsedAt、inFlight（requestId/開始時刻/owner/fenceまたはnull）、restorationState（usable/recovery_required/disabled）を保持する。preparedとtargetsは同じ世代のCookieと不可分で保存する。公園・種別・施設ID、配列サイズ、日付、Cookieの期限/domain、schemaを復元時に検証する。Cookie期限切れや未知versionは勝手に初期化せずrecovery_required。有効Cookieがあっても公式側有効性は保証しない。期限情報のないsession Cookieも形式検証だけで有効とは断定しない。

通常の使用はworkerのみ。API用SAも同じDBへの読取権限を持つことは受容する。Cookieはログイン前の空き検索専用。API/画面/task本文/ログ/エラーへDTOやCookieを出さず、管理表示は世代・最終使用・復元可否・停止理由のみ。公式ログイン/予約は対象外。Cookie破棄は公式側の強制失効を意味しない。

1. job generation/終端、全体停止と初期化待機を確認。transactionで全体leaseとjobをclaim（lease90秒、heartbeat20秒、owner UUID、単調増加fence）。DTOのgeneration/revisionも取得する。
2. 各HTTP前にcontrol/job/sessionをtransactionで読み、所有権・停止・次回可能時刻・inFlightなしを確認。通信枠とinFlightを保存してからHTTPへ進む。transaction内でHTTPやTasksを呼ばない。
3. 応答後はCookieと準備フラグの更新、revision加算、inFlight解除、次回可能時刻を応答完了から2秒以上後へ進めるチェックポイントを保存する。timeout等の送達不明はinFlightを無条件に解除しない。内部retry前にもこの確定が必要で、beforeRequest/onProgressだけには依存しない。DB保存失敗なら後続HTTP停止。
4. 正常終了はDTO保存確認後にlease解放。すべての書込みはowner/fence/generation/revision比較で旧workerを拒否する。明示的セッションタイムアウトだけ1回home→施設→週間取得で復旧し、Cookieと準備情報を新世代へ一緒に切替える。
5. SIGTERM/HTTP abort/lease更新失敗/開始から830秒でAbortSignalを伝播。840秒より前の中断開始を確保する。task dispatchDeadlineは900秒、Cloud Run worker timeoutも900秒。deadlineだけでプロセス停止と考えない。

inFlightが残る終了・送達不明timeout・lease失効はjobをinterruptedとして少なくとも15分cooldownとsession復旧待ちにする。自動で新ownerへ引継がない。失効ownerが通信中かもしれないため、CLIでworker停止/進行要求終了を確認してから復旧する。home403/429は全体blockedを保存しtask再配送やセッション破棄で解除しない。invalid-home/初期化失敗も理由と次回初期化時刻（最低15分後）を共有し、状態不明なら運用者確認まで待つ。初回もupdatesEnabled=falseで開始する。過去の開発検証で公式から拒否された事実が未解決なら、DB移行はせず運用確認事項として記録し、再開を判断する。

保存後応答喪失を含むタスク登録は`jobId-generation`の決定名、本文はjobId/generationのみ。createTask成功/AlreadyExists後にdispatch更新するが終端jobをqueuedに戻さない。配送側は旧generation/終端をセッション接触前に2xx。業務失敗をDB保存済みなら2xx、DB障害で確定不能なら5xx。CLIの再配送ではtaskの状態と旧処理静止を確認しgenerationを増やしてpendingへ戻す。task名の重複排除期間をexactly-onceの根拠にしない。自動outbox走査は導入せず、120秒の登録遅延・長期待機・試行上限消失を手動調査する。queuedの経過時間だけではtask消失を確定しない。

別プロセスの同一DTO復元、SDK更新互換、Cookie非露出、応答後保存前終了、古いownerの遅延完了、home拒否、復旧失敗、保存失敗時の内部retry停止をFS-2でテストする。異なるCloud Runインスタンス/IPでの公式再利用はFS-4で限定確認し、IP結合が判明したら取得停止して再設計する。

## 起動・管理CLI

APP_ROLE=api/workerを明示し、リリース対象の保存先はFirestoreのみとする。STORAGE_BACKENDによるDB切替は導入せず、接続失敗はエラーにする。現行PostgreSQLコードは各単位の置換まで残せるが、新旧を同時運用しない。FS-3完了までに旧worker/SQL/DB Composeへの参照を除去する。依存削除は開発者向けコマンドを用意し、実施後lockfileを確認する。FirestoreにはGOOGLE_CLOUD_PROJECT・FIRESTORE_DATABASE_ID（初期(default)）が必須、ADCを使用し鍵JSONは追加しない。本番はFIRESTORE_EMULATOR_HOSTが存在するだけで起動拒否。ローカルFirestoreはdemoプロジェクトかつloopbackエミュレータ必須。PORTで0.0.0.0待受、server.tsとコンパイル済み管理CLIをFS-1〜3で追加する。

Tasks設定はTASKS_LOCATION/TASKS_QUEUE/TASKS_CALLER_SA/WORKER_URL（固定HTTPSベースURL、OIDC audience、利用者入力禁止）。createTaskにdispatchDeadline={seconds:900}を毎回指定する。

管理CLIの予定契約は`node dist/storage/firestore-cli.js <command> --project <id> --database <id>`。書込みは既定dry-run、`--apply`で実行、破棄/再開/blocked解除/復旧は停止確認と理由を追加必須とする。秘密情報を出さず、対象・件数・版・変更結果を出力する。

| command | 用途 |
| --- | --- |
| initialize | 新規DBへ制御・カウンター・空セッションを投入（下記）。既存状態のリセットは禁止 |
| seed-reference-data | バージョン/checksumを検証し公園・祝日投入 |
| status | 制御・件数・セッション復元可否表示 |
| pause / resume | 更新停止/再開。resumeはblockedと復旧待ちを解除しない |
| clear-block | 原因確認後のblocked解除、Cookieを自動生成しない |
| repair-outbox | pending/古いsubmitted/lease失効を照合し登録・世代復旧 |
| repair-counters | 停止中にqueue/usageを照合・修復 |
| session-disable / session-discard / session-recover | 使用停止・Cookie破棄・明示復旧。停止理由/初期化待機/cooldownは残す |
| cleanup | 参照を保護し旧履歴・孤立chunk整理 |

このCLIは未実装。初回はinitialize→seed-reference-data→停止状態の保存済み検索確認→IAM/Tasks確認→手動resume→公式1対象の順。initializeはtransactionでcontrol/acquisition（updatesEnabled=false、blockedReason=null、owner=null、fence=0、leaseなし、復旧generation初期値）、queueCapacity=0、公式Session DTO（jar空、initialized=false、prepared/targets空、initializationRetryAt=0、initializationError=null、revision=0、sessionGeneration=1、restorationState=usable、inFlight=null）を一括作成する。usageは最初の受付時にJST日付で0から作成。初期化済みの完全な状態ならno-op、不完全/矛盾した既存状態なら停止エラーで既存値を上書きしない。

未初期化DBは起動/受付で明示エラーにし、セッション文書が見つからないことだけを根拠に自動生成しない。明示initialize済みの空DTOだけは初回のhome取得を許可する。以後の不正/欠損DTOと区別する。初回リリースのデータ移行ツールは作らない。稼働後のDB消失・復旧や任意バックアップは別の運用手順であり、初回投入と混同しない。

## 根拠と後続の確認

2026-10-17参照。上記のアプリ制限値は設計判断でありGCPの保証値ではない。

- [Firestore制限](https://cloud.google.com/firestore/quotas)：文書・要求・transactionの制約。実装テストでは選定SDKの挙動も確認する。
- [transactionの整合性](https://cloud.google.com/firestore/docs/transaction-data-contention)：検索の同一snapshotと書込み競合設計の根拠。
- [HTTP task作成](https://cloud.google.com/tasks/docs/creating-http-target-tasks)：OIDC付きHTTP配送。IAM/OIDCの実確認はFS-4。
- [Firestore容量計算](https://cloud.google.com/firestore/docs/storage-size)：文書とindexを別に測定する。
- [CookieJar](https://github.com/salesforce/tough-cookie/blob/master/api/docs/tough-cookie.cookiejar.md)：serialize/deserialize。既存6.0.2を維持して互換を試験する。

レビューでの指摘と修正理由は[05の設計レビュー記録](review.md)を参照。
