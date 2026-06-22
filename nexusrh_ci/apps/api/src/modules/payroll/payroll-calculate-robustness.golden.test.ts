/**
 * GOLDEN — Robustesse de la simulation de paie POST /payroll/calculate.
 *
 * Régression corrigée : « Internal Server Error pour une entreprise qui lance la
 * simulation de paie avec un employé ». Le handler ne validait pas le corps
 * (employeeId non-UUID → erreur SQL uuid → 500) et n'avait pas de try/catch
 * englobant. Ces tests verrouillent le comportement : entrées invalides → 4xx
 * clairs, jamais de 500 opaque ; cas nominal CI → 200 avec bulletin.
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
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: '', model: 'test', maxTokens: 1024 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import payrollRoutes from './payroll.routes.js'

const TENANT = 'tenant_sotra'
const EMP = '11111111-1111-1111-1111-111111111111'

function token(app: FastifyInstance, role = 'hr_manager') {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` })

// Lignes DB réutilisées
const empRow = {
  id: EMP, base_salary: '250000', marital_status: 'single', children_count: 0,
  first_name: 'Kouassi', last_name: 'Jean', cnps_number: 'CI-1', nni: 'enc',
  mobile_money_provider: 'wave', mobile_money_phone: '+22507', hire_date: '2022-01-01',
  legal_entity_id: null,
}
const tenantRow = { id: 't1', at_rate: '0.020', has_subsidiaries: false, default_country_code: 'CIV' }

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('POST /payroll/calculate — validation du corps (anti-500)', () => {
  it('employeeId non-UUID → 400 (jamais d\'erreur SQL uuid en 500)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: auth(token(app)), payload: { employeeId: 'pas-un-uuid', month: '2024-12' },
    })
    expect(res.statusCode).toBe(400)
    // aucune requête SQL ne doit avoir été tentée avec un id invalide
    expect(queryMock.mock.calls.some(c => /FROM "tenant_sotra"\.employees/.test(c[0]))).toBe(false)
  })

  it('month mal formé → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: auth(token(app)), payload: { employeeId: EMP, month: '12-2024' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('employé introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT employees vide
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: auth(token(app)), payload: { employeeId: EMP, month: '2024-12' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('salaire de base à 0 → 422 explicite (au lieu d\'un bulletin NaN)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...empRow, base_salary: '0' }] })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: auth(token(app)), payload: { employeeId: EMP, month: '2024-12' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatch(/salaire/i)
  })

  it('cas nominal CI → 200 avec bulletin chiffré (CNPS + ITS)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [empRow] })       // employees
      .mockResolvedValueOnce({ rows: [tenantRow] })    // platform.tenants
    // pay_periods + absences → défaut {rows:[]}
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: auth(token(app)), payload: { employeeId: EMP, month: '2024-12' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.currency).toBe('XOF')
    expect(body.result.netPayable).toBeGreaterThan(0)
    expect(body.result.grossSalary).toBeGreaterThan(0)
    expect(Number.isFinite(body.result.netPayable)).toBe(true)
  })

  it('refuse un rôle non autorisé (employee) → 403', async () => {
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: auth(token(app, 'employee')), payload: { employeeId: EMP, month: '2024-12' },
    })
    expect(res.statusCode).toBe(403)
  })
})
