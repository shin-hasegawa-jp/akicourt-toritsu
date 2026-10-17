// Local SDK connectivity check; never connect to a real GCP project.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Firestore } = require('@google-cloud/firestore')

async function main() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT
  const databaseId = process.env.FIRESTORE_DATABASE_ID
  const host = process.env.FIRESTORE_EMULATOR_HOST || ''
  assert.equal(projectId, 'demo-akicourt-local', 'demo project is required')
  assert.equal(databaseId, '(default)', 'local default database is required')
  const match = /^(?:firestore|localhost|127\.0\.0\.1):(\d+)$/.exec(host)
  assert.ok(
    match && Number(match[1]) > 0 && Number(match[1]) <= 65535,
    'local emulator is required',
  )

  // Avoid ADC/metadata discovery for the SDK universe check in this local-only script.
  const db = new Firestore({ projectId, databaseId, universeDomain: 'googleapis.com' })
  const ref = db.collection('emulatorSmoke').doc(randomUUID())
  let created = false
  try {
    await ref.create({ synthetic: true })
    created = true
    assert.deepEqual((await ref.get()).data(), { synthetic: true })
    await ref.delete()
    created = false
    assert.equal((await ref.get()).exists, false)
    console.log('Firestore emulator: create/read/delete passed')
  } finally {
    try {
      if (created) await ref.delete()
    } finally {
      await db.terminate()
    }
  }
}

main().catch(() => {
  console.error('Firestore emulator check failed; verify demo project and local emulator settings')
  process.exitCode = 1
})
