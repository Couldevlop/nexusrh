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
import climateRoutes from './climate.routes.js'

const SCHEMA = 'tenant_sotra'
function tokenFor(app: FastifyInstance, role: string, employeeId: string | null = null) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(climateRoutes, { prefix: '/climate' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('OWASP A01 — gestion réservée RH', () => {
  it('refuse la création d\'enquête à un employee (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { title: 'X', questions: [{ label: 'Q', type: 'scale' }] },
    })
    expect(res.statusCode).toBe(403)
  })
  it('refuse la liste RH à un employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/climate/surveys',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(403)
  })
  it('autorise hr_manager à créer (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 's1' }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { title: 'Climat 2026', questions: [{ label: 'Satisfaction ?', type: 'scale' }] },
    })
    expect(res.statusCode).toBe(201)
  })
  it('refuse une enquête sans question (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { title: 'X', questions: [] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /climate/surveys/:id/results — anonymat (jamais employee_id)', () => {
  const QUESTIONS = [
    { key: 'sat', label: 'Sat', type: 'scale' },
    { key: 'libre', label: 'Commentaire', type: 'text' },
  ]
  const results = (role = 'hr_officer', qs = '') => app.inject({
    method: 'GET', url: `/climate/surveys/s1/results${qs}`,
    headers: { authorization: `Bearer ${tokenFor(app, role)}` },
  })

  it('n\'expose que des agrégats et ne sélectionne pas employee_id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ questions: QUESTIONS }] }) // survey
      .mockResolvedValueOnce({ rows: [{ climate_min_responses: 2 }] }) // seuil tenant
      .mockResolvedValueOnce({ rows: [{ n: 2 }] }) // COUNT
      .mockResolvedValueOnce({ rows: [{ answers: { sat: 5, libre: 'Top' } }, { answers: { sat: 3 } }] }) // responses
    const res = await results()
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { belowThreshold: boolean; responseCount: number; minResponses: number } }
    expect(body.data.belowThreshold).toBe(false)
    expect(body.data.responseCount).toBe(2)
    expect(body.data.minResponses).toBe(2)
    expect(res.body).not.toContain('employee_id')
    // aucune requête sur les réponses ne sélectionne employee_id
    for (const sql of queryMock.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('climate_responses'))) {
      expect(sql).not.toContain('employee_id')
    }
  })

  it('seuil par défaut (5) : sous le seuil, ni score ni commentaire', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ questions: QUESTIONS }] }) // survey
      .mockResolvedValueOnce({ rows: [{ climate_min_responses: null }] }) // tenant sans réglage
      .mockResolvedValueOnce({ rows: [{ n: 4 }] }) // COUNT
    const res = await results()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ data: { belowThreshold: true, responses: 4, minResponses: 5 } })
    // les réponses elles-mêmes ne sont même pas lues
    expect(queryMock).toHaveBeenCalledTimes(3)
  })

  it('seuil paramétré par le tenant (8) respecté', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ questions: QUESTIONS }] })
      .mockResolvedValueOnce({ rows: [{ climate_min_responses: 8 }] })
      .mockResolvedValueOnce({ rows: [{ n: 6 }] })
    const res = await results('readonly')
    expect(JSON.parse(res.body).data).toEqual({ belowThreshold: true, responses: 6, minResponses: 8 })
  })

  it('lecture du seuil impossible → défaut protecteur (5)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ questions: QUESTIONS }] })
      .mockRejectedValueOnce(new Error('column does not exist'))
      .mockResolvedValueOnce({ rows: [{ n: 3 }] })
    const res = await results()
    expect(JSON.parse(res.body).data).toEqual({ belowThreshold: true, responses: 3, minResponses: 5 })
  })

  it('ventilation par département : sous-groupes sous le seuil masqués, pas de texte libre', async () => {
    const rows = [
      ...Array.from({ length: 3 }, () => ({ answers: { sat: 4, libre: 'ok' }, group_key: 'd1', group_label: 'Exploitation' })),
      ...Array.from({ length: 2 }, () => ({ answers: { sat: 2 }, group_key: 'd2', group_label: 'Maintenance' })),
      { answers: { sat: 1 }, group_key: 'd3', group_label: 'Direction' },
    ]
    queryMock
      .mockResolvedValueOnce({ rows: [{ questions: QUESTIONS }] })
      .mockResolvedValueOnce({ rows: [{ climate_min_responses: 2 }] })
      .mockResolvedValueOnce({ rows: [{ n: 6 }] })
      .mockResolvedValueOnce({ rows: rows.map((r) => ({ answers: r.answers })) })
      .mockResolvedValueOnce({ rows })
    const res = await results('admin', '?groupBy=department')
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body).data as { groups: Array<{ key: string; questions: Array<{ type: string }> }>; hiddenGroups: number }
    // d3 (1 réponse) masqué ; suppression secondaire → d2 (le plus petit visible) masqué aussi
    expect(d.groups.map((g) => g.key)).toEqual(['d1'])
    expect(d.hiddenGroups).toBe(2)
    expect(d.groups[0]!.questions.every((q) => q.type !== 'text')).toBe(true)
  })

  it('ventilation inconnue → 400', async () => {
    const res = await results('admin', '?groupBy=employee')
    expect(res.statusCode).toBe(400)
  })
})

describe('réponse self-service', () => {
  it('refuse une réponse à une enquête non ouverte (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'draft' }] }) // survey status
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys/s1/responses',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', 'emp-1')}` },
      payload: { answers: { sat: 4 } },
    })
    expect(res.statusCode).toBe(409)
  })
  it('refuse une 2e réponse du même salarié (409, anti-doublon)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] }) // survey open
      .mockResolvedValueOnce({ rows: [] }) // INSERT ON CONFLICT DO NOTHING → 0 rows
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys/s1/responses',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', 'emp-1')}` },
      payload: { answers: { sat: 4 } },
    })
    expect(res.statusCode).toBe(409)
  })
  it('enregistre une réponse valide (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] }) // survey open
      .mockResolvedValueOnce({ rows: [{ id: 'r1' }] }) // INSERT ok
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys/s1/responses',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', 'emp-1')}` },
      payload: { answers: { sat: 4, libre: 'RAS' } },
    })
    expect(res.statusCode).toBe(201)
  })
})
