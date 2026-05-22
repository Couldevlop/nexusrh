/**
 * Golden test end-to-end multi-filiales (Palier 3).
 *
 * Scénario validé : un groupe ivoirien "GROUPE TEST CI" possède 2 filiales
 * dans le même pays (CIV) mais avec taux AT et secteurs différents :
 *   - Filiale A : SERVICES (taux AT 2 %) — siège, cadres administratifs
 *   - Filiale B : INDUSTRIE (taux AT 4 %) — usine, ouvriers
 *
 * Et un second scénario multi-pays :
 *   - Filiale C : agence Sénégal (pack SEN-2024 si activé, sinon CIV — vu
 *     que SEN-2024 est en `stub` aujourd'hui, on bascule sur un pack custom
 *     active pour valider le mécanisme)
 *
 * Pour chaque salarié, on simule le pipeline complet :
 *   resolvePayrollContext(tenant, employee, legalEntity)
 *     → calculatePayrollCI(input + atRate + legislationPack résolus)
 *     → comparaison au snapshot des bulletins attendus
 *
 * Cette suite garantit qu'à input identique mais filiale différente,
 * les bulletins divergent comme attendu (taux AT, plafonds, cotisations).
 */
import { describe, it, expect } from 'vitest'
import { resolvePayrollContext } from './payroll-context-resolver.js'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'
import { CIV_2024, type LegislationPack } from './legislation-packs.js'

// ─── Données partagées ──────────────────────────────────────────────────────
const TENANT_GROUPE_CI = {
  id: 'tenant-grp', hasSubsidiaries: true, atRate: 0.02, defaultCountryCode: 'CIV',
}

const FILIALE_SERVICES = {
  id: 'le-services', atRate: 0.02, legislationPackCode: 'CIV-2024',
}
const FILIALE_INDUSTRIE = {
  id: 'le-industrie', atRate: 0.04, legislationPackCode: 'CIV-2024',
}

// Pack custom Sénégal "active" pour test (puisque SEN-2024 réel est en stub).
// Représente une caisse différente : retraite 7 % sal / 8.4 % pat, plafonds
// 1.8M / 60k. Permet de valider le mécanisme multi-pays sans dépendre de
// l'activation officielle des packs UEMOA.
const SEN_ACTIVE_PACK: LegislationPack = {
  ...CIV_2024,
  code: 'SEN-2024-TEST',
  status: 'active',
  tauxCotisationRetraiteSalarie: 0.07,
  tauxCotisationRetraitePatronal: 0.084,
  plafondCnpsRetraite: 1_800_000,
  plafondCnpsAtPf:     60_000,
}

// 2 employés identiques (même brut, même profil familial), mais rattachés à
// des filiales distinctes — la seule chose qui diffère est la résolution.
const EMP_TEMPLATE = {
  baseSalary:        500_000,
  workedDays:        26,
  workingDaysMonth:  26,
  maritalStatus:     'married',
  childrenCount:     2,
  variableElements:  {},
} as const

// ─── Suite 1 : mono-pays, 2 filiales (services vs industrie) ────────────────
describe('Multi-filiales mono-pays (CI) : Services 2% vs Industrie 4%', () => {
  it('Pipeline filiale Services : at_rate 2% → cnpsAtPat 1 400', () => {
    const resolved = resolvePayrollContext({
      tenant: TENANT_GROUPE_CI,
      employee: { id: 'emp-services-1', legalEntityId: 'le-services' },
      legalEntity: FILIALE_SERVICES,
    })
    expect(resolved.source).toBe('legal_entity')
    expect(resolved.atRate).toBe(0.02)
    expect(resolved.legalEntityId).toBe('le-services')

    const ctx: PayrollContext = {
      ...EMP_TEMPLATE,
      atRate:          resolved.atRate,
      legislationPack: resolved.legislationPack,
    }
    const r = calculatePayrollCI(ctx)
    // Snapshot attendu (services, at 2%)
    expect(r.cnpsAtPat).toBe(1_400)              // 70k × 0.02
    expect(r.cnpsRetraiteSal).toBe(31_500)       // 500k × 6.3%
    expect(r.cnpsRetraitePat).toBe(38_500)       // 500k × 7.7%
    expect(r.grossSalary).toBe(500_000)
    expect(r.smigCompliant).toBe(true)
  })

  it('Pipeline filiale Industrie : at_rate 4% → cnpsAtPat 2 800', () => {
    const resolved = resolvePayrollContext({
      tenant: TENANT_GROUPE_CI,
      employee: { id: 'emp-industrie-1', legalEntityId: 'le-industrie' },
      legalEntity: FILIALE_INDUSTRIE,
    })
    expect(resolved.atRate).toBe(0.04)
    expect(resolved.legalEntityId).toBe('le-industrie')

    const r = calculatePayrollCI({
      ...EMP_TEMPLATE,
      atRate: resolved.atRate, legislationPack: resolved.legislationPack,
    })
    // Snapshot industrie : seule différence avec Services = cnpsAtPat
    expect(r.cnpsAtPat).toBe(2_800)              // 70k × 0.04 (double Services)
    expect(r.cnpsRetraiteSal).toBe(31_500)       // identique (pack CIV)
    expect(r.cnpsRetraitePat).toBe(38_500)
    expect(r.grossSalary).toBe(500_000)
  })

  it('Mêmes inputs, filiales différentes → seul cnpsAtPat + employerCost diffèrent', () => {
    const ctxServices = resolvePayrollContext({
      tenant: TENANT_GROUPE_CI,
      employee: { id: 'e1', legalEntityId: 'le-services' },
      legalEntity: FILIALE_SERVICES,
    })
    const ctxIndustrie = resolvePayrollContext({
      tenant: TENANT_GROUPE_CI,
      employee: { id: 'e2', legalEntityId: 'le-industrie' },
      legalEntity: FILIALE_INDUSTRIE,
    })

    const rServices = calculatePayrollCI({
      ...EMP_TEMPLATE, atRate: ctxServices.atRate, legislationPack: ctxServices.legislationPack,
    })
    const rIndustrie = calculatePayrollCI({
      ...EMP_TEMPLATE, atRate: ctxIndustrie.atRate, legislationPack: ctxIndustrie.legislationPack,
    })

    // Net du salarié IDENTIQUE (taux AT = part patronale uniquement)
    expect(rServices.netPayable).toBe(rIndustrie.netPayable)
    expect(rServices.totalCnpsSal).toBe(rIndustrie.totalCnpsSal)
    expect(rServices.its).toBe(rIndustrie.its)

    // Coût employeur DIFFÉRENT (l'industrie paie plus de cotisations AT)
    expect(rIndustrie.employerCost).toBeGreaterThan(rServices.employerCost)
    expect(rIndustrie.cnpsAtPat - rServices.cnpsAtPat).toBe(1_400)  // delta 2% × 70k
    expect(rIndustrie.employerCost - rServices.employerCost).toBe(1_400)
  })
})

// ─── Suite 2 : multi-pays (CIV vs SEN custom active) ────────────────────────
describe('Multi-filiales multi-pays (CIV vs SEN custom)', () => {
  it('Filiale Sénégal (pack custom active) : retraite 7% sal / 8.4% pat', () => {
    const resolved = resolvePayrollContext({
      tenant: TENANT_GROUPE_CI,
      employee: { id: 'emp-sn-1', legalEntityId: 'le-sn' },
      legalEntity: { id: 'le-sn', atRate: 0.025, countryCode: 'SEN' },
    })
    // Le code SEN-2024 n'est pas activé en prod (stub) ; on simule via pack custom
    const r = calculatePayrollCI({
      ...EMP_TEMPLATE,
      atRate: resolved.atRate,
      legislationPack: SEN_ACTIVE_PACK,
    })
    // Plafond retraite SEN custom = 1.8M (vs 1.647M CIV)
    // Salaire 500k < plafond → base = 500k, retraite sal = 500k × 7% = 35 000
    expect(r.cnpsRetraiteSal).toBe(35_000)
    expect(r.cnpsRetraitePat).toBe(42_000)        // 500k × 8.4%
    // Plafond AT/PF custom = 60k → cnpsAtPat = 60k × 0.025 = 1 500
    expect(r.cnpsAtPat).toBe(1_500)
  })

  it('Même salarié sur CIV vs SEN custom → bulletins divergent', () => {
    const ctxCiv = {
      ...EMP_TEMPLATE,
      atRate: 0.02, legislationPack: CIV_2024,
    } satisfies PayrollContext
    const ctxSen = {
      ...EMP_TEMPLATE,
      atRate: 0.025, legislationPack: SEN_ACTIVE_PACK,
    } satisfies PayrollContext

    const rCiv = calculatePayrollCI(ctxCiv)
    const rSen = calculatePayrollCI(ctxSen)

    // Cotisations retraite SEN > CIV (taux plus élevés)
    expect(rSen.cnpsRetraiteSal).toBeGreaterThan(rCiv.cnpsRetraiteSal)
    expect(rSen.cnpsRetraitePat).toBeGreaterThan(rCiv.cnpsRetraitePat)
    // Net divergent : SEN prélève plus côté salarié
    expect(rSen.netPayable).toBeLessThan(rCiv.netPayable)
  })
})

// ─── Suite 3 : non-régression mono-filiale (pas de Palier 3) ─────────────────
describe('Mono-filiale (non-régression Palier 1) : tenant sans filiales', () => {
  it('Tenant has_subsidiaries=false → comportement identique à l\'avant-Palier-3', () => {
    const resolved = resolvePayrollContext({
      tenant: { id: 't-solo', hasSubsidiaries: false, atRate: 0.02, defaultCountryCode: 'CIV' },
      employee: { id: 'emp-solo', legalEntityId: null },
    })
    expect(resolved.source).toBe('tenant_global')
    expect(resolved.legalEntityId).toBeNull()
    expect(resolved.legislationPack).toBe(CIV_2024)
    expect(resolved.atRate).toBe(0.02)

    const r = calculatePayrollCI({
      ...EMP_TEMPLATE, atRate: resolved.atRate, legislationPack: resolved.legislationPack,
    })
    expect(r.cnpsAtPat).toBe(1_400)
    expect(r.cnpsRetraiteSal).toBe(31_500)
  })

  it('Tenant multi-filiale mais employé orphelin → fallback safe + warning', () => {
    const resolved = resolvePayrollContext({
      tenant: TENANT_GROUPE_CI,
      employee: { id: 'emp-no-le', legalEntityId: null },
    })
    expect(resolved.source).toBe('tenant_fallback_legacy')
    expect(resolved.warnings.length).toBeGreaterThan(0)
    // Le moteur fonctionne quand même
    const r = calculatePayrollCI({
      ...EMP_TEMPLATE, atRate: resolved.atRate, legislationPack: resolved.legislationPack,
    })
    expect(r.grossSalary).toBe(500_000)
  })
})
