import { buildApp } from './app.js'
import { config } from './config.js'
import { createPlatformSchema, createDroitCiSchema } from './db/provisioning.js'
import { countArticles } from './modules/referentiels/legal-articles.repository.js'
import { seedReferentiel } from './modules/referentiels/referentiels.service.js'
import { startPayrollReminderScheduler } from './modules/payroll/payroll-reminder.scheduler.js'
import { hasPreviousKey } from '@nexusrhci/shared/crypto'

async function main() {
  // ── Initialiser le schéma platform si absent ───────────────────────────────
  try {
    await createPlatformSchema()
    console.log('[DB] Schéma platform vérifié/créé')
  } catch (err) {
    console.error('[DB] Erreur initialisation schéma platform:', err)
    process.exit(1)
  }

  // Schéma droit_ci : référentiel juridique + tables veille réglementaire
  // (article_proposals, articles_history). Idempotent grâce à CREATE IF NOT EXISTS.
  try {
    await createDroitCiSchema()
    console.log('[DB] Schéma droit_ci vérifié/créé')
  } catch (err) {
    console.error('[DB] Erreur initialisation schéma droit_ci:', err)
    process.exit(1)
  }

  // ── Rotation de ENCRYPTION_KEY en cours ? ──────────────────────────────────
  // Une clé précédente configurée signifie que l'ANCIENNE clé déchiffre encore
  // : la rotation n'est pas terminée tant qu'elle est là. Sans ce rappel au
  // démarrage, l'étape finale — ré-chiffrer puis retirer la clé précédente —
  // s'oublie, et la clé qu'on voulait révoquer reste valable indéfiniment.
  if (hasPreviousKey()) {
    console.warn('[chiffrement] ⚠ ENCRYPTION_KEY_PREVIOUS est configurée : rotation EN COURS.')
    console.warn('[chiffrement]   La cle precedente dechiffre encore les donnees. Terminer par :')
    console.warn('[chiffrement]   1) ré-chiffrer tous les cryptogrammes, 2) retirer encryption-key-previous du secret.')
  }

  // ── Démarrer le serveur Fastify ────────────────────────────────────────────
  const app = await buildApp()

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
    console.log(`\n  NexusRH — API démarrée`)
    console.log(`  API:     http://localhost:${config.port}`)
    console.log(`  Swagger: http://localhost:${config.port}/docs`)
    console.log(`  Health:  http://localhost:${config.port}/health\n`)

    // Seed automatique des articles juridiques si table vide
    const artCount = await countArticles().catch(() => 0)
    if (artCount === 0) {
      console.log('[Référentiel] Table vide — seed automatique des articles...')
      seedReferentiel()
        .then(r => console.log(`[Référentiel] ${r.persisted} articles seedés, ${r.indexed} indexés`))
        .catch(e => console.error('[Référentiel] Seed auto échoué:', e))
    }
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Relance planifiée des valideurs de paie (BullMQ, non bloquant, jamais fatal)
  const stopPayrollReminders = await startPayrollReminderScheduler(app.log)

  const shutdown = async (signal: string) => {
    await stopPayrollReminders()
    app.log.info(`Signal ${signal} reçu — arrêt gracieux...`)
    await app.close()
    process.exit(0)
  }

  process.on('SIGINT',  () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

void main()
