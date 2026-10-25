/**
 * COUVERTURE — chemins non couverts par ai.routes.test :
 *   - /status : IA indisponible (aucune clé) → message d'invitation à configurer ;
 *   - /chat : schema JWT invalide (A05) → 400 ;
 *   - /chat : aucune clé Claude (tenant ni plateforme) → 503 ;
 *   - /simulate-its : barème ITS 2024, RICF par parts, plafond 5 parts (gain nul).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, anthropicStreamMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  anthropicStreamMock: vi.fn(),
}))

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

// La garde centrale (plugin auth) rejette tout schema non conforme en 401 AVANT
// d'atteindre le handler. Pour exercer la défense en profondeur LOCALE du handler
// /chat (re-check du schema → 400), on neutralise ici la garde centrale afin de
// laisser passer un token au schema invalide jusqu'au handler.
vi.mock('../../utils/schema-name.js', () => ({
  SCHEMA_NAME_RE: /^[a-z][a-z0-9_]{0,62}$/,
  isValidSchemaName: vi.fn(() => true),
  assertValidSchemaName: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: anthropicStreamMock },
  })),
}))

// Par défaut : clé Claude présente (repli plateforme). Surchargée par test au besoin.
vi.mock('../../services/ai-credentials.service.js', () => ({
  resolveAiCreds: vi.fn().mockResolvedValue({
    claude:  { apiKey: 'sk-ant-test', model: 'claude-sonnet-4' },
    mistral: { apiKey: null,          model: 'mistral-large' },
    preferredProvider: 'claude',
  }),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import aiRoutes from './ai.routes.js'
import { resolveAiCreds } from '../../services/ai-credentials.service.js'

const TENANT = 'tenant_sotra'

function tokenFor(app: FastifyInstance, role: string, schemaName = TENANT) {
  return app.jwt.sign({
    sub: 'u-' + role,
    tenantId: 't1',
    schemaName,
    role,
    email: `${role}@sotra.ci`,
    firstName: 'Test',
    lastName: 'User',
    employeeId: null,
  })
}

const NO_CREDS = {
  claude:  { apiKey: null, model: 'claude-sonnet-4', source: null },
  mistral: { apiKey: null, model: 'mistral-large', source: null },
  preferredProvider: 'claude' as const,
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(aiRoutes, { prefix: '/ai' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  anthropicStreamMock.mockReset()
})

describe('GET /ai/status — IA indisponible', () => {
  it('renvoie available=false + message de configuration si aucune clé', async () => {
    vi.mocked(resolveAiCreds).mockResolvedValueOnce(NO_CREDS)
    const res = await app.inject({
      method: 'GET', url: '/ai/status',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.available).toBe(false)
    expect(body.message).toContain('non configurée')
  })
})

describe('POST /ai/chat — défenses schema + credentials', () => {
  it('400 si le schema JWT est invalide (OWASP A05)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ai/chat',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', 'Invalid Schema!')}` },
      payload: { messages: [{ role: 'user', content: 'Bonjour' }] },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Schema invalide')
  })

  it('503 si aucune clé Claude (ni tenant ni plateforme)', async () => {
    vi.mocked(resolveAiCreds).mockResolvedValueOnce(NO_CREDS)
    const res = await app.inject({
      method: 'POST', url: '/ai/chat',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { messages: [{ role: 'user', content: 'Bonjour' }] },
    })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toContain('IA non disponible')
  })
})

describe('POST /ai/simulate-its — ITS 2024 et RICF par parts', () => {
  it('marié 6 enfants (5 parts, plafond) : gain nul → message « plafond de 5 parts »', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ai/simulate-its',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { baseSalary: 1_500_000, maritalStatus: 'married', childrenCount: 6 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // 26 400 + 117 600 + 700 000 × 24 % = 312 000 ; RICF 5 parts = 44 000
    expect(body.its.brut).toBe(312_000)
    expect(body.its.parts).toBe(5)
    expect(body.its.credit).toBe(44_000)
    expect(body.its.net).toBe(268_000)
    expect(body.simulation.avecUnEnfantSupp.gain).toBe(0)
    expect(body.simulation.avecUnEnfantSupp.message).toContain('plafond de 5 parts')
  })

  it('marié 1 enfant : 2,5 parts → RICF 16 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ai/simulate-its',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { baseSalary: 1_000_000, maritalStatus: 'married', childrenCount: 1 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // base = 100 % du brut, sans abattement ni CNPS
    expect(body.its.base).toBe(1_000_000)
    expect(body.its.brut).toBe(192_000)    // 144 000 + 200 000 × 24 %
    expect(body.its.parts).toBe(2.5)
    expect(body.its.credit).toBe(16_500)
    expect(body.its.net).toBe(175_500)
  })

  it('célibataire 2 enfants : 1,5 + 2 × 0,5 = 2,5 parts → RICF 16 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ai/simulate-its',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { baseSalary: 1_000_000, maritalStatus: 'single', childrenCount: 2 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).its.credit).toBe(16_500)
  })

  it('célibataire 450 000 : ITS 70 500, +1 enfant → gain 11 000 (2 parts)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ai/simulate-its',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { baseSalary: 450_000, maritalStatus: 'single', childrenCount: 0 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.its.net).toBe(70_500)
    expect(body.simulation.avecUnEnfantSupp.gain).toBe(11_000)
    expect(body.simulation.avecUnEnfantSupp.message).toContain('le net augmenterait')
  })

  it('impôt déjà couvert par la RICF : message dédié', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ai/simulate-its',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { baseSalary: 100_000, maritalStatus: 'married', childrenCount: 1 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.its.net).toBe(0)           // 25 000 × 16 % = 4 000 ≤ 16 500
    expect(body.simulation.avecUnEnfantSupp.message).toContain('entièrement couvert')
  })
})
