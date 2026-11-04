import { describe, it, expect } from 'vitest'
import { CIV_2024, TGO_2024, BFA_2024 } from './legislation-packs.js'
import { calculatePayrollCI, overtimeLabels } from './payroll-engine-ci.js'

describe('overtimeLabels', () => {
  it('CIV : libellés historiques', () => {
    expect(overtimeLabels(CIV_2024)).toEqual({
      norm: 'Heures supp. +15%',
      nuit: 'Heures supp. +50% (nuit/dim)',
      ferie: 'Heures supp. +100% (jour férié)',
    })
  })
  it('TGO : nuit et dimanche distincts', () => {
    const l = overtimeLabels(TGO_2024)
    expect(l.norm).toBe('Heures supp. +20%')
    expect(l.nuit).toBe('Heures supp. nuit (+50%) / dimanche (+65%)')
    expect(l.ferie).toBe('Heures supp. +100% (jour férié)')
  })
})

describe('overtimeLabels décimales', () => {
  it('12,5 % reste 12,5', () => {
    const pack = { ...CIV_2024, leaveRules: { ...CIV_2024.leaveRules!, overtimeRates: { weekly: 0.125 } } }
    expect(overtimeLabels(pack).norm).toBe('Heures supp. +12,5%')
  })
})

describe('lignes 1400/1500/1550 du bulletin', () => {
  const ctx = {
    baseSalary: 300_000, workedDays: 26, workingDaysMonth: 26, atRate: 0.02,
    maritalStatus: 'single' as const, childrenCount: 0,
    variableElements: { HEURES_SUPP_NORM: 10_000, HEURES_SUPP_NUIT: 20_000, HEURES_SUPP_FERIE: 30_000 },
  }
  it('CIV : libellés inchangés', () => {
    const r = calculatePayrollCI({ ...ctx, legislationPack: CIV_2024 })
    const label = (c: string) => r.lines.find(l => l.code === c)?.label
    expect(label('1400')).toBe('Heures supp. +15%')
    expect(label('1500')).toBe('Heures supp. +50% (nuit/dim)')
    expect(label('1550')).toBe('Heures supp. +100% (jour férié)')
  })
  it('TGO : libellés dérivés du pack', () => {
    const r = calculatePayrollCI({ ...ctx, legislationPack: TGO_2024 })
    expect(r.lines.find(l => l.code === '1500')?.label).toBe('Heures supp. nuit (+50%) / dimanche (+65%)')
  })
  it('BFA : pourcentages du pack', () => {
    const r = calculatePayrollCI({ ...ctx, legislationPack: BFA_2024 })
    expect(r.lines.find(l => l.code === '1400')?.label).toBe('Heures supp. +15%')
  })
})
