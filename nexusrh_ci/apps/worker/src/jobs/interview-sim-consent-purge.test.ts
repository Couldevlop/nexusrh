import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))

import { processInterviewSimConsentPurgeJob, clampRetentionMonths } from './interview-sim-consent-purge.js'

function jobFor(): Job<unknown, void> {
  return { id: 'job-1', data: {} } as unknown as Job<unknown, void>
}

const DAY_MS = 24 * 3600 * 1000

/** Approximation mois → jours cohérente avec l'intervalle PostgreSQL (`interval '1 month'`). */
function monthsAgo(months: number): Date {
  return new Date(Date.now() - months * 30.44 * DAY_MS)
}

interface TenantFixture {
  schema: string
  retentionMonths: number | undefined // undefined = pas de ligne de config (repli 36)
  consents: Array<{ acceptedAt: Date }>
}

/**
 * Dispatcher pg minimal : identifie chaque requête par schéma (interpolé dans
 * le texte SQL) + type de requête (SELECT config / DELETE consents), et
 * applique la MÊME logique de seuil que le job (accepted_at < now() - N mois)
 * pour calculer combien de lignes de la fixture seraient réellement supprimées
 * — preuve que le mois transmis en paramètre est le bon.
 */
function makeQueryMock(tenants: TenantFixture[]) {
  return vi.fn((sql: unknown, params?: unknown[]) => {
    const s = String(sql)
    const p = params ?? []

    if (s.includes('platform.tenants')) {
      return Promise.resolve({ rows: tenants.map((t) => ({ schema_name: t.schema })) })
    }

    const tenant = tenants.find((t) => s.includes(`"${t.schema}"`))
    if (!tenant) return Promise.resolve({ rows: [] })

    if (s.includes('interview_sim_config')) {
      return Promise.resolve({
        rows: tenant.retentionMonths === undefined ? [] : [{ consent_retention_months: tenant.retentionMonths }],
      })
    }
    if (s.includes('DELETE FROM') && s.includes('interview_sim_consents')) {
      const months = Number(p[0])
      const cutoff = monthsAgo(months)
      const deleted = tenant.consents.filter((c) => c.acceptedAt < cutoff).length
      return Promise.resolve({ rowCount: deleted })
    }
    return Promise.resolve({ rows: [] })
  })
}

beforeEach(() => {
  queryMock.mockReset()
  loggerMock.info.mockReset()
  loggerMock.error.mockReset()
  loggerMock.warn.mockReset()
})

describe('clampRetentionMonths', () => {
  it('repli 36 si non-fini/absent', () => {
    expect(clampRetentionMonths(undefined)).toBe(36)
    expect(clampRetentionMonths(NaN)).toBe(36)
    expect(clampRetentionMonths('abc')).toBe(36)
  })
  it('borne min 1, max 120', () => {
    expect(clampRetentionMonths(0)).toBe(1)
    expect(clampRetentionMonths(-5)).toBe(1)
    expect(clampRetentionMonths(121)).toBe(120)
    expect(clampRetentionMonths(999)).toBe(120)
  })
  it('tronque un flottant', () => {
    expect(clampRetentionMonths(12.9)).toBe(12)
  })
  it('valeur valide inchangée', () => {
    expect(clampRetentionMonths(24)).toBe(24)
  })
})

describe('processInterviewSimConsentPurgeJob', () => {
  it('supprime les traces au-delà de la rétention et conserve celles en deçà (rétention explicite)', async () => {
    const tenants: TenantFixture[] = [{
      schema: 'tenant_sotra',
      retentionMonths: 12,
      consents: [
        { acceptedAt: monthsAgo(13) }, // au-delà de 12 mois → supprimée
        { acceptedAt: monthsAgo(1) },  // en deçà de 12 mois → conservée
      ],
    }]
    queryMock.mockImplementation(makeQueryMock(tenants))

    await processInterviewSimConsentPurgeJob(jobFor())

    const del = queryMock.mock.calls.find((c) => String(c[0]).includes('DELETE FROM') && String(c[0]).includes('interview_sim_consents'))
    expect(del).toBeDefined()
    expect((del![1] as unknown[])[0]).toBe(12)
    // Requête paramétrée (jamais d'interpolation de la valeur numérique dans le texte SQL).
    expect(String(del![0])).toContain('$1')
    expect(String(del![0])).not.toContain('12 months')

    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ schema: 'tenant_sotra', months: 12, deleted: 1 }),
      expect.any(String),
    )
  })

  it('repli 36 mois quand la config est absente pour un tenant', async () => {
    const tenants: TenantFixture[] = [{
      schema: 'tenant_cabinet',
      retentionMonths: undefined,
      consents: [
        { acceptedAt: monthsAgo(40) }, // au-delà de 36 → supprimée
        { acceptedAt: monthsAgo(10) }, // en deçà de 36 → conservée
      ],
    }]
    queryMock.mockImplementation(makeQueryMock(tenants))

    await processInterviewSimConsentPurgeJob(jobFor())

    const del = queryMock.mock.calls.find((c) => String(c[0]).includes('DELETE FROM') && String(c[0]).includes('interview_sim_consents'))
    expect((del![1] as unknown[])[0]).toBe(36)
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ schema: 'tenant_cabinet', months: 36, deleted: 1 }),
      expect.any(String),
    )
  })

  it('isolation par schéma : chaque tenant purgé avec SA propre rétention, requêtes distinctes', async () => {
    const tenants: TenantFixture[] = [
      { schema: 'tenant_a', retentionMonths: 6, consents: [{ acceptedAt: monthsAgo(7) }] },
      { schema: 'tenant_b', retentionMonths: 48, consents: [{ acceptedAt: monthsAgo(7) }] }, // conservée pour B (< 48 mois)
    ]
    queryMock.mockImplementation(makeQueryMock(tenants))

    await processInterviewSimConsentPurgeJob(jobFor())

    const deletes = queryMock.mock.calls.filter((c) => String(c[0]).includes('DELETE FROM') && String(c[0]).includes('interview_sim_consents'))
    expect(deletes).toHaveLength(2)
    const byMonths = deletes.map((c) => (c[1] as unknown[])[0] as number)
    expect(byMonths.sort((a, b) => a - b)).toEqual([6, 48])

    const infoLogs = loggerMock.info.mock.calls.filter((c) => (c[0] as { schema?: string }).schema)
    const a = infoLogs.find((c) => (c[0] as { schema?: string }).schema === 'tenant_a')
    const b = infoLogs.find((c) => (c[0] as { schema?: string }).schema === 'tenant_b')
    expect((a![0] as { deleted: number }).deleted).toBe(1)
    expect((b![0] as { deleted: number }).deleted).toBe(0)
  })

  it('schéma invalide → ignoré sans requête sur ce schéma', async () => {
    queryMock.mockImplementation((sql: unknown) => {
      const s = String(sql)
      if (s.includes('platform.tenants')) return Promise.resolve({ rows: [{ schema_name: 'BAD SCHEMA; DROP TABLE x;' }] })
      return Promise.resolve({ rows: [] })
    })

    await processInterviewSimConsentPurgeJob(jobFor())

    expect(loggerMock.warn).toHaveBeenCalled()
    const del = queryMock.mock.calls.find((c) => String(c[0]).includes('DELETE FROM'))
    expect(del).toBeUndefined()
  })

  it('journalise le compte SEULEMENT — aucune donnée personnelle (employee_id/consent_text/session_id)', async () => {
    const tenants: TenantFixture[] = [{
      schema: 'tenant_sotra',
      retentionMonths: 12,
      consents: [{ acceptedAt: monthsAgo(13) }],
    }]
    queryMock.mockImplementation(makeQueryMock(tenants))

    await processInterviewSimConsentPurgeJob(jobFor())

    for (const call of loggerMock.info.mock.calls) {
      const payload = call[0] as Record<string, unknown>
      expect(payload).not.toHaveProperty('employee_id')
      expect(payload).not.toHaveProperty('consent_text')
      expect(payload).not.toHaveProperty('session_id')
    }
  })

  it('isolation des pannes : un tenant en échec n\'empêche pas la purge des autres', async () => {
    queryMock.mockImplementation((sql: unknown, params?: unknown[]) => {
      const s = String(sql)
      if (s.includes('platform.tenants')) {
        return Promise.resolve({ rows: [{ schema_name: 'tenant_broken' }, { schema_name: 'tenant_ok' }] })
      }
      if (s.includes('tenant_broken') && s.includes('interview_sim_config')) {
        return Promise.reject(new Error('connexion DB perdue'))
      }
      if (s.includes('tenant_broken') && s.includes('DELETE FROM')) {
        return Promise.reject(new Error('ne devrait jamais être appelée : la lecture de la config a déjà échoué (erreur non liée à une table/colonne absente, donc non absorbée)'))
      }
      if (s.includes('tenant_ok') && s.includes('interview_sim_config')) {
        return Promise.resolve({ rows: [{ consent_retention_months: 36 }] })
      }
      if (s.includes('tenant_ok') && s.includes('DELETE FROM')) {
        return Promise.resolve({ rowCount: 3 })
      }
      return Promise.resolve({ rows: [] })
    })

    await expect(processInterviewSimConsentPurgeJob(jobFor())).resolves.toBeUndefined()

    expect(loggerMock.error).toHaveBeenCalled()
    const brokenDelete = queryMock.mock.calls.find((c) => String(c[0]).includes('tenant_broken') && String(c[0]).includes('DELETE FROM'))
    expect(brokenDelete).toBeUndefined()
    const okLog = loggerMock.info.mock.calls.find((c) => (c[0] as { schema?: string }).schema === 'tenant_ok')
    expect((okLog![0] as { deleted: number }).deleted).toBe(3)
  })
})
