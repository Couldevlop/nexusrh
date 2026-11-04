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

describe('completedYears validation', () => {
  it('mois hors 1-12', () => {
    expect(() => completedYears('2016-11-01', '2026-13')).toThrow(RangeError)
    expect(() => completedYears('2016-11-01', '2026-00')).toThrow(RangeError)
    expect(() => completedYears('2016-13-01', '2026-11')).toThrow(RangeError)
  })
  it('date impossible', () => {
    expect(() => completedYears('2026-02-30', '2026-11')).toThrow(RangeError)
    expect(() => completedYears('2021-02-29', '2026-11')).toThrow(RangeError)
  })
})

describe('computeSeniority', () => {
  const common = { hireDate: '2016-11-01', payMonth: '2026-11', baseSalary: 400_000, categoryMinimum: 150_000 }
  it('CIV : taux sur le minimum de catégorie', () => {
    const r = computeSeniority({ pack: CIV_2024, ...common })
    expect(r.years).toBe(10)
    expect(r.months).toBe(0)
    expect(r.source).toBe('rule')
    expect(r.amount).toBe(15_000)
    expect(r.rule).toMatchObject({ rate: 0.10, base: 150_000, amount: 15_000, confidence: 'confirmed' })
    expect(r.rule?.legalSource).toContain('1977')
  })
  it('mois révolus', () => {
    const r = computeSeniority({ pack: CIV_2024, ...common, hireDate: '2016-12-01' })
    expect(r.years).toBe(9)
    expect(r.months).toBe(11)
  })
  it('BFA : assiette = salaire de base', () => {
    const r = computeSeniority({ pack: BFA_2024, ...common, baseSalary: 200_000, categoryMinimum: 80_000 })
    expect(r.rule?.base).toBe(200_000)
    expect(r.amount).toBe(24_000)
  })
  it('manuel avec règle : montant retenu = saisie, règle conservée', () => {
    const r = computeSeniority({ pack: CIV_2024, ...common, override: 50_000 })
    expect(r.source).toBe('manual')
    expect(r.amount).toBe(50_000)
    expect(r.rule?.amount).toBe(15_000)
  })
  it('manuel sans règle', () => {
    const r = computeSeniority({ pack: BEN_2024, ...common, override: 20_000 })
    expect(r.source).toBe('manual')
    expect(r.amount).toBe(20_000)
    expect(r.rule).toBeNull()
  })
  it('BEN sans override', () => {
    const r = computeSeniority({ pack: BEN_2024, ...common })
    expect(r.source).toBe('none')
    expect(r.amount).toBe(0)
    expect(r.rule).toBeNull()
  })
})

describe('computeOvertime', () => {
  const th = 400_000 / ((40 * 52) / 12)
  it('taux horaire non arrondi', () => {
    expect(hourlyRate(400_000, 40)).toBe(th)
  })
  it('CIV 10 h normales : littéral calculé à la main (26 538)', () => {
    const r = computeOvertime(CIV_2024, 400_000, 40, { weekly: 10, night: 0, sunday: 0, holiday: 0 })
    expect(r.variableElements.HEURES_SUPP_NORM).toBe(26_538)
    expect(r.variableElements.HEURES_SUPP_NUIT).toBeUndefined()
    expect(r.lines).toHaveLength(1)
  })
  it('TGO nuit 4 h (+50 %) et dimanche 6 h (+65 %) : 13 846 + 22 846', () => {
    const r = computeOvertime(TGO_2024, 400_000, 40, { weekly: 0, night: 4, sunday: 6, holiday: 0 })
    expect(r.lines.map(l => l.amount)).toEqual([13_846, 22_846])
    expect(r.variableElements.HEURES_SUPP_NUIT).toBe(36_692)
  })
  it('BFA jour férié 2 h (+100 %) : 9 231', () => {
    const r = computeOvertime(BFA_2024, 400_000, 40, { weekly: 0, night: 0, sunday: 0, holiday: 2 })
    expect(r.variableElements.HEURES_SUPP_FERIE).toBe(9_231)
  })
  it('CIV 5 catégories (décret 2024-898 art. 25) : littéraux calculés à la main', () => {
    // th = 400 000 / (40 × 52 / 12) = 2 307,692…
    const r = computeOvertime(CIV_2024, 400_000, 40, {
      weekly: 6, weeklyBeyond: 4, night: 2, sunday: 3, holiday: 1, sundayHolidayNight: 2,
    })
    expect(r.lines.map(l => [l.category, l.element, l.majoration, l.amount])).toEqual([
      ['weekly', 'HEURES_SUPP_NORM', 0.15, 15_923],              // 6 × th × 1,15 = 15 923,08
      ['weeklyBeyond', 'HEURES_SUPP_47', 0.5, 13_846],           // 4 × th × 1,5 = 13 846,15
      ['night', 'HEURES_SUPP_NUIT', 0.75, 8_077],                // 2 × th × 1,75 = 8 076,92
      ['sunday', 'HEURES_SUPP_DIM', 0.75, 12_115],               // 3 × th × 1,75 = 12 115,38
      ['holiday', 'HEURES_SUPP_DIM', 0.75, 4_038],               // 1 × th × 1,75 = 4 038,46
      ['sundayHolidayNight', 'HEURES_SUPP_FERIE', 1, 9_231],     // 2 × th × 2 = 9 230,77
    ])
    expect(r.variableElements).toEqual({
      HEURES_SUPP_NORM: 15_923, HEURES_SUPP_47: 13_846, HEURES_SUPP_NUIT: 8_077,
      HEURES_SUPP_DIM: 16_153, HEURES_SUPP_FERIE: 9_231,
    })
    expect(r.lines[5]?.label).toBe('Heures supp. +100% (dimanche/férié de nuit)')
  })
  it('pack sans taux au-delà de 46 h (TGO) : heures saisies -> erreur', () => {
    expect(() => computeOvertime(TGO_2024, 400_000, 40, { weekly: 0, weeklyBeyond: 2, night: 0, sunday: 0, holiday: 0 })).toThrow()
    expect(() => computeOvertime(TGO_2024, 400_000, 40, { weekly: 0, night: 0, sunday: 0, holiday: 0, sundayHolidayNight: 1 })).toThrow()
  })
  it('majoration absente du pack avec heures saisies -> erreur', () => {
    const pack: LegislationPack = { ...CIV_2024, leaveRules: { ...CIV_2024.leaveRules!, overtimeRates: { weekly: 0.15 } } }
    expect(() => computeOvertime(pack, 400_000, 40, { weekly: 0, night: 3, sunday: 0, holiday: 0 })).toThrow()
  })
})
