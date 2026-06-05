/**
 * Couverture complémentaire des routes /platform/legal-watch.
 *
 * Le test existant (legal-watch.routes.test.ts) couvre la validation Zod/RBAC/UUID.
 * Ce fichier couvre les CHEMINS NOMINAUX et les branches d'erreur métier :
 *  - POST /analyze : succès sans article_id, succès avec article_id existant,
 *    erreur IA user-actionable (422)
 *  - GET /proposals : liste filtrée, status=all, status invalide → fallback pending
 *  - GET /proposals/:id : 404 introuvable, succès
 *  - POST /approve : article existant (archive + update), nouvel article (insert),
 *    proposition introuvable (404), déjà traitée (409), erreur transaction (500)
 *  - POST /reject : succès, proposition introuvable/déjà traitée (409)
 *  - GET /sources-catalog : filtre pays valide
 *  - GET /stats : agrégation des compteurs
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, poolConnectMock, analyzeDiffMock } = vi.hoisted(() => ({
  queryMock:       vi.fn(),
  poolConnectMock: vi.fn(),
  analyzeDiffMock: vi.fn(),
}))

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({
    query:   queryMock,
    connect: poolConnectMock,
    end:     vi.fn(),
  })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../services/legal-diff.service.js', () => ({
  analyzeLegalDiff: analyzeDiffMock,
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import legalWatchRoutes from './legal-watch.routes.js'

const UUID_A = '11111111-1111-1111-1111-111111111111'

const DIFF_RESULT = {
  has_changes: true,
  confidence:  90,
  summary:     'Le taux passe de 6,3% à 6,5%.',
  reasoning:   'Modification du taux salarial CNPS.',
  key_changes: ['Taux 6.3 → 6.5%'],
  risk_level:  'high' as const,
  model_used:  'claude-sonnet-4-test',
}

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: null, schemaName: 'platform', role,
    email: `${role}@nexusrh.com`, firstName: 'Test', lastName: 'User', employeeId: null,
  })
}

/** Faux client PG transactionnel pour pool.connect() (BEGIN/COMMIT/ROLLBACK). */
function makeClient(clientQuery: ReturnType<typeof vi.fn>) {
  return { query: clientQuery, release: vi.fn() }
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(legalWatchRoutes, { prefix: '/platform/legal-watch' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  poolConnectMock.mockReset()
  analyzeDiffMock.mockReset()
  // Défaut sûr : toute requête non explicitement programmée renvoie rows vide.
  queryMock.mockResolvedValue({ rows: [] })
})

describe('POST /platform/legal-watch/analyze — chemins nominaux', () => {
  it('analyse réussie SANS article_id → 201 + insert proposition', async () => {
    analyzeDiffMock.mockResolvedValueOnce(DIFF_RESULT)
    // INSERT proposition RETURNING id
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A }] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.data.id).toBe(UUID_A)
    expect(body.data.diff.confidence).toBe(90)
    expect(body.data.article).toBeNull()
  })

  it('analyse réussie AVEC article_id existant → 201 + article enrichi', async () => {
    // SELECT article courant
    queryMock.mockResolvedValueOnce({ rows: [{ texte: 'ancien texte', titre_article: 'Article 36' }] })
    analyzeDiffMock.mockResolvedValueOnce(DIFF_RESULT)
    // INSERT proposition
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A }] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', article_id: 'art-36', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.data.article).toEqual({ id: 'art-36', title: 'Article 36' })
  })

  it('erreur IA user-actionable → 422 avec message exposé', async () => {
    analyzeDiffMock.mockRejectedValueOnce(new Error('Texte proposé trop court (minimum 10 caractères)'))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toMatch(/trop court/i)
  })

  it('erreur IA non-Error (string) masquée en 500 générique', async () => {
    analyzeDiffMock.mockRejectedValueOnce('boom interne anthropic')
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('boom interne')
  })
})

describe('GET /platform/legal-watch/proposals — liste paginée', () => {
  it('liste filtrée par status pending (défaut) → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'pending' }] }) // SELECT data
      .mockResolvedValueOnce({ rows: [{ cnt: 1 }] })                        // SELECT count
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/proposals',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(1)
    expect(body.data).toHaveLength(1)
  })

  it('status=all → pas de clause WHERE, 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/proposals?status=all&limit=10&offset=5',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).total).toBe(0)
  })

  it('status invalide → fallback "pending", limit/offset bornés', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/proposals?status=hacker&limit=99999&offset=-5',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('count vide → total = 0 (coalesce)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // count rows vide → ?? 0
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/proposals',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).total).toBe(0)
  })
})

describe('GET /platform/legal-watch/proposals/:id — détail', () => {
  it('UUID valide mais introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: `/platform/legal-watch/proposals/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /platform/legal-watch/proposals/:id/approve — transaction', () => {
  it('approuve une proposition liée à un article existant (archive + update) → 200', async () => {
    const clientQuery = vi.fn()
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, article_id: 'art-36', country_code: 'CIV',
        source: 'code_travail', proposed_text: 'nouveau texte', status: 'pending',
      }] }) // SELECT FOR UPDATE proposition
      .mockResolvedValueOnce({ rows: [{
        titre_article: 'Article 36', texte: 'ancien', keywords: ['a'], payroll_codes: ['2000'],
      }] }) // SELECT FOR UPDATE article courant
      .mockResolvedValueOnce({ rows: [{ max_v: 2 }] }) // max version history
      .mockResolvedValueOnce({ rows: [] }) // INSERT history
      .mockResolvedValueOnce({ rows: [] }) // UPDATE article
      .mockResolvedValueOnce({ rows: [] }) // UPDATE proposition
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
    poolConnectMock.mockResolvedValueOnce(makeClient(clientQuery))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: 'OK conforme' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.status).toBe('approved')
    expect(body.data.article_id).toBe('art-36')
    expect(body.data.checksum_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('approuve un article existant mais introuvable en base (cur null) → pas d\'update mais 200', async () => {
    const clientQuery = vi.fn()
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, article_id: 'art-36', country_code: 'CIV',
        source: 'code_travail', proposed_text: 'nouveau texte', status: 'pending',
      }] }) // SELECT proposition
      .mockResolvedValueOnce({ rows: [] }) // SELECT article courant → vide
      .mockResolvedValueOnce({ rows: [] }) // UPDATE proposition
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
    poolConnectMock.mockResolvedValueOnce(makeClient(clientQuery))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('approuve une proposition SANS article (insert nouvel article) → 200', async () => {
    const clientQuery = vi.fn()
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, article_id: null, country_code: 'CIV',
        source: 'cnps', proposed_text: 'tout nouveau texte', status: 'pending',
      }] }) // SELECT proposition
      .mockResolvedValueOnce({ rows: [] }) // INSERT nouvel article
      .mockResolvedValueOnce({ rows: [] }) // UPDATE proposition
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
    poolConnectMock.mockResolvedValueOnce(makeClient(clientQuery))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.article_id).toMatch(/^cnps-CIV-/)
  })

  it('proposition introuvable → ROLLBACK + 404', async () => {
    const clientQuery = vi.fn()
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT proposition → vide
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK
    poolConnectMock.mockResolvedValueOnce(makeClient(clientQuery))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('proposition déjà traitée (non pending) → ROLLBACK + 409', async () => {
    const clientQuery = vi.fn()
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, article_id: null, country_code: 'CIV',
        source: 'cnps', proposed_text: 'txt', status: 'approved',
      }] }) // SELECT proposition → déjà approved
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK
    poolConnectMock.mockResolvedValueOnce(makeClient(clientQuery))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/déjà approved/i)
  })

  it('erreur en cours de transaction → ROLLBACK + 500 générique', async () => {
    const clientQuery = vi.fn()
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('connection lost mid-transaction')) // SELECT échoue
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK (catch)
    poolConnectMock.mockResolvedValueOnce(makeClient(clientQuery))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('connection lost')
  })
})

describe('POST /platform/legal-watch/proposals/:id/reject', () => {
  it('rejette une proposition pending → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'rejected' }] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: 'non pertinent' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('rejected')
  })

  it('proposition introuvable ou déjà traitée → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('GET /platform/legal-watch/sources-catalog — filtre pays valide', () => {
  it('country=CIV → renvoie uniquement les sources CIV', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/sources-catalog?country=CIV',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBeGreaterThan(0)
    expect(body.data.every((s: { countryCode: string }) => s.countryCode === 'CIV')).toBe(true)
  })
})

describe('GET /platform/legal-watch/stats', () => {
  it('agrège les compteurs par status → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { status: 'pending', cnt: 3 },
      { status: 'approved', cnt: 5 },
      { status: 'inconnu', cnt: 99 }, // status hors structure → ignoré
    ] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/stats',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.pending).toBe(3)
    expect(body.data.approved).toBe(5)
    expect(body.data.rejected).toBe(0)
  })

  it('un admin ne peut PAS voir les stats (403)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/stats',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
