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
import classificationRoutes from './classification.routes.js'

const SCHEMA = 'tenant_sotra'
function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(classificationRoutes, { prefix: '/classification' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('OWASP A01 — RBAC config', () => {
  it('lecture des niveaux autorisée à hr_officer (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/classification/levels', headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` } })
    expect(res.statusCode).toBe(200)
  })
  it('config des règles RÉSERVÉE à admin — hr_manager refusé (403)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/classification/levels/4',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { allowedRoles: ['admin'], exportAllowed: false, encryptionRequired: true, auditRequired: true },
    })
    expect(res.statusCode).toBe(403)
  })
  it('admin met à jour les règles d\'un niveau (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ level: 4 }] }).mockResolvedValueOnce({ rows: [] }) // UPDATE + audit
    const res = await app.inject({
      method: 'PUT', url: '/classification/levels/4',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { allowedRoles: ['admin', 'hr_manager'], exportAllowed: false, encryptionRequired: true, auditRequired: true },
    })
    expect(res.statusCode).toBe(200)
  })
  it('niveau invalide (5) → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/classification/levels/5',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { allowedRoles: ['admin'], exportAllowed: false, encryptionRequired: false, auditRequired: false },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('check — décision d\'accès/export', () => {
  it('niveau 4 : refuse l\'accès à un manager', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ level: 4 }] }) // category lookup
      .mockResolvedValueOnce({ rows: [{ level: 4, label: 'restricted', allowed_roles: ['admin', 'hr_manager', 'hr_officer'], export_allowed: false, encryption_required: true, audit_required: true }] }) // level rule
    const res = await app.inject({
      method: 'GET', url: '/classification/check?categoryKey=disciplinary',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { level: number; canAccess: boolean; canExport: boolean } }
    expect(body.data.level).toBe(4)
    expect(body.data.canAccess).toBe(false)
    expect(body.data.canExport).toBe(false)
  })
  it('niveau 3 : RH accède mais avec audit (sensitive_access journalisé)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ level: 3, label: 'confidential', allowed_roles: ['admin', 'hr_manager'], export_allowed: true, encryption_required: true, audit_required: true }] }) // level rule (level param)
      .mockResolvedValueOnce({ rows: [] }) // audit insert
    const res = await app.inject({
      method: 'GET', url: '/classification/check?level=3',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { canAccess: boolean } }
    expect(body.data.canAccess).toBe(true)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('classification.sensitive_access')
  })
})

describe('catégories', () => {
  it('création réservée admin/hr_manager — hr_officer refusé (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/classification/categories',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { categoryKey: 'custom_data', label: 'Custom', level: 2 },
    })
    expect(res.statusCode).toBe(403)
  })
  it('refuse une clé de catégorie invalide (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/classification/categories',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { categoryKey: 'Bad Key!', label: 'X', level: 2 },
    })
    expect(res.statusCode).toBe(400)
  })
})
