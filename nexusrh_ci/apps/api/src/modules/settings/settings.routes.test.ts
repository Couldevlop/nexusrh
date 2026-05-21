import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../db/provisioning.js', () => ({
  provisionTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: vi.fn().mockResolvedValue({ sent: true }),
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
import settingsRoutes from './settings.routes.js'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'

function tokenFor(app: FastifyInstance, role: string, tenantId: string | null = 't1') {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId, schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

describe('PATCH /settings/tenant — Zod + audit (OWASP A03 + A09)', () => {
  it('refuse champs inconnus (.strict)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'OK', isAdmin: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse primary_color au format libre (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { primary_color: 'red' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse at_rate hors plage CNPS CI (0.02-0.05) — 400', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { at_rate: 0.5 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un hr_manager NE PEUT PAS modifier le tenant (403)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Hack' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('admin modifie + trace audit settings.tenant_updated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 't1', name: 'Sotra v2', at_rate: '0.03' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Sotra v2', at_rate: 0.03, primary_color: '#E85D04' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.tenant_updated')
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.modifiedFields).toEqual(expect.arrayContaining(['name', 'at_rate', 'primary_color']))
  })
})

describe('POST /settings/legal-entities — Zod + audit + bornes AT (OWASP A03 + A04 + A09)', () => {
  it('refuse name vide (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse at_rate hors plage 0.02-0.05 (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Filiale Plateau', at_rate: 0.1 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse legal_form hors énum (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'F', legal_form: 'INC' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('création OK + audit settings.legal_entity_created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'le-1', name: 'Filiale Cocody', at_rate: '0.03' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Filiale Cocody', at_rate: 0.03, cnps_number: 'CI-123-X' },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.legal_entity_created')
  })
})

describe('PATCH /settings/legal-entities/:id — UUID + audit', () => {
  it('refuse id non-UUID (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/legal-entities/not-uuid',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('update OK + audit settings.legal_entity_updated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, at_rate: '0.04' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: `/settings/legal-entities/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { at_rate: 0.04 },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.legal_entity_updated')
  })
})

describe('POST /settings/payroll-rules — Zod + audit (taux cotisation critique)', () => {
  it('refuse type hors énum (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/payroll-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '9999', name: 'Bonus', type: 'magic' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('création OK + audit settings.payroll_rule_created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'rule-1', code: '4500', name: 'CNPS RB' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/payroll-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '4500', name: 'CNPS Retraite Bonifié', type: 'employee_contribution', rate: 0.065 },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.payroll_rule_created')
  })
})

describe('POST /settings/import/:type — cap CSV + whitelist + audit (OWASP A03 + A04 + A09)', () => {
  it('refuse type hors whitelist (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { headers: ['email'], rows: [['a@b.ci']] },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Type d\'import invalide')
  })

  it('refuse > 10 000 lignes (413)', async () => {
    const token = tokenFor(app, 'admin')
    const tooManyRows = Array.from({ length: 10_001 }, (_, i) => [`emp${i}@sotra.ci`])
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees',
      headers: { authorization: `Bearer ${token}` },
      payload: { headers: ['email'], rows: tooManyRows },
    })
    expect(res.statusCode).toBe(413)
  })

  it('refuse > 50 colonnes (413)', async () => {
    const token = tokenFor(app, 'admin')
    const tooManyHeaders = Array.from({ length: 51 }, (_, i) => `col${i}`)
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees',
      headers: { authorization: `Bearer ${token}` },
      payload: { headers: tooManyHeaders, rows: [['x']] },
    })
    expect(res.statusCode).toBe(413)
  })

  it('import departments OK + audit settings.import_completed', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing department
      .mockResolvedValueOnce({ rows: [] }) // INSERT department
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/departments',
      headers: { authorization: `Bearer ${token}` },
      payload: { headers: ['nom', 'code'], rows: [['Logistique', 'LOG']] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.inserted).toBe(1)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.import_completed')
  })
})
