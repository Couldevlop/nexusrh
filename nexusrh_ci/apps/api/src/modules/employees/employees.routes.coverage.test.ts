/**
 * COUVERTURE — chemins non couverts par les tests existants de employees.routes :
 *   - GET /employees : liste avec recherche, filtre département, filtre équipe
 *     manager (avec et sans employé manager trouvé), filtre isActive=false ;
 *   - GET /employees/:id : 404, déchiffrement NNI/IBAN, refus employee sur autrui ;
 *   - PATCH /employees/:id : « Aucun champ valide » (400), 404 si UPDATE vide ;
 *   - GET /employees/:id/check-delete : actions en attente, vide, catch 500, RBAC ;
 *   - DELETE /employees/:id : catch 500 ;
 *   - GET /employees/departments : liste + RBAC.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore:  {},
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/crypto.js', () => ({
  encryptIfPresent: vi.fn((v: string | null | undefined) => (v ? `enc:${v}` : null)),
  decryptIfPresent: vi.fn((v: string | null | undefined) => (v?.startsWith('enc:') ? v.slice(4) : v ?? null)),
}))

vi.mock('../../services/integrations.service.js', () => ({
  emitIntegrationEvent: vi.fn(),
}))

vi.mock('../../services/onboarding.service.js', () => ({
  autoStartOnboarding: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

const TENANT_SCHEMA = 'tenant_sotra'
const EMP = '11111111-1111-1111-1111-111111111111'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{
  sub: string; email: string; employeeId: string
}> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? 'u-' + role,
    tenantId: 't1',
    schemaName: TENANT_SCHEMA,
    role,
    email: opts.email ?? `${role}@sotra.ci`,
    firstName: 'Test',
    lastName:  'User',
    employeeId: opts.employeeId ?? null,
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

beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }) })

describe('GET /employees — liste, filtres et équipe manager', () => {
  it('renvoie la liste (admin, sans filtres) avec total', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: EMP, first_name: 'Marie', last_name: 'Konaté', department_name: 'RH' }],
      rowCount: 1,
    })
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(1)
    expect(body.data).toHaveLength(1)
  })

  it('applique recherche + filtre département + isActive=false', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const res = await app.inject({
      method: 'GET',
      url: `/employees?search=KON&departmentId=${EMP}&isActive=false`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const sql = String(queryMock.mock.calls[0]?.[0])
    // isActive=false → pas de clause is_active = true
    expect(sql).not.toContain('e.is_active = true')
    expect(sql).toContain('e.department_id = $')
    expect(sql).toContain('lower(e.first_name) LIKE')
    // search converti en minuscules avec wildcards
    expect(queryMock.mock.calls[0]?.[1]).toContain('%kon%')
  })

  it('un manager voit uniquement son équipe (manager_id filtré)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'mgr-emp-1' }] })   // SELECT id FROM employees WHERE email
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // SELECT liste filtrée
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const listCall = queryMock.mock.calls.find((c) => String(c[0]).includes('ORDER BY e.last_name'))
    expect(String(listCall?.[0])).toContain('e.manager_id = $')
    expect(listCall?.[1]).toContain('mgr-emp-1')
  })

  it('un manager sans fiche employée → pas de filtre équipe ajouté', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                       // SELECT id (aucun employé lié)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // liste
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const listCall = queryMock.mock.calls.find((c) => String(c[0]).includes('ORDER BY e.last_name'))
    expect(String(listCall?.[0])).not.toContain('e.manager_id = $')
  })
})

describe('GET /employees/:id — restitution et accès', () => {
  it('404 si employé introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('déchiffre NNI et IBAN avant restitution (admin)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: EMP, email: 'x@sotra.ci', first_name: 'M', last_name: 'T',
      nni: 'enc:CI123', iban: 'enc:CI93XYZ',
    }] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const emp = JSON.parse(res.body).data
    expect(emp.nni).toBe('CI123')
    expect(emp.iban).toBe('CI93XYZ')
  })

  it('un employee ne peut pas voir un autre employé (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: EMP, email: 'autre@sotra.ci', first_name: 'A', last_name: 'B',
    }] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { email: 'moi@sotra.ci', employeeId: EMP })}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('PATCH /employees/:id — branches résiduelles', () => {
  it('hr_manager sans aucun champ → 400 « Aucun champ valide »', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Aucun champ valide')
  })

  it('400 si le body échoue la validation Zod (clé inconnue, .strict)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { champInconnu: 'x' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Champs invalides')
  })

  it('400 si un champ a un type invalide (baseSalary string)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { baseSalary: 'beaucoup' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si l\'UPDATE ne retourne aucune ligne', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE RETURNING vide
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { jobTitle: 'Chef de ligne' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /employees/:id/check-delete', () => {
  it('canDelete=false avec actions en attente (absences + frais)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // absences
      .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // expenses
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}/check-delete`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.canDelete).toBe(false)
    expect(body.pendingActions).toHaveLength(2)
  })

  it('canDelete=true si rien en attente', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}/check-delete`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.canDelete).toBe(true)
    expect(body.pendingActions).toHaveLength(0)
  })

  it('500 si une requête échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}/check-delete`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(500)
  })

  it('refuse un hr_officer (RBAC admin/hr_manager, 403)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP}/check-delete`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('DELETE /employees/:id — catch 500', () => {
  it('500 si le snapshot échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({
      method: 'DELETE', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('GET /employees/departments', () => {
  it('renvoie la liste des départements (admin)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { id: 'd1', name: 'Exploitation', manager_first_name: 'Jean', manager_last_name: 'Paul' },
    ] })
    const res = await app.inject({
      method: 'GET', url: '/employees/departments',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('refuse un employee (RBAC, 403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/employees/departments',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { employeeId: EMP })}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
