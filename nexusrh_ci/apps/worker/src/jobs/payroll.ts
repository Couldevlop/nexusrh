import type { Job } from 'bullmq'
import { logger } from '../logger.js'
import { parsePayrollPayload, type PayrollPayload, JobValidationError } from '../schemas.js'

export async function processPayrollJob(job: Job<unknown, void>): Promise<void> {
  let payload: PayrollPayload
  try {
    // OWASP A03 + A01 — valider tenantId UUID, schemaName regex, periodId UUID
    payload = parsePayrollPayload(job.data)
  } catch (err) {
    if (err instanceof JobValidationError) {
      logger.error({ jobId: job.id, err: err.message }, 'payroll: payload invalide — job rejeté')
      return // ne pas relancer : payload structurellement invalide
    }
    throw err
  }
  logger.info({ jobId: job.id, ...payload }, 'Processing payroll job')
}
