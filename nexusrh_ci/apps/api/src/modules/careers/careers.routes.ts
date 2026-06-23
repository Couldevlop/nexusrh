import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// OWASP A03 — schemas Zod
const createSkillSchema = z.object({
  name:     z.string().min(1).max(200).trim(),
  category: z.string().max(100).optional(),
}).strict()

const upsertEmployeeSkillsSchema = z.object({
  employee_id: z.string().uuid(),
  skills:      z.array(z.object({
    skill_id:     z.string().uuid(),
    level:        z.number().int().min(0).max(5),
    target_level: z.number().int().min(0).max(5).optional(),
  })).min(1).max(200),
}).strict()

const createEvaluationSchema = z.object({
  employee_id:       z.string().uuid(),
  // Inclut trial_end (fin d'essai) et exit (entretien de sortie) proposés par
  // l'UI — sinon ces choix renvoyaient un 400 à la création de l'entretien.
  type:              z.enum(['annual', 'mid_year', 'probation', '360', 'manager_review', 'trial_end', 'exit']).optional(),
  // coerce : le champ année du formulaire est une chaîne ("2026").
  year:              z.coerce.number().int().min(2000).max(2100).optional(),
  period:            z.string().max(50).optional(),
  global_score:      z.number().int().min(0).max(100).optional(),
  performance_score: z.number().int().min(0).max(100).optional(),
  goals_score:       z.number().int().min(0).max(100).optional(),
  skills_score:      z.number().int().min(0).max(100).optional(),
  comments:          z.string().max(5000).optional(),
  goals:             z.array(z.string().max(500)).max(50).optional(),
  strengths:         z.array(z.string().max(500)).max(50).optional(),
  improvements:      z.array(z.string().max(500)).max(50).optional(),
  training_needs:    z.array(z.string().max(500)).max(50).optional(),
}).strict()

const patchEvaluationSchema = z.object({
  global_score:        z.number().int().min(0).max(100).optional(),
  performance_score:   z.number().int().min(0).max(100).optional(),
  goals_score:         z.number().int().min(0).max(100).optional(),
  skills_score:        z.number().int().min(0).max(100).optional(),
  comments:            z.string().max(5000).optional(),
  manager_comments:    z.string().max(5000).optional(),
  employee_comments:   z.string().max(5000).optional(),
  status:              z.enum(['draft', 'in_progress', 'pending_signature', 'completed', 'cancelled']).optional(),
  signed_by_employee:  z.boolean().optional(),
  signed_by_manager:   z.boolean().optional(),
  goals:               z.array(z.string().max(500)).max(50).optional(),
  strengths:           z.array(z.string().max(500)).max(50).optional(),
  improvements:        z.array(z.string().max(500)).max(50).optional(),
  training_needs:      z.array(z.string().max(500)).max(50).optional(),
}).strict()

/**
 * OWASP A01 — vérifie qu'un manager a le droit d'agir sur l'employé cible
 * (manager direct uniquement). Retourne true pour admin/hr_*, false sinon.
 */
async function userCanActOnEmployee(
  schema: string, role: string, requesterEmail: string, targetEmployeeId: string,
): Promise<boolean> {
  if (role === 'admin' || role === 'hr_manager' || role === 'hr_officer') return true
  if (role !== 'manager') return false
  const r = await pool.query<{ id: string }>(
    `SELECT e.id FROM "${schema}".employees e
       JOIN "${schema}".employees m ON m.id = e.manager_id
      WHERE e.id = $1 AND m.email = $2 LIMIT 1`,
    [targetEmployeeId, requesterEmail],
  )
  return r.rows.length > 0
}

/**
 * OWASP A01 — pour les routes self-service / lecture compétences. Un employé
 * peut voir SES données ; un manager celles de son équipe directe ; les RH/admin
 * partout. Renvoie l'employé connecté (lookup email/JWT) ou null.
 */
async function isOwnEmployeeRecord(
  schema: string, requesterEmail: string, targetEmployeeId: string,
): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM "${schema}".employees WHERE id = $1 AND email = $2 LIMIT 1`,
    [targetEmployeeId, requesterEmail],
  )
  return r.rows.length > 0
}

function auditLogCareer(
  schema: string, userId: string, action: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'career', $3, $4, $5)`,
    [userId, action, entityId, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

const careersRoutes: FastifyPluginAsync = async (fastify) => {
  // Migration lazy (idempotente) : garantit les colonnes ajoutées tardivement
  // (evaluations.manager_comments/employee_comments, employee_skills.target_level…)
  // pour ne pas renvoyer de 500 sur un tenant provisionné avant ces colonnes.
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /careers/skills
  fastify.get('/skills', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(
          `SELECT * FROM "${schema}".career_skills WHERE is_active = true ORDER BY category, name`
        )
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /careers/skills
  fastify.post('/skills', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = createSkillSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Compétence invalide',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      try {
        const res = await pool.query(
          `INSERT INTO "${schema}".career_skills (name, category) VALUES ($1,$2) RETURNING *`,
          [parsed.data.name, parsed.data.category ?? null]
        )
        auditLogCareer(schema, request.user.sub, 'career.skill_created', res.rows[0].id, {
          name: parsed.data.name, category: parsed.data.category ?? null,
        }, request.ip ?? null)
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/employee-skills/:employeeId
  fastify.get('/employee-skills/:employeeId', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      if (!UUID_RE.test(employeeId)) {
        return reply.status(400).send({ error: 'employeeId invalide (UUID requis)' })
      }
      // OWASP A01 : un employee ne voit QUE ses propres compétences ; un manager
      // celles de son équipe directe ; admin/hr_* partout.
      const role = request.user.role
      if (role === 'employee') {
        const own = await isOwnEmployeeRecord(schema, request.user.email, employeeId)
        if (!own) return reply.status(403).send({ error: 'Accès interdit' })
      } else if (role === 'manager') {
        const allowed = await userCanActOnEmployee(schema, role, request.user.email, employeeId)
        if (!allowed) return reply.status(403).send({ error: 'Vous ne pouvez consulter que les compétences de votre équipe directe' })
      }
      try {
        const res = await pool.query(`
          SELECT es.*, cs.name AS skill_name, cs.category
          FROM "${schema}".employee_skills es
          JOIN "${schema}".career_skills cs ON cs.id = es.skill_id
          WHERE es.employee_id = $1
          ORDER BY cs.category, cs.name
        `, [employeeId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PUT /careers/employee-skills
  fastify.put('/employee-skills', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = upsertEmployeeSkillsSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données compétences invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      // OWASP A01 : un manager ne peut modifier que les compétences de son équipe
      const allowed = await userCanActOnEmployee(schema, request.user.role, request.user.email, body.employee_id)
      if (!allowed) {
        return reply.status(403).send({ error: 'Vous ne pouvez modifier que les compétences de votre équipe directe' })
      }
      try {
        for (const skill of body.skills) {
          await pool.query(`
            INSERT INTO "${schema}".employee_skills (employee_id, skill_id, level, target_level, updated_at)
            VALUES ($1,$2,$3,$4,now())
            ON CONFLICT (employee_id, skill_id) DO UPDATE
            SET level = $3, target_level = $4, updated_at = now()
          `, [body.employee_id, skill.skill_id, skill.level, skill.target_level ?? null])
        }
        auditLogCareer(schema, request.user.sub, 'career.skills_updated', body.employee_id, {
          skillsCount: body.skills.length,
        }, request.ip ?? null)
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/evaluations
  fastify.get('/evaluations', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employee_id, year, status } = request.query as Record<string, string>
      let sql = `SELECT ev.*, e.first_name, e.last_name, e.job_title,
                   ev2.first_name AS evaluator_first_name, ev2.last_name AS evaluator_last_name
                 FROM "${schema}".evaluations ev
                 JOIN "${schema}".employees e ON e.id = ev.employee_id
                 LEFT JOIN "${schema}".employees ev2 ON ev2.id = ev.evaluator_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (request.user.role === 'manager') {
        const mgr = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        if (mgr.rows[0]) { sql += ` AND e.manager_id = $${idx++}`; params.push(mgr.rows[0].id) }
      }
      if (employee_id) { sql += ` AND ev.employee_id = $${idx++}`; params.push(employee_id) }
      if (year)        { sql += ` AND ev.year = $${idx++}`; params.push(parseInt(year)) }
      if (status)      { sql += ` AND ev.status = $${idx++}`; params.push(status) }
      sql += ` ORDER BY ev.year DESC, ev.created_at DESC`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /careers/evaluations
  fastify.post('/evaluations', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 : Zod strict (rejette champs hors whitelist, scores bornés 0-100)
      const parsed = createEvaluationSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Évaluation invalide',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      // OWASP A01 : un manager ne peut évaluer que son équipe directe
      const allowed = await userCanActOnEmployee(schema, request.user.role, request.user.email, body.employee_id)
      if (!allowed) {
        return reply.status(403).send({ error: 'Vous ne pouvez évaluer que votre équipe directe' })
      }
      try {
        const evaluatorRes = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        const evaluatorId = evaluatorRes.rows[0]?.id || null
        const res = await pool.query(`
          INSERT INTO "${schema}".evaluations
            (employee_id, evaluator_id, type, year, period, status,
             global_score, performance_score, goals_score, skills_score,
             comments, goals, strengths, improvements, training_needs)
          VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14)
          RETURNING *
        `, [
          body.employee_id, evaluatorId,
          body.type ?? 'annual', body.year ?? new Date().getFullYear(),
          body.period ?? null,
          body.global_score ?? null, body.performance_score ?? null,
          body.goals_score ?? null, body.skills_score ?? null,
          body.comments ?? null,
          JSON.stringify(body.goals ?? []),
          JSON.stringify(body.strengths ?? []),
          JSON.stringify(body.improvements ?? []),
          JSON.stringify(body.training_needs ?? []),
        ])
        auditLogCareer(schema, request.user.sub, 'career.evaluation_created', res.rows[0].id, {
          employeeId: body.employee_id, type: body.type ?? 'annual', year: body.year ?? new Date().getFullYear(),
        }, request.ip ?? null)
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /careers/evaluations/:id
  fastify.patch('/evaluations/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const parsed = patchEvaluationSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Modification invalide',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      // OWASP A01 : un manager ne peut modifier que les évaluations de son équipe.
      // On lit d'abord l'employee_id de l'évaluation pour la vérification.
      if (request.user.role === 'manager') {
        const target = await pool.query<{ employee_id: string }>(
          `SELECT employee_id FROM "${schema}".evaluations WHERE id = $1 LIMIT 1`, [id],
        )
        if (!target.rows[0]) return reply.status(404).send({ error: 'Évaluation introuvable' })
        const allowed = await userCanActOnEmployee(schema, 'manager', request.user.email, target.rows[0].employee_id)
        if (!allowed) {
          return reply.status(403).send({ error: 'Vous ne pouvez modifier que les évaluations de votre équipe directe' })
        }
      }
      const scalarFields = [
        'global_score','performance_score','goals_score','skills_score',
        'comments','manager_comments','employee_comments','status',
        'signed_by_employee','signed_by_manager',
      ] as const
      const jsonFields = ['goals','strengths','improvements','training_needs'] as const
      const updates: string[] = []
      const values: unknown[] = []
      const modifiedFields: string[] = []
      const b = body as Record<string, unknown>
      for (const f of scalarFields) {
        if (f in b) { updates.push(`${f} = $${values.length + 1}`); values.push(b[f]); modifiedFields.push(f) }
      }
      for (const f of jsonFields) {
        if (f in b) { updates.push(`${f} = $${values.length + 1}`); values.push(JSON.stringify(b[f])); modifiedFields.push(f) }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      if (body.status === 'completed') updates.push(`completed_at = now()`)
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".evaluations SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Évaluation introuvable' })
        auditLogCareer(schema, request.user.sub, 'career.evaluation_updated', id, {
          modifiedFields,
          newStatus: body.status ?? null,
        }, request.ip ?? null)
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/my-evaluations — entretiens de l'employé connecté
  fastify.get('/my-evaluations', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const empRes = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE user_id = $1
           UNION SELECT id FROM "${schema}".employees WHERE email = $2
           LIMIT 1`,
          [request.user.sub, request.user.email]
        )
        const empId = empRes.rows[0]?.id
        if (!empId) return reply.send({ data: [] })

        const res = await pool.query(`
          SELECT ev.id, ev.type, ev.year, ev.status,
                 ev.global_score, ev.performance_score, ev.skills_score,
                 ev.comments AS notes, ev.manager_comments, ev.created_at, ev.completed_at,
                 e2.first_name AS evaluator_first_name,
                 e2.last_name  AS evaluator_last_name
          FROM "${schema}".evaluations ev
          LEFT JOIN "${schema}".employees e2 ON e2.id = ev.evaluator_id
          WHERE ev.employee_id = $1
          ORDER BY ev.year DESC, ev.created_at DESC
        `, [empId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/my-skills — compétences de l'employé connecté
  fastify.get('/my-skills', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const empRes = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE user_id = $1
           UNION SELECT id FROM "${schema}".employees WHERE email = $2
           LIMIT 1`,
          [request.user.sub, request.user.email]
        )
        const empId = empRes.rows[0]?.id
        if (!empId) return reply.send({ data: [] })

        const res = await pool.query(`
          SELECT es.level, es.target_level,
                 cs.name AS skill_name, cs.category
          FROM "${schema}".employee_skills es
          JOIN "${schema}".career_skills cs ON cs.id = es.skill_id
          WHERE es.employee_id = $1
          ORDER BY cs.category NULLS LAST, cs.name
        `, [empId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/nine-box
  fastify.get('/nine-box', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { year = String(new Date().getFullYear()) } = request.query as Record<string, string>
      try {
        const res = await pool.query(`
          SELECT e.id, e.first_name, e.last_name, e.job_title, d.name AS department,
            ev.global_score AS performance, ev.skills_score AS potential,
            e.retention_score
          FROM "${schema}".employees e
          JOIN "${schema}".evaluations ev ON ev.employee_id = e.id
            AND ev.year = $1 AND ev.type = 'annual' AND ev.status = 'completed'
          LEFT JOIN "${schema}".departments d ON d.id = e.department_id
          WHERE e.is_active = true AND e.deleted_at IS NULL
          ORDER BY ev.global_score DESC NULLS LAST
        `, [parseInt(year)])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default careersRoutes
