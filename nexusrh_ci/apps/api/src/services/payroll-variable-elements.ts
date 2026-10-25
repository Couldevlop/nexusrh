/**
 * Lecture des éléments variables d'un bulletin avec l'assujettissement
 * CNPS / ITS paramétré par le tenant sur la rubrique correspondante
 * (`payroll_rules.subject_social` / `subject_tax`, NULL = règle du pack).
 * Une seule requête : la rubrique est jointe par sa formule `VAR:<code>`.
 */
import type { VariableTreatmentOverride } from './payroll-engine-ci.js'

export interface VariableElementRow {
  rule_code: string
  amount: string
  subject_social?: boolean | null
  subject_tax?: boolean | null
}

/** SELECT des éléments variables (alias `ve`) à compléter par un WHERE. */
export const VARIABLE_ELEMENTS_SQL = (schema: string): string =>
  `SELECT ve.rule_code, ve.amount, pr.subject_social, pr.subject_tax
     FROM "${schema}".variable_elements ve
     LEFT JOIN LATERAL (
       SELECT r.subject_social, r.subject_tax FROM "${schema}".payroll_rules r
        WHERE r.formula = 'VAR:' || ve.rule_code AND r.is_active = true
        ORDER BY r."order" LIMIT 1
     ) pr ON true`

/** Surcharges tenant (champ par champ) à passer à `calculatePayrollCI`. */
export function treatmentFromRows(rows: readonly VariableElementRow[]): VariableTreatmentOverride | undefined {
  const out: Record<string, { social?: boolean; tax?: boolean }> = {}
  for (const r of rows) {
    const social = typeof r.subject_social === 'boolean' ? r.subject_social : undefined
    const tax    = typeof r.subject_tax === 'boolean' ? r.subject_tax : undefined
    if (social === undefined && tax === undefined) continue
    out[r.rule_code] = { ...(social !== undefined ? { social } : {}), ...(tax !== undefined ? { tax } : {}) }
  }
  return Object.keys(out).length ? out : undefined
}
