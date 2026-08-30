/**
 * Golden — l'article 22 du RGPD traduit en test.
 *
 * Aucune candidature ne peut apparaître dans le pipeline tant qu'un humain n'a
 * pas tranché. C'est l'invariant central du pré-tri : le verdict machine
 * (`screening_verdict`) est une PROPOSITION ; seule `screening_decision`, posée
 * par une personne identifiée, fait entrer ou sortir du pipeline.
 *
 * Si ce test tombe, ce n'est pas un détail d'affichage : c'est que la décision
 * automatisée est redevenue une décision.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn().mockResolvedValue({ rows: [] }) }))
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
    claude: { apiKey: null, model: 'c' }, mistral: { apiKey: null, model: 'm' },
    preferredProvider: 'claude',
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

let app: FastifyInstance
const auth = () => ({
  authorization: `Bearer ${app.jwt.sign({
    sub: '33333333-3333-4333-8333-333333333333', jti: 'jti-1',
    tenantId: '44444444-4444-4444-8444-444444444444',
    schemaName: 'tenant_demo', role: 'hr_manager', email: 'rh@demo.ci',
    firstName: 'A', lastName: 'B', employeeId: null,
  })}`,
})

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockClear(); queryMock.mockResolvedValue({ rows: [] }) })

/** Le SQL de la première requête émise par le handler. */
const firstSql = () => String(queryMock.mock.calls[0]![0])

describe('Barrière du pré-tri', () => {
  it('le pipeline exclut les dossiers SANS décision humaine', async () => {
    const r = await app.inject({
      method: 'GET', url: '/recruitment/applications', headers: auth(),
    })
    expect(r.statusCode).toBe(200)
    expect(firstSql()).toMatch(/screening_decision IS NOT NULL/)
  })

  it('`?pending=true` renvoie au contraire UNIQUEMENT les dossiers en attente', async () => {
    await app.inject({
      method: 'GET', url: '/recruitment/applications?pending=true', headers: auth(),
    })
    expect(firstSql()).toMatch(/screening_decision IS NULL/)
    expect(firstSql()).not.toMatch(/screening_decision IS NOT NULL/)
  })

  it('la barrière s’applique aussi quand on filtre par offre ou par étape', async () => {
    await app.inject({
      method: 'GET',
      url: '/recruitment/applications?job_id=11111111-1111-4111-8111-111111111111&stage=new',
      headers: auth(),
    })
    const sql = firstSql()
    expect(sql).toMatch(/a\.job_id = \$/)
    expect(sql).toMatch(/a\.stage = \$/)
    expect(sql, 'la barrière ne doit pas sauter avec les filtres').toMatch(/screening_decision IS NOT NULL/)
  })

  it('aucune valeur fournie par le client ne peut désactiver la barrière', async () => {
    // `pending` n'est comparé qu'à la chaîne exacte 'true' : toute autre valeur
    // retombe sur le comportement fermé.
    for (const v of ['1', 'yes', 'TRUE', 'null', '']) {
      queryMock.mockClear()
      await app.inject({
        method: 'GET', url: `/recruitment/applications?pending=${v}`, headers: auth(),
      })
      expect(firstSql(), `pending=${v}`).toMatch(/screening_decision IS NOT NULL/)
    }
  })
})
