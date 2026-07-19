import type { Job } from 'bullmq'
import { Queue } from 'bullmq'
import { Pool } from 'pg'
import { logger } from '../logger.js'
import { createClient } from '../redis.js'

// Balayage quotidien du module Badgeuse/Pointage : pour chaque tenant actif ayant
// le module `attendance` activé, on enfile (1) une évaluation de la veille et
// (2) un poll par badgeuse active. OWASP A04 — cap anti-storm sur le nombre de tenants.
const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 3 })
const MAX_TENANTS = Number(process.env['ATTENDANCE_CRON_MAX_TENANTS'] ?? 500)
const SAFE_SCHEMA = /^[a-z0-9_]{1,63}$/

function yesterdayIso(): string {
  const y = new Date(Date.now() - 24 * 3600 * 1000)
  return y.toISOString().slice(0, 10)
}

export async function processAttendanceCronJob(_job: Job): Promise<void> {
  const connection = createClient()
  const evalQueue = new Queue('attendance-evaluate', { connection })
  const pollQueue = new Queue('attendance-poll', { connection })
  const day = yesterdayIso()
  let tenantCount = 0
  try {
    const tenants = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM platform.tenants
        WHERE COALESCE((enabled_modules->>'attendance')::boolean, false) = true
          AND status NOT IN ('rejected', 'suspended', 'cancelled')
        LIMIT $1`,
      [MAX_TENANTS],
    )
    for (const t of tenants.rows) {
      const schema = t.schema_name
      if (!SAFE_SCHEMA.test(schema)) {
        logger.warn({ schema }, 'attendance-cron: schema_name invalide, ignoré')
        continue
      }
      try {
        await evalQueue.add('attendance-evaluate', { schemaName: schema, dateFrom: day, dateTo: day })
        const devices = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".attendance_devices WHERE is_active = true AND poll_enabled = true`,
        )
        for (const d of devices.rows) {
          await pollQueue.add('attendance-poll', { schemaName: schema, deviceId: d.id })
        }
        tenantCount++
      } catch (e) {
        // Isolation : un tenant en échec n'interrompt pas le balayage des autres.
        logger.error({ err: e, schema }, 'attendance-cron: fan-out tenant échoué')
      }
    }
    logger.info({ tenants: tenantCount, day }, 'attendance-cron: balayage quotidien terminé')
  } catch (e) {
    logger.error({ err: e }, 'attendance-cron: échec du balayage')
  } finally {
    await evalQueue.close()
    await pollQueue.close()
    await connection.quit()
  }
}
