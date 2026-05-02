import { Worker } from 'bullmq'
import { Pool } from 'pg'
import { redisConnection } from '../queues'
import pino from 'pino'

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' })

export const cleanupWorker = new Worker(
  'cleanup',
  async (job) => {
    logger.info({ name: job.name }, 'Job nettoyage démarré')

    const pool = new Pool({
      connectionString: process.env['DATABASE_URL'],
    })

    try {
      // Supprimer les tokens de rafraîchissement expirés
      const result = await pool.query(
        `DELETE FROM refresh_tokens WHERE expires_at < NOW()`
      )
      logger.info({ deleted: result.rowCount }, 'Tokens expirés supprimés')

      // Nettoyer les tokens de reset password expirés
      await pool.query(
        `UPDATE users SET password_reset_token = NULL, password_reset_expires_at = NULL
         WHERE password_reset_expires_at < NOW()`
      )

      logger.info('Nettoyage terminé')
    } finally {
      await pool.end()
    }
  },
  {
    connection: redisConnection,
    concurrency: 1,
  }
)

cleanupWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Job cleanup échoué')
})
