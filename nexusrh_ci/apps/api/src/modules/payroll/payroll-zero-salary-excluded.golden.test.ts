/**
 * Fiche « à compléter » (salaire de base 0 — ex. fiche auto-créée de l'admin
 * du tenant) : HORS PAIE tant que la rémunération n'est pas renseignée.
 *
 * Tous les lots qui génèrent des bulletins passent par loadPayrollPopulation,
 * qui exclut base_salary <= 0. Les exports banque / Mobile Money / CNPS / DISA
 * partent des bulletins (pay_slips) : ils héritent de l'exclusion. Le RNS, qui
 * liste aussi les actifs sans bulletin, filtre explicitement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

describe('salaire 0 exclu de la génération des bulletins', () => {
  it('loadPayrollPopulation applique le filtre (requête principale et repli legacy)', () => {
    const src = read('services', 'final-payslip.service.ts')
    expect(src).toContain('export const PAYABLE_SALARY_FILTER = `COALESCE(e.base_salary, 0) > 0`')
    expect(src.match(/AND \$\{PAYABLE_SALARY_FILTER\}/g)?.length).toBe(2)
  })

  it('clôture mono-entité ET lot de filiale (déclinaison / RAF) passent par loadPayrollPopulation', () => {
    expect(read('modules', 'payroll', 'payroll.routes.ts')).toMatch(/rows: await loadPayrollPopulation\(schema, month/)
    expect(read('modules', 'payroll', 'payroll-workflow.routes.ts')).toMatch(/rows: await loadPayrollPopulation\(schema, month/)
  })

  it('simulation unitaire /payroll/calculate refuse un salaire de base <= 0 (422)', () => {
    expect(read('modules', 'payroll', 'payroll.routes.ts')).toContain('baseSalary <= 0')
  })

  it('RNS : les actifs sans bulletin à salaire 0 ne sont pas déclarés', () => {
    expect(read('modules', 'cnps', 'cnps.routes.ts')).toContain('AND COALESCE(e.base_salary, 0) > 0) -- fiche « à compléter »')
  })

  it('la liste des employés ne filtre PAS sur le salaire', () => {
    expect(read('modules', 'employees', 'employees.routes.ts')).not.toContain('base_salary > 0')
  })
})
