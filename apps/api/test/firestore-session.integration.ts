import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { acquire, Target } from '../src/availability/client'
import { OfficialSessionRepository } from '../src/storage/firestore/official-session'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { firestoreSettings } from '../src/storage/firestore/database'

const target: Target = { parkId: '1280', surface: 'grass', startDate: '2026-10-10' }
const facility =
  '<input name="displayNo" value="prwrc2000"><input name="selectBldCd" value="1280"><select id="facility-select"><option value="12800020_3">Tennis</option></select>'
const weekly = JSON.stringify(
  JSON.parse(readFileSync(join(__dirname, 'availability/fixtures/grass-11.json'), 'utf8')),
).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

test(
  'Firestore official session checkpoints with fake HTTP',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST, timeout: 120000 },
  async (t) => {
    const projectId = 'demo-akicourt-local'
    const db = new Firestore({
      ...firestoreSettings({ projectId, databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    let now = new Date()
    const repository = new OfficialSessionRepository(db, projectId, () => now)
    const ownership = { owner: 'worker-1', fence: 1 }
    const control = db.doc('control/acquisition'),
      ref = db.doc('officialSessions/current')
    const sleep = async (ms: number) => {
      now = new Date(now.getTime() + ms)
    }
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname
      paths.push(path)
      const saved = (await ref.get()).data()!
      assert.equal(saved.inFlight.phase, 'sent')
      if (path.endsWith('Action.do')) assert.equal(saved.initialized, true)
      if (path.includes('Ajax')) {
        assert.ok(saved.prepared.includes('1280/grass'))
        assert.match(new Headers(init?.headers).get('cookie') ?? '', /SESSION=/)
      }
      return path === '/web/'
        ? new Response('pawab2000', {
            headers: { 'set-cookie': 'SESSION=private; Path=/; Secure' },
          })
        : new Response(path.includes('Ajax') ? weekly : facility)
    }
    const claim = async () =>
      control.update({
        updatesEnabled: true,
        blockedReason: null,
        ...ownership,
        leaseUntil: Timestamp.fromMillis(now.getTime() + 90000),
        nextRequestNotBefore: Timestamp.fromMillis(0),
      })
    try {
      await new ReferenceRepository(db).initialize(true)
      await claim()
      await t.test(
        'initial home→facility→week checkpoints allow reuse by another loaded instance',
        async () => {
          const first = await repository.load(ownership)
          assert.equal(
            (
              await acquire([target], {
                session: first.state,
                checkpoint: first.checkpoint,
                fetchImpl,
                sleep,
              })
            )[0].state,
            'success',
          )
          assert.deepEqual(
            paths.map((p) => (p === '/web/' ? 'home' : p.includes('Ajax') ? 'week' : 'facility')),
            ['home', 'facility', 'week'],
          )
          assert.equal((await ref.get()).get('inFlight'), null)
          const second = await repository.load(ownership)
          assert.notEqual(second.state.jar, first.state.jar)
          paths.length = 0
          now = new Date(now.getTime() + 2000)
          assert.equal(
            (
              await acquire([target], {
                session: second.state,
                checkpoint: second.checkpoint,
                fetchImpl,
                sleep,
              })
            )[0].state,
            'success',
          )
          assert.equal(paths.length, 1)
          assert.ok(paths[0].includes('Ajax'))
        },
      )
      await t.test(
        'a separate Node process restores the saved session and fetches only the week',
        async () => {
          now = new Date(now.getTime() + 2000)
          const script = `
          const {Firestore} = require('@google-cloud/firestore');
          const {firestoreSettings} = require('./dist/storage/firestore/database');
          const {OfficialSessionRepository} = require('./dist/storage/firestore/official-session');
          const {acquire} = require('./dist/availability/client');
          (async () => {
            const db = new Firestore({...firestoreSettings({projectId:'demo-akicourt-local',databaseId:'(default)'}), databaseId:process.env.TEST_SESSION_DB});
            try {
              const repo = new OfficialSessionRepository(db, 'demo-akicourt-local', () => new Date(process.env.TEST_SESSION_NOW));
              const loaded = await repo.load({owner:'worker-1',fence:1});
              let calls = 0;
              const result = await acquire([${JSON.stringify(target)}], {session:loaded.state,checkpoint:loaded.checkpoint,
                fetchImpl:async (url) => {if (!String(url).includes('Ajax')) throw new Error('unexpected-home'); calls++; return new Response(${JSON.stringify(weekly)});}});
              console.log(JSON.stringify({state:result[0].state,calls}));
            } finally {await db.terminate();}
          })().catch(() => {process.exitCode=1;});
        `
          const child = await promisify(execFile)(process.execPath, ['-e', script], {
            env: {
              ...process.env,
              TEST_SESSION_DB: db.databaseId,
              TEST_SESSION_NOW: now.toISOString(),
            },
            timeout: 15000,
          })
          assert.deepEqual(JSON.parse(child.stdout), { state: 'success', calls: 1 })
        },
      )
      await t.test('5xx retry persists changed cookies before the next HTTP request', async () => {
        now = new Date(now.getTime() + 2000)
        const loaded = await repository.load(ownership)
        let calls = 0
        const fake: typeof fetch = async (_url, init) => {
          if (++calls === 1)
            return new Response('', {
              status: 503,
              headers: { 'set-cookie': 'SESSION=rotated; Path=/; Secure' },
            })
          assert.match(new Headers(init?.headers).get('cookie') ?? '', /SESSION=rotated/)
          assert.match(JSON.stringify((await ref.get()).get('cookieJar')), /rotated/)
          return new Response(weekly)
        }
        assert.equal(
          (
            await acquire([target], {
              session: loaded.state,
              checkpoint: loaded.checkpoint,
              fetchImpl: fake,
              sleep,
            })
          )[0].state,
          'success',
        )
        assert.equal(calls, 2)
      })
      await t.test(
        'old revision, expired lease and old owner cannot overwrite the saved session',
        async () => {
          const a = await repository.load(ownership),
            b = await repository.load(ownership)
          await a.checkpoint(a.state, { kind: 'state' })
          await assert.rejects(
            b.checkpoint(b.state, { kind: 'state' }),
            /session-recovery-required/,
          )
          await control.update({ owner: 'worker-2', fence: 2 })
          await assert.rejects(a.checkpoint(a.state, { kind: 'state' }), /ownership-lost/)
          await claim()
          const expired = await repository.load(ownership)
          await control.update({ leaseUntil: Timestamp.fromMillis(now.getTime()) })
          await assert.rejects(
            expired.checkpoint(expired.state, { kind: 'state' }),
            /ownership-lost/,
          )
          await claim()
        },
      )
      await t.test(
        'explicit official timeout creates a new generation through home→facility→week',
        async () => {
          now = new Date(now.getTime() + 2000)
          await claim()
          const before = (await ref.get()).get('sessionGeneration')
          const loaded = await repository.load(ownership)
          let count = 0
          paths.length = 0
          const fake: typeof fetch = async (url, init) => {
            if (++count === 1)
              return new Response(
                Buffer.from(
                  'PGh0bWw+PGJvZHk+g1qDYoNWg4eDk4Neg0ODgINBg0WDZ4KqlK2QtoK1gtyCtYK9gUIgjcSTeIFBlEaP2ILwjXOCwYLEibqCs4KigUI8L2JvZHk+PC9odG1sPg==',
                  'base64',
                ),
              )
            return fetchImpl(url, init)
          }
          assert.equal(
            (
              await acquire([target], {
                session: loaded.state,
                checkpoint: loaded.checkpoint,
                fetchImpl: fake,
                sleep,
              })
            )[0].state,
            'success',
          )
          assert.equal(count, 4)
          assert.equal((await ref.get()).get('sessionGeneration'), before + 1)
          assert.equal((await ref.get()).get('inFlight'), null)
        },
      )
      await t.test(
        'uncertain transport, response-before-state crash and incompatible data require manual recovery',
        async () => {
          const clean = (await ref.get()).data()!
          for (const scenario of ['transport', 'received', 'schema', 'missing']) {
            await ref.set(clean) // Reset only this isolated test database's synthetic state.
            now = new Date(now.getTime() + 2000)
            await claim()
            const loaded = await repository.load(ownership)
            if (scenario === 'transport') {
              let calls = 0
              const result = await acquire([target], {
                session: loaded.state,
                checkpoint: loaded.checkpoint,
                sleep,
                fetchImpl: async () => {
                  calls++
                  throw new Error('network-secret')
                },
              })
              assert.equal(calls, 1)
              assert.equal(result[0].state, 'failed')
              assert.ok(!JSON.stringify(result).includes('network-secret'))
            } else if (scenario === 'received') {
              await loaded.checkpoint(loaded.state, { kind: 'before-request' })
              await loaded.checkpoint(loaded.state, { kind: 'response', uncertain: false })
            } else if (scenario === 'schema') await ref.update({ schemaVersion: 999 })
            else await ref.delete()
            await assert.rejects(repository.load(ownership), /session-recovery-required/)
            if (scenario !== 'missing')
              assert.equal((await ref.get()).get('restorationState'), 'recovery_required')
          }
          await ref.set(clean)
          await claim()
        },
      )
      await t.test(
        'initialization failure is shared and 403 preserves the global block',
        async () => {
          const clean = (await ref.get()).data()!
          await ref.update({ initialized: false, prepared: [], targets: [] })
          const loaded = await repository.load(ownership)
          let count = 0
          const fake: typeof fetch = async () => {
            count++
            return new Response('<html>invalid</html>')
          }
          await acquire([target], {
            session: loaded.state,
            checkpoint: loaded.checkpoint,
            fetchImpl: fake,
            sleep,
          })
          const reloaded = await repository.load(ownership)
          await acquire([target], {
            session: reloaded.state,
            checkpoint: reloaded.checkpoint,
            fetchImpl: fake,
            sleep,
          })
          assert.equal(count, 1)
          assert.equal((await ref.get()).get('initializationError'), 'invalid-home')
          await ref.set(clean)
          now = new Date(now.getTime() + 2000)
          await claim()
          const blocked = await repository.load(ownership)
          await acquire([target], {
            session: blocked.state,
            checkpoint: blocked.checkpoint,
            fetchImpl: async () => new Response('', { status: 403 }),
            sleep,
          })
          assert.equal((await control.get()).get('blockedReason'), 'access-blocked')
          await assert.rejects(repository.load(ownership), /updates-disabled/)
          await claim()
        },
      )
      await t.test(
        'failed persistence stops subsequent HTTP and a leftover in-flight marker blocks reuse',
        async () => {
          now = new Date(now.getTime() + 2000)
          const loaded = await repository.load(ownership)
          let calls = 0
          const result = await acquire([target, target], {
            session: loaded.state,
            sleep,
            fetchImpl: async () => {
              calls++
              return new Response(weekly)
            },
            checkpoint: async (state, event) => {
              if (event.kind === 'response') throw new Error('private-cookie-must-not-leak')
              await loaded.checkpoint(state, event)
            },
          })
          assert.equal(calls, 1)
          assert.ok(
            result.every((r) => r.state === 'failed' && r.error === 'session-checkpoint-failed'),
          )
          assert.ok(!JSON.stringify(result).includes('private-cookie'))
          await assert.rejects(repository.load(ownership), /session-recovery-required/)
          assert.equal((await ref.get()).get('restorationState'), 'recovery_required')
        },
      )
    } finally {
      try {
        for (const c of await db.listCollections()) await db.recursiveDelete(c)
      } finally {
        await db.terminate()
      }
    }
  },
)
