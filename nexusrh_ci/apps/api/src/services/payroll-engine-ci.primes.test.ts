/**
 * Assujettissement des éléments variables de rémunération — Côte d'Ivoire.
 * Valeurs attendues calculées À LA MAIN (aucune capture moteur).
 *
 * Primes d'ancienneté / de rendement, heures supplémentaires, indemnité de
 * congés payés, gratifications et avantages en nature font partie du salaire
 * brut soumis aux cotisations CNPS et à l'ITS.
 * Prime de transport : exonérée jusqu'à 30 000 F/mois à Abidjan, 24 000 F à
 * Bouaké, 20 000 F ailleurs (CGI art. 116 al. 10 modifié par l'annexe fiscale
 * 2023 ; arrêté n° 2020-012/MEPS/CAB du 30/01/2020) ; l'excédent est soumis.
 * Rappels : CNPS retraite salarié 6,3 % ; ITS 2024 = 16 % de 75 001 à 240 000,
 * 21 % de 240 001 à 800 000 ; célibataire sans enfant = 1 part, RICF 0.
 */
import { describe, it, expect } from 'vitest'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'
import { CIV_2024 } from './legislation-packs.js'

const ctx = (over: Partial<PayrollContext> = {}): PayrollContext => ({
  baseSalary:       200_000,
  workedDays:       26,
  workingDaysMonth: 26,
  atRate:           0.02,
  maritalStatus:    'single',
  childrenCount:    0,
  variableElements: {},
  ...over,
})

describe('Primes et heures supplémentaires — soumises CNPS + ITS', () => {
  it('prime de rendement 50 000 : bases 250 000', () => {
    const r = calculatePayrollCI(ctx({ variableElements: { PRIME_RENDEMENT: 50_000 } }))
    expect(r.grossSalary).toBe(250_000)
    expect(r.cnpsRetraiteSal).toBe(15_750)       // 250 000 × 6,3 %
    expect(r.cnpsRetraitePat).toBe(19_250)       // 250 000 × 7,7 %
    expect(r.baseImposable).toBe(250_000)
    expect(r.its).toBe(28_500)                   // 26 400 + 10 000 × 21 %
    expect(r.netPayable).toBe(205_750)           // 250 000 − 15 750 − 28 500
  })

  it('gratification 100 000 : ligne 1250, bases 300 000', () => {
    const r = calculatePayrollCI(ctx({ variableElements: { GRATIFICATION: 100_000 } }))
    expect(r.lines.find(l => l.code === '1250')?.amount).toBe(100_000)
    expect(r.grossSalary).toBe(300_000)
    expect(r.cnpsRetraiteSal).toBe(18_900)       // 300 000 × 6,3 %
    expect(r.its).toBe(39_000)                   // 26 400 + 60 000 × 21 %
    expect(r.netPayable).toBe(242_100)           // 300 000 − 18 900 − 39 000
  })

  it('avantage en nature 50 000 : imposé et cotisé, puis repris en retenue (ligne 5200)', () => {
    const r = calculatePayrollCI(ctx({ variableElements: { AVANTAGE_NATURE: 50_000 } }))
    expect(r.lines.find(l => l.code === '1260')?.amount).toBe(50_000)
    expect(r.lines.find(l => l.code === '5200')).toMatchObject({ type: 'deduction', amount: 50_000 })
    expect(r.grossSalary).toBe(250_000)
    expect(r.cnpsRetraiteSal).toBe(15_750)
    expect(r.its).toBe(28_500)
    expect(r.totalDeductions).toBe(94_250)       // 15 750 + 28 500 + 50 000
    expect(r.netPayable).toBe(155_750)           // le salarié ne touche pas l'avantage en espèces
  })
})

describe('Prime de transport — exonérée dans la limite du plafond légal', () => {
  it('30 000 à Abidjan (zone par défaut) : totalement exonérée', () => {
    const r = calculatePayrollCI(ctx({ variableElements: { PRIME_TRANSPORT: 30_000 } }))
    expect(r.grossSalary).toBe(230_000)
    expect(r.baseImposable).toBe(200_000)
    expect(r.cnpsRetraiteSal).toBe(12_600)
    expect(r.its).toBe(20_000)
  })

  it('45 000 sans zone : excédent 15 000 soumis', () => {
    const r = calculatePayrollCI(ctx({ variableElements: { PRIME_TRANSPORT: 45_000 } }))
    expect(r.baseImposable).toBe(215_000)
    expect(r.cnpsRetraiteSal).toBe(13_545)       // 215 000 × 6,3 %
    expect(r.its).toBe(22_400)                   // 140 000 × 16 %
    expect(r.netPayable).toBe(209_055)           // 245 000 − 13 545 − 22 400
  })

  it('45 000 à Bouaké (plafond 24 000) : excédent 21 000', () => {
    const r = calculatePayrollCI(ctx({ transportZone: 'Bouake', variableElements: { PRIME_TRANSPORT: 45_000 } }))
    expect(r.baseImposable).toBe(221_000)
    expect(r.cnpsRetraiteSal).toBe(13_923)       // 221 000 × 6,3 %
    expect(r.its).toBe(23_360)                   // 146 000 × 16 %
  })

  it('45 000 hors Abidjan / Bouaké (plafond 20 000) : excédent 25 000', () => {
    const r = calculatePayrollCI(ctx({ transportZone: 'autres', variableElements: { PRIME_TRANSPORT: 45_000 } }))
    expect(r.baseImposable).toBe(225_000)
    expect(r.its).toBe(24_000)                   // 150 000 × 16 %
  })

  it('zone inconnue : plafond par défaut du pack (30 000)', () => {
    const r = calculatePayrollCI(ctx({ transportZone: 'Yamoussoukro', variableElements: { PRIME_TRANSPORT: 45_000 } }))
    expect(r.baseImposable).toBe(215_000)
  })

  it('pack sans plafond de transport : prime totalement exonérée', () => {
    const pack = { ...CIV_2024, primeTransportExoneree: undefined }
    const r = calculatePayrollCI(ctx({ legislationPack: pack, variableElements: { PRIME_TRANSPORT: 100_000 } }))
    expect(r.baseImposable).toBe(200_000)
    expect(r.grossSalary).toBe(300_000)
  })
})

describe('Traitement paramétrable par rubrique', () => {
  it('paramétrage tenant : prime de rendement déclarée hors bases', () => {
    const r = calculatePayrollCI(ctx({
      variableTreatment: { PRIME_RENDEMENT: { social: false, tax: false } },
      variableElements: { PRIME_RENDEMENT: 50_000 },
    }))
    expect(r.grossSalary).toBe(250_000)
    expect(r.baseImposable).toBe(200_000)
    expect(r.cnpsRetraiteSal).toBe(12_600)
    expect(r.its).toBe(20_000)
  })

  it('paramétrage pack : ICP cotisable mais non imposable', () => {
    const pack = { ...CIV_2024, traitementElementsVariables: { ...CIV_2024.traitementElementsVariables, ICP: { social: true, tax: false } } }
    const r = calculatePayrollCI(ctx({ legislationPack: pack, variableElements: { ICP: 35_000 } }))
    expect(r.cnpsRetraiteSal).toBe(14_805)       // 235 000 × 6,3 %
    expect(r.baseImposable).toBe(200_000)
  })

  it('paramétrage tenant : prime de transport entièrement soumise (plafond ignoré)', () => {
    const r = calculatePayrollCI(ctx({
      variableTreatment: { PRIME_TRANSPORT: { social: true, tax: true } },
      variableElements: { PRIME_TRANSPORT: 30_000 },
    }))
    expect(r.baseImposable).toBe(230_000)
    expect(r.its).toBe(24_800)                   // 155 000 × 16 %
  })
})
