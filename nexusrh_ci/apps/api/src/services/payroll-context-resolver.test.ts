/**
 * Tests unit du résolveur de contexte paie (Clean Architecture — pure function).
 *
 * Ces tests valident le mapping (tenant + employé + filiale) → (atRate, pack,
 * legalEntityId) sans aucune dépendance externe (pas de pg, pas de Fastify).
 */
import { describe, it, expect } from 'vitest'
import { resolvePayrollContext } from './payroll-context-resolver.js'
import { CIV_2024, SEN_2024, BEN_2024 } from './legislation-packs.js'

const TENANT_MONO = {
  id: 't1', hasSubsidiaries: false, atRate: 0.03, defaultCountryCode: 'CIV',
}
const TENANT_MULTI = {
  id: 't2', hasSubsidiaries: true, atRate: 0.02, defaultCountryCode: 'CIV',
}
const EMP_NO_ENTITY = { id: 'emp1', legalEntityId: null }
const EMP_CI       = { id: 'emp2', legalEntityId: 'le-ci' }
const EMP_SN       = { id: 'emp3', legalEntityId: 'le-sn' }

describe('resolvePayrollContext — Cas 1 : tenant mono-filiale', () => {
  it('utilise tenant.atRate + pack par défaut depuis country_code', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MONO, employee: EMP_NO_ENTITY,
    })
    expect(r.atRate).toBe(0.03)
    expect(r.legislationPackCode).toBe('CIV-2024')
    expect(r.legislationPack).toBe(CIV_2024)
    expect(r.legalEntityId).toBeNull()
    expect(r.source).toBe('tenant_global')
    expect(r.warnings).toEqual([])
  })

  it('tenant.atRate hors plage (50%) → fallback safe sur default pack', () => {
    const r = resolvePayrollContext({
      tenant: { ...TENANT_MONO, atRate: 0.5 }, employee: EMP_NO_ENTITY,
    })
    expect(r.atRate).toBe(0.02)  // tauxAtDefaultPatronal du pack CIV
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('tenant sans defaultCountryCode → fallback CIV-2024', () => {
    const r = resolvePayrollContext({
      tenant: { ...TENANT_MONO, defaultCountryCode: null }, employee: EMP_NO_ENTITY,
    })
    expect(r.legislationPackCode).toBe('CIV-2024')
  })

  it('tenant avec defaultPackCode prend précédence sur countryCode', () => {
    const r = resolvePayrollContext({
      tenant: { ...TENANT_MONO, defaultCountryCode: 'CIV', defaultPackCode: 'CIV-2024' },
      employee: EMP_NO_ENTITY,
    })
    expect(r.legislationPackCode).toBe('CIV-2024')
  })

  it('CAS multi-pays Sénégal mono-filiale (defaultCountryCode=SEN)', () => {
    const r = resolvePayrollContext({
      tenant: { ...TENANT_MONO, defaultCountryCode: 'SEN' }, employee: EMP_NO_ENTITY,
    })
    expect(r.legislationPackCode).toBe('SEN-2024')
    expect(r.legislationPack).toBe(SEN_2024)
  })
})

describe('resolvePayrollContext — Cas 2 : tenant multi-filiale + employé rattaché', () => {
  it('utilise legal_entity.atRate + pack filiale', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: 0.04, legislationPackCode: 'CIV-2024' },
    })
    expect(r.atRate).toBe(0.04)
    expect(r.legalEntityId).toBe('le-ci')
    expect(r.legislationPackCode).toBe('CIV-2024')
    expect(r.source).toBe('legal_entity')
    expect(r.warnings).toEqual([])
  })

  it('filiale Sénégal sur tenant principal CI → pack SEN-2024 appliqué', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_SN,
      legalEntity: { id: 'le-sn', atRate: 0.025, legislationPackCode: 'SEN-2024' },
    })
    expect(r.atRate).toBe(0.025)
    expect(r.legislationPackCode).toBe('SEN-2024')
    expect(r.legislationPack).toBe(SEN_2024)
    expect(r.source).toBe('legal_entity')
  })

  it('filiale sans legislationPackCode → fallback sur countryCode filiale', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_SN,
      legalEntity: { id: 'le-sn', atRate: 0.025, countryCode: 'SEN' },
    })
    expect(r.legislationPackCode).toBe('SEN-2024')
  })

  it('filiale ni packCode ni countryCode → fallback tenant.defaultCountryCode', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: 0.03 },
    })
    expect(r.legislationPackCode).toBe('CIV-2024')
  })

  it('legal_entity.atRate hors plage → fallback tenant.atRate', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: 0.99 },
    })
    expect(r.atRate).toBe(0.02)  // = tenant.atRate
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})

describe('resolvePayrollContext — Cas 3 : tenant multi-filiale + employé orphelin', () => {
  it('employé SANS legal_entity_id → fallback tenant + warning', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI, employee: EMP_NO_ENTITY,
    })
    expect(r.atRate).toBe(0.02)
    expect(r.legislationPackCode).toBe('CIV-2024')
    expect(r.legalEntityId).toBeNull()
    expect(r.source).toBe('tenant_fallback_legacy')
    expect(r.warnings[0]).toContain('sans legal_entity_id')
  })

  it('employé avec legal_entity_id mais filiale non chargée → fallback + warning', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI, employee: EMP_CI, // legalEntity omis
    })
    expect(r.source).toBe('tenant_fallback_legacy')
    expect(r.warnings[0]).toContain('non chargée')
  })

  it('employé avec legal_entity_id mais filiale chargée NE MATCHE PAS → fallback', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'autre-uuid', atRate: 0.03, legislationPackCode: 'BEN-2024' },
    })
    expect(r.source).toBe('tenant_fallback_legacy')
    expect(r.legislationPackCode).toBe('CIV-2024')  // pas BEN
  })
})

describe('resolvePayrollContext — Sécurité (OWASP A04)', () => {
  it('refuse les at_rate négatifs (utilise fallback)', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: -0.05, legislationPackCode: 'CIV-2024' },
    })
    expect(r.atRate).toBeGreaterThan(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('refuse les at_rate > 5% (utilise fallback)', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: 0.10, legislationPackCode: 'CIV-2024' },
    })
    expect(r.atRate).toBe(0.02)
    expect(r.warnings[0]).toContain('invalide')
  })

  it('pack code inconnu → fallback CIV-2024 (jamais d\'undefined)', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: 0.03, legislationPackCode: 'INEXISTANT-9999' },
    })
    expect(r.legislationPackCode).toBe('CIV-2024')
    expect(r.legislationPack).toBe(CIV_2024)
  })

  it('packs UEMOA stub sont retournés tels quels (le moteur refusera)', () => {
    // Le resolver ne filtre PAS les packs stub : c'est la responsabilité du
    // moteur lui-même. Cette séparation respecte le SRP.
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: 0.03, legislationPackCode: 'BEN-2024' },
    })
    expect(r.legislationPack).toBe(BEN_2024)
    expect(r.legislationPack.status).toBe('stub')
    // Le moteur calculatePayrollCI throw si pack.status === 'stub'.
  })
})
