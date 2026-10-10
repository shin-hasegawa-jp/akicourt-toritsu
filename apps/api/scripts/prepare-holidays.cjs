// Offline preparation only. Review the generated diff against the annual
// Cabinet Office tables before registering it in a database.
const { readFileSync, writeFileSync, renameSync, rmSync } = require('node:fs')
const { resolve } = require('node:path')
const { createHash } = require('node:crypto')

const [filename, ...args] = process.argv.slice(2)
if (
  !filename ||
  !args.length ||
  args.some((year) => !/^\d{4}$/.test(year)) ||
  new Set(args).size !== args.length
)
  throw new Error('Usage: node scripts/prepare-holidays.cjs CSV YEAR [YEAR...]')
const years = args.map(Number).sort((a, b) => a - b)
const text = new TextDecoder('shift_jis', { fatal: true }).decode(readFileSync(filename))
const lines = text
  .replace(/^\uFEFF/, '')
  .trimEnd()
  .split(/\r?\n/)
if (lines.shift() !== '国民の祝日・休日月日,国民の祝日・休日名称')
  throw new Error('Unexpected CSV header')
const rows = []
let previous = ''
for (const line of lines) {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),([^,\t\r\n"]+)$/.exec(line)
  if (!match) throw new Error('Unexpected CSV row')
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00Z`)
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date ||
    date <= previous ||
    !match[4].trim()
  )
    throw new Error('Invalid or duplicate CSV date/name')
  previous = date
  rows.push({ date, name: match[4] })
}
const data = {
  source: 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv',
  verifiedAt: new Date().toISOString().slice(0, 10),
  years: years.map((year) => {
    const holidays = rows.filter((row) => Number(row.date.slice(0, 4)) === year)
    if (!holidays.length) throw new Error(`Year unavailable: ${year}`)
    return {
      year,
      count: holidays.length,
      sha256: createHash('sha256')
        .update(holidays.map((row) => `${row.date}\t${row.name}`).join('\n'))
        .digest('hex'),
      holidays,
    }
  }),
}
const path = resolve(__dirname, '../src/storage/holiday-calendar.ts')
const temporary = `${path}.${process.pid}.tmp`
try {
  writeFileSync(
    temporary,
    '// Cabinet Office CSV. Review all selected years against the annual tables.\nexport default ' +
      JSON.stringify(data, null, 2) +
      '\n',
    { flag: 'wx' },
  )
  renameSync(temporary, path)
} finally {
  rmSync(temporary, { force: true })
}
console.log('Prepared:', data.years.map((entry) => `${entry.year}: ${entry.count}`).join(', '))
console.log('Review every date/name and the selected year list before DB registration.')
