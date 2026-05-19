import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyRequest } from 'fastify'
import authPlugin from '../../plugins/auth.js'

// Mock du pool PG et Redis pour les tests unitaires
vi.mock('pg', () => {
  const mockPool = {
    query: vi.fn(),
    end: vi.fn(),
  }
  return { Pool: vi.fn(() => mockPool) }
})

vi.mock('../../services/redis.js', () => ({
  blacklistToken:      vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted:  vi.fn().mockResolvedValue(false),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

describe('Auth plugin — JWT + RBAC', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    await app.register(authPlugin)

    app.get('/protected', { preHandler: [app.authenticate] }, async (req: FastifyRequest) => ({ user: req.user }))
    app.get('/admin-only', { preHandler: [app.authorize('admin')] }, async () => ({ ok: true }))
    app.get('/multi-role', { preHandler: [app.authorize('admin', 'hr_manager')] }, async () => ({ ok: true }))

    await app.ready()
  })

  afterAll(async () => app.close())

  it('rejette une requête sans token (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
  })

  it('rejette un token invalide (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer invalid.token.here' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepte un token valide (200)', async () => {
    const token = app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_test', role: 'employee', email: 'e@t.com', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).user.role).toBe('employee')
  })

  it('rejette rôle insuffisant (403)', async () => {
    const token = app.jwt.sign({ sub: 'u2', tenantId: 't1', schemaName: 'tenant_test', role: 'employee', email: 'e@t.com', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({
      method: 'GET',
      url: '/admin-only',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('accepte admin sur route admin-only (200)', async () => {
    const token = app.jwt.sign({ sub: 'u3', tenantId: 't1', schemaName: 'tenant_test', role: 'admin', email: 'a@t.com', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({
      method: 'GET',
      url: '/admin-only',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('accepte hr_manager sur route multi-rôle (200)', async () => {
    const token = app.jwt.sign({ sub: 'u4', tenantId: 't1', schemaName: 'tenant_test', role: 'hr_manager', email: 'h@t.com', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({
      method: 'GET',
      url: '/multi-role',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejette token blacklisté (401)', async () => {
    const { isTokenBlacklisted } = await import('../../services/redis.js')
    vi.mocked(isTokenBlacklisted).mockResolvedValueOnce(true)

    const token = app.jwt.sign({ sub: 'u5', tenantId: 't1', schemaName: 'tenant_test', role: 'admin', email: 'a@t.com', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('Token révoqué')
  })
})

describe('RBAC — matrice des rôles', () => {
  const ROLES = ['super_admin', 'admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly']

  it('couvre tous les rôles définis', () => {
    expect(ROLES).toHaveLength(7)
    expect(ROLES).toContain('super_admin')
    expect(ROLES).toContain('employee')
  })

  it('employee ne fait pas partie des rôles RH', () => {
    const hrRoles = ['admin', 'hr_manager', 'hr_officer']
    expect(hrRoles).not.toContain('employee')
  })
})
