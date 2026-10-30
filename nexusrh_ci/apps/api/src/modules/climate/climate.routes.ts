/**
 * Enquêtes climat social — routes Fastify (prefix /climate).
 *
 * Gestion RH (campagnes + résultats agrégés) et réponse self-service du salarié.
 *
 * CONFIDENTIALITÉ / SÉCURITÉ
 *  - Les résultats sont AGRÉGÉS : aucune réponse nominative n'est jamais exposée.
 *  - employee_id n'est stocké que pour le dédoublonnage + le taux de participation
 *    (UNIQUE(survey_id, employee_id)), jamais restitué dans /results.
 *  - OWASP A01 : gestion réservée RH ; la réponse est ouverte à tout salarié
 *    authentifié (fastify.authenticate). A03 : Zod safeParse + validation des
 *    questions. A09 : actions de gestion auditées (pas la réponse → anonymat).
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { actorEmployeeSql } from '../../utils/actor-employee.js'
import {
  SURVEY_STATUSES,
  QUESTION_TYPES,
  canTransition,
  validateQuestions,
  aggregateResults,
  aggregateByGroup,
  resolveMinResponses,
  DEFAULT_MIN_RESPONSES,
  GROUP_BY_VALUES,
  type GroupBy,
  type GroupResults,
  type BelowThresholdResults,
  type SurveyStatus,
  type SurveyQuestion,
} from './climate.service.js'
import { auditTenant } from '../../utils/audit-log.js'
import { badRequest } from '../../utils/http-errors.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'

const MANAGE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'readonly'] as const
const DELETE_ROLES = ['admin', 'hr_manager'] as const

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  anonymous: z.boolean().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  questions: z.array(z.object({
    key: z.string().max(50).optional(),
    label: z.string().min(1).max(300),
    type: z.enum(QUESTION_TYPES),
  })).min(1),
})

const updateSchema = z.object({
  status: z.enum(SURVEY_STATUSES).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
})

const responseSchema = z.object({
  answers: z.record(z.union([z.string(), z.number(), z.boolean()])),
})

function audit(
  schema: string, userId: string | undefined, action: string,
  id: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  auditTenant(schema, { userId: userId ?? null, action: action, entity: 'climate_survey', entityId: id, changes: changes, ip: ip })
}

async function resolveEmployeeId(
  schema: string, user: { employeeId: string | null; email: string },
): Promise<string | null> {
  if (user.employeeId) return user.employeeId
  const r = await rawPool.query<{ id: string }>(
    actorEmployeeSql(schema), [user.email],
  )
  return r.rows[0]?.id ?? null
}

/**
 * Seuil d'anonymat du tenant (platform.tenants.climate_min_responses). Lecture
 * impossible (colonne pas encore migrée…) → défaut : on reste protecteur.
 */
async function loadMinResponses(schema: string): Promise<number> {
  try {
    const r = await rawPool.query<{ climate_min_responses: number | null }>(
      `SELECT climate_min_responses FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
    )
    return resolveMinResponses(r.rows[0]?.climate_min_responses)
  } catch {
    return DEFAULT_MIN_RESPONSES
  }
}

const climateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // GET /climate/surveys — liste (RH) avec nombre de réponses
  fastify.get('/surveys', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['climate'], summary: 'Liste des enquêtes climat' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT s.*, (SELECT COUNT(*) FROM "${schema}".climate_responses r WHERE r.survey_id = s.id) AS response_count
         FROM "${schema}".climate_surveys s ORDER BY s.created_at DESC`,
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /climate/surveys/:id — détail (RH)
  fastify.get('/surveys/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['climate'], summary: 'Détail d\'une enquête' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(
        `SELECT * FROM "${schema}".climate_surveys WHERE id = $1 LIMIT 1`, [id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Enquête introuvable' })
      return reply.send({ data: res.rows[0] })
    },
  })

  // POST /climate/surveys — créer (RH)
  fastify.post('/surveys', {
    preHandler: [fastify.authorize(...MANAGE_ROLES)],
    schema: { tags: ['climate'], summary: 'Créer une enquête climat' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply, 'Validation échouée')
      let questions: SurveyQuestion[]
      try { questions = validateQuestions(parsed.data.questions) }
      catch (e) { return badRequest(reply, (e as Error).message) }
      const b = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".climate_surveys
           (title, description, anonymous, questions, start_date, end_date, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING *`,
        [b.title, b.description ?? null, b.anonymous ?? true, JSON.stringify(questions),
         b.startDate ?? null, b.endDate ?? null, request.user.sub],
      )
      const row = res.rows[0] as { id: string }
      audit(schema, request.user.sub, 'climate.created', row.id, { title: b.title }, request.ip ?? null)
      return reply.status(201).send({ data: row })
    },
  })

  // PATCH /climate/surveys/:id — statut / titre (RH)
  fastify.patch('/surveys/:id', {
    preHandler: [fastify.authorize(...MANAGE_ROLES)],
    schema: { tags: ['climate'], summary: 'Mettre à jour une enquête' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = updateSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply, 'Validation échouée')
      const b = parsed.data
      const cur = await rawPool.query<{ status: SurveyStatus }>(
        `SELECT status FROM "${schema}".climate_surveys WHERE id = $1 LIMIT 1`, [id],
      )
      if (!cur.rows[0]) return reply.status(404).send({ error: 'Enquête introuvable' })
      if (b.status && !canTransition(cur.rows[0].status, b.status)) {
        return reply.status(409).send({ error: `Transition interdite : ${cur.rows[0].status} → ${b.status}`, statusCode: 409 })
      }
      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      if (b.status !== undefined)      { sets.push(`status = $${i++}`); params.push(b.status) }
      if (b.title !== undefined)       { sets.push(`title = $${i++}`); params.push(b.title) }
      if (b.description !== undefined) { sets.push(`description = $${i++}`); params.push(b.description) }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      sets.push(`updated_at = now()`)
      params.push(id)
      const res = await rawPool.query(
        `UPDATE "${schema}".climate_surveys SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params,
      )
      audit(schema, request.user.sub, 'climate.updated', id, b as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // DELETE /climate/surveys/:id — admin / hr_manager
  fastify.delete('/surveys/:id', {
    preHandler: [fastify.authorize(...DELETE_ROLES)],
    schema: { tags: ['climate'], summary: 'Supprimer une enquête (admin/RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(
        `DELETE FROM "${schema}".climate_surveys WHERE id = $1 RETURNING id`, [id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Enquête introuvable' })
      await rawPool.query(`DELETE FROM "${schema}".climate_responses WHERE survey_id = $1`, [id]).catch(() => undefined)
      audit(schema, request.user.sub, 'climate.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })

  // GET /climate/surveys/:id/results — résultats AGRÉGÉS (jamais nominatifs)
  //
  // Seuil d'anonymat : sous `minResponses` réponses (paramétrable par tenant),
  // AUCUN score ni commentaire n'est renvoyé — seulement le compte et le seuil.
  // Même règle pour la ventilation optionnelle ?groupBy=department|legal_entity :
  // les sous-groupes sous le seuil sont masqués (avec suppression secondaire).
  fastify.get('/surveys/:id/results', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['climate'], summary: 'Résultats agrégés d\'une enquête (seuil d\'anonymat)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const { groupBy: rawGroupBy } = request.query as { groupBy?: string }
      let groupBy: GroupBy | null = null
      if (rawGroupBy !== undefined && rawGroupBy !== '') {
        if (!(GROUP_BY_VALUES as readonly string[]).includes(rawGroupBy)) return badRequest(reply, 'Ventilation invalide')
        groupBy = rawGroupBy as GroupBy
      }
      try {
        const s = await rawPool.query<{ questions: SurveyQuestion[] }>(
          `SELECT questions FROM "${schema}".climate_surveys WHERE id = $1 LIMIT 1`, [id],
        )
        if (!s.rows[0]) return reply.status(404).send({ error: 'Enquête introuvable' })
        const questions = s.rows[0].questions ?? []
        const minResponses = await loadMinResponses(schema)

        const c = await rawPool.query<{ n: number | string }>(
          `SELECT COUNT(*)::int AS n FROM "${schema}".climate_responses WHERE survey_id = $1`, [id],
        )
        const responses = Number(c.rows[0]?.n ?? 0)
        if (responses < minResponses) {
          const below: BelowThresholdResults = { belowThreshold: true, responses: responses, minResponses: minResponses }
          return reply.send({ data: below })
        }

        // On ne sélectionne QUE les réponses (answers), jamais employee_id : aucun
        // lien nominatif ne quitte la base.
        const r = await rawPool.query<{ answers: Record<string, unknown> }>(
          `SELECT answers FROM "${schema}".climate_responses WHERE survey_id = $1`, [id],
        )
        const results = aggregateResults(questions, r.rows.map((x) => x.answers ?? {}))

        let groups: GroupResults[] | null = null
        let hiddenGroups = 0
        if (groupBy) {
          // La jointure sur la fiche salarié reste DANS la base : seuls la clé et
          // le libellé du groupe en sortent, jamais l'identifiant du répondant.
          const join = groupBy === 'department'
            ? `LEFT JOIN "${schema}".departments g ON g.id = e.department_id`
            : `LEFT JOIN "${schema}".legal_entities g ON g.id = e.legal_entity_id`
          const g = await rawPool.query<{ answers: Record<string, unknown>; group_key: string | null; group_label: string | null }>(
            `SELECT r.answers, g.id::text AS group_key, g.name AS group_label
               FROM "${schema}".climate_responses r
               LEFT JOIN "${schema}".employees e ON e.id = r.employee_id
               ${join}
              WHERE r.survey_id = $1`,
            [id],
          )
          const grouped = aggregateByGroup(
            questions,
            g.rows.map((x) => ({ groupKey: x.group_key, groupLabel: x.group_label, answers: x.answers ?? {} })),
            minResponses,
          )
          groups = grouped.groups
          hiddenGroups = grouped.hiddenGroups
        }

        return reply.send({
          data: {
            belowThreshold: false,
            minResponses: minResponses,
            ...results,
            groupBy: groupBy,
            groups: groups,
            hiddenGroups: hiddenGroups,
          },
        })
      } catch (err) {
        request.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /climate/my-surveys — enquêtes ouvertes pour le salarié (self-service)
  fastify.get('/my-surveys', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['climate'], summary: 'Mes enquêtes climat à compléter' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const employeeId = await resolveEmployeeId(schema, request.user)
      if (!employeeId) return reply.send({ data: [] })
      const res = await rawPool.query(
        `SELECT s.id, s.title, s.description, s.questions, s.anonymous,
                EXISTS(SELECT 1 FROM "${schema}".climate_responses r
                       WHERE r.survey_id = s.id AND r.employee_id = $1) AS responded
         FROM "${schema}".climate_surveys s
         WHERE s.status = 'open' ORDER BY s.created_at DESC`,
        [employeeId],
      )
      return reply.send({ data: res.rows })
    },
  })

  // POST /climate/surveys/:id/responses — soumettre (tout salarié authentifié)
  fastify.post('/surveys/:id/responses', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['climate'], summary: 'Répondre à une enquête climat' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = responseSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply, 'Validation échouée')

      const s = await rawPool.query<{ status: SurveyStatus }>(
        `SELECT status FROM "${schema}".climate_surveys WHERE id = $1 LIMIT 1`, [id],
      )
      if (!s.rows[0]) return reply.status(404).send({ error: 'Enquête introuvable' })
      if (s.rows[0].status !== 'open') return reply.status(409).send({ error: 'Enquête non ouverte', statusCode: 409 })

      const employeeId = await resolveEmployeeId(schema, request.user)
      if (!employeeId) return reply.status(400).send({ error: 'Salarié non identifié' })

      const ins = await rawPool.query<{ id: string }>(
        `INSERT INTO "${schema}".climate_responses (survey_id, employee_id, answers)
         VALUES ($1, $2, $3) ON CONFLICT (survey_id, employee_id) DO NOTHING RETURNING id`,
        [id, employeeId, JSON.stringify(parsed.data.answers)],
      )
      if (!ins.rows[0]) return reply.status(409).send({ error: 'Vous avez déjà répondu à cette enquête', statusCode: 409 })
      return reply.status(201).send({ data: { ok: true } })
    },
  })
}

export default climateRoutes
