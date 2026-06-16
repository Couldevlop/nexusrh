import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
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

import authPlugin from '../../plugins/auth.js'
import competenciesRoutes from './competencies.routes.js'

const SCHEMA = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'
function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(competenciesRoutes, { prefix: '/competencies' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('OWASP A01 — RBAC', () => {
  it('refuse employee en lecture catalogue (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/competencies/catalog', headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('autorise manager en lecture (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/competencies/catalog', headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` } })
    expect(res.statusCode).toBe(200)
  })
  it('refuse la création à readonly (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/competencies/catalog',
      headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` },
      payload: { label: 'Excel' },
    })
    expect(res.statusCode).toBe(403)
  })
  it('refuse la suppression d\'un poste à hr_officer (403)', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/competencies/job-profiles/${UUID_A}`, headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` } })
    expect(res.statusCode).toBe(403)
  })
})

describe('compétences (Bloom 1–6)', () => {
  it('crée une compétence et borne le niveau Bloom (clamp)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'c1' }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/competencies/catalog',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { label: 'Analyse de données', bloomLevel: 4 },
    })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls[0]
    expect(insert?.[1]).toContain(4) // bloom_level clampé/transmis
  })
  it('refuse un bloomLevel hors bornes (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/competencies/catalog',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { label: 'X', bloomLevel: 9 },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('fiches de poste + comparateur', () => {
  it('crée une fiche de poste (201 + audit)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'p1' }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/competencies/job-profiles',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { title: 'Contrôleur de gestion', mission: 'Piloter' },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('job_profile.created')
  })

  it('compare deux postes via leurs compétences requises (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ competency_id: 'c1', label: 'Excel', required_level: 3 }] }) // reqA
      .mockResolvedValueOnce({ rows: [{ competency_id: 'c1', label: 'Excel', required_level: 5 }] }) // reqB
    const res = await app.inject({
      method: 'GET', url: `/competencies/compare?a=${UUID_A}&b=${UUID_B}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { rows: Array<{ diff: number | null }> } }
    expect(body.data.rows[0]?.diff).toBe(2)
  })

  it('compare refuse des UUID invalides (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/competencies/compare?a=x&b=y',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(400)
  })
})
