import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'
import { calculatePayrollCI, type AbsencePayrollInfo } from '../../services/payroll-engine-ci.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

const rawPool = new Pool({ connectionString: config.database.url })

// ── Helper : calcul des jours ouvrables d'un mois (lundi–samedi, hors dimanche) ──
// Parse 'YYYY-MM' avec validation stricte → évite NaN dans les calculs paie.
// OWASP A04 (Insecure Design) : refuser dès l'entrée plutôt que produire des
// résultats corrompus en aval.
function parseMonth(month: string): { year: number; monthNum: number } | null {
  if (!month || typeof month !== 'string') return null
  const m = month.match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  const year = parseInt(m[1]!, 10)
  const monthNum = parseInt(m[2]!, 10)
  if (!Number.isFinite(year) || year < 2000 || year > 2100) return null
  if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return null
  return { year, monthNum }
}

function getWorkingDays(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate()
  let count = 0
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month - 1, d).getDay() !== 0) count++
  }
  return count
}

// ── Helper : ancienneté en années complètes ────────────────────────────────────
function getAnciennete(hireDateStr: string, refDate: Date): number {
  const hire = new Date(hireDateStr)
  let years = refDate.getFullYear() - hire.getFullYear()
  const m = refDate.getMonth() - hire.getMonth()
  if (m < 0 || (m === 0 && refDate.getDate() < hire.getDate())) years--
  return Math.max(0, years)
}

// ── Helper : taux de maintien maladie selon ancienneté (Convention collective CI) ──
function getMaintienTauxMaladie(anciennete: number): number {
  if (anciennete < 1)  return 0.50  // < 1 an : 50%
  if (anciennete < 5)  return 0.75  // 1–4 ans : 75%
  return 1.00                        // ≥ 5 ans : 100%
}

// ── Helper : résolution de l'absence principale du mois pour la paie ──────────
// Priorité : maternite > accident_travail > maladie_sans_at
// Retourne null si aucune absence validée impactant la paie
async function resolveAbsenceForPayroll(
  schema: string,
  employeeId: string,
  month: string, // 'YYYY-MM'
  hireDateStr: string | null,
): Promise<{ info: AbsencePayrollInfo; absenceDays: number; workedDays: number; workingDaysMonth: number } | null> {
  const [year, monthNum] = month.split('-').map(Number)
  if (!year || !monthNum) return null

  const workingDaysMonth = getWorkingDays(year, monthNum)
  const monthStart = `${month}-01`
  const daysInMonth = new Date(year, monthNum, 0).getDate()
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`

  // Récupérer toutes les absences approuvées du mois
  const absRes = await rawPool.query<{
    absence_type_slug: string
    start_date: string
    end_date: string
    days_count: number
  }>(
    `SELECT at.slug AS absence_type_slug, a.start_date, a.end_date,
            COALESCE(a.days_count, a.end_date::date - a.start_date::date + 1) AS days_count
     FROM "${schema}".absences a
     JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
     WHERE a.employee_id = $1
       AND a.status = 'approved'
       AND a.start_date <= $2
       AND a.end_date   >= $3`,
    [employeeId, monthEnd, monthStart]
  )

  if (absRes.rows.length === 0) return null

  // Calculer les jours d'absence réels dans le mois (chevauchement)
  let materniteDay = 0
  let atDays = 0; let atJourAccidentInMonth = false
  let maladieDays = 0

  for (const row of absRes.rows) {
    const start = new Date(Math.max(new Date(row.start_date).getTime(), new Date(monthStart).getTime()))
    const end   = new Date(Math.min(new Date(row.end_date).getTime(), new Date(monthEnd).getTime()))
    // Compter jours ouvrables dans l'intersection
    let days = 0
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0) days++ // lundi–samedi
    }

    const slug = (row.absence_type_slug ?? '').toLowerCase()
    if (slug.includes('maternit')) {
      materniteDay += days
    } else if (slug.includes('accident') || slug.includes('_at')) {
      // Jour J = premier jour d'arrêt (payé employeur)
      const startMonth = new Date(row.start_date)
      atJourAccidentInMonth = startMonth >= new Date(monthStart) && startMonth <= new Date(monthEnd)
      atDays += days
    } else if (slug.includes('maladi') || slug.includes('maladie')) {
      maladieDays += days
    }
  }

  // Priorité : maternite > AT > maladie
  let absenceDays = 0
  let info: AbsencePayrollInfo | null = null

  if (materniteDay > 0) {
    absenceDays = Math.min(materniteDay, workingDaysMonth)
    info = { type: 'maternite', absenceDays }
  } else if (atDays > 0) {
    absenceDays = Math.min(atDays, workingDaysMonth)
    info = { type: 'accident_travail', absenceDays, atJourAccidentInMonth }
  } else if (maladieDays > 0) {
    absenceDays = Math.min(maladieDays, workingDaysMonth)
    const anciennete = hireDateStr ? getAnciennete(hireDateStr, new Date()) : 0
    const maintienTaux = getMaintienTauxMaladie(anciennete)
    info = { type: 'maladie_sans_at', absenceDays, maintienTaux }
  }

  if (!info) return null

  const workedDays = Math.max(0, workingDaysMonth - absenceDays)
  return { info, absenceDays, workedDays, workingDaysMonth }
}

const payrollRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // POST /payroll/calculate — calcul d'un bulletin CI (avec absences)
  fastify.post('/calculate', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    schema: { tags: ['payroll'], summary: 'Calculer un bulletin de paie CI (CNPS + ITS + absences)' },
    handler: async (request, reply) => {
      const { employeeId, month } = request.body as { employeeId: string; month: string }
      const schema = request.user.schemaName

      const empRes = await rawPool.query<{
        id: string; base_salary: string; marital_status: string; children_count: number
        first_name: string; last_name: string; cnps_number: string; nni: string
        mobile_money_provider: string; mobile_money_phone: string; hire_date: string | null
      }>(
        `SELECT id, base_salary, marital_status, children_count,
                first_name, last_name, cnps_number, nni,
                mobile_money_provider, mobile_money_phone, hire_date
         FROM "${schema}".employees WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [employeeId]
      )
      const emp = empRes.rows[0]
      if (!emp) return reply.status(404).send({ error: 'Employé introuvable' })

      const tenantRes = await rawPool.query<{ at_rate: string }>(
        `SELECT at_rate FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const atRate = parseFloat(tenantRes.rows[0]?.at_rate ?? '0.020')

      const periodRes = await rawPool.query<{ id: string }>(
        `SELECT id FROM "${schema}".pay_periods WHERE month = $1 LIMIT 1`, [month]
      )
      const periodId = periodRes.rows[0]?.id

      const varEls: Record<string, number> = {}
      if (periodId) {
        const velRes = await rawPool.query<{ rule_code: string; amount: string }>(
          `SELECT rule_code, amount FROM "${schema}".variable_elements
           WHERE employee_id = $1 AND period_id = $2`,
          [employeeId, periodId]
        )
        for (const v of velRes.rows) varEls[v.rule_code] = parseInt(v.amount)
      }

      const parsed = parseMonth(month)
      if (!parsed) {
        return reply.status(400).send({ error: 'Format mois invalide (attendu : YYYY-MM)' })
      }
      const { year, monthNum } = parsed
      const workingDaysMonth = getWorkingDays(year, monthNum)

      // Résolution absence du mois
      const absenceCtx = await resolveAbsenceForPayroll(schema, employeeId, month, emp.hire_date)

      const result = calculatePayrollCI({
        baseSalary:       parseInt(emp.base_salary),
        workedDays:       absenceCtx ? absenceCtx.workedDays : workingDaysMonth,
        workingDaysMonth,
        atRate,
        maritalStatus:    emp.marital_status ?? 'single',
        childrenCount:    emp.children_count ?? 0,
        variableElements: varEls,
        absence:          absenceCtx?.info,
      })

      return reply.send({
        employee: {
          id: emp.id,
          firstName: emp.first_name, lastName: emp.last_name,
          cnpsNumber: emp.cnps_number, nni: emp.nni,
          mobileMoneyProvider: emp.mobile_money_provider,
          mobileMoneyPhone:    emp.mobile_money_phone,
        },
        month,
        absence: absenceCtx ? {
          type:        absenceCtx.info.type,
          absenceDays: absenceCtx.absenceDays,
          workedDays:  absenceCtx.workedDays,
          maintienTaux: absenceCtx.info.type === 'maladie_sans_at' ? absenceCtx.info.maintienTaux : undefined,
        } : null,
        result,
        currency: 'XOF',
      })
    },
  })

  // POST /payroll/periods/:month/close — clôture mensuelle (avec absences)
  fastify.post('/periods/:month/close', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    schema: { tags: ['payroll'], summary: 'Clôturer une période de paie CI' },
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      const schema = request.user.schemaName

      const existing = await rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".pay_periods WHERE month = $1 LIMIT 1`, [month]
      )
      if (existing.rows[0]?.status === 'closed') {
        return reply.status(422).send({ error: 'Période déjà clôturée' })
      }

      const emps = await rawPool.query<{
        id: string; base_salary: string; marital_status: string; children_count: number
        mobile_money_provider: string; mobile_money_phone: string
        first_name: string; last_name: string; cnps_number: string; nni: string
        hire_date: string | null
      }>(
        `SELECT id, base_salary, marital_status, children_count,
                mobile_money_provider, mobile_money_phone,
                first_name, last_name, cnps_number, nni, hire_date
         FROM "${schema}".employees WHERE is_active = true AND deleted_at IS NULL`
      )

      const tenantRes = await rawPool.query<{ at_rate: string }>(
        `SELECT at_rate FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const atRate = parseFloat(tenantRes.rows[0]?.at_rate ?? '0.020')

      const parsed = parseMonth(month)
      if (!parsed) {
        return reply.status(400).send({ error: 'Format mois invalide (attendu : YYYY-MM)' })
      }
      const { year, monthNum } = parsed
      const workingDaysMonth = getWorkingDays(year, monthNum)

      let periodId: string
      if (existing.rows[0]) {
        periodId = existing.rows[0].id
      } else {
        const pRes = await rawPool.query<{ id: string }>(
          `INSERT INTO "${schema}".pay_periods (month) VALUES ($1) RETURNING id`, [month]
        )
        periodId = pRes.rows[0]?.id ?? ''
      }

      let totalGross = 0; let totalNet = 0; let totalCnps = 0; let totalIts = 0
      const paySlips: unknown[] = []

      for (const emp of emps.rows) {
        const varEls: Record<string, number> = {}
        const velRes = await rawPool.query<{ rule_code: string; amount: string }>(
          `SELECT rule_code, amount FROM "${schema}".variable_elements
           WHERE employee_id = $1 AND period_id = $2`, [emp.id, periodId]
        )
        for (const v of velRes.rows) varEls[v.rule_code] = parseInt(v.amount)

        // Résolution absence pour cet employé ce mois-ci
        const absenceCtx = await resolveAbsenceForPayroll(schema, emp.id, month, emp.hire_date)

        const result = calculatePayrollCI({
          baseSalary:       parseInt(emp.base_salary),
          workedDays:       absenceCtx ? absenceCtx.workedDays : workingDaysMonth,
          workingDaysMonth,
          atRate,
          maritalStatus:    emp.marital_status ?? 'single',
          childrenCount:    emp.children_count ?? 0,
          variableElements: varEls,
          absence:          absenceCtx?.info,
        })

        totalGross += result.grossSalary
        totalNet   += result.netPayable
        totalCnps  += result.totalCnpsSal + result.totalCnpsPat
        totalIts   += result.its

        // Sérialiser le bordereau CNPS s'il existe
        const bordereauJson = result.bordereauCnps ? JSON.stringify(result.bordereauCnps) : null

        const slip = await rawPool.query(
          `INSERT INTO "${schema}".pay_slips
             (employee_id, period_id, month, base_salary, gross_salary,
              cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
              total_cnps_sal, total_cnps_pat, its, total_deductions,
              net_payable, employer_cost, lines, status, generated_at,
              payment_method, payment_status, bordereau_cnps, indemnite_absence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'generated',now(),$17,'pending',$18::jsonb,$19)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            emp.id, periodId, month, emp.base_salary, result.grossSalary,
            result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
            result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
            result.netPayable, result.employerCost, JSON.stringify(result.lines),
            emp.mobile_money_provider ?? 'mobile_money',
            bordereauJson,
            result.indemniteAbsence ?? null,
          ]
        )
        if (slip.rows[0]) paySlips.push({
          employeeId: emp.id,
          paySlipId: slip.rows[0].id,
          netPayable: result.netPayable,
          hasAbsence: !!absenceCtx,
          absenceType: absenceCtx?.info.type ?? null,
          hasBordereauCnps: !!result.bordereauCnps,
        })
      }

      // Workflow 2-yeux OBLIGATOIRE (OWASP A04 — Segregation of Duties) :
      // L'initiateur calcule et clôture en `pending_validation`. Un VALIDATEUR
      // différent (POST /periods/:month/validate) confirme pour passer à `closed`.
      // Aucun bypass possible — l'initiateur ne peut PAS auto-valider.
      await rawPool.query(
        `UPDATE "${schema}".pay_periods SET
           status = 'pending_validation',
           initiated_at = now(), initiated_by = $1,
           total_gross = $2, total_net = $3, total_cnps = $4, total_its = $5
         WHERE id = $6`,
        [request.user.sub, totalGross, totalNet, totalCnps, totalIts, periodId]
      )

      const absenceCount = paySlips.filter((s: any) => s.hasAbsence).length
      const bordereauCount = paySlips.filter((s: any) => s.hasBordereauCnps).length

      return reply.send({
        message: `Période ${month} en attente de validation — ${emps.rows.length} bulletins générés. Demandez à un autre admin/hr_manager de valider via POST /payroll/periods/${month}/validate.`,
        periodId,
        status: 'pending_validation',
        employeesCount: emps.rows.length,
        absencesIntegrées: absenceCount,
        bordereauCnpsCount: bordereauCount,
        totals: {
          grossSalary: totalGross, netPayable: totalNet,
          cnps: totalCnps, its: totalIts,
          currency: 'XOF',
        },
        paySlips,
      })
    },
  })

  // ── Workflow paramétrable de validation paie ────────────────────────────
  // Cycle : open → pending_validation (via /close) → N approvals → closed
  // OWASP A04 : Segregation of Duties strictement appliquée.
  // workflow_configs.levels_count détermine le nombre d'approbations requises.

  // GET /payroll/periods/:month/workflow — état du workflow (timeline)
  fastify.get('/periods/:month/workflow', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      const schema = request.user.schemaName
      const period = await rawPool.query<{
        id: string; month: string; status: string
        initiated_at: string | null; initiated_by: string | null
        rejection_reason: string | null; closed_at: string | null; closed_by: string | null
        initiator_first_name: string | null; initiator_last_name: string | null
      }>(
        `SELECT p.id, p.month, p.status, p.initiated_at, p.initiated_by,
                p.rejection_reason, p.closed_at, p.closed_by,
                ui.first_name AS initiator_first_name,
                ui.last_name  AS initiator_last_name
           FROM "${schema}".pay_periods p
           LEFT JOIN "${schema}".users ui ON ui.id = p.initiated_by
           WHERE p.month = $1 AND p.parent_period_id IS NULL LIMIT 1`,
        [month],
      )
      if (!period.rows[0]) return reply.status(404).send({ error: 'Période introuvable' })
      const p = period.rows[0]

      const cfg = await rawPool.query<{ levels_count: number }>(
        `SELECT levels_count FROM "${schema}".workflow_configs WHERE module = 'payroll' LIMIT 1`,
      )
      const requiredLevels = cfg.rows[0]?.levels_count ?? 2

      const approvals = await rawPool.query<{
        level: number; approver_id: string; approver_role: string | null
        approved_at: string; notes: string | null
        first_name: string | null; last_name: string | null
      }>(
        `SELECT a.level, a.approver_id, a.approver_role, a.approved_at, a.notes,
                u.first_name, u.last_name
           FROM "${schema}".pay_period_approvals a
           LEFT JOIN "${schema}".users u ON u.id = a.approver_id
          WHERE a.period_id = $1
          ORDER BY a.level ASC`,
        [p.id],
      )

      const initiatorName = [p.initiator_first_name, p.initiator_last_name].filter(Boolean).join(' ') || null

      return reply.send({
        period: {
          id: p.id, month: p.month, status: p.status,
          initiatedAt: p.initiated_at, initiatedBy: p.initiated_by,
          initiatorName,
          rejectionReason: p.rejection_reason,
          closedAt: p.closed_at, closedBy: p.closed_by,
        },
        requiredLevels,
        currentLevel: approvals.rows.length,
        isComplete: approvals.rows.length >= requiredLevels,
        approvals: approvals.rows.map(a => ({
          level: a.level,
          approverId: a.approver_id,
          approverRole: a.approver_role,
          approverName: [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
          approvedAt: a.approved_at,
          notes: a.notes,
        })),
      })
    },
  })

  // POST /payroll/periods/:month/approve — N+1 (ou plus) valide
  fastify.post('/periods/:month/approve', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      const { notes } = (request.body ?? {}) as { notes?: string }
      const schema = request.user.schemaName

      const period = await rawPool.query<{
        id: string; status: string; initiated_by: string | null
      }>(
        `SELECT id, status, initiated_by FROM "${schema}".pay_periods
           WHERE month = $1 AND parent_period_id IS NULL LIMIT 1`,
        [month],
      )
      if (!period.rows[0]) return reply.status(404).send({ error: 'Période introuvable' })
      const p = period.rows[0]

      if (p.status !== 'pending_validation') {
        return reply.status(409).send({
          error: `Période non éligible (status=${p.status}, attendu=pending_validation)`,
        })
      }
      // OWASP A04 SoD : l'initiateur ne peut PAS approuver
      if (p.initiated_by === request.user.sub) {
        return reply.status(403).send({
          error: 'Vous avez initié cette paie. Un autre approbateur est requis (séparation des tâches).',
        })
      }
      // L'approver ne doit pas avoir déjà approuvé à un niveau précédent
      const dup = await rawPool.query(
        `SELECT 1 FROM "${schema}".pay_period_approvals
           WHERE period_id = $1 AND approver_id = $2 LIMIT 1`,
        [p.id, request.user.sub],
      )
      if (dup.rows[0]) {
        return reply.status(403).send({
          error: 'Vous avez déjà approuvé un niveau précédent. Un autre approbateur est requis.',
        })
      }

      const cfg = await rawPool.query<{ levels_count: number }>(
        `SELECT levels_count FROM "${schema}".workflow_configs WHERE module = 'payroll' LIMIT 1`,
      )
      const requiredLevels = cfg.rows[0]?.levels_count ?? 2

      const currentCount = await rawPool.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM "${schema}".pay_period_approvals WHERE period_id = $1`,
        [p.id],
      )
      const nextLevel = (currentCount.rows[0]?.cnt ?? 0) + 1

      await rawPool.query(
        `INSERT INTO "${schema}".pay_period_approvals
           (period_id, level, approver_id, approver_role, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [p.id, nextLevel, request.user.sub, request.user.role, notes ?? null],
      )

      // Si on a atteint le nombre requis → clôture définitive
      if (nextLevel >= requiredLevels) {
        await rawPool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'closed', closed_at = now(), closed_by = $1
             WHERE id = $2`,
          [request.user.sub, p.id],
        )
        // Audit log (non bloquant)
        rawPool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'payroll.closed', 'pay_period', $2, $3, $4)`,
          [request.user.sub, p.id, JSON.stringify({ month, finalLevel: nextLevel, requiredLevels }), request.ip ?? null],
        ).catch(() => {})
        return reply.send({
          data: { status: 'closed', level: nextLevel, requiredLevels },
          message: `Paie ${month} validée à tous les niveaux requis et clôturée.`,
        })
      }

      return reply.send({
        data: { status: 'pending_validation', level: nextLevel, requiredLevels },
        message: `Validation niveau ${nextLevel}/${requiredLevels} enregistrée. ${requiredLevels - nextLevel} validation(s) restante(s).`,
      })
    },
  })

  // POST /payroll/periods/:month/reject — rejette et retour à open
  fastify.post('/periods/:month/reject', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      const { reason } = (request.body ?? {}) as { reason?: string }
      if (!reason || reason.trim().length < 5) {
        return reply.status(400).send({ error: 'Motif de rejet requis (min 5 caractères)' })
      }
      const schema = request.user.schemaName
      const period = await rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".pay_periods
           WHERE month = $1 AND parent_period_id IS NULL LIMIT 1`,
        [month],
      )
      if (!period.rows[0]) return reply.status(404).send({ error: 'Période introuvable' })
      const p = period.rows[0]
      if (p.status !== 'pending_validation') {
        return reply.status(409).send({
          error: `Période non éligible (status=${p.status}, attendu=pending_validation)`,
        })
      }
      // Reset : status → open, supprimer toutes les approbations partielles
      await rawPool.query(
        `DELETE FROM "${schema}".pay_period_approvals WHERE period_id = $1`,
        [p.id],
      )
      await rawPool.query(
        `UPDATE "${schema}".pay_periods
           SET status = 'open', rejection_reason = $1,
               initiated_at = NULL, initiated_by = NULL
           WHERE id = $2`,
        [reason, p.id],
      )
      rawPool.query(
        `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
         VALUES ($1, 'payroll.rejected', 'pay_period', $2, $3, $4)`,
        [request.user.sub, p.id, JSON.stringify({ month, reason }), request.ip ?? null],
      ).catch(() => {})
      return reply.send({ data: { status: 'open' }, message: 'Paie rejetée — retour à open. Re-calculer la paie après corrections.' })
    },
  })

  // GET /payroll/payslips — liste des bulletins
  fastify.get('/payslips', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    schema: { tags: ['payroll'], summary: 'Liste des bulletins de paie' },
    handler: async (request, reply) => {
      const { month, employeeId } = request.query as Record<string, string>
      const schema = request.user.schemaName
      let sql = `SELECT ps.*, e.first_name, e.last_name, e.cnps_number
                 FROM "${schema}".pay_slips ps
                 JOIN "${schema}".employees e ON e.id = ps.employee_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (month)      { sql += ` AND ps.month = $${idx++}`; params.push(month) }
      if (employeeId) { sql += ` AND ps.employee_id = $${idx++}`; params.push(employeeId) }
      sql += ` ORDER BY ps.month DESC, e.last_name`
      const res = await rawPool.query(sql, params)
      return reply.send({ data: res.rows })
    },
  })

  // GET /payroll/payslips/:id/transparency — drill-down complet d'un bulletin
  // Inspiration : Workday "Pay Explained" + PayFit Smart Lines + Gusto Pay Insights
  // Accessible par : admin/hr_manager/hr_officer/readonly (tous bulletins du tenant)
  //                 + employee (uniquement SES bulletins)
  fastify.get('/payslips/:id/transparency', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['payroll'], summary: 'Bulletin transparent — formules, comparaison, audit' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const schema = request.user.schemaName
      const role = request.user.role

      const slipRes = await rawPool.query<{
        id: string; employee_id: string; period_id: string; month: string
        base_salary: string; gross_salary: string; net_payable: string
        total_cnps_sal: string; total_cnps_pat: string; its: string
        employer_cost: string; total_deductions: string
        lines: unknown
        first_name: string; last_name: string; cnps_number: string | null
        nni: string | null; job_title: string | null
        period_status: string; initiated_at: string | null; closed_at: string | null
        generated_at: string | null; viewed_by_employee_at: string | null
        payment_status: string; payment_method: string; payment_reference: string | null
        paid_at: string | null
      }>(
        `SELECT ps.id, ps.employee_id, ps.period_id, ps.month,
                ps.base_salary, ps.gross_salary, ps.net_payable,
                ps.total_cnps_sal, ps.total_cnps_pat, ps.its,
                ps.employer_cost, ps.total_deductions, ps.lines,
                ps.generated_at, ps.viewed_by_employee_at,
                ps.payment_status, ps.payment_method, ps.payment_reference, ps.paid_at,
                e.first_name, e.last_name, e.cnps_number, e.nni, e.job_title,
                pp.status AS period_status, pp.initiated_at, pp.closed_at
           FROM "${schema}".pay_slips ps
           JOIN "${schema}".employees e ON e.id = ps.employee_id
           LEFT JOIN "${schema}".pay_periods pp ON pp.id = ps.period_id
          WHERE ps.id = $1 LIMIT 1`,
        [id],
      )
      if (!slipRes.rows[0]) return reply.status(404).send({ error: 'Bulletin introuvable' })
      const slip = slipRes.rows[0]

      // Garde-fou employee : ne peut voir que son propre bulletin
      if (role === 'employee') {
        let myEmployeeId = request.user.employeeId ?? null
        if (!myEmployeeId) {
          const me = await rawPool.query(
            `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email],
          )
          myEmployeeId = (me.rows[0] as { id?: string } | undefined)?.id ?? null
        }
        if (myEmployeeId !== slip.employee_id) {
          return reply.status(403).send({ error: 'Accès refusé à ce bulletin' })
        }
      } else if (!['admin','hr_manager','hr_officer','readonly','manager'].includes(role)) {
        return reply.status(403).send({ error: 'Rôle non autorisé' })
      }

      // Enrichir les lignes via le service explainer
      const { explainLines } = await import('../../services/payroll-explainer.service.js')
      const rawLines = Array.isArray(slip.lines) ? slip.lines : []
      const explained = explainLines(rawLines as never)

      // Comparaison : 3 mois précédents pour le même employé
      const compRes = await rawPool.query<{
        month: string; gross_salary: string; net_payable: string
        total_cnps_sal: string; its: string
      }>(
        `SELECT month, gross_salary, net_payable, total_cnps_sal, its
           FROM "${schema}".pay_slips
          WHERE employee_id = $1 AND id <> $2 AND month < $3
          ORDER BY month DESC LIMIT 3`,
        [slip.employee_id, id, slip.month],
      )

      // Audit : événements liés au bulletin ou à sa période
      const auditRes = await rawPool.query<{
        action: string; entity: string; created_at: string
        first_name: string | null; last_name: string | null
        changes: unknown
      }>(
        `SELECT a.action, a.entity, a.created_at, a.changes,
                u.first_name, u.last_name
           FROM "${schema}".audit_log a
           LEFT JOIN "${schema}".users u ON u.id = a.user_id
          WHERE (a.entity = 'payslip' AND a.entity_id = $1)
             OR (a.entity = 'pay_period' AND a.entity_id = $2)
          ORDER BY a.created_at DESC LIMIT 20`,
        [id, slip.period_id],
      )

      // Totaux gains / cotisations / retenues
      const totals = {
        earnings: explained.filter(l => l.type === 'earning').reduce((s, l) => s + Number(l.amount), 0),
        employeeContributions: explained
          .filter(l => l.type === 'employee_contribution' || l.type === 'deduction')
          .reduce((s, l) => s + Math.abs(Number(l.amount)), 0),
        employerContributions: explained
          .filter(l => l.type === 'employer_contribution')
          .reduce((s, l) => s + Number(l.amount), 0),
      }

      return reply.send({
        slip: {
          id: slip.id,
          month: slip.month,
          baseSalary: Number(slip.base_salary),
          grossSalary: Number(slip.gross_salary),
          netPayable: Number(slip.net_payable),
          totalCnpsSal: Number(slip.total_cnps_sal),
          totalCnpsPat: Number(slip.total_cnps_pat),
          its: Number(slip.its),
          employerCost: Number(slip.employer_cost),
          totalDeductions: Number(slip.total_deductions),
          generatedAt: slip.generated_at,
          viewedAt: slip.viewed_by_employee_at,
          paymentStatus: slip.payment_status,
          paymentMethod: slip.payment_method,
          paymentReference: slip.payment_reference,
          paidAt: slip.paid_at,
        },
        employee: {
          id: slip.employee_id,
          firstName: slip.first_name,
          lastName: slip.last_name,
          cnpsNumber: slip.cnps_number,
          nni: slip.nni,
          jobTitle: slip.job_title,
        },
        period: {
          id: slip.period_id,
          status: slip.period_status,
          initiatedAt: slip.initiated_at,
          closedAt: slip.closed_at,
        },
        lines: explained,
        totals,
        comparison: compRes.rows.map(r => ({
          month: r.month,
          grossSalary: Number(r.gross_salary),
          netPayable: Number(r.net_payable),
          totalCnpsSal: Number(r.total_cnps_sal),
          its: Number(r.its),
        })),
        audit: auditRes.rows.map(a => ({
          action: a.action,
          entity: a.entity,
          createdAt: a.created_at,
          actorName: [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
          changes: a.changes,
        })),
      })
    },
  })

  // GET /payroll/my-payslips — self-service employé
  fastify.get('/my-payslips', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['payroll'], summary: 'Mes bulletins de paie (self-service CI)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      let employeeId = request.user.employeeId ?? null
      if (!employeeId) {
        const r = await rawPool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        employeeId = r.rows[0]?.id ?? null
      }
      if (!employeeId) return reply.send({ data: [] })

      await rawPool.query(
        `UPDATE "${schema}".pay_slips
         SET viewed_by_employee_at = now()
         WHERE employee_id = $1 AND viewed_by_employee_at IS NULL`,
        [employeeId]
      )

      const res = await rawPool.query(
        `SELECT id, month, gross_salary, net_payable, its, total_cnps_sal,
                status, payment_method, payment_status, payment_reference,
                generated_at, viewed_by_employee_at, file_url, currency,
                indemnite_absence, bordereau_cnps
         FROM "${schema}".pay_slips
         WHERE employee_id = $1
         ORDER BY month DESC LIMIT 24`,
        [employeeId]
      )
      return reply.send({ data: res.rows, currency: 'XOF' })
    },
  })

  // GET /payroll/my-access-log — journal d'accès ARTCI
  fastify.get('/my-access-log', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['payroll'], summary: 'Journal accès données personnelles (conformité ARTCI)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      let employeeId = request.user.employeeId ?? null
      if (!employeeId) {
        const r = await rawPool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        employeeId = r.rows[0]?.id ?? null
      }

      await rawPool.query(
        `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, created_at)
         VALUES ($1,'READ','payslip',null,$2::jsonb,now())`,
        [request.user.sub, JSON.stringify({ access: 'my_access_log', ip: request.ip })]
      ).catch(() => null)

      const res = await rawPool.query(
        `SELECT al.id, al.user_id, al.action, al.entity, al.entity_id,
                al.changes, al.ip_address, al.created_at
         FROM "${schema}".audit_log al
         WHERE al.user_id = $1
         ORDER BY al.created_at DESC LIMIT 20`,
        [request.user.sub]
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /payroll/periods — liste des périodes
  fastify.get('/periods', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    schema: { tags: ['payroll'], summary: 'Périodes de paie' },
    handler: async (request, reply) => {
      const res = await rawPool.query(
        `SELECT * FROM "${request.user.schemaName}".pay_periods ORDER BY month DESC`
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /payroll/livre-de-paie/:year/export — Livre de paie annuel CSV
  // OWASP A07 : rate-limit anti-scraping/brute-force sur cet export coûteux
  // (agrège jusqu'à plusieurs centaines de bulletins, données salariales sensibles).
  fastify.get('/livre-de-paie/:year/export', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: { tags: ['payroll'], summary: 'Export livre de paie annuel — inspecteurs du travail CI' },
    handler: async (request, reply) => {
      const { year } = request.params as { year: string }
      const schema = request.user.schemaName

      const tenantRes = await rawPool.query<{ name: string; cnps_number: string; rccm: string }>(
        `SELECT name, cnps_number, rccm FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]

      const res = await rawPool.query(
        `SELECT ps.month,
                e.first_name, e.last_name,
                COALESCE(e.cnps_number,'') AS cnps_number,
                COALESCE(e.nni,'') AS nni,
                COALESCE(e.job_title,'') AS job_title,
                COALESCE(d.name,'') AS department_name,
                COALESCE(e.contract_type,'cdi') AS contract_type,
                ps.base_salary, ps.gross_salary,
                COALESCE(ps.cnps_retraite_sal,0) AS cnps_retraite_sal,
                COALESCE(ps.cnps_pf_pat,0) AS cnps_pf_pat,
                COALESCE(ps.cnps_at_pat,0) AS cnps_at_pat,
                COALESCE(ps.cnps_retraite_pat,0) AS cnps_retraite_pat,
                COALESCE(ps.total_cnps_sal,0) AS total_cnps_sal,
                COALESCE(ps.total_cnps_pat,0) AS total_cnps_pat,
                COALESCE(ps.its,0) AS its,
                ps.net_payable, ps.employer_cost,
                COALESCE(ps.indemnite_absence,0) AS indemnite_absence,
                ps.payment_method
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         LEFT JOIN "${schema}".departments d ON d.id = e.department_id
         WHERE ps.month LIKE $1
         ORDER BY ps.month, e.last_name`,
        [`${year}-%`]
      )

      const header = [
        'Mois','Nom','Prénom','N° CNPS','NNI','Poste','Département','Contrat',
        'Salaire Base','Brut','CNPS Ret. Sal.','CNPS PF Pat.','CNPS AT Pat.','CNPS Ret. Pat.',
        'Total CNPS Sal.','Total CNPS Pat.','ITS','Indemnité Absence','Net à Payer','Coût Employeur','Mode Paiement',
      ].join(';')

      const rows = res.rows.map((r: Record<string, unknown>) => [
        r.month, r.last_name, r.first_name, r.cnps_number, r.nni,
        r.job_title, r.department_name, r.contract_type,
        r.base_salary, r.gross_salary,
        r.cnps_retraite_sal, r.cnps_pf_pat, r.cnps_at_pat, r.cnps_retraite_pat,
        r.total_cnps_sal, r.total_cnps_pat, r.its, r.indemnite_absence,
        r.net_payable, r.employer_cost, r.payment_method,
      ].join(';'))

      const csv = `Livre de paie ${year} — ${tenant?.name ?? ''} | CNPS: ${tenant?.cnps_number ?? ''}\n${header}\n${rows.join('\n')}`

      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="livre-paie-${year}.csv"`)
      return reply.send('﻿' + csv)
    },
  })
}

export default payrollRoutes
