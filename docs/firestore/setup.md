# FS-0 依存導入・ローカル準備

開発者が実施する手順。FS-0設計承認後にこのブランチで実行し、package.json/package-lock.json差分をCodexが確認する。現時点で実施していない。SDK導入とFS-1実装は別工程。

## 選定

サーバーでFirestoreだけを使用するため`@google-cloud/firestore`を直接使う（Firebase AdminのAuth等は不要）。Cloud Tasksは`@google-cloud/tasks`、ローカルCLIはdevDependencyの`firebase-tools`。WebへAuth SDKは追加しない。pgは置換途中の現行コードの検証用に一時的に残す。リリースはFirestoreのみで、FS-3までに不要コード・依存を整理する。データ変換・転送や本番DB切替の準備は不要。
2026-10-17のnpmレジストリ確認値：Firestore 9.3.1 / Node >=22、Tasks 7.3.0 / Node >=22、firebase-tools 15.34.0 / Node >=20 || >=22 || >=24。プロジェクトのNode 24.18.0を使う。バージョンは固定しlockfileへ記録する。

リポジトリ直下で：

```sh
nvm use
node --version
java -version
cd apps/api
npm install --save-exact @google-cloud/firestore@9.3.1 @google-cloud/tasks@7.3.0
npm install --save-dev --save-exact firebase-tools@15.34.0
npm ls @google-cloud/firestore @google-cloud/tasks firebase-tools tough-cookie
npm run type-check
npm run build:ts
npm test
npm run lint
npm run format:check
```

Javaがない場合は開発者がJDK 21以上を準備してから進める（この端末では未導入）。追加・更新された依存のengine警告、ネイティブ依存、脆弱性警告は確認結果へ分けて記録する。npm audit fixはこの手順に含めない。build/testが既存不具合で失敗した場合も結果をそのまま共有し、成功扱いにしない。

確認用：`git diff -- apps/api/package.json apps/api/package-lock.json`。Codexは選定3パッケージ、固定version、lock整合、Node互換と想定外変更を確認する。再現性のnpm ciは開発者が必要に応じて実施する。

## エミュレータ

CLI設定はローカル専用の一時ディレクトリへ作る。既存firebase.jsonや本番project設定を上書きしない。firebase init/login、GCP接続、公式通信は不要。
リポジトリ直下から：

```sh
mkdir -p /tmp/akicourt-fs-local
cat > /tmp/akicourt-fs-local/firebase.json <<'JSON'
{
  "emulators": {
    "firestore": { "host": "127.0.0.1", "port": 17593 },
    "ui": { "enabled": false },
    "singleProjectMode": true
  }
}
JSON
./apps/api/node_modules/.bin/firebase emulators:start --only firestore --project demo-akicourt-local --config /tmp/akicourt-fs-local/firebase.json
```

初回はエミュレータ本体のダウンロードがある。ポート競合時は設定と接続先を一緒に変更する。別ターミナルで下記の疎通確認（合成文書の作成・読取・削除）を実行する：

```sh
cd apps/api
GOOGLE_CLOUD_PROJECT=demo-akicourt-local FIRESTORE_EMULATOR_HOST=127.0.0.1:17593 node <<'JS'
const assert = require('node:assert/strict')
const { Firestore } = require('@google-cloud/firestore')
assert.equal(process.env.GOOGLE_CLOUD_PROJECT, 'demo-akicourt-local')
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:17593')
const db = new Firestore({ projectId: 'demo-akicourt-local', databaseId: '(default)' })
;(async () => {
  try {
    const ref = db.doc('fs0Smoke/check')
    await ref.set({ synthetic: true })
    assert.equal((await ref.get()).data().synthetic, true)
    await ref.delete()
    console.log('emulator smoke passed')
  } finally {
    await db.terminate()
  }
})().catch(() => { console.error('emulator smoke failed'); process.exitCode = 1 })
JS
```

接続失敗時にエミュレータ変数を外して再試行しない。ADCで実プロジェクトへfallbackさせない。停止はエミュレータ側ターミナルでCtrl-C。永続exportは指定していないため合成データのみ再投入する。
FS-1でテスト専用Rules/index設定と`test:firestore`を実装する。上記smokeはRepository・整合性・Rulesの試験ではない。Cloud TasksはFS-2のテストdispatcherでcreateTask本文・決定名・OIDC audience・900秒deadlineを検査し、ローカルから本物のキューへ送らない。

## 引渡しと承認条件

開発者から導入diff、各コマンドの結果、Java/エミュレータの結果を受け、Codexが確認してFS-0記録を更新する。FS-1はFS-0のレビュー承認・マージと依存準備完了後。

[Emulator Suite準備](https://firebase.google.com/docs/emulator-suite/install_and_configure)と[Firestoreエミュレータ](https://firebase.google.com/docs/emulator-suite/connect_firestore)を参照。エミュレータは本番のIAM/OIDC、index強制、課金、公式サイトからの送信元IP依存を証明しない。これらはFS-4で別に記録する。
