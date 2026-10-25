import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { emitIntegrationEvent } from '../../services/integrations.service.js'
import { decryptIfPresent } from '@nexusrhci/shared/crypto'
import { initiateTransfer, normalizeMmProvider } from '../../services/mobile-money-providers.js'
import { scanBuffer, scanRejectionMessage } from '../../services/antivirus.service.js'
import { auditTenant } from '../../utils/audit-log.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { managerScopeSql } from '../../services/manager-scope.service.js'
import {
  denialMessage, evaluateRequest, hrCanSee, loadManagerMap, loadWorkflowSettings, stepLabel, summarize, trailEntry,
  type Actor, type ApprovalTrailEntry,
} from '../../services/approval-workflow.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Catégories de frais autorisées (OHADA CI : transport, repas, hébergement…).
// Inclut materiel/communication proposés par l'UI : sans eux ces choix du
// formulaire renvoyaient un 400 à la soumission.
const EXPENSE_CATEGORIES = ['transport', 'repas', 'hebergement', 'fournitures', 'representation', 'formation', 'materiel', 'communication', 'autre'] as const
// Cap par ligne : 10M FCFA (>16k€), bien au-delà de la note de frais réaliste.
// Anti-overflow + anti-fraude (un attaquant ne peut pas injecter 99 999 999 999).
const EXPENSE_LINE_MAX = 10_000_000

// Justificatif : soit une URL http(s), soit un data URL (image/PDF en base64
// produit par l'endpoint d'upload), soit un chemin interne "local://".
// Borné à ~7 Mo (un data URL base64 = ~1,37x la taille binaire ; 5 Mo binaire
// → ~6,8 Mo de chaîne) pour rester cohérent avec EXPENSE_RECEIPT_MAX_BYTES.
const RECEIPT_URL_MAX = 7_500_000
const receiptUrlSchema = z.string().trim().max(RECEIPT_URL_MAX).refine(
  (v) => /^https?:\/\//i.test(v) || /^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,/i.test(v) || /^local:\/\//i.test(v),
  { message: 'Justificatif invalide (URL http(s), data URL image/PDF ou chemin interne attendu)' },
)

const expenseLineSchema = z.object({
  description: z.string().min(1).max(500).trim(),
  category:    z.enum(EXPENSE_CATEGORIES).optional(),
  date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD requis'),
  amount:      z.number().int().nonnegative().max(EXPENSE_LINE_MAX),
  receiptUrl:  receiptUrlSchema.optional(),
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

// FRA-006 — remboursement Mobile Money (opt-in). Sans body, /pay reste un simple
// flag comptable (rétro-compat). Avec provider, on initie un vrai virement.
const paySchema = z.object({
  provider: z.string().max(20).optional(),
  phone:    z.string().max(20).optional(),
}).strict()

/**
 * OWASP A01 — un manager ne peut approver/rejeter que les notes de frais des
 * employés de son périmètre (équipe directe, ou branche selon le réglage
 * tenant — cf. manager-scope.service). admin/hr_manager = portée tenant.
 * Sa propre note n'est jamais dans son périmètre (anti auto-approbation).
 */
async function managerCanActOnReport(
  schema: string,
  managerEmail: string,
  reportId: string,
): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    `SELECT e.id FROM "${schema}".expense_reports er
       JOIN "${schema}".employees e ON e.id = er.employee_id
      WHERE er.id = $1
        AND ${managerScopeSql(schema, 'e', `(SELECT id FROM "${schema}".employees WHERE email = $2 LIMIT 1)`)}
      LIMIT 1`,
    [reportId, managerEmail],
  )
  return r.rows.length > 0
}

/**
 * OWASP A01 — un manager ne peut imputer une note de frais qu'à un membre de son
 * périmètre (ou à lui-même). Fail-closed : manager sans dossier employé →
 * aucune imputation possible pour autrui.
 */
async function managerCanActOnEmployee(
  schema: string,
  managerEmail: string,
  targetEmployeeId: string,
): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    `SELECT e.id FROM "${schema}".employees e
      WHERE e.id = $1
        AND ${managerScopeSql(schema, 'e', `(SELECT id FROM "${schema}".employees WHERE email = $2 LIMIT 1)`)}
      UNION ALL
     SELECT s.id FROM "${schema}".employees s
      WHERE s.id = $1 AND s.email = $2
      LIMIT 1`,
    [targetEmployeeId, managerEmail],
  )
  return r.rows.length > 0
}

/** Rôles RH à portée tenant globale (matrice RBAC « Notes de frais (saisie) »). */
const HR_SCOPE_ROLES = ['admin', 'hr_manager', 'hr_officer']

/** Notification non bloquante (table notifications). Échec silencieux. */
function notifyUser(
  schema: string, userId: string | null | undefined, type: string,
  title: string, message: string, data: Record<string, unknown> = {},
): void {
  if (!userId) return
  pool.query(
    `INSERT INTO "${schema}".notifications (user_id, type, title, message, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, message, JSON.stringify(data)],
  ).catch(() => { /* table absente / user supprimé : non bloquant */ })
}

/** user_id du compte lié à un employé (null si aucun). */
async function userIdOfEmployee(schema: string, employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null
  try {
    const r = await pool.query<{ user_id: string | null }>(
      `SELECT user_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
    )
    return r?.rows?.[0]?.user_id ?? null
  } catch { return null }
}

/** user_id du manager direct d'un employé (pour notifier la soumission). */
async function managerUserIdOfEmployee(schema: string, employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null
  try {
    const r = await pool.query<{ user_id: string | null }>(
      `SELECT m.user_id FROM "${schema}".employees e
         JOIN "${schema}".employees m ON m.id = e.manager_id
        WHERE e.id = $1 LIMIT 1`, [employeeId],
    )
    return r?.rows?.[0]?.user_id ?? null
  } catch { return null }
}

/** Utilisateur connecté vu par le circuit de validation (dossier employé résolu). */
async function actorOf(schema: string, user: { sub: string; role: string; employeeId?: string | null; email?: string }): Promise<Actor> {
  let employeeId = user.employeeId ?? null
  if (!employeeId && user.email) {
    try {
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [user.email],
      )
      employeeId = r?.rows?.[0]?.id ?? null
    } catch { employeeId = null }
  }
  return { role: user.role, userId: user.sub, employeeId }
}

interface ReportWorkflowRow {
  employee_id: string; status: string; validation_level: number | null
  submitted_at: string | null; created_at: string | null; approval_trail: ApprovalTrailEntry[] | null
  total_amount?: string | number | null; title?: string | null
}

async function loadReportForWorkflow(schema: string, id: string): Promise<ReportWorkflowRow | null> {
  const r = await pool.query<ReportWorkflowRow>(
    `SELECT employee_id, status, validation_level, submitted_at, created_at, approval_trail, total_amount, title
       FROM "${schema}".expense_reports WHERE id = $1 LIMIT 1`, [id],
  )
  return r?.rows?.[0] ?? null
}

function toWorkflowRequest(row: ReportWorkflowRow) {
  return {
    employeeId: row.employee_id,
    validationLevel: Number(row.validation_level ?? 0),
    status: row.status,
    submittedAt: new Date(row.submitted_at ?? row.created_at ?? Date.now()),
    trail: Array.isArray(row.approval_trail) ? row.approval_trail : [],
  }
}

function auditLogExpense(
  schema: string, userId: string, action: string,
  reportId: string, changes: Record<string, unknown>, ip: string | null,
): void {
  auditTenant(schema, { userId: userId, action: action, entity: 'expense_report', entityId: reportId, changes: changes, ip: ip })
}

const expensesRoutes: FastifyPluginAsync = async (fastify) => {
  // Migration paresseuse (colonnes du circuit de validation sur les anciens tenants).
  fastify.addHook('preHandler', ensureTenantSchemaHook)

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
      let managerEmpId: string | null = null
      if (request.user.role === 'manager') {
        const emp = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        // OWASP A01 — fail-closed : manager sans dossier employé → aucune note.
        if (!emp.rows[0]) return reply.send({ data: [] })
        managerEmpId = emp.rows[0].id as string
        // Son périmètre, plus les notes de sa branche en attente (visa N+2…).
        const p = `$${idx++}`; params.push(managerEmpId)
        sql = sql.replace('SELECT er.*,', `SELECT er.*, (${managerScopeSql(schema, 'e', p)}) AS in_scope,`)
        sql += ` AND (${managerScopeSql(schema, 'e', p)}
                 OR (er.status = 'submitted' AND ${managerScopeSql(schema, 'e', p, { forceHierarchy: true })}))`
      }
      if (status)      { sql += ` AND er.status = $${idx++}`; params.push(status) }
      if (employee_id) { sql += ` AND er.employee_id = $${idx++}`; params.push(employee_id) }
      sql += ` ORDER BY er.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`
      params.push(parseInt(limit), parseInt(offset))
      try {
        const res = await pool.query(sql, params)
        const rows = (res?.rows ?? []) as Array<ReportWorkflowRow & { in_scope?: boolean }>
        if (rows.length === 0) return reply.send({ data: rows })
        // Circuit : la RH voit les notes dès la soumission, en lecture seule
        // tant qu'elles ne sont pas arrivées à son niveau.
        const settings = await loadWorkflowSettings(pool, schema, 'expenses')
        const managerOf = await loadManagerMap(pool, schema)
        const actor = managerEmpId
          ? { role: request.user.role, userId: request.user.sub, employeeId: managerEmpId }
          : await actorOf(schema, request.user)
        const data = rows
          .map(({ in_scope: inScope, ...row }) => ({
            ...row,
            inScope: inScope !== false,
            workflow: summarize(settings, managerOf, toWorkflowRequest(row), actor),
          }))
          .filter((row) => managerEmpId !== null
            ? row.inScope || row.workflow.canAct
            : hrCanSee('expenses', row.workflow))
          .map(({ inScope: _inScope, ...row }) => row)
        return reply.send({ data })
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
  // OWASP A01 — `readonly` est consultation seule : exclu de la saisie.
  fastify.post('/', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee')],
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
        // OWASP A01 (IDOR) — `body.employee_id` n'est honoré que dans la portée
        // du rôle : RH (admin/hr_manager/hr_officer) = tenant entier ; manager =
        // son équipe directe ou lui-même ; tout autre rôle = son propre dossier
        // (le champ est ignoré, jamais une erreur silencieuse d'imputation).
        const role = request.user.role
        let employeeId: string | undefined
        if (HR_SCOPE_ROLES.includes(role)) {
          employeeId = body.employee_id
        } else if (role === 'manager' && body.employee_id) {
          const allowed = await managerCanActOnEmployee(schema, request.user.email, body.employee_id)
          if (!allowed) {
            return reply.status(403).send({
              error: 'Vous ne pouvez saisir une note de frais que pour votre équipe directe',
            })
          }
          employeeId = body.employee_id
        }
        if (!employeeId) {
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
            INSERT INTO "${schema}".expense_lines (report_id, description, category, date, amount, receipt_url)
            VALUES ($1,$2,$3,$4,$5,$6)
          `, [report.id, line.description, line.category ?? 'autre', line.date, line.amount, line.receiptUrl ?? null])
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
  // OWASP A01 — `readonly` est consultation seule : exclu de la soumission.
  fastify.patch('/:id/submit', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        // OWASP A01 — un manager ne soumet que les notes de son équipe directe
        // (même helper que /approve et /reject). RH = portée tenant.
        if (request.user.role === 'manager') {
          const allowed = await managerCanActOnReport(schema, request.user.email, id)
          if (!allowed) {
            return reply.status(403).send({
              error: 'Vous ne pouvez soumettre que les notes de votre équipe directe',
            })
          }
        }
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
        // FRA-003 — notifier le manager direct (non bloquant)
        const submitted = res.rows[0]
        void managerUserIdOfEmployee(schema, submitted.employee_id).then((uid) =>
          notifyUser(schema, uid, 'expense_submitted', 'Note de frais à valider',
            `La note « ${submitted.title} » a été soumise pour validation.`,
            { reportId: submitted.id, employeeId: submitted.employee_id }))
        return reply.send({ data: submitted })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/approve — circuit N+1 … N+n → RH (Paramètres → Workflow).
  // Le valideur de l'étape agit, quel que soit son rôle (un chef d'équipe peut
  // avoir le rôle employee) ; la RH décide en dernier. Jamais sur sa propre note.
  fastify.patch('/:id/approve', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','employee')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      try {
        const report = await loadReportForWorkflow(schema, id)
        if (!report) return reply.status(404).send({ error: 'Note introuvable' })
        if (report.status !== 'submitted') return reply.status(400).send({ error: 'Note non approvable' })
        const actor = await actorOf(schema, request.user)
        const settings = await loadWorkflowSettings(pool, schema, 'expenses')
        const ev = evaluateRequest(settings, await loadManagerMap(pool, schema), toWorkflowRequest(report), actor)
        if (!ev.decision.allowed) {
          return reply.status(403).send({ error: denialMessage(ev.decision.reason, ev.step, 'note de frais') })
        }
        const isFinal = ev.step.kind === 'hr'
        const nextLevel = ev.index + 1
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET validation_level = $1, status = $2,
              approved_by = $3, approved_at = $4, updated_at = now(),
              approval_trail = COALESCE(approval_trail, '[]'::jsonb) || $5::jsonb
          WHERE id = $6 AND status = 'submitted' RETURNING *
        `, [nextLevel, isFinal ? 'approved' : 'submitted', isFinal ? request.user.sub : null, isFinal ? new Date() : null,
            JSON.stringify([trailEntry(ev.index, ev.step, actor, ev.decision.override)]), id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non approvable' })
        if (!isFinal) {
          auditLogExpense(schema, request.user.sub, 'expense.approval_step', id, {
            step: ev.step.kind === 'hr' ? 'hr' : `n+${ev.step.level}`, level: nextLevel, totalLevels: ev.steps.length,
            employeeId: report.employee_id,
          }, request.ip ?? null)
          const next = ev.steps[nextLevel]
          if (next?.kind === 'manager') {
            void userIdOfEmployee(schema, next.approverEmployeeId).then((uid) =>
              notifyUser(schema, uid, 'expense_submitted', 'Note de frais à viser',
                `La note « ${report.title ?? ''} » attend votre visa (N+${next.level}).`, { reportId: id }))
          }
          return reply.send({
            data: res.rows[0],
            message: `Étape ${nextLevel}/${ev.steps.length} validée — suite : ${next ? stepLabel(next) : 'validation RH'}`,
            fullyApproved: false,
          })
        }
        auditLogExpense(schema, request.user.sub, 'expense.approved', id, {
          totalAmount: res.rows[0].total_amount,
          employeeId:  res.rows[0].employee_id,
          escalated:   ev.decision.override,
        }, request.ip ?? null)
        emitIntegrationEvent(pool, schema, 'expense.approved', {
          id, employeeId: res.rows[0].employee_id, totalAmount: res.rows[0].total_amount,
        }, decryptIfPresent)
        // FRA-004 — notifier l'employé que sa note est approuvée (non bloquant)
        void userIdOfEmployee(schema, res.rows[0].employee_id).then((uid) =>
          notifyUser(schema, uid, 'expense_approved', 'Note de frais approuvée',
            'Votre note de frais a été approuvée — remboursement à venir.',
            { reportId: id }))
        return reply.send({ data: res.rows[0], message: 'Note de frais approuvée', fullyApproved: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/reject
  fastify.patch('/:id/reject', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','employee')],
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
      try {
        // OWASP A01 : même circuit que approve (valideur de l'étape, jamais soi-même).
        const report = await loadReportForWorkflow(schema, id)
        if (!report) return reply.status(404).send({ error: 'Note introuvable' })
        if (report.status !== 'submitted') return reply.status(400).send({ error: 'Note non refusable' })
        const actor = await actorOf(schema, request.user)
        const settings = await loadWorkflowSettings(pool, schema, 'expenses')
        const ev = evaluateRequest(settings, await loadManagerMap(pool, schema), toWorkflowRequest(report), actor)
        if (!ev.decision.allowed) {
          return reply.status(403).send({ error: denialMessage(ev.decision.reason, ev.step, 'note de frais') })
        }
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
        // FRA-005 — notifier l'employé du refus avec le motif (non bloquant)
        void userIdOfEmployee(schema, res.rows[0].employee_id).then((uid) =>
          notifyUser(schema, uid, 'expense_rejected', 'Note de frais refusée',
            reason ? `Votre note de frais a été refusée : ${reason}` : 'Votre note de frais a été refusée.',
            { reportId: id, reason: reason ?? null }))
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
      const parsedPay = paySchema.safeParse(request.body ?? {})
      if (!parsedPay.success) return reply.status(400).send({ error: 'Paramètres de paiement invalides' })
      const mmProvider = parsedPay.data.provider ? normalizeMmProvider(parsedPay.data.provider) : null
      if (parsedPay.data.provider && !mmProvider) {
        return reply.status(400).send({ error: 'Fournisseur Mobile Money inconnu (wave | mtn_momo | orange_money)' })
      }
      try {
        // ── FRA-006 : remboursement Mobile Money réel (opt-in via provider) ──
        if (mmProvider) {
          const repRes = await pool.query<{
            status: string; total_amount: string; employee_id: string; currency: string
            mm_phone: string | null; mm_provider: string | null
          }>(`
            SELECT er.status, er.total_amount, er.employee_id, er.currency,
                   e.mobile_money_phone AS mm_phone, e.mobile_money_provider AS mm_provider
              FROM "${schema}".expense_reports er
              JOIN "${schema}".employees e ON e.id = er.employee_id
             WHERE er.id = $1 LIMIT 1
          `, [id])
          const rep = repRes.rows[0]
          if (!rep) return reply.status(404).send({ error: 'Note introuvable' })
          if (rep.status !== 'approved') return reply.status(400).send({ error: 'Note non remboursable' })
          const phone = (parsedPay.data.phone ?? rep.mm_phone ?? '').trim()
          if (!phone) return reply.status(400).send({ error: 'Numéro Mobile Money manquant pour cet employé' })
          const amount = Math.round(Number(rep.total_amount) || 0)
          const reference = `EXP-${id.slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`

          let transfer
          try {
            transfer = await initiateTransfer(schema, mmProvider, {
              phone, amount, reference, description: 'Remboursement note de frais',
            })
          } catch (e) {
            transfer = { success: false, status: 'failed' as const, error: e instanceof Error ? e.message : 'Échec du virement' }
          }

          // Traçabilité du virement (mobile_money_payments) — non bloquant
          pool.query(`
            INSERT INTO "${schema}".mobile_money_payments
              (employee_id, amount, currency, provider, phone_number, reference, external_ref, status, initiated_at, confirmed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
          `, [rep.employee_id, amount, rep.currency || 'XOF', mmProvider, phone, reference,
              transfer.transactionId ?? null, transfer.status,
              transfer.status === 'completed' ? new Date().toISOString() : null,
          ]).catch(() => { /* table absente : non bloquant */ })

          if (transfer.status === 'failed') {
            return reply.status(502).send({ error: 'Virement Mobile Money échoué', detail: transfer.error ?? null, reference })
          }

          // Le virement est initié/abouti → on marque la note remboursée + référence TXN
          await pool.query(
            `ALTER TABLE "${schema}".expense_reports ADD COLUMN IF NOT EXISTS payment_reference varchar(100)`,
          ).catch(() => { /* idempotent */ })
          const upd = await pool.query(`
            UPDATE "${schema}".expense_reports
            SET status = 'paid', payment_method = $2, payment_reference = $3, paid_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'approved' RETURNING *
          `, [id, mmProvider, reference])
          if (!upd.rows[0]) return reply.status(400).send({ error: 'Note non remboursable' })
          auditLogExpense(schema, request.user.sub, 'expense.paid', id, {
            totalAmount: upd.rows[0].total_amount, employeeId: upd.rows[0].employee_id,
            provider: mmProvider, reference, mmStatus: transfer.status,
          }, request.ip ?? null)
          void userIdOfEmployee(schema, upd.rows[0].employee_id).then((uid) =>
            notifyUser(schema, uid, 'expense_paid', 'Note de frais remboursée',
              `Votre note de frais a été remboursée par ${mmProvider} (réf. ${reference}).`,
              { reportId: id, reference, provider: mmProvider }))
          return reply.send({ data: upd.rows[0], payment: { reference, status: transfer.status, transactionId: transfer.transactionId ?? null } })
        }

        // ── Rétro-compat : simple flag comptable (sans Mobile Money) ──
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
    // RBAC — readonly exclu (consultation seule). Le périmètre est ensuite
    // affiné par rôle dans le handler (employee → son rapport, manager → équipe).
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee')],
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
        // OWASP A01 (IDOR) — un employé ne peut ajouter une ligne qu'à SON propre
        // rapport, et uniquement tant qu'il est en brouillon. Sans ce contrôle, un
        // employé pourrait greffer une ligne sur le rapport d'un autre (UUID deviné).
        // Même pattern d'ownership que PATCH /:id/submit (résolution employeeId
        // via token sinon lookup par email).
        const reportRes = await pool.query<{ employee_id: string; status: string }>(
          `SELECT employee_id, status FROM "${schema}".expense_reports WHERE id = $1 LIMIT 1`,
          [id],
        )
        const report = reportRes.rows[0]
        if (!report) return reply.status(404).send({ error: 'Note introuvable' })

        if (request.user.role === 'employee') {
          let employeeId = request.user.employeeId
          if (!employeeId) {
            const emp = await pool.query<{ id: string }>(
              `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`,
              [request.user.email],
            )
            if (!emp.rows[0]) return reply.status(403).send({ error: 'Accès interdit' })
            employeeId = emp.rows[0].id
          }
          if (report.employee_id !== employeeId) {
            return reply.status(403).send({ error: 'Accès interdit' })
          }
        } else if (request.user.role === 'manager') {
          // OWASP A01 — un manager ne peut compléter QUE les notes de frais des
          // membres de son équipe directe (mêmes règles que /approve, /reject).
          const allowed = await managerCanActOnReport(schema, request.user.email, id)
          if (!allowed) return reply.status(403).send({ error: 'Accès interdit' })
        }
        // Seul un rapport en brouillon accepte de nouvelles lignes (cohérent avec
        // le workflow : une fois soumis/approuvé/payé, le contenu est figé).
        if (report.status !== 'draft') {
          return reply.status(400).send({ error: 'Note non modifiable' })
        }

        const lineRes = await pool.query(`
          INSERT INTO "${schema}".expense_lines (report_id, description, category, date, amount, receipt_url)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
        `, [id, body.description, body.category ?? 'autre', body.date, body.amount, body.receiptUrl ?? null])
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

  // ── UPLOAD JUSTIFICATIF (multipart) ────────────────────────────────────────
  // Reçoit un fichier (image ou PDF), le valide (MIME allowlist + taille max) et
  // renvoie un data URL base64 que le client stocke dans la ligne (champ
  // receiptUrl). Suit le pattern d'upload de la recrutement (request.file() +
  // toBuffer + allowlist MIME) ; comme la colonne expense_lines.receipt_url est
  // de type text et qu'aucune colonne blob n'existe (provisioning non modifié),
  // le binaire est encodé en data URL — auto-portable, affichable inline côté UI.
  // OWASP A03 (content type spoofing) : allowlist stricte sur le MIME.
  // OWASP A01 : tout utilisateur authentifié peut uploader SON justificatif ; la
  // donnée n'est rattachée à un rapport que via une ligne dont l'ownership est
  // déjà contrôlé (POST /:id/lines / POST /).
  const RECEIPT_ALLOWED_MIMES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
  ])
  // 5 Mo binaire — au-delà, le data URL dépasserait RECEIPT_URL_MAX.
  const RECEIPT_MAX_BYTES = 5 * 1024 * 1024
  fastify.post('/receipts/upload', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const file = await request.file()
        if (!file) return reply.status(400).send({ error: 'Aucun fichier reçu' })

        const mimetype = (file.mimetype || '').toLowerCase()
        if (!RECEIPT_ALLOWED_MIMES.has(mimetype)) {
          return reply.status(400).send({
            error: 'Format non autorisé. Accepté : PNG, JPG, WEBP, GIF, PDF.',
          })
        }

        const buf = await file.toBuffer()
        if (buf.byteLength === 0) {
          return reply.status(400).send({ error: 'Fichier vide' })
        }
        if (buf.byteLength > RECEIPT_MAX_BYTES) {
          return reply.status(400).send({
            error: `Fichier trop volumineux (max ${RECEIPT_MAX_BYTES / (1024 * 1024)} Mo).`,
          })
        }
        // OWASP A08 — analyse antivirale (désactivée si CLAMAV_HOST absent).
        const av = await scanBuffer(buf)
        if (!av.clean) return reply.status(400).send({ error: scanRejectionMessage(av) })

        const receiptUrl = `data:${mimetype};base64,${buf.toString('base64')}`
        return reply.send({
          data: {
            receiptUrl,
            mimeType: mimetype,
            filename: file.filename || 'justificatif',
            sizeBytes: buf.byteLength,
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur upload justificatif' })
      }
    },
  })
}

export default expensesRoutes
