import type { Job } from 'bullmq'
import { logger } from '../logger.js'
import { parseAiScoringPayload, type AiScoringPayload, JobValidationError } from '../schemas.js'

export async function processAiScoringJob(job: Job<unknown, void>): Promise<void> {
  let payload: AiScoringPayload
  try {
    // OWASP A03 + A01 — valider tenantId, schemaName, employeeId optionnel
    payload = parseAiScoringPayload(job.data)
  } catch (err) {
    if (err instanceof JobValidationError) {
      logger.error({ jobId: job.id, err: err.message }, 'ai-scoring: payload invalide — job rejeté')
      return
    }
    throw err
  }
  logger.info({ jobId: job.id, ...payload }, 'Processing AI retention scoring job')
}
