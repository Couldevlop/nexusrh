/**
 * Indicateurs de l'entonnoir de recrutement (marque employeur, lot 2) —
 * AGRÉGATS uniquement : aucun nom, aucun identifiant de candidature n'est
 * renvoyé.
 *
 * GET /recruitment/funnel-stats?from=YYYY-MM-DD&to=YYYY-MM-DD&jobId=<uuid>
 *
 *   - cohorte = candidatures DÉPOSÉES dans la période (created_at) ;
 *   - étape atteinte = étape la plus avancée connue (historique OU étape
 *     courante) : un dossier passé directement de « nouveau » à « entretien »
 *     compte comme ayant franchi la présélection ;
 *   - conversion étape → étape suivante = atteint(n+1) / atteint(n) ;
 *   - offres faites = dossiers ayant atteint « offre » (ou « recruté ») ;
 *     acceptation = recrutés / (recrutés + offres déclinées par le candidat) ;
 *   - délai de recrutement réel = 1re entrée d'historique → hired_at, sur les
 *     embauches DATÉES dans la période (hired_at) ;
 *   - motifs de rejet = répartition des dossiers rejetés de la cohorte.
 *
 * RBAC : admin, hr_manager, dg, readonly (lecture d'agrégats).
 */
import type { FastifyPluginAsync } from 'fastify'
import { pool } from '../../db/pool.js'
import { ensureRecruitmentSchemaMigrated } from '../../db/provisioning.js'
import { DECLINED_BY_CANDIDATE_PREFIX, FUNNEL_STAGES, REJECTION_REASONS } from './stage-history.js'

const STATS_ROLES = ['admin', 'hr_manager', 'dg', 'readonly'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Rang d'une étape dans l'entonnoir (NULL pour `rejected` / inconnu). */
function stageRankSql(expr: string): string {
  return `CASE ${expr} ${FUNNEL_STAGES.map((st, i) => `WHEN '${st}' THEN ${i}`).join(' ')} ELSE NULL END`
}

/** Taux en pourcentage, une décimale ; null si le dénominateur est nul. */
export function rate(num: number, den: number): number | null {
  if (!den) return null
  return Math.round((num / den) * 1000) / 10
}

interface ReachedRow {
  total: number
  hired: number
  rejected: number
  offers_declined: number
  candidate_withdrawals: number
  [reached: `reached_${number}`]: number
}

export interface FunnelStats {
  period: { from: string | null; to: string | null; jobId: string | null }
  totalApplications: number
  hired: number
  rejected: number
  stages: Array<{ stage: string; reached: number }>
  conversions: Array<{ from: string; to: string; fromCount: number; toCount: number; rate: number | null }>
  offers: { made: number; accepted: number; declinedByCandidate: number; acceptanceRate: number | null }
  candidateWithdrawals: number
  timeToHire: { hires: number; averageDays: number | null; medianDays: number | null; minDays: number | null; maxDays: number | null }
  rejectionReasons: Array<{ reason: string; count: number; share: number | null }>
}

export function buildFunnelStats(
  period: FunnelStats['period'],
  reached: ReachedRow,
  reasons: Array<{ reason: string; count: number }>,
  tth: { hires: number; avg_days: number | null; median_days: number | null; min_days: number | null; max_days: number | null },
): FunnelStats {
  const num = (v: unknown) => Number(v) || 0
  const stages = FUNNEL_STAGES.map((stage, i) => ({ stage, reached: num(reached[`reached_${i}`]) }))
  const conversions = stages.slice(0, -1).map((s, i) => {
    const next = stages[i + 1]!
    return { from: s.stage, to: next.stage, fromCount: s.reached, toCount: next.reached, rate: rate(next.reached, s.reached) }
  })
  const hired = num(reached.hired)
  const declined = num(reached.offers_declined)
  const offersMade = stages[FUNNEL_STAGES.indexOf('offer')]!.reached
  const rejected = num(reached.rejected)
  const round1 = (v: number | null) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10)
  return {
    period,
    totalApplications: num(reached.total),
    hired,
    rejected,
    stages,
    conversions,
    offers: { made: offersMade, accepted: hired, declinedByCandidate: declined, acceptanceRate: rate(hired, hired + declined) },
    candidateWithdrawals: num(reached.candidate_withdrawals),
    timeToHire: {
      hires: num(tth.hires),
      averageDays: round1(tth.avg_days),
      medianDays: round1(tth.median_days),
      minDays: round1(tth.min_days),
      maxDays: round1(tth.max_days),
    },
    rejectionReasons: reasons
      .map((r) => ({ reason: r.reason, count: num(r.count), share: rate(num(r.count), rejected) }))
      .sort((a, b) => b.count - a.count),
  }
}

const funnelStatsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/funnel-stats', {
    preHandler: [fastify.authorize(...STATS_ROLES)],
    schema: { tags: ['recruitment'], summary: "Indicateurs de l'entonnoir de recrutement (agrégats)" },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const q = request.query as { from?: string; to?: string; jobId?: string }
      const from = q.from || null
      const to = q.to || null
      const jobId = q.jobId || null
      if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
        return reply.status(400).send({ error: 'Dates attendues au format YYYY-MM-DD' })
      }
      if (jobId && !UUID_RE.test(jobId)) {
        return reply.status(400).send({ error: 'jobId invalide (UUID requis)' })
      }
      if (from && to && from > to) {
        return reply.status(400).send({ error: 'La date de début doit précéder la date de fin' })
      }
      try {
        await ensureRecruitmentSchemaMigrated(schema)
        const a = `"${schema}".applications`
        const h = `"${schema}".application_stage_history`
        const cohort = `SELECT a.id, a.stage, a.rejection_reason
                          FROM ${a} a
                         WHERE ($1::date IS NULL OR a.created_at >= $1::date)
                           AND ($2::date IS NULL OR a.created_at < $2::date + 1)
                           AND ($3::uuid IS NULL OR a.job_id = $3::uuid)`
        const reachedCols = FUNNEL_STAGES
          .map((_, i) => `count(*) FILTER (WHERE furthest >= ${i})::int AS reached_${i}`).join(',\n               ')
        const declinedLike = `'${DECLINED_BY_CANDIDATE_PREFIX}%'`
        const offerRank = FUNNEL_STAGES.indexOf('offer')
        const params = [from, to, jobId]

        const [reachedRes, reasonsRes, tthRes] = await Promise.all([
          pool.query<ReachedRow>(
            `WITH cohort AS (${cohort}),
             ranked AS (
               SELECT c.stage, c.rejection_reason,
                      GREATEST(
                        (SELECT max(${stageRankSql('h.to_stage')}) FROM ${h} h WHERE h.application_id = c.id),
                        ${stageRankSql('c.stage')},
                        0) AS furthest
                 FROM cohort c
             )
             SELECT count(*)::int AS total,
               ${reachedCols},
               count(*) FILTER (WHERE stage = 'hired')::int AS hired,
               count(*) FILTER (WHERE stage = 'rejected')::int AS rejected,
               count(*) FILTER (WHERE stage = 'rejected' AND rejection_reason LIKE ${declinedLike}
                                  AND furthest >= ${offerRank})::int AS offers_declined,
               count(*) FILTER (WHERE stage = 'rejected' AND rejection_reason LIKE ${declinedLike})::int AS candidate_withdrawals
               FROM ranked`,
            params,
          ),
          pool.query<{ reason: string; count: number }>(
            `WITH cohort AS (${cohort})
             SELECT COALESCE(rejection_reason, 'unspecified') AS reason, count(*)::int AS count
               FROM cohort WHERE stage = 'rejected'
              GROUP BY 1`,
            params,
          ),
          pool.query<{ hires: number; avg_days: number | null; median_days: number | null; min_days: number | null; max_days: number | null }>(
            `WITH hires AS (
               SELECT EXTRACT(EPOCH FROM (a.hired_at - COALESCE(
                        (SELECT min(h.changed_at) FROM ${h} h WHERE h.application_id = a.id),
                        a.created_at))) / 86400.0 AS days
                 FROM ${a} a
                WHERE a.stage = 'hired' AND a.hired_at IS NOT NULL
                  AND ($1::date IS NULL OR a.hired_at >= $1::date)
                  AND ($2::date IS NULL OR a.hired_at < $2::date + 1)
                  AND ($3::uuid IS NULL OR a.job_id = $3::uuid)
             )
             SELECT count(*)::int AS hires,
                    avg(GREATEST(days, 0))::float AS avg_days,
                    (percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(days, 0)))::float AS median_days,
                    min(GREATEST(days, 0))::float AS min_days,
                    max(GREATEST(days, 0))::float AS max_days
               FROM hires`,
            params,
          ),
        ])

        const reachedRow = reachedRes.rows[0] ?? { total: 0, hired: 0, rejected: 0, offers_declined: 0, candidate_withdrawals: 0 }
        const tth = tthRes.rows[0] ?? { hires: 0, avg_days: null, median_days: null, min_days: null, max_days: null }
        const stats = buildFunnelStats({ from, to, jobId }, reachedRow, reasonsRes.rows, tth)
        return reply.send({ data: stats, reasons: REJECTION_REASONS })
      } catch (err) {
        request.log.error({ err, schema }, 'recruitment.funnel-stats failed')
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default funnelStatsRoutes
