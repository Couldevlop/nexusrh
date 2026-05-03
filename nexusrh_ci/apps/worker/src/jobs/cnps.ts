import type { Job } from 'bullmq'
import { logger } from '../logger.js'

interface CnpsPayload {
  tenantId: string
  schemaName: string
  month: number
  year: number
}

export async function processCnpsDeclarationJob(job: Job<CnpsPayload, void>): Promise<void> {
  const { tenantId, schemaName, month, year } = job.data
  logger.info({ tenantId, schemaName, month, year }, 'Processing CNPS declaration job')
}
