import { Worker } from 'bullmq'
import Anthropic from '@anthropic-ai/sdk'
import { redisConnection } from '../queues'
import pino from 'pino'

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' })

export interface AIScoringJobData {
  employeeId: string
  employeeData: Record<string, unknown>
}

const anthropic = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
})

export const aiScoringWorker = new Worker<AIScoringJobData>(
  'ai-scoring',
  async (job) => {
    const { employeeId, employeeData } = job.data
    logger.info({ employeeId }, 'Calcul score IA démarré')

    const response = await anthropic.messages.create({
      model: process.env['AI_MODEL'] ?? 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Analyse ce profil RH et calcule un score de rétention (0-1).

Données :
${JSON.stringify(employeeData, null, 2)}

Réponds UNIQUEMENT en JSON :
{"score": 0.82, "risk": "low", "factors": ["ancienneté", "formation récente"], "recommendations": ["Proposer une promotion"]}`,
        },
      ],
    })

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : '{}'
    const result = JSON.parse(text) as {
      score: number
      risk: string
      factors: string[]
      recommendations: string[]
    }

    // Mettre à jour en base via API
    const apiUrl = process.env['API_URL'] ?? 'http://localhost:4000'
    await fetch(`${apiUrl}/employees/${employeeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        retentionScore: result.score.toString(),
        burnoutRisk: result.risk,
        aiScoreFactors: result.factors,
      }),
    })

    logger.info({ employeeId, score: result.score }, 'Score IA calculé')
    return result
  },
  {
    connection: redisConnection,
    concurrency: 3,
  }
)

aiScoringWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Job IA scoring échoué')
})
