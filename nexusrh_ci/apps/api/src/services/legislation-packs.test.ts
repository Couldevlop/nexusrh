/**
 * Tests garantissant que :
 *  1. Le pack par défaut (CIV-2024) correspond exactement aux constantes
 *     historiques du moteur CI.
 *  2. Les packs `stub` font lever une erreur explicite quand on tente de
 *     calculer un bulletin avec eux.
 *  3. Les listings d'inventaire sont cohérents.
 */
import { describe, it, expect } from 'vitest'
import {
  CIV_2024, BEN_2024, TGO_2024, BFA_2024, SEN_2024, MLI_2024, NER_2024,
  TCD_2024, NGA_2024,
  LEGISLATION_PACKS, DEFAULT_LEGISLATION_PACK,
  getLegislationPack, listLegislationPacks,
} from './legislation-packs.js'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'

describe('LegislationPack — pack par défaut CIV-2024', () => {
  it('le pack CIV-2024 est actif (active, jamais stub)', () => {
    expect(CIV_2024.status).toBe('active')
  })

  it('CIV-2024 reflète les constantes CI 2024 historiques', () => {
    expect(CIV_2024.smigMensuel).toBe(75_000)
    expect(CIV_2024.plafondCnpsRetraite).toBe(1_647_315)
    expect(CIV_2024.plafondCnpsAtPf).toBe(70_000)
    expect(CIV_2024.tauxCotisationRetraiteSalarie).toBe(0.063)
    expect(CIV_2024.tauxCotisationRetraitePatronal).toBe(0.077)
    expect(CIV_2024.tauxCotisationPfPatronal).toBe(0.05)
    expect(CIV_2024.tauxCotisationMaternitePatronal).toBe(0.0075)
    expect(CIV_2024.abattementImpotSalaire).toBe(0.15)
    expect(CIV_2024.creditImpotMarieSansEnfant).toBe(5_500)
    expect(CIV_2024.creditImpotParEnfant).toEqual([3_000, 6_000, 9_000])
    expect(CIV_2024.bracketScale).toBe('monthly')
  })

  it('DEFAULT_LEGISLATION_PACK est bien CIV-2024', () => {
    expect(DEFAULT_LEGISLATION_PACK).toBe(CIV_2024)
  })

  it('getLegislationPack(null) renvoie le pack par défaut', () => {
    expect(getLegislationPack(null)).toBe(CIV_2024)
    expect(getLegislationPack(undefined)).toBe(CIV_2024)
    expect(getLegislationPack('inconnu')).toBe(CIV_2024)
  })

  it('le pack par défaut est utilisé quand aucun pack n\'est précisé', () => {
    const ctx: PayrollContext = {
      baseSalary: 300_000, workedDays: 26, workingDaysMonth: 26,
      atRate: 0.02, maritalStatus: 'single', childrenCount: 0,
      variableElements: {},
    }
    const r = calculatePayrollCI(ctx)
    // Comparaison contre passage explicite du pack
    const rWithPack = calculatePayrollCI({ ...ctx, legislationPack: CIV_2024 })
    expect(r.netPayable).toBe(rWithPack.netPayable)
    expect(r.its).toBe(rWithPack.its)
    expect(r.totalCnpsSal).toBe(rWithPack.totalCnpsSal)
  })
})

describe('LegislationPack — packs stub : refus de calcul', () => {
  const stubs = [
    BEN_2024, TGO_2024, BFA_2024, SEN_2024, MLI_2024, NER_2024, TCD_2024, NGA_2024,
  ] as const

  it.each(stubs.map(p => [p.code, p] as const))(
    '%s refuse explicitement le calcul (status=stub)',
    (_code, pack) => {
      expect(pack.status).toBe('stub')
      const ctx: PayrollContext = {
        baseSalary: 300_000, workedDays: 26, workingDaysMonth: 26,
        atRate: 0.02, maritalStatus: 'single', childrenCount: 0,
        variableElements: {},
        legislationPack: pack,
      }
      expect(() => calculatePayrollCI(ctx))
        .toThrow(/stub/i)
    },
  )
})

describe('LegislationPack — inventaire complet', () => {
  it('exactement 9 packs déclarés', () => {
    expect(Object.keys(LEGISLATION_PACKS)).toHaveLength(9)
  })

  it('les pays UEMOA + Tchad + Nigeria sont présents', () => {
    const codes = Object.keys(LEGISLATION_PACKS)
    expect(codes).toContain('CIV-2024')
    expect(codes).toContain('BEN-2024')
    expect(codes).toContain('TGO-2024')
    expect(codes).toContain('BFA-2024')
    expect(codes).toContain('SEN-2024')
    expect(codes).toContain('MLI-2024')
    expect(codes).toContain('NER-2024')
    expect(codes).toContain('TCD-2024')
    expect(codes).toContain('NGA-2024')
  })

  it('CIV est le seul pack actif (les autres sont stub)', () => {
    const actifs = Object.values(LEGISLATION_PACKS).filter(p => p.status === 'active')
    expect(actifs).toHaveLength(1)
    expect(actifs[0]!.code).toBe('CIV-2024')
  })

  it('Tchad utilise XAF (CEMAC, pas XOF UEMOA)', () => {
    expect(TCD_2024.currency).toBe('XAF')
  })

  it('Nigeria utilise NGN (hors zone franc)', () => {
    expect(NGA_2024.currency).toBe('NGN')
  })

  it('chaque pack a un libellé impôt et caisse non vide', () => {
    for (const pack of Object.values(LEGISLATION_PACKS)) {
      expect(pack.labelImpotSalaire.length).toBeGreaterThan(0)
      expect(pack.labelCaisseSociale.length).toBeGreaterThan(0)
    }
  })

  it('listLegislationPacks expose les métadonnées (sans tranches/credits)', () => {
    const list = listLegislationPacks()
    expect(list).toHaveLength(9)
    const civ = list.find(p => p.code === 'CIV-2024')!
    expect(civ).toBeDefined()
    expect(civ.status).toBe('active')
    expect(civ.smigMensuel).toBe(75_000)
    expect('tranchesImpotSalaire' in civ).toBe(false)
  })
})

describe('LegislationPack — barèmes annuels vs mensuels', () => {
  it('TGO et TCD et NGA utilisent un barème annuel', () => {
    expect(TGO_2024.bracketScale).toBe('annual')
    expect(TCD_2024.bracketScale).toBe('annual')
    expect(NGA_2024.bracketScale).toBe('annual')
  })

  it('CIV et BEN et BFA utilisent un barème mensuel', () => {
    expect(CIV_2024.bracketScale).toBe('monthly')
    expect(BEN_2024.bracketScale).toBe('monthly')
    expect(BFA_2024.bracketScale).toBe('monthly')
  })
})

describe('LegislationPack — leaveRules par pays', () => {
  it('CIV-2024 a les règles CT CI exactes (14 sem mat + 10 j pat + AT jour J employeur)', () => {
    const r = CIV_2024.leaveRules!
    expect(r.maternityWeeks).toBe(14)
    expect(r.maternitySplit).toEqual({ before: 6, after: 8 })
    expect(r.maternityPayRate).toBe(1.0)
    expect(r.paternityDays).toBe(10)
    expect(r.workAccidentDayJEmployer).toBe(true)
    expect(r.annualLeaveDaysPerMonth).toBe(2.5)
    expect(r.workingDaysPerWeek).toBe(6)
    expect(r.sickLeaveMaintien).toEqual([
      { minYears: 0, rate: 0.5 },
      { minYears: 1, rate: 0.75 },
      { minYears: 5, rate: 1.0 },
    ])
  })

  it('Nigeria : maternité 12 sem à 50% (Labour Act CAP L1)', () => {
    const r = NGA_2024.leaveRules!
    expect(r.maternityWeeks).toBe(12)
    expect(r.maternityPayRate).toBe(0.5)
    expect(r.workingDaysPerWeek).toBe(5)   // semaine de 40h lun-ven
  })

  it('Sénégal : semaine de 5 jours (40h)', () => {
    expect(SEN_2024.leaveRules!.workingDaysPerWeek).toBe(5)
  })

  it('Bénin : maternité 100% co-financée (50/50 employeur+CNSS)', () => {
    const r = BEN_2024.leaveRules!
    expect(r.maternityWeeks).toBe(14)
    expect(r.maternityFunding).toBe('shared')
    expect(r.maternityPayRate).toBe(1.0)
    expect(r.paternityDays).toBe(3)
  })

  it('chaque pack hors CIV a un leaveRules renseigné', () => {
    for (const pack of [BEN_2024, TGO_2024, BFA_2024, SEN_2024, MLI_2024, NER_2024, TCD_2024, NGA_2024]) {
      expect(pack.leaveRules, `pack ${pack.code}`).toBeDefined()
      expect(pack.leaveRules!.maternityWeeks).toBeGreaterThan(0)
      expect([5, 6]).toContain(pack.leaveRules!.workingDaysPerWeek)
    }
  })

  it('Tchad : barème ancienneté maladie étendu (12 mois plein si ≥10 ans)', () => {
    const r = TCD_2024.leaveRules!
    expect(r.sickLeaveMaintien.length).toBeGreaterThanOrEqual(3)
  })
})
