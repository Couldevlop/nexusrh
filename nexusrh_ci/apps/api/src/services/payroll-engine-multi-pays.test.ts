/**
 * Tests multi-pays — valide que le moteur calculatePayrollCI consomme bien
 * le `legislationPack` injecté dans le contexte, plutôt que d'appliquer
 * CIV-2024 par défaut.
 *
 * Approche : on crée un pack mock "TST-2024" (active) avec des taux
 * différents de CIV-2024 (retraite 8%, plafond AT 80k, etc.) et on vérifie
 * que les cotisations calculées matchent bien le pack injecté.
 *
 * Ces tests garantissent que le multi-pays UEMOA (Sénégal, Mali, Bénin,
 * etc.) est techniquement supporté dès que les packs réels seront passés
 * en `status: 'active'` après validation par un expert paie local.
 */
import { describe, it, expect } from 'vitest'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'
import { CIV_2024, type LegislationPack } from './legislation-packs.js'

// ─── Pack mock pour tests (taux volontairement différents de CIV) ───────────
const TEST_PACK: LegislationPack = {
  ...CIV_2024,
  code: 'TST-2024',
  status: 'active',
  // Taux CNPS Retraite différents (8% sal au lieu de 6.3%, 10% pat au lieu de 7.7%)
  tauxCotisationRetraiteSalarie:    0.08,
  tauxCotisationRetraitePatronal:   0.10,
  // Plafonds différents
  plafondCnpsAtPf:    80_000,         // vs 70 000 CIV
  plafondCnpsRetraite: 2_000_000,     // vs 1 647 315 CIV
}

const BASE_CTX: PayrollContext = {
  baseSalary:       500_000,
  workedDays:       26,
  workingDaysMonth: 26,
  atRate:           0.02,
  maritalStatus:    'single',
  childrenCount:    0,
  variableElements: {},
}

describe('PayrollEngine — multi-pays (legislationPack consommé)', () => {
  it('CIV par défaut : 500k → cnpsRetraiteSal 31 500 (= 500000 × 6.3%)', () => {
    const r = calculatePayrollCI(BASE_CTX)
    expect(r.cnpsRetraiteSal).toBe(31_500)
    expect(r.cnpsRetraitePat).toBe(38_500)  // 500k × 7.7%
  })

  it('Pack custom TST 8% sal / 10% pat : 500k → 40k sal / 50k pat', () => {
    const r = calculatePayrollCI({ ...BASE_CTX, legislationPack: TEST_PACK })
    expect(r.cnpsRetraiteSal).toBe(40_000)  // 500k × 8%
    expect(r.cnpsRetraitePat).toBe(50_000)  // 500k × 10%
  })

  it('Plafond AT/PF CIV = 70k, plafond TST = 80k → atPat différent', () => {
    // À salaire 100k > plafonds, le base AT/PF = min(salaire, plafond)
    const civ = calculatePayrollCI({ ...BASE_CTX, baseSalary: 100_000 })
    const tst = calculatePayrollCI({ ...BASE_CTX, baseSalary: 100_000, legislationPack: TEST_PACK })
    // CIV : 70k × atRate 2% = 1400
    expect(civ.cnpsAtPat).toBe(1_400)
    // TST : 80k × atRate 2% = 1600
    expect(tst.cnpsAtPat).toBe(1_600)
  })

  it('Plafond retraite CIV 1.6M, plafond TST 2M → retraite différent au-delà', () => {
    // À 3M salaire, base retraite = min(3M, plafond)
    const ctx = { ...BASE_CTX, baseSalary: 3_000_000 }
    const civ = calculatePayrollCI(ctx)
    const tst = calculatePayrollCI({ ...ctx, legislationPack: TEST_PACK })
    // CIV : 1 647 315 × 6.3% = 103 780
    expect(civ.cnpsRetraiteSal).toBe(103_780)
    // TST : 2 000 000 × 8% = 160 000
    expect(tst.cnpsRetraiteSal).toBe(160_000)
  })

  it('Pack stub : moteur lève une erreur explicite (sécurité finance)', () => {
    const stubPack: LegislationPack = { ...CIV_2024, code: 'BEN-2024', status: 'stub' }
    expect(() => calculatePayrollCI({ ...BASE_CTX, legislationPack: stubPack }))
      .toThrow(/stub/)
  })

  it('Mêmes valeurs entrée → mêmes valeurs sortie (déterminisme)', () => {
    const a = calculatePayrollCI({ ...BASE_CTX, legislationPack: TEST_PACK })
    const b = calculatePayrollCI({ ...BASE_CTX, legislationPack: TEST_PACK })
    expect(a.netPayable).toBe(b.netPayable)
    expect(a.cnpsRetraiteSal).toBe(b.cnpsRetraiteSal)
    expect(a.its).toBe(b.its)
  })
})
