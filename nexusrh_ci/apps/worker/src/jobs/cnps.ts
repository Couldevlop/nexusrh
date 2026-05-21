import type { Job } from 'bullmq'
import { logger } from '../logger.js'
import { parseCnpsPayload, type CnpsPayload, JobValidationError } from '../schemas.js'

export async function processCnpsDeclarationJob(job: Job<unknown, void>): Promise<void> {
  let payload: CnpsPayload
  try {
    // OWASP A03 + A01 — valider tenantId, schemaName, month [1-12], year [2000-2100]
    payload = parseCnpsPayload(job.data)
  } catch (err) {
    if (err instanceof JobValidationError) {
      logger.error({ jobId: job.id, err: err.message }, 'cnps: payload invalide — job rejeté')
      return
    }
    throw err
  }
  logger.info({ jobId: job.id, ...payload }, 'Processing CNPS declaration job')
}
