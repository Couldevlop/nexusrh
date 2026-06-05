/**
 * COUVERTURE — Routes de gestion des logos (brand.routes.ts).
 *
 * Cible :
 *  - POST /platform/brand/logo : upload authentifié (super_admin/agency_owner),
 *    allowlist MIME stricte (SVG exclu), taille max 2 Mo, insert bytea + URL
 *    absolue, RBAC, erreur DB → 500 ;
 *  - GET /public/brand/:id : service public non authentifié, validation UUID,
 *    404 si introuvable, en-têtes de sécurité (nosniff + Content-Type).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test', appUrl: 'http://localhost:3001', apiUrl: 'http://localhost:4001',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import { brandRoutes, publicBrandRoutes } from './brand.routes.js'

let app: FastifyInstance
const ASSET = '55555555-5555-5555-5555-555555555555'

function superToken() {
  return app.jwt.sign({ sub: 'sa1', tenantId: null, schemaName: 'platform', role: 'super_admin',
    email: 'super@ci', firstName: 'S', lastName: 'A', employeeId: null })
}
function agencyOwnerToken() {
  return app.jwt.sign({ sub: 'ao1', tenantId: null, schemaName: 'platform', role: 'agency_owner',
    email: 'owner@cab.ci', firstName: 'O', lastName: 'W', employeeId: null,
    actorType: 'agency', agencyId: 'ag1' })
}
function adminToken() {
  return app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_x', role: 'admin',
    email: 'a@x.ci', firstName: 'A', lastName: 'D', employeeId: null })
}

function multipartBody(boundary: string, file?: { filename: string; type: string; content: string }) {
  let body = ''
  if (file) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n${file.content}\r\n`
  }
  body += `--${boundary}--\r\n`
  return Buffer.from(body, 'utf-8')
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 5 * 1024 * 1024 } })
  await app.register(brandRoutes, { prefix: '/platform/brand' })
  await app.register(publicBrandRoutes, { prefix: '/public/brand' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }) })

// ─── POST /platform/brand/logo ───────────────────────────────────────────────
describe('POST /platform/brand/logo', () => {
  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo' })
    expect(res.statusCode).toBe(401)
  })

  it('rôle admin tenant → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo',
      headers: { authorization: `Bearer ${adminToken()}` } })
    expect(res.statusCode).toBe(403)
  })

  it('aucun fichier reçu → 400', async () => {
    const boundary = '----brand-empty'
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo',
      headers: { authorization: `Bearer ${superToken()}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary) })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Aucun fichier')
  })

  it('MIME interdit (SVG) → 400', async () => {
    const boundary = '----brand-svg'
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo',
      headers: { authorization: `Bearer ${superToken()}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, { filename: 'logo.svg', type: 'image/svg+xml', content: '<svg></svg>' }) })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Format non autorisé')
  })

  it('upload PNG valide (super_admin) → 201 + URL absolue', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: ASSET }] })
    const boundary = '----brand-png'
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo',
      headers: { authorization: `Bearer ${superToken()}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, { filename: 'logo.png', type: 'image/png', content: 'fakepngbytes' }) })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.data.id).toBe(ASSET)
    expect(body.data.url).toBe(`http://localhost:4001/public/brand/${ASSET}`)
    expect(body.data.mime).toBe('image/png')
    expect(body.data.size).toBeGreaterThan(0)
  })

  it('upload JPEG valide (agency_owner) → 201', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: ASSET }] })
    const boundary = '----brand-jpg'
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo',
      headers: { authorization: `Bearer ${agencyOwnerToken()}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, { filename: 'logo.jpg', type: 'image/jpeg', content: 'jpegbytes' }) })
    expect(res.statusCode).toBe(201)
  })

  it('image trop volumineuse (> 2 Mo) → 400', async () => {
    const boundary = '----brand-big'
    // 3 Mo de contenu : passe la limite multipart (5 Mo) mais dépasse LOGO_MAX_BYTES (2 Mo)
    const big = 'a'.repeat(3 * 1024 * 1024)
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo',
      headers: { authorization: `Bearer ${superToken()}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, { filename: 'big.png', type: 'image/png', content: big }) })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('trop volumineuse')
  })

  it('insert ne renvoie pas d\'id → 500', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas d'id
    const boundary = '----brand-noid'
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo',
      headers: { authorization: `Bearer ${superToken()}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, { filename: 'logo.png', type: 'image/png', content: 'bytes' }) })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toContain('Erreur upload')
  })

  it('erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert failed'))
    const boundary = '----brand-dberr'
    const res = await app.inject({ method: 'POST', url: '/platform/brand/logo',
      headers: { authorization: `Bearer ${superToken()}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, { filename: 'logo.png', type: 'image/png', content: 'bytes' }) })
    expect(res.statusCode).toBe(500)
  })
})

// ─── GET /public/brand/:id ───────────────────────────────────────────────────
describe('GET /public/brand/:id', () => {
  it('id non-UUID → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/brand/not-a-uuid' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('id invalide')
  })

  it('asset introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: `/public/brand/${ASSET}` })
    expect(res.statusCode).toBe(404)
  })

  it('asset trouvé → 200 + binaire + en-têtes de sécurité (non authentifié)', async () => {
    const bytes = Buffer.from('logobinary')
    queryMock.mockResolvedValueOnce({ rows: [{ mime: 'image/png', bytes }] })
    const res = await app.inject({ method: 'GET', url: `/public/brand/${ASSET}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cache-control']).toContain('max-age=86400')
    expect(res.rawPayload.equals(bytes)).toBe(true)
  })
})
