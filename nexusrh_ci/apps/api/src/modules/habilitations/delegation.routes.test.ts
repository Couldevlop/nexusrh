/**
 * Délégation temporaire d'habilitation — routes (tâche 12).
 *
 * Ce que ce banc protège : une délégation est une procuration sur des DROITS.
 * Sans borne de durée elle devient une habilitation permanente que personne ne
 * relit ; sans borne de périmètre elle élargit les droits du délégant ; et si
 * un délégataire pouvait déléguer à son tour, la chaîne deviendrait
 * intraçable. Les trois refus sont vérifiés ici, pas seulement l'acceptation.
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
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.unmock('../../services/habilitation.service.js')

import authPlugin from '../../plugins/auth.js'
import delegationRoutes, { activeDelegation } from './delegation.routes.js'

const SCHEMA = 'tenant_sotra'
const GROUP = '11111111-1111-4111-8111-111111111111'
const SIEGE = '22222222-2222-4222-8222-222222222222'
const FILIALE = '33333333-3333-4333-8333-333333333333'
const AUTRE_GROUPE = '44444444-4444-4444-8444-444444444444'
const DRH = '66666666-6666-4666-8666-666666666666'
const ADJOINT = '77777777-7777-4777-8777-777777777777'
const ADMIN = '99999999-9999-4999-8999-999999999999'
const DELEG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function token(app: FastifyInstance, sub: string, role: string): string {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}
const auth = (app: FastifyInstance, sub: string, role: string) => ({ authorization: `Bearer ${token(app, sub, role)}` })

interface Store {
  /** Droits du demandeur (contexte simulé) et périmètre de son sous-groupe. */
  requesterPermissions: string[]
  requesterSubgroup: string
  requesterKind: 'siege' | 'entity'
  /** Sous-groupe + groupe du délégataire visé ; `null` = aucune affectation. */
  delegateSubgroup: { id: string; groupId: string } | null
  /** Délégation active renvoyée pour le demandeur (chaîne de délégation). */
  delegationRows: Array<Record<string, unknown>>
  audits: Array<{ action: string; changes: Record<string, unknown> }>
  inserts: Array<{ sql: string; params: unknown[] }>
  revokedRowCount: number
}
let store: Store
let app: FastifyInstance

function inDays(n: number): string {
  return new Date(Date.now() + n * 24 * 3600 * 1000).toISOString()
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(delegationRoutes, { prefix: '/habilitations' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  store = {
    requesterPermissions: ['manage_habilitations', 'employees:view'],
    requesterSubgroup: SIEGE,
    requesterKind: 'siege',
    delegateSubgroup: { id: FILIALE, groupId: GROUP },
    delegationRows: [],
    audits: [],
    inserts: [],
    revokedRowCount: 1,
  }
  queryMock.mockReset()
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const q = String(sql).replace(/\s+/g, ' ')
    if (q.includes('platform.tenants')) return { rows: [{ enforced: true }] }
    // Contexte d'habilitation du demandeur (INTERSECT fiche ∩ plafond).
    if (q.includes('INTERSECT')) {
      const asked = String(params[0])
      const perms = asked === DRH ? store.requesterPermissions : []
      return {
        rows: [{
          user_id: asked, subgroup_id: store.requesterSubgroup, kind: store.requesterKind,
          legal_entity_id: null, permissions: perms, active: true, self_employee_id: null,
        }],
      }
    }
    if (q.includes('audit_log')) {
      store.audits.push({ action: String(params[1]), changes: JSON.parse(String(params[4])) as Record<string, unknown> })
      return { rows: [] }
    }
    // Lecture des délégations actives (la route les consulte pour refuser la
    // sous-délégation, et `activeDelegation` les expose au circuit de fiche).
    if (q.includes('hab_delegations') && q.includes('now() BETWEEN')) {
      return { rows: store.delegationRows }
    }
    // Groupe du sous-groupe du délégant (lecture seule sur hab_subgroups).
    if (q.includes('FROM') && q.includes('hab_subgroups sg') && !q.includes('hab_assignments')) {
      return { rows: [{ group_id: GROUP }] }
    }
    // Périmètre du délégataire : son sous-groupe et le groupe de celui-ci.
    if (q.includes('hab_assignments') && q.includes('group_id')) {
      return { rows: store.delegateSubgroup ? [{ subgroup_id: store.delegateSubgroup.id, group_id: store.delegateSubgroup.groupId }] : [] }
    }
    if (q.includes('INSERT INTO') && q.includes('hab_delegations')) {
      store.inserts.push({ sql: q, params })
      return { rows: [{ id: DELEG, delegate_id: params[1], ends_at: params[3] }] }
    }
    if (q.includes('UPDATE') && q.includes('hab_delegations')) {
      return { rows: store.revokedRowCount > 0 ? [{ id: DELEG }] : [], rowCount: store.revokedRowCount }
    }
    if (q.includes('FROM') && q.includes('hab_delegations')) {
      return { rows: [{ id: DELEG, delegator_id: DRH, delegate_id: ADJOINT, subgroup_id: null, ends_at: inDays(10), revoked_at: null }] }
    }
    return { rows: [] }
  })
})

describe('POST /habilitations/delegations — bornes obligatoires', () => {
  it('sans jeton : 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/habilitations/delegations', payload: { delegateId: ADJOINT, endsAt: inDays(10) } })
    expect(res.statusCode).toBe(401)
  })

  it('sans date de fin : 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT },
    })
    expect(res.statusCode).toBe(400)
  })

  it('une date de fin passée : 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(-1) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/futur/i)
  })

  it('au-delà de 90 jours : 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(91) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/90/)
  })

  it('à 90 jours pile : accepté', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(89) },
    })
    expect(res.statusCode).toBe(201)
    expect(store.audits.map((a) => a.action)).toContain('habilitation.delegation.created')
  })
})

describe('POST /habilitations/delegations — périmètre et chaîne', () => {
  it('un utilisateur sans « gérer les habilitations » : 403', async () => {
    store.requesterPermissions = ['employees:view']
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(10) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un délégataire ne peut pas déléguer à son tour : 403', async () => {
    // Il n'a pas la case lui-même : il n'agit QUE par la délégation reçue.
    store.requesterPermissions = ['employees:view']
    store.delegationRows = [{ id: DELEG, delegator_id: ADMIN, subgroup_id: null, ends_at: inDays(5) }]
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(5) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/délégataire/i)
  })

  it('se déléguer à soi-même : 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: DRH, endsAt: inDays(5) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un délégataire sans affectation : 403', async () => {
    store.delegateSubgroup = null
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(5) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un délégataire hors du groupe du délégant siège : 403', async () => {
    store.delegateSubgroup = { id: FILIALE, groupId: AUTRE_GROUPE }
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(5) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un délégant de filiale ne délègue que dans SON sous-groupe', async () => {
    store.requesterKind = 'entity'
    store.requesterSubgroup = FILIALE
    store.delegateSubgroup = { id: SIEGE, groupId: GROUP }
    const refus = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(5) },
    })
    expect(refus.statusCode).toBe(403)

    store.delegateSubgroup = { id: FILIALE, groupId: GROUP }
    const ok = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(5) },
    })
    expect(ok.statusCode).toBe(201)
    // Le périmètre délégué est celui du délégant, jamais plus large.
    expect(store.inserts.at(-1)?.params[2]).toBe(FILIALE)
  })

  it('un délégant siège délègue son périmètre de groupe (sous-groupe nul)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/delegations',
      headers: auth(app, DRH, 'hr_manager'), payload: { delegateId: ADJOINT, endsAt: inDays(5) },
    })
    expect(res.statusCode).toBe(201)
    expect(store.inserts.at(-1)?.params[2]).toBeNull()
  })
})

describe('DELETE /habilitations/delegations/:id', () => {
  it('révoque et audite', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/habilitations/delegations/${DELEG}`,
      headers: auth(app, DRH, 'hr_manager'),
    })
    expect(res.statusCode).toBe(200)
    expect(store.audits.map((a) => a.action)).toContain('habilitation.delegation.revoked')
  })

  it('une délégation qui n\'est pas la sienne : 404', async () => {
    store.revokedRowCount = 0
    const res = await app.inject({
      method: 'DELETE', url: `/habilitations/delegations/${DELEG}`,
      headers: auth(app, DRH, 'hr_manager'),
    })
    expect(res.statusCode).toBe(404)
  })

  it('identifiant non-UUID : 400, aucune requête', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/habilitations/delegations/pas-un-uuid',
      headers: auth(app, DRH, 'hr_manager'),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('activeDelegation — l\'expiration ne dépend d\'aucun job', () => {
  it('filtre sur la fenêtre de validité et la révocation, dans le SQL', async () => {
    store.delegationRows = [{ id: DELEG, delegator_id: DRH, subgroup_id: FILIALE, ends_at: inDays(3) }]
    const d = await activeDelegation(SCHEMA, ADJOINT)
    expect(d).toEqual({ id: DELEG, delegatorId: DRH, subgroupId: FILIALE, endsAt: expect.any(String) })
    const sql = queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ')).find((s) => s.includes('hab_delegations'))
    expect(sql).toContain('now() BETWEEN')
    expect(sql).toContain('revoked_at IS NULL')
  })

  it('aucune délégation en cours : null', async () => {
    store.delegationRows = []
    expect(await activeDelegation(SCHEMA, ADJOINT)).toBeNull()
  })

  it('un schéma sans la table ne fait pas échouer l\'appelant', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }))
    expect(await activeDelegation(SCHEMA, ADJOINT)).toBeNull()
  })
})
