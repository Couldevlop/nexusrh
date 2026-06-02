/**
 * Durcissement /auth/refresh pour les tokens cabinet :
 *  - token SCOPÉ (sur un tenant client) → re-validation du guard à chaque refresh
 *    (révocation détectée → 401), TTL 30 min conservé ;
 *  - token contexte cabinet (schemaName=platform) → claims actorType/agencyId
 *    préservés ;
 *  - token tenant standard → comportement inchangé (non-régression).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore: {},
}))
vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: vi.fn(), sendWelcomeTenantEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(), sendPasswordResetLinkEmail: vi.fn(),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test', jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import authRoutes from './auth.routes.js'

let app: FastifyInstance
const AG = '11111111-1111-1111-1111-111111111111'
const T1 = '22222222-2222-2222-2222-222222222222'
const GUARD_OK = {
  agency_status: 'active', tenant_id: T1, schema_name: 'tenant_acme', name: 'ACME', slug: 'acme',
  primary_color: null, secondary_color: null, logo_url: null, city: 'Abidjan',
  tenant_status: 'active', default_country_code: 'CIV',
  has_subsidiaries: false, payroll_mode: 'single_country', link_id: 'lnk1',
}

function scopedToken() {
  return app.jwt.sign({ sub: 'au1', tenantId: T1, schemaName: 'tenant_acme', role: 'admin',
    email: 'o@cab.ci', firstName: 'O', lastName: 'W', employeeId: null,
    actorType: 'agency', agencyId: AG, agencyUserId: 'au1', onBehalfOf: T1 })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }) })

describe('POST /auth/refresh — tokens cabinet', () => {
  it('token scopé + guard OK → nouveau token scopé 30 min', async () => {
    queryMock.mockResolvedValueOnce({ rows: [GUARD_OK] })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${scopedToken()}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scoped).toBe(true)
    expect(body.expiresInSec).toBe(1800)
    const d = app.jwt.decode(body.token) as Record<string, number | string>
    expect(d.schemaName).toBe('tenant_acme')
    expect(d.role).toBe('admin')
    expect(d.actorType).toBe('agency')
    expect((d.exp as number) - (d.iat as number)).toBe(1800)
  })

  it('token scopé + accès révoqué (détaché) → 401', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...GUARD_OK, link_id: null }] })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${scopedToken()}` } })
    expect(res.statusCode).toBe(401)
  })

  it('token contexte cabinet (platform) → claims préservés, pas de guard', async () => {
    const ctx = app.jwt.sign({ sub: 'au1', tenantId: null, schemaName: 'platform', role: 'agency_owner',
      email: 'o@cab.ci', firstName: 'O', lastName: 'W', employeeId: null, actorType: 'agency', agencyId: AG })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${ctx}` } })
    expect(res.statusCode).toBe(200)
    const d = app.jwt.decode(JSON.parse(res.body).token) as Record<string, string>
    expect(d.actorType).toBe('agency')
    expect(d.agencyId).toBe(AG)
    expect(d.schemaName).toBe('platform')
  })

  it('token tenant standard → inchangé (non-régression)', async () => {
    const t = app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_x', role: 'admin',
      email: 'a@x.ci', firstName: 'A', lastName: 'D', employeeId: null })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(200)
    const d = app.jwt.decode(JSON.parse(res.body).token) as Record<string, unknown>
    expect(d.schemaName).toBe('tenant_x')
    expect(d.actorType).toBeUndefined()
  })
})
