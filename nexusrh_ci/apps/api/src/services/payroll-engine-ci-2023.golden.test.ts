/**
 * Paie CI — valeurs en vigueur depuis le 01/01/2023 (non-régression bloquante).
 *
 * - Plafond retraite CNPS 3 375 000 (45 × SMIG) et plafond AT / PF / maternité
 *   75 000 (= SMIG) : communiqué CNPS « Nouveau plafond des cotisations
 *   sociales » (11/01/2023), décret n° 2022-986 du 21/12/2022.
 * - CMU : 1 000 F/mois par bénéficiaire, 500 employeur + 500 salarié (salarié,
 *   conjoint sans emploi, 6 enfants) ; au-delà du 6e enfant, 1 000 à la charge
 *   du salarié (loi n° 2014-131 ; CLEISS ; servicepublic.gouv.ci).
 * - Heures supplémentaires : décret n° 2024-898 du 16/10/2024, art. 25.
 *
 * Tous les littéraux sont calculés à la main (détail en commentaire).
 */
import { describe, it, expect } from 'vitest'
import { calculatePayrollCI, overtimeLabels, type PayrollContext } from './payroll-engine-ci.js'
import { CIV_2024, TGO_2024 } from './legislation-packs.js'

const base: PayrollContext = {
  baseSalary: 2_000_000, workedDays: 26, workingDaysMonth: 26, atRate: 0.02,
  maritalStatus: 'single', childrenCount: 0, variableElements: {},
}
const line = (r: ReturnType<typeof calculatePayrollCI>, code: string) => r.lines.find(l => l.code === code)

describe('pack CIV — valeurs 2023', () => {
  it('plafonds CNPS', () => {
    expect(CIV_2024.plafondCnpsRetraite).toBe(3_375_000)
    expect(CIV_2024.plafondCnpsAtPf).toBe(75_000)
  })
  it('majorations heures supplémentaires (décret 2024-898 art. 25)', () => {
    expect(CIV_2024.leaveRules?.overtimeRates).toEqual({
      weekly: 0.15, weeklyBeyond: 0.5, weeklyBeyondFromHour: 47,
      night: 0.75, sunday: 0.75, holiday: 0.75, sundayHolidayNight: 1.0,
    })
  })
  it('CMU', () => {
    expect(CIV_2024.cmu).toEqual({ perBeneficiary: 1000, employerShare: 0.5, maxSharedChildren: 6 })
  })
})

describe('plafond retraite 3 375 000', () => {
  it('brut 2 000 000 : retraite sur 2 000 000', () => {
    const r = calculatePayrollCI(base)
    // 2 000 000 × 6,3 % = 126 000 ; × 7,7 % = 154 000
    expect(r.cnpsRetraiteSal).toBe(126_000)
    expect(r.cnpsRetraitePat).toBe(154_000)
    expect(line(r, '2000')?.base).toBe(2_000_000)
    // ITS : 165 000 × 16 % + 560 000 × 21 % + 1 200 000 × 24 % = 26 400 + 117 600 + 288 000
    expect(r.its).toBe(432_000)
    // AT/PF sur 75 000 : 3 750 + 562 (562,5) = 4 312 ; AT 2 % = 1 500
    expect(r.cnpsPfPat).toBe(4_312)
    expect(r.cnpsAtPat).toBe(1_500)
    expect(r.totalCnpsPat).toBe(159_812)          // 154 000 + 4 312 + 1 500
    expect(r.totalDeductions).toBe(558_500)       // 126 000 + 432 000 + CMU 500
    expect(r.netPayable).toBe(1_441_500)          // 2 000 000 − 558 500
    expect(r.employerCost).toBe(2_160_312)        // 2 000 000 + 159 812 + CMU 500
  })
  it('brut 4 000 000 : retraite sur 3 375 000', () => {
    const r = calculatePayrollCI({ ...base, baseSalary: 4_000_000 })
    // 3 375 000 × 6,3 % = 212 625 ; × 7,7 % = 259 875
    expect(r.cnpsRetraiteSal).toBe(212_625)
    expect(r.cnpsRetraitePat).toBe(259_875)
    expect(line(r, '2000')?.base).toBe(3_375_000)
    expect(line(r, '3000')?.base).toBe(3_375_000)
    // ITS : 26 400 + 117 600 + 1 600 000 × 24 % + 1 600 000 × 28 % = 976 000
    expect(r.its).toBe(976_000)
    expect(r.totalDeductions).toBe(1_189_125)     // 212 625 + 976 000 + 500
    expect(r.netPayable).toBe(2_810_875)
    expect(r.employerCost).toBe(4_266_187)        // 4 000 000 + 259 875 + 4 312 + 1 500 + 500
  })
})

describe('assiette AT / PF / maternité 75 000', () => {
  it('brut 75 000 : assiette 75 000', () => {
    const r = calculatePayrollCI({ ...base, baseSalary: 75_000 })
    expect(line(r, '3100')).toMatchObject({ base: 75_000, amount: 3_750 })   // 5 %
    expect(line(r, '3200')).toMatchObject({ base: 75_000, amount: 562 })     // 0,75 % = 562,5
    expect(line(r, '3300')).toMatchObject({ base: 75_000, amount: 1_500 })   // 2 %
    expect(r.cnpsPfPat).toBe(4_312)
  })
  it('brut 72 000 : assiette 72 000 (sous le plafond)', () => {
    const r = calculatePayrollCI({ ...base, baseSalary: 72_000 })
    expect(line(r, '3100')).toMatchObject({ base: 72_000, amount: 3_600 })   // 5 %
    expect(line(r, '3200')).toMatchObject({ base: 72_000, amount: 540 })     // 0,75 %
    expect(line(r, '3300')).toMatchObject({ base: 72_000, amount: 1_440 })   // 2 %
    expect(r.cnpsPfPat).toBe(4_140)                                          // 72 000 × 5,75 %
  })
  it('brut 100 000 : plafonné à 75 000', () => {
    const r = calculatePayrollCI({ ...base, baseSalary: 100_000 })
    expect(line(r, '3300')).toMatchObject({ base: 75_000, amount: 1_500 })
  })
})

describe('CMU — lignes 2200 (salarié) et 3400 (employeur)', () => {
  const small: PayrollContext = { ...base, baseSalary: 300_000 }
  it('salarié seul : 500 + 500', () => {
    const r = calculatePayrollCI(small)
    expect(line(r, '2200')).toMatchObject({ type: 'employee_contribution', amount: 500 })
    expect(line(r, '3400')).toMatchObject({ type: 'employer_contribution', amount: 500 })
    expect(r.cmuSal).toBe(500)
    expect(r.cmuPat).toBe(500)
  })
  it('conjoint couvert + 2 enfants : 4 bénéficiaires → 2 000 + 2 000', () => {
    const r = calculatePayrollCI({ ...small, maritalStatus: 'married', childrenCount: 2, cmu: { spouseCovered: true } })
    expect(line(r, '2200')?.amount).toBe(2_000)
    expect(line(r, '3400')?.amount).toBe(2_000)
  })
  it('conjoint sans emploi déclaré mais salarié non marié : conjoint non compté', () => {
    // célibataire + 2 enfants, case cochée : salarié + 2 enfants = 3 × 500
    const r = calculatePayrollCI({ ...small, maritalStatus: 'single', childrenCount: 2, cmu: { spouseCovered: true } })
    expect(r.cmuSal).toBe(1_500)
    expect(r.cmuPat).toBe(1_500)
    const c = calculatePayrollCI({ ...small, maritalStatus: 'cohabiting', childrenCount: 0, cmu: { spouseCovered: true } })
    expect(c.cmuSal).toBe(500)
  })
  it('marié, situation du conjoint non renseignée (null) : conjoint non compté', () => {
    const r = calculatePayrollCI({ ...small, maritalStatus: 'married', childrenCount: 0, cmu: { spouseCovered: null } })
    expect(r.cmuSal).toBe(500)
    expect(r.cmuPat).toBe(500)
  })
  it('conjoint non couvert par défaut (marié, 2 enfants) : 3 bénéficiaires', () => {
    const r = calculatePayrollCI({ ...small, maritalStatus: 'married', childrenCount: 2 })
    expect(r.cmuSal).toBe(1_500)
    expect(r.cmuPat).toBe(1_500)
  })
  it('8 enfants : 7 partagés (3 500 + 3 500) + 2 enfants à 1 000 pour le salarié', () => {
    const r = calculatePayrollCI({ ...small, childrenCount: 8 })
    expect(line(r, '2200')?.amount).toBe(5_500)   // 7 × 500 + 2 × 1 000
    expect(line(r, '3400')?.amount).toBe(3_500)   // 7 × 500
  })
  it('enfants couverts saisis : priment sur le nombre d’enfants à charge', () => {
    const r = calculatePayrollCI({ ...small, childrenCount: 3, cmu: { childrenCovered: 1 } })
    expect(r.cmuSal).toBe(1_000)
    expect(r.cmuPat).toBe(1_000)
  })
  it('hors assiettes CNPS et ITS, réduit le net, augmente le coût employeur', () => {
    const r = calculatePayrollCI({ ...small, childrenCount: 8 })
    expect(line(r, '2000')?.base).toBe(300_000)
    expect(r.baseImposable).toBe(300_000)
    expect(r.totalCnpsSal).toBe(18_900)           // 300 000 × 6,3 %, sans la CMU
    // ITS 300 000 : 26 400 + 60 000 × 21 % = 39 000 ; parts : 1 + 0,5 + 8 × 0,5 = 5,5 → plafond 5 → RICF 44 000
    expect(r.its).toBe(0)
    expect(r.totalDeductions).toBe(18_900 + 5_500)
    expect(r.netPayable).toBe(300_000 - 18_900 - 5_500)
    // 300 000 + 23 100 + 4 312 + 1 500 + 3 500
    expect(r.employerCost).toBe(332_412)
  })
  it('CMU suspendue (mois sans jour de contrat) : aucune ligne 2200 / 3400', () => {
    const r = calculatePayrollCI({ ...small, childrenCount: 2, cmu: { suspended: true } })
    expect(line(r, '2200')).toBeUndefined()
    expect(line(r, '3400')).toBeUndefined()
    expect(r.cmuSal).toBe(0)
    expect(r.cmuPat).toBe(0)
    // seules la retraite et l'ITS sont retenues
    expect(r.totalDeductions).toBe(r.totalCnpsSal + r.its)
  })
  it('congé maternité complet (0 jour travaillé, absence) : la CMU reste due', () => {
    const r = calculatePayrollCI({
      ...small, baseSalary: 250_000, workedDays: 0, maritalStatus: 'married', childrenCount: 1,
      absence: { type: 'maternite', absenceDays: 26 },
    })
    // salarié + 1 enfant (conjoint non couvert par défaut) = 2 × 500
    expect(line(r, '2200')?.amount).toBe(1_000)
    expect(line(r, '3400')?.amount).toBe(1_000)
  })
  it('pack sans CMU (TGO) : aucune ligne CMU', () => {
    const r = calculatePayrollCI({ ...small, legislationPack: TGO_2024 })
    expect(line(r, '2200')).toBeUndefined()
    expect(line(r, '3400')).toBeUndefined()
    expect(r.cmuSal).toBe(0)
    expect(r.cmuPat).toBe(0)
  })
})

describe('heures supplémentaires CIV — 5 catégories', () => {
  it('libellés dérivés du pack', () => {
    expect(overtimeLabels(CIV_2024)).toEqual({
      norm: 'Heures supp. +15% (41e à 46e h)',
      beyond: 'Heures supp. +50% (au-delà de 46 h)',
      nuit: 'Heures supp. +75% (nuit)',
      dim: 'Heures supp. +75% (dimanche/férié de jour)',
      ferie: 'Heures supp. +100% (dimanche/férié de nuit)',
    })
  })
  it('lignes 1450 et 1520 soumises CNPS et ITS', () => {
    const r = calculatePayrollCI({
      ...base, baseSalary: 200_000,
      variableElements: { HEURES_SUPP_NORM: 10_000, HEURES_SUPP_47: 20_000, HEURES_SUPP_NUIT: 5_000, HEURES_SUPP_DIM: 7_000, HEURES_SUPP_FERIE: 8_000 },
    })
    expect(line(r, '1400')).toMatchObject({ label: 'Heures supp. +15% (41e à 46e h)', amount: 10_000 })
    expect(line(r, '1450')).toMatchObject({ label: 'Heures supp. +50% (au-delà de 46 h)', amount: 20_000 })
    expect(line(r, '1500')).toMatchObject({ label: 'Heures supp. +75% (nuit)', amount: 5_000 })
    expect(line(r, '1520')).toMatchObject({ label: 'Heures supp. +75% (dimanche/férié de jour)', amount: 7_000 })
    expect(line(r, '1550')).toMatchObject({ label: 'Heures supp. +100% (dimanche/férié de nuit)', amount: 8_000 })
    // brut 250 000 : retraite 15 750, ITS 26 400 + 10 000 × 21 % = 28 500
    expect(r.grossSalary).toBe(250_000)
    expect(r.cnpsRetraiteSal).toBe(15_750)
    expect(r.its).toBe(28_500)
    // ordre d'affichage : 1400, 1450, 1500, 1520, 1550
    expect(r.lines.filter(l => l.code.startsWith('14') || l.code.startsWith('15')).map(l => l.code))
      .toEqual(['1400', '1450', '1500', '1520', '1550'])
  })
})
