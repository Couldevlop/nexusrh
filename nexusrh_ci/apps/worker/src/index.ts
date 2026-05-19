import { Worker, Queue, type Job } from 'bullmq'
import { createClient } from './redis.js'
import { logger } from './logger.js'
import { processEmailJob } from './jobs/email.js'
import { processPayrollJob } from './jobs/payroll.js'
import { processCnpsDeclarationJob } from './jobs/cnps.js'
import { processAiScoringJob } from './jobs/ai-scoring.js'
import { processLegalWatchJob, type LegalWatchPayload } from './jobs/legal-watch.js'

type AnyJob = Job<unknown, void>
type JobHandler = (job: AnyJob) => Promise<void>

const connection = createClient()
connection.on('error', (err: Error) => logger.error({ err }, 'Redis connection error'))
const workers: Worker<unknown, void>[] = []

function createWorker(queueName: string, handler: JobHandler): Worker<unknown, void> {
  const worker = new Worker<unknown, void>(queueName, handler, {
    connection,
    concurrency: 5,
  })

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, queue: queueName }, 'Job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, queue: queueName, err }, 'Job failed')
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

async function start(): Promise<void> {
  logger.info('NexusRH CI Worker starting...')

  workers.push(createWorker('email', processEmailJob as JobHandler))
  workers.push(createWorker('payroll-ci', processPayrollJob as JobHandler))
  workers.push(createWorker('cnps-declaration', processCnpsDeclarationJob as JobHandler))
  workers.push(createWorker('ai-scoring-ci', processAiScoringJob as JobHandler))
  workers.push(createWorker('legal-watch', processLegalWatchJob as JobHandler))

  await scheduleLegalWatchCron()

  logger.info(
    { queues: ['email', 'payroll-ci', 'cnps-declaration', 'ai-scoring-ci', 'legal-watch'] },
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
