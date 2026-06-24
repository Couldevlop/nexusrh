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
  TCD_2024, NGA_2024, GHA_2024,
  LEGISLATION_PACKS, DEFAULT_LEGISLATION_PACK,
  getLegislationPack, listLegislationPacks,
  getPackByCountry, isSupportedCountry, listCountries,
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

describe('LegislationPack — garde-fou stub : refus de calcul', () => {
  // Tous les packs déclarés sont désormais ACTIFS (valeurs sourcées dans
  // docs/referentiel-paie-afrique.md). Le mécanisme de refus reste actif pour
  // tout futur pack marqué stub : on le teste avec un pack synthétique.
  it('un pack stub fait toujours lever une erreur explicite (sécurité)', () => {
    const fakeStub = { ...CIV_2024, code: 'XXX-2024', status: 'stub' as const }
    const ctx: PayrollContext = {
      baseSalary: 300_000, workedDays: 26, workingDaysMonth: 26,
      atRate: 0.02, maritalStatus: 'single', childrenCount: 0,
      variableElements: {}, legislationPack: fakeStub,
    }
    expect(() => calculatePayrollCI(ctx)).toThrow(/stub/i)
  })

  it.each([BEN_2024, TGO_2024, BFA_2024, SEN_2024, MLI_2024, NER_2024, TCD_2024, NGA_2024].map(p => [p.code, p] as const))(
    '%s est actif et calcule sans lever',
    (_code, pack) => {
      expect(pack.status).toBe('active')
      const ctx: PayrollContext = {
        baseSalary: 300_000, workedDays: 26, workingDaysMonth: 26,
        atRate: 0.02, maritalStatus: 'single', childrenCount: 0,
        variableElements: {}, legislationPack: pack,
      }
      expect(() => calculatePayrollCI(ctx)).not.toThrow()
    },
  )
})

describe('LegislationPack — inventaire complet', () => {
  it('exactement 16 packs déclarés (UEMOA + CEMAC + Nigeria + Ghana)', () => {
    expect(Object.keys(LEGISLATION_PACKS)).toHaveLength(16)
  })

  it('les pays UEMOA + CEMAC + Nigeria + Ghana sont présents', () => {
    const codes = Object.keys(LEGISLATION_PACKS)
    for (const c of [
      'CIV-2024', 'BEN-2024', 'TGO-2024', 'BFA-2024', 'SEN-2024', 'MLI-2024', 'NER-2024',
      'TCD-2024', 'NGA-2024', 'CMR-2024', 'GAB-2024', 'COG-2024', 'CAF-2024', 'GNQ-2024', 'GNB-2024',
      'GHA-2024',
    ]) expect(codes).toContain(c)
  })

  it('les 16 packs sont actifs (valeurs sourcées appliquées)', () => {
    const actifs = Object.values(LEGISLATION_PACKS).filter(p => p.status === 'active')
    expect(actifs).toHaveLength(16)
  })

  it('Tchad utilise XAF (CEMAC, pas XOF UEMOA)', () => {
    expect(TCD_2024.currency).toBe('XAF')
  })

  it('Nigeria utilise NGN (hors zone franc)', () => {
    expect(NGA_2024.currency).toBe('NGN')
  })

  it('Ghana utilise GHS (CEDEAO anglophone, hors zone franc)', () => {
    expect(GHA_2024.currency).toBe('GHS')
    expect(GHA_2024.status).toBe('active')
    expect(GHA_2024.labelCaisseSociale).toBe('SSNIT')
    expect(getPackByCountry('GHA')).toBe(GHA_2024)
    expect(isSupportedCountry('GHA')).toBe(true)
  })

  it('chaque pack a un libellé impôt et caisse non vide', () => {
    for (const pack of Object.values(LEGISLATION_PACKS)) {
      expect(pack.labelImpotSalaire.length).toBeGreaterThan(0)
      expect(pack.labelCaisseSociale.length).toBeGreaterThan(0)
    }
  })

  it('listLegislationPacks expose les métadonnées (sans tranches/credits)', () => {
    const list = listLegislationPacks()
    expect(list).toHaveLength(16)
    const civ = list.find(p => p.code === 'CIV-2024')!
    expect(civ).toBeDefined()
    expect(civ.status).toBe('active')
    expect(civ.smigMensuel).toBe(75_000)
    expect('tranchesImpotSalaire' in civ).toBe(false)
  })
})

describe('LegislationPack — résolution par PAYS (paramétrage tenant)', () => {
  it('getPackByCountry(CIV) renvoie le pack CI actif', () => {
    expect(getPackByCountry('CIV')).toBe(CIV_2024)
  })

  it('getPackByCountry est insensible à la casse', () => {
    expect(getPackByCountry('civ')).toBe(CIV_2024)
    expect(getPackByCountry('Sen')).toBe(SEN_2024)
  })

  it('getPackByCountry mappe chaque pays UEMOA/CEMAC/Nigeria', () => {
    expect(getPackByCountry('BEN')).toBe(BEN_2024)
    expect(getPackByCountry('TGO')).toBe(TGO_2024)
    expect(getPackByCountry('BFA')).toBe(BFA_2024)
    expect(getPackByCountry('MLI')).toBe(MLI_2024)
    expect(getPackByCountry('NER')).toBe(NER_2024)
    expect(getPackByCountry('TCD')).toBe(TCD_2024)
    expect(getPackByCountry('NGA')).toBe(NGA_2024)
  })

  it('getPackByCountry(pays inconnu/null) renvoie null (pas de repli silencieux)', () => {
    expect(getPackByCountry('XXX')).toBeNull()
    expect(getPackByCountry(null)).toBeNull()
    expect(getPackByCountry(undefined)).toBeNull()
    expect(getPackByCountry('')).toBeNull()
  })

  it('isSupportedCountry distingue pays pris en charge et inconnus', () => {
    expect(isSupportedCountry('CIV')).toBe(true)
    expect(isSupportedCountry('sen')).toBe(true)
    expect(isSupportedCountry('XXX')).toBe(false)
    expect(isSupportedCountry(null)).toBe(false)
  })

  it('listCountries expose 16 pays, tous actifs', () => {
    const list = listCountries()
    expect(list).toHaveLength(16)
    expect(list.filter(c => c.status === 'active')).toHaveLength(16)
    // chaque entrée porte SMIG + devise + packCode
    for (const c of list) {
      expect(c.smigMensuel).toBeGreaterThan(0)
      expect(c.currency.length).toBeGreaterThan(0)
      expect(c.packCode).toMatch(/^[A-Z]{3}-\d{4}$/)
    }
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
