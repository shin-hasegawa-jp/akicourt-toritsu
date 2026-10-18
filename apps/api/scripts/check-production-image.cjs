// Exercise the actual release image without network access or cloud credentials.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

const image = 'akicourt-production:check'
const docker = (...args) => {
  const options = { encoding: 'utf8', timeout: 30000 }
  return process.platform === 'darwin'
    ? execFileSync('/usr/local/bin/docker', args, options)
    : execFileSync('/usr/bin/docker', args, options)
}
const containers = []
async function main() {
  assert.equal(docker('image', 'inspect', '--format', '{{.Architecture}}', image).trim(), 'amd64')
  try {
    for (const role of ['api', 'worker']) {
      const name = `akicourt-image-check-${process.pid}-${role}`
      docker(
        'run',
        '--platform',
        'linux/amd64',
        '-d',
        '--name',
        name,
        '--network',
        'none',
        '--read-only',
        '--tmpfs',
        '/tmp',
        '-e',
        `APP_ROLE=${role}`,
        '-e',
        'GOOGLE_CLOUD_PROJECT=akicourt-image-check',
        '-e',
        'FIRESTORE_DATABASE_ID=(default)',
        '-e',
        'TASKS_LOCATION=asia-northeast1',
        '-e',
        'TASKS_QUEUE=acquisition-check',
        '-e',
        'TASKS_CALLER_SA=task-caller@akicourt-image-check.iam.gserviceaccount.com',
        '-e',
        'WORKER_URL=https://worker-check.run.app',
        image,
      )
      containers.push(name)
      let ready = false
      for (let i = 0; i < 30; i++) {
        try {
          docker(
            'exec',
            name,
            'node',
            '-e',
            "fetch('http://127.0.0.1:8080/health', {signal:AbortSignal.timeout(1000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
          )
          ready = true
          break
        } catch {
          await delay(250)
        }
      }
      assert.ok(ready, `${role} did not start`)
      docker(
        'exec',
        name,
        'node',
        '-e',
        `
        const assert = require('node:assert/strict');
        assert.notEqual(process.getuid(), 0);
        (async () => {
          const post = (url) => fetch('http://127.0.0.1:8080'+url, {
            method:'POST', headers:{'content-type':'application/json'}, body:'{}', signal:AbortSignal.timeout(2000)
          });
          assert.equal((await post('${role === 'api' ? '/tasks/acquire' : '/api/availability/search'}')).status, 404);
          assert.equal((await post('${role === 'api' ? '/api/availability/search' : '/tasks/acquire'}')).status, 400);
        })().catch(error => { console.error(error); process.exitCode=1 });
      `,
      )
      docker('stop', '--time', '10', name)
      assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', name).trim(), '0')
      console.log(
        `${role}: non-root startup, route isolation and SIGTERM passed (network disabled)`,
      )
    }
  } finally {
    for (const name of containers) docker('rm', '-f', name)
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
