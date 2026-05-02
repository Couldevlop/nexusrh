import { buildApp } from './app'
import { config } from './config'
import { connectRedis } from './services/redis.service'
import { initSearchIndexes } from './services/search.service'
import { closePool } from './db/client'
import { disconnectRedis } from './services/redis.service'
import { logger } from './utils/logger'
import { Pool } from 'pg'

/**
 * Safe idempotent migrations — adds columns/tables that may be missing in
 * existing tenant schemas created before a schema change was introduced.
 * All statements use ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS
 * so they are safe to run on every startup.
 */
async function runStartupMigrations(pool: Pool): Promise<void> {
  try {
    // Get all tenant schemas
    const res = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM platform.tenants WHERE status != 'deleted' AND schema_name IS NOT NULL`
    )
    const schemas = res.rows.map((r) => r.schema_name)

    for (const s of schemas) {
      // validation_level on absences
      await pool.query(
        `ALTER TABLE "${s}".absences ADD COLUMN IF NOT EXISTS validation_level INT NOT NULL DEFAULT 0`
      ).catch(() => undefined) // table may not exist yet

      // validation_level on expense_reports
      await pool.query(
        `ALTER TABLE "${s}".expense_reports ADD COLUMN IF NOT EXISTS validation_level INT NOT NULL DEFAULT 0`
      ).catch(() => undefined)

      // workflow_configs table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "${s}".workflow_configs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          module VARCHAR(50) NOT NULL UNIQUE,
          levels_count INT NOT NULL DEFAULT 1,
          level1_role VARCHAR(50) NOT NULL DEFAULT 'manager',
          level2_role VARCHAR(50), level3_role VARCHAR(50), level4_role VARCHAR(50),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `).catch(() => undefined)

      await pool.query(`
        INSERT INTO "${s}".workflow_configs (module, levels_count, level1_role)
        VALUES ('absences', 1, 'manager'), ('expenses', 1, 'manager')
        ON CONFLICT (module) DO NOTHING
      `).catch(() => undefined)
    }

    if (schemas.length > 0) {
      logger.info({ count: schemas.length }, 'Startup migrations appliquées')
    }
  } catch (err) {
    // Non-fatal — log and continue (platform schema may not exist on first run)
    logger.warn({ err }, 'Startup migrations ignorées (première initialisation ?)')
  }
}

async function start() {
  const startupPool = new Pool({ connectionString: config.database.url })

  try {
    // Connect services
    await connectRedis()
    logger.info('Redis connecté')

    await initSearchIndexes()
    logger.info('Meilisearch initialisé')

    // Run safe idempotent migrations for existing tenant schemas
    await runStartupMigrations(startupPool)
    await startupPool.end()

    // Build and start server
    const app = await buildApp()

    await app.listen({
      port: config.app.port,
      host: '0.0.0.0',
    })

    logger.info(`🚀 NexusRH API démarrée sur http://0.0.0.0:${config.app.port}`)
    logger.info(`📄 Documentation Swagger : http://localhost:${config.app.port}/docs`)

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Arrêt du serveur...')
      await app.close()
      await closePool()
      await disconnectRedis()
      logger.info('Serveur arrêté proprement')
      process.exit(0)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  } catch (err) {
    logger.error({ err }, 'Erreur au démarrage')
    await startupPool.end().catch(() => undefined)
    process.exit(1)
  }
}

start()
