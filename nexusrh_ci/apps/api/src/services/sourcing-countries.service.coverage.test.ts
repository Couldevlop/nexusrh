/**
 * Sourcing par pays — complément de couverture pour les branches résiduelles :
 *   - toIso2 avec undefined (repli 'CIV' → 'CI')
 *   - multi-pays : filtrage regex /^[A-Z]{2}$/ + dédoublonnage + repli
 *   - requested non-tableau côté multi-pays → repli sur le pays du tenant
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveSourcingCountries, toIso2 } from './sourcing-countries.service.js'

function pool(row: Record<string, unknown> | null) {
  return { query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) } as never
}

describe('toIso2 — repli par défaut', () => {
  it('undefined → CI (défaut CIV)', () => {
    expect(toIso2(undefined)).toBe('CI')
  })
})

describe('resolveSourcingCountries — multi-pays branches résiduelles', () => {
  it('dédoublonne et met en majuscules la sélection client', async () => {
    const r = await resolveSourcingCountries(
      pool({ has_subsidiaries: true, payroll_mode: 'multi_country', default_country_code: 'CIV' }),
      'tenant_grp', ['ci', 'CI', 'sn'])
    expect(r.multiCountry).toBe(true)
    expect(r.countries).toEqual(['CI', 'SN'])
  })

  it('requested non défini en multi-pays → repli sur le pays du tenant', async () => {
    const r = await resolveSourcingCountries(
      pool({ has_subsidiaries: true, payroll_mode: 'multi_country', default_country_code: 'SEN' }),
      'tenant_grp', undefined)
    expect(r.multiCountry).toBe(true)
    expect(r.countries).toEqual(['SN'])
  })

  it('multi-pays détecté via payroll_mode seul (has_subsidiaries false)', async () => {
    const r = await resolveSourcingCountries(
      pool({ has_subsidiaries: false, payroll_mode: 'multi_country', default_country_code: 'CIV' }),
      'tenant_grp', ['BJ'])
    expect(r.multiCountry).toBe(true)
    expect(r.countries).toEqual(['BJ'])
  })

  it('échec de la requête DB → défauts prudents (mono-pays CI)', async () => {
    const p = { query: vi.fn().mockRejectedValue(new Error('db down')) } as never
    const r = await resolveSourcingCountries(p, 'tenant_err', ['SN'])
    expect(r).toMatchObject({ multiCountry: false, countries: ['CI'] })
  })
})
