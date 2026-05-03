import type { Job } from 'bullmq'
import { logger } from '../logger.js'

interface PayrollPayload {
  tenantId: string
  schemaName: string
  periodId: string
}

export async function processPayrollJob(job: Job<PayrollPayload, void>): Promise<void> {
  const { tenantId, schemaName, periodId } = job.data
  logger.info({ tenantId, schemaName, periodId }, 'Processing payroll job')
}
