import type { Job } from 'bullmq'
import { logger } from '../logger.js'

export async function processPayrollJob(job: Job) {
  const { tenantId, schemaName, periodId } = job.data as {
    tenantId: string
    schemaName: string
    periodId: string
  }

  logger.info({ tenantId, schemaName, periodId }, 'Processing payroll job')
  // Payroll calculation is triggered by the API; worker handles async post-processing
  // (PDF generation, notifications, Mobile Money payment initiation)
}
