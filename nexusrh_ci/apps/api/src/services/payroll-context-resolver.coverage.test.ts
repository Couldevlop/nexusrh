/**
 * Tests de couverture ciblée — payroll-context-resolver.
 *
 * Complète payroll-context-resolver.test.ts en exerçant les branches non
 * couvertes de `safeAtRate` :
 *   - valeur null / undefined (filiale sans at_rate) → fallback tenant
 *   - valeur NaN → fallback tenant
 * et le chemin `packFromCode` avec un code valide passé explicitement.
 */
import { describe, it, expect } from 'vitest'
import { resolvePayrollContext } from './payroll-context-resolver.js'

const TENANT_MULTI = {
  id: 't2', hasSubsidiaries: true, atRate: 0.02, defaultCountryCode: 'CIV',
}
const EMP_CI = { id: 'emp2', legalEntityId: 'le-ci' }

describe('safeAtRate — at_rate filiale manquant ou NaN', () => {
  it('legal_entity.atRate = null → fallback tenant.atRate + warning', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: null, legislationPackCode: 'CIV-2024' },
    })
    expect(r.atRate).toBe(0.02)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings[0]).toContain('fallback')
  })

  it('legal_entity.atRate = undefined → fallback tenant.atRate', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', legislationPackCode: 'CIV-2024' }, // atRate omis
    })
    expect(r.atRate).toBe(0.02)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('legal_entity.atRate = NaN → fallback tenant.atRate', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: Number.NaN, legislationPackCode: 'CIV-2024' },
    })
    expect(r.atRate).toBe(0.02)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('legal_entity.atRate valide dans la plage → utilisé, aucun warning', () => {
    const r = resolvePayrollContext({
      tenant: TENANT_MULTI,
      employee: EMP_CI,
      legalEntity: { id: 'le-ci', atRate: 0.035, legislationPackCode: 'CIV-2024' },
    })
    expect(r.atRate).toBe(0.035)
    expect(r.warnings).toEqual([])
  })
})
