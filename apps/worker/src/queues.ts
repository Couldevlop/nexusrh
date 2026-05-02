import { Queue } from 'bullmq'
import IORedis from 'ioredis'

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

export const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
})

export const payrollQueue = new Queue('payroll', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
})

export const emailQueue = new Queue('email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  },
})

export const aiQueue = new Queue('ai-scoring', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
  },
})

export const cleanupQueue = new Queue('cleanup', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
  },
})

export const backupQueue = new Queue('backup', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 60_000 }, // retry après 1 min
    removeOnComplete: 50,
    removeOnFail: 100,
  },
})
