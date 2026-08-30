/**
 * Golden — parcours complet du pré-tri et traçabilité de la décision.
 *
 * Les goldens voisins couvrent chacun un maillon (branchement du moteur, dépôt
 * public, barrière du pipeline, dépôt de données). Celui-ci vérifie ce qu'aucun
 * autre ne voit : que la DÉCISION HUMAINE laisse une trace exploitable.
 *
 * C'est l'obligation de journalisation qu'impose l'AI Act aux systèmes de
 * recrutement (haut risque), et ce qui permet de démontrer, dossier par dossier,
 * qui a tranché, dans quel sens, et pourquoi lorsqu'il s'est écarté de la
 * machine.
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
  },
}))
vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import screeningRoutes from './screening.routes.js'

const JOB = '11111111-1111-4111-8111-111111111111'
const APP = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
let app: FastifyInstance

const auth = () => ({
  authorization: `Bearer ${app.jwt.sign({
    sub: USER, jti: 'jti-1', tenantId: '44444444-4444-4444-8444-444444444444',
    schemaName: 'tenant_demo', role: 'hr_manager', email: 'rh@demo.ci',
    firstName: 'A', lastName: 'B', employeeId: null,
  })}`,
})

/** Retrouve l'écriture d'audit émise par le handler. */
const auditCall = () => queryMock.mock.calls.find(c => /audit_log/.test(String(c[0])))

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(screeningRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockClear(); queryMock.mockResolvedValue({ rows: [] }) })

/** Amorce : le dossier a le verdict donné, puis la décision aboutit. */
const primeDecision = (verdict: 'pass' | 'flagged') => {
  queryMock
    .mockResolvedValueOnce({ rows: [{ screening_verdict: verdict }] })   // getVerdict
    .mockResolvedValueOnce({ rows: [{ id: APP, screening_verdict: verdict }] }) // decide
    .mockResolvedValue({ rows: [] })                                     // audit
}

describe('Traçabilité de la décision', () => {
  it('journalise le verdict machine, la décision humaine et son auteur', async () => {
    primeDecision('pass')
    await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'kept' },
    })

    const call = auditCall()
    expect(call, 'une entrée d’audit est écrite').toBeDefined()
    const params = call![1] as unknown[]
    expect(params).toContain(USER)
    expect(params).toContain('recruitment.screening_decided')

    const changes = JSON.parse(String(params.find(p => typeof p === 'string' && p.startsWith('{'))))
    expect(changes).toMatchObject({ verdict: 'pass', decision: 'kept', contradicts: false })
  })

  it('journalise le MOTIF quand l’humain contredit la machine', async () => {
    primeDecision('flagged')
    await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(),
      payload: { decision: 'kept', reason: 'Parcours remarquable malgré 4 ans' },
    })

    const params = auditCall()![1] as unknown[]
    const changes = JSON.parse(String(params.find(p => typeof p === 'string' && p.startsWith('{'))))
    expect(changes.contradicts, 'la dérogation est signalée comme telle').toBe(true)
    expect(changes.reason).toBe('Parcours remarquable malgré 4 ans')
  })

  it('n’écrit AUCUNE trace quand la décision est refusée faute de motif', async () => {
    queryMock.mockResolvedValue({ rows: [{ screening_verdict: 'flagged' }] })
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'kept' },
    })
    expect(r.statusCode).toBe(400)
    // Une décision refusée n'est pas une décision : rien ne doit être tracé,
    // ni bien sûr la candidature modifiée.
    expect(auditCall()).toBeUndefined()
    const writes = queryMock.mock.calls.filter(c => /UPDATE .*applications SET screening_decision/.test(String(c[0])))
    expect(writes).toEqual([])
  })
})

describe('Parcours complet', () => {
  it('la file ne présente que les dossiers en attente, puis se vide au fil des décisions', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const r = await app.inject({
      method: 'GET', url: `/recruitment/jobs/${JOB}/screening/queue`, headers: auth(),
    })
    expect(r.statusCode).toBe(200)
    // La requête de file porte la condition « sans décision humaine ».
    const queueSql = queryMock.mock.calls.map(c => String(c[0])).find(s => /FROM .*applications/.test(s))
    expect(queueSql).toMatch(/screening_decision IS NULL/)
  })

  it('retenir place le dossier au stade `screening` du pipeline', async () => {
    primeDecision('pass')
    await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'kept' },
    })
    const upd = queryMock.mock.calls.find(c =>
      /UPDATE .*applications[\s\S]*screening_decision/.test(String(c[0])))
    expect(upd![1] as unknown[]).toContain('screening')
  })

  it('écarter place le dossier au stade `rejected`', async () => {
    primeDecision('flagged')
    await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'dismissed' },
    })
    const upd = queryMock.mock.calls.find(c =>
      /UPDATE .*applications[\s\S]*screening_decision/.test(String(c[0])))
    expect(upd![1] as unknown[]).toContain('rejected')
  })
})
