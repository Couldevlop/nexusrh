/**
 * Parcours d'intégration (onboarding) — module API.
 *
 * Meilleures pratiques RH :
 *   - modèles paramétrables par séniorité / type de poste (mots-clés) ;
 *   - parcours auto-créé à la création du collaborateur (pré-boarding inclus) ;
 *   - kanban d'étapes (todo / in_progress / done) planifiable par les RH ;
 *   - chaque étape a un responsable (RH, manager, collaborateur, IT, parrain),
 *     une phase (avant l'arrivée → fin d'essai), une échéance et des
 *     ressources (documents, vidéos, liens utiles) ;
 *   - le collaborateur voit son parcours en self-service et coche SES étapes ;
 *   - génération IA d'un parcours complet (brouillon validé par les RH).
 *
 * RBAC :
 *   admin / hr_manager        : tout (modèles + parcours)
 *   hr_officer                : parcours (saisie), modèles en lecture
 *   manager                   : parcours de SON équipe (lecture + avancement)
 *   employee                  : son propre parcours uniquement (A01)
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  ONBOARDING_PHASES,
  ONBOARDING_OWNERS,
  ONBOARDING_STEP_STATUSES,
  ONBOARDING_SENIORITIES,
} from '../../db/onboarding-tables.js'
import {
  startOnboardingJourney,
  refreshJourneyStatus,
} from '../../services/onboarding.service.js'
import { generateOnboardingPlan } from '../../services/onboarding-ai.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Schémas Zod (OWASP A03) ─────────────────────────────────────────────────
const resourceSchema = z.object({
  type:  z.enum(['document', 'video', 'link']),
  title: z.string().min(1).max(200),
  url:   z.string().max(2000).optional().default(''),
})

const templateStepSchema = z.object({
  title:         z.string().min(1).max(255),
  description:   z.string().max(2000).optional().default(''),
  phase:         z.enum(ONBOARDING_PHASES).optional().default('first_week'),
  ownerRole:     z.enum(ONBOARDING_OWNERS).optional().default('hr'),
  dueOffsetDays: z.number().int().min(-60).max(365).optional().default(0),
  resources:     z.array(resourceSchema).max(10).optional().default([]),
})

const createTemplateSchema = z.object({
  name:         z.string().min(1).max(200),
  description:  z.string().max(2000).optional(),
  seniority:    z.enum(ONBOARDING_SENIORITIES).optional().default('any'),
  jobKeywords:  z.string().max(500).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  isDefault:    z.boolean().optional().default(false),
  isActive:     z.boolean().optional().default(true),
  steps:        z.array(templateStepSchema).max(60).optional().default([]),
}).strict()

const patchStepSchema = z.object({
  title:       z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  phase:       z.enum(ONBOARDING_PHASES).optional(),
  ownerRole:   z.enum(ONBOARDING_OWNERS).optional(),
  status:      z.enum(ONBOARDING_STEP_STATUSES).optional(),
  dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  sortOrder:   z.number().int().min(0).max(10_000).optional(),
  notes:       z.string().max(2000).nullable().optional(),
  resources:   z.array(resourceSchema).max(10).optional(),
}).strict()

const generateSchema = z.object({
  jobTitle:       z.string().min(2).max(200),
  seniority:      z.string().max(50).optional(),
  department:     z.string().max(100).optional(),
  companyContext: z.string().max(500).optional(),
}).strict()

// Génération IA : coûteuse → rate limit serré (anti-abus).
const AI_GENERATE_RATE_LIMIT = { rateLimit: { max: 5, timeWindow: '1 minute' } }

function auditLogOnboarding(
  schema: string, userId: string, action: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'onboarding', $3, $4, $5)`,
    [userId, action, entityId, JSON.stringify(changes), ip],
  ).catch(() => { /* non bloquant */ })
}

/** Id employé du user courant (claim JWT, repli par email). */
async function currentEmployeeId(schema: string, user: { employeeId?: string | null; email: string }): Promise<string | null> {
  if (user.employeeId) return user.employeeId
  try {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM "${schema}".employees WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
      [user.email],
    )
    return r.rows[0]?.id ?? null
  } catch { return null }
}

/** OWASP A01 — un manager ne touche que les parcours de son équipe directe. */
async function managerOwnsJourney(schema: string, managerEmail: string, journeyId: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT 1
       FROM "${schema}".onboarding_journeys j
       JOIN "${schema}".employees e ON e.id = j.employee_id
       JOIN "${schema}".employees m ON m.id = e.manager_id
       WHERE j.id = $1 AND m.email = $2 LIMIT 1`,
      [journeyId, managerEmail],
    )
    return !!r.rows[0]
  } catch { return false }
}

const onboardingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // ─── MODÈLES ───────────────────────────────────────────────────────────────

  // GET /onboarding/templates
  fastify.get('/templates', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['onboarding'], summary: 'Modèles de parcours d\'intégration' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await pool.query(
        `SELECT t.*, d.name AS department_name,
                (SELECT count(*) FROM "${schema}".onboarding_template_steps s WHERE s.template_id = t.id) AS steps_count
         FROM "${schema}".onboarding_templates t
         LEFT JOIN "${schema}".departments d ON d.id = t.department_id
         ORDER BY t.is_active DESC, t.created_at DESC`,
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /onboarding/templates/:id — détail + étapes
  fastify.get('/templates/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['onboarding'], summary: 'Détail d\'un modèle' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const schema = request.user.schemaName
      const tpl = await pool.query(`SELECT * FROM "${schema}".onboarding_templates WHERE id = $1 LIMIT 1`, [id])
      if (!tpl.rows[0]) return reply.status(404).send({ error: 'Modèle introuvable' })
      const steps = await pool.query(
        `SELECT * FROM "${schema}".onboarding_template_steps WHERE template_id = $1 ORDER BY sort_order ASC, created_at ASC`,
        [id],
      )
      return reply.send({ data: { ...tpl.rows[0], steps: steps.rows } })
    },
  })

  // POST /onboarding/templates — créer (avec étapes)
  fastify.post('/templates', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['onboarding'], summary: 'Créer un modèle de parcours' },
    handler: async (request, reply) => {
      const parsed = createTemplateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Modèle invalide',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data
      const schema = request.user.schemaName
      const tpl = await pool.query<{ id: string }>(
        `INSERT INTO "${schema}".onboarding_templates
           (name, description, seniority, job_keywords, department_id, is_default, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [b.name, b.description ?? null, b.seniority, b.jobKeywords ?? null,
         b.departmentId ?? null, b.isDefault, b.isActive, request.user.sub],
      )
      const templateId = tpl.rows[0]!.id
      let order = 0
      for (const s of b.steps) {
        await pool.query(
          `INSERT INTO "${schema}".onboarding_template_steps
             (template_id, title, description, phase, owner_role, due_offset_days, sort_order, resources)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [templateId, s.title, s.description || null, s.phase, s.ownerRole,
           s.dueOffsetDays, order++, JSON.stringify(s.resources)],
        )
      }
      auditLogOnboarding(schema, request.user.sub, 'onboarding.template.created', templateId,
        { name: b.name, steps: b.steps.length }, request.ip ?? null)
      return reply.status(201).send({ data: { id: templateId } })
    },
  })

  // PATCH /onboarding/templates/:id — métadonnées + remplacement des étapes
  fastify.patch('/templates/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['onboarding'], summary: 'Modifier un modèle de parcours' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = createTemplateSchema.partial().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Modèle invalide' })
      const b = parsed.data
      const schema = request.user.schemaName

      const sets: string[] = []
      const vals: unknown[] = []
      let i = 1
      if (b.name !== undefined)         { sets.push(`name = $${i++}`); vals.push(b.name) }
      if (b.description !== undefined)  { sets.push(`description = $${i++}`); vals.push(b.description ?? null) }
      if (b.seniority !== undefined)    { sets.push(`seniority = $${i++}`); vals.push(b.seniority) }
      if (b.jobKeywords !== undefined)  { sets.push(`job_keywords = $${i++}`); vals.push(b.jobKeywords ?? null) }
      if (b.departmentId !== undefined) { sets.push(`department_id = $${i++}`); vals.push(b.departmentId ?? null) }
      if (b.isDefault !== undefined)    { sets.push(`is_default = $${i++}`); vals.push(b.isDefault) }
      if (b.isActive !== undefined)     { sets.push(`is_active = $${i++}`); vals.push(b.isActive) }
      if (sets.length) {
        sets.push(`updated_at = now()`)
        vals.push(id)
        const r = await pool.query(
          `UPDATE "${schema}".onboarding_templates SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, vals,
        )
        if (!r.rows[0]) return reply.status(404).send({ error: 'Modèle introuvable' })
      }
      if (b.steps !== undefined) {
        await pool.query(`DELETE FROM "${schema}".onboarding_template_steps WHERE template_id = $1`, [id])
        let order = 0
        for (const s of b.steps) {
          await pool.query(
            `INSERT INTO "${schema}".onboarding_template_steps
               (template_id, title, description, phase, owner_role, due_offset_days, sort_order, resources)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, s.title, s.description || null, s.phase, s.ownerRole,
             s.dueOffsetDays, order++, JSON.stringify(s.resources)],
          )
        }
      }
      auditLogOnboarding(schema, request.user.sub, 'onboarding.template.updated', id,
        { fields: Object.keys(b) }, request.ip ?? null)
      return reply.send({ data: { id, updated: true } })
    },
  })

  // DELETE /onboarding/templates/:id
  fastify.delete('/templates/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['onboarding'], summary: 'Supprimer un modèle de parcours' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const schema = request.user.schemaName
      const r = await pool.query(`DELETE FROM "${schema}".onboarding_templates WHERE id = $1 RETURNING id`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Modèle introuvable' })
      auditLogOnboarding(schema, request.user.sub, 'onboarding.template.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id, deleted: true } })
    },
  })

  // POST /onboarding/templates/generate — IA : brouillon de parcours complet
  fastify.post('/templates/generate', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    config: AI_GENERATE_RATE_LIMIT,
    schema: { tags: ['onboarding'], summary: 'Générer un parcours par IA (brouillon)' },
    handler: async (request, reply) => {
      const parsed = generateSchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Paramètres de génération invalides' })
      const schema = request.user.schemaName
      try {
        const plan = await generateOnboardingPlan({ ...parsed.data, schemaName: schema })
        auditLogOnboarding(schema, request.user.sub, 'onboarding.template.ai_generated', null,
          { jobTitle: parsed.data.jobTitle, steps: plan.steps.length }, request.ip ?? null)
        return reply.send({ data: plan })
      } catch (err) {
        // OWASP A10 — pas de détails internes (clé absente, réponse IA invalide…)
        fastify.log.error({ err: (err as Error).message }, '[onboarding] AI generation failed')
        return reply.status(502).send({
          error: 'Génération IA indisponible. Vérifiez la configuration IA du tenant ou réessayez.',
        })
      }
    },
  })

  // ─── PARCOURS ──────────────────────────────────────────────────────────────

  // GET /onboarding/journeys — liste avec progression (manager : son équipe)
  fastify.get('/journeys', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    schema: { tags: ['onboarding'], summary: 'Parcours d\'intégration en cours' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { status } = request.query as { status?: string }
      let sql = `
        SELECT j.*, e.first_name, e.last_name, e.job_title, e.hire_date, e.profile_photo_url,
               d.name AS department_name,
               (SELECT count(*) FROM "${schema}".onboarding_steps s WHERE s.journey_id = j.id) AS total_steps,
               (SELECT count(*) FROM "${schema}".onboarding_steps s WHERE s.journey_id = j.id AND s.status = 'done') AS done_steps,
               (SELECT count(*) FROM "${schema}".onboarding_steps s
                WHERE s.journey_id = j.id AND s.status <> 'done' AND s.due_date IS NOT NULL AND s.due_date < CURRENT_DATE) AS late_steps
        FROM "${schema}".onboarding_journeys j
        JOIN "${schema}".employees e ON e.id = j.employee_id
        LEFT JOIN "${schema}".departments d ON d.id = e.department_id
        WHERE e.deleted_at IS NULL`
      const params: unknown[] = []
      let i = 1
      if (status && ['in_progress', 'completed', 'cancelled'].includes(status)) {
        sql += ` AND j.status = $${i++}`; params.push(status)
      }
      if (request.user.role === 'manager') {
        sql += ` AND e.manager_id = (SELECT id FROM "${schema}".employees WHERE email = $${i++} LIMIT 1)`
        params.push(request.user.email)
      }
      sql += ` ORDER BY j.started_at DESC`
      const res = await pool.query(sql, params)
      return reply.send({ data: res.rows })
    },
  })

  // POST /onboarding/journeys — démarrer manuellement un parcours
  fastify.post('/journeys', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['onboarding'], summary: 'Démarrer un parcours pour un employé' },
    handler: async (request, reply) => {
      const parsed = z.object({
        employeeId: z.string().uuid(),
        templateId: z.string().uuid(),
      }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'employeeId et templateId (UUID) requis' })
      const schema = request.user.schemaName
      const { employeeId, templateId } = parsed.data

      const emp = await pool.query<{ id: string; job_title: string | null; job_level: string | null; department_id: string | null; hire_date: string | null }>(
        `SELECT id, job_title, job_level, department_id, hire_date
         FROM "${schema}".employees WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [employeeId])
      if (!emp.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })

      const tpl = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM "${schema}".onboarding_templates WHERE id = $1 AND is_active = true LIMIT 1`, [templateId])
      if (!tpl.rows[0]) return reply.status(404).send({ error: 'Modèle introuvable ou inactif' })

      const dup = await pool.query(
        `SELECT 1 FROM "${schema}".onboarding_journeys WHERE employee_id = $1 AND status = 'in_progress' LIMIT 1`,
        [employeeId])
      if (dup.rows[0]) return reply.status(409).send({ error: 'Un parcours est déjà en cours pour cet employé' })

      const journeyId = await startOnboardingJourney(pool, schema, emp.rows[0], tpl.rows[0], request.user.sub)
      if (!journeyId) return reply.status(422).send({ error: 'Le modèle ne contient aucune étape' })
      auditLogOnboarding(schema, request.user.sub, 'onboarding.journey.started', journeyId,
        { employeeId, templateId }, request.ip ?? null)
      return reply.status(201).send({ data: { id: journeyId } })
    },
  })

  // GET /onboarding/journeys/:id — détail (kanban)
  fastify.get('/journeys/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    schema: { tags: ['onboarding'], summary: 'Détail d\'un parcours (étapes kanban)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const schema = request.user.schemaName
      // OWASP A01 — manager : uniquement son équipe directe
      if (request.user.role === 'manager' && !(await managerOwnsJourney(schema, request.user.email, id))) {
        return reply.status(403).send({ error: 'Accès limité à votre équipe' })
      }
      const j = await pool.query(
        `SELECT j.*, e.first_name, e.last_name, e.job_title, e.job_level, e.hire_date,
                e.profile_photo_url, d.name AS department_name,
                m.first_name AS manager_first_name, m.last_name AS manager_last_name
         FROM "${schema}".onboarding_journeys j
         JOIN "${schema}".employees e ON e.id = j.employee_id
         LEFT JOIN "${schema}".departments d ON d.id = e.department_id
         LEFT JOIN "${schema}".employees m ON m.id = e.manager_id
         WHERE j.id = $1 LIMIT 1`, [id])
      if (!j.rows[0]) return reply.status(404).send({ error: 'Parcours introuvable' })
      const steps = await pool.query(
        `SELECT * FROM "${schema}".onboarding_steps WHERE journey_id = $1
         ORDER BY sort_order ASC, due_date ASC NULLS LAST, created_at ASC`, [id])
      return reply.send({ data: { ...j.rows[0], steps: steps.rows } })
    },
  })

  // PATCH /onboarding/journeys/:id — annuler / réactiver un parcours
  fastify.patch('/journeys/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['onboarding'], summary: 'Modifier le statut d\'un parcours' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = z.object({ status: z.enum(['in_progress', 'cancelled']) }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'status invalide (in_progress | cancelled)' })
      const schema = request.user.schemaName
      const r = await pool.query(
        `UPDATE "${schema}".onboarding_journeys SET status = $2, updated_at = now() WHERE id = $1 RETURNING id`,
        [id, parsed.data.status])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Parcours introuvable' })
      auditLogOnboarding(schema, request.user.sub, 'onboarding.journey.status_changed', id,
        { status: parsed.data.status }, request.ip ?? null)
      return reply.send({ data: { id, status: parsed.data.status } })
    },
  })

  // POST /onboarding/journeys/:id/steps — ajouter une étape ad hoc
  fastify.post('/journeys/:id/steps', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['onboarding'], summary: 'Ajouter une étape au parcours' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = templateStepSchema.extend({
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }).safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Étape invalide' })
      const s = parsed.data
      const schema = request.user.schemaName
      const exists = await pool.query(`SELECT 1 FROM "${schema}".onboarding_journeys WHERE id = $1 LIMIT 1`, [id])
      if (!exists.rows[0]) return reply.status(404).send({ error: 'Parcours introuvable' })
      const r = await pool.query<{ id: string }>(
        `INSERT INTO "${schema}".onboarding_steps
           (journey_id, title, description, phase, owner_role, status, due_date, sort_order, resources)
         VALUES ($1,$2,$3,$4,$5,'todo',$6,
                 COALESCE((SELECT max(sort_order) + 1 FROM "${schema}".onboarding_steps WHERE journey_id = $1), 0),
                 $7)
         RETURNING id`,
        [id, s.title, s.description || null, s.phase, s.ownerRole, s.dueDate ?? null, JSON.stringify(s.resources)])
      await refreshJourneyStatus(pool, schema, id)
      auditLogOnboarding(schema, request.user.sub, 'onboarding.step.added', r.rows[0]!.id,
        { journeyId: id, title: s.title }, request.ip ?? null)
      return reply.status(201).send({ data: { id: r.rows[0]!.id } })
    },
  })

  // PATCH /onboarding/steps/:id — kanban (statut), planification, contenu
  fastify.patch('/steps/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager')],
    schema: { tags: ['onboarding'], summary: 'Modifier une étape (kanban / planification)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = patchStepSchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Étape invalide' })
      const b = parsed.data
      const schema = request.user.schemaName

      const step = await pool.query<{ id: string; journey_id: string }>(
        `SELECT id, journey_id FROM "${schema}".onboarding_steps WHERE id = $1 LIMIT 1`, [id])
      if (!step.rows[0]) return reply.status(404).send({ error: 'Étape introuvable' })
      const journeyId = step.rows[0].journey_id

      // OWASP A01 — manager : avancement uniquement, sur son équipe
      if (request.user.role === 'manager') {
        if (!(await managerOwnsJourney(schema, request.user.email, journeyId))) {
          return reply.status(403).send({ error: 'Accès limité à votre équipe' })
        }
        const allowed = new Set(['status', 'notes'])
        if (Object.keys(b).some((k) => !allowed.has(k))) {
          return reply.status(403).send({ error: 'Un manager ne peut modifier que le statut et les notes' })
        }
      }

      const sets: string[] = []
      const vals: unknown[] = []
      let i = 1
      if (b.title !== undefined)       { sets.push(`title = $${i++}`); vals.push(b.title) }
      if (b.description !== undefined) { sets.push(`description = $${i++}`); vals.push(b.description ?? null) }
      if (b.phase !== undefined)       { sets.push(`phase = $${i++}`); vals.push(b.phase) }
      if (b.ownerRole !== undefined)   { sets.push(`owner_role = $${i++}`); vals.push(b.ownerRole) }
      if (b.dueDate !== undefined)     { sets.push(`due_date = $${i++}`); vals.push(b.dueDate) }
      if (b.sortOrder !== undefined)   { sets.push(`sort_order = $${i++}`); vals.push(b.sortOrder) }
      if (b.notes !== undefined)       { sets.push(`notes = $${i++}`); vals.push(b.notes) }
      if (b.resources !== undefined)   { sets.push(`resources = $${i++}`); vals.push(JSON.stringify(b.resources)) }
      if (b.status !== undefined) {
        sets.push(`status = $${i++}`); vals.push(b.status)
        if (b.status === 'done') {
          sets.push(`completed_at = now()`)
          sets.push(`completed_by = $${i++}`); vals.push(request.user.sub)
        } else {
          sets.push(`completed_at = NULL`, `completed_by = NULL`)
        }
      }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ à modifier' })
      sets.push(`updated_at = now()`)
      vals.push(id)
      await pool.query(`UPDATE "${schema}".onboarding_steps SET ${sets.join(', ')} WHERE id = $${i}`, vals)

      if (b.status !== undefined) await refreshJourneyStatus(pool, schema, journeyId)
      auditLogOnboarding(schema, request.user.sub, 'onboarding.step.updated', id,
        { fields: Object.keys(b) }, request.ip ?? null)
      return reply.send({ data: { id, updated: true } })
    },
  })

  // DELETE /onboarding/steps/:id
  fastify.delete('/steps/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['onboarding'], summary: 'Supprimer une étape' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const schema = request.user.schemaName
      const r = await pool.query<{ journey_id: string }>(
        `DELETE FROM "${schema}".onboarding_steps WHERE id = $1 RETURNING journey_id`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Étape introuvable' })
      await refreshJourneyStatus(pool, schema, r.rows[0].journey_id)
      auditLogOnboarding(schema, request.user.sub, 'onboarding.step.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id, deleted: true } })
    },
  })

  // ─── SELF-SERVICE COLLABORATEUR ────────────────────────────────────────────

  // GET /onboarding/my-journey — le parcours du collaborateur connecté
  fastify.get('/my-journey', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['onboarding'], summary: 'Mon parcours d\'intégration' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const employeeId = await currentEmployeeId(schema, request.user)
      if (!employeeId) return reply.send({ data: null })
      const j = await pool.query(
        `SELECT j.*, e.first_name, e.last_name, e.job_title, e.hire_date,
                m.first_name AS manager_first_name, m.last_name AS manager_last_name
         FROM "${schema}".onboarding_journeys j
         JOIN "${schema}".employees e ON e.id = j.employee_id
         LEFT JOIN "${schema}".employees m ON m.id = e.manager_id
         WHERE j.employee_id = $1 AND j.status <> 'cancelled'
         ORDER BY j.started_at DESC LIMIT 1`, [employeeId])
      if (!j.rows[0]) return reply.send({ data: null })
      const steps = await pool.query(
        `SELECT * FROM "${schema}".onboarding_steps WHERE journey_id = $1
         ORDER BY sort_order ASC, due_date ASC NULLS LAST, created_at ASC`, [j.rows[0].id])
      return reply.send({ data: { ...j.rows[0], steps: steps.rows } })
    },
  })

  // PATCH /onboarding/my-steps/:id — le collaborateur coche SES étapes
  fastify.patch('/my-steps/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['onboarding'], summary: 'Avancer une de mes étapes d\'intégration' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = z.object({ status: z.enum(ONBOARDING_STEP_STATUSES) }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'status invalide' })
      const schema = request.user.schemaName
      const employeeId = await currentEmployeeId(schema, request.user)
      if (!employeeId) return reply.status(403).send({ error: 'Aucun dossier employé associé' })

      // OWASP A01 (IDOR) — l'étape doit appartenir au parcours du collaborateur
      // ET lui être assignée (owner_role = 'employee').
      const step = await pool.query<{ id: string; journey_id: string }>(
        `SELECT s.id, s.journey_id
         FROM "${schema}".onboarding_steps s
         JOIN "${schema}".onboarding_journeys j ON j.id = s.journey_id
         WHERE s.id = $1 AND j.employee_id = $2 AND s.owner_role = 'employee' LIMIT 1`,
        [id, employeeId])
      if (!step.rows[0]) {
        return reply.status(403).send({ error: 'Étape non modifiable (réservée aux RH ou hors de votre parcours)' })
      }
      const done = parsed.data.status === 'done'
      await pool.query(
        `UPDATE "${schema}".onboarding_steps
         SET status = $2, completed_at = ${done ? 'now()' : 'NULL'},
             completed_by = ${done ? '$3' : 'NULL'}, updated_at = now()
         WHERE id = $1`,
        done ? [id, parsed.data.status, request.user.sub] : [id, parsed.data.status])
      await refreshJourneyStatus(pool, schema, step.rows[0].journey_id)
      auditLogOnboarding(schema, request.user.sub, 'onboarding.step.self_updated', id,
        { status: parsed.data.status }, request.ip ?? null)
      return reply.send({ data: { id, status: parsed.data.status } })
    },
  })
}

export default onboardingRoutes
