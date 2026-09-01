import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { collectReport } from './collect.js'
import { weeklyPeriod } from './period.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

const TENANT = {
  id: 't1', name: 'SOTRA', schema_name: 'tenant_sotra', status: 'active',
  plan_type: 'business', sector: 'transport', max_users: 100, max_employees: 150,
  trial_ends_at: null, created_at: new Date('2026-01-01T00:00:00Z'),
}

beforeEach(() => queryMock.mockReset())

describe('collectReport', () => {
  it('ignore un schéma au nom invalide plutôt que de l’interpoler', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...TENANT, schema_name: 'tenant"; DROP' }] })
      .mockResolvedValueOnce({ rows: [] })   // agences
      .mockResolvedValueOnce({ rows: [] })   // rattachements
    const data = await collectReport(pool, period)
    expect(data.tenants).toHaveLength(1)
    expect(data.tenants[0]?.collected).toBe(false)
    // Aucune requête n'a interpolé le nom hostile.
    const sql = queryMock.mock.calls.map(c => String(c[0])).join('\n')
    expect(sql).not.toContain('DROP')
  })

  it('isole un tenant dont le schéma est cassé sans faire échouer le rapport', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [TENANT, { ...TENANT, id: 't2', name: 'CABEX', schema_name: 'tenant_cabex' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // t1 : effectifs OK, puis users, puis audit
      .mockResolvedValueOnce({ rows: [{ headcount: 82, hires: 3, departures: 1 }] })
      .mockResolvedValueOnce({ rows: [{ contract_type: 'cdi', n: 3 }] })
      .mockResolvedValueOnce({ rows: [{ active_users: 10, logged_in: 7, last_login_at: null }] })
      .mockResolvedValueOnce({ rows: [] })
      // t2 : le premier appel explose
      .mockRejectedValueOnce(Object.assign(new Error('relation absente'), { code: '42P01' }))

    const data = await collectReport(pool, period)
    expect(data.tenants[0]?.collected).toBe(true)
    expect(data.tenants[0]?.headcount).toBe(82)
    expect(data.tenants[1]?.collected).toBe(false)
  })

  it('agrège l’effectif des entreprises rattachées à chaque cabinet', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [TENANT] })
      .mockResolvedValueOnce({ rows: [{ id: 'a1', name: 'Cabinet Expertise', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ agency_id: 'a1', tenant_id: 't1', attached: true, detached: false }] })
      .mockResolvedValueOnce({ rows: [{ headcount: 82, hires: 3, departures: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active_users: 10, logged_in: 7, last_login_at: null }] })
      .mockResolvedValueOnce({ rows: [] })

    const data = await collectReport(pool, period)
    expect(data.agencies[0]?.managedTenants).toBe(1)
    expect(data.agencies[0]?.headcount).toBe(82)
  })
})
