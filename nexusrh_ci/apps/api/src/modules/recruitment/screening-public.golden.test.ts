/**
 * Golden — dépôt public : les questions sont posées, les seuils jamais divulgués.
 *
 * Un candidat qui lirait `{ op: 'min', value: 5 }` saurait exactement quoi
 * répondre : l'endpoint public ne doit exposer que les libellés, les types et
 * les options. Le second invariant tient à la conformité : une réponse non
 * conforme SIGNALE le dossier, elle ne le rejette jamais — seul un humain
 * tranche (RGPD art. 22).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
    apiUrl: 'http://localhost:4001',
    ai: { apiKey: '', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))
vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/recruitment-ai.service.js', () => ({
  analyzeCV: vi.fn(), sourceProfiles: vi.fn(), sourceProfilesCompare: vi.fn(),
  isModelAvailable: vi.fn(() => false),
}))
vi.mock('../../services/ai-credentials.service.js', () => ({
  resolveAiCreds: vi.fn().mockResolvedValue({
    claude: { apiKey: null, model: 'claude-sonnet-4' },
    mistral: { apiKey: null, model: 'mistral-large' }, preferredProvider: 'claude',
  }),
}))
vi.mock('../../services/sourcing-countries.service.js', () => ({
  resolveSourcingCountries: vi.fn(async () => ({ countries: ['CI'], multiCountry: false, tenantCountry: 'CI' })),
}))
vi.mock('../../services/tenant-modules.service.js', () => ({
  getModulesForSchema: vi.fn().mockResolvedValue({}),
  resolveEnabledModules: vi.fn().mockResolvedValue({}),
}))

import authPlugin from '../../plugins/auth.js'
import recruitmentRoutes from './recruitment.routes.js'

const JOB = '11111111-1111-4111-8111-111111111111'
let app: FastifyInstance

/** Question éliminatoire : au moins 5 ans d'expérience. */
const QUESTIONS = [{
  id: 'q1', label: 'Années d’expérience en comptabilité', type: 'number',
  required: true, knockout: true, rule: { op: 'min', value: 5 },
}]

const TENANT = {
  schema_name: 'tenant_sotra', name: 'SOTRA', slug: 'sotra',
  primary_color: '#E85D04', secondary_color: '#F48C06', logo_url: null,
  city: 'Abidjan', sector: 'transport',
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('GET /public/:slug/jobs/:jobId', () => {
  it('expose les libellés des questions et JAMAIS les règles', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [TENANT] })
      .mockResolvedValueOnce({ rows: [{
        id: JOB, title: 'Comptable', location: 'Abidjan', contract_type: 'cdi',
        screening_questions: QUESTIONS,
      }] })
      .mockResolvedValue({ rows: [] })

    const r = await app.inject({ method: 'GET', url: `/recruitment/public/sotra/jobs/${JOB}` })
    expect(r.statusCode).toBe(200)

    const body = r.body
    expect(body, 'le libellé est visible').toContain('Années d’expérience')
    // Les seuils ne doivent apparaître nulle part dans la réponse.
    expect(body, 'la règle ne doit pas fuiter').not.toContain('"rule"')
    expect(body).not.toContain('"min"')
    expect(body).not.toContain('"knockout"')
    expect(body).not.toContain('screening_questions')
  })
})

describe('POST /public/:slug/jobs/:jobId/apply', () => {
  const primeDeposit = () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_sotra', name: 'SOTRA' }] })
      .mockResolvedValueOnce({ rows: [{ id: JOB, title: 'Comptable', screening_questions: QUESTIONS }] })
      .mockResolvedValueOnce({ rows: [] })                       // anti-doublon
      .mockResolvedValueOnce({ rows: [{ id: 'app-1' }] })         // INSERT
      .mockResolvedValue({ rows: [] })
  }

  it('une réponse non conforme SIGNALE le dossier, elle ne le rejette pas', async () => {
    primeDeposit()
    const r = await app.inject({
      method: 'POST', url: `/recruitment/public/sotra/jobs/${JOB}/apply`,
      payload: { first_name: 'Awa', last_name: 'Koné', email: 'awa@example.ci', answers: { q1: 2 } },
    })
    expect(r.statusCode).toBe(201)

    const insert = queryMock.mock.calls.find(c => /INSERT INTO .*applications/.test(String(c[0])))
    expect(insert, 'la candidature est bien créée').toBeDefined()
    const params = insert![1] as unknown[]
    expect(params, 'verdict signalé').toContain('flagged')
    // Le stage reste 'new' (littéral dans le SQL) : aucun rejet automatique.
    expect(String(insert![0])).toContain("'new'")
    expect(params).not.toContain('rejected')
  })

  it('une réponse conforme donne un verdict `pass`', async () => {
    primeDeposit()
    const r = await app.inject({
      method: 'POST', url: `/recruitment/public/sotra/jobs/${JOB}/apply`,
      payload: { first_name: 'Awa', last_name: 'Koné', email: 'awa2@example.ci', answers: { q1: 7 } },
    })
    expect(r.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find(c => /INSERT INTO .*applications/.test(String(c[0])))
    expect(insert![1] as unknown[]).toContain('pass')
  })

  it('une question obligatoire sans réponse est refusée en 400', async () => {
    primeDeposit()
    const r = await app.inject({
      method: 'POST', url: `/recruitment/public/sotra/jobs/${JOB}/apply`,
      payload: { first_name: 'Awa', last_name: 'Koné', email: 'awa3@example.ci', answers: {} },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/obligatoires/i)
    expect(r.json().details[0].message).toContain('Années d’expérience')
  })

  it('la candidature entre en file de revue, sans décision humaine', async () => {
    primeDeposit()
    await app.inject({
      method: 'POST', url: `/recruitment/public/sotra/jobs/${JOB}/apply`,
      payload: { first_name: 'Awa', last_name: 'Koné', email: 'awa4@example.ci', answers: { q1: 7 } },
    })
    const insert = queryMock.mock.calls.find(c => /INSERT INTO .*applications/.test(String(c[0])))
    // screening_decision n'est pas renseignée à l'insertion : elle reste NULL,
    // donc le dossier attend une décision humaine.
    expect(String(insert![0])).not.toContain('screening_decision')
  })
})
