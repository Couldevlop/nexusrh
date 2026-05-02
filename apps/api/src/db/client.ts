import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { config } from '../config'
import * as authSchema from './schema/auth'
import * as employeesSchema from './schema/employees'
import * as payrollSchema from './schema/payroll'
import * as absencesSchema from './schema/absences'
import * as recruitmentSchema from './schema/recruitment'
import * as trainingSchema from './schema/training'
import * as expensesSchema from './schema/expenses'
import * as careersSchema from './schema/careers'
import * as platformSchema from './schema/platform'
import * as relationsSchema from './schema/relations'

export const schema = {
  ...authSchema,
  ...employeesSchema,
  ...payrollSchema,
  ...absencesSchema,
  ...recruitmentSchema,
  ...trainingSchema,
  ...expensesSchema,
  ...careersSchema,
  ...relationsSchema,
}

export const platformDbSchema = {
  ...platformSchema,
}

// ─── Shared pool (used by getDb for tenant operations) ───────────────────────
let pool: Pool | null = null

// ─── Per-tenant pool cache — one pool per schemaName ─────────────────────────
type TenantDbInstance = ReturnType<typeof drizzle<typeof schema>>
const tenantPools = new Map<string, TenantDbInstance>()
let platformDbInstance: ReturnType<typeof drizzle> | null = null

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      min: config.database.poolMin,
      max: config.database.poolMax,
    })

    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err)
    })
  }
  return pool
}

/**
 * Default DB instance — uses public/default search_path.
 * Still usable by existing routes that haven't been migrated yet.
 */
export function getDb() {
  return drizzle(getPool(), { schema })
}

export type Db = ReturnType<typeof getDb>

/**
 * Returns a Drizzle instance scoped to the "platform" schema.
 * search_path is passed as a pg startup option — applied at connection open,
 * before any query runs (no async race condition).
 * Cached — only one pool is created for the platform schema.
 */
export function getPlatformDb() {
  if (platformDbInstance) return platformDbInstance

  const platformPool = new Pool({
    connectionString: config.database.url,
    options: '-c search_path=platform,public',
    min: 1,
    max: 5,
  })

  platformPool.on('error', (err) => {
    console.error('Unexpected error on platform pool client', err)
  })

  platformDbInstance = drizzle(platformPool, { schema: platformDbSchema })
  return platformDbInstance
}

/**
 * Returns a Drizzle instance scoped to a tenant schema.
 * search_path is passed as a pg startup option — applied at connection open,
 * before any query runs (no async race condition).
 * Cached per schemaName — one pool per tenant, reused across requests.
 */
export function getTenantDb(schemaName: string) {
  // Sanitise: allow only alphanumeric and underscores to prevent injection
  const safe = schemaName.replace(/[^a-z0-9_]/gi, '')

  const cached = tenantPools.get(safe)
  if (cached) return cached

  const tenantPool = new Pool({
    connectionString: config.database.url,
    options: `-c search_path=${safe},public`,
    min: 1,
    max: 10,
  })

  tenantPool.on('error', (err) => {
    console.error(`Unexpected error on tenant pool (${safe})`, err)
  })

  const db = drizzle(tenantPool, { schema })
  tenantPools.set(safe, db)
  return db
}

export type TenantDb = ReturnType<typeof getTenantDb>

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
