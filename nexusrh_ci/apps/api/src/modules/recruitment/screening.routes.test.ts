/**
 * Endpoints de pré-tri.
 *
 * Trois propriétés y sont verrouillées :
 *  - `preview` ne modifie RIEN (c'est ce qui rend le réglage d'un critère
 *    instantané et gratuit) ;
 *  - une décision qui contredit le verdict machine exige un motif ;
 *  - une candidature déjà tranchée ne peut pas l'être une seconde fois.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
}))
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
  },
}))
vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import screeningRoutes from './screening.routes.js'

const JOB = '11111111-1111-4111-8111-111111111111'
const APP = '22222222-2222-4222-8222-222222222222'
let app: FastifyInstance

const auth = (role = 'hr_manager') => ({
  authorization: `Bearer ${app.jwt.sign({
    sub: '33333333-3333-4333-8333-333333333333', jti: 'jti-1',
    tenantId: '44444444-4444-4444-8444-444444444444',
    schemaName: 'tenant_demo', role, email: 'rh@demo.ci',
    firstName: 'A', lastName: 'B', employeeId: null,
  })}`,
})

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(screeningRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockClear(); queryMock.mockResolvedValue({ rows: [] }) })

describe('Questions éliminatoires — accès', () => {
  it('un salarié ne peut pas lire la définition des questions', async () => {
    const r = await app.inject({
      method: 'GET', url: `/recruitment/jobs/${JOB}/screening-questions`,
      headers: auth('employee'),
    })
    expect(r.statusCode).toBe(403)
  })

  it('un hr_officer ne peut pas les modifier', async () => {
    const r = await app.inject({
      method: 'PUT', url: `/recruitment/jobs/${JOB}/screening-questions`,
      headers: auth('hr_officer'), payload: { questions: [] },
    })
    expect(r.statusCode).toBe(403)
  })

  it('rejette un identifiant d’offre non-UUID', async () => {
    const r = await app.inject({
      method: 'GET', url: '/recruitment/jobs/pas-un-uuid/screening-questions',
      headers: auth(),
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('Questions éliminatoires — écriture', () => {
  it('dégrade un knockout sans règle en question informative', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: JOB }] })
    const r = await app.inject({
      method: 'PUT', url: `/recruitment/jobs/${JOB}/screening-questions`, headers: auth(),
      payload: { questions: [
        { id: 'q1', label: 'Permis B ?', type: 'boolean', required: true, knockout: true },
      ] },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.questions[0].knockout).toBe(false)
  })

  it('conserve un knockout muni d’une règle applicable', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: JOB }] })
    const r = await app.inject({
      method: 'PUT', url: `/recruitment/jobs/${JOB}/screening-questions`, headers: auth(),
      payload: { questions: [
        { id: 'q1', label: 'Permis B ?', type: 'boolean', required: true, knockout: true,
          rule: { op: 'is', value: true } },
      ] },
    })
    expect(r.json().data.questions[0].knockout).toBe(true)
  })

  it('404 si l’offre n’existe pas', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const r = await app.inject({
      method: 'PUT', url: `/recruitment/jobs/${JOB}/screening-questions`,
      headers: auth(), payload: { questions: [] },
    })
    expect(r.statusCode).toBe(404)
  })

  it('refuse plus de 15 questions', async () => {
    const r = await app.inject({
      method: 'PUT', url: `/recruitment/jobs/${JOB}/screening-questions`, headers: auth(),
      payload: { questions: Array.from({ length: 16 }, (_, i) => ({
        id: `q${i}`, label: 'L', type: 'boolean', required: true, knockout: false,
      })) },
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('Simulation', () => {
  it('preview n’écrit RIEN', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const r = await app.inject({
      method: 'POST', url: `/recruitment/jobs/${JOB}/screening/preview`, headers: auth(),
      payload: { criteria: { minExperienceYears: 5 }, questions: [] },
    })
    expect(r.statusCode).toBe(200)
    const writes = queryMock.mock.calls.filter(c => /UPDATE|INSERT|DELETE/i.test(String(c[0])))
    expect(writes).toEqual([])
  })

  it('compte les dossiers signalés et agrège les motifs', async () => {
    queryMock.mockResolvedValue({ rows: [
      { id: 'a1', screening_answers: { q1: false }, ai_analyzed_at: null,
        ai_score: null, ai_years_experience: null, ai_skills: null, ai_diploma: null,
        ai_location: null, ai_languages: null, expected_salary: null },
      { id: 'a2', screening_answers: { q1: true }, ai_analyzed_at: null,
        ai_score: null, ai_years_experience: null, ai_skills: null, ai_diploma: null,
        ai_location: null, ai_languages: null, expected_salary: null },
    ] })
    const r = await app.inject({
      method: 'POST', url: `/recruitment/jobs/${JOB}/screening/preview`, headers: auth(),
      payload: { questions: [
        { id: 'q1', label: 'Permis B ?', type: 'boolean', required: true, knockout: true,
          rule: { op: 'is', value: true } },
      ] },
    })
    const d = r.json().data
    expect(d.total).toBe(2)
    expect(d.flagged).toBe(1)
    expect(d.pass).toBe(1)
    expect(d.byRule[0].count).toBe(1)
  })

  it('n’applique pas les règles sur CV tant qu’aucun CV n’est analysé', async () => {
    // Sans ai_analyzed_at, l'extraction est vide : appliquer les règles ferait
    // échouer tout le monde à tort.
    queryMock.mockResolvedValue({ rows: [
      { id: 'a1', screening_answers: {}, ai_analyzed_at: null, ai_score: null,
        ai_years_experience: null, ai_skills: null, ai_diploma: null,
        ai_location: null, ai_languages: null, expected_salary: null },
    ] })
    const r = await app.inject({
      method: 'POST', url: `/recruitment/jobs/${JOB}/screening/preview`, headers: auth(),
      payload: { criteria: { minExperienceYears: 10 }, questions: [] },
    })
    expect(r.json().data.flagged).toBe(0)
  })
})

describe('Décision humaine', () => {
  it('refuse une dérogation sans motif (400)', async () => {
    queryMock.mockResolvedValue({ rows: [{ screening_verdict: 'flagged' }] })
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'kept' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/motif/i)
  })

  it('refuse d’écarter un dossier conforme sans motif', async () => {
    queryMock.mockResolvedValue({ rows: [{ screening_verdict: 'pass' }] })
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'dismissed', reason: 'court' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('accepte une dérogation motivée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ screening_verdict: 'flagged' }] })
      .mockResolvedValueOnce({ rows: [{ id: APP, screening_verdict: 'flagged' }] })
      .mockResolvedValue({ rows: [] })
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'kept', reason: 'Parcours remarquable malgré 4 ans' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.decision).toBe('kept')
  })

  it('accepte sans motif quand la décision SUIT le verdict', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ screening_verdict: 'pass' }] })
      .mockResolvedValueOnce({ rows: [{ id: APP, screening_verdict: 'pass' }] })
      .mockResolvedValue({ rows: [] })
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'kept' },
    })
    expect(r.statusCode).toBe(200)
  })

  it('404 si la candidature est déjà tranchée', async () => {
    queryMock.mockResolvedValue({ rows: [] })   // getVerdict ne trouve rien
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'dismissed' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('refuse une décision hors énumération', async () => {
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'peut-être' },
    })
    expect(r.statusCode).toBe(400)
  })
})
