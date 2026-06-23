import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { calculatePayrollCI, type AbsencePayrollInfo, type PayrollContext } from '../../services/payroll-engine-ci.js'
import { resolvePayrollContext } from '../../services/payroll-context-resolver.js'
import { renderPayslipPdf, type PayslipPdfLine } from './payslip-pdf.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

// OWASP A03 — UUID regex stricte pour les paramètres sensibles (legalEntityId)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// OWASP A03 — schéma body close period (multi-filiales)
const closePeriodBodySchema = z.object({
  legalEntityId: z.string().regex(UUID_RE, 'UUID requis').optional(),
}).strict()

// OWASP A03 — schéma body /calculate. Sans validation, un employeeId non-UUID
// faisait planter la requête SQL (« invalid input syntax for type uuid ») en
// 500 opaque. On valide en amont → 400 clair.
const calcBodySchema = z.object({
  employeeId: z.string().regex(UUID_RE, 'UUID employé requis'),
  month:      z.string().regex(/^\d{4}-\d{2}$/, 'Format mois invalide (YYYY-MM)'),
}).strict()

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
      // OWASP A03 — validation stricte (employeeId UUID, month YYYY-MM).
      const parsedBody = calcBodySchema.safeParse(request.body)
      if (!parsedBody.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsedBody.error.flatten() })
      }
      const { employeeId, month } = parsedBody.data
      const schema = request.user.schemaName

      // Toute la simulation est encadrée : une donnée employé/tenant incohérente
      // (filiale orpheline, pack indisponible, colonne legacy) doit produire un
      // message exploitable plutôt qu'un 500 opaque côté client.
      try {
      const empRes = await rawPool.query<{
        id: string; base_salary: string; marital_status: string; children_count: number
        first_name: string; last_name: string; cnps_number: string; nni: string
        mobile_money_provider: string; mobile_money_phone: string; hire_date: string | null
        legal_entity_id: string | null
      }>(
        `SELECT id, base_salary, marital_status, children_count,
                first_name, last_name, cnps_number, nni,
                mobile_money_provider, mobile_money_phone, hire_date, legal_entity_id
         FROM "${schema}".employees WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [employeeId]
      )
      const emp = empRes.rows[0]
      if (!emp) return reply.status(404).send({ error: 'Employé introuvable' })

      // Garde anti-NaN : un dossier sans salaire de base exploitable ne peut pas
      // être simulé (produirait des montants NaN dans tout le bulletin).
      const baseSalary = parseInt(emp.base_salary, 10)
      if (!Number.isFinite(baseSalary) || baseSalary <= 0) {
        return reply.status(422).send({
          error: 'Salaire de base manquant ou invalide pour cet employé. Renseignez la rémunération avant de simuler la paie.',
        })
      }

      const tenantRes = await rawPool.query<{
        id: string; at_rate: string; has_subsidiaries: boolean; default_country_code: string | null
      }>(
        `SELECT id, at_rate, has_subsidiaries, default_country_code
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenantRow = tenantRes.rows[0]

      // Résolution du pack législatif de l'employé (multi-pays / multi-filiales).
      // Aligne l'aperçu /calculate sur la clôture /close : même pack, même devise.
      let legalEntityInfo: {
        id: string; atRate: number | null; legislationPackCode: string | null; countryCode: string | null
      } | null = null
      if (emp.legal_entity_id) {
        const leRes = await rawPool.query<{
          id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null
        }>(
          `SELECT id, at_rate, legislation_pack_code, country_code
           FROM "${schema}".legal_entities WHERE id = $1 LIMIT 1`,
          [emp.legal_entity_id],
        ).catch(() => ({ rows: [] as Array<{ id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null }> }))
        const le = leRes.rows[0]
        if (le) legalEntityInfo = {
          id: le.id,
          atRate: le.at_rate ? parseFloat(le.at_rate) : null,
          legislationPackCode: le.legislation_pack_code,
          countryCode: le.country_code,
        }
      }

      const resolved = resolvePayrollContext({
        tenant: {
          id: tenantRow?.id ?? '',
          hasSubsidiaries: tenantRow?.has_subsidiaries ?? false,
          atRate: parseFloat(tenantRow?.at_rate ?? '0.020'),
          defaultCountryCode: tenantRow?.default_country_code ?? null,
        },
        employee: { id: emp.id, legalEntityId: emp.legal_entity_id },
        legalEntity: legalEntityInfo,
      })
      const atRate = resolved.atRate

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
        baseSalary,
        workedDays:       absenceCtx ? absenceCtx.workedDays : workingDaysMonth,
        workingDaysMonth,
        atRate,
        maritalStatus:    emp.marital_status ?? 'single',
        childrenCount:    emp.children_count ?? 0,
        variableElements: varEls,
        absence:          absenceCtx?.info,
        legislationPack:  resolved.legislationPack,
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
        currency: result.currency,
      })
      } catch (err) {
        // Le moteur refuse explicitement les packs législatifs non validés
        // (status='stub') et autres incohérences métier : on remonte le message
        // en 422 (action corrective côté RH), le reste en 500 générique.
        const msg = err instanceof Error ? err.message : ''
        if (/stub|pack législatif|legislation/i.test(msg)) {
          return reply.status(422).send({ error: msg })
        }
        request.log.error({ err, schema, employeeId, month }, 'payroll calculate failed')
        return reply.status(500).send({ error: 'Échec de la simulation de paie. Vérifiez le dossier de l\'employé et le paramétrage paie.' })
      }
    },
  })

  // POST /payroll/periods/:month — crée une période de paie au statut 'open'
  // (PAY-019), AVANT la génération des bulletins (qui se fait via /close).
  fastify.post('/periods/:month', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['payroll'], summary: 'Créer une période de paie (statut open)' },
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return reply.status(400).send({ error: 'Mois invalide (format AAAA-MM attendu).' })
      }
      const schema = request.user.schemaName
      const existing = await rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".pay_periods WHERE month = $1 LIMIT 1`, [month],
      )
      if (existing.rows[0]) {
        return reply.status(409).send({ error: `La période ${month} existe déjà (statut : ${existing.rows[0].status}).` })
      }
      const ins = await rawPool.query<{ id: string; month: string; status: string }>(
        `INSERT INTO "${schema}".pay_periods (month) VALUES ($1) RETURNING id, month, status`, [month],
      )
      return reply.status(201).send({ data: ins.rows[0] })
    },
  })

  // POST /payroll/periods/:month/close — clôture mensuelle (avec absences)
  //
  // Multi-filiales (Palier 3) :
  //  - Si tenant.has_subsidiaries=true → `legalEntityId` REQUIS dans le body
  //    Zod : scope la clôture aux employés de cette filiale uniquement.
  //  - Si false → `legalEntityId` ignoré, comportement historique (tous emp).
  //  - Le moteur reçoit le pack législatif + at_rate spécifiques à la filiale
  //    (ou tenant si mono-filiale), résolus par resolvePayrollContext().
  fastify.post('/periods/:month/close', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    schema: { tags: ['payroll'], summary: 'Clôturer une période de paie CI (scope filiale si multi-filiales)' },
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      const schema = request.user.schemaName

      // OWASP A03 — body validation (legalEntityId UUID si fourni)
      const bodyParsed = closePeriodBodySchema.safeParse(request.body ?? {})
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: bodyParsed.error.flatten() })
      }
      const { legalEntityId } = bodyParsed.data

      const tenantRes = await rawPool.query<{
        id: string; has_subsidiaries: boolean; at_rate: string
        default_country_code: string | null
      }>(
        `SELECT id, has_subsidiaries, at_rate, default_country_code
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]
      if (!tenant) return reply.status(404).send({ error: 'Tenant introuvable' })

      // Multi-filiales : exige legalEntityId
      if (tenant.has_subsidiaries && !legalEntityId) {
        return reply.status(400).send({
          error: 'Ce tenant a plusieurs filiales — legalEntityId requis pour scoper la clôture',
        })
      }

      // Si filiale fournie, valide qu'elle existe et appartient au tenant
      let legalEntity: { id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null; name: string } | null = null
      if (legalEntityId) {
        const leRes = await rawPool.query<{
          id: string; at_rate: string | null; legislation_pack_code: string | null
          country_code: string | null; name: string
        }>(
          `SELECT id, at_rate, legislation_pack_code, country_code, name
           FROM "${schema}".legal_entities WHERE id = $1 AND is_active = true LIMIT 1`,
          [legalEntityId],
        ).catch(() => ({ rows: [] as Array<{ id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null; name: string }> }))
        if (!leRes.rows[0]) {
          return reply.status(404).send({ error: 'Filiale introuvable ou inactive' })
        }
        legalEntity = leRes.rows[0]
      }

      const existing = await rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".pay_periods
         WHERE month = $1 AND (legal_entity_id IS NOT DISTINCT FROM $2)
         LIMIT 1`,
        [month, legalEntityId ?? null],
      ).catch(async () => {
        // Fallback si colonne legal_entity_id pas encore migrée (mono-filiale)
        return rawPool.query<{ id: string; status: string }>(
          `SELECT id, status FROM "${schema}".pay_periods WHERE month = $1 LIMIT 1`, [month],
        )
      })
      if (existing.rows[0]?.status === 'closed') {
        return reply.status(422).send({ error: 'Période déjà clôturée' })
      }
      // OWASP A04 (idempotence) — si la clôture a déjà été initiée (bulletins
      // générés, en attente de validation 2-yeux), un nouvel appel ne doit PAS
      // recalculer/regénérer. On refuse explicitement : pour recalculer, il faut
      // d'abord rejeter la période (retour à 'open').
      if (existing.rows[0]?.status === 'pending_validation') {
        return reply.status(409).send({
          error: 'Clôture déjà initiée pour cette période (en attente de validation). Rejetez-la d\'abord pour recalculer.',
          periodId: existing.rows[0].id,
          status: 'pending_validation',
        })
      }

      // Scope employés par filiale si applicable
      const empsParams: unknown[] = []
      let empsWhere = `is_active = true AND deleted_at IS NULL`
      if (legalEntityId) {
        empsParams.push(legalEntityId)
        empsWhere += ` AND legal_entity_id = $${empsParams.length}`
      }
      const emps = await rawPool.query<{
        id: string; base_salary: string; marital_status: string; children_count: number
        mobile_money_provider: string; mobile_money_phone: string
        first_name: string; last_name: string; cnps_number: string; nni: string
        hire_date: string | null; legal_entity_id: string | null
      }>(
        `SELECT id, base_salary, marital_status, children_count,
                mobile_money_provider, mobile_money_phone,
                first_name, last_name, cnps_number, nni, hire_date, legal_entity_id
         FROM "${schema}".employees WHERE ${empsWhere}`,
        empsParams,
      )

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
          `INSERT INTO "${schema}".pay_periods (month, legal_entity_id) VALUES ($1, $2) RETURNING id`,
          [month, legalEntityId ?? null],
        ).catch(async () => {
          // Colonne pas encore migrée → fallback INSERT sans legal_entity_id
          return rawPool.query<{ id: string }>(
            `INSERT INTO "${schema}".pay_periods (month) VALUES ($1) RETURNING id`, [month],
          )
        })
        periodId = pRes.rows[0]?.id ?? ''
      }

      let totalGross = 0; let totalNet = 0; let totalCnps = 0; let totalIts = 0
      const paySlips: unknown[] = []

      // Résolution du contexte paie commun (Clean Architecture — pure function)
      const tenantInfo = {
        id: tenant.id, hasSubsidiaries: tenant.has_subsidiaries,
        atRate: parseFloat(tenant.at_rate ?? '0.020'),
        defaultCountryCode: tenant.default_country_code,
      }
      const legalEntityInfo = legalEntity ? {
        id: legalEntity.id,
        atRate: legalEntity.at_rate ? parseFloat(legalEntity.at_rate) : null,
        legislationPackCode: legalEntity.legislation_pack_code,
        countryCode: legalEntity.country_code,
      } : null

      for (const emp of emps.rows) {
        const varEls: Record<string, number> = {}
        const velRes = await rawPool.query<{ rule_code: string; amount: string }>(
          `SELECT rule_code, amount FROM "${schema}".variable_elements
           WHERE employee_id = $1 AND period_id = $2`, [emp.id, periodId]
        )
        for (const v of velRes.rows) varEls[v.rule_code] = parseInt(v.amount)

        // Résolution absence pour cet employé ce mois-ci
        const absenceCtx = await resolveAbsenceForPayroll(schema, emp.id, month, emp.hire_date)

        // Résolution du contexte paie (at_rate + pack législatif selon filiale).
        // OWASP A09 : si fallback legacy, le warning est inclus dans l'audit
        // log final via paySlips.warnings.
        const resolved = resolvePayrollContext({
          tenant:     tenantInfo,
          employee:   { id: emp.id, legalEntityId: emp.legal_entity_id },
          legalEntity: legalEntityInfo,
        })

        const result = calculatePayrollCI({
          baseSalary:       parseInt(emp.base_salary),
          workedDays:       absenceCtx ? absenceCtx.workedDays : workingDaysMonth,
          workingDaysMonth,
          atRate:           resolved.atRate,
          maritalStatus:    emp.marital_status ?? 'single',
          childrenCount:    emp.children_count ?? 0,
          variableElements: varEls,
          absence:          absenceCtx?.info,
          legislationPack:  resolved.legislationPack,
        })

        totalGross += result.grossSalary
        totalNet   += result.netPayable
        totalCnps  += result.totalCnpsSal + result.totalCnpsPat
        totalIts   += result.its

        // Sérialiser le bordereau CNPS s'il existe
        const bordereauJson = result.bordereauCnps ? JSON.stringify(result.bordereauCnps) : null

        // Persist le legal_entity_id résolu (peut être null en mono-filiale).
        // Si la colonne n'est pas encore migrée, on retombe sur l'INSERT
        // sans cette colonne (backward compat période de transition).
        const slip = await rawPool.query(
          `INSERT INTO "${schema}".pay_slips
             (employee_id, period_id, month, base_salary, gross_salary,
              cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
              total_cnps_sal, total_cnps_pat, its, total_deductions,
              net_payable, employer_cost, lines, status, generated_at,
              payment_method, payment_status, bordereau_cnps, indemnite_absence,
              legal_entity_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'generated',now(),$17,'pending',$18::jsonb,$19,$20)
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
            resolved.legalEntityId,
          ]
        ).catch(async () => {
          // Fallback si legal_entity_id pas encore migrée
          return rawPool.query(
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
            ],
          )
        })
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
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags: ['payroll'], summary: 'Bulletin transparent — formules, comparaison, audit' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      // OWASP A03 : UUID validation stricte avant SELECT
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      }
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
      } else if (!['admin','hr_manager','hr_officer','readonly'].includes(role)) {
        // OWASP A01 (deny-by-default) — la paie est hors du périmètre du manager
        // (matrice RBAC : manager = aucun accès paie). Seuls admin/hr_manager/
        // hr_officer/readonly consultent les bulletins du tenant ; l'employee
        // accède uniquement aux siens (traité plus haut).
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

  // GET /payroll/my-payslips/:id/pdf — bulletin PDF self-service employé
  // Auth : header Authorization OU ?token= (l'iframe/lien de téléchargement ne
  // peut pas porter de header → on recopie le token de la query avant authenticate).
  // OWASP A01 : scope STRICT sur l'employé du token (un salarié ne télécharge
  // que ses propres bulletins) — pas d'IDOR.
  fastify.get('/my-payslips/:id/pdf', {
    preHandler: [
      async (request: FastifyRequest) => {
        const q = request.query as { token?: string }
        if (q?.token && !request.headers.authorization) {
          request.headers.authorization = `Bearer ${q.token}`
        }
      },
      fastify.authenticate,
    ],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags: ['payroll'], summary: 'Mon bulletin de paie en PDF (self-service)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      }
      const schema = request.user.schemaName

      let employeeId = request.user.employeeId ?? null
      if (!employeeId) {
        const me = await rawPool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email],
        )
        employeeId = (me.rows[0] as { id?: string } | undefined)?.id ?? null
      }
      if (!employeeId) return reply.status(404).send({ error: 'Bulletin introuvable' })

      const slipRes = await rawPool.query<{
        month: string; base_salary: string; gross_salary: string; net_payable: string
        total_cnps_sal: string; its: string; employer_cost: string; total_deductions: string
        lines: unknown; currency: string | null
        payment_method: string | null; payment_reference: string | null; generated_at: string | null
        first_name: string; last_name: string; job_title: string | null
        cnps_number: string | null; nni: string | null
      }>(
        `SELECT ps.month, ps.base_salary, ps.gross_salary, ps.net_payable,
                ps.total_cnps_sal, ps.its, ps.employer_cost, ps.total_deductions,
                ps.lines, ps.currency, ps.payment_method, ps.payment_reference, ps.generated_at,
                e.first_name, e.last_name, e.job_title, e.cnps_number, e.nni
           FROM "${schema}".pay_slips ps
           JOIN "${schema}".employees e ON e.id = ps.employee_id
          WHERE ps.id = $1 AND ps.employee_id = $2 LIMIT 1`,
        [id, employeeId],
      )
      const slip = slipRes.rows[0]
      if (!slip) return reply.status(404).send({ error: 'Bulletin introuvable' })

      const tenantRes = await rawPool.query<{ name: string }>(
        `SELECT name FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
      ).catch(() => ({ rows: [] as Array<{ name: string }> }))
      const tenantName = tenantRes.rows[0]?.name ?? 'Employeur'

      const rawLines = Array.isArray(slip.lines) ? (slip.lines as PayslipPdfLine[]) : []

      const pdf = await renderPayslipPdf({
        tenantName,
        employee: {
          firstName: slip.first_name, lastName: slip.last_name, jobTitle: slip.job_title,
          cnpsNumber: slip.cnps_number, nni: slip.nni,
        },
        month: slip.month,
        lines: rawLines,
        grossSalary: Number(slip.gross_salary),
        totalCnpsSal: Number(slip.total_cnps_sal),
        its: Number(slip.its),
        totalDeductions: Number(slip.total_deductions),
        netPayable: Number(slip.net_payable),
        employerCost: Number(slip.employer_cost),
        currency: slip.currency ?? 'XOF',
        paymentMethod: slip.payment_method,
        paymentReference: slip.payment_reference,
        generatedAt: slip.generated_at,
      })

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="bulletin_${slip.month}.pdf"`)
        .send(Buffer.from(pdf))
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

  // ── POST /payroll/simulate — simulation what-if (axe 2 transparence) ───────
  // Calcul de paie hypothétique SANS persistance : le RH ajuste brut/primes
  // /absences et voit instantanément net, coût employeur, ITS. Aussi utilisé
  // côté employee pour simuler une augmentation/prime, ou côté manager pour
  // préparer une offre d'embauche.
  //
  // OWASP :
  // - A01 : employee ne peut simuler QUE sur son propre employeeId ;
  //         manager uniquement sur équipe directe ; admin/hr partout
  // - A03 : Zod strict avec bornes anti-fraude (cap brut 50M FCFA, AT ≤ 10%,
  //         workedDays ≤ workingDaysMonth, enfants ≤ 20)
  // - A07 : rate-limit 30 req/min (calcul CPU + DB lookup)
  // - A09 : audit log des simulations sensibles (offre d'embauche, négociation)
  const simulationSchema = z.object({
    employee_id:      z.string().uuid().optional(),
    baseSalary:       z.number().int().min(0).max(50_000_000),
    workedDays:       z.number().int().min(0).max(31),
    workingDaysMonth: z.number().int().min(20).max(31),
    atRate:           z.number().min(0).max(0.1),
    maritalStatus:    z.enum(['single', 'married', 'divorced', 'widowed', 'cohabiting']),
    childrenCount:    z.number().int().min(0).max(20),
    variableElements: z.record(z.string().max(50), z.number().int().min(0).max(50_000_000)).optional(),
    absence:          z.object({
      type:                    z.enum(['maternite', 'maladie_sans_at', 'accident_travail']),
      absenceDays:             z.number().int().min(0).max(31),
      maintienTaux:            z.number().min(0).max(1).optional(),
      atJourAccidentInMonth:   z.boolean().optional(),
    }).optional(),
  }).strict()

  fastify.post('/simulate', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['payroll'], summary: 'Simulation what-if de paie (sans persistance)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const role = request.user.role
      const parsed = simulationSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Paramètres de simulation invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      // OWASP A04 : cohérence métier
      if (body.workedDays > body.workingDaysMonth) {
        return reply.status(400).send({ error: 'workedDays ne peut pas dépasser workingDaysMonth' })
      }

      // OWASP A01 (deny-by-default) — la simulation de paie est réservée aux rôles
      // RH + à l'employee (sur lui-même). Le manager n'a aucun accès paie (matrice
      // RBAC) ; readonly ne simule pas (action de préparation, pas de consultation).
      const SIM_ALLOWED_ROLES = ['admin', 'hr_manager', 'hr_officer', 'employee']
      if (!SIM_ALLOWED_ROLES.includes(role)) {
        return reply.status(403).send({ error: 'Rôle non autorisé pour la simulation de paie' })
      }

      // OWASP A01 : RBAC sur le target employee_id
      if (body.employee_id) {
        if (role === 'employee') {
          // Un employee ne peut simuler QUE sur lui-même
          const myId = request.user.employeeId
          if (myId && myId !== body.employee_id) {
            return reply.status(403).send({ error: 'Vous ne pouvez simuler que sur votre propre profil' })
          }
        }
        // admin/hr_manager/hr_officer : portée tenant globale, pas de check
      }
      // Sans employee_id, un employee simule implicitement sur lui-même : OK

      // Calcul via le moteur (jamais persisté)
      const ctx: PayrollContext = {
        baseSalary:       body.baseSalary,
        workedDays:       body.workedDays,
        workingDaysMonth: body.workingDaysMonth,
        atRate:           body.atRate,
        maritalStatus:    body.maritalStatus,
        childrenCount:    body.childrenCount,
        variableElements: body.variableElements ?? {},
      }
      if (body.absence) {
        ctx.absence = body.absence as AbsencePayrollInfo
      }
      let result
      try {
        result = calculatePayrollCI(ctx)
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        // OWASP A10 : message d'erreur générique côté client (pack stub etc.)
        return reply.status(422).send({
          error: msg.includes('stub') ? msg : 'Erreur de calcul de paie. Vérifiez les paramètres.',
        })
      }

      // Enrichissement explainer (axe 1 transparence)
      const { explainLines } = await import('../../services/payroll-explainer.service.js')
      const explained = explainLines(result.lines)

      // OWASP A09 : trace de la simulation (action sensible — préparation
      // d'offre, négociation). Non bloquant si audit_log absent.
      rawPool.query(
        `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
         VALUES ($1, $2, 'payroll_simulation', $3, $4, $5)`,
        [request.user.sub, 'payroll.simulated', body.employee_id ?? null,
         JSON.stringify({
           baseSalary: body.baseSalary,
           hasAbsence: !!body.absence,
           variableElementsCount: Object.keys(body.variableElements ?? {}).length,
           grossSalary: result.grossSalary,
           netPayable: result.netPayable,
           employerCost: result.employerCost,
         }),
         request.ip ?? null],
      ).catch(() => { /* tenant sans audit_log : non bloquant */ })

      return reply.send({
        data: { ...result, lines: explained },
        meta: {
          mode: 'simulation',
          persistedAt: null,
          targetEmployeeId: body.employee_id ?? null,
        },
      })
    },
  })
}

export default payrollRoutes
