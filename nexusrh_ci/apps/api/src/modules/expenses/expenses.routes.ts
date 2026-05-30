import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { z } from 'zod'
import { config } from '../../config.js'

const pool = new Pool({ connectionString: config.database.url })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Catégories de frais autorisées (OHADA CI : transport, repas, hébergement…)
const EXPENSE_CATEGORIES = ['transport', 'repas', 'hebergement', 'fournitures', 'representation', 'formation', 'autre'] as const
// Cap par ligne : 10M FCFA (>16k€), bien au-delà de la note de frais réaliste.
// Anti-overflow + anti-fraude (un attaquant ne peut pas injecter 99 999 999 999).
const EXPENSE_LINE_MAX = 10_000_000

const expenseLineSchema = z.object({
  description: z.string().min(1).max(500).trim(),
  category:    z.enum(EXPENSE_CATEGORIES).optional(),
  date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD requis'),
  amount:      z.number().int().nonnegative().max(EXPENSE_LINE_MAX),
}).strict()

const createExpenseSchema = z.object({
  title:       z.string().min(1).max(200).trim(),
  month:       z.string().regex(/^\d{4}-\d{2}$/).optional(),
  employee_id: z.string().uuid().optional(),
  lines:       z.array(expenseLineSchema).max(50).optional(),
}).strict()

const addLineSchema = expenseLineSchema

const rejectSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
}).strict()

/**
 * OWASP A01 — un manager ne peut approver/rejeter que les notes de frais des
 * employés de son équipe directe. admin/hr_manager ont la portée tenant globale.
 */
async function managerCanActOnReport(
  schema: string,
  managerEmail: string,
  reportId: string,
): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    `SELECT e.id FROM "${schema}".expense_reports er
       JOIN "${schema}".employees e ON e.id = er.employee_id
       JOIN "${schema}".employees m ON m.id = e.manager_id
      WHERE er.id = $1 AND m.email = $2 LIMIT 1`,
    [reportId, managerEmail],
  )
  return r.rows.length > 0
}

function auditLogExpense(
  schema: string, userId: string, action: string,
  reportId: string, changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'expense_report', $3, $4, $5)`,
    [userId, action, reportId, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

const expensesRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /expenses — toutes les notes (RH)
  fastify.get('/', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { status, employee_id, limit = '50', offset = '0' } = request.query as Record<string, string>
      let sql = `SELECT er.*, e.first_name, e.last_name, d.name AS department_name
                 FROM "${schema}".expense_reports er
                 JOIN "${schema}".employees e ON e.id = er.employee_id
                 LEFT JOIN "${schema}".departments d ON d.id = e.department_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (request.user.role === 'manager') {
        const emp = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        if (emp.rows[0]) { sql += ` AND e.manager_id = $${idx++}`; params.push(emp.rows[0].id) }
      }
      if (status)      { sql += ` AND er.status = $${idx++}`; params.push(status) }
      if (employee_id) { sql += ` AND er.employee_id = $${idx++}`; params.push(employee_id) }
      sql += ` ORDER BY er.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`
      params.push(parseInt(limit), parseInt(offset))
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /expenses/my-expenses
  fastify.get('/my-expenses', {
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
          SELECT er.*,
            (SELECT json_agg(el ORDER BY el.date) FROM "${schema}".expense_lines el WHERE el.report_id = er.id) AS lines
          FROM "${schema}".expense_reports er
          WHERE er.employee_id = $1
          ORDER BY er.created_at DESC LIMIT 24
        `, [employeeId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /expenses/:id
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const role = request.user.role
      try {
        const reportRes = await pool.query(`
          SELECT er.*, e.first_name, e.last_name, e.email AS employee_email, d.name AS department_name
          FROM "${schema}".expense_reports er
          JOIN "${schema}".employees e ON e.id = er.employee_id
          LEFT JOIN "${schema}".departments d ON d.id = e.department_id
          WHERE er.id = $1
        `, [id])
        if (!reportRes.rows[0]) return reply.status(404).send({ error: 'Note introuvable' })
        // OWASP A01 — scope d'accès :
        //  - employee : uniquement ses propres notes
        //  - manager  : uniquement les notes de son équipe directe
        //  - admin/hr_manager/hr_officer/readonly : accès complet (matrice RBAC)
        if (role === 'employee') {
          if (reportRes.rows[0].employee_email !== request.user.email) {
            return reply.status(403).send({ error: 'Accès interdit' })
          }
        } else if (role === 'manager') {
          const allowed = await managerCanActOnReport(schema, request.user.email, id)
          if (!allowed) return reply.status(403).send({ error: 'Accès interdit — hors de votre équipe directe' })
        }
        const linesRes = await pool.query(
          `SELECT * FROM "${schema}".expense_lines WHERE report_id = $1 ORDER BY date`, [id]
        )
        return reply.send({ data: { ...reportRes.rows[0], lines: linesRes.rows } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /expenses
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 : validation Zod stricte (rejette champs arbitraires + bornes montants)
      const parsed = createExpenseSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données de note de frais invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      try {
        let employeeId = body.employee_id
        if (!employeeId || request.user.role === 'employee') {
          const emp = await pool.query(
            `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
          )
          if (emp.rows[0]) {
            employeeId = emp.rows[0].id as string
          } else {
            return reply.status(422).send({ error: 'Aucun dossier employé associé à ce compte. Contactez votre RH.' })
          }
        }
        const lines = body.lines ?? []
        const totalAmount = lines.reduce((sum, l) => sum + l.amount, 0)
        // Garde-fou supplémentaire : total bornée même si chaque ligne est OK
        if (totalAmount > EXPENSE_LINE_MAX * 50) {
          return reply.status(422).send({ error: 'Montant total disproportionné (> 500 M FCFA).' })
        }
        const res = await pool.query(`
          INSERT INTO "${schema}".expense_reports (employee_id, title, month, total_amount, status)
          VALUES ($1,$2,$3,$4,'draft') RETURNING *
        `, [employeeId, body.title, body.month || new Date().toISOString().slice(0, 7), totalAmount])
        const report = res.rows[0]
        for (const line of lines) {
          await pool.query(`
            INSERT INTO "${schema}".expense_lines (report_id, description, category, date, amount)
            VALUES ($1,$2,$3,$4,$5)
          `, [report.id, line.description, line.category ?? 'autre', line.date, line.amount])
        }
        auditLogExpense(schema, request.user.sub, 'expense.created', report.id, {
          employeeId, title: body.title, totalAmount, lineCount: lines.length,
        }, request.ip ?? null)
        return reply.status(201).send({ data: report })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/submit
  fastify.patch('/:id/submit', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        // Vérifier l'ownership avant la mise à jour
        if (request.user.role === 'employee') {
          const ownerCheck = await pool.query(
            `SELECT e.email FROM "${schema}".expense_reports er
             JOIN "${schema}".employees e ON e.id = er.employee_id
             WHERE er.id = $1 LIMIT 1`,
            [id]
          )
          if (!ownerCheck.rows[0] || ownerCheck.rows[0].email !== request.user.email) {
            return reply.status(403).send({ error: 'Accès interdit' })
          }
        }
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET status = 'submitted', submitted_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'draft' RETURNING *
        `, [id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non modifiable' })
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/approve
  fastify.patch('/:id/approve', {
    preHandler: [fastify.authorize('admin','hr_manager','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      // OWASP A01 : un manager ne peut approuver que les notes de son équipe directe
      if (request.user.role === 'manager') {
        const allowed = await managerCanActOnReport(schema, request.user.email, id)
        if (!allowed) {
          return reply.status(403).send({ error: 'Vous ne pouvez approuver que les notes de votre équipe directe' })
        }
      }
      try {
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
          WHERE id = $2 AND status = 'submitted' RETURNING *
        `, [request.user.sub, id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non approvable' })
        auditLogExpense(schema, request.user.sub, 'expense.approved', id, {
          totalAmount: res.rows[0].total_amount,
          employeeId:  res.rows[0].employee_id,
        }, request.ip ?? null)
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/reject
  fastify.patch('/:id/reject', {
    preHandler: [fastify.authorize('admin','hr_manager','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      // OWASP A03 : validation du body (motif optionnel mais borné)
      const parsed = rejectSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Motif invalide' })
      }
      const reason = parsed.data.reason
      // OWASP A01 : même RBAC manager que approve
      if (request.user.role === 'manager') {
        const allowed = await managerCanActOnReport(schema, request.user.email, id)
        if (!allowed) {
          return reply.status(403).send({ error: 'Vous ne pouvez rejeter que les notes de votre équipe directe' })
        }
      }
      try {
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET status = 'rejected', rejection_reason = $1, updated_at = now()
          WHERE id = $2 AND status = 'submitted' RETURNING *
        `, [reason ?? null, id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non refusable' })
        auditLogExpense(schema, request.user.sub, 'expense.rejected', id, {
          reason: reason ?? null,
          employeeId: res.rows[0].employee_id,
        }, request.ip ?? null)
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/pay
  fastify.patch('/:id/pay', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      try {
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET status = 'paid', paid_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'approved' RETURNING *
        `, [id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non remboursable' })
        // OWASP A09 : paiement = action financière critique, traçabilité obligatoire
        auditLogExpense(schema, request.user.sub, 'expense.paid', id, {
          totalAmount: res.rows[0].total_amount,
          employeeId:  res.rows[0].employee_id,
        }, request.ip ?? null)
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /expenses/:id/lines
  fastify.post('/:id/lines', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      // OWASP A03 : validation Zod (description, category enum, date YYYY-MM-DD, amount borné)
      const parsed = addLineSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Ligne de frais invalide',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      try {
        const lineRes = await pool.query(`
          INSERT INTO "${schema}".expense_lines (report_id, description, category, date, amount)
          VALUES ($1,$2,$3,$4,$5) RETURNING *
        `, [id, body.description, body.category ?? 'autre', body.date, body.amount])
        await pool.query(`
          UPDATE "${schema}".expense_reports
          SET total_amount = (SELECT COALESCE(SUM(amount),0) FROM "${schema}".expense_lines WHERE report_id = $1),
              updated_at = now()
          WHERE id = $1
        `, [id])
        return reply.status(201).send({ data: lineRes.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default expensesRoutes
