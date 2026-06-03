/**
 * Sécurité du sourcing par pays (OWASP A01) : un tenant mono-pays ne peut
 * sourcer que dans son propre pays, le `countries` du client est ignoré.
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveSourcingCountries, toIso2 } from './sourcing-countries.service.js'

function pool(row: Record<string, unknown> | null) {
  return { query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) } as never
}

describe('toIso2', () => {
  it('mappe ISO-3 connus et replie sur 2 lettres sinon', () => {
    expect(toIso2('CIV')).toBe('CI')
    expect(toIso2('SEN')).toBe('SN')
    expect(toIso2('NGA')).toBe('NG')
    expect(toIso2(null)).toBe('CI')
    expect(toIso2('ZZZ')).toBe('ZZ')
  })
})

describe('resolveSourcingCountries', () => {
  it('mono-pays : ignore le client et force le pays du tenant', async () => {
    const r = await resolveSourcingCountries(
      pool({ has_subsidiaries: false, payroll_mode: 'single_country', default_country_code: 'CIV' }),
      'tenant_sotra', ['SN', 'FR', 'NG'])
    expect(r.multiCountry).toBe(false)
    expect(r.countries).toEqual(['CI'])
  })

  it('mono-pays SEN : force SN', async () => {
    const r = await resolveSourcingCountries(
      pool({ has_subsidiaries: false, payroll_mode: 'single_country', default_country_code: 'SEN' }),
      'tenant_x', ['CI'])
    expect(r.countries).toEqual(['SN'])
  })

  it('multi-pays (has_subsidiaries) : conserve la sélection client nettoyée', async () => {
    const r = await resolveSourcingCountries(
      pool({ has_subsidiaries: true, payroll_mode: 'multi_country', default_country_code: 'CIV' }),
      'tenant_grp', ['sn', 'bj', 'XX', '12'])
    expect(r.multiCountry).toBe(true)
    expect(r.countries).toEqual(['SN', 'BJ', 'XX']) // '12' rejeté (pas 2 lettres)
  })

  it('multi-pays sans sélection : repli sur le pays du tenant', async () => {
    const r = await resolveSourcingCountries(
      pool({ has_subsidiaries: true, payroll_mode: 'multi_country', default_country_code: 'CIV' }),
      'tenant_grp', [])
    expect(r.countries).toEqual(['CI'])
  })

  it('tenant introuvable → défauts prudents (mono-pays CI)', async () => {
    const r = await resolveSourcingCountries(pool(null), 'tenant_ghost', ['SN'])
    expect(r).toMatchObject({ multiCountry: false, countries: ['CI'] })
  })

  it('schéma invalide → mono-pays CI (pas de requête)', async () => {
    const p = pool(null)
    const r = await resolveSourcingCountries(p, 'Bad Schema!', ['SN'])
    expect(r.countries).toEqual(['CI'])
    expect((p as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled()
  })
})
