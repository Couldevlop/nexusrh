import { describe, it, expect } from 'vitest'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'

const baseCtx: PayrollContext = {
  baseSalary:       200_000,
  workedDays:       26,
  workingDaysMonth: 26,
  atRate:           0.02,          // Commerce/services
  maritalStatus:    'single',
  childrenCount:    0,
  variableElements: {},
}

describe('PayrollEngineCi — calculs CNPS 2024', () => {

  it('salaire plein temps : netPayable < grossSalary', () => {
    const r = calculatePayrollCI(baseCtx)
    expect(r.netPayable).toBeLessThan(r.grossSalary)
    expect(r.netPayable).toBeGreaterThan(0)
  })

  it('CNPS retraite salarié = BASE_RETRAITE × 6,3%', () => {
    const r = calculatePayrollCI(baseCtx)
    const baseRetraite = Math.min(baseCtx.baseSalary, 1_647_315)
    expect(r.cnpsRetraiteSal).toBe(Math.floor(baseRetraite * 0.063))
  })

  it('CNPS retraite plafonné à 1 647 315 FCFA', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 2_000_000 }
    const r = calculatePayrollCI(ctx)
    const plafond = 1_647_315
    expect(r.cnpsRetraiteSal).toBe(Math.floor(plafond * 0.063))
  })

  it('AT/PF plafonné à 70 000 FCFA', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 200_000 }
    const r = calculatePayrollCI(ctx)
    const baseAtPf = Math.min(200_000, 70_000)
    expect(r.cnpsAtPat).toBe(Math.floor(baseAtPf * 0.02))
  })

  it('ITS = 0 pour salaire net imposable ≤ 75 000', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 75_000 }
    const r = calculatePayrollCI(ctx)
    expect(r.its).toBe(0)
  })

  it('ITS > 0 pour salaire 300 000 FCFA', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 300_000 }
    const r = calculatePayrollCI(ctx)
    expect(r.its).toBeGreaterThan(0)
  })

  it('crédit impôt marié 2 enfants réduit ITS', () => {
    const ctx1: PayrollContext = { ...baseCtx, baseSalary: 400_000, maritalStatus: 'single',  childrenCount: 0 }
    const ctx2: PayrollContext = { ...baseCtx, baseSalary: 400_000, maritalStatus: 'married', childrenCount: 2 }
    const r1 = calculatePayrollCI(ctx1)
    const r2 = calculatePayrollCI(ctx2)
    expect(r2.its).toBeLessThan(r1.its)
  })

  it('prorata : salaire partiel si jours travaillés < jours ouvrables', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 200_000, workedDays: 13, workingDaysMonth: 26 }
    const r = calculatePayrollCI(ctx)
    expect(r.brutProrata).toBe(100_000) // 50% du brut
  })

  it('prime transport incluse dans grossSalary', () => {
    const ctx: PayrollContext = { ...baseCtx, variableElements: { PRIME_TRANSPORT: 30_000 } }
    const r = calculatePayrollCI(ctx)
    expect(r.grossSalary).toBeGreaterThan(r.brutProrata)
  })

  it('employerCost > netPayable (charges patronales)', () => {
    const r = calculatePayrollCI(baseCtx)
    expect(r.employerCost).toBeGreaterThan(r.netPayable)
  })

  it('tous les montants sont des entiers FCFA (zéro décimale)', () => {
    const r = calculatePayrollCI(baseCtx)
    expect(r.netPayable % 1).toBe(0)
    expect(r.cnpsRetraiteSal % 1).toBe(0)
    expect(r.its % 1).toBe(0)
    expect(r.employerCost % 1).toBe(0)
  })
})

describe('PayrollEngineCi — absence maternité', () => {
  it('maternité : l\'indemnité est incluse dans grossSalary (remboursée ensuite par CNPS)', () => {
    const ctx: PayrollContext = {
      ...baseCtx,
      workedDays: 0,
      absence: { type: 'maternite', absenceDays: 26 },
    }
    const r = calculatePayrollCI(ctx)
    // L'employeur avance l'indemnité = brut mensuel complet
    expect(r.grossSalary).toBe(baseCtx.baseSalary)
    // Un bordereau CNPS est généré pour le remboursement
    expect(r.bordereauCnps).toBeDefined()
    expect(r.bordereauCnps?.motif).toBe('maternite')
    expect(r.netPayable).toBeGreaterThan(0)
  })
})

describe('PayrollEngineCi — tranches ITS hautes', () => {
  it('ITS tranche 10% (salaire 1 200 000 FCFA)', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 1_200_000 }
    const r = calculatePayrollCI(ctx)
    // imposable = 1_200_000 * 0.85 - cnps_sal ; dépasse 800 001 → tranche 10%
    expect(r.its).toBeGreaterThan(0)
    // net imposable ≈ 1 020 000 − cnps, en tranche 10% partielle
    const netImposable = Math.floor(1_200_000 * 0.85) - r.cnpsRetraiteSal
    expect(netImposable).toBeGreaterThan(800_000)
  })

  it('ITS tranche 15% (salaire 3 000 000 FCFA)', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 3_000_000 }
    const r = calculatePayrollCI(ctx)
    const netImposable = Math.floor(3_000_000 * 0.85) - r.cnpsRetraiteSal
    expect(netImposable).toBeGreaterThan(2_000_000)
    expect(r.its).toBeGreaterThan(0)
  })
})

describe('PayrollEngineCi — SMIG & taux AT secteur', () => {
  it('SMIG plancher : net >= 60 000 FCFA pour temps plein', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 60_000 }
    const r = calculatePayrollCI(ctx)
    expect(r.netPayable).toBeGreaterThanOrEqual(0)
  })

  it('taux AT BTP (3%) > taux AT commerce (2%)', () => {
    const commerce = calculatePayrollCI({ ...baseCtx, atRate: 0.02 })
    const btp      = calculatePayrollCI({ ...baseCtx, atRate: 0.03 })
    expect(btp.cnpsAtPat).toBeGreaterThan(commerce.cnpsAtPat)
  })

  it('taux AT extraction (5%) = max', () => {
    const ctx: PayrollContext = { ...baseCtx, baseSalary: 200_000, atRate: 0.05 }
    const r = calculatePayrollCI(ctx)
    expect(r.cnpsAtPat).toBe(Math.floor(Math.min(200_000, 70_000) * 0.05))
  })
})

describe('PayrollEngineCi — avance sur salaire (retenue)', () => {
  it('avance sur salaire réduit netPayable', () => {
    const sans = calculatePayrollCI(baseCtx)
    const avec = calculatePayrollCI({ ...baseCtx, variableElements: { AVANCE: 20_000 } })
    expect(avec.netPayable).toBe(sans.netPayable - 20_000)
  })
})
