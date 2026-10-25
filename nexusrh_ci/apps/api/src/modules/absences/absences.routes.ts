import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { actorEmployeeSql } from '../../utils/actor-employee.js'
import { emitIntegrationEvent } from '../../services/integrations.service.js'
import { decryptIfPresent } from '@nexusrhci/shared/crypto'
import { sendAbsenceRequestEmail } from '../../services/email.js'
import { loadTenantMailBySchema } from '../../services/tenant-mail.service.js'
import { config } from '../../config.js'
import { auditTenant } from '../../utils/audit-log.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { isInManagerScope, managerScopeSql } from '../../services/manager-scope.service.js'
import {
  checkNotice, denialMessage, evaluateRequest, hrCanSee, initialValidationLevel, isHrDecisionRole, loadManagerMap,
  loadWorkflowSettings, managerChain, stepLabel, stepsFor, summarize, trailEntry,
  type Actor, type ApprovalTrailEntry,
} from '../../services/approval-workflow.service.js'
import { isMaternityCode, maternityRule, resolveAbsenceRequest } from '../../services/absence-duration.service.js'
import { loadEmployeeTenantContext } from '../../services/employee-tenant-context.service.js'
import { checkPaidLeaveRequest, loadLeavePolicyForEmployee, refreshPaidLeaveBalance } from '../../services/paid-leave.service.js'

// OWASP A03 (input validation) — schema strict pour POST /absences
const createAbsenceSchema = z.object({
  absenceTypeId: z.string().uuid('absenceTypeId doit être un UUID'),
  startDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format date attendu YYYY-MM-DD'),
  endDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format date attendu YYYY-MM-DD'),
  halfDay:       z.boolean().optional(),
  reason:        z.string().max(1000).optional(),
  employeeId:    z.string().uuid().optional(),
  // Maternité : prolongations légales déclarées (pack du pays)
  maternity: z.object({
    multipleBirth: z.boolean().optional(),
    illnessExtension: z.boolean().optional(),
    childHospitalizedDays: z.number().int().min(0).max(366).optional(),
  }).strict().optional(),
}).refine((d) => d.startDate <= d.endDate, {
  // ABS-003 — la date de fin doit être postérieure ou égale au début.
  // Comparaison lexicographique sûre sur des chaînes YYYY-MM-DD.
  message: 'La date de fin doit être postérieure ou égale à la date de début',
  path: ['endDate'],
})

/**
 * Notifie un utilisateur (table notifications). Non bloquant. `userId` peut être
 * null (employé sans compte / manager non lié) → on ignore silencieusement.
 */
function notifyUser(
  schema: string, userId: string | null | undefined, type: string,
  title: string, message: string, data: Record<string, unknown> = {},
): void {
  if (!userId) return
  rawPool.query(
    `INSERT INTO "${schema}".notifications (user_id, type, title, message, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, message, JSON.stringify(data)],
  ).catch(() => { /* table absente / user supprimé : non bloquant */ })
}

/** Résout le user_id du compte lié à un employé (null si aucun). */
async function userIdOfEmployee(schema: string, employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null
  try {
    const r = await rawPool.query<{ user_id: string | null }>(
      `SELECT user_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
    )
    return r?.rows?.[0]?.user_id ?? null
  } catch { return null }
}

/**
 * OWASP A01 — portée de CONSULTATION d'un manager : son périmètre, et
 * lui-même. Fail-closed (manager sans dossier employé → aucun accès).
 * Distinct de `managerCanActOnAbsence` qui interdit volontairement l'auto-action
 * (anti auto-approbation) : consulter SON propre solde reste légitime.
 */
async function managerCanViewEmployee(
  schema: string,
  managerEmployeeId: string | null | undefined,
  targetEmployeeId: string,
): Promise<boolean> {
  if (!managerEmployeeId) return false
  if (managerEmployeeId === targetEmployeeId) return true
  return isInManagerScope(rawPool, schema, managerEmployeeId, targetEmployeeId)
}

/** Statuts « en attente de validation » (création = 'pending', circuit = 'submitted'). */
const PENDING_STATUSES = ['pending', 'submitted']

/** Dossier employé de l'utilisateur connecté (token, sinon email). */
async function actorEmployeeId(schema: string, user: { employeeId?: string | null; email?: string }): Promise<string | null> {
  if (user.employeeId) return user.employeeId
  if (!user.email) return null
  try {
    const r = await rawPool.query<{ id: string }>(
      actorEmployeeSql(schema), [user.email],
    )
    return r?.rows?.[0]?.id ?? null
  } catch { return null }
}

async function actorOf(schema: string, user: { sub: string; role: string; employeeId?: string | null; email?: string }): Promise<Actor> {
  return { role: user.role, userId: user.sub, employeeId: await actorEmployeeId(schema, user) }
}

function auditLogAbsence(
  schema: string, userId: string, action: string,
  absenceId: string, changes: Record<string, unknown>, ip: string | null,
): void {
  auditTenant(schema, { userId: userId, action: action, entity: 'absence', entityId: absenceId, changes: changes, ip: ip })
}

const absencesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // GET /absences
  fastify.get('/', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    schema: { tags: ['absences'], summary: 'Liste des absences' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId, status, year, today } = request.query as Record<string, string>
      let sql = `SELECT a.*, at.label AS type_label, at.color AS type_color,
                        e.first_name, e.last_name
                 FROM "${schema}".absences a
                 JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
                 JOIN "${schema}".employees e ON e.id = a.employee_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (employeeId) { sql += ` AND a.employee_id = $${idx++}`; params.push(employeeId) }
      if (status === 'submitted' || status === 'pending') {
        sql += ` AND a.status = ANY($${idx++}::text[])`; params.push(PENDING_STATUSES)
      } else if (status) { sql += ` AND a.status = $${idx++}`; params.push(status) }
      if (year)       { sql += ` AND EXTRACT(YEAR FROM a.start_date) = $${idx++}`; params.push(parseInt(year)) }
      // REP — "Absences aujourd'hui" : ne compter que les absences en cours ce
      // jour (la date du jour est dans l'intervalle start_date..end_date).
      if (today === 'true' || today === '1') {
        sql += ` AND CURRENT_DATE BETWEEN a.start_date AND a.end_date`
      }
      let managerEmpId: string | null = null
      if (request.user.role === 'manager') {
        const emp = await rawPool.query(
          actorEmployeeSql(schema), [request.user.email]
        )
        // OWASP A01 — fail-closed : un manager sans dossier employé associé ne
        // doit voir AUCUNE absence (jamais toutes celles du tenant).
        if (!emp.rows[0]) return reply.send({ data: [] })
        managerEmpId = emp.rows[0].id as string
        // Son périmètre, plus les demandes de sa branche en attente (visa N+2,
        // N+3… quand le tenant a plusieurs niveaux) — filtrées ci-dessous.
        const p = `$${idx++}`; params.push(managerEmpId)
        sql = sql.replace('SELECT a.*,', `SELECT a.*, (${managerScopeSql(schema, 'e', p)}) AS in_scope,`)
        sql += ` AND (${managerScopeSql(schema, 'e', p)}
                 OR (a.status IN ('pending','submitted') AND ${managerScopeSql(schema, 'e', p, { forceHierarchy: true })}))`
      }
      sql += ` ORDER BY a.created_at DESC`
      const res = await rawPool.query(sql, params)
      const rows = (res?.rows ?? []) as Array<Record<string, unknown>>
      if (rows.length === 0) return reply.send({ data: rows })

      // Circuit de validation : étape courante, échéance, droit d'agir.
      const settings = await loadWorkflowSettings(rawPool, schema, 'absences')
      const managerOf = await loadManagerMap(rawPool, schema)
      const actor = managerEmpId
        ? { role: request.user.role, userId: request.user.sub, employeeId: managerEmpId }
        : await actorOf(schema, request.user)
      const data = rows
        .map(({ in_scope: inScope, ...row }) => ({
          ...row,
          inScope: inScope !== false,
          workflow: summarize(settings, managerOf, {
            employeeId: String(row.employee_id),
            validationLevel: Number(row.validation_level ?? 0),
            status: PENDING_STATUSES.includes(String(row.status)) ? 'submitted' : String(row.status),
            submittedAt: new Date(String(row.created_at ?? new Date().toISOString())),
            trail: Array.isArray(row.approval_trail) ? row.approval_trail as ApprovalTrailEntry[] : [],
          }, actor),
        }))
        // Manager : son périmètre + ce qui attend son visa. RH : une absence en
        // attente ne lui apparaît qu'une fois les visas hiérarchiques obtenus.
        .filter((row) => managerEmpId !== null
          ? row.inScope || row.workflow.canAct
          : hrCanSee('absences', row.workflow))
        .map(({ inScope: _inScope, ...row }) => row)
      return reply.send({ data })
    },
  })

  // GET /absences/my-absences
  fastify.get('/my-absences', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Mes absences (self-service)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      let employeeId: string | null = request.user.employeeId ?? null
      if (!employeeId) {
        const r = await rawPool.query(
          actorEmployeeSql(schema), [request.user.email]
        )
        employeeId = r.rows[0]?.id ?? null
      }
      if (!employeeId) return reply.send({ data: [] })
      const res = await rawPool.query(
        `SELECT a.*, at.label AS type_label, at.color AS type_color
         FROM "${schema}".absences a
         JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
         WHERE a.employee_id = $1
         ORDER BY a.created_at DESC LIMIT 50`,
        [employeeId]
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /absences/balances
  fastify.get('/balances', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Soldes congés CI' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.query as { employeeId?: string }
      const year = new Date().getFullYear()
      const role = request.user.role

      // OWASP A01 (IDOR) — le paramètre `employeeId` n'est PAS de confiance :
      //  - rôles RH (admin/hr_manager/hr_officer) : portée tenant → param honoré ;
      //  - manager : uniquement son équipe directe (ou lui-même), sinon 403 ;
      //  - tout autre rôle (employee, readonly, dg…) : forcé sur SON dossier,
      //    le param est ignoré (même règle que GET /absences/my-absences).
      const isHrRole = ['admin', 'hr_manager', 'hr_officer'].includes(role)
      let empId: string | null
      if (isHrRole) {
        empId = employeeId ?? request.user.employeeId ?? null
      } else if (role === 'manager' && employeeId) {
        let managerEmpId: string | null = request.user.employeeId ?? null
        if (!managerEmpId) {
          const m = await rawPool.query(
            actorEmployeeSql(schema), [request.user.email]
          )
          managerEmpId = m.rows[0]?.id ?? null
        }
        const allowed = await managerCanViewEmployee(schema, managerEmpId, employeeId)
        if (!allowed) {
          return reply.status(403).send({
            error: 'Vous ne pouvez consulter que les soldes de votre équipe directe',
          })
        }
        empId = employeeId
      } else {
        empId = request.user.employeeId ?? null
      }

      if (!empId) {
        const r = await rawPool.query(
          actorEmployeeSql(schema), [request.user.email]
        )
        empId = r.rows[0]?.id ?? null
      }
      if (!empId) return reply.send({ data: [] })
      // Acquisition mensuelle des congés payés mise à jour avant lecture
      // (sans effet en mode manuel ; un échec laisse le solde stocké).
      const policy = await loadLeavePolicyForEmployee(rawPool, schema, empId)
      if (policy.accrualMode === 'monthly') await refreshPaidLeaveBalance(rawPool, schema, empId, policy)
      const res = await rawPool.query(
        `SELECT ab.*, at.label, at.code, at.color
         FROM "${schema}".absence_balances ab
         JOIN "${schema}".absence_types at ON at.id = ab.absence_type_id
         WHERE ab.employee_id = $1 AND ab.year = $2`,
        [empId, year]
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /absences/types
  fastify.get('/types', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Types d\'absences CI' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT * FROM "${schema}".absence_types WHERE is_active = true ORDER BY label`
      )
      // Maternité : durée légale du pays du tenant (pré-remplissage du formulaire ;
      // la demande est contrôlée sur le pack de la filiale de l'employée)
      const rows = res.rows as Array<{ code?: string }>
      if (!rows.some((r) => isMaternityCode(r.code))) return reply.send({ data: rows })
      const ctx = await loadEmployeeTenantContext(rawPool, schema, null).catch(() => null)
      const rule = maternityRule(ctx?.legislation.legislationPack.leaveRules)
      return reply.send({ data: rows.map((r) => (isMaternityCode(r.code) && rule ? { ...r, maternity_rule: rule } : r)) })
    },
  })

  // POST /absences
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Créer une demande d\'absence' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 : validation stricte du body (rejette champs arbitraires)
      const parsed = createAbsenceSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données de demande invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      // OWASP A01 (IDOR) — saisie pour autrui : l'équipe RH pour tout salarié,
      // un responsable pour son équipe (sa branche). Les autres saisissent pour
      // eux-mêmes (body.employeeId ignoré).
      const isHrRole = isHrDecisionRole(request.user.role)
      let employeeId: string | null = request.user.employeeId ?? null
      if (body.employeeId && body.employeeId !== employeeId) {
        if (isHrRole) {
          employeeId = body.employeeId
        } else {
          const creatorEmp = await actorEmployeeId(schema, request.user)
          const chain = creatorEmp ? managerChain(body.employeeId, await loadManagerMap(rawPool, schema), 10) : []
          if (creatorEmp && chain.includes(creatorEmp)) {
            employeeId = body.employeeId
          } else if (request.user.role === 'manager') {
            return reply.status(403).send({ error: 'Vous ne pouvez saisir une absence que pour vous-même ou votre équipe' })
          }
        }
      }
      if (!employeeId) {
        const r = await rawPool.query(
          actorEmployeeSql(schema), [request.user.email]
        )
        if (r.rows[0]) {
          employeeId = r.rows[0].id as string
        } else {
          return reply.status(422).send({ error: 'Aucun dossier employé associé à ce compte. Contactez votre RH.' })
        }
      }

      // Décompte selon le type (jours ouvrables hors dimanche et fériés CI —
      // ABS-008 — ou jours calendaires) + durée légale de la maternité.
      const start = new Date(body.startDate)
      const rules = await resolveAbsenceRequest(rawPool, schema, employeeId, body.absenceTypeId,
        body.startDate, body.endDate, body.maternity)
      if (rules.maternity && !rules.maternity.ok) {
        return reply.status(422).send({ error: rules.maternity.error, allowedDays: rules.maternity.allowedDays })
      }
      let days = rules.days
      if (body.halfDay && rules.mode === 'working_days') days = 0.5

      // Délai de prévenance (absences planifiables) — la RH peut régulariser.
      const settings = await loadWorkflowSettings(rawPool, schema, 'absences')
      if (!isHrRole) {
        const noticeError = checkNotice(settings.notice, rules.code, days, body.startDate, new Date())
        if (noticeError) return reply.status(422).send({ error: noticeError, code: 'NOTICE_TOO_SHORT' })
      }

      // Congés payés : contrôle du solde acquis à date (paramétrable par tenant)
      const leaveCheck = await checkPaidLeaveRequest(rawPool, schema, employeeId, body.absenceTypeId, days)
      if (leaveCheck?.blocked) {
        return reply.status(422).send({
          error: `Solde de congés payés insuffisant : ${leaveCheck.available} j disponible(s), ${days} j demandé(s).`,
          balance: leaveCheck.balance,
        })
      }

      // Saisie par un responsable de la chaîne : vaut visa jusqu'à son niveau.
      let validationLevel = 0
      const trail: ApprovalTrailEntry[] = []
      if (employeeId !== (request.user.employeeId ?? null)) {
        const creator = await actorOf(schema, request.user)
        const steps = stepsFor(settings.levels, await loadManagerMap(rawPool, schema), employeeId)
        validationLevel = initialValidationLevel(steps, creator.employeeId, employeeId)
        for (let i = 0; i < validationLevel; i++) trail.push({ ...trailEntry(i, steps[i]!, creator, false), onCreation: true })
      }

      const res = await rawPool.query(
        `INSERT INTO "${schema}".absences
           (employee_id, absence_type_id, start_date, end_date, days, half_day, reason,
            status, created_by, validation_level, approval_trail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'submitted',$8,$9,$10::jsonb) RETURNING *`,
        [employeeId, body.absenceTypeId, body.startDate, body.endDate, days, body.halfDay ?? false, body.reason ?? null,
         request.user.sub, validationLevel, JSON.stringify(trail)]
      )

      // Incrémenter pending dans absence_balances
      const year = start.getFullYear()
      await rawPool.query(
        `UPDATE "${schema}".absence_balances
         SET pending = pending + $1, remaining = remaining - $1, updated_at = now()
         WHERE employee_id = $2 AND absence_type_id = $3 AND year = $4`,
        [days, employeeId, body.absenceTypeId, year]
      ).catch(() => undefined)

      // OWASP A09 : trace de la création de demande
      auditLogAbsence(schema, request.user.sub, 'absence.created', res.rows[0].id, {
        employeeId, absenceTypeId: body.absenceTypeId,
        startDate: body.startDate, endDate: body.endDate, days,
      }, request.ip ?? null)

      // ABS-002 — notifier le manager de la nouvelle demande (non bloquant, crash-safe)
      const newAbsenceId = res.rows[0].id as string
      void (async () => {
        try {
          const r = await rawPool.query<{
            manager_user_id: string | null; manager_email: string | null; manager_first: string | null
            first_name: string; last_name: string; type_label: string | null
          }>(
            `SELECT m.user_id AS manager_user_id, m.email AS manager_email, m.first_name AS manager_first,
                    e.first_name, e.last_name,
                    (SELECT label FROM "${schema}".absence_types WHERE id = $2) AS type_label
               FROM "${schema}".employees e LEFT JOIN "${schema}".employees m ON m.id = e.manager_id
              WHERE e.id = $1 LIMIT 1`, [employeeId, body.absenceTypeId],
          )
          const row = r?.rows?.[0]
          if (!row) return
          const employeeName = `${row.first_name} ${row.last_name}`.trim()
          // Notification in-app (ABS-002)
          if (row.manager_user_id) notifyUser(schema, row.manager_user_id, 'absence_request',
            'Nouvelle demande d\'absence',
            `${employeeName} a soumis une demande d'absence du ${body.startDate} au ${body.endDate} (${days} j) — à valider.`,
            { absenceId: newAbsenceId, employeeId })
          // Email manager (ABS-016) — best-effort, via le SMTP du TENANT s'il est
          // configuré (Paramètres → Email), sinon repli sur le SMTP plateforme
          // (comme tous les autres envois au nom du tenant).
          if (row.manager_email) {
            const mail = await loadTenantMailBySchema(schema).catch(() => null)
            if (mail?.smtp || config.smtp.user) {
              await sendAbsenceRequestEmail({
                to: row.manager_email, managerName: row.manager_first || 'Manager', employeeName,
                absenceType: row.type_label || 'Absence', startDate: body.startDate, endDate: body.endDate, days,
                reason: body.reason ?? null, tenantName: mail?.name || 'NexusRH CI',
                primaryColor: mail?.primaryColor ?? null, approvalUrl: `${config.appUrl}/absences`,
                from: mail?.from, replyTo: mail?.from, smtp: mail?.smtp ?? null,
              }).catch(() => undefined)
            }
          }
        } catch { /* non bloquant */ }
      })()

      return reply.status(201).send({
        data: res.rows[0],
        ...(leaveCheck?.insufficient
          ? { warning: `Solde de congés payés dépassé : ${leaveCheck.available} j disponible(s), ${days} j demandé(s).` }
          : rules.maternity?.warning ? { warning: rules.maternity.warning } : {}),
      })
    },
  })

  // PATCH /absences/:id/approve
  fastify.patch('/:id/approve', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    schema: { tags: ['absences'], summary: 'Approuver une absence (workflow multi-niveaux)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const schema = request.user.schemaName

      const settings = await loadWorkflowSettings(rawPool, schema, 'absences')

      const cur = await rawPool.query<{
        validation_level: number; status: string; employee_id: string; days: number; absence_type_id: string
        created_at?: string; approval_trail?: ApprovalTrailEntry[] | null
      }>(
        `SELECT validation_level, status, employee_id, days, absence_type_id, created_at, approval_trail
         FROM "${schema}".absences WHERE id = $1`, [id]
      )
      const absence = cur.rows[0]
      if (!absence) return reply.status(404).send({ error: 'Absence introuvable' })
      if (absence.status === 'approved') return reply.status(422).send({ error: 'Déjà approuvée' })
      if (absence.status === 'rejected') return reply.status(422).send({ error: 'Déjà rejetée' })

      // Circuit N+1 … N+n → RH (OWASP A01) : le valideur de l'étape agit ;
      // l'équipe RH prend la main une fois l'échéance dépassée. Jamais sur soi.
      const actor = await actorOf(schema, request.user)
      const ev = evaluateRequest(settings, await loadManagerMap(rawPool, schema), {
        employeeId: absence.employee_id, validationLevel: absence.validation_level, status: 'submitted',
        submittedAt: new Date(absence.created_at ?? Date.now()), trail: absence.approval_trail ?? [],
      }, actor)
      if (!ev.decision.allowed) {
        return reply.status(403).send({ error: denialMessage(ev.decision.reason, ev.step, 'absence') })
      }
      const { steps, index, step } = ev
      const override = ev.decision.override
      const isApproved = step.kind === 'hr'
      const nextLevel = index + 1

      const res = await rawPool.query(
        `UPDATE "${schema}".absences SET
           validation_level = $1, status = $2,
           approved_by = $3, approved_at = $4, updated_at = now(),
           approval_trail = COALESCE(approval_trail, '[]'::jsonb) || $6::jsonb
         WHERE id = $5 RETURNING *`,
        [nextLevel, isApproved ? 'approved' : 'submitted',
         isApproved ? request.user.sub : null,
         isApproved ? new Date() : null, id, JSON.stringify([trailEntry(index, step, actor, override)])]
      )

      if (isApproved) {
        const year = new Date(res.rows[0].start_date).getFullYear()
        await rawPool.query(
          `UPDATE "${schema}".absence_balances
           SET taken = taken + $1, pending = pending - $1, updated_at = now()
           WHERE employee_id = $2 AND absence_type_id = $3 AND year = $4`,
          [absence.days, absence.employee_id, absence.absence_type_id, year]
        ).catch(() => undefined)
      }

      // OWASP A09 : trace de l'approbation (niveau workflow + fully approved)
      auditLogAbsence(schema, request.user.sub,
        isApproved ? 'absence.approved' : 'absence.approval_step',
        id,
        { level: nextLevel, totalLevels: steps.length, fullyApproved: isApproved,
          step: step.kind === 'hr' ? 'hr' : `n+${step.level}`, escalated: override,
          employeeId: absence.employee_id },
        request.ip ?? null)

      if (isApproved) {
        emitIntegrationEvent(rawPool, schema, 'absence.approved', {
          id, employeeId: absence.employee_id, days: absence.days,
        }, decryptIfPresent)
        // ABS-004 — notifier l'employé de l'approbation (non bloquant)
        void userIdOfEmployee(schema, absence.employee_id).then(uid => notifyUser(
          schema, uid, 'absence_approved', 'Absence approuvée',
          `Votre demande d'absence (${absence.days} j) a été approuvée.`, { absenceId: id }))
      }

      const next = steps[nextLevel]
      if (!isApproved && next?.kind === 'manager') {
        // Étape suivante hiérarchique : prévenir le responsable (la RH voit la file).
        void userIdOfEmployee(schema, next.approverEmployeeId).then(uid => notifyUser(
          schema, uid, 'absence_request', 'Absence à viser',
          `Une demande d'absence (${absence.days} j) attend votre visa (N+${next.level}).`, { absenceId: id }))
      }

      return reply.send({
        data: res.rows[0],
        message: isApproved
          ? 'Absence approuvée'
          : `Étape ${nextLevel}/${steps.length} validée — suite : ${next ? stepLabel(next) : 'validation RH'}`,
        fullyApproved: isApproved,
      })
    },
  })

  // PATCH /absences/:id/reject
  fastify.patch('/:id/reject', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    schema: { tags: ['absences'], summary: 'Refuser une absence' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { reason } = (request.body as { reason?: string }) ?? {}
      const schema = request.user.schemaName

      const cur = await rawPool.query<{
        employee_id: string; days: number; absence_type_id: string; start_date: string
        validation_level?: number; status?: string; created_at?: string; approval_trail?: ApprovalTrailEntry[] | null
      }>(
        `SELECT employee_id, days, absence_type_id, start_date, validation_level, status, created_at, approval_trail
         FROM "${schema}".absences WHERE id = $1`, [id]
      )
      const absence = cur.rows[0]
      if (!absence) return reply.status(404).send({ error: 'Absence introuvable' })
      if (absence.status && !PENDING_STATUSES.includes(absence.status)) {
        return reply.status(422).send({ error: 'Seule une demande en attente peut être refusée' })
      }

      // OWASP A01 : refus par le valideur de l'étape (ou la RH après échéance),
      // jamais par le demandeur lui-même.
      const actor = await actorOf(schema, request.user)
      const settings = await loadWorkflowSettings(rawPool, schema, 'absences')
      const ev = evaluateRequest(settings, await loadManagerMap(rawPool, schema), {
        employeeId: absence.employee_id, validationLevel: absence.validation_level ?? 0, status: 'submitted',
        submittedAt: new Date(absence.created_at ?? Date.now()), trail: absence.approval_trail ?? [],
      }, actor)
      if (!ev.decision.allowed) {
        return reply.status(403).send({ error: denialMessage(ev.decision.reason, ev.step, 'absence') })
      }

      const res = await rawPool.query(
        `UPDATE "${schema}".absences SET status = 'rejected', rejection_reason = $1,
         rejected_by = $2, updated_at = now() WHERE id = $3 RETURNING *`,
        [reason ?? null, request.user.sub, id]
      )

      // Remettre le pending
      const year = new Date(absence.start_date).getFullYear()
      await rawPool.query(
        `UPDATE "${schema}".absence_balances
         SET pending = pending - $1, remaining = remaining + $1, updated_at = now()
         WHERE employee_id = $2 AND absence_type_id = $3 AND year = $4`,
        [absence.days, absence.employee_id, absence.absence_type_id, year]
      ).catch(() => undefined)

      // OWASP A09 : trace du rejet (motif inclus)
      auditLogAbsence(schema, request.user.sub, 'absence.rejected', id, {
        employeeId: absence.employee_id, reason: reason ?? null,
      }, request.ip ?? null)

      // ABS-005 — notifier l'employé du refus + motif (non bloquant)
      void userIdOfEmployee(schema, absence.employee_id).then(uid => notifyUser(
        schema, uid, 'absence_rejected', 'Absence refusée',
        `Votre demande d'absence a été refusée.${reason ? ' Motif : ' + reason : ''}`,
        { absenceId: id, reason: reason ?? null }))

      return reply.send({ data: res.rows[0] })
    },
  })

  // PATCH /absences/:id/cancel — l'employé annule SA propre demande en attente
  fastify.patch('/:id/cancel', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Annuler ma demande d\'absence en attente (self-service)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const schema = request.user.schemaName

      // Résolution de l'employeeId du demandeur (token, sinon lookup par email)
      let employeeId: string | null = request.user.employeeId ?? null
      if (!employeeId) {
        const r = await rawPool.query(
          actorEmployeeSql(schema), [request.user.email]
        )
        employeeId = r.rows[0]?.id ?? null
      }
      if (!employeeId) {
        return reply.status(422).send({ error: 'Aucun dossier employé associé à ce compte. Contactez votre RH.' })
      }

      const cur = await rawPool.query<{ employee_id: string; days: number; absence_type_id: string; start_date: string; status: string }>(
        `SELECT employee_id, days, absence_type_id, start_date, status
         FROM "${schema}".absences WHERE id = $1`, [id]
      )
      const absence = cur.rows[0]
      if (!absence) return reply.status(404).send({ error: 'Absence introuvable' })

      // OWASP A01 (IDOR) — un employé ne peut annuler QUE sa propre demande.
      // On répond 404 (et non 403) pour ne pas divulguer l'existence d'une
      // absence appartenant à un autre employé.
      if (absence.employee_id !== employeeId) {
        return reply.status(404).send({ error: 'Absence introuvable' })
      }

      // Annulation autorisée uniquement tant que la demande est en attente
      // (statut 'pending' à la création, ou 'submitted' en cours de workflow).
      if (absence.status !== 'pending' && absence.status !== 'submitted') {
        return reply.status(409).send({
          error: 'Seule une demande en attente peut être annulée',
        })
      }

      const res = await rawPool.query(
        `UPDATE "${schema}".absences
         SET status = 'cancelled', updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id]
      )

      // Restaurer le solde "pending" décrémenté à la création
      const year = new Date(absence.start_date).getFullYear()
      await rawPool.query(
        `UPDATE "${schema}".absence_balances
         SET pending = pending - $1, remaining = remaining + $1, updated_at = now()
         WHERE employee_id = $2 AND absence_type_id = $3 AND year = $4`,
        [absence.days, absence.employee_id, absence.absence_type_id, year]
      ).catch(() => undefined)

      // OWASP A09 : trace de l'annulation par l'employé
      auditLogAbsence(schema, request.user.sub, 'absence.cancelled', id, {
        employeeId: absence.employee_id, days: absence.days,
      }, request.ip ?? null)

      return reply.send({ data: res.rows[0] })
    },
  })
}

export default absencesRoutes
