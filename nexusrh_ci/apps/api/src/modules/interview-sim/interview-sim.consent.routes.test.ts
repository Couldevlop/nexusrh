/**
 * Consentement RGPD explicite (art. 7-1) — routes + blocage serveur.
 *
 * Bloc INTERNE : POST /interview-sim/internal-jobs/:jobId/consent enregistre
 * une trace `scope='internal'` avec employee_id ISSU DU JWT (jamais du body).
 * Bloc PUBLIC : POST /public/interview-sim/:token/consent enregistre une
 * trace `scope='public'` STRICTEMENT ANONYME — employee_id NULL, aucune IP.
 * `GET .../start` (interne) et `POST .../submit` (public) refusent ensuite
 * (403) toute tentative sans `sessionId` correspondant à une trace valide.
 */
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
import interviewSimRoutes, { interviewSimPublicRoutes, mintPublicInterviewToken } from './interview-sim.routes.js'

const SCHEMA = 'tenant_sotra'
const JOB_ID = '22222222-2222-2222-2222-222222222222'
const SESSION_ID = '33333333-3333-3333-3333-333333333333'
let app: FastifyInstance

function tokenFor(employeeId: string | null, role = 'employee') {
  return app.jwt.sign({
    sub: 'u-1', tenantId: 't1', schemaName: SCHEMA, role,
    email: 'e@sotra.ci', firstName: 'E', lastName: 'M', employeeId,
  })
}

function validPublicToken(jobId = JOB_ID) {
  return mintPublicInterviewToken(app as unknown as FastifyInstance,
    { schema: SCHEMA, tenantSlug: 'sotra', jobId, title: 'Comptable', secteur: 'Finance', langue: 'fr' }, 60)
}

beforeAll(async () => {
  app = Fastify({ maxParamLength: 1000 })
  await app.register(authPlugin)
  await app.register(interviewSimRoutes, { prefix: '/interview-sim' })
  await app.register(interviewSimPublicRoutes, { prefix: '/public/interview-sim' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

const eligibleJobRows = (sql: string) => {
  const s = String(sql)
  if (s.includes(`FROM "${SCHEMA}".employees`)) return { rows: [{ id: 'emp-1', department_id: null, job_level: null, hire_date: null, legal_entity_id: null }] }
  if (s.includes(`FROM "${SCHEMA}".recruitment_jobs`)) return { rows: [{ title: 'Développeur', interview_focus: null, experience_level: null }] }
  return null
}

describe('POST /interview-sim/internal-jobs/:jobId/consent', () => {
  it('401 sans token', async () => {
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/consent`,
      payload: { consentAccepted: true },
    })
    expect(res.statusCode).toBe(401)
  })

  it('404 si l’offre n’est pas éligible pour l’employé', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes(`FROM "${SCHEMA}".employees`)) return Promise.resolve({ rows: [{ id: 'emp-1', department_id: null, job_level: null, hire_date: null, legal_entity_id: null }] })
      if (s.includes(`FROM "${SCHEMA}".recruitment_jobs`)) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/consent`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { consentAccepted: true },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Offre introuvable' })
  })

  it('400 si consentAccepted absent/faux', async () => {
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/consent`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { consentAccepted: false },
    })
    expect(res.statusCode).toBe(400)
  })

  it('200 : INSERT avec employee_id DU JWT et snapshot du texte de consentement tenant', async () => {
    queryMock.mockImplementation((sql: string) => {
      const found = eligibleJobRows(sql)
      if (found) return Promise.resolve(found)
      const s = String(sql)
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 5, public_token_ttl_minutes: 60, consent_text: 'Texte tenant personnalisé' }] })
      if (s.includes('INSERT INTO') && s.includes('interview_sim_consents')) return Promise.resolve({ rows: [{ id: 'consent-abc' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/consent`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { consentAccepted: true },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.consentId).toBe('consent-abc')
    expect(typeof data.sessionId).toBe('string')
    expect(data.sessionId.length).toBeGreaterThan(10)

    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('interview_sim_consents'))
    expect(insert).toBeTruthy()
    const [sql, params] = insert as [string, unknown[]]
    expect(sql).toContain(`"${SCHEMA}".interview_sim_consents`)
    expect(sql).toContain(`'internal'`)
    expect(params).toContain('emp-1') // employee_id = JWT, jamais le body
    expect(params).toContain(JOB_ID)
    expect(params).toContain('Texte tenant personnalisé') // snapshot exact
  })

  it('repli sur le texte de consentement par défaut si le tenant n’en a pas configuré', async () => {
    queryMock.mockImplementation((sql: string) => {
      const found = eligibleJobRows(sql)
      if (found) return Promise.resolve(found)
      const s = String(sql)
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 5, public_token_ttl_minutes: 60, consent_text: null }] })
      if (s.includes('INSERT INTO') && s.includes('interview_sim_consents')) return Promise.resolve({ rows: [{ id: 'consent-def' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/consent`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { consentAccepted: true },
    })
    expect(res.statusCode).toBe(200)
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('interview_sim_consents'))
    const [, params] = insert as [string, unknown[]]
    expect(params.some((p) => typeof p === 'string' && p.length > 0)).toBe(true)
  })
})

describe('POST /public/interview-sim/:token/consent', () => {
  it('401 si le jeton est invalide', async () => {
    const res = await app.inject({ method: 'POST', url: '/public/interview-sim/not-a-token/consent', payload: { consentAccepted: true } })
    expect(res.statusCode).toBe(401)
  })

  it('410 si le jeton est expiré', async () => {
    const expired = mintPublicInterviewToken(app as unknown as FastifyInstance,
      { schema: SCHEMA, tenantSlug: 'sotra', jobId: JOB_ID, title: 'Comptable', secteur: 'Finance', langue: 'fr' }, -1)
    const res = await app.inject({ method: 'POST', url: `/public/interview-sim/${expired}/consent`, payload: { consentAccepted: true } })
    expect(res.statusCode).toBe(410)
  })

  it('400 si consentAccepted absent/faux', async () => {
    const res = await app.inject({ method: 'POST', url: `/public/interview-sim/${validPublicToken()}/consent`, payload: { consentAccepted: false } })
    expect(res.statusCode).toBe(400)
  })

  it('200 : INSERT avec employee_id NULL et AUCUNE IP enregistrée (trace strictement anonyme)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 5, public_token_ttl_minutes: 60, consent_text: 'Texte public' }] })
      if (s.includes('INSERT INTO') && s.includes('interview_sim_consents')) return Promise.resolve({ rows: [{ id: 'consent-pub' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/public/interview-sim/${validPublicToken()}/consent`,
      headers: { 'x-forwarded-for': '203.0.113.7' }, // même avec un en-tête IP présent : ne doit JAMAIS être enregistré
      payload: { consentAccepted: true },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.consentId).toBe('consent-pub')
    expect(typeof data.sessionId).toBe('string')

    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('interview_sim_consents'))
    expect(insert).toBeTruthy()
    const [sql, params] = insert as [string, unknown[]]
    expect(sql).toContain(`'public'`)
    expect(sql).toContain('NULL') // employee_id NULL en dur, jamais paramétré
    expect(params).not.toContain('emp-1')
    expect(params.every((p) => typeof p !== 'string' || !p.includes('203.0.113.7'))).toBe(true)
    expect(params).not.toContain('203.0.113.7')
    // Aucun paramètre IP : seuls jobId, sessionId, consentText sont attendus.
    expect(params.length).toBe(3)
  })
})

describe('GET /interview-sim/consent-text', () => {
  it('401 sans token', async () => {
    const res = await app.inject({ method: 'GET', url: '/interview-sim/consent-text' })
    expect(res.statusCode).toBe(401)
  })

  it('200 pour un simple employee (pas admin/hr_manager)', async () => {
    queryMock.mockResolvedValue({ rows: [{ default_langue: 'fr', questions_count: 5, public_token_ttl_minutes: 60, consent_text: 'Mon texte' }] })
    const res = await app.inject({
      method: 'GET', url: '/interview-sim/consent-text',
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.consentText).toBe('Mon texte')
  })

  it('repli texte par défaut si non configuré', async () => {
    queryMock.mockResolvedValue({ rows: [{ default_langue: 'fr', questions_count: 5, public_token_ttl_minutes: 60, consent_text: null }] })
    const res = await app.inject({
      method: 'GET', url: '/interview-sim/consent-text',
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().data.consentText).toBe('string')
    expect(res.json().data.consentText.length).toBeGreaterThan(0)
  })
})

describe('GET /interview-sim/internal-jobs/:jobId/start — blocage sans consentement', () => {
  it('403 sans sessionId', async () => {
    queryMock.mockImplementation((sql: string) => Promise.resolve(eligibleJobRows(sql) ?? { rows: [] }))
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'Consentement requis' })
  })

  it('403 avec un sessionId inconnu (aucune trace correspondante)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const found = eligibleJobRows(sql)
      if (found) return Promise.resolve(found)
      const s = String(sql)
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start?sessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'Consentement requis' })
  })

  it('200 avec un sessionId valide (trace correspondante trouvée)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const found = eligibleJobRows(sql)
      if (found) return Promise.resolve(found)
      const s = String(sql)
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [{ id: 'consent-1' }] })
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ sector: 'IT' }] })
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 4, public_token_ttl_minutes: 60, consent_text: null }] })
      if (s.includes('interview_sim_question_banks')) return Promise.resolve({ rows: [{ questions: ['Q1', 'Q2'], source_model: 'claude' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start?sessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(200)

    const check = queryMock.mock.calls.find((c) => String(c[0]).includes('interview_sim_consents') && String(c[0]).toLowerCase().includes('select'))
    expect(check).toBeTruthy()
    const [sql, params] = check as [string, unknown[]]
    expect(sql).toContain(`'internal'`)
    expect(params).toContain(SESSION_ID)
    expect(params).toContain(JOB_ID)
    expect(params).toContain('emp-1')
  })
})

describe('POST /interview-sim/internal-jobs/:jobId/submit — blocage sans consentement', () => {
  const payloadSansSessionId = {
    langue: 'fr', questions: ['Q1'], answers: [{ index: 0, question: 'Q1', transcript: 'r' }],
  }
  const payloadAvecSessionId = { ...payloadSansSessionId, sessionId: SESSION_ID }

  it('400 sans sessionId (le schéma refuse — impossible même de tenter le contournement)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: payloadSansSessionId,
    })
    expect(res.statusCode).toBe(400)
  })

  it('403 avec un sessionId inconnu (aucune trace correspondante) — pas de retour IA, pas de compteur', async () => {
    queryMock.mockImplementation((sql: string) => {
      const found = eligibleJobRows(sql)
      if (found) return Promise.resolve(found)
      const s = String(sql)
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: payloadAvecSessionId,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'Consentement requis' }) // aucun champ `retour` : produireRetour jamais atteint
    const usage = queryMock.mock.calls.find((c) => String(c[0]).includes('platform.interview_sim_usage'))
    expect(usage).toBeFalsy()
  })

  it('200 avec un sessionId valide (trace correspondante trouvée) : retour IA renvoyé', async () => {
    queryMock.mockImplementation((sql: string) => {
      const found = eligibleJobRows(sql)
      if (found) return Promise.resolve(found)
      const s = String(sql)
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [{ id: 'consent-1' }] })
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ sector: 'IT' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: payloadAvecSessionId,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.retour).toBeTruthy()
    const usage = queryMock.mock.calls.find((c) => String(c[0]).includes('platform.interview_sim_usage'))
    expect(usage).toBeTruthy()
  })

  it('la vérification du consentement lie employee_id AU JWT — un consentement d’un AUTRE employé ne satisfait jamais la garde', async () => {
    queryMock.mockImplementation((sql: string) => {
      const found = eligibleJobRows(sql)
      if (found) return Promise.resolve(found)
      const s = String(sql)
      // La trace de consentement existe mais appartient à 'emp-AUTRE' : la
      // requête SQL filtre employee_id = $3 (JWT) ⇒ 0 ligne pour 'emp-1' ici.
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: payloadAvecSessionId,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'Consentement requis' })

    const check = queryMock.mock.calls.find((c) => String(c[0]).includes('interview_sim_consents') && String(c[0]).toLowerCase().includes('select'))
    expect(check).toBeTruthy()
    const [sql, params] = check as [string, unknown[]]
    expect(sql).toContain('employee_id = $3') // la garde filtre bien sur l'employé du JWT
    expect(params).toContain('emp-1')
    expect(params).toContain(SESSION_ID)
    expect(params).toContain(JOB_ID)
  })
})

describe('POST /public/interview-sim/:token/submit — blocage sans consentement', () => {
  it('403 avec un sessionId inconnu (aucune trace correspondante)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/public/interview-sim/${validPublicToken()}/submit`,
      payload: {
        consentAccepted: true, sessionId: SESSION_ID,
        answers: [{ index: 0, question: 'Q1', transcript: 'r' }], questions: ['Q1'],
      },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'Consentement requis' })
  })

  it('200 avec un sessionId valide (trace correspondante trouvée)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [{ id: 'consent-1' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/public/interview-sim/${validPublicToken()}/submit`,
      payload: {
        consentAccepted: true, sessionId: SESSION_ID,
        answers: [{ index: 0, question: 'Q1', transcript: 'r' }], questions: ['Q1'],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.retour).toBeTruthy()
  })
})

describe('non-régression RGPD : aucune écriture ne touche interview_sim_attempts', () => {
  it('interne : consent + start ne référencent jamais interview_sim_attempts', async () => {
    queryMock.mockImplementation((sql: string) => {
      const found = eligibleJobRows(sql)
      if (found) return Promise.resolve(found)
      const s = String(sql)
      if (s.includes('interview_sim_consents') && s.includes('INSERT')) return Promise.resolve({ rows: [{ id: 'consent-x' }] })
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [{ id: 'consent-x' }] })
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ sector: 'IT' }] })
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 4, public_token_ttl_minutes: 60, consent_text: null }] })
      if (s.includes('interview_sim_question_banks')) return Promise.resolve({ rows: [{ questions: ['Q1'], source_model: 'claude' }] })
      return Promise.resolve({ rows: [] })
    })
    await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/consent`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { consentAccepted: true },
    })
    await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start?sessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    const touchAttempts = queryMock.mock.calls.some((c) => String(c[0]).includes('interview_sim_attempts'))
    expect(touchAttempts).toBe(false)
  })

  it('public : consent + submit ne référencent jamais interview_sim_attempts', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('interview_sim_consents')) return Promise.resolve({ rows: [{ id: 'consent-y' }] })
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 4, public_token_ttl_minutes: 60, consent_text: null }] })
      return Promise.resolve({ rows: [] })
    })
    const token = validPublicToken()
    await app.inject({ method: 'POST', url: `/public/interview-sim/${token}/consent`, payload: { consentAccepted: true } })
    await app.inject({
      method: 'POST', url: `/public/interview-sim/${token}/submit`,
      payload: {
        consentAccepted: true, sessionId: SESSION_ID,
        answers: [{ index: 0, question: 'Q1', transcript: 'r' }], questions: ['Q1'],
      },
    })
    const touchAttempts = queryMock.mock.calls.some((c) => String(c[0]).includes('interview_sim_attempts'))
    expect(touchAttempts).toBe(false)
  })
})
