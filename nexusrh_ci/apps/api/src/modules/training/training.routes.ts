import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { z } from 'zod'
import { config } from '../../config.js'

const pool = new Pool({ connectionString: config.database.url })
const rawPool = pool

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// OWASP A03 — schemas Zod pour les routes mutantes
const createTrainingSchema = z.object({
  title:              z.string().min(1).max(200).trim(),
  description:        z.string().max(5000).optional(),
  duration:           z.number().int().min(0).max(10_000).optional(),
  duration_unit:      z.enum(['hours', 'days', 'weeks', 'months']).optional(),
  format:             z.enum(['presentiel', 'distanciel', 'hybride']).optional(),
  category:           z.string().max(100).optional(),
  is_fdfp_eligible:   z.boolean().optional(),
  fdfp_code:          z.string().max(50).optional(),
  max_participants:   z.number().int().min(1).max(500).optional(),
}).strict()

const createSessionSchema = z.object({
  training_id:  z.string().uuid(),
  start_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Format date YYYY-MM-DD requis'),
  end_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  location:     z.string().max(200).optional(),
  trainer:      z.string().max(200).optional(),
  max_places:   z.number().int().min(1).max(500).optional(),
  // À la planification, les RH désignent directement les employés à inscrire.
  employee_ids: z.array(z.string().uuid()).max(500).optional(),
}).strict()

// L'inscription est désormais une action RH/manager : employee_id OBLIGATOIRE
// (plus d'auto-inscription par l'employé — cf. authorize sur la route).
const enrollSchema = z.object({
  session_id:   z.string().uuid(),
  employee_id:  z.string().uuid(),
}).strict()

const participantsSchema = z.object({
  employee_ids: z.array(z.string().uuid()).min(1).max(500),
}).strict()

// OWASP A04 — bornes anti-fraude : 1 formation pro CI dépasse rarement 5M FCFA
// par session entière. 50M est un cap "sanity check" qui bloque les 999999999.
const FDFP_TOTAL_MAX = 50_000_000
const FDFP_EMPLOYEES_MAX = 1000
const fdfpRequestSchema = z.object({
  training_title:   z.string().min(1).max(200).trim(),
  training_id:      z.string().uuid().optional(),
  session_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Format date YYYY-MM-DD requis'),
  employees_count:  z.number().int().min(1).max(FDFP_EMPLOYEES_MAX),
  total_cost:       z.number().int().min(0).max(FDFP_TOTAL_MAX),
  provider_name:    z.string().min(1).max(200).trim(),
  fdfp_code:        z.string().max(50).optional(),
}).strict()

function auditLogTraining(
  schema: string, userId: string, action: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'training', $3, $4, $5)`,
    [userId, action, entityId, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

interface BulkEnrollResult {
  ok: boolean
  reason?: 'session_not_found'
  added: number
  skippedDuplicates: number
  skippedFull: number
  skippedInvalid: number
}

// Inscrit en masse des employés SÉLECTIONNÉS à une session (action RH). Réutilisé
// par la planification de session ET l'ajout de participants à une session
// existante. Sûr : ne garde que les employee_ids appartenant au tenant (OWASP A01
// IDOR — pas d'inscription d'un id forgé hors tenant), respecte les places et la
// non-duplication. `schema` provient du JWT validé (plugins/auth — OWASP A03).
async function enrollEmployeesBulk(
  schema: string, sessionId: string, employeeIds: string[],
  actorId: string, ip: string | null,
): Promise<BulkEnrollResult> {
  const unique = [...new Set(employeeIds)]
  const result: BulkEnrollResult = { ok: true, added: 0, skippedDuplicates: 0, skippedFull: 0, skippedInvalid: 0 }

  const cap = await pool.query<{ max_places: number; enrolled: number }>(`
    SELECT ts.max_places, COUNT(te.id)::int AS enrolled
    FROM "${schema}".training_sessions ts
    LEFT JOIN "${schema}".training_enrollments te ON te.session_id = ts.id
    WHERE ts.id = $1 GROUP BY ts.id
  `, [sessionId])
  if (!cap.rows[0]) return { ...result, ok: false, reason: 'session_not_found' }
  const maxPlaces = cap.rows[0].max_places
  let enrolled = cap.rows[0].enrolled

  // OWASP A01 — ne conserver que les employés réels du tenant.
  const valid = await pool.query<{ id: string }>(
    `SELECT id FROM "${schema}".employees WHERE id = ANY($1::uuid[]) AND is_active = true`, [unique],
  )
  const validSet = new Set(valid.rows.map((r) => r.id))

  const existing = await pool.query<{ employee_id: string }>(
    `SELECT employee_id FROM "${schema}".training_enrollments WHERE session_id = $1`, [sessionId],
  )
  const existingSet = new Set(existing.rows.map((r) => r.employee_id))

  const added: string[] = []
  for (const empId of unique) {
    if (!validSet.has(empId)) { result.skippedInvalid++; continue }
    if (existingSet.has(empId)) { result.skippedDuplicates++; continue }
    if (enrolled >= maxPlaces) { result.skippedFull++; continue }
    const r = await pool.query<{ id: string }>(`
      INSERT INTO "${schema}".training_enrollments (session_id, employee_id, status)
      VALUES ($1,$2,'enrolled') RETURNING id
    `, [sessionId, empId])
    if (r.rows[0]) { added.push(empId); enrolled++ }
  }
  result.added = added.length
  if (added.length) {
    auditLogTraining(schema, actorId, 'training.participants_added', sessionId,
      { count: added.length, employeeIds: added }, ip)
  }
  return result
}

const trainingRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /training/catalog
  fastify.get('/catalog', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { is_fdfp_eligible, category } = request.query as Record<string, string>
      let sql = `SELECT t.*,
                   COUNT(DISTINCT ts.id)::int AS sessions_count,
                   COUNT(DISTINCT te.id)::int AS enrollments_count
                 FROM "${schema}".trainings t
                 LEFT JOIN "${schema}".training_sessions ts ON ts.training_id = t.id AND ts.status = 'planned'
                 LEFT JOIN "${schema}".training_enrollments te ON te.session_id = ts.id
                 WHERE t.is_active = true`
      const params: unknown[] = []
      let idx = 1
      if (is_fdfp_eligible === 'true') sql += ` AND t.is_fdfp_eligible = true`
      if (category) { sql += ` AND t.category = $${idx++}`; params.push(category) }
      sql += ` GROUP BY t.id ORDER BY t.title`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/catalog
  fastify.post('/catalog', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 : validation Zod stricte
      const parsed = createTrainingSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données de formation invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".trainings
            (title, description, duration, duration_unit, format, category,
             is_fdfp_eligible, fdfp_code, max_participants)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
        `, [body.title, body.description ?? null,
            body.duration ?? null, body.duration_unit ?? 'hours',
            body.format ?? 'presentiel', body.category ?? null,
            body.is_fdfp_eligible ?? false, body.fdfp_code ?? null,
            body.max_participants ?? null])
        auditLogTraining(schema, request.user.sub, 'training.created', res.rows[0].id, {
          title: body.title, category: body.category ?? null, isFdfp: body.is_fdfp_eligible ?? false,
        }, request.ip ?? null)
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /training/sessions
  fastify.get('/sessions', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { status, training_id } = request.query as Record<string, string>
      let sql = `SELECT ts.*, t.title AS training_title, t.duration, t.duration_unit,
                   t.is_fdfp_eligible, t.category, t.format,
                   COUNT(te.id)::int AS enrolled_count
                 FROM "${schema}".training_sessions ts
                 JOIN "${schema}".trainings t ON t.id = ts.training_id
                 LEFT JOIN "${schema}".training_enrollments te ON te.session_id = ts.id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (status)      { sql += ` AND ts.status = $${idx++}`; params.push(status) }
      if (training_id) { sql += ` AND ts.training_id = $${idx++}`; params.push(training_id) }
      sql += ` GROUP BY ts.id, t.id ORDER BY ts.start_date DESC`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/sessions
  fastify.post('/sessions', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = createSessionSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données de session invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".training_sessions
            (training_id, start_date, end_date, location, trainer, status, max_places)
          VALUES ($1,$2,$3,$4,$5,'planned',$6) RETURNING *
        `, [body.training_id, body.start_date, body.end_date ?? null,
            body.location ?? null, body.trainer ?? null,
            body.max_places ?? 20])
        const session = res.rows[0]
        auditLogTraining(schema, request.user.sub, 'training.session_created', session.id, {
          trainingId: body.training_id, startDate: body.start_date, maxPlaces: body.max_places ?? 20,
        }, request.ip ?? null)

        // À la planification : inscrit directement les employés sélectionnés.
        let enrollment: BulkEnrollResult | undefined
        if (body.employee_ids && body.employee_ids.length > 0) {
          enrollment = await enrollEmployeesBulk(
            schema, session.id, body.employee_ids, request.user.sub, request.ip ?? null)
        }
        return reply.status(201).send({ data: session, enrollment })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/sessions/:id/participants — ajoute des employés sélectionnés
  // à une session existante (action RH). Remplace l'auto-inscription employé.
  fastify.post('/sessions/:id/participants', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id session invalide (UUID requis)' })
      const parsed = participantsSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Liste de participants invalide',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      try {
        const r = await enrollEmployeesBulk(schema, id, parsed.data.employee_ids, request.user.sub, request.ip ?? null)
        if (!r.ok) return reply.status(404).send({ error: 'Session introuvable' })
        return reply.status(201).send({ data: r })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /training/enrollments
  fastify.get('/enrollments', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { session_id, employee_id } = request.query as Record<string, string>
      // OWASP A03 : validation UUID query params (évite injection même bindée)
      if (session_id && !UUID_RE.test(session_id)) {
        return reply.status(400).send({ error: 'session_id invalide (UUID requis)' })
      }
      if (employee_id && !UUID_RE.test(employee_id)) {
        return reply.status(400).send({ error: 'employee_id invalide (UUID requis)' })
      }
      let sql = `SELECT te.*,
                   e.first_name, e.last_name,
                   ts.start_date AS session_start, ts.location,
                   t.title AS training_title, t.is_fdfp_eligible, t.category
                 FROM "${schema}".training_enrollments te
                 JOIN "${schema}".employees e ON e.id = te.employee_id
                 JOIN "${schema}".training_sessions ts ON ts.id = te.session_id
                 JOIN "${schema}".trainings t ON t.id = ts.training_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (session_id)  { sql += ` AND te.session_id = $${idx++}`; params.push(session_id) }
      if (employee_id) { sql += ` AND te.employee_id = $${idx++}`; params.push(employee_id) }
      sql += ` ORDER BY te.created_at DESC`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/enroll
  // L'inscription est une action RH/manager : les employés NE s'inscrivent PLUS
  // eux-mêmes (les RH désignent les participants à la planification ou via
  // /sessions/:id/participants). 'employee' et 'readonly' sont exclus.
  fastify.post('/enroll', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 : validation Zod stricte (UUIDs, employee_id obligatoire)
      const parsed = enrollSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données d\'inscription invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      try {
        const employeeId = body.employee_id
        if (request.user.role === 'manager') {
          // OWASP A01 — un manager ne peut inscrire QUE son équipe directe
          const team = await pool.query(
            `SELECT 1 FROM "${schema}".employees e
               JOIN "${schema}".employees m ON m.id = e.manager_id
              WHERE e.id = $1 AND m.email = $2 LIMIT 1`,
            [employeeId, request.user.email],
          )
          if (!team.rows[0]) {
            return reply.status(403).send({ error: 'Vous ne pouvez inscrire que les membres de votre équipe directe' })
          }
        }
        // admin/hr_manager/hr_officer : inscription de tout employé (fonction admin formation)
        // OWASP A04 : empêche l'inscription multiple à la même session (anti spam)
        const duplicate = await pool.query(
          `SELECT id FROM "${schema}".training_enrollments
            WHERE session_id = $1 AND employee_id = $2 LIMIT 1`,
          [body.session_id, employeeId],
        )
        if (duplicate.rows[0]) {
          return reply.status(409).send({ error: 'Cet employé est déjà inscrit à cette session' })
        }
        // Vérifier places
        const session = await pool.query(`
          SELECT ts.max_places, COUNT(te.id)::int AS enrolled
          FROM "${schema}".training_sessions ts
          LEFT JOIN "${schema}".training_enrollments te ON te.session_id = ts.id
          WHERE ts.id = $1 GROUP BY ts.id
        `, [body.session_id])
        if (!session.rows[0]) return reply.status(404).send({ error: 'Session introuvable' })
        if (session.rows[0].enrolled >= session.rows[0].max_places) {
          return reply.status(400).send({ error: 'Session complète' })
        }
        const res = await pool.query(`
          INSERT INTO "${schema}".training_enrollments (session_id, employee_id, status)
          VALUES ($1,$2,'enrolled') RETURNING *
        `, [body.session_id, employeeId])
        auditLogTraining(schema, request.user.sub, 'training.enrolled', res.rows[0].id, {
          sessionId: body.session_id, employeeId, bySelf: request.user.role === 'employee',
        }, request.ip ?? null)
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /training/my-enrollments
  fastify.get('/my-enrollments', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        let employeeId = request.user.employeeId
        if (!employeeId) {
          const emp = await pool.query(
            `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
          )
          if (!emp.rows[0]) return reply.send({ data: [] })
          employeeId = emp.rows[0].id as string
        }
        const res = await pool.query(`
          SELECT te.*,
            ts.start_date AS session_start, ts.end_date AS session_end,
            ts.location, ts.trainer,
            t.title AS training_title, t.duration, t.duration_unit,
            t.category, t.is_fdfp_eligible, t.format
          FROM "${schema}".training_enrollments te
          JOIN "${schema}".training_sessions ts ON ts.id = te.session_id
          JOIN "${schema}".trainings t ON t.id = ts.training_id
          WHERE te.employee_id = $1
          ORDER BY ts.start_date DESC
        `, [employeeId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/fdfp/request — demande remboursement FDFP
  // OWASP A04 anti-fraude : montants bornés (total ≤ 50M FCFA, ≤ 1000 employés).
  // OWASP A07 : rate-limit modeste (action financière sensible, on tolère un
  // burst raisonnable mais on bloque le spam).
  fastify.post('/fdfp/request', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['training'], summary: 'Soumettre demande remboursement FDFP CI' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 + A04 : validation Zod stricte, bornes anti-fraude
      const parsed = fdfpRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Demande FDFP invalide',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      const estimated_refund = Math.floor(body.total_cost * 0.5)
      const insertRes = await rawPool.query(
        `INSERT INTO "${schema}".hr_events
           (type, title, description, date, metadata, created_by)
         VALUES ('fdfp_request','Demande remboursement FDFP',$1,$2,$3,$4)
         RETURNING id`,
        [
          `Formation : ${body.training_title} · Organisme : ${body.provider_name}`,
          body.session_date,
          JSON.stringify({
            training_title: body.training_title,
            training_id: body.training_id ?? null,
            session_date: body.session_date,
            employees_count: body.employees_count,
            total_cost: body.total_cost,
            provider_name: body.provider_name,
            fdfp_code: body.fdfp_code ?? null,
            estimated_refund, currency: 'XOF',
            status: 'pending_validation',
          }),
          request.user.sub,
        ]
      )
      // OWASP A09 : trace de la demande financière (vol potentiel via fraude FDFP)
      auditLogTraining(schema, request.user.sub, 'training.fdfp_requested', insertRes.rows[0]?.id ?? null, {
        trainingTitle: body.training_title,
        providerName: body.provider_name,
        totalCost: body.total_cost,
        employeesCount: body.employees_count,
        estimatedRefund: estimated_refund,
      }, request.ip ?? null)

      return reply.status(201).send({
        message: 'Demande FDFP enregistrée',
        data: {
          training_title: body.training_title,
          session_date: body.session_date,
          employees_count: body.employees_count,
          total_cost: body.total_cost,
          estimated_refund,
          fdfp_code: body.fdfp_code ?? null,
          status: 'pending_validation', currency: 'XOF',
        },
      })
    },
  })

  // GET /training/fdfp/eligible — liste formations agréées FDFP
  fastify.get('/fdfp/eligible', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['training'], summary: 'Formations éligibles remboursement FDFP' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT t.*, COUNT(ts.id)::int AS sessions_count
         FROM "${schema}".trainings t
         LEFT JOIN "${schema}".training_sessions ts ON ts.training_id = t.id
         WHERE t.is_fdfp_eligible = true AND t.is_active = true
         GROUP BY t.id ORDER BY t.title`
      )
      return reply.send({ data: res.rows })
    },
  })
}

export default trainingRoutes
