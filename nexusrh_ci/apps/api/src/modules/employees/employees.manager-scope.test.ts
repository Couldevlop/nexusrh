/**
 * Périmètre manager côté employés (vue hiérarchique réglable par tenant) +
 * garde-fous du responsable hiérarchique (pas de boucle A → B → A).
 */
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

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@nexusrhci/shared/crypto', () => ({
  encryptIfPresent: vi.fn((v) => v),
  decryptIfPresent: vi.fn((v) => v),
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

const MGR = '11111111-1111-4111-8111-111111111111'
const EMP = '22222222-2222-4222-8222-222222222222'
const SUB = '33333333-3333-4333-8333-333333333333'

function tokenFor(app: FastifyInstance, role: string, employeeId: string | null = null) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: 'tenant_sotra', role,
    email: `${role}@sotra.ci`, firstName: 'Test', lastName: 'User', employeeId,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('GET /employees — manager : filtre de périmètre partagé', () => {
  it('applique le fragment manager-scope (équipe directe + branche si le tenant l’a activée)', async () => {
    queryMock.mockResolvedValue({ rows: [{ c: 0 }] })
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager', MGR)}` },
    })
    expect(res.statusCode).toBe(200)
    const countSql = String(queryMock.mock.calls[0]![0])
    expect(countSql).toContain('e.manager_id = $1')
    expect(countSql).toContain(`mst.manager_scope = 'hierarchy'`)
    expect(queryMock.mock.calls[0]![1]).toEqual([MGR])
  })

  it('fail-closed : manager sans dossier employé → liste vide, sans requête de liste', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup par email
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: [], total: 0 })
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
})

describe('GET /employees/:id — manager', () => {
  const row = { id: EMP, email: 'e@sotra.ci', manager_id: SUB, nni: null, iban: null, hire_date: null }

  it('membre de sa branche (N-2) → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [row] })       // fiche
      .mockResolvedValueOnce({ rows: [{ id: EMP }] }) // isInManagerScope
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'manager', MGR)}` },
    })
    expect(res.statusCode).toBe(200)
    expect(queryMock.mock.calls[1]![1]).toEqual([EMP, MGR])
  })

  it('hors périmètre → 403', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'manager', MGR)}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('PATCH /employees/:id — responsable hiérarchique', () => {
  it('soi-même comme responsable → 422, aucune écriture', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { managerId: EMP },
    })
    expect(res.statusCode).toBe(422)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('un de ses subordonnés comme responsable → 422 (boucle)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SUB }] }) // SUB est dans la branche d'EMP
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { managerId: SUB },
    })
    expect(res.statusCode).toBe(422)
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(String(queryMock.mock.calls[0]![0])).toContain('WITH RECURSIVE')
  })

  it('responsable valide → mise à jour de manager_id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                          // pas de boucle
      .mockResolvedValueOnce({ rows: [{ id: EMP, manager_id: MGR }] }) // UPDATE
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { managerId: MGR },
    })
    expect(res.statusCode).toBe(200)
    const update = queryMock.mock.calls.find(c => String(c[0]).startsWith('UPDATE'))
    expect(String(update?.[0])).toContain('manager_id = $1')
  })

  it('retrait du responsable (null) → accepté sans contrôle de boucle', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP, manager_id: null }] })
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { managerId: null },
    })
    expect(res.statusCode).toBe(200)
    expect(String(queryMock.mock.calls[0]![0])).toMatch(/^UPDATE/)
  })
})

describe('GET /employees/manager-options', () => {
  it('RH → employés actifs, champs minimaux', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: MGR, first_name: 'Awa', last_name: 'Koné', job_title: 'DRH' }] })
    const res = await app.inject({
      method: 'GET', url: '/employees/manager-options',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toContain('is_active = true')
    expect(sql).not.toMatch(/salary|nni|iban/)
  })

  it.each(['manager', 'employee', 'readonly'])('%s → 403', async (role) => {
    const res = await app.inject({
      method: 'GET', url: '/employees/manager-options',
      headers: { authorization: `Bearer ${tokenFor(app, role, MGR)}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
