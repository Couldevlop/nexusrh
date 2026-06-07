import { drizzle } from 'drizzle-orm/node-postgres'
import { tenants, platformUsers, tenantInvitations } from './schema/platform.js'
import { legalArticles } from './schema/droit-ci.js'
import { pool } from './pool.js'

// ── Pool global (unique, partagé via db/pool.ts) ──────────────────────────────
export { pool }

// ── Client platform (Drizzle) ─────────────────────────────────────────────────
export const platformDb = drizzle(pool, {
  schema: { tenants, platformUsers, tenantInvitations },
})

// ── Client droit_ci — schéma PostgreSQL dédié aux articles juridiques ─────────
export const droitCiDb = drizzle(pool, { schema: { legalArticles } })
