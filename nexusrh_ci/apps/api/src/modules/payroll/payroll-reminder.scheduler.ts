/**
 * Planification BullMQ de la RELANCE des valideurs de paie
 * (services/payroll-validation-alerts.service → runPayrollValidationReminders).
 *
 * Pourquoi dans l'API et non dans apps/worker : l'éligibilité (règles SoD du
 * circuit), la configuration SMTP du tenant (déchiffrement, garde SSRF) et les
 * gabarits d'email vivent dans l'API ; les recopier dans le worker
 * dupliquerait la logique SoD. L'API héberge donc sa propre file
 * `payroll-validation-reminder` : la planification (upsertJobScheduler) est
 * idempotente et BullMQ ne délivre chaque occurrence qu'à UN consommateur,
 * même avec plusieurs réplicas ; la réservation en base
 * (pay_period_reminders) garantit en plus l'unicité de la relance.
 *
 * Désactivable par PAYROLL_REMINDER_ENABLED=false ; jamais démarrée en test.
 * Cadence : PAYROLL_REMINDER_CRON (défaut : toutes les heures à hh:05,
 * Africa/Abidjan). Toute erreur Redis est journalisée, jamais fatale.
 */
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { config } from '../../config.js'
import { runPayrollValidationReminders } from '../../services/payroll-validation-alerts.service.js'

const QUEUE_NAME = 'payroll-validation-reminder'
const SCHEDULER_ID = 'payroll-validation-reminder-hourly'

interface SchedulerLogger {
  info: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

/** Démarre la planification ; renvoie la fonction d'arrêt (graceful shutdown). */
export async function startPayrollReminderScheduler(log: SchedulerLogger): Promise<() => Promise<void>> {
  const noop = async (): Promise<void> => undefined
  if (config.env === 'test' || (process.env['PAYROLL_REMINDER_ENABLED'] ?? 'true').toLowerCase() === 'false') {
    log.info({}, 'payroll-reminder: planification désactivée')
    return noop
  }
  const pattern = process.env['PAYROLL_REMINDER_CRON'] ?? '5 * * * *'
  try {
    const connection = new Redis(config.redis.url, { maxRetriesPerRequest: null })
    connection.on('error', (err: Error) => log.error({ errMsg: err.message }, 'payroll-reminder: erreur Redis'))
    const queue = new Queue(QUEUE_NAME, { connection })
    const worker = new Worker(QUEUE_NAME, async () => {
      const summary = await runPayrollValidationReminders(new Date(), log)
      log.info(summary, 'payroll-reminder: balayage terminé')
    }, {
      connection, concurrency: 1,
      removeOnComplete: { count: 50 }, removeOnFail: { count: 200 },
    })
    worker.on('failed', (_job, err) => log.error({ errMsg: err instanceof Error ? err.message : 'unknown' }, 'payroll-reminder: job en échec'))

    const register = () => queue.upsertJobScheduler(
      SCHEDULER_ID, { pattern, tz: 'Africa/Abidjan' }, { name: 'sweep', data: {} },
    )
    await register()
    // Redis ne persiste pas ses clés (recréé à chaque déploiement) : on réarme
    // la planification après chaque reconnexion (idempotent).
    let armed = true
    connection.on('ready', () => {
      if (!armed) return
      void register().catch((err: unknown) => log.error({ err }, 'payroll-reminder: réarmement échoué'))
    })
    log.info({ pattern }, 'payroll-reminder: planification programmée')
    return async () => {
      armed = false
      await worker.close().catch(() => undefined)
      await queue.close().catch(() => undefined)
      await connection.quit().catch(() => undefined)
    }
  } catch (err) {
    log.error({ err }, 'payroll-reminder: démarrage impossible (relances inactives)')
    return noop
  }
}
