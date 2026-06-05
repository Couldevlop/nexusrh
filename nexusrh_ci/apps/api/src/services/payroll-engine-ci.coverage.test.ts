/**
 * Tests de couverture ciblée — payroll-engine-ci.
 *
 * Complète les golden existants (payroll-engine-ci.test.ts,
 * payroll-engine-multi-pays.test.ts, .pme-scenario) en exerçant :
 *   - `evalFormule` : évaluateur de formules de rubriques (toutes branches)
 *   - les branches d'absence non couvertes par les golden :
 *       · maladie_sans_at (indemnité taxée + ligne 1800)
 *       · accident_travail avec jour J dans le mois (joursIjCnps = days - 1)
 *
 * Aucune fixture golden n'est modifiée ; ces tests sont additifs.
 */
import { describe, it, expect } from 'vitest'
import { calculatePayrollCI, evalFormule, type PayrollContext } from './payroll-engine-ci.js'
import { CIV_2024, type LegislationPack } from './legislation-packs.js'

const baseCtx: PayrollContext = {
  baseSalary:       200_000,
  workedDays:       26,
  workingDaysMonth: 26,
  atRate:           0.02,
  maritalStatus:    'single',
  childrenCount:    0,
  variableElements: {},
}

describe('evalFormule — préfixe VAR:', () => {
  it('VAR:CLE → lit directement la variable existante', () => {
    expect(evalFormule('VAR:PRIME', { PRIME: 30_000 })).toBe(30_000)
  })

  it('VAR:CLE absente → 0 (fallback sûr)', () => {
    expect(evalFormule('VAR:INEXISTANTE', {})).toBe(0)
  })
})

describe('evalFormule — variable ITS', () => {
  it("formule 'ITS' → valeur ITS calculée", () => {
    expect(evalFormule('ITS', { ITS: 12_345 })).toBe(12_345)
  })

  it("formule 'ITS' absente du contexte → 0", () => {
    expect(evalFormule('ITS', {})).toBe(0)
  })
})

describe('evalFormule — whitelist de sécurité', () => {
  it('caractères interdits (minuscules / appel de fonction) → 0', () => {
    expect(evalFormule('process.exit(1)', {})).toBe(0)
    expect(evalFormule('alert(1)', {})).toBe(0)
  })
})

describe('evalFormule — évaluation arithmétique', () => {
  it('expression numérique simple → résultat plancher (Math.floor)', () => {
    expect(evalFormule('100 / 3', {})).toBe(33)
  })

  it('substitution des variables connues (mot entier)', () => {
    expect(evalFormule('BASE * 0.063', { BASE: 200_000 })).toBe(12_600)
  })

  it('résultat négatif borné à 0 (Math.max)', () => {
    expect(evalFormule('10 - 50', {})).toBe(0)
  })

  it('résultat non fini (division par zéro) → 0', () => {
    expect(evalFormule('100 / 0', {})).toBe(0)
  })

  it('expression invalide (parenthèses déséquilibrées) → 0 via catch', () => {
    expect(evalFormule('((1 + 2)', {})).toBe(0)
  })

  it('expression vide après whitelist → 0', () => {
    // Une chaîne d'espaces passe la whitelist mais `new Function('return ()')`
    // lève → catch → 0.
    expect(evalFormule('   ', {})).toBe(0)
  })
})

describe('calculatePayrollCI — absence maladie sans AT (branche taxée)', () => {
  it('maladie : indemnité incluse dans grossSalary + ligne 1800 + soumise à ITS', () => {
    const ctx: PayrollContext = {
      ...baseCtx,
      workedDays: 13,            // moitié de présence
      absence: { type: 'maladie_sans_at', absenceDays: 13, maintienTaux: 0.5 },
    }
    const r = calculatePayrollCI(ctx)
    // L'indemnité maladie est renseignée et apparaît comme ligne earning 1800
    expect(r.indemniteAbsence).toBeDefined()
    expect(r.lines.some(l => l.code === '1800')).toBe(true)
    // Maladie n'est PAS exonérée d'ITS → pas de bordereau CNPS
    expect(r.bordereauCnps).toBeUndefined()
    expect(r.netPayable).toBeGreaterThan(0)
  })

  it('maladie sans maintienTaux → défaut 100%', () => {
    const ctx: PayrollContext = {
      ...baseCtx,
      workedDays: 13,
      absence: { type: 'maladie_sans_at', absenceDays: 13 },
    }
    const r = calculatePayrollCI(ctx)
    const tauxJour = baseCtx.baseSalary / baseCtx.workingDaysMonth
    expect(r.indemniteAbsence).toBe(Math.floor(tauxJour * 13 * 1.0))
  })
})

describe('calculatePayrollCI — accident du travail', () => {
  it('jour J de l\'accident dans le mois → joursIjCnps = absenceDays - 1', () => {
    const ctx: PayrollContext = {
      ...baseCtx,
      workedDays: 20,
      absence: { type: 'accident_travail', absenceDays: 6, atJourAccidentInMonth: true },
    }
    const r = calculatePayrollCI(ctx)
    const tauxJour = baseCtx.baseSalary / baseCtx.workingDaysMonth
    // 6 jours - le jour J (payé par l'employeur via brutProrata) = 5 jours IJSS CNPS
    expect(r.indemniteAbsence).toBe(Math.floor(tauxJour * 5))
    expect(r.bordereauCnps).toBeDefined()
    expect(r.bordereauCnps?.motif).toBe('accident_travail')
    expect(r.lines.some(l => l.code === '1900')).toBe(true)
  })

  it('jour J hors du mois → tous les jours indemnisés par la CNPS', () => {
    const ctx: PayrollContext = {
      ...baseCtx,
      workedDays: 20,
      absence: { type: 'accident_travail', absenceDays: 6, atJourAccidentInMonth: false },
    }
    const r = calculatePayrollCI(ctx)
    const tauxJour = baseCtx.baseSalary / baseCtx.workingDaysMonth
    expect(r.indemniteAbsence).toBe(Math.floor(tauxJour * 6))
  })

  it('AT d\'un seul jour avec jour J inclus → aucune indemnité CNPS (joursIjCnps = 0)', () => {
    const ctx: PayrollContext = {
      ...baseCtx,
      workedDays: 25,
      absence: { type: 'accident_travail', absenceDays: 1, atJourAccidentInMonth: true },
    }
    const r = calculatePayrollCI(ctx)
    expect(r.indemniteAbsence).toBeUndefined()
    expect(r.bordereauCnps).toBeUndefined()
  })
})

describe('calculatePayrollCI — barème annuel (bracketScale)', () => {
  it('pack à barème annuel : ITS calculé puis ramené au mois', () => {
    // Pack actif dérivé de CIV mais avec barème ANNUEL (comme TGO/TCD/NGA).
    const ANNUAL_PACK: LegislationPack = {
      ...CIV_2024,
      code: 'ANN-2024',
      status: 'active',
      bracketScale: 'annual',
    }
    const r = calculatePayrollCI({ ...baseCtx, baseSalary: 400_000, legislationPack: ANNUAL_PACK })
    // Le barème annuel s'applique sur base×12 puis /12 → ITS positif et entier.
    expect(r.its).toBeGreaterThanOrEqual(0)
    expect(r.its % 1).toBe(0)
  })
})

describe('calculatePayrollCI — mutuelle santé (sal + pat)', () => {
  it('mutuelle salarié + patronal → lignes 4000 et 4100, impact net et coût employeur', () => {
    const ctx: PayrollContext = {
      ...baseCtx,
      variableElements: { MUTUELLE_SAL: 5_000, MUTUELLE_PAT: 10_000 },
    }
    const r = calculatePayrollCI(ctx)
    expect(r.lines.some(l => l.code === '4000')).toBe(true)  // mutuelle salarié
    expect(r.lines.some(l => l.code === '4100')).toBe(true)  // mutuelle patronal
    const sans = calculatePayrollCI(baseCtx)
    // Mutuelle salarié réduit le net ; mutuelle patronal augmente le coût employeur
    expect(r.netPayable).toBe(sans.netPayable - 5_000)
    expect(r.employerCost).toBe(sans.employerCost + 10_000)
  })
})
