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
const JOB_ID = '22222222-2222-2222-2222-222222222222'
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

describe('GET /interview-sim/internal-jobs/:jobId/start', () => {
  it('401 sans token', async () => {
    const res = await app.inject({ method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start` })
    expect(res.statusCode).toBe(401)
  })

  it('400 si le compte n’est pas lié à un employé', async () => {
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start`,
      headers: { authorization: `Bearer ${tokenFor(null)}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si l’offre n’est pas interne-visible / éligible', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".employees')) return Promise.resolve({ rows: [{ id: 'emp-1', department_id: null, job_level: null, hire_date: null, legal_entity_id: null }] })
      if (s.includes('FROM "tenant_sotra".recruitment_jobs')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('200 : questions + catégories calibrées sur l’offre (repli banque)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".employees')) return Promise.resolve({ rows: [{ id: 'emp-1', department_id: null, job_level: null, hire_date: null, legal_entity_id: null }] })
      if (s.includes('FROM "tenant_sotra".recruitment_jobs')) return Promise.resolve({ rows: [{ title: 'Développeur', interview_focus: { technologies: [{ name: 'Java', yearsRequired: 5 }], tools: [], methodologies: [], languages: [] }, experience_level: '3_7_ans' }] })
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ sector: 'IT' }] })
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 4, public_token_ttl_minutes: 60, consent_text: null }] })
      if (s.includes('interview_sim_question_banks')) return Promise.resolve({ rows: [{ questions: ['Q1', 'Q2'], source_model: 'claude' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.jobTitle).toBe('Développeur')
    expect(Array.isArray(data.questions)).toBe(true)
    expect(data.langue).toBe('fr')
  })
})

describe('POST /interview-sim/internal-jobs/:jobId/submit — éphémère', () => {
  it('200 + retour, SANS écrire dans interview_sim_attempts', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".recruitment_jobs')) return Promise.resolve({ rows: [{ title: 'Développeur' }] })
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ sector: 'IT' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { langue: 'fr', questions: ['Q1'], categories: ['Java'], answers: [{ index: 0, question: 'Q1', transcript: 'ma réponse' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.retour).toBeTruthy()
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('interview_sim_attempts'))
    expect(insert).toBeFalsy() // ÉPHÉMÈRE : rien de personnel stocké
    const usage = queryMock.mock.calls.find((c) => String(c[0]).includes('platform.interview_sim_usage'))
    expect(usage).toBeTruthy() // compteur anonyme agrégé
  })

  it('400 si body invalide', async () => {
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { langue: 'fr', questions: [], answers: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si l’offre n’est pas interne-visible', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".recruitment_jobs')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { langue: 'fr', questions: ['Q1'], answers: [{ index: 0, question: 'Q1', transcript: 'r' }] },
    })
    expect(res.statusCode).toBe(404)
  })
})
