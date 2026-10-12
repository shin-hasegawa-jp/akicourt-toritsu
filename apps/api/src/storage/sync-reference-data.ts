import { Pool } from 'pg'
import { resolve } from 'node:path'
import { migrate, transaction } from './database'
import calendar from './holiday-calendar'
import parks from './park-options'
import { validateCalendar, writeHolidays } from './holidays'

export async function syncReferenceData(pool: Pool): Promise<void> {
  const years = validateCalendar(
    calendar,
    calendar.years.map((entry) => entry.year),
  )
  await transaction(pool, async (client) => {
    // Also serializes against the manual holiday registration command.
    await client.query('SELECT pg_advisory_xact_lock(1759104)')
    // Preserve foreign keys and acquisition history for removed parks.
    await client.query('UPDATE park_surfaces SET enabled=false')
    for (const park of parks) {
      await client.query(
        `INSERT INTO park_surfaces(park_id,surface,name,enabled) VALUES($1,$2,$3,true)
        ON CONFLICT(park_id,surface) DO UPDATE SET name=excluded.name,enabled=true`,
        [park.parkId, park.surface, park.name],
      )
    }
    // The bundled calendar is authoritative, including its supported years.
    await client.query('DELETE FROM holidays')
    await client.query('DELETE FROM holiday_calendar_years')
    await writeHolidays(client, years)
  })
}

export async function prepareStorage(pool: Pool): Promise<void> {
  await migrate(pool, resolve(__dirname, '../../migrations'))
  await syncReferenceData(pool)
}
