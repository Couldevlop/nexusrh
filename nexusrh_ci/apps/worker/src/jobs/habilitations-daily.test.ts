/**
 * Job quotidien des habilitations (tâche 12).
 *
 * Ce que ce banc protège : le job ne DONNE ni ne RETIRE aucun droit — le
 * moteur filtre déjà sur les dates — il trace. Une trace rejouée chaque nuit
 * remplirait la piste d'audit de doublons et rendrait illisible la seule
 * chose qu'un contrôleur vient y chercher : quand une délégation a cessé.
 * Le non-rejeu est donc testé autant que l'écriture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))

import { processHabilitationsDailyJob } from './habilitations-daily.js'

const job = () => ({ id: 'job-1', data: {} } as unknown as Job<unknown, void>)

interface Tenant {
  schema: string
  /** Délégations échues jamais tracées (le SQL exclut déjà les tracées). */
  expiredDelegations: string[]
  /** Affectations dont `effective_from` est aujourd'hui. */
  activatedUsers: string[]
  /** Code d'erreur PostgreSQL à lever pour ce tenant (table absente, …). */
  failWith?: string
}

interface AuditWrite { schema: string; action: string; entityId: string }
let audits: AuditWrite[]

function mockTenants(tenants: Tenant[]): void {
  audits = []
  queryMock.mockReset()
  queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    const q = String(sql).replace(/\s+/g, ' ')
    if (q.includes('platform.tenants')) {
      return { rows: tenants.map((t) => ({ schema_name: t.schema })) }
    }
    const schema = /"([a-z0-9_]+)"/.exec(q)?.[1] ?? ''
    const t = tenants.find((x) => x.schema === schema)
    if (t?.failWith) throw Object.assign(new Error('boom'), { code: t.failWith })
    if (q.includes('INSERT INTO') && q.includes('audit_log')) {
      audits.push({ schema, action: String(params[1]), entityId: String(params[3]) })
      return { rows: [], rowCount: 1 }
    }
    if (q.includes('hab_delegations')) {
      return { rows: (t?.expiredDelegations ?? []).map((id) => ({ id })) }
    }
    if (q.includes('hab_assignments')) {
      return { rows: (t?.activatedUsers ?? []).map((id) => ({ user_id: id })) }
    }
    return { rows: [] }
  })
}

beforeEach(() => {
  loggerMock.info.mockReset()
  loggerMock.error.mockReset()
  loggerMock.warn.mockReset()
})

describe('processHabilitationsDailyJob', () => {
  it('trace les délégations échues du jour', async () => {
    mockTenants([{ schema: 'tenant_sotra', expiredDelegations: ['d-1', 'd-2'], activatedUsers: [] }])
    await processHabilitationsDailyJob(job())
    expect(audits.filter((a) => a.action === 'habilitation.delegation.expired').map((a) => a.entityId))
      .toEqual(['d-1', 'd-2'])
  })

  it('ne retrace pas une délégation déjà tracée (le SQL exclut les tracées)', async () => {
    mockTenants([{ schema: 'tenant_sotra', expiredDelegations: ['d-1'], activatedUsers: [] }])
    await processHabilitationsDailyJob(job())
    const sql = queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
      .find((s) => s.includes('hab_delegations') && s.includes('SELECT'))
    expect(sql).toContain('NOT EXISTS')
    expect(sql).toContain('habilitation.delegation.expired')
    expect(sql).toContain('revoked_at IS NULL')
  })

  it('trace les habilitations qui prennent effet aujourd\'hui', async () => {
    mockTenants([{ schema: 'tenant_sotra', expiredDelegations: [], activatedUsers: ['u-1'] }])
    await processHabilitationsDailyJob(job())
    expect(audits.filter((a) => a.action === 'habilitation.activated').map((a) => a.entityId)).toEqual(['u-1'])
    const sql = queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
      .find((s) => s.includes('hab_assignments') && s.includes('SELECT'))
    expect(sql).toContain('effective_from = CURRENT_DATE')
  })

  it('un tenant non migré (42P01) n\'interrompt pas les autres', async () => {
    mockTenants([
      { schema: 'tenant_vieux', expiredDelegations: [], activatedUsers: [], failWith: '42P01' },
      { schema: 'tenant_sotra', expiredDelegations: ['d-9'], activatedUsers: [] },
    ])
    await processHabilitationsDailyJob(job())
    expect(audits.map((a) => a.schema)).toEqual(['tenant_sotra'])
  })

  it('un nom de schéma non conforme est ignoré', async () => {
    mockTenants([{ schema: 'tenant_sotra; DROP', expiredDelegations: ['d-1'], activatedUsers: [] }])
    await processHabilitationsDailyJob(job())
    expect(audits).toEqual([])
    expect(loggerMock.warn).toHaveBeenCalled()
  })

  it('un échec global est journalisé, jamais propagé', async () => {
    queryMock.mockReset()
    queryMock.mockRejectedValue(new Error('redis/pg down'))
    await expect(processHabilitationsDailyJob(job())).resolves.toBeUndefined()
    expect(loggerMock.error).toHaveBeenCalled()
  })
})
