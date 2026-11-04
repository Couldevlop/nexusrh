import { describe, it, expect } from 'vitest'
import {
  BEN_2024, BFA_2024, CIV_2024, GNB_2024, MLI_2024, NER_2024, SEN_2024, TGO_2024,
  type LegislationPack,
} from './legislation-packs.js'
import {
  completedYears, computeOvertime, computeSeniority, hourlyRate, seniorityRate,
} from './payroll-simulator.service.js'

function rateOf(pack: LegislationPack, years: number): number {
  if (!pack.seniorityBonus) throw new Error('pas de règle')
  return seniorityRate(pack.seniorityBonus, years)
}

describe('seniorityRate par pack', () => {
  const cases: Array<[string, LegislationPack, Array<[number, number]>]> = [
    ['CIV', CIV_2024, [[0, 0], [1, 0], [2, 0.02], [3, 0.03], [10, 0.10], [25, 0.25], [30, 0.25]]],
    ['SEN', SEN_2024, [[0, 0], [1, 0], [2, 0.02], [3, 0.03], [10, 0.10], [25, 0.25], [30, 0.25]]],
    ['MLI', MLI_2024, [[2, 0], [3, 0.03], [4, 0.03], [5, 0.05], [10, 0.10], [15, 0.15], [30, 0.15]]],
    ['NER', NER_2024, [[2, 0], [3, 0.03], [10, 0.10], [24, 0.24], [30, 0.24]]],
    ['BFA', BFA_2024, [[2, 0], [3, 0.05], [10, 0.12], [40, 0.42]]],
    ['TGO', TGO_2024, [[2, 0.02], [3, 0.02], [4, 0.03], [10, 0.09], [31, 0.30], [40, 0.30]]],
  ]
  for (const [name, pack, rows] of cases) {
    for (const [years, expected] of rows) {
      it(`${name} ${years} an(s) -> ${expected}`, () => {
        expect(rateOf(pack, years)).toBe(expected)
      })
    }
  }
  it('BEN et GNB sans règle', () => {
    expect(BEN_2024.seniorityBonus).toBeUndefined()
    expect(GNB_2024.seniorityBonus).toBeUndefined()
  })
})

describe('completedYears', () => {
  it('anniversaire le dernier jour du mois', () => {
    expect(completedYears('2016-11-30', '2026-11')).toEqual({ years: 10, months: 0 })
  })
  it('anniversaire le mois suivant', () => {
    expect(completedYears('2016-12-01', '2026-11')).toEqual({ years: 9, months: 11 })
  })
  it('29 février, année bissextile', () => {
    expect(completedYears('2020-02-29', '2024-02')).toEqual({ years: 4, months: 0 })
  })
  it('29 février, année non bissextile (28 février)', () => {
    expect(completedYears('2020-02-29', '2025-02')).toEqual({ years: 5, months: 0 })
  })
  it('embauche postérieure -> RangeError', () => {
    expect(() => completedYears('2026-12-01', '2026-11')).toThrow(RangeError)
  })
})

describe('computeSeniority', () => {
  it('CIV : taux sur le minimum de catégorie', () => {
    const r = computeSeniority({ pack: CIV_2024, hireDate: '2016-11-01', payMonth: '2026-11', baseSalary: 400_000, categoryMinimum: 150_000 })
    expect(r.years).toBe(10)
    expect(r.rate).toBe(0.10)
    expect(r.base).toBe(150_000)
    expect(r.amount).toBe(15_000)
    expect(r.source).toBe('rule')
    expect(r.confidence).toBe('confirmed')
    expect(r.legalSource).toContain('1977')
  })
  it('BFA : assiette = salaire de base', () => {
    const r = computeSeniority({ pack: BFA_2024, hireDate: '2016-11-01', payMonth: '2026-11', baseSalary: 200_000, categoryMinimum: 80_000 })
    expect(r.base).toBe(200_000)
    expect(r.amount).toBe(24_000)
  })
  it('override manuel', () => {
    const r = computeSeniority({ pack: CIV_2024, hireDate: '2016-11-01', payMonth: '2026-11', baseSalary: 400_000, categoryMinimum: 150_000, override: 50_000 })
    expect(r.amount).toBe(50_000)
    expect(r.source).toBe('manual')
  })
  it('BEN sans override', () => {
    const r = computeSeniority({ pack: BEN_2024, hireDate: '2016-11-01', payMonth: '2026-11', baseSalary: 400_000, categoryMinimum: 150_000 })
    expect(r.amount).toBe(0)
    expect(r.source).toBe('none')
    expect(r.confidence).toBeNull()
    expect(r.legalSource).toBeNull()
  })
})

describe('computeOvertime', () => {
  const th = 400_000 / ((40 * 52) / 12)
  it('taux horaire non arrondi', () => {
    expect(hourlyRate(400_000, 40)).toBe(th)
  })
  it('CIV heures normales', () => {
    const r = computeOvertime(CIV_2024, 400_000, 40, { weekly: 10, night: 0, sunday: 0, holiday: 0 })
    expect(r.variableElements.HEURES_SUPP_NORM).toBe(Math.round(10 * th * 1.15))
    expect(r.variableElements.HEURES_SUPP_NUIT).toBeUndefined()
    expect(r.lines).toHaveLength(1)
  })
  it('nuit et dimanche s\'additionnent', () => {
    const r = computeOvertime(CIV_2024, 400_000, 40, { weekly: 0, night: 4, sunday: 6, holiday: 2 })
    expect(r.variableElements.HEURES_SUPP_NUIT).toBe(Math.round(4 * th * 1.5) + Math.round(6 * th * 1.5))
    expect(r.variableElements.HEURES_SUPP_FERIE).toBe(Math.round(2 * th * 2))
  })
  it('majoration absente du pack avec heures saisies -> erreur', () => {
    const pack: LegislationPack = { ...CIV_2024, leaveRules: { ...CIV_2024.leaveRules!, overtimeRates: { weekly: 0.15 } } }
    expect(() => computeOvertime(pack, 400_000, 40, { weekly: 0, night: 3, sunday: 0, holiday: 0 })).toThrow()
  })
})
