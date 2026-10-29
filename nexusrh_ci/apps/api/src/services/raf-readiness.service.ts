/**
 * Contrôle OBLIGATOIRE avant la soumission d'une période-filiale par son RAF
 * (paie multi-filiales, POST /payroll-workflow/periods/:id/submit-by-raf).
 *
 * Deux conditions, pour chaque salarié de la filiale inclus dans la période :
 *   A. Données salarié complètes : situation familiale, nombre d'enfants
 *      (0 valide, NULL refusé), n° de sécurité sociale, mode de paiement et
 *      coordonnée correspondante (numéro Mobile Money ou RIB/IBAN), salaire de
 *      base ≥ SMIG du pack législatif du pays de la filiale.
 *   B. Variables du mois validées explicitement par le RAF (« variables
 *      saisies » ou « aucune variable ce mois »). La validation mémorise une
 *      empreinte des éléments variables : toute modification ultérieure, quelle
 *      que soit la voie (feuille RAF, paramétrage, import), l'invalide.
 *
 * Les salariés à salaire de base ≤ 0 (fiches « à compléter », hors paie) sont
 * ignorés. Le calcul est PUR (`computeRafReadiness`) ; `loadRafReadiness`
 * se contente de lire les données — GET /readiness et submit-by-raf partagent
 * la même fonction, jamais deux règles divergentes.
 */
import { createHash } from 'node:crypto'
import { pool } from '../db/pool.js'
import type { LegislationPack } from './legislation-packs.js'
import type { AttendancePayrollDeductions } from './payroll-engine-ci.js'

/** Variables usuelles saisissables par le RAF (clés du moteur de paie). */
export const RAF_VARIABLE_CODES = [
  'HEURES_SUPP_NORM', 'HEURES_SUPP_NUIT', 'HEURES_SUPP_FERIE',
  'PRIME_RENDEMENT', 'PRIME_ANCIENNETE', 'PRIME_TRANSPORT', 'PRIME_PANIER',
  'ABSENCE_INJ',
] as const
export type RafVariableCode = (typeof RAF_VARIABLE_CODES)[number]

/** Absences injustifiées : saisies en JOURS (pas en FCFA), retenues sur le salaire de base. */
export const UNJUSTIFIED_ABSENCE_CODE: RafVariableCode = 'ABSENCE_INJ'
export const MAX_UNJUSTIFIED_ABSENCE_DAYS = 31
/** Plafond défensif des montants FCFA (aligné sur /settings/variable-elements). */
export const MAX_VARIABLE_AMOUNT = 100_000_000

export const RAF_VARIABLE_LABELS: Record<RafVariableCode, string> = {
  HEURES_SUPP_NORM:  'Heures supp. +15%',
  HEURES_SUPP_NUIT:  'Heures supp. +50% (nuit/dim)',
  HEURES_SUPP_FERIE: 'Heures supp. +100% (jour férié)',
  PRIME_RENDEMENT:   'Prime de rendement',
  PRIME_ANCIENNETE:  "Prime d'ancienneté",
  PRIME_TRANSPORT:   'Prime de transport',
  PRIME_PANIER:      'Prime de panier',
  ABSENCE_INJ:       'Absences injustifiées (jours)',
}

export type ReadinessMissingCode =
  | 'marital_status' | 'children_count' | 'cnps_number'
  | 'payment_method' | 'mobile_money_phone' | 'iban' | 'below_smig'

export interface ReadinessEmployeeInput {
  id: string
  first_name: string | null
  last_name: string | null
  base_salary: string | number | null
  marital_status: string | null
  children_count: number | null
  cnps_number: string | null
  payment_method: string | null
  mobile_money_phone: string | null
  has_iban?: boolean | null
}

export interface VariableElementInput {
  employee_id: string
  rule_code: string
  amount: string | number
}

export type ValidationMode = 'entered' | 'none'

export interface VariableValidationRow {
  employee_id: string
  mode: ValidationMode
  variables_hash: string
  validated_at: string | Date | null
  validated_by: string | null
}

export interface RafEmployeeReadiness {
  id: string
  name: string
  missing: ReadinessMissingCode[]
  values: Record<string, number>
  validation: { mode: ValidationMode; validatedAt: string | Date | null; valid: boolean } | null
  variablesValidated: boolean
}

export interface RafReadiness {
  packCode: string
  smig: number
  employees: RafEmployeeReadiness[]
  totalEmployees: number
  validatedCount: number
  incompleteCount: number
  dataComplete: boolean
  variablesValidated: boolean
  ready: boolean
}

const blank = (v: string | null | undefined): boolean => v === null || v === undefined || String(v).trim() === ''

function toInt(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** Salarié réellement payé (les fiches à salaire nul ou négatif restent hors paie). */
export function isPayrollEligible(emp: Pick<ReadinessEmployeeInput, 'base_salary'>): boolean {
  return toInt(emp.base_salary) > 0
}

/** Codes des données manquantes ou non conformes d'un salarié. */
export function employeeMissing(emp: ReadinessEmployeeInput, smig: number): ReadinessMissingCode[] {
  const missing: ReadinessMissingCode[] = []
  if (blank(emp.marital_status)) missing.push('marital_status')
  if (emp.children_count === null || emp.children_count === undefined || !Number.isFinite(Number(emp.children_count))) {
    missing.push('children_count')
  }
  if (blank(emp.cnps_number)) missing.push('cnps_number')
  const method = blank(emp.payment_method) ? '' : String(emp.payment_method).trim()
  if (method === 'mobile_money') {
    if (blank(emp.mobile_money_phone)) missing.push('mobile_money_phone')
  } else if (method === 'bank_transfer') {
    if (emp.has_iban !== true) missing.push('iban')
  } else {
    missing.push('payment_method')
  }
  if (toInt(emp.base_salary) < smig) missing.push('below_smig')
  return missing
}

/**
 * Empreinte des éléments variables d'un salarié pour la période : codes triés,
 * montants non nuls. Deux saisies identiques donnent la même empreinte.
 */
export function variablesFingerprint(values: Record<string, number>): string {
  const canonical = Object.keys(values)
    .filter(k => values[k] !== 0)
    .sort()
    .map(k => `${k}=${values[k]}`)
    .join('|')
  return createHash('sha256').update(canonical).digest('hex')
}

/** Regroupe les éléments variables par salarié (montants entiers FCFA / jours). */
export function groupVariables(rows: readonly VariableElementInput[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const cur = out.get(r.employee_id) ?? {}
    cur[r.rule_code] = (cur[r.rule_code] ?? 0) + toInt(r.amount)
    out.set(r.employee_id, cur)
  }
  return out
}

export function computeRafReadiness(input: {
  employees: readonly ReadinessEmployeeInput[]
  variables: readonly VariableElementInput[]
  validations: readonly VariableValidationRow[]
  pack: Pick<LegislationPack, 'code' | 'smigMensuel'>
}): RafReadiness {
  const smig = input.pack.smigMensuel
  const valuesByEmp = groupVariables(input.variables)
  const validationByEmp = new Map(input.validations.map(v => [v.employee_id, v]))
  const employees: RafEmployeeReadiness[] = input.employees
    .filter(isPayrollEligible)
    .map((emp) => {
      const values = valuesByEmp.get(emp.id) ?? {}
      const v = validationByEmp.get(emp.id)
      const valid = !!v && v.variables_hash === variablesFingerprint(values)
      return {
        id: emp.id,
        name: [emp.first_name, emp.last_name].filter(Boolean).join(' ').trim() || emp.id,
        missing: employeeMissing(emp, smig),
        values,
        validation: v ? { mode: v.mode, validatedAt: v.validated_at, valid } : null,
        variablesValidated: valid,
      }
    })
  const validatedCount = employees.filter(e => e.variablesValidated).length
  const incompleteCount = employees.filter(e => e.missing.length > 0).length
  const dataComplete = incompleteCount === 0
  const variablesValidated = validatedCount === employees.length
  return {
    packCode: input.pack.code,
    smig,
    employees,
    totalEmployees: employees.length,
    validatedCount,
    incompleteCount,
    dataComplete,
    variablesValidated,
    ready: dataComplete && variablesValidated,
  }
}

/** Message FR actionnable quand la soumission est refusée. */
export function readinessRefusalMessage(r: RafReadiness): string {
  const parts: string[] = []
  if (r.incompleteCount > 0) {
    parts.push(`${r.incompleteCount} salarié(s) ont un dossier incomplet ou non conforme (situation familiale, enfants, n° de sécurité sociale, mode de paiement, salaire ≥ SMIG ${r.smig})`)
  }
  const pending = r.totalEmployees - r.validatedCount
  if (pending > 0) parts.push(`${pending} salarié(s) n'ont pas leurs variables du mois validées`)
  return `Soumission impossible : ${parts.join(' ; ')}. Complétez puis validez chaque ligne avant de soumettre.`
}

/**
 * Lit les éléments variables et les validations de la période, puis applique
 * `computeRafReadiness` sur la population déjà chargée (même population que
 * le calcul des bulletins). Aucune requête si aucun salarié n'est payé.
 */
export async function loadRafReadiness(
  schema: string,
  periodId: string,
  pack: Pick<LegislationPack, 'code' | 'smigMensuel'>,
  population: readonly ReadinessEmployeeInput[],
): Promise<RafReadiness> {
  const eligible = population.filter(isPayrollEligible)
  if (eligible.length === 0) {
    return computeRafReadiness({ employees: [], variables: [], validations: [], pack })
  }
  const ids = eligible.map(e => e.id)
  const vars = await pool.query<VariableElementInput>(
    `SELECT ve.employee_id, ve.rule_code, ve.amount
       FROM "${schema}".variable_elements ve
      WHERE ve.period_id = $1 AND ve.employee_id = ANY($2::uuid[])`,
    [periodId, ids],
  )
  // Tenant non encore migré (table absente) : aucune validation → non prêt.
  const validations = await pool.query<VariableValidationRow>(
    `SELECT employee_id, mode, variables_hash, validated_at, validated_by
       FROM "${schema}".payroll_variable_validations
      WHERE period_id = $1`,
    [periodId],
  ).catch(() => ({ rows: [] as VariableValidationRow[] }))
  return computeRafReadiness({
    employees: eligible,
    variables: vars?.rows ?? [],
    validations: validations?.rows ?? [],
    pack,
  })
}

/**
 * Retire les jours d'absence injustifiée saisis par le RAF des éléments
 * variables (ce ne sont pas des montants) et les ajoute aux retenues de
 * pointage : retenue = salaire de base / jours ouvrables du mois × jours.
 */
export function takeUnjustifiedAbsenceDays(varEls: Record<string, number>): number {
  const days = Math.max(0, Math.min(MAX_UNJUSTIFIED_ABSENCE_DAYS, Math.trunc(varEls[UNJUSTIFIED_ABSENCE_CODE] ?? 0)))
  delete varEls[UNJUSTIFIED_ABSENCE_CODE]
  return days
}

export function withUnjustifiedAbsence(
  att: AttendancePayrollDeductions | undefined,
  days: number,
  baseSalary: number,
  workingDaysMonth: number,
): AttendancePayrollDeductions | undefined {
  if (!(days > 0) || !(workingDaysMonth > 0)) return att
  const amount = Math.floor((baseSalary / workingDaysMonth) * days)
  return {
    absenceDays: (att?.absenceDays ?? 0) + days,
    absenceAmount: (att?.absenceAmount ?? 0) + amount,
    lateMinutes: att?.lateMinutes ?? 0,
    latenessAmount: att?.latenessAmount ?? 0,
    suspendAttendanceBonus: att?.suspendAttendanceBonus ?? false,
  }
}
