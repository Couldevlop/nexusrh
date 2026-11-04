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
 *  - CMU non retenue (loi n° 2014-131) : ESTIMATION d'après les bénéficiaires
 *    ACTUELS de la fiche salarié (500 F par bénéficiaire et par côté) ;
 *  - drapeau `heures_supp_a_verifier` : le bulletin porte des lignes 1500 ou
 *    1550, dont les taux ont changé de sens (décret n° 2024-898, art. 25).
 *
 * Assiette : le brut du bulletin, sauf quand les bases portées par ses lignes
 * (2000 retraite, 3100 AT/PF) prouvent qu'aucun plafond n'était atteint (base
 * inférieure à l'ancien plafond) ou que le bulletin applique déjà le nouveau
 * plafond (base supérieure) : l'écart est alors nul.
 *
 * Accès : admin, hr_manager. Isolation : schéma du JWT uniquement.
 */
import type { FastifyPluginAsync } from 'fastify'
import { pool as rawPool } from '../../db/pool.js'
import { CIV_2024 } from '../../services/legislation-packs.js'
import { computeCmu } from '../../services/payroll-engine-ci.js'
import { employeeCmu } from '../../services/final-payslip.service.js'
import { encodeField } from '../sage/sage.service.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

/** Plafonds CNPS appliqués à tort après le 31/12/2022 (historique, pas une valeur en vigueur). */
export const CNPS_PLAFONDS_AVANT_2023 = { retraite: 1_647_315, atPf: 70_000 } as const
export const IMPACT_FROM_MONTH = '2023-01'
export const CMU_ESTIMATION_LABEL = 'estimation (bénéficiaires actuels)'

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

export interface SlipImpact {
  slipId: string
  employeeId: string
  month: string
  gross: number
  retraiteSal: number
  retraitePat: number
  atPfPat: number
  cmuSal: number
  cmuPat: number
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

  // CMU déjà retenue sur le bulletin (ligne 2200) : rien à estimer.
  let cmuSal = 0
  let cmuPat = 0
  if (!lines.some(l => l.code === '2200' || l.code === '3400')) {
    const cmu = computeCmu(pack, row.children_count ?? 0, employeeCmu(row))
    cmuSal = cmu.sal
    cmuPat = cmu.pat
  }

  return {
    slipId: row.id,
    employeeId: row.employee_id,
    month: row.month,
    gross,
    retraiteSal, retraitePat, atPfPat, cmuSal, cmuPat,
    heuresSuppAVerifier: lines.some(l => (l.code === '1500' || l.code === '1550') && l.amount !== 0),
  }
}

function emptyTotals(): ImpactTotals {
  return { slips: 0, retraiteSal: 0, retraitePat: 0, atPfPat: 0, cmuSal: 0, cmuPat: 0, heuresSuppAVerifier: 0, total: 0 }
}

function addTo(t: ImpactTotals, s: SlipImpact): void {
  t.slips += 1
  t.retraiteSal += s.retraiteSal
  t.retraitePat += s.retraitePat
  t.atPfPat += s.atPfPat
  t.cmuSal += s.cmuSal
  t.cmuPat += s.cmuPat
  if (s.heuresSuppAVerifier) t.heuresSuppAVerifier += 1
  t.total += s.retraiteSal + s.retraitePat + s.atPfPat + s.cmuSal + s.cmuPat
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
  byEmployeeMonth: Array<ImpactTotals & { employeeId: string; employeeNumber: string | null; name: string; month: string }>
}

export function buildImpactReport(rows: readonly ImpactSlipRow[], tenantCountry: string | null, tenantAtRate: number): ImpactReport {
  const totals = emptyTotals()
  const byEmp = new Map<string, ImpactTotals & { employeeId: string; employeeNumber: string | null; name: string }>()
  const byMonth = new Map<string, ImpactTotals & { month: string }>()
  const byEmpMonth = new Map<string, ImpactTotals & { employeeId: string; employeeNumber: string | null; name: string; month: string }>()
  let excluded = 0
  let analyzed = 0
  for (const row of rows) {
    if (!isCivSlip(row, tenantCountry)) { excluded += 1; continue }
    analyzed += 1
    const s = computeSlipImpact(row, tenantAtRate)
    const name = `${row.last_name ?? ''} ${row.first_name ?? ''}`.trim()
    addTo(totals, s)
    let e = byEmp.get(s.employeeId)
    if (!e) { e = { ...emptyTotals(), employeeId: s.employeeId, employeeNumber: row.employee_number, name }; byEmp.set(s.employeeId, e) }
    addTo(e, s)
    let m = byMonth.get(s.month)
    if (!m) { m = { ...emptyTotals(), month: s.month }; byMonth.set(s.month, m) }
    addTo(m, s)
    const k = `${s.employeeId}|${s.month}`
    let em = byEmpMonth.get(k)
    if (!em) { em = { ...emptyTotals(), employeeId: s.employeeId, employeeNumber: row.employee_number, name, month: s.month }; byEmpMonth.set(k, em) }
    addTo(em, s)
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
  }
}

const CSV_HEADER = [
  'mois', 'matricule', 'salarie', 'bulletins',
  'retraite_non_cotisee_salarie', 'retraite_non_cotisee_employeur', 'at_pf_maternite_employeur_manquant',
  `cmu_salarie_${CMU_ESTIMATION_LABEL}`, `cmu_employeur_${CMU_ESTIMATION_LABEL}`,
  'bulletins_heures_supp_a_verifier', 'total',
]

export function impactCsv(report: ImpactReport): string {
  const cell = (v: unknown) => encodeField(v, ';')
  const lines = [CSV_HEADER.map(cell).join(';')]
  for (const r of report.byEmployeeMonth) {
    lines.push([
      r.month, r.employeeNumber ?? '', r.name, r.slips,
      r.retraiteSal, r.retraitePat, r.atPfPat, r.cmuSal, r.cmuPat, r.heuresSuppAVerifier, r.total,
    ].map(cell).join(';'))
  }
  const t = report.totals
  lines.push([
    'TOTAL', '', '', t.slips, t.retraiteSal, t.retraitePat, t.atPfPat, t.cmuSal, t.cmuPat, t.heuresSuppAVerifier, t.total,
  ].map(cell).join(';'))
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
        const slips = await rawPool.query<ImpactSlipRow>(
          `SELECT ps.id, ps.employee_id, ps.month, ps.gross_salary, ps.lines, ps.legal_entity_id,
                  e.first_name, e.last_name, e.employee_number, e.marital_status, e.children_count,
                  e.cmu_spouse_covered, e.cmu_children_covered,
                  le.legislation_pack_code AS le_pack_code, le.country_code AS le_country_code
             FROM "${schema}".pay_slips ps
             JOIN "${schema}".pay_periods pp ON pp.id = ps.period_id
             LEFT JOIN "${schema}".employees e ON e.id = ps.employee_id
             LEFT JOIN "${schema}".legal_entities le ON le.id = ps.legal_entity_id
            WHERE pp.status = 'closed' AND ps.month >= $1
            ORDER BY ps.month, e.last_name, e.first_name`,
          [IMPACT_FROM_MONTH],
        )
        const report = buildImpactReport(slips.rows, tenant?.default_country_code ?? null, tenantAtRate)
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
