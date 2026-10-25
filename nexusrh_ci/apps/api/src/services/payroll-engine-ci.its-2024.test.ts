/**
 * Réforme ITS Côte d'Ivoire — ordonnance n° 2023-719 du 13/09/2023, en
 * vigueur au 01/01/2024. Chaque valeur attendue est calculée À LA MAIN dans le
 * commentaire du test (aucune valeur capturée depuis le moteur).
 *
 * Barème mensuel sur 100 % du brut imposable (ni abattement, ni déduction des
 * cotisations CNPS salariales) :
 *   0–75 000 : 0 % · 75 001–240 000 : 16 % · 240 001–800 000 : 21 %
 *   800 001–2 400 000 : 24 % · 2 400 001–8 000 000 : 28 % · > 8 000 000 : 32 %
 * RICF par parts : 1 → 0 ; 1,5 → 5 500 ; 2 → 11 000 ; … ; 5 → 44 000.
 */
import { describe, it, expect } from 'vitest'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'
import { BFA_2024, CIV_2024 } from './legislation-packs.js'

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

describe('ITS 2024 — barème sur 100 % du brut imposable (célibataire, 1 part)', () => {
  const cas: Array<[number, number, string]> = [
    [75_000,    0,         'borne haute de la tranche 0 %'],
    [75_001,    0,         '1 F à 16 % = 0,16 → 0'],
    [75_007,    1,         '7 F à 16 % = 1,12 → 1'],
    [200_000,   20_000,    '(200 000 − 75 000) × 16 %'],
    [240_000,   26_400,    '(240 000 − 75 000) × 16 % — pas 26 399,84'],
    [240_001,   26_400,    '26 400 + 1 × 21 % = 26 400,21 → 26 400'],
    [450_000,   70_500,    '26 400 + (450 000 − 240 000) × 21 % = 26 400 + 44 100'],
    [800_000,   144_000,   '26 400 + 560 000 × 21 % = 26 400 + 117 600'],
    [1_500_000, 312_000,   '26 400 + 117 600 + (1 500 000 − 800 000) × 24 % = 144 000 + 168 000'],
    [2_400_000, 528_000,   '144 000 + 1 600 000 × 24 % = 144 000 + 384 000'],
    [8_000_000, 2_096_000, '528 000 + 5 600 000 × 28 % = 528 000 + 1 568 000'],
    [9_000_000, 2_416_000, '2 096 000 + 1 000 000 × 32 %'],
  ]
  for (const [brut, its, calcul] of cas) {
    it(`brut ${brut} → ITS ${its} (${calcul})`, () => {
      const r = calculatePayrollCI(ctx({ baseSalary: brut }))
      expect(r.baseImposable).toBe(brut)
      expect(r.itsBrut).toBe(its)
      expect(r.reductionImpot).toBe(0)
      expect(r.its).toBe(its)
      expect(r.partsFiscales).toBe(1)
    })
  }

  it('les cotisations CNPS salariales ne sont PAS déduites de l\'assiette', () => {
    const r = calculatePayrollCI(ctx({ baseSalary: 450_000 }))
    expect(r.totalCnpsSal).toBe(28_350)            // 450 000 × 6,3 %
    expect(r.baseImposable).toBe(450_000)          // et non 450 000 − 28 350
    expect(r.netPayable).toBe(450_000 - 28_350 - 70_500)
  })

  it('le pack CI ne porte plus d\'abattement ni de crédits marié/enfants', () => {
    expect(CIV_2024.abattementImpotSalaire).toBe(0)
    expect(CIV_2024.deduireCotisationsAssietteImpot).toBe(false)
    expect(CIV_2024.creditImpotMarieSansEnfant).toBe(0)
    expect(CIV_2024.creditImpotParEnfant).toEqual([0, 0, 0])
  })
})

describe('ITS 2024 — RICF par nombre de parts (brut 500 000 → impôt brut 81 000)', () => {
  // 26 400 + (500 000 − 240 000) × 21 % = 26 400 + 54 600 = 81 000
  const cas: Array<[string, number, number, number]> = [
    ['single',   0, 1,   0],
    ['divorced', 0, 1,   0],
    ['widowed',  0, 1,   0],
    ['married',  0, 2,   11_000],
    ['single',   1, 2,   11_000],   // 1 + 0,5 (parent isolé) + 0,5
    ['divorced', 2, 2.5, 16_500],
    ['married',  1, 2.5, 16_500],
    ['married',  2, 3,   22_000],
    ['widowed',  1, 2.5, 16_500],   // veuf avec enfant : comme un marié
    ['married',  4, 4,   33_000],
    ['married',  5, 4.5, 38_500],
    ['married',  6, 5,   44_000],
    ['married',  9, 5,   44_000],   // plafond 5 parts
    ['single',   9, 5,   44_000],
  ]
  for (const [ms, enfants, parts, ricf] of cas) {
    it(`${ms} ${enfants} enfant(s) → ${parts} parts → RICF ${ricf} → ITS ${81_000 - ricf}`, () => {
      const r = calculatePayrollCI(ctx({ baseSalary: 500_000, maritalStatus: ms, childrenCount: enfants }))
      expect(r.itsBrut).toBe(81_000)
      expect(r.partsFiscales).toBe(parts)
      expect(r.reductionImpot).toBe(ricf)
      expect(r.its).toBe(81_000 - ricf)
    })
  }

  it('la RICF ne rend jamais l\'ITS négatif (brut 120 000, marié 3 enfants)', () => {
    // impôt brut = 45 000 × 16 % = 7 200 ; RICF 3,5 parts = 27 500 → ITS 0
    const r = calculatePayrollCI(ctx({ baseSalary: 120_000, maritalStatus: 'married', childrenCount: 3 }))
    expect(r.itsBrut).toBe(7_200)
    expect(r.reductionImpot).toBe(7_200)
    expect(r.its).toBe(0)
  })
})

describe('ITS 2024 — éléments hors assiette', () => {
  it('l\'indemnité maternité est exonérée (seule la présence est imposée)', () => {
    // présence 13/26 de 400 000 = 200 000 → ITS 20 000
    const r = calculatePayrollCI(ctx({
      baseSalary: 400_000, workedDays: 13,
      absence: { type: 'maternite', absenceDays: 13 },
    }))
    expect(r.baseImposable).toBe(200_000)
    expect(r.its).toBe(20_000)
  })

  it('l\'indemnité journalière AT est exonérée', () => {
    const r = calculatePayrollCI(ctx({
      baseSalary: 260_000, workedDays: 16,
      absence: { type: 'accident_travail', absenceDays: 10, atJourAccidentInMonth: false },
    }))
    // présence 260 000 × 16/26 = 160 000 → (160 000 − 75 000) × 16 % = 13 600
    expect(r.baseImposable).toBe(160_000)
    expect(r.its).toBe(13_600)
  })

  it('le remboursement de notes de frais (ligne 6000) est hors assiette', () => {
    const sans = calculatePayrollCI(ctx({ baseSalary: 300_000 }))
    const avec = calculatePayrollCI(ctx({ baseSalary: 300_000, expenseReimbursement: 50_000 }))
    expect(avec.baseImposable).toBe(sans.baseImposable)
    expect(avec.its).toBe(sans.its)
    expect(avec.netPayable).toBe(sans.netPayable + 50_000)
  })

  it('l\'indemnité de licenciement (limite légale) est hors assiette, le préavis imposable', () => {
    const r = calculatePayrollCI(ctx({
      baseSalary: 200_000,
      settlementEarnings: [
        { key: 'licenciement', label: 'Indemnité de licenciement', amount: 81_250 },
        { key: 'preavis',      label: 'Indemnité de préavis',      amount: 100_000 },
      ],
    }))
    // 200 000 + 100 000 de préavis = 300 000 → 26 400 + 60 000 × 21 % = 39 000
    expect(r.baseImposable).toBe(300_000)
    expect(r.its).toBe(39_000)
  })
})

describe('Arrondi des indemnités d\'absence — aucun franc perdu', () => {
  it('Fanta : base 140 000, maternité sur la fin du mois → 1000 + 1700 = 140 000', () => {
    // 27 j ouvrables, 15 travaillés : 140 000 × 15/27 = 77 777,7 → 77 777
    // maternité 12 j : complément = 140 000 − 77 777 = 62 223 (et non 62 222)
    const r = calculatePayrollCI(ctx({
      baseSalary: 140_000, workedDays: 15, workingDaysMonth: 27,
      absence: { type: 'maternite', absenceDays: 12 },
    }))
    const l1000 = r.lines.find(l => l.code === '1000')?.amount
    const l1700 = r.lines.find(l => l.code === '1700')?.amount
    expect(l1000).toBe(77_777)
    expect(l1700).toBe(62_223)
    expect(r.grossSalary).toBe(140_000)
    expect(r.bordereauCnps?.montant).toBe(62_223)
  })

  it('maladie maintenue à 100 % sur la fin du mois → brut = salaire de base', () => {
    const r = calculatePayrollCI(ctx({
      baseSalary: 140_000, workedDays: 15, workingDaysMonth: 27,
      absence: { type: 'maladie_sans_at', absenceDays: 12, maintienTaux: 1 },
    }))
    expect(r.grossSalary).toBe(140_000)
  })

  it('absence au milieu du mois (présence + absence < mois) : prorata journalier inchangé', () => {
    // 140 000 / 27 × 5 = 25 925,9 → 25 925
    const r = calculatePayrollCI(ctx({
      baseSalary: 140_000, workedDays: 15, workingDaysMonth: 27,
      absence: { type: 'maternite', absenceDays: 5 },
    }))
    expect(r.indemniteAbsence).toBe(25_925)
  })
})

describe('Autres packs — logique historique conservée', () => {
  it('BFA-2024 : abattement + déduction des cotisations + crédits inchangés', () => {
    const pack = { ...BFA_2024, status: 'active' as const }
    const r = calculatePayrollCI(ctx({ baseSalary: 300_000, legislationPack: pack }))
    const attendu = Math.floor(300_000 * (1 - pack.abattementImpotSalaire)) - r.totalCnpsSal
    expect(r.baseImposable).toBe(Math.max(0, attendu))
    expect(r.partsFiscales).toBeUndefined()
  })
})
