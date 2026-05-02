/**
 * ensurePlatformSchema — vérifie et crée le schéma platform au démarrage.
 * Idempotent : peut être appelé plusieurs fois sans effet secondaire.
 */
import { Pool } from 'pg'
import { config } from '../config'
import { logger } from '../utils/logger'

export async function ensurePlatformSchema(): Promise<void> {
  const pool = new Pool({ connectionString: config.database.url, max: 2 })
  const client = await pool.connect()
  try {
    // Vérifier si le schéma platform existe
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.schemata WHERE schema_name = 'platform'
       ) AS exists`,
    )

    if (rows[0]?.exists) {
      logger.info('Platform schema: OK')
      return
    }

    logger.warn('Platform schema absent — création en cours...')

    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA IF NOT EXISTS platform`)

    // ── platform.tenants ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.tenants (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug            VARCHAR(100) UNIQUE NOT NULL,
        name            VARCHAR(255) NOT NULL,
        plan_type       VARCHAR(50) NOT NULL DEFAULT 'trial'
                          CHECK (plan_type IN ('trial','starter','pro','enterprise')),
        status          VARCHAR(50) NOT NULL DEFAULT 'trial'
                          CHECK (status IN ('active','suspended','trial')),
        schema_name     VARCHAR(100) NOT NULL,
        max_users       INTEGER NOT NULL DEFAULT 10,
        max_employees   INTEGER NOT NULL DEFAULT 20,
        primary_color   VARCHAR(7) NOT NULL DEFAULT '#4F46E5',
        secondary_color VARCHAR(7) NOT NULL DEFAULT '#818CF8',
        logo_url        TEXT,
        favicon_url     TEXT,
        custom_domain   VARCHAR(255),
        trial_ends_at   TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // ── platform.platform_users ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.platform_users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name    VARCHAR(100) NOT NULL,
        last_name     VARCHAR(100) NOT NULL,
        role          VARCHAR(50) NOT NULL DEFAULT 'super_admin',
        is_active     BOOLEAN NOT NULL DEFAULT true,
        mfa_enabled   BOOLEAN NOT NULL DEFAULT false,
        mfa_secret    VARCHAR(255),
        onboarding_completed BOOLEAN NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // ── platform.tenant_invitations ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.tenant_invitations (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   UUID REFERENCES platform.tenants(id) ON DELETE CASCADE,
        email       VARCHAR(255) NOT NULL,
        role        VARCHAR(50) NOT NULL DEFAULT 'admin',
        token       VARCHAR(255) UNIQUE NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // ── platform.webhook_endpoints ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.webhook_endpoints (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   UUID REFERENCES platform.tenants(id) ON DELETE CASCADE,
        url         TEXT NOT NULL,
        secret      VARCHAR(255) NOT NULL,
        events      TEXT[] NOT NULL DEFAULT '{}',
        is_active   BOOLEAN NOT NULL DEFAULT true,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // ── platform.webhook_deliveries ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.webhook_deliveries (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        endpoint_id     UUID REFERENCES platform.webhook_endpoints(id) ON DELETE CASCADE,
        event_type      VARCHAR(100) NOT NULL,
        payload         JSONB NOT NULL,
        status          VARCHAR(50) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','delivered','failed')),
        http_status     INTEGER,
        response_body   TEXT,
        attempt_count   INTEGER NOT NULL DEFAULT 0,
        next_retry_at   TIMESTAMPTZ,
        delivered_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // ── platform.audit_log ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.audit_log (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id    UUID,
        actor_email VARCHAR(255),
        actor_role  VARCHAR(50),
        tenant_id   UUID,
        action      VARCHAR(255) NOT NULL,
        resource    VARCHAR(100),
        resource_id UUID,
        details     JSONB,
        ip_address  VARCHAR(45),
        user_agent  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // ── platform.backup_jobs ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.backup_jobs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status      VARCHAR(50) NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','failed')),
        file_key    TEXT,
        file_size   BIGINT,
        duration_ms INTEGER,
        error       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `)

    await client.query('COMMIT')
    logger.info('Platform schema créé avec succès')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error({ err }, 'Erreur création platform schema')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

/**
 * addColumnIfNotExists — migration lazy pour colonnes ajoutées après le déploiement initial.
 */
export async function addColumnIfNotExists(
  pool: Pool,
  schema: string,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  await pool.query(`
    ALTER TABLE "${schema}"."${table}"
    ADD COLUMN IF NOT EXISTS "${column}" ${definition}
  `)
}
