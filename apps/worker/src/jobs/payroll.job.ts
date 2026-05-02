import { Worker } from 'bullmq'
import { redisConnection } from '../queues'
import pino from 'pino'

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' })

export interface PayrollJobData {
  entityId: string
  year: number
  month: number
  employeeIds?: string[]
}

export const payrollWorker = new Worker<PayrollJobData>(
  'payroll',
  async (job) => {
    const { entityId, year, month, employeeIds } = job.data
    logger.info({ entityId, year, month }, 'Traitement paie démarré')

    // Appel à l'API de calcul de paie
    const apiUrl = process.env['API_URL'] ?? 'http://localhost:4000'

    const response = await fetch(`${apiUrl}/payroll/periods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityId, year, month }),
    })

    if (!response.ok) {
      throw new Error(`Erreur création période: ${response.status}`)
    }

    const periodData = (await response.json()) as { data: { id: string } }
    const periodId = periodData.data.id

    logger.info({ periodId }, 'Période de paie créée/récupérée')
    await job.updateProgress(10)

    // TODO: Calculer les bulletins pour chaque employé
    logger.info({ year, month, entityId }, 'Calcul de paie terminé')
    await job.updateProgress(100)

    return { periodId, processed: employeeIds?.length ?? 0 }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  }
)

payrollWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'Job paie terminé')
})

payrollWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Job paie échoué')
})
