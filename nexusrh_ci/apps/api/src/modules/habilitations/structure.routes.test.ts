/**
 * Habilitations RH — API d'administration de la structure (tâche 8).
 *
 * Le pool PostgreSQL est simulé, mais la simulation reproduit l'INTERSECT
 * « droits de la fiche ∩ plafond du sous-groupe » : c'est ce qui permet de
 * vérifier qu'un plafond retiré se voit immédiatement dans l'aperçu
 * « Ce que voit X », sans cache et par le MÊME moteur que les routes RH.
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
// Le setup global (src/__tests__/legacy-hab.setup.ts) force loadHabContext à
// null pour les tests qui ignorent les habilitations. Ici c'est le moteur réel
// qu'on veut : l'aperçu doit prouver qu'il passe par lui.
vi.unmock('../../services/habilitation.service.js')

import authPlugin from '../../plugins/auth.js'
import habilitationStructureRoutes from './structure.routes.js'

const SCHEMA = 'tenant_sotra'
const GROUP_ID = '11111111-1111-4111-8111-111111111111'
const SIEGE_ID = '22222222-2222-4222-8222-222222222222'
const FILIALE_SG_ID = '33333333-3333-4333-8333-333333333333'
const ENTITY_ID = '44444444-4444-4444-8444-444444444444'
const MEMBER_ID = '55555555-5555-4555-8555-555555555555'
const TEMPLATE_KEY = 'charge_recrutement'
const SOD_RULE_ID = '66666666-6666-4666-8666-666666666666'

function tokenFor(app: FastifyInstance, role: string): string {
  return app.jwt.sign({
    sub: `u-${role}`, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}

/** État simulé de la base, mutable : le plafond change quand la route l'écrit. */
interface FakeDb {
  enforced: boolean
  ceiling: string[]
  memberPermissions: string[]
  existingFicheAssignment: boolean
}
let db: FakeDb

const auditWrites = (): string[] =>
  queryMock.mock.calls.filter((c) => String(c[0]).includes('audit_log')).map((c) => JSON.stringify(c[1] ?? []))

function intersect(a: string[], b: string[]): string[] {
  return a.filter((x) => b.includes(x))
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(habilitationStructureRoutes, { prefix: '/habilitations' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  db = {
    enforced: true,
    ceiling: ['employees:view', 'payroll:view', 'payroll:close', 'sensitive_data', 'all_entities'],
    memberPermissions: ['employees:view', 'payroll:view', 'payroll:close', 'all_entities'],
    existingFicheAssignment: false,
  }
  queryMock.mockReset()
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    const q = String(sql)
    // ── Plateforme : interrupteur d'activation ───────────────────────────────
    if (q.includes('UPDATE platform.tenants')) {
      db.enforced = Boolean(params?.[0])
      return { rows: [{ id: 't1' }] }
    }
    if (q.includes('platform.tenants')) return { rows: [{ enforced: db.enforced }] }
    // ── Moteur : droits effectifs = fiche ∩ plafond ──────────────────────────
    if (q.includes('INTERSECT')) {
      return {
        rows: [{
          user_id: MEMBER_ID, subgroup_id: SIEGE_ID, kind: 'siege', legal_entity_id: null,
          permissions: intersect(db.memberPermissions, db.ceiling),
          active: true, self_employee_id: null,
        }],
      }
    }
    if (q.includes('is_head_office = true')) return { rows: [] }
    // ── Structure ────────────────────────────────────────────────────────────
    if (q.includes('hab_groups g')) {
      return {
        rows: [
          { group_id: GROUP_ID, group_name: 'DRH Groupe', subgroup_id: SIEGE_ID, subgroup_name: 'RH Siège', kind: 'siege', legal_entity_id: null, legal_entity_name: null, ceiling: db.ceiling },
          { group_id: GROUP_ID, group_name: 'DRH Groupe', subgroup_id: FILIALE_SG_ID, subgroup_name: 'RH Filiale B', kind: 'entity', legal_entity_id: ENTITY_ID, legal_entity_name: 'Filiale B', ceiling: ['employees:view'] },
        ],
      }
    }
    if (q.includes('hab_assignments a') && q.includes('users u')) {
      return { rows: [{ user_id: MEMBER_ID, subgroup_id: SIEGE_ID, permissions: db.memberPermissions, source: 'reprise', revoked_at: null, email: 'rh@sotra.ci', first_name: 'Awa', last_name: 'Koné', role: 'hr_manager' }] }
    }
    if (q.includes('.employees') && q.includes('legal_entity_id IS NULL')) return { rows: [{ n: 12 }] }
    // ── Écritures ────────────────────────────────────────────────────────────
    if (q.includes('INSERT INTO') && q.includes('hab_groups')) return { rows: [{ id: GROUP_ID, name: 'DRH Groupe' }] }
    if (q.includes('INSERT INTO') && q.includes('hab_subgroups')) return { rows: [{ id: FILIALE_SG_ID }] }
    if (q.startsWith('SELECT') && q.includes('hab_subgroups') && q.includes('ceiling')) {
      return { rows: [{ id: SIEGE_ID, name: 'RH Siège', ceiling: db.ceiling }] }
    }
    if (q.startsWith('SELECT') && q.includes('hab_subgroups') && q.includes('WHERE id =')) {
      return { rows: [{ id: SIEGE_ID }] }
    }
    if (q.includes('UPDATE') && q.includes('hab_subgroups')) {
      db.ceiling = (params?.[0] as string[]) ?? []
      return { rows: [{ id: SIEGE_ID, ceiling: db.ceiling }] }
    }
    if (q.includes('hab_templates')) return { rows: [{ id: '77777777-7777-4777-8777-777777777777', key: TEMPLATE_KEY, label: 'Chargé de recrutement', permissions: ['recruitment:view'] }] }
    if (q.includes('hab_sod_rules')) return { rows: [{ id: SOD_RULE_ID, label: 'Valider la paie et payer', left_perm: 'payroll:validate', right_perm: 'payments:pay', active: false }] }
    if (q.includes('hab_assignments') && q.includes("source IN ('fiche'")) {
      return { rows: db.existingFicheAssignment ? [{ exists: true }] : [] }
    }
    if (q.includes('hab_assignments')) return { rows: [{ user_id: MEMBER_ID }] }
    if (q.includes('audit_log')) return { rows: [] }
    return { rows: [] }
  })
})

describe('OWASP A01 — réservé à l\'admin du tenant', () => {
  it.each([
    ['GET', '/habilitations/structure', undefined],
    ['GET', '/habilitations/preview/' + MEMBER_ID, undefined],
    ['POST', '/habilitations/groups', { name: 'Autre groupe' }],
    ['PATCH', `/habilitations/subgroups/${SIEGE_ID}/ceiling`, { ceiling: ['employees:view'] }],
    ['POST', '/habilitations/enforcement', { enabled: false }],
  ])('%s %s refusé à hr_manager (403)', async (method, url, payload) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` }, payload })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /habilitations/structure', () => {
  it('rend les groupes, leurs sous-groupes, plafonds, membres et le siège', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/structure', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { enforced: boolean; siegeEmployeeCount: number; groups: Array<{ name: string; subgroups: Array<{ name: string; kind: string; ceiling: string[]; members: Array<{ userId: string; email: string }> }> }> } }>()
    expect(body.data.enforced).toBe(true)
    expect(body.data.siegeEmployeeCount).toBe(12)
    expect(body.data.groups).toHaveLength(1)
    const sub = body.data.groups[0]?.subgroups ?? []
    expect(sub.map((s) => s.name)).toEqual(['RH Siège', 'RH Filiale B'])
    expect(sub[0]?.members[0]).toMatchObject({ userId: MEMBER_ID, email: 'rh@sotra.ci' })
    expect(sub[1]?.members).toEqual([])
  })
})

describe('PATCH /habilitations/subgroups/:id/ceiling', () => {
  it('refuse un plafond hors catalogue (400) sans rien écrire', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/habilitations/subgroups/${SIEGE_ID}/ceiling`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` }, payload: { ceiling: ['employees:view', 'foo:bar'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toContain('foo:bar')
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('hab_subgroups'))).toBe(false)
  })

  it('refuse un identifiant mal formé (400)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/habilitations/subgroups/pas-un-uuid/ceiling',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` }, payload: { ceiling: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('journalise le plafond avant et après', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/habilitations/subgroups/${SIEGE_ID}/ceiling`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` }, payload: { ceiling: ['employees:view'] },
    })
    expect(res.statusCode).toBe(200)
    const audit = auditWrites().join(' ')
    expect(audit).toContain('habilitation.ceiling.updated')
    expect(audit).toContain('payroll:close')
    expect(audit).toContain('employees:view')
  })

  it('retirer payroll:close du plafond rend la case fausse pour le membre (aperçu)', async () => {
    const before = await app.inject({ method: 'GET', url: `/habilitations/preview/${MEMBER_ID}`, headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` } })
    expect(before.json<{ data: { permissions: string[] } }>().data.permissions).toContain('payroll:close')

    const patched = await app.inject({
      method: 'PATCH', url: `/habilitations/subgroups/${SIEGE_ID}/ceiling`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ceiling: ['employees:view', 'payroll:view', 'all_entities'] },
    })
    expect(patched.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: `/habilitations/preview/${MEMBER_ID}`, headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` } })
    const data = after.json<{ data: { permissions: string[]; can: Record<string, boolean> } }>().data
    expect(data.permissions).not.toContain('payroll:close')
    expect(data.permissions).toContain('payroll:view')
  })
})

describe('GET /habilitations/preview/:userId', () => {
  it('rend le périmètre et les champs masqués calculés par le moteur', async () => {
    const res = await app.inject({ method: 'GET', url: `/habilitations/preview/${MEMBER_ID}`, headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    const d = res.json<{ data: { hasAssignment: boolean; kind: string; allEntities: boolean; sensitive: boolean; maskedFields: string[]; scope: { allEntities: boolean; includesNoEntity: boolean; entityIds: string[] } } }>().data
    expect(d.hasAssignment).toBe(true)
    expect(d.kind).toBe('siege')
    expect(d.allEntities).toBe(true)
    // payroll:view est dans les droits effectifs → sensitive implicite
    expect(d.sensitive).toBe(true)
    expect(d.maskedFields).toEqual([])
    expect(d.scope.allEntities).toBe(true)
  })

  it('masque les champs sensibles quand la case ne l\'est pas', async () => {
    db.memberPermissions = ['employees:view']
    db.ceiling = ['employees:view']
    const res = await app.inject({ method: 'GET', url: `/habilitations/preview/${MEMBER_ID}`, headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` } })
    const d = res.json<{ data: { sensitive: boolean; maskedFields: string[] } }>().data
    expect(d.sensitive).toBe(false)
    expect(d.maskedFields).toContain('base_salary')
  })

  it('refuse un identifiant mal formé (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/preview/pas-un-uuid', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /habilitations/subgroups', () => {
  it('refuse un sous-groupe de filiale sans entité légale (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/subgroups', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { groupId: GROUP_ID, name: 'RH Filiale C', kind: 'entity' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un sous-groupe siège porteur d\'une entité légale (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/subgroups', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { groupId: GROUP_ID, name: 'RH Siège bis', kind: 'siege', legalEntityId: ENTITY_ID },
    })
    expect(res.statusCode).toBe(400)
  })

  it('crée un sous-groupe de filiale (201) avec un plafond validé', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/subgroups', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { groupId: GROUP_ID, name: 'RH Filiale C', kind: 'entity', legalEntityId: ENTITY_ID, ceiling: ['employees:view'] },
    })
    expect(res.statusCode).toBe(201)
    expect(auditWrites().join(' ')).toContain('habilitation.subgroup.created')
  })

  it('refuse un plafond hors catalogue à la création (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/subgroups', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { groupId: GROUP_ID, name: 'RH Filiale D', kind: 'entity', legalEntityId: ENTITY_ID, ceiling: ['nimporte:quoi'] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /habilitations/bootstrap-user', () => {
  it('habilite le premier responsable (201) par une écriture idempotente', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/bootstrap-user', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { userId: MEMBER_ID, subgroupId: SIEGE_ID, permissions: ['employees:view', 'manage_habilitations'] },
    })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.map((c) => String(c[0])).find((q) => q.includes('INSERT INTO') && q.includes('hab_assignments'))
    expect(insert).toBeDefined()
    expect(insert).toContain('ON CONFLICT')
    expect(auditWrites().join(' ')).toContain('habilitation.bootstrap_user')
  })

  it('refuse (409) dès qu\'une fiche a été appliquée', async () => {
    db.existingFicheAssignment = true
    const res = await app.inject({
      method: 'POST', url: '/habilitations/bootstrap-user', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { userId: MEMBER_ID, subgroupId: SIEGE_ID, permissions: ['employees:view'] },
    })
    expect(res.statusCode).toBe(409)
  })

  it('refuse une permission hors catalogue (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/bootstrap-user', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { userId: MEMBER_ID, subgroupId: SIEGE_ID, permissions: ['employees:fly'] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('Modèles de fiche et règles de cumul', () => {
  it('liste les modèles (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/templates', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
  })

  it('refuse un modèle portant une permission hors catalogue (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/templates', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { key: 'faux', label: 'Faux', permissions: ['employees:teleport'] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('crée un modèle (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/templates', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { key: TEMPLATE_KEY, label: 'Chargé de recrutement', permissions: ['recruitment:view', 'recruitment:create'] },
    })
    expect(res.statusCode).toBe(201)
  })

  it('met à jour un modèle existant (200)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/habilitations/templates/${TEMPLATE_KEY}`, headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { label: 'Chargé de recrutement (siège)' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('une règle de cumul ne peut qu\'être désactivée, jamais réécrite', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/habilitations/sod-rules/${SOD_RULE_ID}`, headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { active: false, leftPerm: 'employees:view' },
    })
    expect(res.statusCode).toBe(200)
    const update = queryMock.mock.calls.map((c) => String(c[0])).find((q) => q.includes('UPDATE') && q.includes('hab_sod_rules'))
    expect(update).toBeDefined()
    expect(update).not.toContain('left_perm =')
  })
})

describe('Activation du contrôle par la grille', () => {
  it('rend le rapport de reprise (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/takeover-report', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    const d = res.json<{ data: { enforced: boolean; assignments: unknown[]; usersWithoutAssignment: number } }>().data
    expect(d.enforced).toBe(true)
    expect(Array.isArray(d.assignments)).toBe(true)
  })

  it('active le contrôle et le journalise (200)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/enforcement', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    expect(auditWrites().join(' ')).toContain('habilitation.enforcement.changed')
  })

  it('refuse un corps sans booléen (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/habilitations/enforcement', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { enabled: 'oui' },
    })
    expect(res.statusCode).toBe(400)
  })
})
