import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { renderAttestationPdf } from './training-attestation-pdf.js'

const rawPool = pool

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// OWASP A03 — schemas Zod pour les routes mutantes
const createTrainingSchema = z.object({
  title:              z.string().min(1).max(200).trim(),
  description:        z.string().max(5000).optional(),
  duration:           z.number().int().min(0).max(10_000).optional(),
  duration_unit:      z.enum(['hours', 'days', 'weeks', 'months']).optional(),
  format:             z.enum(['presentiel', 'distanciel', 'hybride', 'e-learning']).optional(),
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

// Inscription RH/manager : employee_id OBLIGATOIRE (les RH désignent un employé).
const enrollSchema = z.object({
  session_id:   z.string().uuid(),
  employee_id:  z.string().uuid(),
}).strict()

// Auto-inscription self-service (rôle employee) : SEUL session_id est accepté.
// L'employee_id est TOUJOURS dérivé du token (OWASP A01 — jamais de confiance
// dans un employee_id fourni par un employee).
const selfEnrollSchema = z.object({
  session_id:   z.string().uuid(),
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
  // Le formulaire peut envoyer une chaîne vide quand aucune formation du
  // catalogue n'est liée : on la traite comme « absente » (sinon .optional()
  // ne s'applique pas à '' et la validation échouait en 400 à chaque envoi).
  training_id:      z.preprocess((v) => (v === '' ? undefined : v), z.string().uuid().optional()),
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

// Inscrit UN employé à UNE session. Partagé par l'inscription RH/manager et
// l'auto-inscription self-service. Garde inchangées : anti-doublon (409),
// session introuvable (404), session complète (400), trace audit. `employeeId`
// est toujours résolu/validé en amont par l'appelant (token pour l'employé,
// employee_id validé pour RH ; manager : équipe directe vérifiée).
async function runEnroll(
  reply: FastifyReply, schema: string, sessionId: string, employeeId: string,
  user: { sub: string; role: string }, ip: string | null,
): Promise<FastifyReply> {
  // OWASP A04 : empêche l'inscription multiple à la même session (anti spam)
  const duplicate = await pool.query(
    `SELECT id FROM "${schema}".training_enrollments
      WHERE session_id = $1 AND employee_id = $2 LIMIT 1`,
    [sessionId, employeeId],
  )
  if (duplicate.rows[0]) {
    return reply.status(409).send({ error: 'Cet employé est déjà inscrit à cette session' })
  }
  // Vérifier places disponibles
  const session = await pool.query<{ max_places: number; enrolled: number }>(`
    SELECT ts.max_places, COUNT(te.id)::int AS enrolled
    FROM "${schema}".training_sessions ts
    LEFT JOIN "${schema}".training_enrollments te ON te.session_id = ts.id
    WHERE ts.id = $1 GROUP BY ts.id
  `, [sessionId])
  if (!session.rows[0]) return reply.status(404).send({ error: 'Session introuvable' })
  if (session.rows[0].enrolled >= session.rows[0].max_places) {
    return reply.status(400).send({ error: 'Session complète' })
  }
  const res = await pool.query<{ id: string }>(`
    INSERT INTO "${schema}".training_enrollments (session_id, employee_id, status)
    VALUES ($1,$2,'enrolled') RETURNING *
  `, [sessionId, employeeId])
  auditLogTraining(schema, user.sub, 'training.enrolled', res.rows[0]!.id, {
    sessionId, employeeId, bySelf: user.role === 'employee',
  }, ip)
  return reply.status(201).send({ data: res.rows[0] })
}

const trainingRoutes: FastifyPluginAsync = async (fastify) => {
  // Migrations lazy idempotentes du schéma tenant (ex. hr_events.employee_id
  // nullable pour les demandes FDFP niveau entreprise). Mis en cache par schéma.
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

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
  // Inscription RH/manager (désignation d'un employee_id) OU auto-inscription
  // self-service de l'employé (rôle 'employee' : employee_id IGNORÉ, dérivé du
  // token — OWASP A01). 'readonly' reste exclu.
  fastify.post('/enroll', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','employee')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        let employeeId: string
        if (request.user.role === 'employee') {
          // OWASP A01 — auto-inscription : on n'accepte QUE session_id ; l'employee_id
          // est TOUJOURS celui du token (jamais un id forgé dans le body).
          const parsed = selfEnrollSchema.safeParse(request.body)
          if (!parsed.success) {
            return reply.status(400).send({
              error: 'Données d\'inscription invalides',
              details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            })
          }
          // Résout l'employé lié au compte (employeeId du token, sinon par email).
          let selfId = request.user.employeeId
          if (!selfId) {
            const emp = await pool.query<{ id: string }>(
              `SELECT id FROM "${schema}".employees WHERE email = $1 AND is_active = true LIMIT 1`,
              [request.user.email],
            )
            if (!emp.rows[0]) {
              return reply.status(404).send({ error: 'Aucun dossier employé associé à votre compte' })
            }
            selfId = emp.rows[0].id
          }
          return await runEnroll(reply, schema, parsed.data.session_id, selfId, request.user, request.ip ?? null)
        }

        // RH/manager : validation Zod stricte (UUIDs, employee_id obligatoire)
        const parsed = enrollSchema.safeParse(request.body)
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Données d\'inscription invalides',
            details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          })
        }
        const body = parsed.data
        employeeId = body.employee_id
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
        return await runEnroll(reply, schema, body.session_id, employeeId, request.user, request.ip ?? null)
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

  // DELETE /training/enroll/:id — désinscription (FRM-006)
  // Self-service : un employee ne peut annuler QUE sa propre inscription (OWASP A01)
  // et uniquement tant qu'elle n'est pas terminée. admin/hr peuvent désinscrire.
  fastify.delete('/enroll/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','employee')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      try {
        const enr = await pool.query<{ id: string; employee_id: string; status: string }>(
          `SELECT id, employee_id, status FROM "${schema}".training_enrollments WHERE id = $1 LIMIT 1`, [id],
        )
        const row = enr.rows[0]
        if (!row) return reply.status(404).send({ error: 'Inscription introuvable' })
        // OWASP A01 — un employee ne peut annuler que SA propre inscription
        if (request.user.role === 'employee') {
          let selfId = request.user.employeeId
          if (!selfId) {
            const emp = await pool.query<{ id: string }>(
              `SELECT id FROM "${schema}".employees WHERE email = $1 AND is_active = true LIMIT 1`,
              [request.user.email],
            )
            selfId = emp.rows[0]?.id ?? null
          }
          if (!selfId || selfId !== row.employee_id) {
            return reply.status(403).send({ error: 'Vous ne pouvez annuler que vos propres inscriptions' })
          }
        }
        if (row.status === 'completed') {
          return reply.status(409).send({ error: 'Formation déjà terminée — désinscription impossible' })
        }
        await pool.query(`DELETE FROM "${schema}".training_enrollments WHERE id = $1`, [id])
        auditLogTraining(schema, request.user.sub, 'training.unenrolled', id, {
          employeeId: row.employee_id, bySelf: request.user.role === 'employee',
        }, request.ip ?? null)
        return reply.send({ data: { id, cancelled: true } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /training/enrollments/:id/attestation — attestation PDF (FRM-007)
  // Disponible quand la formation est terminée (status='completed' ou completed_at).
  // Self-service : un employee ne télécharge QUE sa propre attestation (OWASP A01).
  fastify.get('/enrollments/:id/attestation', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      try {
        const res = await pool.query<{
          status: string; completed_at: string | null; employee_id: string
          first_name: string; last_name: string; emp_email: string | null
          training_title: string; duration: number | null; duration_unit: string | null
          session_start: string | null; session_end: string | null; location: string | null; trainer: string | null
        }>(`
          SELECT te.status, te.completed_at, te.employee_id,
                 e.first_name, e.last_name, e.email AS emp_email,
                 t.title AS training_title, t.duration, t.duration_unit,
                 ts.start_date AS session_start, ts.end_date AS session_end, ts.location, ts.trainer
            FROM "${schema}".training_enrollments te
            JOIN "${schema}".training_sessions ts ON ts.id = te.session_id
            JOIN "${schema}".trainings t ON t.id = ts.training_id
            JOIN "${schema}".employees e ON e.id = te.employee_id
           WHERE te.id = $1 LIMIT 1
        `, [id])
        const row = res.rows[0]
        if (!row) return reply.status(404).send({ error: 'Inscription introuvable' })
        // OWASP A01 — un employee ne peut télécharger que SA propre attestation
        const privileged = ['admin', 'hr_manager', 'hr_officer'].includes(request.user.role)
        if (!privileged) {
          const mine = request.user.employeeId === row.employee_id ||
            (row.emp_email && row.emp_email === request.user.email)
          if (!mine) return reply.status(403).send({ error: 'Accès interdit' })
        }
        if (row.status !== 'completed' && !row.completed_at) {
          return reply.status(409).send({ error: 'Attestation indisponible : formation non terminée' })
        }
        const tenant = await pool.query<{ name: string; city: string | null }>(
          `SELECT name, city FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
        )
        const pdf = await renderAttestationPdf({
          tenantName:    tenant.rows[0]?.name ?? 'NexusRH',
          employeeName:  `${row.first_name} ${row.last_name}`.trim(),
          trainingTitle: row.training_title,
          duration:      row.duration,
          durationUnit:  row.duration_unit,
          sessionStart:  row.session_start,
          sessionEnd:    row.session_end,
          location:      row.location,
          trainer:       row.trainer,
          completedAt:   row.completed_at,
          city:          tenant.rows[0]?.city ?? null,
        })
        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `inline; filename="attestation_${id.slice(0, 8)}.pdf"`)
          .send(Buffer.from(pdf))
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
