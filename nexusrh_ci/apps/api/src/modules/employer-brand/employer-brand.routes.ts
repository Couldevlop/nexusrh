/**
 * Marque employeur — routes Fastify (prefix /employer-brand). Lot 1.
 *
 * Tableau de bord qui VALORISE les données déjà présentes (aucune collecte
 * nouvelle) : attractivité (candidatures par source / par offre, taux de
 * candidatures internes), efficacité (délai de pourvoi, pipeline) et fidélisation
 * des recrues (rétention à 3 et 12 mois, départs précoces, motifs de départ).
 *
 * SÉCURITÉ / CONFIDENTIALITÉ
 *  - OWASP A01 : admin, hr_manager, dg et readonly (lecture seule). Ni manager
 *    ni employee. Module `employer_brand` activable par tenant (hook global).
 *  - Isolation tenant : schéma lu dans le JWT, jamais en dur.
 *  - Uniquement des AGRÉGATS : aucun nom, email ni identifiant de candidat ou de
 *    salarié ne sort de cette route.
 *  - OWASP A03 : dates et identifiant de filiale validés (regex/UUID) puis
 *    passés en paramètres SQL.
 *  - Fail-soft : un bloc dont la table/colonne n'est pas encore migrée renvoie
 *    des zéros au lieu de casser l'écran (règle « zéro écran vide »).
 */
import type { FastifyPluginAsync } from 'fastify'
import { pool } from '../../db/pool.js'
import { ensureRecruitmentSchemaMigrated } from '../../db/provisioning.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { badRequest } from '../../utils/http-errors.js'
import {
  resolvePeriod, median, average, percent,
  bySource, byStage, byDepartureType, summarizeRetention,
  type RetentionCounts,
} from './employer-brand.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'dg', 'readonly'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Nombre d'offres restituées dans le classement « candidatures par offre ». */
const TOP_JOBS = 10

// Colonnes recrutement (source, target_legal_entity_id…) : migration lazy du
// module recrutement, rejouée une seule fois par schéma et par processus.
const recruitmentMigrated = new Set<string>()
async function ensureRecruitmentColumns(schema: string): Promise<void> {
  if (recruitmentMigrated.has(schema)) return
  try {
    await ensureRecruitmentSchemaMigrated(schema)
    recruitmentMigrated.add(schema)
  } catch { /* fail-soft : les blocs concernés renverront des zéros */ }
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() } catch { return fallback }
}

const employerBrandRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // GET /employer-brand/overview?from=&to=&legalEntityId=
  fastify.get('/overview', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['employer-brand'], summary: 'Marque employeur — indicateurs agrégés (attractivité, recrutement, rétention)' },
    handler: async (request, reply) => {
      const q = request.query as { from?: string; to?: string; legalEntityId?: string }
      let period: { from: string; to: string }
      try { period = resolvePeriod(q.from, q.to) }
      catch (e) { return badRequest(reply, (e as Error).message) }
      const legalEntityId = q.legalEntityId && q.legalEntityId !== '' ? q.legalEntityId : null
      if (legalEntityId && !UUID_RE.test(legalEntityId)) return badRequest(reply, 'Filiale invalide')

      try {
        const s = request.user.schemaName
        await ensureRecruitmentColumns(s)
        const params = [period.from, period.to, legalEntityId]
        // Filtre filiale côté offres (filiale cible de l'offre) et côté salariés.
        const jobFilter = `($3::uuid IS NULL OR rj.target_legal_entity_id = $3::uuid)`
        const empFilter = `($3::uuid IS NULL OR e.legal_entity_id = $3::uuid)`
        const inPeriod = (col: string) => `${col} >= $1::date AND ${col} < ($2::date + 1)`

        const [sources, jobs, fillDays, pipeline, retention, departures, legalEntities] = await Promise.all([
          safe(async () => {
            const r = await pool.query<{ source: string | null; n: string }>(
              `SELECT a.source, COUNT(*)::int AS n
                 FROM "${s}".applications a
                 JOIN "${s}".recruitment_jobs rj ON rj.id = a.job_id
                WHERE ${inPeriod('a.created_at')} AND ${jobFilter}
                GROUP BY a.source`, params)
            return r.rows
          }, [] as Array<{ source: string | null; n: string }>),

          safe(async () => {
            const r = await pool.query<{ id: string; title: string; n: string; internal: string }>(
              `SELECT rj.id, rj.title, COUNT(a.id)::int AS n,
                      COUNT(a.id) FILTER (WHERE a.source = 'internal')::int AS internal
                 FROM "${s}".applications a
                 JOIN "${s}".recruitment_jobs rj ON rj.id = a.job_id
                WHERE ${inPeriod('a.created_at')} AND ${jobFilter}
                GROUP BY rj.id, rj.title
                ORDER BY n DESC, rj.title ASC
                LIMIT ${TOP_JOBS}`, params)
            return r.rows.map((x) => ({ jobId: x.id, title: x.title, applications: Number(x.n), internal: Number(x.internal) }))
          }, [] as Array<{ jobId: string; title: string; applications: number; internal: number }>),

          // Délai de pourvoi = publication → pourvoi. Date de pourvoi : closed_at
          // de l'offre, à défaut la 1re embauche (applications.hired_at, posé
          // par le funnel recrutement ; repli updated_at pour l'historique).
          safe(async () => {
            const r = await pool.query<{ days: string }>(
              `SELECT EXTRACT(EPOCH FROM (f.filled_at - rj.published_at)) / 86400 AS days
                 FROM "${s}".recruitment_jobs rj
                 CROSS JOIN LATERAL (
                   SELECT COALESCE(rj.closed_at,
                     (SELECT MIN(COALESCE(a.hired_at, a.updated_at)) FROM "${s}".applications a
                       WHERE a.job_id = rj.id AND a.stage = 'hired')) AS filled_at
                 ) f
                WHERE rj.published_at IS NOT NULL AND f.filled_at IS NOT NULL
                  AND f.filled_at >= rj.published_at
                  AND ${inPeriod('f.filled_at')} AND ${jobFilter}`, params)
            return r.rows.map((x) => Number(x.days)).filter((n) => Number.isFinite(n))
          }, [] as number[]),

          // Pipeline : photographie ACTUELLE des offres ouvertes (hors période).
          safe(async () => {
            const r = await pool.query<{ stage: string | null; n: string }>(
              `SELECT a.stage, COUNT(*)::int AS n
                 FROM "${s}".applications a
                 JOIN "${s}".recruitment_jobs rj ON rj.id = a.job_id
                WHERE rj.status = 'open' AND ${jobFilter}
                GROUP BY a.stage`, params)
            return r.rows
          }, [] as Array<{ stage: string | null; n: string }>),

          // Rétention des recrues de la période. Un salarié archivé (deleted_at)
          // est un départ : date de sortie effective = exit_date, à défaut la
          // date d'archivage. Une cohorte n'est « éligible » à 3/12 mois que si
          // ce délai est écoulé depuis l'embauche.
          safe(async () => {
            const r = await pool.query<RetentionCounts>(
              `WITH emp AS (
                 SELECT e.hire_date, COALESCE(e.exit_date, e.deleted_at::date) AS left_on
                   FROM "${s}".employees e
                  WHERE ${empFilter}
               )
               SELECT
                 COUNT(*) FILTER (WHERE hire_date BETWEEN $1::date AND $2::date)::int AS hires,
                 COUNT(*) FILTER (WHERE hire_date BETWEEN $1::date AND $2::date
                                   AND hire_date + interval '3 months' <= CURRENT_DATE)::int AS eligible_3m,
                 COUNT(*) FILTER (WHERE hire_date BETWEEN $1::date AND $2::date
                                   AND hire_date + interval '3 months' <= CURRENT_DATE
                                   AND (left_on IS NULL OR left_on > hire_date + interval '3 months'))::int AS retained_3m,
                 COUNT(*) FILTER (WHERE hire_date BETWEEN $1::date AND $2::date
                                   AND hire_date + interval '12 months' <= CURRENT_DATE)::int AS eligible_12m,
                 COUNT(*) FILTER (WHERE hire_date BETWEEN $1::date AND $2::date
                                   AND hire_date + interval '12 months' <= CURRENT_DATE
                                   AND (left_on IS NULL OR left_on > hire_date + interval '12 months'))::int AS retained_12m,
                 COUNT(*) FILTER (WHERE left_on BETWEEN $1::date AND $2::date)::int AS departures,
                 COUNT(*) FILTER (WHERE left_on BETWEEN $1::date AND $2::date
                                   AND hire_date IS NOT NULL
                                   AND left_on < hire_date + interval '1 year')::int AS early_departures
               FROM emp`, params)
            return r.rows[0]
          }, undefined as RetentionCounts | undefined),

          safe(async () => {
            const r = await pool.query<{ departure_type: string | null; n: string }>(
              `SELECT oc.departure_type, COUNT(*)::int AS n
                 FROM "${s}".offboarding_cases oc
                 JOIN "${s}".employees e ON e.id = oc.employee_id
                WHERE oc.status <> 'cancelled'
                  AND oc.departure_date BETWEEN $1::date AND $2::date
                  AND ${empFilter}
                GROUP BY oc.departure_type`, params)
            return r.rows
          }, [] as Array<{ departure_type: string | null; n: string }>),

          safe(async () => {
            const r = await pool.query<{ id: string; name: string }>(
              `SELECT id, name FROM "${s}".legal_entities WHERE is_active = true ORDER BY name`)
            return r.rows
          }, [] as Array<{ id: string; name: string }>),
        ])

        const applicationsBySource = bySource(sources)
        const totalApplications = applicationsBySource.reduce((a, b) => a + b.count, 0)
        const internalApplications = applicationsBySource.find((x) => x.source === 'internal')?.count ?? 0
        const pipelineByStage = byStage(pipeline)

        return reply.send({
          data: {
            period: period,
            legalEntityId: legalEntityId,
            legalEntities: legalEntities,
            attractiveness: {
              totalApplications: totalApplications,
              internalApplications: internalApplications,
              internalRate: percent(internalApplications, totalApplications),
              bySource: applicationsBySource,
              byJob: jobs,
            },
            timeToFill: {
              filledJobs: fillDays.length,
              medianDays: median(fillDays),
              averageDays: average(fillDays),
            },
            pipeline: {
              total: pipelineByStage.reduce((a, b) => a + b.count, 0),
              byStage: pipelineByStage,
            },
            retention: summarizeRetention(retention),
            departureTypes: byDepartureType(departures),
          },
        })
      } catch (err) {
        request.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default employerBrandRoutes
