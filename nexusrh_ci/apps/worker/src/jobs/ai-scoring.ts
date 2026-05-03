import type { Job } from 'bullmq'
import { logger } from '../logger.js'

interface AiScoringPayload {
  tenantId: string
  schemaName: string
  employeeId?: string
}

export async function processAiScoringJob(job: Job<AiScoringPayload, void>): Promise<void> {
  const { tenantId, schemaName, employeeId } = job.data
  logger.info({ tenantId, schemaName, employeeId }, 'Processing AI retention scoring job')
}
