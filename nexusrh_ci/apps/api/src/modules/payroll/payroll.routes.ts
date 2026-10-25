import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { calculatePayrollCI, transportZoneFromCity, type AbsencePayrollInfo, type PayrollContext, type VariableTreatmentOverride } from '../../services/payroll-engine-ci.js'
import { getWorkingDays } from '../../services/payroll-absences.service.js'
import { loadEffectiveAttendancePayrollSettings } from '../../services/attendance-payroll.service.js'
import {
  loadPayrollPopulation, markExpensesPaid, markSettlementPaid, previousMonth, resolveEmployeeMonth, slipPaymentMethod,
} from '../../services/final-payslip.service.js'
import { resolvePayrollContext } from '../../services/payroll-context-resolver.js'
import { VARIABLE_ELEMENTS_SQL, treatmentFromRows, type VariableElementRow } from '../../services/payroll-variable-elements.js'
import { renderPayslipPdf, resolvePayslipTemplateConfig, type PayslipPdfLine } from './payslip-pdf.js'
import { getPackByCountry } from '../../services/legislation-packs.js'
import { encodeField } from '../sage/sage.service.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { auditTenant } from '../../utils/audit-log.js'
import { loadPayslipMentions } from '../../services/payslip-mentions.service.js'
import {
  buildPayrollCircuitView, decideOnPayrollPeriod, describePendingPeriods, loadPayrollCircuit, loadPayrollUsers, loadPeriodApprovals,
  notifyPayrollUser, payrollDenialMessage, payrollLevelState, pendingValidationMessage, pendingWithOf,
  resetPendingPeriod, PayrollResetConflict,
  type ApprovalForValidation, type PayrollCircuit, type PayrollLevelState,
  type PayrollUser, type PeriodForValidation,
} from '../../services/payroll-validation.service.js'

// OWASP A03 — motif de rejet (commentaire obligatoire) / commentaire d'annulation / visa
const rejectBodySchema = z.object({
  reason: z.string().trim().min(10, 'Commentaire obligatoire (10 caractères minimum)').max(2000),
}).strict()
const cancelBodySchema = z.object({
  comment: z.string().trim().max(2000).optional(),
}).strict()
const approveBodySchema = z.object({
  notes: z.string().trim().max(2000).optional(),
}).strict()
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// Statut de période à partir duquel un bulletin est PUBLIÉ au salarié : la
// période est entièrement validée et clôturée ('closed' est le statut terminal
// des deux circuits — validation N niveaux et multi-filiales, où la clôture
// passe la période parente ET ses filles à 'closed'). Avant (open,
// pending_validation, draft_central, sent_to_sites, completed_by_site,
// validated_central…), le bulletin reste invisible en self-service : liste,
// PDF, « Comprendre ». Passé en paramètre SQL ($n), jamais concaténé.
const EMPLOYEE_VISIBLE_PERIOD_STATUS = 'closed'

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

// Entrée / sortie du mois, renvoyée par la simulation (null = mois complet)
function employmentSummary(m: Awaited<ReturnType<typeof resolveEmployeeMonth>>) {
  const w = m.window
  if (!w.hiredInMonth && !w.exitsThisMonth && !w.settlementOnly) return null
  return {
    start: w.start, end: w.end,
    contractDays: w.contractDays, workingDaysMonth: w.workingDaysMonth,
    hiredInMonth: w.hiredInMonth, finalPayslip: w.exitsThisMonth || w.settlementOnly,
    settlementOnly: w.settlementOnly,
    settlement: m.settlementEarnings,
  }
}

/** Période « en validation » + état de son circuit, ou l'erreur HTTP à renvoyer. */
async function loadPendingPeriod(schema: string, month: string): Promise<
  | { status: 404 | 409; error: string }
  | {
      period: PeriodForValidation; circuit: PayrollCircuit; approvals: ApprovalForValidation[]
      users: Map<string, PayrollUser>; state: PayrollLevelState | null
    }
> {
  const r = await rawPool.query<PeriodForValidation>(
    `SELECT id, status, initiated_by, initiated_at FROM "${schema}".pay_periods
       WHERE month = $1 AND parent_period_id IS NULL LIMIT 1`,
    [month],
  )
  const period = r.rows[0]
  if (!period) return { status: 404, error: 'Période introuvable' }
  if (period.status === 'closed') {
    return { status: 409, error: 'Période clôturée : elle est immuable (ni validation, ni rejet, ni annulation).' }
  }
  if (period.status !== 'pending_validation') {
    return { status: 409, error: 'Période non éligible : elle n\'est pas en attente de validation.' }
  }
  const circuit = await loadPayrollCircuit(rawPool, schema)
  const approvals = (await loadPeriodApprovals(rawPool, schema, [period.id])).get(String(period.id)) ?? []
  const users = await loadPayrollUsers(rawPool, schema, circuit.steps.map(s => s.userId))
  return { period, circuit, approvals, users, state: payrollLevelState(circuit, period, approvals, users) }
}

/** Droit d'agir sur une période en validation (règles communes : service du circuit). */
function decideOnPeriod(
  state: PayrollLevelState | null, period: { initiated_by: string | null }, user: { sub: string; role: string },
) {
  return decideOnPayrollPeriod(state, period.initiated_by, user)
}

const payrollRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

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
      type CalcEmployee = {
        id: string; base_salary: string; marital_status: string; children_count: number
        first_name: string; last_name: string; cnps_number: string; nni: string
        mobile_money_provider: string; mobile_money_phone: string; hire_date: string | null
        legal_entity_id: string | null; exit_date?: string | null; settlement?: unknown
      }
      // Un salarié archivé reste simulable pour son mois de sortie (bulletin
      // de solde) et le mois suivant (rattrapage du solde).
      const empRes = await rawPool.query<CalcEmployee>(
        `SELECT e.id, e.base_salary, e.marital_status, e.children_count,
                e.first_name, e.last_name, e.cnps_number, e.nni,
                e.mobile_money_provider, e.mobile_money_phone, e.hire_date::text AS hire_date, e.legal_entity_id,
                COALESCE(e.exit_date, oc.departure_date)::text AS exit_date, oc.settlement
         FROM "${schema}".employees e
         LEFT JOIN LATERAL (
           SELECT o.departure_date, o.settlement FROM "${schema}".offboarding_cases o
           WHERE o.employee_id = e.id AND o.status <> 'cancelled'
             AND (o.status IN ('settled', 'closed') OR o.departure_date >= $3::date)
           ORDER BY o.departure_date DESC LIMIT 1
         ) oc ON true
         WHERE e.id = $1
           AND (e.deleted_at IS NULL OR COALESCE(e.exit_date, oc.departure_date) >= $2::date)
         LIMIT 1`,
        [employeeId, `${previousMonth(month)}-01`, `${month}-01`]
      ).catch(() => rawPool.query<CalcEmployee>(
        `SELECT id, base_salary, marital_status, children_count,
                first_name, last_name, cnps_number, nni,
                mobile_money_provider, mobile_money_phone, hire_date, legal_entity_id
         FROM "${schema}".employees WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [employeeId]
      ))
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
        city: string | null
      }>(
        `SELECT id, at_rate, has_subsidiaries, default_country_code, city
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenantRow = tenantRes.rows[0]

      // Résolution du pack législatif de l'employé (multi-pays / multi-filiales).
      // Aligne l'aperçu /calculate sur la clôture /close : même pack, même devise.
      let legalEntityInfo: {
        id: string; atRate: number | null; legislationPackCode: string | null; countryCode: string | null
      } | null = null
      let workCity: string | null = tenantRow?.city ?? null
      if (emp.legal_entity_id) {
        const leRes = await rawPool.query<{
          id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null
          city: string | null
        }>(
          `SELECT id, at_rate, legislation_pack_code, country_code, city
           FROM "${schema}".legal_entities WHERE id = $1 LIMIT 1`,
          [emp.legal_entity_id],
        ).catch(() => ({ rows: [] as Array<{ id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null; city: string | null }> }))
        const le = leRes.rows[0]
        if (le?.city) workCity = le.city
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
      let variableTreatment: VariableTreatmentOverride | undefined
      if (periodId) {
        const velRes = await rawPool.query<VariableElementRow>(
          `${VARIABLE_ELEMENTS_SQL(schema)}
           WHERE ve.employee_id = $1 AND ve.period_id = $2`,
          [employeeId, periodId]
        )
        for (const v of velRes.rows) varEls[v.rule_code] = parseInt(v.amount)
        variableTreatment = treatmentFromRows(velRes.rows)
      }

      const parsed = parseMonth(month)
      if (!parsed) {
        return reply.status(400).send({ error: 'Format mois invalide (attendu : YYYY-MM)' })
      }
      const { year, monthNum } = parsed
      const workingDaysMonth = getWorkingDays(year, monthNum)

      // Prorata entrée / sortie, absences, pointage et solde de tout compte
      const monthInputs = await resolveEmployeeMonth(
        schema, emp, month, await loadEffectiveAttendancePayrollSettings(schema))
      const { absenceCtx, attendance } = monthInputs

      const result = calculatePayrollCI({
        baseSalary,
        workedDays:       monthInputs.workedDays,
        workingDaysMonth,
        atRate,
        maritalStatus:    emp.marital_status ?? 'single',
        childrenCount:    emp.children_count ?? 0,
        variableElements: varEls,
        absence:          absenceCtx?.info,
        attendanceDeductions: attendance?.deductions,
        settlementEarnings: monthInputs.settlementEarnings,
        expenseReimbursement: monthInputs.expenses.total,
        legislationPack:  resolved.legislationPack,
        // Plafond d'exonération transport selon le lieu de travail
        transportZone:    transportZoneFromCity(workCity),
        variableTreatment,
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
          workedDays:  monthInputs.workedDays,
          maintienTaux: absenceCtx.info.type === 'maladie_sans_at' ? absenceCtx.info.maintienTaux : undefined,
        } : null,
        attendance: attendance?.summary ?? null,
        employment: employmentSummary(monthInputs),
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
        default_country_code: string | null; city: string | null
      }>(
        `SELECT id, has_subsidiaries, at_rate, default_country_code, city
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
      let legalEntity: { id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null; name: string; city?: string | null } | null = null
      if (legalEntityId) {
        const leRes = await rawPool.query<{
          id: string; at_rate: string | null; legislation_pack_code: string | null
          country_code: string | null; name: string; city: string | null
        }>(
          `SELECT id, at_rate, legislation_pack_code, country_code, name, city
           FROM "${schema}".legal_entities WHERE id = $1 AND is_active = true LIMIT 1`,
          [legalEntityId],
        ).catch(() => ({ rows: [] as Array<{ id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null; name: string; city: string | null }> }))
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
          error: 'Clôture déjà initiée pour cette période (en attente de validation). Pour recalculer, le valideur doit la renvoyer en préparation, ou l\'initiateur annuler son initiation tant qu\'aucun niveau n\'a validé.',
          periodId: existing.rows[0].id,
          status: 'pending_validation',
        })
      }

      const parsed = parseMonth(month)
      if (!parsed) {
        return reply.status(400).send({ error: 'Format mois invalide (attendu : YYYY-MM)' })
      }

      // Actifs + sortants du mois (bulletin de solde), scope filiale si applicable
      const emps = { rows: await loadPayrollPopulation(schema, month, { legalEntityId: legalEntityId ?? null }) }
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
      // Devise des bulletins (pack du pays) — plus de XOF en dur.
      const currencies = new Set<string>()
      const paySlips: unknown[] = []
      // Lien badgeuse → paie : chargé une fois pour le lot (null = désactivé)
      const attendanceSettings = await loadEffectiveAttendancePayrollSettings(schema)

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
        const velRes = await rawPool.query<VariableElementRow>(
          `${VARIABLE_ELEMENTS_SQL(schema)}
           WHERE ve.employee_id = $1 AND ve.period_id = $2`, [emp.id, periodId]
        )
        for (const v of velRes.rows) varEls[v.rule_code] = parseInt(v.amount)
        const variableTreatment = treatmentFromRows(velRes.rows)

        // Prorata entrée / sortie, absences, pointage et solde de tout compte
        const monthInputs = await resolveEmployeeMonth(schema, emp, month, attendanceSettings)
        const { absenceCtx, attendance } = monthInputs

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
          workedDays:       monthInputs.workedDays,
          workingDaysMonth,
          atRate:           resolved.atRate,
          maritalStatus:    emp.marital_status ?? 'single',
          childrenCount:    emp.children_count ?? 0,
          variableElements: varEls,
          absence:          absenceCtx?.info,
          attendanceDeductions: attendance?.deductions,
          settlementEarnings: monthInputs.settlementEarnings,
          expenseReimbursement: monthInputs.expenses.total,
          legislationPack:  resolved.legislationPack,
          // Plafond d'exonération transport selon le lieu de travail
          transportZone:    transportZoneFromCity(legalEntity?.city || tenant.city),
          variableTreatment,
        })

        totalGross += result.grossSalary
        totalNet   += result.netPayable
        totalCnps  += result.totalCnpsSal + result.totalCnpsPat
        totalIts   += result.its
        currencies.add(result.currency)

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
              legal_entity_id, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'generated',now(),$17,'pending',$18::jsonb,$19,$20,$21)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            emp.id, periodId, month, emp.base_salary, result.grossSalary,
            result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
            result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
            result.netPayable, result.employerCost, JSON.stringify(result.lines),
            slipPaymentMethod(emp),
            bordereauJson,
            result.indemniteAbsence ?? null,
            resolved.legalEntityId,
            result.currency,
          ]
        ).catch(async () => {
          // Fallback si legal_entity_id pas encore migrée
          return rawPool.query(
            `INSERT INTO "${schema}".pay_slips
               (employee_id, period_id, month, base_salary, gross_salary,
                cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
                total_cnps_sal, total_cnps_pat, its, total_deductions,
                net_payable, employer_cost, lines, status, generated_at,
                payment_method, payment_status, bordereau_cnps, indemnite_absence, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'generated',now(),$17,'pending',$18::jsonb,$19,$20)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              emp.id, periodId, month, emp.base_salary, result.grossSalary,
              result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
              result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
              result.netPayable, result.employerCost, JSON.stringify(result.lines),
              slipPaymentMethod(emp),
              bordereauJson,
              result.indemniteAbsence ?? null,
              result.currency,
            ],
          )
        })
        // Solde de tout compte porté sur ce bulletin : marqué payé
        if (slip.rows[0] && emp.offboarding_id && result.settlementTotal) {
          await markSettlementPaid(schema, emp.offboarding_id, month, slip.rows[0].id)
        }
        // Notes de frais remboursées par ce bulletin : marquées payées
        if (slip.rows[0]) await markExpensesPaid(schema, monthInputs.expenses.ids, slip.rows[0].id)
        if (slip.rows[0]) paySlips.push({
          employeeId: emp.id,
          paySlipId: slip.rows[0].id,
          netPayable: result.netPayable,
          hasAbsence: !!absenceCtx,
          absenceType: absenceCtx?.info.type ?? null,
          hasBordereauCnps: !!result.bordereauCnps,
          ...(monthInputs.window.exitsThisMonth || monthInputs.window.settlementOnly
            ? { finalPayslip: true, settlementTotal: result.settlementTotal ?? 0 } : {}),
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
      const finalPayslipCount = paySlips.filter((s: any) => s.finalPayslip).length
      const bordereauCount = paySlips.filter((s: any) => s.hasBordereauCnps).length

      // Valideur attendu du 1er niveau (circuit nominatif, Paramètres → Workflow)
      let firstLevel: PayrollLevelState | null = null
      try {
        const circuit = await loadPayrollCircuit(rawPool, schema)
        const users = await loadPayrollUsers(rawPool, schema, [circuit.steps[0]?.userId])
        firstLevel = payrollLevelState(circuit,
          { id: periodId, status: 'pending_validation', initiated_by: request.user.sub, initiated_at: new Date() }, [], users)
      } catch { firstLevel = null }
      const pendingWith = pendingWithOf(firstLevel)
      if (pendingWith?.userId) {
        notifyPayrollUser(schema, pendingWith.userId, 'payroll_validation_requested', 'Paie à valider',
          `La paie ${month} attend votre validation (niveau 1/${pendingWith.requiredLevels}).`, { month, periodId, level: 1 })
      }

      return reply.send({
        message: `${pendingValidationMessage(month, firstLevel)}. ${emps.rows.length} bulletin(s) générés.`,
        pendingWith,
        periodId,
        status: 'pending_validation',
        employeesCount: emps.rows.length,
        absencesIntegrées: absenceCount,
        bordereauCnpsCount: bordereauCount,
        bulletinsDeSolde: finalPayslipCount,
        totals: {
          grossSalary: totalGross, netPayable: totalNet,
          cnps: totalCnps, its: totalIts,
          // Clôture par filiale → en pratique une seule devise ; chaque bulletin
          // porte de toute façon la sienne (pay_slips.currency).
          currency: currencies.values().next().value ?? 'XOF',
        },
        paySlips,
      })
    },
  })

  // ── Workflow paramétrable de validation paie ────────────────────────────
  // Cycle : open → pending_validation (via /close) → N approvals → closed
  // OWASP A04 : Segregation of Duties strictement appliquée.
  // workflow_configs.levels_count détermine le nombre d'approbations requises.

  // GET /payroll/periods/:month/workflow — état du circuit : niveaux validés
  // (qui, quand), niveau courant (valideur attendu + échéance) et droits du
  // lecteur (valider / rejeter / annuler), calculés ici — l'UI n'en duplique rien.
  fastify.get('/periods/:month/workflow', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      if (!MONTH_RE.test(month)) return reply.status(400).send({ error: 'Mois invalide (format AAAA-MM attendu).' })
      const schema = request.user.schemaName
      try {
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
        const view = await buildPayrollCircuitView(rawPool, schema, p, request.user)
        return reply.send({
          period: {
            id: p.id, month: p.month, status: p.status,
            initiatedAt: p.initiated_at, initiatedBy: p.initiated_by,
            initiatorName: [p.initiator_first_name, p.initiator_last_name].filter(Boolean).join(' ') || null,
            rejectionReason: p.rejection_reason,
            closedAt: p.closed_at, closedBy: p.closed_by,
          },
          ...view,
        })
      } catch (err) {
        request.log.error({ err, schema, month }, 'payroll workflow state failed')
        return reply.status(500).send({ error: 'Impossible de charger le circuit de validation de la paie. Réessayez.' })
      }
    },
  })

  // POST /payroll/periods/:month/approve — validation du niveau courant par le
  // valideur désigné (ou, échéance dépassée, par l'équipe RH hors initiateur).
  fastify.post('/periods/:month/approve', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      if (!MONTH_RE.test(month)) return reply.status(400).send({ error: 'Mois invalide (format AAAA-MM attendu).' })
      const body = approveBodySchema.safeParse(request.body ?? {})
      if (!body.success) return reply.status(400).send({ error: 'Commentaire invalide (2000 caractères maximum).' })
      const notes = body.data.notes || null
      const schema = request.user.schemaName
      try {
        const loaded = await loadPendingPeriod(schema, month)
        if ('status' in loaded) return reply.status(loaded.status).send({ error: loaded.error })
        const { period: p, circuit, approvals, users, state } = loaded

        const decision = decideOnPeriod(state, p, request.user)
        if (!decision.allowed) {
          return reply.status(403).send({ error: payrollDenialMessage(decision.reason, state) })
        }
        const requiredLevels = circuit.levels
        const level = state?.level ?? approvals.length + 1

        if (state) {
          try {
            await rawPool.query(
              `INSERT INTO "${schema}".pay_period_approvals
                 (period_id, level, approver_id, approver_role, notes)
               VALUES ($1, $2, $3, $4, $5)`,
              [p.id, level, request.user.sub, request.user.role, notes],
            )
          } catch (err) {
            if ((err as { code?: string } | null)?.code === '23505') {
              return reply.status(409).send({ error: 'Ce niveau vient d\'être validé par quelqu\'un d\'autre. Rechargez la page.' })
            }
            throw err
          }
          auditTenant(schema, { userId: request.user.sub, action: 'payroll.approved', entity: 'pay_period', entityId: p.id, changes: { month, level, requiredLevels, escalated: decision.escalated }, ip: request.ip ?? null })
        }

        // Dernier niveau requis atteint → clôture définitive
        if (level >= requiredLevels) {
          await rawPool.query(
            `UPDATE "${schema}".pay_periods
               SET status = 'closed', closed_at = now(), closed_by = $1
               WHERE id = $2`,
            [request.user.sub, p.id],
          )
          auditTenant(schema, { userId: request.user.sub, action: 'payroll.closed', entity: 'pay_period', entityId: p.id, changes: { month, finalLevel: level, requiredLevels, escalated: decision.escalated }, ip: request.ip ?? null })
          notifyPayrollUser(schema, p.initiated_by, 'payroll_closed', 'Paie clôturée',
            `La paie ${month} a été validée à tous les niveaux et clôturée.`, { month, periodId: p.id })
          return reply.send({
            data: { status: 'closed', level, requiredLevels, escalated: decision.escalated },
            message: `Paie ${month} validée à tous les niveaux requis et clôturée.`,
          })
        }

        const next = payrollLevelState(circuit, p,
          [...approvals, { level, approver_id: request.user.sub, approved_at: new Date() }], users)
        const pendingWith = pendingWithOf(next)
        if (pendingWith?.userId) {
          notifyPayrollUser(schema, pendingWith.userId, 'payroll_validation_requested', 'Paie à valider',
            `La paie ${month} attend votre validation (niveau ${pendingWith.level}/${requiredLevels}).`, { month, periodId: p.id, level: pendingWith.level })
        }
        return reply.send({
          data: { status: 'pending_validation', level, requiredLevels, escalated: decision.escalated },
          pendingWith,
          message: `Validation niveau ${level}/${requiredLevels} enregistrée. ${pendingValidationMessage(month, next)}.`,
        })
      } catch (err) {
        request.log.error({ err, schema, month }, 'payroll approve failed')
        return reply.status(500).send({ error: 'La validation de la paie a échoué. Réessayez ; si le problème persiste, contactez le support.' })
      }
    },
  })

  // POST /payroll/periods/:month/reject — rejet / renvoi en préparation par le
  // valideur attendu (ou l'équipe RH après échéance). Commentaire obligatoire.
  // Bulletins générés supprimés, notes de frais et solde de tout compte
  // rétablis (transaction) : la période peut être recalculée puis ré-initiée.
  fastify.post('/periods/:month/reject', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      if (!MONTH_RE.test(month)) return reply.status(400).send({ error: 'Mois invalide (format AAAA-MM attendu).' })
      const body = rejectBodySchema.safeParse(request.body ?? {})
      if (!body.success) {
        return reply.status(400).send({ error: 'Commentaire obligatoire : expliquez le motif du renvoi en préparation (10 caractères minimum).' })
      }
      const reason = body.data.reason
      const schema = request.user.schemaName
      try {
        const loaded = await loadPendingPeriod(schema, month)
        if ('status' in loaded) return reply.status(loaded.status).send({ error: loaded.error })
        const { period: p, state } = loaded

        const decision = decideOnPeriod(state, p, request.user)
        if (!decision.allowed) {
          return reply.status(403).send({ error: payrollDenialMessage(decision.reason, state) })
        }
        let reverted
        try {
          reverted = await resetPendingPeriod(schema, p.id, reason)
        } catch (err) {
          if (err instanceof PayrollResetConflict) return reply.status(409).send({ error: err.message })
          throw err
        }
        auditTenant(schema, { userId: request.user.sub, action: 'payroll.rejected', entity: 'pay_period', entityId: p.id, changes: {
          month, reason, level: state?.level ?? null, escalated: decision.escalated,
          deletedPaySlips: reverted.deletedPaySlips, restoredExpenses: reverted.restoredExpenses, restoredSettlements: reverted.restoredSettlements,
        }, ip: request.ip ?? null })
        const actorName = [request.user.firstName, request.user.lastName].filter(Boolean).join(' ').trim() || 'un valideur'
        notifyPayrollUser(schema, p.initiated_by, 'payroll_rejected', 'Paie renvoyée en préparation',
          `La paie ${month} a été renvoyée en préparation par ${actorName}. Motif : ${reason}`, { month, periodId: p.id })
        return reply.send({
          data: { status: 'open', ...reverted },
          message: 'Paie renvoyée en préparation : les bulletins générés ont été supprimés. Corrigez puis relancez la clôture.',
        })
      } catch (err) {
        request.log.error({ err, schema, month }, 'payroll reject failed')
        return reply.status(500).send({ error: 'Le renvoi en préparation a échoué. Réessayez ; si le problème persiste, contactez le support.' })
      }
    },
  })

  // POST /payroll/periods/:month/cancel — l'INITIATEUR annule sa clôture tant
  // qu'aucun niveau n'a validé (mêmes effets que le rejet, sans motif imposé).
  fastify.post('/periods/:month/cancel', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const { month } = request.params as { month: string }
      if (!MONTH_RE.test(month)) return reply.status(400).send({ error: 'Mois invalide (format AAAA-MM attendu).' })
      const body = cancelBodySchema.safeParse(request.body ?? {})
      if (!body.success) return reply.status(400).send({ error: 'Commentaire invalide (2000 caractères maximum).' })
      const schema = request.user.schemaName
      try {
        const loaded = await loadPendingPeriod(schema, month)
        if ('status' in loaded) return reply.status(loaded.status).send({ error: loaded.error })
        const { period: p, approvals } = loaded
        if (p.initiated_by !== request.user.sub) {
          return reply.status(403).send({ error: 'Seul l\'initiateur de la clôture peut annuler son initiation.' })
        }
        if (approvals.length > 0) {
          return reply.status(409).send({ error: 'Un niveau a déjà été validé : l\'initiation ne peut plus être annulée. Demandez au valideur de renvoyer la période en préparation.' })
        }
        let reverted
        try {
          reverted = await resetPendingPeriod(schema, p.id, null, { requireNoApproval: true })
        } catch (err) {
          if (err instanceof PayrollResetConflict) return reply.status(409).send({ error: err.message })
          throw err
        }
        auditTenant(schema, { userId: request.user.sub, action: 'payroll.initiation_cancelled', entity: 'pay_period', entityId: p.id, changes: {
          month, comment: body.data.comment || null,
          deletedPaySlips: reverted.deletedPaySlips, restoredExpenses: reverted.restoredExpenses, restoredSettlements: reverted.restoredSettlements,
        }, ip: request.ip ?? null })
        return reply.send({
          data: { status: 'open', ...reverted },
          message: 'Initiation annulée : la période est revenue en préparation et les bulletins générés ont été supprimés.',
        })
      } catch (err) {
        request.log.error({ err, schema, month }, 'payroll cancel failed')
        return reply.status(500).send({ error: 'L\'annulation de l\'initiation a échoué. Réessayez ; si le problème persiste, contactez le support.' })
      }
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
        // Bulletin non publié (période pas encore clôturée) : 404 — on ne
        // révèle pas au salarié l'existence d'une paie en cours de validation.
        if (slip.period_status !== EMPLOYEE_VISIBLE_PERIOD_STATUS) {
          return reply.status(404).send({ error: 'Bulletin introuvable' })
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

      // Comparaison : 3 mois précédents pour le même employé (côté salarié :
      // uniquement des bulletins publiés, période clôturée).
      const compParams: unknown[] = [slip.employee_id, id, slip.month]
      let compPublished = ''
      if (role === 'employee') {
        compParams.push(EMPLOYEE_VISIBLE_PERIOD_STATUS)
        compPublished = ` AND EXISTS (SELECT 1 FROM "${schema}".pay_periods pp
                                      WHERE pp.id = ps.period_id AND pp.status = $4)`
      }
      const compRes = await rawPool.query<{
        month: string; gross_salary: string; net_payable: string
        total_cnps_sal: string; its: string
      }>(
        `SELECT ps.month, ps.gross_salary, ps.net_payable, ps.total_cnps_sal, ps.its
           FROM "${schema}".pay_slips ps
          WHERE ps.employee_id = $1 AND ps.id <> $2 AND ps.month < $3${compPublished}
          ORDER BY ps.month DESC LIMIT 3`,
        compParams,
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
        reimbursements: explained
          .filter(l => l.type === 'reimbursement')
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

      // Seuls les bulletins PUBLIÉS (période clôturée) sont visibles — et
      // marqués « vus » — en self-service, quel que soit le rôle (un manager
      // ou un RH consultant SES bulletins est un salarié à cet égard).
      await rawPool.query(
        `UPDATE "${schema}".pay_slips ps
         SET viewed_by_employee_at = now()
         FROM "${schema}".pay_periods pp
         WHERE ps.employee_id = $1 AND ps.viewed_by_employee_at IS NULL
           AND pp.id = ps.period_id AND pp.status = $2`,
        [employeeId, EMPLOYEE_VISIBLE_PERIOD_STATUS]
      )

      const res = await rawPool.query(
        `SELECT ps.id, ps.month, ps.gross_salary, ps.net_payable, ps.its, ps.total_cnps_sal,
                ps.status, ps.payment_method, ps.payment_status, ps.payment_reference,
                ps.generated_at, ps.viewed_by_employee_at, ps.file_url, ps.currency,
                ps.indemnite_absence, ps.bordereau_cnps
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".pay_periods pp ON pp.id = ps.period_id AND pp.status = $2
         WHERE ps.employee_id = $1
         ORDER BY ps.month DESC LIMIT 24`,
        [employeeId, EMPLOYEE_VISIBLE_PERIOD_STATUS]
      )
      return reply.send({ data: res.rows, currency: res.rows[0]?.currency ?? 'XOF' })
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
           JOIN "${schema}".pay_periods pp ON pp.id = ps.period_id AND pp.status = $3
          WHERE ps.id = $1 AND ps.employee_id = $2 LIMIT 1`,
        [id, employeeId, EMPLOYEE_VISIBLE_PERIOD_STATUS],
      )
      const slip = slipRes.rows[0]
      // Inexistant, d'un autre salarié OU non publié (période non clôturée) : 404.
      if (!slip) return reply.status(404).send({ error: 'Bulletin introuvable' })

      // Employeur + modèle de bulletin personnalisable (logo, colonnes, couleur…)
      const tenantRes = await rawPool.query<{
        name: string; cnps_number: string | null; city: string | null; payslip_config: unknown
        has_subsidiaries: boolean | null; default_country_code: string | null
      }>(
        `SELECT name, cnps_number, city, payslip_config, has_subsidiaries, default_country_code
           FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
        [schema],
      ).catch(() => ({ rows: [] as Array<{ name: string; cnps_number: string | null; city: string | null; payslip_config: unknown; has_subsidiaries: boolean | null; default_country_code: string | null }> }))
      const tenant = tenantRes.rows[0]
      const tenantName = tenant?.name ?? 'Employeur'

      // Portée auto : multi-filiale → pays de la filiale du bulletin ; sinon pays
      // par défaut du tenant. resolvePayslipTemplateConfig applique la surcharge pays.
      let country = tenant?.default_country_code ?? 'CIV'
      if (tenant?.has_subsidiaries) {
        const le = await rawPool.query<{ country_code: string | null }>(
          `SELECT le.country_code FROM "${schema}".pay_slips ps
             LEFT JOIN "${schema}".legal_entities le ON le.id = ps.legal_entity_id
            WHERE ps.id = $1 LIMIT 1`, [id],
        ).catch(() => ({ rows: [] as Array<{ country_code: string | null }> }))
        country = le.rows[0]?.country_code || country
      }
      const tpl = resolvePayslipTemplateConfig(tenant?.payslip_config, country)

      // Logo raster (PNG/JPG) du modèle, depuis le store d'images de la plateforme.
      let logo: { bytes: Uint8Array; mime: string } | null = null
      if (typeof tpl.logoAssetId === 'string' && tpl.logoAssetId) {
        const a = await rawPool.query<{ bytes: Buffer; mime: string }>(
          `SELECT bytes, mime FROM platform.brand_assets WHERE id = $1 LIMIT 1`, [tpl.logoAssetId],
        ).catch(() => ({ rows: [] as Array<{ bytes: Buffer; mime: string }> }))
        if (a.rows[0] && !/svg/i.test(a.rows[0].mime)) {
          logo = { bytes: new Uint8Array(a.rows[0].bytes), mime: a.rows[0].mime }
        }
      }

      // PAY-025 — cumuls annuels (YTD) : somme des bulletins de l'année ≤ ce mois.
      const year = slip.month.slice(0, 4)
      const cum = await rawPool.query<{ g: string; c: string; i: string; n: string }>(
        `SELECT COALESCE(SUM(ps.gross_salary),0) g, COALESCE(SUM(ps.total_cnps_sal),0) c,
                COALESCE(SUM(ps.its),0) i, COALESCE(SUM(ps.net_payable),0) n
           FROM "${schema}".pay_slips ps
           JOIN "${schema}".pay_periods pp ON pp.id = ps.period_id AND pp.status = $4
          WHERE ps.employee_id = $1 AND ps.month LIKE $2 AND ps.month <= $3`,
        [employeeId, `${year}-%`, slip.month, EMPLOYEE_VISIBLE_PERIOD_STATUS],
      ).catch(() => ({ rows: [{ g: '0', c: '0', i: '0', n: '0' }] }))
      const c0 = cum.rows[0]!

      const rawLines = Array.isArray(slip.lines) ? (slip.lines as PayslipPdfLine[]) : []
      // Mentions obligatoires (embauche/ancienneté, catégorie, temps de travail,
      // congés, RCCM/DGI) — lecture seule, sans impact sur les montants.
      const mentions = await loadPayslipMentions(rawPool, schema, employeeId, slip.month)

      const pdf = await renderPayslipPdf({
        tenantName,
        employer: { cnpsNumber: tenant?.cnps_number ?? null, city: tenant?.city ?? null, ...mentions.employer },
        employee: {
          firstName: slip.first_name, lastName: slip.last_name, jobTitle: slip.job_title,
          cnpsNumber: slip.cnps_number, nni: slip.nni, ...mentions.employee,
        },
        worked: mentions.worked,
        leaveBalance: mentions.leaveBalance,
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
        annualCumuls: {
          grossSalary: Number(c0.g), totalCnpsSal: Number(c0.c),
          its: Number(c0.i), netPayable: Number(c0.n),
        },
        caisseLabel: getPackByCountry(country)?.labelCaisseSociale ?? null,
        impotLabel: getPackByCountry(country)?.labelImpotSalaire ?? null,
        template: {
          accentColor: typeof tpl.accentColor === 'string' ? tpl.accentColor : null,
          logo,
          showBaseColumn: tpl.showBaseColumn !== false,
          showCodeColumn: tpl.showCodeColumn !== false,
          showEmployerCost: tpl.showEmployerCost !== false,
          showAnnualCumuls: tpl.showAnnualCumuls !== false,
          footerText: typeof tpl.footerText === 'string' ? tpl.footerText : null,
          blocks: Array.isArray(tpl.blocks)
            ? (tpl.blocks as Array<{ id: string; enabled?: boolean; text?: string }>) : undefined,
        },
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
      const schema = request.user.schemaName
      const res = await rawPool.query<PeriodForValidation & Record<string, unknown>>(
        `SELECT * FROM "${schema}".pay_periods ORDER BY month DESC`
      )
      // Valideur attendu (nom + fonction + échéance) des périodes en validation
      const pendingWith = await describePendingPeriods(rawPool, schema, res.rows)
        .catch(() => new Map<string, ReturnType<typeof pendingWithOf>>())
      return reply.send({
        data: res.rows.map(row => ({ ...row, pending_with: pendingWith.get(String(row.id)) ?? null })),
      })
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

      // OWASP A03 — anti-injection de formule CSV (Excel `=`,`+`,`-`,`@`…) : chaque
      // champ passe par encodeField (préfixe apostrophe + quoting) avant .join.
      const csvCell = (v: unknown) => encodeField(v, ';')

      const header = [
        'Mois','Nom','Prénom','N° CNPS','NNI','Poste','Département','Contrat',
        'Salaire Base','Brut','CNPS Ret. Sal.','CNPS PF Pat.','CNPS AT Pat.','CNPS Ret. Pat.',
        'Total CNPS Sal.','Total CNPS Pat.','ITS','Indemnité Absence','Net à Payer','Coût Employeur','Mode Paiement',
      ].map(csvCell).join(';')

      const rows = res.rows.map((r: Record<string, unknown>) => [
        r.month, r.last_name, r.first_name, r.cnps_number, r.nni,
        r.job_title, r.department_name, r.contract_type,
        r.base_salary, r.gross_salary,
        r.cnps_retraite_sal, r.cnps_pf_pat, r.cnps_at_pat, r.cnps_retraite_pat,
        r.total_cnps_sal, r.total_cnps_pat, r.its, r.indemnite_absence,
        r.net_payable, r.employer_cost, r.payment_method,
      ].map(csvCell).join(';'))

      const csv = `${csvCell(`Livre de paie ${year} — ${tenant?.name ?? ''} | CNPS: ${tenant?.cnps_number ?? ''}`)}\n${header}\n${rows.join('\n')}`

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
      auditTenant(schema, { userId: request.user.sub, action: 'payroll.simulated', entity: 'payroll_simulation', entityId: body.employee_id ?? null, changes: {
           baseSalary: body.baseSalary,
           hasAbsence: !!body.absence,
           variableElementsCount: Object.keys(body.variableElements ?? {}).length,
           grossSalary: result.grossSalary,
           netPayable: result.netPayable,
           employerCost: result.employerCost,
         }, ip: request.ip ?? null })

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
