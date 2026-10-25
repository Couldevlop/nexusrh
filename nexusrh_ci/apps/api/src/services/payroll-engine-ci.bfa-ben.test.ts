/**
 * Packs Burkina Faso (BFA-2024) et Bénin (BEN-2024) — recette multi-filiales 10/2026.
 *
 * BFA : CGI art. 111-113 (abattement 25 % du salaire de base, barème IUTS
 * 0/12,1/13,9/15,7/18,4/21,7/25 %, réduction 8-14 % pour charges de famille),
 * CNSS 5,5 % salarié / 8,5 + 6 + 1,5 % employeur, plafond 800 000.
 * BEN : CNSS sans plafond (3,6 % salarié, 6,4 + 9 % + AT employeur) — le
 * plafond « 0 » du pack annulait toutes les cotisations.
 */
import { describe, it, expect } from 'vitest'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'
import { BFA_2024, BEN_2024 } from './legislation-packs.js'

const ctx = (over: Partial<PayrollContext> = {}): PayrollContext => ({
  baseSalary: 300_000, workedDays: 26, workingDaysMonth: 26, atRate: 0.015,
  maritalStatus: 'single', childrenCount: 0, variableElements: {}, ...over,
})

describe('BFA-2024 — IUTS et CNSS', () => {
  const pack = { ...BFA_2024, status: 'active' as const }

  it('300 000 célibataire : CNSS 16 500, base IUTS 208 500, IUTS 30 424', () => {
    const r = calculatePayrollCI(ctx({ legislationPack: pack }))
    expect(r.totalCnpsSal).toBe(16_500)                  // 300 000 × 5,5 %
    expect(r.baseImposable).toBe(208_500)                // 300 000 − 75 000 (25 %) − 16 500
    // 20 000×12,1 % + 30 000×13,9 % + 40 000×15,7 % + 50 000×18,4 % + 38 500×21,7 %
    expect(r.its).toBe(30_424)
  })

  it('abattement sur le seul salaire de base : une prime reste imposable à 100 %', () => {
    const sans = calculatePayrollCI(ctx({ legislationPack: pack }))
    const avec = calculatePayrollCI(ctx({ legislationPack: pack, variableElements: { PRIME_RENDEMENT: 50_000 } }))
    // +50 000 imposables − 2 750 de CNSS en plus
    expect(avec.baseImposable - sans.baseImposable).toBe(47_250)
  })

  it('marié 2 enfants = 3 charges : réduction 12 % de l\'IUTS', () => {
    const r = calculatePayrollCI(ctx({ legislationPack: pack, maritalStatus: 'married', childrenCount: 2 }))
    expect(r.its).toBe(30_424 - Math.floor(30_424.5 * 0.12))
  })

  it('cotisations employeur 8,5 % + 6 % + 1,5 %, plafond 800 000', () => {
    const r = calculatePayrollCI(ctx({ legislationPack: pack, baseSalary: 1_000_000 }))
    expect(r.totalCnpsSal).toBe(44_000)                  // 800 000 × 5,5 %
    expect(r.totalCnpsPat).toBe(68_000 + 48_000 + 12_000)
  })
})

describe('BEN-2024 — CNSS sans plafond', () => {
  const pack = { ...BEN_2024, status: 'active' as const }

  it('300 000 : CNSS salarié 10 800 et cotisations patronales non nulles', () => {
    const r = calculatePayrollCI(ctx({ legislationPack: pack, atRate: 0.02 }))
    expect(r.totalCnpsSal).toBe(10_800)                  // 3,6 %
    expect(r.totalCnpsPat).toBe(19_200 + 27_000 + 6_000) // 6,4 % + 9 % + AT 2 %
  })
})
