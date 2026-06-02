/**
 * Service cabinet — point de contrôle d'autorisation (OWASP A01).
 * Couvre toutes les branches de refus + le succès, et le prédicat CI.
 */
import { describe, it, expect, vi } from 'vitest'
import { assertAgencyCanActOnTenant, assertTenantIsCI } from './agency.service.js'

function poolReturning(row: Record<string, unknown> | null) {
  return { query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) } as never
}

const OK_ROW = {
  agency_status: 'active',
  tenant_id: 't1', schema_name: 'tenant_acme', name: 'ACME', slug: 'acme',
  primary_color: '#1D4ED8', secondary_color: '#F48C06', logo_url: null, city: 'Abidjan',
  tenant_status: 'active', default_country_code: 'CIV',
  has_subsidiaries: false, payroll_mode: 'single_country', link_id: 'lnk1',
}

describe('assertTenantIsCI', () => {
  it('CIV / CI → vrai ; autre / null → faux', () => {
    expect(assertTenantIsCI('CIV')).toBe(true)
    expect(assertTenantIsCI('ci')).toBe(true)
    expect(assertTenantIsCI('SEN')).toBe(false)
    expect(assertTenantIsCI(null)).toBe(false)
    expect(assertTenantIsCI(undefined)).toBe(false)
  })
})

describe('assertAgencyCanActOnTenant — matrice de refus', () => {
  it('utilisateur hors cabinet → not_member', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning(null), 'au1', 'ag1', 't1')
    expect(r).toEqual({ ok: false, reason: 'not_member' })
  })

  it('cabinet suspendu → agency_suspended', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning({ ...OK_ROW, agency_status: 'suspended' }), 'au1', 'ag1', 't1')
    expect(r).toEqual({ ok: false, reason: 'agency_suspended' })
  })

  it('tenant non rattaché (link absent) → not_assigned', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning({ ...OK_ROW, link_id: null }), 'au1', 'ag1', 't1')
    expect(r).toEqual({ ok: false, reason: 'not_assigned' })
  })

  it('tenant inexistant (tenant_id null) → not_assigned', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning({ ...OK_ROW, tenant_id: null, link_id: null }), 'au1', 'ag1', 't1')
    expect(r).toEqual({ ok: false, reason: 'not_assigned' })
  })

  it('tenant suspendu → tenant_suspended', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning({ ...OK_ROW, tenant_status: 'suspended' }), 'au1', 'ag1', 't1')
    expect(r).toEqual({ ok: false, reason: 'tenant_suspended' })
  })

  it('tenant non-CI → non_ci', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning({ ...OK_ROW, default_country_code: 'SEN' }), 'au1', 'ag1', 't1')
    expect(r).toEqual({ ok: false, reason: 'non_ci' })
  })

  it('schéma non conforme → bad_schema', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning({ ...OK_ROW, schema_name: 'Invalid Schema!' }), 'au1', 'ag1', 't1')
    expect(r).toEqual({ ok: false, reason: 'bad_schema' })
  })

  it('tenant trial autorisé → ok', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning({ ...OK_ROW, tenant_status: 'trial' }), 'au1', 'ag1', 't1')
    expect(r.ok).toBe(true)
  })

  it('cas nominal → ok + contexte tenant', async () => {
    const r = await assertAgencyCanActOnTenant(poolReturning(OK_ROW), 'au1', 'ag1', 't1')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.tenant.schemaName).toBe('tenant_acme')
      expect(r.tenant.tenantId).toBe('t1')
      expect(r.tenant.defaultCountryCode).toBe('CIV')
    }
  })
})
