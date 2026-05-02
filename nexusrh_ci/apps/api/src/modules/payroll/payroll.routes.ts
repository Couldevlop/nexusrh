import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'
import { calculatePayrollCI } from '../../services/payroll-engine-ci.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

const rawPool = new Pool({ connectionString: config.database.url })

const payrollRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // POST /payroll/calculate — calcul d'un bulletin CI
  fastify.post('/calculate', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    schema: { tags: ['payroll'], summary: 'Calculer un bulletin de paie CI (CNPS + ITS)' },
    handler: async (request, reply) => {
      const { employeeId, month } = request.body as { employeeId: string; month: string }
      const schema = request.user.schemaName

      const empRes = await rawPool.query<{
        id: string; base_salary: string; marital_status: string; children_count: number
        first_name: string; last_name: string; cnps_number: string; nni: string
        mobile_money_provider: string; mobile_money_phone: string
      }>(
        `SELECT id, base_salary, marital_status, children_count,
                first_name, last_name, cnps_number, nni,
                mobile_money_provider, mobile_money_phone
         FROM "${schema}".employees WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [employeeId]
      )
      const emp = empRes.rows[0]
      if (!emp) return reply.status(404).send({ error: 'Employé introuvable' })

      // Récupérer le taux AT du tenant
      const tenantRes = await rawPool.query<{ at_rate: string }>(
        `SELECT at_rate FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const atRate = parseFloat(tenantRes.rows[0]?.at_rate ?? '0.020')

      // Récupérer les éléments variables du mois
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
        for (const v of velRes.rows) {
          varEls[v.rule_code] = parseInt(v.amount)
        }
      }

      // Calculer jours ouvrables du mois
      const [year, monthNum] = month.split('-').map(Number)
      const daysInMonth = new Date(year!, monthNum!, 0).getDate()
      let workingDays = 0
      for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(year!, (monthNum ?? 1) - 1, d).getDay()
        if (dow !== 0) workingDays++ // dimanche exclu
      }

      const result = calculatePayrollCI({
        baseSalary:       parseInt(emp.base_salary),
        workedDays:       workingDays, // mois complet
        workingDaysMonth: workingDays,
        atRate,
        maritalStatus:    emp.marital_status ?? 'single',
        childrenCount:    emp.children_count ?? 0,
        variableElements: varEls,
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
        result,
        currency: 'XOF',
      })
    },
  })

  // POST /payroll/periods/:month/close — clôture mensuelle
  fastify.post('/periods/:month/close', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    schema: { tags: ['payroll'], summary: 'Clôturer une période de paie CI' },
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      const schema = request.user.schemaName

      // Vérifier que la période n'est pas déjà clôturée
      const existing = await rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".pay_periods WHERE month = $1 LIMIT 1`, [month]
      )
      if (existing.rows[0]?.status === 'closed') {
        return reply.status(422).send({ error: 'Période déjà clôturée' })
      }

      // Récupérer tous les employés actifs
      const emps = await rawPool.query<{
        id: string; base_salary: string; marital_status: string; children_count: number
        mobile_money_provider: string; mobile_money_phone: string
        first_name: string; last_name: string; cnps_number: string; nni: string
      }>(
        `SELECT id, base_salary, marital_status, children_count,
                mobile_money_provider, mobile_money_phone,
                first_name, last_name, cnps_number, nni
         FROM "${schema}".employees WHERE is_active = true AND deleted_at IS NULL`
      )

      const tenantRes = await rawPool.query<{ at_rate: string }>(
        `SELECT at_rate FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const atRate = parseFloat(tenantRes.rows[0]?.at_rate ?? '0.020')

      const [year, monthNum] = month.split('-').map(Number)
      const daysInMonth = new Date(year!, monthNum!, 0).getDate()
      let workingDays = 0
      for (let d = 1; d <= daysInMonth; d++) {
        if (new Date(year!, (monthNum ?? 1) - 1, d).getDay() !== 0) workingDays++
      }

      // Créer/récupérer la période
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

        const result = calculatePayrollCI({
          baseSalary: parseInt(emp.base_salary),
          workedDays: workingDays, workingDaysMonth: workingDays,
          atRate, maritalStatus: emp.marital_status ?? 'single',
          childrenCount: emp.children_count ?? 0, variableElements: varEls,
        })

        totalGross += result.grossSalary
        totalNet   += result.netPayable
        totalCnps  += result.totalCnpsSal + result.totalCnpsPat
        totalIts   += result.its

        const slip = await rawPool.query(
          `INSERT INTO "${schema}".pay_slips
             (employee_id, period_id, month, base_salary, gross_salary,
              cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
              total_cnps_sal, total_cnps_pat, its, total_deductions,
              net_payable, employer_cost, lines, status, generated_at,
              payment_method, payment_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'generated',now(),$17,'pending')
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            emp.id, periodId, month, emp.base_salary, result.grossSalary,
            result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
            result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
            result.netPayable, result.employerCost, JSON.stringify(result.lines),
            emp.mobile_money_provider ?? 'mobile_money',
          ]
        )
        if (slip.rows[0]) paySlips.push({ employeeId: emp.id, paySlipId: slip.rows[0].id, netPayable: result.netPayable })
      }

      // Mettre à jour la période
      await rawPool.query(
        `UPDATE "${schema}".pay_periods SET
           status = 'closed', closed_at = now(), closed_by = $1,
           total_gross = $2, total_net = $3, total_cnps = $4, total_its = $5
         WHERE id = $6`,
        [request.user.sub, totalGross, totalNet, totalCnps, totalIts, periodId]
      )

      return reply.send({
        message: `Période ${month} clôturée — ${emps.rows.length} bulletins générés`,
        periodId,
        employeesCount: emps.rows.length,
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

      // Marquer comme vu
      await rawPool.query(
        `UPDATE "${schema}".pay_slips
         SET viewed_by_employee_at = now()
         WHERE employee_id = $1 AND viewed_by_employee_at IS NULL`,
        [employeeId]
      )

      const res = await rawPool.query(
        `SELECT id, month, gross_salary, net_payable, its, total_cnps_sal,
                status, payment_method, payment_status, payment_reference,
                generated_at, viewed_by_employee_at, file_url, currency
         FROM "${schema}".pay_slips
         WHERE employee_id = $1
         ORDER BY month DESC LIMIT 24`,
        [employeeId]
      )
      return reply.send({ data: res.rows, currency: 'XOF' })
    },
  })

  // GET /payroll/my-access-log — journal d'accès ARTCI (self-service)
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

      // Log the access to this endpoint itself
      await rawPool.query(
        `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, created_at)
         VALUES ($1,'READ','payslip',null,$2::jsonb,now())`,
        [request.user.sub, JSON.stringify({ access: 'my_access_log', ip: request.ip })]
      ).catch(() => null)

      const res = await rawPool.query<{
        id: string; user_id: string; action: string; entity: string; entity_id: string | null
        changes: unknown; ip_address: string | null; created_at: string
      }>(
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

  // GET /payroll/livre-de-paie/:year/export — Livre de paie annuel (CSV inspecteurs du travail CI)
  fastify.get('/livre-de-paie/:year/export', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    schema: { tags: ['payroll'], summary: 'Export livre de paie annuel — format inspecteurs du travail CI' },
    handler: async (request, reply) => {
      const { year } = request.params as { year: string }
      const schema = request.user.schemaName

      const tenantRes = await rawPool.query<{ name: string; cnps_number: string; rccm: string }>(
        `SELECT name, cnps_number, rccm FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]

      const res = await rawPool.query<{
        month: string; first_name: string; last_name: string; cnps_number: string; nni: string
        job_title: string; department_name: string; contract_type: string
        base_salary: string; gross_salary: string
        cnps_retraite_sal: string; cnps_pf_pat: string; cnps_at_pat: string; cnps_retraite_pat: string
        total_cnps_sal: string; total_cnps_pat: string; its: string
        net_payable: string; employer_cost: string; payment_method: string
      }>(
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
                COALESCE(ps.payment_method,'mobile_money') AS payment_method
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         LEFT JOIN "${schema}".departments d ON d.id = e.department_id
         WHERE ps.month LIKE $1
         ORDER BY ps.month, e.last_name, e.first_name`,
        [`${year}-%`]
      )

      const rows = res.rows
      if (rows.length === 0) {
        return reply.status(404).send({ error: `Aucun bulletin pour l'année ${year}` })
      }

      // En-tête légal CI pour livre de paie
      const header = [
        `LIVRE DE PAIE — ANNÉE ${year}`,
        `Employeur : ${tenant?.name ?? ''}`,
        `N° CNPS Employeur : ${tenant?.cnps_number ?? ''}`,
        `RCCM : ${tenant?.rccm ?? ''}`,
        `Généré le : ${new Date().toLocaleDateString('fr-CI')}`,
        '',
        'MOIS;NOM;PRENOM;NNI;N_CNPS;DEPARTEMENT;POSTE;TYPE_CONTRAT;' +
        'SALAIRE_BASE;SALAIRE_BRUT;CNPS_RET_SAL;CNPS_PF_PAT;CNPS_AT_PAT;CNPS_RET_PAT;' +
        'TOTAL_CNPS_SAL;TOTAL_CNPS_PAT;ITS;NET_A_PAYER;COUT_EMPLOYEUR;MODE_PAIEMENT',
      ]

      const lines = rows.map(r => [
        r.month,
        r.last_name.toUpperCase(),
        r.first_name,
        r.nni,
        r.cnps_number,
        r.department_name,
        r.job_title,
        r.contract_type.toUpperCase(),
        r.base_salary,
        r.gross_salary,
        r.cnps_retraite_sal,
        r.cnps_pf_pat,
        r.cnps_at_pat,
        r.cnps_retraite_pat,
        r.total_cnps_sal,
        r.total_cnps_pat,
        r.its,
        r.net_payable,
        r.employer_cost,
        r.payment_method,
      ].join(';'))

      // Totaux par mois
      const totauxParMois = new Map<string, { brut: number; net: number; cnpsSal: number; cnpsPat: number; its: number }>()
      for (const r of rows) {
        const t = totauxParMois.get(r.month) ?? { brut: 0, net: 0, cnpsSal: 0, cnpsPat: 0, its: 0 }
        t.brut    += parseInt(r.gross_salary ?? '0')
        t.net     += parseInt(r.net_payable ?? '0')
        t.cnpsSal += parseInt(r.total_cnps_sal ?? '0')
        t.cnpsPat += parseInt(r.total_cnps_pat ?? '0')
        t.its     += parseInt(r.its ?? '0')
        totauxParMois.set(r.month, t)
      }

      const totaux = ['', 'RÉCAPITULATIF MENSUEL', 'MOIS;MASSE_SALARIALE_BRUTE;TOTAL_CNPS_SAL;TOTAL_CNPS_PAT;TOTAL_ITS;MASSE_SALARIALE_NETTE']
      for (const [mois, t] of Array.from(totauxParMois.entries()).sort()) {
        totaux.push(`${mois};${t.brut};${t.cnpsSal};${t.cnpsPat};${t.its};${t.net}`)
      }

      const csv = [...header, ...lines, ...totaux].join('\r\n')
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="Livre_Paie_${year}.csv"`)
      return reply.send('\uFEFF' + csv)
    },
  })
}

export default payrollRoutes
