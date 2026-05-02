import dotenv from 'dotenv'
import pino from 'pino'
import { payrollWorker } from './jobs/payroll.job'
import { emailWorker } from './jobs/email.job'
import { aiScoringWorker } from './jobs/ai-scoring.job'
import { cleanupWorker } from './jobs/cleanup.job'
import { backupWorker } from './jobs/backup.job'
import { cleanupQueue, backupQueue } from './queues'

dotenv.config({ path: '../../.env' })

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})

async function start() {
  logger.info('NexusRH Worker démarré')
  logger.info(`  ✅ Worker Paie: actif`)
  logger.info(`  ✅ Worker Email: actif`)
  logger.info(`  ✅ Worker IA Scoring: actif`)
  logger.info(`  ✅ Worker Cleanup: actif`)
  logger.info(`  ✅ Worker Backup: actif`)

  // Planifier le nettoyage quotidien (2h du matin)
  await cleanupQueue.add('daily-cleanup', {}, { repeat: { pattern: '0 2 * * *' } })

  // Planifier le backup nocturne (3h du matin)
  await backupQueue.add('nightly-backup', {}, { repeat: { pattern: '0 3 * * *' } })
  logger.info('Backup nocturne planifié à 3h00 chaque jour')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Arrêt des workers...')
    await Promise.all([
      payrollWorker.close(),
      emailWorker.close(),
      aiScoringWorker.close(),
      cleanupWorker.close(),
      backupWorker.close(),
    ])
    logger.info('Workers arrêtés proprement')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch((err) => {
  logger.error({ err }, 'Erreur au démarrage du worker')
  process.exit(1)
})
