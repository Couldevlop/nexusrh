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
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))

import authPlugin from '../../plugins/auth.js'
import signatureRoutes from './signature.routes.js'

const SCHEMA = 'tenant_sotra'
function token(app: FastifyInstance, role: string, employeeId: string | null = null) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(signatureRoutes, { prefix: '/signature' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('OWASP A01 — RBAC gestion', () => {
  it('liste autorisée à readonly (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/signature/requests', headers: { authorization: `Bearer ${token(app, 'readonly')}` } })
    expect(res.statusCode).toBe(200)
  })
  it('création réservée RH — manager refusé (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/signature/requests',
      headers: { authorization: `Bearer ${token(app, 'manager')}` },
      payload: { title: 'CDI', signatories: [{ name: 'Kouassi' }] },
    })
    expect(res.statusCode).toBe(403)
  })
  it('hr_officer crée une demande (201) avec ses signataires', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'req-1' }] }) // INSERT request
      .mockResolvedValueOnce({ rows: [] }) // INSERT signatory 1
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/signature/requests',
      headers: { authorization: `Bearer ${token(app, 'hr_officer')}` },
      payload: { title: 'CDI Kouassi', documentType: 'contract', signatories: [{ name: 'Kouassi Jean', email: 'k@sotra.ci' }] },
    })
    expect(res.statusCode).toBe(201)
  })
  it('création rejette une liste de signataires vide (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/signature/requests',
      headers: { authorization: `Bearer ${token(app, 'hr_manager')}` },
      payload: { title: 'CDI', signatories: [] },
    })
    expect(res.statusCode).toBe(400)
  })
  it('suppression réservée admin/hr_manager — hr_officer refusé (403)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/signature/requests/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${token(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('Workflow envoi / annulation', () => {
  const ID = '11111111-1111-1111-1111-111111111111'
  it('envoi d\'un brouillon sans signataire → 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'draft' }] }) // SELECT status
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // COUNT signatories
    const res = await app.inject({ method: 'POST', url: `/signature/requests/${ID}/send`, headers: { authorization: `Bearer ${token(app, 'hr_manager')}` } })
    expect(res.statusCode).toBe(400)
  })
  it('envoi d\'un brouillon avec signataire → 200 pending', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'draft' }] })
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: `/signature/requests/${ID}/send`, headers: { authorization: `Bearer ${token(app, 'hr_manager')}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('pending')
  })
  it('annulation d\'une demande déjà signée → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'signed' }] })
    const res = await app.inject({ method: 'POST', url: `/signature/requests/${ID}/cancel`, headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })
})

describe('Signature self-service (A01 + A09)', () => {
  const ID = '11111111-1111-1111-1111-111111111111'
  it('refuse si le salarié courant n\'est pas signataire (403)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'pending', sequential: false, expires_at: null }] }) // SELECT request
      .mockResolvedValueOnce({ rows: [{ id: 's1', status: 'pending', order_index: 0, employee_id: 'other-emp' }] }) // signatories
    const res = await app.inject({
      method: 'POST', url: `/signature/requests/${ID}/sign`,
      headers: { authorization: `Bearer ${token(app, 'employee', 'me-emp')}` },
      payload: { signatureText: 'Kouassi Jean' },
    })
    expect(res.statusCode).toBe(403)
  })
  it('le signataire signe → 200 + audit signature.signed', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'pending', sequential: false, expires_at: null }] }) // SELECT request
      .mockResolvedValueOnce({ rows: [{ id: 's1', status: 'pending', order_index: 0, employee_id: 'me-emp' }] }) // signatories
      .mockResolvedValueOnce({ rows: [] }) // UPDATE signatory
      .mockResolvedValueOnce({ rows: [{ id: 's1', status: 'signed', order_index: 0, employee_id: 'me-emp' }] }) // recompute SELECT
      .mockResolvedValueOnce({ rows: [] }) // recompute UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: `/signature/requests/${ID}/sign`,
      headers: { authorization: `Bearer ${token(app, 'employee', 'me-emp')}` },
      payload: { signatureText: 'Kouassi Jean' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('signed')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('signature.signed')
  })
  it('signature impossible sans profil salarié (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/signature/requests/${ID}/sign`,
      headers: { authorization: `Bearer ${token(app, 'admin', null)}` },
      payload: { signatureText: 'X' },
    })
    expect(res.statusCode).toBe(403)
  })
  it('mes documents à signer : liste vide si pas de profil salarié', async () => {
    const res = await app.inject({ method: 'GET', url: '/signature/my-requests', headers: { authorization: `Bearer ${token(app, 'admin', null)}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })
})
