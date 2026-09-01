import { Worker, Queue, type Job } from 'bullmq'
import { createClient } from './redis.js'
import { logger } from './logger.js'
import { processEmailJob } from './jobs/email.js'
import { processPayrollJob } from './jobs/payroll.js'
import { processCnpsDeclarationJob } from './jobs/cnps.js'
import { processAiScoringJob } from './jobs/ai-scoring.js'
import { processLegalWatchJob, type LegalWatchPayload } from './jobs/legal-watch.js'
import { processLegislationWatchJob } from './jobs/legislation-watch.js'
import { processAttendancePollJob } from './jobs/attendance-poll.js'
import { processAttendanceEvaluateJob } from './jobs/attendance-evaluate.js'
import { processAttendanceCronJob } from './jobs/attendance-cron.js'
import { processInterviewSimConsentPurgeJob } from './jobs/interview-sim-consent-purge.js'

type AnyJob = Job<unknown, void>
type JobHandler = (job: AnyJob) => Promise<void>

const connection = createClient()
connection.on('error', (err: Error) => logger.error({ err }, 'Redis connection error'))
const workers: Worker<unknown, void>[] = []

// OWASP A04 — concurrency cap par worker pour éviter qu'un seul tenant
// monopolise la DB en envoyant 1000 jobs en parallèle.
const WORKER_CONCURRENCY = 5

// OWASP A04 — cap absolu de cron legal-watch sources (anti config rogue
// qui définirait LEGAL_WATCH_SOURCES avec 10000 entrées → Redis storm)
const LEGAL_WATCH_MAX_SOURCES = 100

function createWorker(queueName: string, handler: JobHandler): Worker<unknown, void> {
  const worker = new Worker<unknown, void>(queueName, handler, {
    connection,
    concurrency: WORKER_CONCURRENCY,
    // OWASP A04 — anti-saturation Redis : purger les jobs terminés.
    // Garder les 1000 derniers échecs pour diagnostic. Garder les 100 derniers
    // succès pour observabilité (sans saturer la mémoire Redis).
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 1000 },
  })

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, queue: queueName }, 'Job completed')
  })

  worker.on('failed', (job, err) => {
    // OWASP A10 — log message d'erreur sans stack complète (peut leak PII
    // si une query inclut email/employeeId dans la trace)
    const errMsg = err instanceof Error ? err.message : 'unknown'
    logger.error({ jobId: job?.id, queue: queueName, errMsg, attempts: job?.attemptsMade }, 'Job failed')
  })

  return worker
}

// Schedule cron quotidien si LEGAL_WATCH_ENABLED=true.
// Sources lues depuis env LEGAL_WATCH_SOURCES (JSON array). Format :
//   [{"articleId":"ct_ci_art_36","sourceUrl":"https://...","source":"cnps","countryCode":"CIV"}]
// Si vide ou flag off : le worker démarre les consumers mais n'ajoute aucun job.
// Un super_admin peut toujours queue manuellement via API future.
async function scheduleLegalWatchCron(): Promise<void> {
  if ((process.env['LEGAL_WATCH_ENABLED'] ?? 'false').toLowerCase() !== 'true') {
    logger.info('legal-watch cron désactivé (LEGAL_WATCH_ENABLED != true)')
    return
  }
  const rawSources = process.env['LEGAL_WATCH_SOURCES'] ?? '[]'
  let sources: LegalWatchPayload[] = []
  try {
    const parsed = JSON.parse(rawSources)
    if (Array.isArray(parsed)) sources = parsed
  } catch {
    logger.warn({ rawSources }, 'legal-watch: LEGAL_WATCH_SOURCES invalide (JSON parse failed)')
    return
  }
  if (sources.length === 0) {
    logger.info('legal-watch: aucune source configurée — cron non programmé')
    return
  }
  // OWASP A04 — cap anti-config-rogue
  if (sources.length > LEGAL_WATCH_MAX_SOURCES) {
    logger.error(
      { count: sources.length, max: LEGAL_WATCH_MAX_SOURCES },
      `legal-watch: trop de sources (max ${LEGAL_WATCH_MAX_SOURCES}) — cron non programmé`,
    )
    return
  }
  const legalQueue = new Queue<LegalWatchPayload>('legal-watch', { connection })
  // Cron quotidien 3h du matin (Africa/Abidjan = UTC, donc 3h UTC = 3h local CI)
  const pattern = process.env['LEGAL_WATCH_CRON'] ?? '0 3 * * *'
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!
    await legalQueue.upsertJobScheduler(
      `daily-watch-${i}`,
      { pattern, tz: 'Africa/Abidjan' },
      { name: 'fetch-source', data: src, opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } },
    )
  }
  logger.info({ sources: sources.length, pattern }, 'legal-watch: cron programmé')
}

// Veille HEBDOMADAIRE des packs législatifs paie : crée des propositions de revue
// (validation humaine super_admin). Par défaut dimanche ~00h07 (Africa/Abidjan).
async function scheduleLegislationWatchCron(): Promise<void> {
  const pattern = process.env['LEGISLATION_WATCH_CRON'] ?? '7 0 * * 0'
  const q = new Queue('legislation-watch', { connection })
  await q.upsertJobScheduler(
    'weekly-legislation-watch',
    { pattern, tz: 'Africa/Abidjan' },
    { name: 'review', data: {}, opts: { attempts: 2, backoff: { type: 'exponential', delay: 60_000 } } },
  )
  logger.info({ pattern }, 'legislation-watch: cron hebdomadaire programmé')
}

// Badgeuse/Pointage : balayage quotidien (par défaut 05h15 Africa/Abidjan) qui
// enfile l'évaluation de la veille + les polls des badgeuses actives par tenant.
async function scheduleAttendanceCron(): Promise<void> {
  const pattern = process.env['ATTENDANCE_CRON'] ?? '15 5 * * *'
  const q = new Queue('attendance-cron', { connection })
  await q.upsertJobScheduler(
    'attendance-daily',
    { pattern, tz: 'Africa/Abidjan' },
    { name: 'attendance-daily', data: {} },
  )
  logger.info({ pattern }, 'attendance: cron quotidien programmé')
}

// Simulations d'entretien : purge quotidienne des preuves de consentement RGPD
// (interview_sim_consents) au-delà de la durée de conservation par tenant
// (par défaut 03h30 Africa/Abidjan — obligatoire, une conservation illimitée
// recréerait le problème de limitation de la conservation corrigé le 24/07/2026).
async function scheduleInterviewSimConsentPurgeCron(): Promise<void> {
  const pattern = process.env['INTERVIEW_SIM_PURGE_CRON'] ?? '30 3 * * *'
  const q = new Queue('interview-sim-consent-purge', { connection })
  await q.upsertJobScheduler(
    'interview-sim-consent-purge-daily',
    { pattern, tz: 'Africa/Abidjan' },
    { name: 'interview-sim-consent-purge-daily', data: {} },
  )
  logger.info({ pattern }, 'interview-sim-consent-purge: cron quotidien programmé')
}

/**
 * Pose les planifications récurrentes dans Redis.
 *
 * Appelée au démarrage ET à chaque reconnexion : les planifications BullMQ
 * vivent DANS Redis, or Redis ne persiste rien (`--save ''`) et le script de
 * déploiement le recrée à chaque livraison. Un worker qui survit à ce
 * remplacement se retrouve donc vivant, connecté — et sans aucun cron.
 *
 * Constaté en production le 01/09/2026 : le worker tournait depuis deux heures,
 * ses logs de démarrage annonçaient bien les trois crons, et Redis ne contenait
 * AUCUNE clé de planification. Rien ne se serait déclenché, sans le moindre
 * signal d'erreur.
 *
 * `upsertJobScheduler` est idempotent : rejouer l'enregistrement ne crée pas de
 * doublon.
 */
async function registerSchedulers(): Promise<void> {
  await scheduleLegalWatchCron()
  await scheduleLegislationWatchCron()
  await scheduleAttendanceCron()
  await scheduleInterviewSimConsentPurgeCron()
}

/**
 * Réarme les planifications après une coupure Redis.
 *
 * `ready` est émis à la connexion initiale ET après chaque reconnexion. La
 * première est déjà couverte par `start()`, on ne réagit donc qu'aux suivantes.
 * Le drapeau évite deux réenregistrements concurrents si Redis bat de l'aile.
 */
let schedulersRegistered = false
let reregistering = false
connection.on('ready', () => {
  if (!schedulersRegistered || reregistering) return
  reregistering = true
  void registerSchedulers()
    .then(() => logger.info('Planifications réarmées après reconnexion Redis'))
    .catch((err: unknown) => logger.error({ err }, 'Échec du réarmement des planifications'))
    .finally(() => { reregistering = false })
})

async function start(): Promise<void> {
  logger.info('NexusRH CI Worker starting...')

  workers.push(createWorker('email', processEmailJob as JobHandler))
  workers.push(createWorker('payroll-ci', processPayrollJob as JobHandler))
  workers.push(createWorker('cnps-declaration', processCnpsDeclarationJob as JobHandler))
  workers.push(createWorker('ai-scoring-ci', processAiScoringJob as JobHandler))
  workers.push(createWorker('legal-watch', processLegalWatchJob as JobHandler))
  workers.push(createWorker('legislation-watch', processLegislationWatchJob as JobHandler))
  workers.push(createWorker('attendance-poll', processAttendancePollJob as JobHandler))
  workers.push(createWorker('attendance-evaluate', processAttendanceEvaluateJob as JobHandler))
  workers.push(createWorker('attendance-cron', processAttendanceCronJob as JobHandler))
  workers.push(createWorker('interview-sim-consent-purge', processInterviewSimConsentPurgeJob as JobHandler))

  await registerSchedulers()
  schedulersRegistered = true

  logger.info(
    {
      queues: [
        'email', 'payroll-ci', 'cnps-declaration', 'ai-scoring-ci',
        'legal-watch', 'legislation-watch', 'attendance-poll', 'attendance-evaluate',
        'attendance-cron', 'interview-sim-consent-purge',
      ],
    },
    'Workers started',
  )
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down workers...')
  await Promise.all(workers.map((w) => w.close()))
  await connection.quit()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })

start().catch((err: unknown) => {
  logger.error({ err }, 'Failed to start worker')
  process.exit(1)
})
