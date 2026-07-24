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
vi.mock('../../services/ai-credentials.service.js', () => ({ resolveAiCreds: vi.fn() }))
vi.mock('../../services/tenant-modules.service.js', () => ({ getModulesForSchema: vi.fn() }))

import authPlugin from '../../plugins/auth.js'
import interviewSimRoutes from './interview-sim.routes.js'

const SCHEMA = 'tenant_sotra'
let app: FastifyInstance
function token(role: string) {
  return app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: SCHEMA, role, email: 'a@sotra.ci', firstName: 'A', lastName: 'B', employeeId: null })
}
beforeAll(async () => {
  app = Fastify(); await app.register(authPlugin)
  await app.register(interviewSimRoutes, { prefix: '/interview-sim' }); await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('config RBAC', () => {
  it('403 pour un employee', async () => {
    const res = await app.inject({ method: 'GET', url: '/interview-sim/config', headers: { authorization: `Bearer ${token('employee')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('200 pour admin', async () => {
    queryMock.mockResolvedValue({ rows: [{ default_langue: 'fr', questions_count: 5, public_token_ttl_minutes: 60, consent_text: null, consent_retention_months: 36 }] })
    const res = await app.inject({ method: 'GET', url: '/interview-sim/config', headers: { authorization: `Bearer ${token('admin')}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.questions_count).toBe(5)
    expect(res.json().data.consent_retention_months).toBe(36)
  })
})

describe('PUT config', () => {
  it('upsert singleton avec valeurs bornées', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'PUT', url: '/interview-sim/config',
      headers: { authorization: `Bearer ${token('hr_manager')}` },
      payload: { defaultLangue: 'en', questionsCount: 8, publicTokenTtlMinutes: 120, consentText: 'Consent EN', consentRetentionMonths: 24 },
    })
    expect(res.statusCode).toBe(200)
    const up = queryMock.mock.calls.find((c) => String(c[0]).includes('interview_sim_config') && String(c[0]).includes('ON CONFLICT'))
    expect(up).toBeTruthy()
    expect(up?.[1]).toContain(24)
  })
  it('400 si questionsCount hors bornes', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/interview-sim/config',
      headers: { authorization: `Bearer ${token('admin')}` },
      payload: { defaultLangue: 'fr', questionsCount: 99, publicTokenTtlMinutes: 60, consentText: '', consentRetentionMonths: 36 },
    })
    expect(res.statusCode).toBe(400)
  })
  it('400 si consentRetentionMonths = 0 (sous la borne min)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/interview-sim/config',
      headers: { authorization: `Bearer ${token('admin')}` },
      payload: { defaultLangue: 'fr', questionsCount: 5, publicTokenTtlMinutes: 60, consentText: '', consentRetentionMonths: 0 },
    })
    expect(res.statusCode).toBe(400)
  })
  it('400 si consentRetentionMonths = 121 (au-dessus de la borne max)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/interview-sim/config',
      headers: { authorization: `Bearer ${token('admin')}` },
      payload: { defaultLangue: 'fr', questionsCount: 5, publicTokenTtlMinutes: 60, consentText: '', consentRetentionMonths: 121 },
    })
    expect(res.statusCode).toBe(400)
  })
  it('400 si consentRetentionMonths non entier', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/interview-sim/config',
      headers: { authorization: `Bearer ${token('admin')}` },
      payload: { defaultLangue: 'fr', questionsCount: 5, publicTokenTtlMinutes: 60, consentText: '', consentRetentionMonths: 12.5 },
    })
    expect(res.statusCode).toBe(400)
  })
  it('accepte les bornes 1 et 120', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    for (const months of [1, 120]) {
      const res = await app.inject({
        method: 'PUT', url: '/interview-sim/config',
        headers: { authorization: `Bearer ${token('admin')}` },
        payload: { defaultLangue: 'fr', questionsCount: 5, publicTokenTtlMinutes: 60, consentText: '', consentRetentionMonths: months },
      })
      expect(res.statusCode).toBe(200)
    }
  })
})
