import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { config } from '../config.js'
import { platformSchema, tenants, platformUsers, tenantInvitations } from './schema/platform.js'
import { legalArticles } from './schema/droit-ci.js'
import { createTenantSchema } from './schema/tenant.js'
import { assertValidSchemaName } from '../utils/schema-name.js'
import type { FastifyRequest } from 'fastify'

// ── Pool global ───────────────────────────────────────────────────────────────
export const pool = new Pool({
  connectionString: config.database.url,
  min: config.database.poolMin,
  max: config.database.poolMax,
})

// ── Client platform ───────────────────────────────────────────────────────────
export const platformDb = drizzle(pool, {
  schema: { tenants, platformUsers, tenantInvitations },
})

// ── Client droit_ci — schéma PostgreSQL dédié aux articles juridiques ─────────
export const droitCiDb = drizzle(pool, { schema: { legalArticles } })

// ── Cache des clients tenant (un par schemaName) ──────────────────────────────
const tenantClients = new Map<string, ReturnType<typeof drizzle>>()

export function getTenantDb(schemaName: string) {
  if (tenantClients.has(schemaName)) {
    return tenantClients.get(schemaName)!
  }
  const tenantSchema = createTenantSchema(schemaName)
  const client = drizzle(pool, { schema: tenantSchema })
  tenantClients.set(schemaName, client)
  return client
}

export function getTenantDbForRequest(request: FastifyRequest) {
  const schemaName = request.user.schemaName
  if (!schemaName) throw new Error('schemaName manquant dans le token JWT')
  return getTenantDb(schemaName)
}

export function getTenantSchemaForRequest(request: FastifyRequest) {
  return createTenantSchema(request.user.schemaName ?? '')
}

// ── SET search_path pour requête raw ─────────────────────────────────────────
export async function setSearchPath(schemaName: string): Promise<void> {
  // OWASP A03 — le nom de schéma est interpolé (non paramétrable en SQL) :
  // whitelist stricte obligatoire avant exécution.
  assertValidSchemaName(schemaName)
  await pool.query(`SET search_path = "${schemaName}", public`)
}
