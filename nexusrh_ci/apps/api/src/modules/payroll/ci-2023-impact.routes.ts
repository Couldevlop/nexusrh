/**
 * Rapport d'impact de la correction de la paie ivoirienne (valeurs en vigueur
 * depuis le 01/01/2023) — GET /payroll/ci-2023-impact[?format=csv].
 *
 * Les bulletins clôturés ne sont JAMAIS modifiés (décision du 04/11/2026 :
 * correction à partir de la prochaine paie). Ce rapport, en LECTURE SEULE,
 * chiffre pour le tenant ce que l'ancien paramétrage a laissé de côté sur ses
 * bulletins clôturés depuis 01/2023, pack CIV uniquement :
 *
 *  - retraite non cotisée : plafond 1 647 315 au lieu de 3 375 000 (communiqué
 *    CNPS « Nouveau plafond des cotisations sociales », décret n° 2022-986) :
 *    max(0, min(assiette, 3 375 000) − 1 647 315) × 6,3 % (salarié) / × 7,7 %
 *    (employeur) ;
 *  - AT / PF / maternité patronal manquant : plafond 70 000 au lieu de 75 000 :
 *    max(0, min(assiette, 75 000) − 70 000) × (5 % + 0,75 % + taux AT du bulletin) ;
 *  - CMU non retenue (loi n° 2014-131 ; CLEISS 2025) : ESTIMATION d'après les
 *    bénéficiaires ACTUELS de la fiche salarié (`computeCmu` du moteur) :
 *    500 F par bénéficiaire partagé et par côté (salarié, conjoint sans emploi
 *    d'un salarié marié, jusqu'à 6 enfants), PLUS 1 000 F à la charge du
 *    salarié par enfant au-delà du 6e. Une seule estimation par salarié et par
 *    mois, même si le mois compte plusieurs bulletins clôturés ; aucune si l'un
 *    d'eux porte déjà une ligne CMU (2200 / 3400) ;
 *  - `conjoint_a_verifier` : salarié marié dont la situation du conjoint
 *    (sans emploi ou non) n'est pas renseignée — conjoint non compté ;
 *  - drapeau `heures_supp_a_verifier` : le bulletin porte des lignes 1500 ou
 *    1550, dont les taux ont changé de sens (décret n° 2024-898, art. 25) ;
 *  - périodes OUVERTES : éléments variables HEURES_SUPP_NUIT / HEURES_SUPP_FERIE
 *    déjà saisis, « à revoir avant clôture » — depuis le décret n° 2024-898 ils
 *    valent nuit +75 % et dimanche / férié de nuit +100 % (les heures de
 *    dimanche de jour vont désormais en HEURES_SUPP_DIM).
 *
 * Assiette : le brut du bulletin, sauf quand les bases portées par ses lignes
 * (2000 retraite, 3100 AT/PF) prouvent qu'aucun plafond n'était atteint (base
 * inférieure à l'ancien plafond) ou que le bulletin applique déjà le nouveau
 * plafond (base supérieure) : l'écart est alors nul. Quand la base vaut
 * l'ancien plafond (ou que la ligne manque), le brut sert d'assiette : il peut
 * contenir une part exonérée (transport…) → « estimation majorante ».
 *
 * Accès : admin, hr_manager. Isolation : schéma du JWT uniquement.
 */
import type { FastifyPluginAsync } from 'fastify'
import { pool as rawPool } from '../../db/pool.js'
import { CIV_2024 } from '../../services/legislation-packs.js'
import { computeCmu, isCmuSpouseToVerify } from '../../services/payroll-engine-ci.js'
import { employeeCmu } from '../../services/final-payslip.service.js'
import { encodeField } from '../sage/sage.service.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { requestHrScope } from '../../utils/hr-scope.js'

/** Plafonds CNPS appliqués à tort après le 31/12/2022 (historique, pas une valeur en vigueur). */
export const CNPS_PLAFONDS_AVANT_2023 = { retraite: 1_647_315, atPf: 70_000 } as const
export const IMPACT_FROM_MONTH = '2023-01'
export const CMU_ESTIMATION_LABEL = 'estimation (bénéficiaires actuels)'
export const ESTIMATION_MAJORANTE_LABEL = 'estimation majorante'
export const OPEN_PERIOD_FLAG = 'à revoir avant clôture'
/** Sens des clés d'heures supplémentaires depuis le décret n° 2024-898 (art. 25). */
export const OPEN_PERIOD_OVERTIME_MEANING: Readonly<Record<'HEURES_SUPP_NUIT' | 'HEURES_SUPP_FERIE', string>> = {
  HEURES_SUPP_NUIT: 'heures de nuit, +75 % (décret n° 2024-898, art. 25)',
  HEURES_SUPP_FERIE: 'heures de nuit des dimanches et jours fériés, +100 % (décret n° 2024-898, art. 25)',
}
type OpenPeriodOvertimeCode = keyof typeof OPEN_PERIOD_OVERTIME_MEANING
const isOpenPeriodOvertimeCode = (c: string): c is OpenPeriodOvertimeCode => c in OPEN_PERIOD_OVERTIME_MEANING

export interface ImpactSlipRow {
  id: string
  employee_id: string
  month: string
  gross_salary: string | number | null
  lines: unknown
  legal_entity_id: string | null
  first_name: string | null
  last_name: string | null
  employee_number: string | null
  marital_status: string | null
  children_count: number | null
  cmu_spouse_covered: boolean | null
  cmu_children_covered: number | null
  le_pack_code: string | null
  le_country_code: string | null
}

/** Élément variable d'heures supplémentaires saisi sur une période non clôturée. */
export interface OpenPeriodOvertimeRow {
  employee_id: string
  month: string
  period_status: string
  rule_code: string
  amount: string | number
  first_name: string | null
  last_name: string | null
  employee_number: string | null
  legal_entity_id: string | null
  le_pack_code: string | null
  le_country_code: string | null
}

export interface OpenPeriodOvertime {
  employeeId: string
  employeeNumber: string | null
  name: string
  month: string
  periodStatus: string
  code: OpenPeriodOvertimeCode
  amount: number
  flag: typeof OPEN_PERIOD_FLAG
  meaning: string
}

export interface SlipImpact {
  slipId: string
  employeeId: string
  month: string
  gross: number
  retraiteSal: number
  retraitePat: number
  atPfPat: number
  /** Écart retraite calculé sur le brut (base à l'ancien plafond ou absente) */
  retraiteEstimationMajorante: boolean
  /** Écart AT/PF calculé sur le brut (base à l'ancien plafond ou absente) */
  atPfEstimationMajorante: boolean
  cmuSal: number
  cmuPat: number
  /** Le bulletin porte déjà une ligne CMU (2200 / 3400) */
  cmuOnSlip: boolean
  conjointAVerifier: boolean
  heuresSuppAVerifier: boolean
}

export interface ImpactTotals {
  slips: number
  retraiteSal: number
  retraitePat: number
  atPfPat: number
  cmuSal: number
  cmuPat: number
  heuresSuppAVerifier: number
  /** Salarié × mois dont le conjoint est à vérifier (CMU) */
  conjointAVerifier: number
  /** Retraite + AT/PF + CMU, salarié + employeur */
  total: number
}

interface SlipLine { code: string; base: number; amount: number; label: string }

function toLines(raw: unknown): SlipLine[] {
  let v: unknown = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return [] }
  }
  if (!Array.isArray(v)) return []
  const out: SlipLine[] = []
  for (const l of v) {
    if (typeof l !== 'object' || l === null) continue
    const o = l as Record<string, unknown>
    out.push({
      code: String(o.code ?? ''),
      base: Number(o.base ?? 0) || 0,
      amount: Number(o.amount ?? 0) || 0,
      label: String(o.label ?? ''),
    })
  }
  return out
}

/** Pack CIV : pack explicite de la filiale (CIV-*), sinon son pays, sinon le pays du tenant (défaut CIV). */
export function isCivSlip(
  row: Pick<ImpactSlipRow, 'legal_entity_id' | 'le_pack_code' | 'le_country_code'>,
  tenantCountry: string | null,
): boolean {
  if (row.legal_entity_id) {
    const pack = row.le_pack_code?.trim()
    if (pack) return pack.toUpperCase().startsWith('CIV-')
    return (row.le_country_code?.trim() || 'CIV').toUpperCase() === 'CIV'
  }
  return (tenantCountry?.trim() || 'CIV').toUpperCase() === 'CIV'
}

/** Taux AT du bulletin : libellé « (2.00%) » de la ligne 3300, sinon montant / base, sinon taux du tenant. */
export function slipAtRate(lines: readonly SlipLine[], fallback: number): number {
  const at = lines.find(l => l.code === '3300')
  if (at) {
    const m = /\(([\d.,]+)\s*%\)/.exec(at.label)
    if (m) {
      const r = Number(m[1]!.replace(',', '.')) / 100
      if (Number.isFinite(r) && r >= 0) return r
    }
    if (at.base > 0) return Math.round((at.amount / at.base) * 10_000) / 10_000
  }
  return fallback
}

/**
 * Assiette à retenir pour un écart de plafond : null = aucun écart (la base du
 * bulletin prouve un salaire sous l'ancien plafond, ou le nouveau plafond déjà
 * appliqué) ; sinon le brut (estimation haute : le brut contient la part
 * exonérée éventuelle).
 */
function gapBase(lines: readonly SlipLine[], code: string, oldCap: number, gross: number): number | null {
  const l = lines.find(x => x.code === code)
  if (!l) return gross
  if (l.base === oldCap) return gross
  return null
}

const nameOf = (r: { last_name: string | null; first_name: string | null }): string =>
  `${r.last_name ?? ''} ${r.first_name ?? ''}`.trim()

/** Impact d'un bulletin clôturé (pur, entiers FCFA, arrondi inférieur comme le moteur). */
export function computeSlipImpact(row: ImpactSlipRow, tenantAtRate: number): SlipImpact {
  const lines = toLines(row.lines)
  const gross = Math.max(0, Math.round(Number(row.gross_salary ?? 0) || 0))
  const pack = CIV_2024

  let retraiteSal = 0
  let retraitePat = 0
  const ret = gapBase(lines, '2000', CNPS_PLAFONDS_AVANT_2023.retraite, gross)
  if (ret !== null) {
    const gap = Math.max(0, Math.min(ret, pack.plafondCnpsRetraite) - CNPS_PLAFONDS_AVANT_2023.retraite)
    retraiteSal = Math.floor(gap * pack.tauxCotisationRetraiteSalarie)
    retraitePat = Math.floor(gap * pack.tauxCotisationRetraitePatronal)
  }

  let atPfPat = 0
  const atpf = gapBase(lines, '3100', CNPS_PLAFONDS_AVANT_2023.atPf, gross)
  if (atpf !== null) {
    const gap = Math.max(0, Math.min(atpf, pack.plafondCnpsAtPf) - CNPS_PLAFONDS_AVANT_2023.atPf)
    const rate = pack.tauxCotisationPfPatronal + pack.tauxCotisationMaternitePatronal + slipAtRate(lines, tenantAtRate)
    atPfPat = Math.floor(gap * rate + 1e-6)
  }

  // CMU déjà retenue sur le bulletin : rien à estimer. Sinon, moteur de paie
  // (bénéficiaires actuels ; +1 000 F salarié par enfant au-delà du 6e).
  const cmuOnSlip = lines.some(l => l.code === '2200' || l.code === '3400')
  let cmuSal = 0
  let cmuPat = 0
  if (!cmuOnSlip) {
    const cmu = computeCmu(pack, row.children_count ?? 0, employeeCmu(row), row.marital_status ?? undefined)
    cmuSal = cmu.sal
    cmuPat = cmu.pat
  }

  return {
    slipId: row.id,
    employeeId: row.employee_id,
    month: row.month,
    gross,
    retraiteSal, retraitePat, atPfPat,
    retraiteEstimationMajorante: ret !== null && retraiteSal + retraitePat > 0,
    atPfEstimationMajorante: atpf !== null && atPfPat > 0,
    cmuSal, cmuPat, cmuOnSlip,
    conjointAVerifier: isCmuSpouseToVerify(row.marital_status, row.cmu_spouse_covered),
    heuresSuppAVerifier: lines.some(l => (l.code === '1500' || l.code === '1550') && l.amount !== 0),
  }
}

function emptyTotals(): ImpactTotals {
  return { slips: 0, retraiteSal: 0, retraitePat: 0, atPfPat: 0, cmuSal: 0, cmuPat: 0, heuresSuppAVerifier: 0, conjointAVerifier: 0, total: 0 }
}

function addTo(t: Omit<ImpactTotals, 'conjointAVerifier'>, s: SlipImpact): void {
  t.slips += 1
  t.retraiteSal += s.retraiteSal
  t.retraitePat += s.retraitePat
  t.atPfPat += s.atPfPat
  t.cmuSal += s.cmuSal
  t.cmuPat += s.cmuPat
  if (s.heuresSuppAVerifier) t.heuresSuppAVerifier += 1
  t.total += s.retraiteSal + s.retraitePat + s.atPfPat + s.cmuSal + s.cmuPat
}

export type EmployeeMonthImpact = Omit<ImpactTotals, 'conjointAVerifier'> & {
  employeeId: string; employeeNumber: string | null; name: string; month: string
  /** Au moins un écart retraite / AT-PF du mois calculé sur le brut */
  retraiteEstimationMajorante: boolean
  atPfEstimationMajorante: boolean
  /** Salarié marié, situation du conjoint (CMU) non renseignée */
  conjointAVerifier: boolean
}

export interface ImpactReport {
  from: string
  slipsAnalyzed: number
  slipsExcludedNonCiv: number
  cmuNote: string
  totals: ImpactTotals
  byEmployee: Array<ImpactTotals & { employeeId: string; employeeNumber: string | null; name: string }>
  byMonth: Array<ImpactTotals & { month: string }>
  /** Une ligne par salarié et par mois (export CSV) */
  byEmployeeMonth: EmployeeMonthImpact[]
  /** Salariés mariés dont la situation du conjoint (CMU) est à renseigner */
  cmuSpouseToVerify: Array<{ employeeId: string; employeeNumber: string | null; name: string }>
  /** Heures supp. NUIT / FERIE saisies sur des périodes ouvertes : à revoir avant clôture */
  openPeriodOvertime: OpenPeriodOvertime[]
}

/** Lignes HEURES_SUPP_NUIT / FERIE non nulles des périodes ouvertes, CIV seulement. */
export function openPeriodOvertimeFlags(rows: readonly OpenPeriodOvertimeRow[], tenantCountry: string | null): OpenPeriodOvertime[] {
  const out: OpenPeriodOvertime[] = []
  for (const r of rows) {
    if (!isOpenPeriodOvertimeCode(r.rule_code) || !isCivSlip(r, tenantCountry)) continue
    const amount = Math.round(Number(r.amount) || 0)
    if (amount === 0) continue
    out.push({
      employeeId: r.employee_id, employeeNumber: r.employee_number, name: nameOf(r),
      month: r.month, periodStatus: r.period_status, code: r.rule_code, amount,
      flag: OPEN_PERIOD_FLAG, meaning: OPEN_PERIOD_OVERTIME_MEANING[r.rule_code],
    })
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name, 'fr') || a.code.localeCompare(b.code))
}

export function buildImpactReport(
  rows: readonly ImpactSlipRow[], tenantCountry: string | null, tenantAtRate: number,
  openRows: readonly OpenPeriodOvertimeRow[] = [],
): ImpactReport {
  const totals = emptyTotals()
  const byEmp = new Map<string, ImpactTotals & { employeeId: string; employeeNumber: string | null; name: string }>()
  const byMonth = new Map<string, ImpactTotals & { month: string }>()
  const byEmpMonth = new Map<string, EmployeeMonthImpact>()
  let excluded = 0
  let analyzed = 0

  // Bulletins CIV, regroupés par salarié × mois : la CMU est un forfait
  // mensuel — estimée une seule fois par mois, et pas du tout si l'un des
  // bulletins du mois la porte déjà.
  const groups = new Map<string, Array<{ row: ImpactSlipRow; s: SlipImpact }>>()
  for (const row of rows) {
    if (!isCivSlip(row, tenantCountry)) { excluded += 1; continue }
    analyzed += 1
    const s = computeSlipImpact(row, tenantAtRate)
    const k = `${s.employeeId}|${s.month}`
    const g = groups.get(k)
    if (g) g.push({ row, s }); else groups.set(k, [{ row, s }])
  }
  const toVerify = new Map<string, { employeeId: string; employeeNumber: string | null; name: string }>()
  for (const [k, group] of groups) {
    const cmuAlreadyWithheld = group.some(x => x.s.cmuOnSlip)
    group.forEach((x, i) => {
      if (cmuAlreadyWithheld || i > 0) { x.s.cmuSal = 0; x.s.cmuPat = 0 }
    })
    const first = group[0]!
    const name = nameOf(first.row)
    const em: EmployeeMonthImpact = {
      ...emptyTotals(), employeeId: first.s.employeeId, employeeNumber: first.row.employee_number, name, month: first.s.month,
      retraiteEstimationMajorante: false, atPfEstimationMajorante: false, conjointAVerifier: false,
    }
    byEmpMonth.set(k, em)
    let e = byEmp.get(first.s.employeeId)
    if (!e) { e = { ...emptyTotals(), employeeId: first.s.employeeId, employeeNumber: first.row.employee_number, name }; byEmp.set(first.s.employeeId, e) }
    let m = byMonth.get(first.s.month)
    if (!m) { m = { ...emptyTotals(), month: first.s.month }; byMonth.set(first.s.month, m) }
    for (const { s } of group) {
      addTo(totals, s); addTo(e, s); addTo(m, s); addTo(em, s)
      if (s.retraiteEstimationMajorante) em.retraiteEstimationMajorante = true
      if (s.atPfEstimationMajorante) em.atPfEstimationMajorante = true
    }
    if (first.s.conjointAVerifier) {
      em.conjointAVerifier = true
      for (const t of [totals, e, m]) t.conjointAVerifier += 1
      toVerify.set(first.s.employeeId, { employeeId: first.s.employeeId, employeeNumber: first.row.employee_number, name })
    }
  }
  return {
    from: IMPACT_FROM_MONTH,
    slipsAnalyzed: analyzed,
    slipsExcludedNonCiv: excluded,
    cmuNote: CMU_ESTIMATION_LABEL,
    totals,
    byEmployee: [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    byEmployeeMonth: [...byEmpMonth.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'fr') || a.month.localeCompare(b.month)),
    cmuSpouseToVerify: [...toVerify.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    openPeriodOvertime: openPeriodOvertimeFlags(openRows, tenantCountry),
  }
}

const CSV_HEADER = [
  'mois', 'matricule', 'salarie', 'bulletins',
  'retraite_non_cotisee_salarie', 'retraite_non_cotisee_employeur', 'retraite_estimation',
  'at_pf_maternite_employeur_manquant', 'at_pf_estimation',
  `cmu_salarie_${CMU_ESTIMATION_LABEL}`, `cmu_employeur_${CMU_ESTIMATION_LABEL}`,
  'conjoint_a_verifier', 'bulletins_heures_supp_a_verifier', 'total',
]
const OPEN_PERIOD_HEADER = [
  'periodes_ouvertes', 'matricule', 'salarie', 'code', 'montant', 'statut_periode', 'alerte', 'sens_depuis_decret_2024_898',
]

export function impactCsv(report: ImpactReport): string {
  const cell = (v: unknown) => encodeField(v, ';')
  const est = (b: boolean) => (b ? ESTIMATION_MAJORANTE_LABEL : '')
  const lines = [CSV_HEADER.map(cell).join(';')]
  for (const r of report.byEmployeeMonth) {
    lines.push([
      r.month, r.employeeNumber ?? '', r.name, r.slips,
      r.retraiteSal, r.retraitePat, est(r.retraiteEstimationMajorante),
      r.atPfPat, est(r.atPfEstimationMajorante),
      r.cmuSal, r.cmuPat, r.conjointAVerifier ? 'oui' : 'non', r.heuresSuppAVerifier, r.total,
    ].map(cell).join(';'))
  }
  const t = report.totals
  lines.push([
    'TOTAL', '', '', t.slips, t.retraiteSal, t.retraitePat, '', t.atPfPat, '', t.cmuSal, t.cmuPat,
    t.conjointAVerifier, t.heuresSuppAVerifier, t.total,
  ].map(cell).join(';'))
  if (report.openPeriodOvertime.length > 0) {
    lines.push('', OPEN_PERIOD_HEADER.map(cell).join(';'))
    for (const o of report.openPeriodOvertime) {
      lines.push([o.month, o.employeeNumber ?? '', o.name, o.code, o.amount, o.periodStatus, o.flag, o.meaning].map(cell).join(';'))
    }
  }
  return lines.join('\r\n')
}

const ci2023ImpactRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/ci-2023-impact', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['payroll'], summary: "Rapport d'impact — paie CI 2023 (plafonds CNPS, CMU), lecture seule" },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { format } = (request.query ?? {}) as { format?: string }
      if (format !== undefined && format !== 'csv' && format !== 'json') {
        return reply.status(400).send({ error: 'Format invalide : « csv » ou « json » attendu' })
      }
      try {
        await ensureTenantSchema(schema)
        const tenantRes = await rawPool.query<{ default_country_code: string | null; at_rate: string | null }>(
          `SELECT default_country_code, at_rate FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
        )
        const tenant = tenantRes.rows[0]
        const tenantAtRate = Number(tenant?.at_rate ?? CIV_2024.tauxAtDefaultPatronal) || CIV_2024.tauxAtDefaultPatronal
        // Périmètre filiale (habilitations RH) : un RH borné à une filiale ne
        // chiffre que SES salariés. 'TRUE' pour l'admin du tenant et le DRH
        // habilité sur toutes les filiales — le rapport reste alors complet.
        const scope = await requestHrScope(request, 'e')
        const slips = await rawPool.query<ImpactSlipRow>(
          `SELECT ps.id, ps.employee_id, ps.month, ps.gross_salary, ps.lines, ps.legal_entity_id,
                  e.first_name, e.last_name, e.employee_number, e.marital_status, e.children_count,
                  e.cmu_spouse_covered, e.cmu_children_covered,
                  le.legislation_pack_code AS le_pack_code, le.country_code AS le_country_code
             FROM "${schema}".pay_slips ps
             JOIN "${schema}".pay_periods pp ON pp.id = ps.period_id
             LEFT JOIN "${schema}".employees e ON e.id = ps.employee_id
             LEFT JOIN "${schema}".legal_entities le ON le.id = ps.legal_entity_id
            WHERE pp.status = 'closed' AND ps.month >= $1 AND ${scope}
            ORDER BY ps.month, e.last_name, e.first_name`,
          [IMPACT_FROM_MONTH],
        )
        // Périodes non clôturées : heures supp. NUIT / FERIE déjà saisies (sens
        // changé par le décret n° 2024-898) — à revoir avant la clôture.
        const openVe = await rawPool.query<OpenPeriodOvertimeRow>(
          `SELECT ve.employee_id, pp.month, pp.status AS period_status, ve.rule_code, ve.amount,
                  e.first_name, e.last_name, e.employee_number,
                  COALESCE(pp.legal_entity_id, e.legal_entity_id) AS legal_entity_id,
                  COALESCE(NULLIF(TRIM(pp.legislation_pack_code), ''), le.legislation_pack_code) AS le_pack_code,
                  le.country_code AS le_country_code
             FROM "${schema}".variable_elements ve
             JOIN "${schema}".pay_periods pp ON pp.id = ve.period_id
             LEFT JOIN "${schema}".employees e ON e.id = ve.employee_id
             LEFT JOIN "${schema}".legal_entities le ON le.id = COALESCE(pp.legal_entity_id, e.legal_entity_id)
            WHERE pp.status <> 'closed'
              AND ve.rule_code IN ('HEURES_SUPP_NUIT', 'HEURES_SUPP_FERIE')
              AND ve.amount <> 0
              AND ${scope}
            ORDER BY pp.month, e.last_name, e.first_name`,
        )
        const report = buildImpactReport(slips.rows, tenant?.default_country_code ?? null, tenantAtRate, openVe.rows)
        if (format === 'csv') {
          reply.header('Content-Type', 'text/csv; charset=utf-8')
          reply.header('Content-Disposition', 'attachment; filename="impact_paie_ci_2023.csv"')
          return reply.send('﻿' + impactCsv(report))
        }
        return reply.send({ data: report })
      } catch (err) {
        request.log.error({ err, schema, action: 'payroll.ci-2023-impact' }, "Échec du rapport d'impact paie CI 2023")
        return reply.status(500).send({ error: "Impossible de produire le rapport d'impact pour le moment. Réessayez ou contactez le support." })
      }
    },
  })
}

export default ci2023ImpactRoutes
