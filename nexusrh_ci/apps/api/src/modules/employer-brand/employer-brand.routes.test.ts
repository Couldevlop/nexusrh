import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, recruitmentMigrationMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  recruitmentMigrationMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: recruitmentMigrationMock,
}))

import authPlugin from '../../plugins/auth.js'
import employerBrandRoutes from './employer-brand.routes.js'

const SCHEMA = 'tenant_sotra'
function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}

/** Réponses DB selon le contenu de la requête (indépendant de l'ordre d'appel). */
function routeQueries(): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('GROUP BY a.source')) {
      return { rows: [{ source: 'careers_page', n: 6 }, { source: 'internal', n: 2 }, { source: null, n: 1 }, { source: 'linkedin', n: 1 }] }
    }
    if (sql.includes('GROUP BY rj.id, rj.title')) {
      return { rows: [{ id: 'j1', title: 'Chauffeur', n: 7, internal: 2 }] }
    }
    if (sql.includes('AS filled_at')) return { rows: [{ days: '10' }, { days: '20' }, { days: '60' }] }
    if (sql.includes('GROUP BY a.stage')) return { rows: [{ stage: 'new', n: 4 }, { stage: 'hired', n: 1 }] }
    if (sql.includes('retained_3m')) {
      return { rows: [{ hires: 4, eligible_3m: 4, retained_3m: 3, eligible_12m: 2, retained_12m: 1, departures: 3, early_departures: 1 }] }
    }
    if (sql.includes('offboarding_cases')) return { rows: [{ departure_type: 'demission', n: 2 }] }
    if (sql.includes('legal_entities')) return { rows: [{ id: 'le1', name: 'SOTRA Abidjan' }] }
    return { rows: [] }
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employerBrandRoutes, { prefix: '/employer-brand' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

const get = (role: string, qs = '') => app.inject({
  method: 'GET', url: `/employer-brand/overview${qs}`,
  headers: { authorization: `Bearer ${tokenFor(app, role)}` },
})

describe('OWASP A01 — RBAC marque employeur', () => {
  it('401 sans token', async () => {
    const res = await app.inject({ method: 'GET', url: '/employer-brand/overview' })
    expect(res.statusCode).toBe(401)
  })
  for (const role of ['employee', 'manager', 'hr_officer', 'raf_site']) {
    it(`403 pour ${role}`, async () => {
      const res = await get(role)
      expect(res.statusCode).toBe(403)
      expect(queryMock).not.toHaveBeenCalled()
    })
  }
  for (const role of ['admin', 'hr_manager', 'dg', 'readonly']) {
    it(`200 pour ${role}`, async () => {
      const res = await get(role)
      expect(res.statusCode).toBe(200)
    })
  }
})

describe('GET /employer-brand/overview — agrégats', () => {
  it('calcule sources, taux interne, délai de pourvoi, pipeline, rétention', async () => {
    routeQueries()
    const res = await get('admin', '?from=2026-01-01&to=2026-06-30')
    expect(res.statusCode).toBe(200)
    interface Overview {
      period: { from: string; to: string }
      legalEntities: Array<{ id: string; name: string }>
      attractiveness: {
        totalApplications: number; internalRate: number | null
        bySource: Array<{ source: string; count: number }>
        byJob: Array<{ jobId: string; title: string; applications: number; internal: number }>
      }
      timeToFill: { filledJobs: number; medianDays: number | null; averageDays: number | null }
      pipeline: { total: number }
      retention: { retention3m: { rate: number | null }; earlyDepartures: number }
      departureTypes: Array<{ type: string; count: number }>
    }
    const d = (JSON.parse(res.body) as { data: Overview }).data
    expect(d.period).toEqual({ from: '2026-01-01', to: '2026-06-30' })
    expect(d.attractiveness.totalApplications).toBe(10)
    expect(d.attractiveness.internalRate).toBe(20)
    expect(d.attractiveness.bySource.find((x) => x.source === 'other')?.count).toBe(1)
    expect(d.attractiveness.byJob[0]).toEqual({ jobId: 'j1', title: 'Chauffeur', applications: 7, internal: 2 })
    expect(d.timeToFill).toEqual({ filledJobs: 3, medianDays: 20, averageDays: 30 })
    expect(d.pipeline.total).toBe(5)
    expect(d.retention.retention3m.rate).toBe(75)
    expect(d.retention.earlyDepartures).toBe(1)
    expect(d.departureTypes.find((x) => x.type === 'demission')?.count).toBe(2)
    expect(d.legalEntities).toEqual([{ id: 'le1', name: 'SOTRA Abidjan' }])
  })

  it('ne restitue aucune donnée nominative (ni nom, ni email de candidat)', async () => {
    routeQueries()
    await get('dg')
    for (const [sql] of queryMock.mock.calls as Array<[string]>) {
      expect(sql).not.toMatch(/first_name|last_name|email|phone/)
    }
  })

  it('isolation tenant : toutes les requêtes ciblent le schéma du JWT, paramètres liés', async () => {
    routeQueries()
    const le = '11111111-1111-4111-8111-111111111111'
    await get('hr_manager', `?legalEntityId=${le}`)
    const calls = queryMock.mock.calls as Array<[string, unknown[]?]>
    for (const [sql] of calls) expect(sql).toContain(`"${SCHEMA}".`)
    const filtered = calls.filter(([sql]) => sql.includes('$3::uuid'))
    expect(filtered.length).toBeGreaterThanOrEqual(5)
    for (const [, params] of filtered) expect(params?.[2]).toBe(le)
  })

  it('fail-soft : une table absente renvoie des zéros (200, pas 500)', async () => {
    queryMock.mockRejectedValue(new Error('relation does not exist'))
    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    const d = (JSON.parse(res.body) as { data: { attractiveness: { totalApplications: number }; timeToFill: { medianDays: number | null }; retention: { hires: number } } }).data
    expect(d.attractiveness.totalApplications).toBe(0)
    expect(d.timeToFill.medianDays).toBeNull()
    expect(d.retention.hires).toBe(0)
  })

  it('OWASP A03 : période et filiale invalides → 400 sans requête', async () => {
    for (const qs of ['?from=2026-13-01', '?from=2026-06-01&to=2026-01-01', '?legalEntityId=1%20OR%201=1']) {
      const res = await get('admin', qs)
      expect(res.statusCode).toBe(400)
    }
    expect(queryMock).not.toHaveBeenCalled()
  })
})
