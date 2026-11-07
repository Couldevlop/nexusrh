/**
 * Traçage effectif des requêtes d'un habilité (tâche 13, amendement 04/11/2026).
 *
 * Le classement est vérifié à côté (hab-trace.test.ts) ; ici on vérifie qu'il
 * est réellement BRANCHÉ : un hook de réponse du plugin d'authentification
 * écrit la trace pour l'utilisateur habilité, et pour lui seul. Sans ce banc,
 * la fonction de classement pourrait rester correcte et muette.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
  setTokenEpoch: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.unmock('../../services/habilitation.service.js')

import authPlugin from '../../plugins/auth.js'
import { requestHrScope } from '../../utils/hr-scope.js'
import { isSelfAction } from '../../services/habilitation.service.js'
import { maskFields } from '../../services/sensitive-mask.js'

const SCHEMA = 'tenant_sotra'
const SIEGE = '22222222-2222-4222-8222-222222222222'
const FILIALE = '33333333-3333-4333-8333-333333333333'
const ENTITY = '44444444-4444-4444-8444-444444444444'
const USER = '66666666-6666-4666-8666-666666666666'
const EMP = '77777777-7777-4777-8777-777777777777'

interface Store {
  permissions: string[]
  kind: 'siege' | 'entity'
  subgroup: string
  sensitive: boolean
  audits: Array<{ action: string; entityId: string | null; changes: Record<string, unknown> }>
}
let store: Store
let app: FastifyInstance

function token(sub: string, role: string): string {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: EMP,
  })
}
const auth = (sub: string, role: string) => ({ authorization: `Bearer ${token(sub, role)}` })

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  // Routes de test calquées sur les vraies URLs (la grille les résout par
  // préfixe) : liste, lecture par id, écriture, refus de périmètre.
  app.get('/employees', { preHandler: [app.authorize('hr_manager', 'hr_officer', 'admin')] },
    async () => ({ data: [] }))
  app.post('/employees', { preHandler: [app.authorize('hr_manager', 'hr_officer', 'admin')] },
    async (_req, reply) => reply.status(201).send({ data: { id: EMP } }))
  app.get('/employees/:id', { preHandler: [app.authorize('hr_manager', 'hr_officer', 'admin')] },
    async (request) => {
      const row = maskFields({ id: EMP, base_salary: 500_000 }, ['base_salary'], request.hab ?? null)
      return { data: row }
    })
  app.get('/employees/:id/check-delete', { preHandler: [app.authorize('hr_manager', 'hr_officer', 'admin')] },
    async (request, reply) => {
      // Périmètre consulté puis ligne hors périmètre : 404 identique à un
      // vrai 404 (aucune fuite d'existence), la cause reste dans la trace.
      await requestHrScope(request, 'e')
      return reply.status(404).send({ error: 'Employé introuvable' })
    })
  app.patch('/employees/:id', { preHandler: [app.authorize('hr_manager', 'hr_officer', 'admin')] },
    async (request, reply) => {
      if (isSelfAction(request, EMP)) return reply.status(403).send({ error: 'Action interdite sur votre propre dossier' })
      return reply.send({ data: { id: EMP } })
    })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  store = {
    permissions: ['employees:view', 'employees:create', 'employees:update', 'employees:delete'],
    kind: 'siege', subgroup: SIEGE, sensitive: true, audits: [],
  }
  queryMock.mockReset()
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const q = String(sql).replace(/\s+/g, ' ')
    if (q.includes('platform.tenants')) return { rows: [{ enforced: true }] }
    if (q.includes('INTERSECT')) {
      return {
        rows: [{
          user_id: String(params[0]), subgroup_id: store.subgroup, kind: store.kind,
          legal_entity_id: store.kind === 'entity' ? ENTITY : null,
          permissions: store.sensitive ? [...store.permissions, 'sensitive_data'] : store.permissions,
          active: true, self_employee_id: EMP,
        }],
      }
    }
    if (q.includes('is_head_office = true')) return { rows: [] }
    if (q.includes('INSERT INTO') && q.includes('audit_log')) {
      store.audits.push({
        action: String(params[1]),
        entityId: params[3] === null ? null : String(params[3]),
        changes: JSON.parse(String(params[4])) as Record<string, unknown>,
      })
      return { rows: [] }
    }
    return { rows: [] }
  })
})

/** Laisse le hook onResponse (non bloquant) écrire avant l'assertion. */
const settled = () => new Promise((r) => setImmediate(r))

describe('traçage des requêtes d\'un habilité', () => {
  it('une lecture de liste est tracée (allowed), filtres par leurs noms', async () => {
    const res = await app.inject({ method: 'GET', url: '/employees?search=kone&page=2', headers: auth(USER, 'hr_manager') })
    expect(res.statusCode).toBe(200)
    await settled()
    const t = store.audits.find((a) => a.action === 'hr.employees.view')
    expect(t).toBeDefined()
    expect(t?.changes).toMatchObject({ result: 'allowed', subgroupId: SIEGE })
    expect(t?.changes.filters).toEqual(['search', 'page'])
    expect(JSON.stringify(t?.changes)).not.toContain('kone')
  })

  it('une écriture est tracée sans aucun élément du body', async () => {
    const res = await app.inject({
      method: 'POST', url: '/employees', headers: auth(USER, 'hr_manager'),
      payload: { firstName: 'Awa', lastName: 'Koné', baseSalary: 450_000 },
    })
    expect(res.statusCode).toBe(201)
    await settled()
    const t = store.audits.find((a) => a.action === 'hr.employees.create')
    expect(t?.changes).toMatchObject({ result: 'allowed' })
    const dump = JSON.stringify(t)
    expect(dump).not.toContain('Awa')
    expect(dump).not.toContain('450000')
  })

  it('un 403 de la grille est tracé denied_permission', async () => {
    store.permissions = ['absences:view']
    const res = await app.inject({ method: 'POST', url: '/employees', headers: auth(USER, 'hr_manager') })
    expect(res.statusCode).toBe(403)
    await settled()
    expect(store.audits.find((a) => a.action === 'hr.employees.create')?.changes)
      .toMatchObject({ result: 'denied_permission' })
  })

  it('un 404 de périmètre est tracé denied_scope, la réponse reste un 404 nu', async () => {
    store.kind = 'entity'
    store.subgroup = FILIALE
    const res = await app.inject({ method: 'GET', url: `/employees/${EMP}/check-delete`, headers: auth(USER, 'hr_manager') })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Employé introuvable' })
    await settled()
    expect(store.audits.find((a) => a.action === 'hr.employees.delete')?.changes)
      .toMatchObject({ result: 'denied_scope' })
  })

  it('un 404 sans restriction de périmètre n\'est pas un refus de périmètre', async () => {
    // RH « toutes les filiales » : le fragment de périmètre vaut TRUE, donc un
    // 404 ne peut pas venir du périmètre — c'est un vrai introuvable.
    store.permissions = [...store.permissions, 'all_entities']
    const res = await app.inject({ method: 'GET', url: `/employees/${EMP}/check-delete`, headers: auth(USER, 'hr_manager') })
    expect(res.statusCode).toBe(404)
    await settled()
    expect(store.audits.find((a) => a.action === 'hr.employees.delete')?.changes)
      .toMatchObject({ result: 'allowed' })
  })

  it('le refus « son propre dossier » est tracé denied_self', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/employees/${EMP}`, headers: auth(USER, 'hr_manager'), payload: {} })
    expect(res.statusCode).toBe(403)
    await settled()
    expect(store.audits.find((a) => a.action === 'hr.employees.update')?.changes)
      .toMatchObject({ result: 'denied_self' })
  })

  it('une réponse masquée est tracée masked, avec les noms des champs cachés', async () => {
    store.sensitive = false
    const res = await app.inject({ method: 'GET', url: `/employees/${EMP}`, headers: auth(USER, 'hr_manager') })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.base_salary).toBeNull()
    await settled()
    const t = store.audits.find((a) => a.action === 'hr.employees.view')
    expect(t?.changes).toMatchObject({ result: 'masked', maskedFields: ['base_salary'] })
    expect(t?.entityId).toBe(EMP)
  })

  it('un admin de tenant (hors grille) n\'est pas tracé par ce hook', async () => {
    const res = await app.inject({ method: 'GET', url: '/employees', headers: auth(USER, 'admin') })
    expect(res.statusCode).toBe(200)
    await settled()
    expect(store.audits.filter((a) => a.action.startsWith('hr.'))).toEqual([])
  })
})
