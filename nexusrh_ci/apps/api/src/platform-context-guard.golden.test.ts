/**
 * GOLDEN — Cloisonnement contexte plateforme ↔ routes tenant (OWASP A01).
 * Un token en contexte plateforme (schemaName='platform' : super_admin ou cabinet
 * hors session scopée) ne doit JAMAIS atteindre une route tenant (sinon le
 * handler interroge platform.<table_tenant> → 500). Il reçoit un 403 net.
 * Les tokens tenant (schemaName='tenant_x') ne sont pas affectés.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.hoisted(() => {
  process.env.NODE_ENV = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET = 'guard-golden-secret-minimum-32-characters!!'
  process.env.LOG_LEVEL = 'silent'
})
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn().mockResolvedValue({ rows: [] }) }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn(), connect: vi.fn() })) }))
vi.mock('./services/redis.js', () => ({
  redis: { quit: vi.fn(), disconnect: vi.fn() },
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore: {},
}))

import { buildApp } from './app.js'

let app: FastifyInstance
const base = { sub: '00000000-0000-0000-0000-000000000000', email: 'x@y.ci', firstName: 'A', lastName: 'B', employeeId: null }
const platformTok = () => app.jwt.sign({ ...base, tenantId: null, schemaName: 'platform', role: 'super_admin' })
const agencyCtxTok = () => app.jwt.sign({ ...base, tenantId: null, schemaName: 'platform', role: 'agency_owner', actorType: 'agency', agencyId: 'a1' })
const tenantTok = () => app.jwt.sign({ ...base, tenantId: 't1', schemaName: 'tenant_test', role: 'admin' })

beforeAll(async () => { app = await buildApp(); await app.ready() })
afterAll(async () => { await app.close() })

const TENANT_ROUTES = ['/training/catalog', '/absences/types', '/careers/skills', '/payroll/my-payslips']

describe('Garde contexte plateforme → routes tenant', () => {
  for (const url of TENANT_ROUTES) {
    it(`${url} : token plateforme (super_admin) => 403`, async () => {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${platformTok()}` } })
      expect(res.statusCode).toBe(403)
    })
    it(`${url} : token cabinet (contexte, non scopé) => 403`, async () => {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${agencyCtxTok()}` } })
      expect(res.statusCode).toBe(403)
    })
  }

  it('route tenant + token tenant valide => atteint le handler (pas 403/500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/training/catalog', headers: { authorization: `Bearer ${tenantTok()}` } })
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).toBeLessThan(500)
  })

  it('route tenant sans token => 401 (le garde laisse la route gérer)', async () => {
    const res = await app.inject({ method: 'GET', url: '/training/catalog' })
    expect(res.statusCode).toBe(401)
  })

  it('routes plateforme/agency non affectées par le garde', async () => {
    // super_admin sur /platform/* : pas bloqué par le garde (path exclu)
    const r1 = await app.inject({ method: 'GET', url: '/platform/dashboard', headers: { authorization: `Bearer ${platformTok()}` } })
    expect(r1.statusCode).not.toBe(403)
    // cabinet sur /agency/* : pas bloqué
    const r2 = await app.inject({ method: 'GET', url: '/agency/my-tenants', headers: { authorization: `Bearer ${agencyCtxTok()}` } })
    expect(r2.statusCode).not.toBe(403)
  })
})
