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

      await rawPool.query(
        `UPDATE "${schema}".pay_periods SET
           status = 'closed', closed_at = now(), closed_by = $1,
           total_gross = $2, total_net = $3, total_cnps = $4, total_its = $5
         WHERE id = $6`,
        [request.user.sub, totalGross, totalNet, totalCnps, totalIts, periodId]
      )

      const absenceCount = paySlips.filter((s: any) => s.hasAbsence).length
      const bordereauCount = paySlips.filter((s: any) => s.hasBordereauCnps).length

      return reply.send({
        message: `Période ${month} clôturée — ${emps.rows.length} bulletins générés`,
        periodId,
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
  fastify.get('/livre-de-paie/:year/export', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
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
