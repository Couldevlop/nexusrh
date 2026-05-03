import { Worker, Queue } from 'bullmq'
import { createClient } from './redis.js'
import { logger } from './logger.js'
import { processEmailJob } from './jobs/email.js'
import { processPayrollJob } from './jobs/payroll.js'
import { processCnpsDeclarationJob } from './jobs/cnps.js'
import { processAiScoringJob } from './jobs/ai-scoring.js'

const connection = createClient()

const workers: Worker[] = []

function createWorker(queueName: string, processor: (job: any) => Promise<void>) {
  const worker = new Worker(queueName, processor, {
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

async function start() {
  logger.info('NexusRH CI Worker starting...')

  workers.push(createWorker('email', processEmailJob))
  workers.push(createWorker('payroll-ci', processPayrollJob))
  workers.push(createWorker('cnps-declaration', processCnpsDeclarationJob))
  workers.push(createWorker('ai-scoring-ci', processAiScoringJob))

  logger.info({ queues: ['email', 'payroll-ci', 'cnps-declaration', 'ai-scoring-ci'] }, 'Workers started')
}

async function shutdown() {
  logger.info('Shutting down workers...')
  await Promise.all(workers.map((w) => w.close()))
  await connection.quit()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch((err) => {
  logger.error({ err }, 'Failed to start worker')
  process.exit(1)
})
