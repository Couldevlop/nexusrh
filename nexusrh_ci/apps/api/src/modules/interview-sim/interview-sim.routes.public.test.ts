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
vi.mock('../../services/tenant-modules.service.js', () => ({
  getModulesForSchema: vi.fn().mockResolvedValue({ interview_sim: true }),
}))

import authPlugin from '../../plugins/auth.js'
import interviewSimRoutes, { mintPublicInterviewToken } from './interview-sim.routes.js'

const SCHEMA = 'tenant_sotra'
let app: FastifyInstance

beforeAll(async () => {
  // maxParamLength : le jeton public (JWT) dépasse la limite par défaut de
  // find-my-way (100 car.) — cf. app.ts pour la même config en production.
  app = Fastify({ maxParamLength: 1000 })
  await app.register(authPlugin)
  await app.register(interviewSimRoutes, { prefix: '/interview-sim' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

function validToken(ttl = 60) {
  return mintPublicInterviewToken(app as unknown as FastifyInstance,
    { schema: SCHEMA, tenantSlug: 'sotra', jobId: 'job-1', title: 'Comptable', secteur: 'Finance', langue: 'fr' }, ttl)
}

describe('GET /interview-sim/public/:token', () => {
  it('401 si le jeton est invalide', async () => {
    const res = await app.inject({ method: 'GET', url: '/interview-sim/public/not-a-token' })
    expect(res.statusCode).toBe(401)
  })
  it('410 si le jeton est expiré', async () => {
    const expired = mintPublicInterviewToken(app as unknown as FastifyInstance,
      { schema: SCHEMA, tenantSlug: 'sotra', jobId: 'job-1', title: 'Comptable', secteur: 'Finance', langue: 'fr' }, -1)
    const res = await app.inject({ method: 'GET', url: `/interview-sim/public/${expired}` })
    expect(res.statusCode).toBe(410)
  })
  it('200 : questions + texte de consentement', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 4, public_token_ttl_minutes: 60, consent_text: 'Je consens.' }] })
      if (s.includes('interview_sim_question_banks')) return Promise.resolve({ rows: [{ questions: ['Q1', 'Q2'], source_model: null }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({ method: 'GET', url: `/interview-sim/public/${validToken()}` })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.questions).toEqual(['Q1', 'Q2'])
    expect(data.consentText).toBe('Je consens.')
    expect(data.jobTitle).toBe('Comptable')
  })
})

describe('POST /interview-sim/public/:token/submit', () => {
  it('400 sans consentement', async () => {
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/public/${validToken()}/submit`,
      payload: { consentAccepted: false, answers: [{ index: 0, question: 'Q1', transcript: 'r' }], questions: ['Q1'] },
    })
    expect(res.statusCode).toBe(400)
  })
  it('200 éphémère : retour rendu, AUCUNE écriture de donnée personnelle', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/public/${validToken()}/submit`,
      payload: { consentAccepted: true, consentAt: new Date().toISOString(), answers: [{ index: 0, question: 'Q1', transcript: 'ma réponse' }], questions: ['Q1'] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.retour).toBeTruthy()
    // Éphémère : aucun INSERT/UPDATE de tentative, applications, employees, etc.
    const wrote = queryMock.mock.calls.some((c) => {
      const s = String(c[0]).toLowerCase()
      return (s.includes('insert into') || s.includes('update ')) && !s.includes('interview_sim_usage')
    })
    expect(wrote).toBe(false)
  })
})
