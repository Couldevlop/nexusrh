import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../db/pool.js', () => ({ pool: { query: queryMock } }))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/redis.js', () => ({
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('../../config.js', () => ({
  config: {
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    ai: { apiKey: null, model: 'claude-sonnet-4', maxTokens: 2048 },
    mistral: { apiKey: null, model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))
vi.mock('../../services/ai-credentials.service.js', () => ({
  resolveAiCreds: vi.fn().mockResolvedValue({
    claude: { apiKey: null, model: 'claude-sonnet-4', source: null },
    mistral: { apiKey: null, model: 'mistral-large', source: null },
    preferredProvider: 'claude',
  }),
}))

import authPlugin from '../../plugins/auth.js'
import interviewSimRoutes from './interview-sim.routes.js'

const SCHEMA = 'tenant_sotra'
let app: FastifyInstance

function tokenFor(employeeId: string | null, role = 'employee') {
  return app.jwt.sign({
    sub: 'u-1', tenantId: 't1', schemaName: SCHEMA, role,
    email: 'e@sotra.ci', firstName: 'E', lastName: 'M', employeeId,
  })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(interviewSimRoutes, { prefix: '/interview-sim' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('GET /interview-sim/start', () => {
  it('401 sans token', async () => {
    const res = await app.inject({ method: 'GET', url: '/interview-sim/start' })
    expect(res.statusCode).toBe(401)
  })
  it('400 si le compte n’est pas lié à un employé', async () => {
    const res = await app.inject({
      method: 'GET', url: '/interview-sim/start',
      headers: { authorization: `Bearer ${tokenFor(null)}` },
    })
    expect(res.statusCode).toBe(400)
  })
  it('200 : contexte poste + questions (repli banque, IA absente)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".employees')) return Promise.resolve({ rows: [{ job_title: 'Comptable', professional_category: 'Cadre' }] })
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ sector: 'Finance' }] })
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 4, public_token_ttl_minutes: 60, consent_text: null }] })
      if (s.includes('interview_sim_question_banks')) return Promise.resolve({ rows: [{ questions: ['Q1', 'Q2'], source_model: 'claude' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'GET', url: '/interview-sim/start',
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.questions).toEqual(['Q1', 'Q2'])
    expect(data.roleKey).toBe('comptable-finance')
    expect(data.langue).toBe('fr')
  })
})

describe('POST /interview-sim/attempts/submit', () => {
  it('enregistre dans l’historique du salarié (employee_id du JWT)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('INSERT INTO "tenant_sotra".interview_sim_attempts')) return Promise.resolve({ rows: [{ id: 'att-1' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: '/interview-sim/attempts/submit',
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { roleKey: 'comptable', langue: 'fr', questions: ['Q1'], answers: [{ index: 0, question: 'Q1', transcript: 'ma réponse' }] },
    })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO "tenant_sotra".interview_sim_attempts'))
    expect(insert).toBeTruthy()
    expect((insert![1] as unknown[])[0]).toBe('emp-1') // employee_id = JWT, jamais body
  })

  it('normalise le roleKey client (non normalisé) avant stockage ET incrémentation du compteur partagé', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('INSERT INTO "tenant_sotra".interview_sim_attempts')) return Promise.resolve({ rows: [{ id: 'att-2' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: '/interview-sim/attempts/submit',
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { roleKey: "  Comptable Épargne !! ", langue: 'fr', questions: ['Q1'], answers: [{ index: 0, question: 'Q1', transcript: 'ma réponse' }] },
    })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO "tenant_sotra".interview_sim_attempts'))
    expect(insert).toBeTruthy()
    expect((insert![1] as unknown[])[1]).toBe('comptable-epargne') // role_key normalisé, pas la valeur brute du client
    const usage = queryMock.mock.calls.find((c) => String(c[0]).includes('platform.interview_sim_usage'))
    expect(usage).toBeTruthy()
    expect((usage![1] as unknown[])[0]).toBe('comptable-epargne')
  })
})

describe('GET /interview-sim/my-attempts/:id — isolation (IDOR)', () => {
  it('ne lit que les tentatives du salarié : WHERE employee_id du JWT', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".interview_sim_attempts') && s.includes('WHERE')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'GET', url: '/interview-sim/my-attempts/att-999',
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(404)
    const sel = queryMock.mock.calls.find((c) => String(c[0]).includes('interview_sim_attempts') && String(c[0]).includes('WHERE'))
    expect(String(sel![0])).toContain('employee_id = $2')
    expect((sel![1] as unknown[])[1]).toBe('emp-1')
  })
})

describe('DELETE /interview-sim/my-attempts/:id — droit à l’effacement', () => {
  it('supprime en scoping employee_id du JWT', async () => {
    queryMock.mockResolvedValue({ rowCount: 1, rows: [] })
    const res = await app.inject({
      method: 'DELETE', url: '/interview-sim/my-attempts/att-1',
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(200)
    const del = queryMock.mock.calls.find((c) => String(c[0]).includes('DELETE FROM "tenant_sotra".interview_sim_attempts'))
    expect(String(del![0])).toContain('employee_id = $2')
  })
})
