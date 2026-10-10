import { acquire, Target } from './client'

async function main(): Promise<void> {
  const [startDate, ...arguments_] = process.argv.slice(2)
  if (!startDate || !arguments_.length || arguments_.length > 2)
    throw new Error(
      'Usage: npm run acquire -- YYYY-MM-DD PARK_ID:grass [PARK_ID:hard] (one week)'
    )
  const targets: Target[] = arguments_.map((value) => {
    const [parkId, surface, extra] = value.split(':')
    if (!parkId || extra || (surface !== 'grass' && surface !== 'hard'))
      throw new Error('Invalid target')
    return { parkId, surface, startDate }
  })
  const result = await acquire(targets)
  console.log(JSON.stringify(result, null, 2))
  if (result.some((row) => row.state === 'failed')) process.exitCode = 1
}
if (require.main === module)
  main().catch(() => {
    console.error('Invalid arguments or acquisition failure')
    process.exitCode = 1
  })
