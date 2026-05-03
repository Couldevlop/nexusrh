import type { Job } from 'bullmq'
import { logger } from '../logger.js'

export async function processCnpsDeclarationJob(job: Job) {
  const { tenantId, schemaName, month, year } = job.data as {
    tenantId: string
    schemaName: string
    month: number
    year: number
  }

  logger.info({ tenantId, schemaName, month, year }, 'Processing CNPS declaration job')
  // Generates monthly e-CNPS export CSV and marks declaration as generated
}
