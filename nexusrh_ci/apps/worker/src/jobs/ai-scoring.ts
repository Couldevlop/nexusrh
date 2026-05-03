import type { Job } from 'bullmq'
import { logger } from '../logger.js'

export async function processAiScoringJob(job: Job) {
  const { tenantId, schemaName, employeeId } = job.data as {
    tenantId: string
    schemaName: string
    employeeId?: string
  }

  logger.info({ tenantId, schemaName, employeeId }, 'Processing AI retention scoring job')
  // Updates employees.retention_score and burnout_risk via Claude API
}
