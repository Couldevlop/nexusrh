import { describe, it, expect } from 'vitest'
import { HAB_FUNCTIONS, HAB_GRID, HAB_EXTRA, SENSITIVE_IMPLIED, isPermission } from './catalog.js'

describe('catalogue des habilitations', () => {
  it('compte 18 fonctions', () => {
    expect(HAB_FUNCTIONS.length).toBe(18)
  })
  it('« pay » uniquement pour payments', () => {
    expect(HAB_GRID.payments).toContain('pay')
    for (const f of HAB_FUNCTIONS.filter((x) => x !== 'payments')) expect(HAB_GRID[f]).not.toContain('pay')
  })
  it('« configure » uniquement pour hr_settings et payroll', () => {
    const withConfigure = HAB_FUNCTIONS.filter((f) => HAB_GRID[f].includes('configure'))
    expect(withConfigure.sort()).toEqual(['hr_settings', 'payroll'])
  })
  it('chaque fonction a une grille non vide', () => {
    for (const f of HAB_FUNCTIONS) expect(HAB_GRID[f].length).toBeGreaterThan(0)
  })
  it('isPermission valide cases de grille et extras, rejette le reste', () => {
    expect(isPermission('payroll:validate')).toBe(true)
    expect(isPermission('payments:pay')).toBe(true)
    for (const e of HAB_EXTRA) expect(isPermission(e)).toBe(true)
    expect(isPermission('employees:pay')).toBe(false)
    expect(isPermission('nope:view')).toBe(false)
    expect(isPermission('')).toBe(false)
  })
  it('« close » pour les déclarations (dépôt CNPS/DISA)', () => {
    expect(isPermission('declarations:close')).toBe(true)
  })
  it('« delete » pour temps, intégration/sorties et signature', () => {
    for (const f of ['attendance', 'lifecycle', 'signature'] as const) expect(HAB_GRID[f]).toContain('delete')
  })
  it('SENSITIVE_IMPLIED', () => {
    expect(SENSITIVE_IMPLIED).toEqual(['payroll', 'payroll_multi', 'declarations', 'payments'])
  })
})
