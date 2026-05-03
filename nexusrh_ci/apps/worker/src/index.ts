import { Worker, type Job } from 'bullmq'
import { createClient } from './redis.js'
import { logger } from './logger.js'
import { processEmailJob } from './jobs/email.js'
import { processPayrollJob } from './jobs/payroll.js'
import { processCnpsDeclarationJob } from './jobs/cnps.js'
import { processAiScoringJob } from './jobs/ai-scoring.js'

type AnyJob = Job<unknown, void>
type JobHandler = (job: AnyJob) => Promise<void>

const connection = createClient()
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

async function start(): Promise<void> {
  logger.info('NexusRH CI Worker starting...')

  workers.push(createWorker('email', processEmailJob as JobHandler))
  workers.push(createWorker('payroll-ci', processPayrollJob as JobHandler))
  workers.push(createWorker('cnps-declaration', processCnpsDeclarationJob as JobHandler))
  workers.push(createWorker('ai-scoring-ci', processAiScoringJob as JobHandler))

  logger.info(
    { queues: ['email', 'payroll-ci', 'cnps-declaration', 'ai-scoring-ci'] },
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
