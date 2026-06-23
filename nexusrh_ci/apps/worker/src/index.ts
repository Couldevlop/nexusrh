import { Worker, Queue, type Job } from 'bullmq'
import { createClient } from './redis.js'
import { logger } from './logger.js'
import { processEmailJob } from './jobs/email.js'
import { processPayrollJob } from './jobs/payroll.js'
import { processCnpsDeclarationJob } from './jobs/cnps.js'
import { processAiScoringJob } from './jobs/ai-scoring.js'
import { processLegalWatchJob, type LegalWatchPayload } from './jobs/legal-watch.js'
import { processLegislationWatchJob } from './jobs/legislation-watch.js'

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

async function start(): Promise<void> {
  logger.info('NexusRH CI Worker starting...')

  workers.push(createWorker('email', processEmailJob as JobHandler))
  workers.push(createWorker('payroll-ci', processPayrollJob as JobHandler))
  workers.push(createWorker('cnps-declaration', processCnpsDeclarationJob as JobHandler))
  workers.push(createWorker('ai-scoring-ci', processAiScoringJob as JobHandler))
  workers.push(createWorker('legal-watch', processLegalWatchJob as JobHandler))
  workers.push(createWorker('legislation-watch', processLegislationWatchJob as JobHandler))

  await scheduleLegalWatchCron()
  await scheduleLegislationWatchCron()

  logger.info(
    { queues: ['email', 'payroll-ci', 'cnps-declaration', 'ai-scoring-ci', 'legal-watch', 'legislation-watch'] },
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
