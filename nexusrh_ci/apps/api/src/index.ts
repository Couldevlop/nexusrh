import { buildApp } from './app.js'
import { config } from './config.js'
import { createPlatformSchema } from './db/provisioning.js'

async function main() {
  // ── Initialiser le schéma platform si absent ───────────────────────────────
  try {
    await createPlatformSchema()
    console.log('[DB] Schéma platform vérifié/créé')
  } catch (err) {
    console.error('[DB] Erreur initialisation schéma platform:', err)
    process.exit(1)
  }

  // ── Démarrer le serveur Fastify ────────────────────────────────────────────
  const app = await buildApp()

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
    console.log(`\n  NexusRH CI — API démarrée`)
    console.log(`  API:     http://localhost:${config.port}`)
    console.log(`  Swagger: http://localhost:${config.port}/docs`)
    console.log(`  Health:  http://localhost:${config.port}/health\n`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Signal ${signal} reçu — arrêt gracieux...`)
    await app.close()
    process.exit(0)
  }

  process.on('SIGINT',  () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

void main()
