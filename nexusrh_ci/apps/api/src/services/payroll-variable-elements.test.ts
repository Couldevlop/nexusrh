import { describe, it, expect } from 'vitest'
import { VARIABLE_ELEMENTS_SQL, treatmentFromRows } from './payroll-variable-elements.js'
import { calculatePayrollCI } from './payroll-engine-ci.js'

describe('treatmentFromRows — paramétrage tenant des rubriques', () => {
  it('ignore les rubriques sans paramétrage (règle du pack)', () => {
    expect(treatmentFromRows([{ rule_code: 'PRIME_RENDEMENT', amount: '50000' }])).toBeUndefined()
    expect(treatmentFromRows([{ rule_code: 'ICP', amount: '1', subject_social: null, subject_tax: null }])).toBeUndefined()
  })

  it('ne retient que les champs renseignés', () => {
    expect(treatmentFromRows([
      { rule_code: 'PRIME_RENDEMENT', amount: '50000', subject_social: null, subject_tax: false },
      { rule_code: 'ICP', amount: '35000', subject_social: true, subject_tax: true },
    ])).toEqual({ PRIME_RENDEMENT: { tax: false }, ICP: { social: true, tax: true } })
  })

  it('un champ seul garde l\'autre du pack : rendement non imposable mais cotisable', () => {
    const variableTreatment = treatmentFromRows([{ rule_code: 'PRIME_RENDEMENT', amount: '50000', subject_tax: false }])
    const r = calculatePayrollCI({
      baseSalary: 200_000, workedDays: 26, workingDaysMonth: 26, atRate: 0.02,
      maritalStatus: 'single', childrenCount: 0,
      variableElements: { PRIME_RENDEMENT: 50_000 }, variableTreatment,
    })
    expect(r.cnpsRetraiteSal).toBe(15_750)   // 250 000 × 6,3 %
    expect(r.baseImposable).toBe(200_000)
  })

  it('la requête joint la rubrique par sa formule VAR:<code> dans le schéma du tenant', () => {
    const sql = VARIABLE_ELEMENTS_SQL('tenant_x')
    expect(sql).toContain('"tenant_x".variable_elements ve')
    expect(sql).toContain('"tenant_x".payroll_rules')
    expect(sql).toContain("'VAR:' || ve.rule_code")
  })
})
