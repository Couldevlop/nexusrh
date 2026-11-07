/**
 * Fiche d'habilitation — routes (tâche 9).
 *
 * Ce qui est vérifié ici, et nulle part ailleurs : les routes du circuit sont
 * ouvertes à TOUT utilisateur authentifié du tenant (un manager validateur n'a
 * aucune case de la grille), et c'est le service qui refuse quiconque n'est pas
 * l'acteur attendu. Un test qui n'ouvrirait ces routes qu'aux rôles RH
 * laisserait le circuit sans validateur.
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
import ficheRoutes from './fiche.routes.js'

const SCHEMA = 'tenant_sotra'
const SIEGE = '22222222-2222-4222-8222-222222222222'
const TARGET = '55555555-5555-4555-8555-555555555555'
const DRH = '66666666-6666-4666-8666-666666666666'
const N1 = '77777777-7777-4777-8777-777777777777'
const N2 = '88888888-8888-4888-8888-888888888888'
const ADMIN = '99999999-9999-4999-8999-999999999999'
const FICHE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function token(app: FastifyInstance, sub: string, role: string): string {
  return app.jwt.sign({ sub, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}
const auth = (app: FastifyInstance, sub: string, role: string) => ({ authorization: `Bearer ${token(app, sub, role)}` })

interface Store {
  /** Droits du demandeur courant (contexte d'habilitation simulé). */
  requesterPermissions: string[]
  ficheStatus: string
  ficheCreatedBy: string
  lastListSql: string
}
let store: Store

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(ficheRoutes, { prefix: '/habilitations' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  store = {
    requesterPermissions: ['manage_habilitations', 'employees:view'],
    ficheStatus: 'n1', ficheCreatedBy: DRH, lastListSql: '',
  }
  queryMock.mockReset()
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const q = String(sql).replace(/\s+/g, ' ')
    if (q.includes('platform.tenants')) return { rows: [{ enforced: true }] }
    if (q.includes('INTERSECT')) {
      // Contexte du DEMANDEUR : c'est son user_id qui est interrogé.
      const asked = String(params[0])
      const perms = asked === DRH ? store.requesterPermissions : []
      return { rows: [{ user_id: asked, subgroup_id: SIEGE, kind: 'siege', legal_entity_id: null, permissions: perms, active: true, self_employee_id: null }] }
    }
    if (q.includes('is_head_office = true')) return { rows: [] }
    if (q.includes('INSERT INTO') && q.includes('hab_fiche_events')) return { rows: [] }
    if (q.includes('INSERT INTO') && q.includes('notifications')) return { rows: [] }
    if (q.includes('audit_log')) return { rows: [] }
    if (q.includes('hab_sod_rules')) return { rows: [] }
    if (q.includes('manager_id')) return { rows: [{ n1_user: N1, n2_user: N2 }] }
    if (q.includes("role = 'admin'")) return { rows: [{ id: ADMIN }] }
    if (q.includes('manage_habilitations')) return { rows: [] }
    if (q.includes('INSERT INTO') && q.includes('hab_fiches')) {
      return { rows: [{ id: FICHE, number: 'HAB-2026-0001', status: 'draft', target_user_id: TARGET, permissions: params[2] }] }
    }
    if (q.includes('UPDATE') && q.includes('hab_fiches')) {
      const next = /SET status = '(\w+)'/.exec(q)?.[1]
      if (next && next !== 'superseded') store.ficheStatus = next
      return { rows: [{ id: FICHE, number: 'HAB-2026-0001', status: store.ficheStatus }] }
    }
    if (q.includes('FROM') && q.includes('hab_fiches') && q.includes('ORDER BY f.created_at')) {
      store.lastListSql = q
      return { rows: [{ id: FICHE, number: 'HAB-2026-0001', status: store.ficheStatus }] }
    }
    if (q.includes('FROM') && q.includes('hab_fiches')) {
      return {
        rows: [{
          id: FICHE, number: 'HAB-2026-0001', target_user_id: TARGET, subgroup_id: SIEGE,
          permissions: ['employees:view'], status: store.ficheStatus, kind: 'grant',
          n1_user_id: N1, n2_user_id: N2, created_by: store.ficheCreatedBy, sod_alerts: [],
          motive: null, effective_from: null, rejected_reason: null, ceiling: ['employees:view'],
        }],
      }
    }
    if (q.includes('hab_fiche_events')) return { rows: [{ id: 'e1', event: 'created', diff: {}, actor_id: DRH }] }
    if (q.includes('ceiling') && q.includes('hab_subgroups')) return { rows: [{ id: SIEGE, ceiling: ['employees:view', 'payroll:validate'] }] }
    if (q.includes('hab_assignments')) return { rows: [] }
    return { rows: [] }
  })
})

describe('Authentification', () => {
  it('sans jeton : 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/fiches' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /habilitations/fiches', () => {
  it('le DRH (case « gérer les habilitations ») rédige une fiche (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/fiches', headers: auth(app, DRH, 'hr_manager'),
      payload: { targetUserId: TARGET, subgroupId: SIEGE, permissions: ['employees:view'], motive: 'Prise de poste' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('un RH sans cette case est refusé (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/fiches', headers: auth(app, N1, 'hr_officer'),
      payload: { targetUserId: TARGET, subgroupId: SIEGE, permissions: ['employees:view'] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('une fiche pour soi-même est refusée (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/fiches', headers: auth(app, DRH, 'hr_manager'),
      payload: { targetUserId: DRH, subgroupId: SIEGE, permissions: ['employees:view'] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('une case hors plafond est refusée (400) en la nommant', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/fiches', headers: auth(app, DRH, 'hr_manager'),
      payload: { targetUserId: TARGET, subgroupId: SIEGE, permissions: ['payroll:close'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toContain('payroll:close')
  })

  it('un identifiant mal formé est refusé (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/fiches', headers: auth(app, DRH, 'hr_manager'),
      payload: { targetUserId: 'pas-un-uuid', subgroupId: SIEGE, permissions: [] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('Circuit', () => {
  it('le validateur attendu valide, même sans aucune case de la grille (200)', async () => {
    const res = await app.inject({ method: 'POST', url: `/habilitations/fiches/${FICHE}/validate`, headers: auth(app, N1, 'manager'), payload: {} })
    expect(res.statusCode).toBe(200)
  })

  it('un autre utilisateur ne valide pas à la place du N+1 (403)', async () => {
    const res = await app.inject({ method: 'POST', url: `/habilitations/fiches/${FICHE}/validate`, headers: auth(app, N2, 'manager'), payload: {} })
    expect(res.statusCode).toBe(403)
  })

  it('un refus sans motif est rejeté (400)', async () => {
    const res = await app.inject({ method: 'POST', url: `/habilitations/fiches/${FICHE}/reject`, headers: auth(app, N1, 'manager'), payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('un refus motivé passe (200)', async () => {
    const res = await app.inject({ method: 'POST', url: `/habilitations/fiches/${FICHE}/reject`, headers: auth(app, N1, 'manager'), payload: { reason: 'Trop large' } })
    expect(res.statusCode).toBe(200)
  })

  it('l\'application est réservée à l\'admin (403 pour un RH)', async () => {
    store.ficheStatus = 'locked'
    const res = await app.inject({ method: 'POST', url: `/habilitations/fiches/${FICHE}/apply`, headers: auth(app, DRH, 'hr_manager'), payload: {} })
    expect(res.statusCode).toBe(403)
  })

  it('l\'admin applique une fiche verrouillée (200)', async () => {
    store.ficheStatus = 'locked'
    const res = await app.inject({ method: 'POST', url: `/habilitations/fiches/${FICHE}/apply`, headers: auth(app, ADMIN, 'admin'), payload: {} })
    expect(res.statusCode).toBe(200)
  })

  it('appliquer une fiche non verrouillée est refusé (409)', async () => {
    store.ficheStatus = 'n2'
    const res = await app.inject({ method: 'POST', url: `/habilitations/fiches/${FICHE}/apply`, headers: auth(app, ADMIN, 'admin'), payload: {} })
    expect(res.statusCode).toBe(409)
  })

  it('le rédacteur soumet son brouillon (200)', async () => {
    store.ficheStatus = 'draft'
    const res = await app.inject({ method: 'POST', url: `/habilitations/fiches/${FICHE}/submit`, headers: auth(app, DRH, 'hr_manager'), payload: {} })
    expect(res.statusCode).toBe(200)
  })
})

describe('Lecture', () => {
  it('la liste d\'un non-admin est bornée aux fiches dont il est acteur', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/fiches', headers: auth(app, N1, 'manager') })
    expect(res.statusCode).toBe(200)
    expect(store.lastListSql).toContain('created_by = $1')
    expect(store.lastListSql).toContain('n1_user_id = $1')
  })

  it('la liste d\'un admin n\'est pas filtrée', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/fiches', headers: auth(app, ADMIN, 'admin') })
    expect(res.statusCode).toBe(200)
    expect(store.lastListSql).not.toContain('created_by = $1')
  })

  it('une fiche dont on n\'est pas acteur est introuvable (404, aucune fuite)', async () => {
    const res = await app.inject({ method: 'GET', url: `/habilitations/fiches/${FICHE}`, headers: auth(app, TARGET, 'employee') })
    expect(res.statusCode).toBe(404)
  })

  it('un acteur lit la fiche et son journal (200)', async () => {
    const res = await app.inject({ method: 'GET', url: `/habilitations/fiches/${FICHE}`, headers: auth(app, N1, 'manager') })
    expect(res.statusCode).toBe(200)
    const d = res.json<{ data: { fiche: { number: string }; events: unknown[] } }>().data
    expect(d.fiche.number).toBe('HAB-2026-0001')
    expect(d.events).toHaveLength(1)
  })
})
