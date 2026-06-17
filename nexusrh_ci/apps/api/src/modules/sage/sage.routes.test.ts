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
import sageRoutes from './sage.routes.js'

const SCHEMA = 'tenant_sotra'
function token(app: FastifyInstance, role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}
const CFG = { id: 1, enabled: true, separator: 'semicolon', include_header: true, matricule_source: 'employee_number' }

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(sageRoutes, { prefix: '/sage' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('OWASP A01 — réservé admin/hr_manager', () => {
  it('hr_officer ne peut pas lire la config (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/sage/config', headers: { authorization: `Bearer ${token(app, 'hr_officer')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('hr_manager lit la config (200, défauts si absente)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/sage/config', headers: { authorization: `Bearer ${token(app, 'hr_manager')}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.separator).toBe('semicolon')
  })
})

describe('OWASP A03 — config bornée', () => {
  it('séparateur inconnu → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/sage/config',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { enabled: true, separator: 'spaces', includeHeader: true, matriculeSource: 'id' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('config valide → upsert + audit (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'PUT', url: '/sage/config',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { enabled: true, separator: 'comma', includeHeader: false, matriculeSource: 'employee_number' },
    })
    expect(res.statusCode).toBe(200)
    const upsert = queryMock.mock.calls.find((c) => String(c[0]).includes('sage_config') && String(c[0]).includes('INSERT'))
    expect(upsert?.[1]).toEqual([true, 'comma', false, 'employee_number'])
  })
})

describe('Exports SAGE (fichier CSV)', () => {
  it('employés : CSV téléchargeable avec en-tête SAGE + BOM', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [CFG] }) // loadConfig
      .mockResolvedValueOnce({ rows: [{ matricule: 'M001', last_name: 'Kouassi', first_name: 'Jean', base_salary: 250000 }], rowCount: 1 })
    const res = await app.inject({ method: 'GET', url: '/sage/export/employees.csv', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('sage_employees.csv')
    expect(res.body).toContain('Matricule;Nom;Prenom')
    expect(res.body).toContain('M001;Kouassi;Jean')
    expect(res.body.charCodeAt(0)).toBe(0xfeff) // BOM
  })
  it('éléments variables sans période → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [CFG] })
    const res = await app.inject({ method: 'GET', url: '/sage/export/variable-elements.csv', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })
  it('paie d\'une période : CSV + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [CFG] })
      .mockResolvedValueOnce({ rows: [{ matricule: 'M001', month: '2024-12', gross_salary: 250000, net_payable: 210000 }], rowCount: 1 })
    const res = await app.inject({ method: 'GET', url: '/sage/export/payroll.csv?period=2024-12', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('sage_payroll_2024-12.csv')
    expect(res.body).toContain('NetAPayer')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('sage.export_payroll')
  })
})
