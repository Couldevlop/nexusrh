/**
 * GET /approvals/pending — « Mes validations » : demandes en attente (absences,
 * notes de frais) que l'utilisateur connecté doit traiter ou peut suivre, avec
 * leur échéance (SLA). Alimente le tableau de bord des valideurs, la bannière
 * et la fenêtre de rappel des échéances.
 *
 * Règles de visibilité (service approval-workflow) :
 *  - le valideur de l'étape (N+1, N+2… ou équipe RH) voit la demande, actionnable ;
 *  - absences : la RH ne voit une demande qu'une fois les visas hiérarchiques obtenus ;
 *  - notes de frais : la RH les voit dès la soumission, en lecture seule tant
 *    qu'elles ne sont pas à son niveau.
 * Personne ne voit ici ses propres demandes (elles sont dans « Mon espace »).
 */
import type { FastifyPluginAsync } from 'fastify'
import { pool } from '../../db/pool.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import {
  hrCanSee, isHrDecisionRole, loadManagerMap, loadWorkflowSettings, summarize,
  type Actor, type ApprovalModule, type ApprovalTrailEntry, type WorkflowSummary,
} from '../../services/approval-workflow.service.js'

/** Une échéance « proche » : moins de 12 h avant son terme. */
const DUE_SOON_MS = 12 * 3_600_000
/** Borne du nombre de demandes en attente lues par module. */
const MAX_PENDING = 500

interface PendingApproval {
  module: ApprovalModule
  id: string
  employeeId: string
  employeeName: string
  label: string
  detail: string
  submittedAt: string
  workflow: WorkflowSummary
  dueSoon: boolean
}

interface PendingRow {
  id: string; employee_id: string; first_name: string; last_name: string
  label: string | null; detail: string | null; validation_level: number | null
  submitted_at: string; approval_trail: ApprovalTrailEntry[] | null
}

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

function pendingSql(schema: string, module: ApprovalModule): string {
  if (module === 'absences') {
    return `SELECT a.id, a.employee_id, e.first_name, e.last_name,
                   at.label AS label,
                   to_char(a.start_date, 'YYYY-MM-DD') || ' → ' || to_char(a.end_date, 'YYYY-MM-DD') || ' (' || a.days || ' j)' AS detail,
                   a.validation_level, a.created_at AS submitted_at, a.approval_trail
              FROM "${schema}".absences a
              JOIN "${schema}".employees e ON e.id = a.employee_id
              LEFT JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
             WHERE a.status IN ('pending','submitted')
             ORDER BY a.created_at LIMIT ${MAX_PENDING}`
  }
  return `SELECT er.id, er.employee_id, e.first_name, e.last_name,
                 er.title AS label, er.total_amount::text || ' FCFA' AS detail,
                 er.validation_level, COALESCE(er.submitted_at, er.created_at) AS submitted_at, er.approval_trail
            FROM "${schema}".expense_reports er
            JOIN "${schema}".employees e ON e.id = er.employee_id
           WHERE er.status = 'submitted'
           ORDER BY COALESCE(er.submitted_at, er.created_at) LIMIT ${MAX_PENDING}`
}

/** Demandes visibles par l'acteur pour un module, avec leur état de circuit. */
async function pendingFor(
  schema: string, module: ApprovalModule, actor: Actor, managerOf: Map<string, string | null>, now: Date = new Date(),
): Promise<PendingApproval[]> {
  const settings = await loadWorkflowSettings(pool, schema, module)
  const res = await pool.query<PendingRow>(pendingSql(schema, module))
  const out: PendingApproval[] = []
  for (const row of res?.rows ?? []) {
    if (actor.employeeId && row.employee_id === actor.employeeId) continue
    const workflow = summarize(settings, managerOf, {
      employeeId: row.employee_id,
      validationLevel: Number(row.validation_level ?? 0),
      status: 'submitted',
      submittedAt: new Date(row.submitted_at),
      trail: Array.isArray(row.approval_trail) ? row.approval_trail : [],
    }, actor, now)
    const visible = workflow.canAct || (isHrDecisionRole(actor.role) && hrCanSee(module, workflow))
    if (!visible) continue
    const dueMs = workflow.dueAt ? Date.parse(workflow.dueAt) - now.getTime() : Number.POSITIVE_INFINITY
    out.push({
      module, id: row.id, employeeId: row.employee_id,
      employeeName: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
      label: row.label ?? '', detail: row.detail ?? '',
      submittedAt: new Date(row.submitted_at).toISOString(),
      workflow,
      dueSoon: !workflow.overdue && dueMs <= DUE_SOON_MS,
    })
  }
  return out
}

const approvalsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  fastify.get('/pending', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['approvals'], summary: 'Mes validations en attente (absences, notes de frais) et leurs échéances' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      if (!schema || request.user.role === 'super_admin') return reply.send({ data: [], summary: emptySummary() })
      try {
        const actor = await actorOf(schema, request.user)
        const managerOf = await loadManagerMap(pool, schema)
        const items = [
          ...await pendingFor(schema, 'absences', actor, managerOf),
          ...await pendingFor(schema, 'expenses', actor, managerOf),
        ].sort((a, b) => Date.parse(a.workflow.dueAt ?? a.submittedAt) - Date.parse(b.workflow.dueAt ?? b.submittedAt))
        const actionable = items.filter((i) => i.workflow.canAct)
        return reply.send({
          data: items,
          summary: {
            actionable: actionable.length,
            overdue: actionable.filter((i) => i.workflow.overdue).length,
            dueSoon: actionable.filter((i) => i.dueSoon).length,
            readOnly: items.length - actionable.length,
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Impossible de charger les validations en attente' })
      }
    },
  })
}

function emptySummary() {
  return { actionable: 0, overdue: 0, dueSoon: 0, readOnly: 0 }
}

export default approvalsRoutes
