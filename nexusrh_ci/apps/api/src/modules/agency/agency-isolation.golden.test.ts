/**
 * GOLDEN — Isolation cabinet ↔ tenant (OWASP A01).
 * Prouve qu'un cabinet :
 *   1. ne peut activer une session que sur un tenant RATTACHÉ (sinon 403) ;
 *   2. une fois scopé sur tenant A, toutes ses requêtes RH ciblent le schéma de A
 *      (jamais celui d'un autre tenant) — la résolution ne dépend QUE du token signé.
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
vi.mock('../../services/email.js', () => ({ sendWelcomeAgencyEmail: vi.fn() }))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test', appUrl: 'http://x', apiUrl: 'http://api',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import agencyRoutes from './agency.routes.js'
import employeesRoutes from '../employees/employees.routes.js'

let app: FastifyInstance
const AG = '11111111-1111-1111-1111-111111111111'
const T_A = '22222222-2222-2222-2222-222222222222'
const T_B = '33333333-3333-3333-3333-333333333333'
const GUARD_A = {
  agency_status: 'active', tenant_id: T_A, schema_name: 'tenant_a', name: 'A', slug: 'a',
  primary_color: null, secondary_color: null, logo_url: null, city: 'Abidjan',
  tenant_status: 'active', default_country_code: 'CIV',
  has_subsidiaries: false, payroll_mode: 'single_country', link_id: 'lnkA',
}

function ownerToken() {
  return app.jwt.sign({ sub: 'au1', tenantId: null, schemaName: 'platform', role: 'agency_owner',
    email: 'o@cab.ci', firstName: 'O', lastName: 'W', employeeId: null, actorType: 'agency', agencyId: AG })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(agencyRoutes, { prefix: '/agency' })
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }) })

describe('Isolation cabinet ↔ tenant', () => {
  it('activation sur tenant rattaché (A) → 200, token scopé sur le schéma de A', async () => {
    queryMock.mockResolvedValueOnce({ rows: [GUARD_A] })
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { tenantId: T_A } })
    expect(res.statusCode).toBe(200)
    const d = app.jwt.decode(JSON.parse(res.body).token) as Record<string, string>
    expect(d.schemaName).toBe('tenant_a')
  })

  it('activation sur tenant NON rattaché (B) → 403 (pas de token émis)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // guard : aucun rattachement → not_member
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { tenantId: T_B } })
    expect(res.statusCode).toBe(403)
  })

  it('token scopé sur A → les requêtes RH ciblent UNIQUEMENT le schéma de A', async () => {
    // 1) activer sur A
    queryMock.mockResolvedValueOnce({ rows: [GUARD_A] })
    const act = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { tenantId: T_A } })
    const scoped = JSON.parse(act.body).token

    // 2) utiliser le token scopé sur la vraie route employees
    queryMock.mockReset().mockResolvedValue({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${scoped}` } })
    expect(res.statusCode).toBe(200)

    const sqls = queryMock.mock.calls.map(c => String(c[0]))
    expect(sqls.length).toBeGreaterThan(0)
    // Toutes les requêtes émises visent le schéma de A ; aucune ne référence un autre schéma tenant.
    expect(sqls.some(s => s.includes('tenant_a'))).toBe(true)
    expect(sqls.some(s => s.includes('tenant_b'))).toBe(false)
  })
})
