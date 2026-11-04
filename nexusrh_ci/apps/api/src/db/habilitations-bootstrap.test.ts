/**
 * Reprise d'office des habilitations — la base est simulée par un petit routeur
 * SQL à état (groupes, sous-groupes, affectations, marqueur), pas par une
 * séquence de mocks : chaque test décrit l'état du tenant puis vérifie le résultat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Ent { id: string; name: string; active: boolean; head: boolean; raf: string | null }
interface Usr { id: string; role: string; active: boolean; entityId: string | null }
interface Sg { id: string; name: string; kind: 'siege' | 'entity'; entityId: string | null; ceiling: string[] }
interface Asg { userId: string; subgroupId: string; permissions: string[]; source: string }

const { st, query, connect, audit } = vi.hoisted(() => {
  const st = {
    groups: [] as string[],
    subgroups: [] as Sg[],
    assignments: [] as Asg[],
    entities: [] as Ent[],
    users: [] as Usr[],
    marker: null as string | null,
    tenantRow: true,
    fail: false,
    log: [] as string[],
  }
  const audit = vi.fn()
  let n = 0
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  const query = vi.fn(async (raw: string, p: unknown[] = []) => {
    const sql = flat(raw)
    st.log.push(sql.split(' ').slice(0, 3).join(' '))
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [], rowCount: 0 }
    if (sql.startsWith('ALTER TABLE platform.tenants')) return { rows: [], rowCount: 0 }
    if (sql.includes('hab_bootstrapped_at IS NOT NULL')) {
      return { rows: st.tenantRow ? [{ done: st.marker !== null }] : [], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE platform.tenants SET hab_bootstrapped_at')) {
      if (st.fail) throw new Error('boom')
      if (st.tenantRow) st.marker = 'now'
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "t_a".hab_groups')) {
      if (!st.groups.includes(String(p[0]))) st.groups.push(String(p[0]))
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM "t_a".hab_groups WHERE name')) return { rows: [{ id: 'g1' }], rowCount: 1 }
    if (sql.includes(`SELECT $1::uuid, $2, 'siege'`)) {
      if (!st.subgroups.some((s) => s.kind === 'siege')) {
        st.subgroups.push({ id: `sg${++n}`, name: String(p[1]), kind: 'siege', entityId: null, ceiling: [] })
      }
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes(`WHERE kind = 'siege'`) && sql.startsWith('SELECT')) {
      const s = st.subgroups.find((x) => x.kind === 'siege')
      return { rows: s ? [{ id: s.id }] : [], rowCount: s ? 1 : 0 }
    }
    if (sql.includes('le.is_active = true AND le.is_head_office = false')) {
      for (const e of st.entities.filter((x) => x.active && !x.head)) {
        if (!st.subgroups.some((s) => s.entityId === e.id)) {
          st.subgroups.push({ id: `sg${++n}`, name: `${p[1]}${e.name}`, kind: 'entity', entityId: e.id, ceiling: [] })
        }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('WHERE le.id = $2::uuid')) {
      const e = st.entities.find((x) => x.id === p[1])
      if (e && !st.subgroups.some((s) => s.entityId === e.id)) {
        st.subgroups.push({ id: `sg${++n}`, name: `${p[2]}${e.name}`, kind: 'entity', entityId: e.id, ceiling: [] })
      }
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('WHERE legal_entity_id = $1::uuid')) {
      const s = st.subgroups.find((x) => x.entityId === p[0])
      return { rows: s ? [{ id: s.id }] : [], rowCount: s ? 1 : 0 }
    }
    if (sql.includes('legal_entities WHERE is_head_office = true')) {
      return { rows: st.entities.filter((e) => e.head).map((e) => ({ id: e.id })), rowCount: 0 }
    }
    if (sql.includes('FROM "t_a".users u')) {
      const rows = st.users
        .filter((u) => u.active && ['hr_manager', 'hr_officer', 'raf_site'].includes(u.role) && !st.assignments.some((a) => a.userId === u.id))
        .map((u) => ({
          id: u.id,
          role: u.role,
          entity_id: u.role === 'raf_site' ? (st.entities.find((e) => e.raf === u.id)?.id ?? u.entityId) : u.entityId,
        }))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('INSERT INTO "t_a".hab_assignments')) {
      if (st.assignments.some((a) => a.userId === p[0])) return { rows: [], rowCount: 0 }
      st.assignments.push({ userId: String(p[0]), subgroupId: String(p[1]), permissions: p[2] as string[], source: 'reprise' })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SET ceiling')) {
      const s = st.subgroups.find((x) => x.id === p[0])
      if (s) s.ceiling = [...new Set([...s.ceiling, ...(p[1] as string[])])]
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`SQL non prévu : ${sql}`)
  })
  const connect = vi.fn(async () => ({ query, release: vi.fn() }))
  return { st, query, connect, audit }
})

vi.mock('./pool.js', () => ({ pool: { query, connect } }))
vi.mock('../utils/audit-log.js', () => ({ auditTenant: audit }))

import {
  ensureHabilitationStructure,
  bootstrapExistingUsers,
  runHabilitationBootstrap,
  provisionHabilitationStructure,
  ROLE_DEFAULT_PERMISSIONS,
} from './habilitations-bootstrap.js'
import { isPermission, HAB_GRID } from '../modules/habilitations/catalog.js'

beforeEach(() => {
  st.groups = []
  st.subgroups = []
  st.assignments = []
  st.entities = []
  st.users = []
  st.marker = null
  st.tenantRow = true
  st.fail = false
  st.log = []
  audit.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('ROLE_DEFAULT_PERMISSIONS', () => {
  it('ne contient que des clés du catalogue', () => {
    for (const perms of Object.values(ROLE_DEFAULT_PERMISSIONS)) {
      for (const p of perms) expect(isPermission(p), p).toBe(true)
    }
  })
  it('hr_officer : ni close, ni delete, ni pay, ni payroll:validate', () => {
    const o = ROLE_DEFAULT_PERMISSIONS.hr_officer
    expect(o.some((p) => /:(close|delete|pay)$/.test(p))).toBe(false)
    expect(o).not.toContain('payroll:validate')
  })
  it('raf_site : payroll_multi view|update|close|validate', () => {
    expect(ROLE_DEFAULT_PERMISSIONS.raf_site).toEqual([
      'payroll_multi:view', 'payroll_multi:update', 'payroll_multi:close', 'payroll_multi:validate',
    ])
  })
  it('hr_manager : tout employees, clôture paie, paiement', () => {
    const m = ROLE_DEFAULT_PERMISSIONS.hr_manager
    for (const a of HAB_GRID.employees) expect(m).toContain(`employees:${a}`)
    expect(m).toContain('payroll:close')
    expect(m).toContain('payments:pay')
    expect(m).not.toContain('hr_settings:configure')
  })
})

describe('ensureHabilitationStructure', () => {
  it('tenant sans filiale : un groupe et un seul sous-groupe RH Siège', async () => {
    await ensureHabilitationStructure('t_a')
    expect(st.groups).toEqual(['DRH Groupe'])
    expect(st.subgroups.map((s) => s.name)).toEqual(['RH Siège'])
  })
  it('un sous-groupe par filiale active non siège, idempotent', async () => {
    st.entities = [
      { id: 'eA', name: 'A', active: true, head: true, raf: null },
      { id: 'eB', name: 'B', active: true, head: false, raf: null },
      { id: 'eC', name: 'C', active: false, head: false, raf: null },
    ]
    await ensureHabilitationStructure('t_a')
    await ensureHabilitationStructure('t_a')
    expect(st.groups).toHaveLength(1)
    expect(st.subgroups.map((s) => s.name).sort()).toEqual(['RH Filiale B', 'RH Siège'])
  })
})

describe('bootstrapExistingUsers', () => {
  beforeEach(() => {
    st.entities = [
      { id: 'eA', name: 'A', active: true, head: true, raf: null },
      { id: 'eB', name: 'B', active: true, head: false, raf: 'rafB' },
    ]
  })

  it('raf_site de la filiale B -> RH Filiale B, sans all_entities', async () => {
    st.users = [{ id: 'rafB', role: 'raf_site', active: true, entityId: null }]
    await ensureHabilitationStructure('t_a')
    expect(await bootstrapExistingUsers('t_a')).toBe(1)
    const a = st.assignments[0]!
    expect(st.subgroups.find((s) => s.id === a.subgroupId)?.name).toBe('RH Filiale B')
    expect(a.permissions).not.toContain('all_entities')
    expect(a.permissions).toContain('sensitive_data')
    expect(a.source).toBe('reprise')
  })

  it('hr_officer du siège : all_entities, pas payroll:close, pas sensitive_data', async () => {
    st.users = [{ id: 'o1', role: 'hr_officer', active: true, entityId: 'eA' }]
    await ensureHabilitationStructure('t_a')
    await bootstrapExistingUsers('t_a')
    const a = st.assignments[0]!
    expect(st.subgroups.find((s) => s.id === a.subgroupId)?.name).toBe('RH Siège')
    expect(a.permissions).toContain('all_entities')
    expect(a.permissions).not.toContain('payroll:close')
    expect(a.permissions).not.toContain('sensitive_data')
  })

  it('utilisateur sans fiche employé -> RH Siège ; hr_manager d’une filiale non siège sans all_entities', async () => {
    st.users = [
      { id: 'm0', role: 'hr_manager', active: true, entityId: null },
      { id: 'mB', role: 'hr_manager', active: true, entityId: 'eB' },
    ]
    await ensureHabilitationStructure('t_a')
    await bootstrapExistingUsers('t_a')
    const byUser = (id: string) => st.assignments.find((a) => a.userId === id)!
    const name = (id: string) => st.subgroups.find((s) => s.id === byUser(id).subgroupId)?.name
    expect(name('m0')).toBe('RH Siège')
    expect(byUser('m0').permissions).toContain('all_entities')
    expect(name('mB')).toBe('RH Filiale B')
    expect(byUser('mB').permissions).not.toContain('all_entities')
  })

  it('plafond de RH Siège = union des droits de ses membres', async () => {
    st.users = [
      { id: 'm0', role: 'hr_manager', active: true, entityId: null },
      { id: 'o1', role: 'hr_officer', active: true, entityId: null },
    ]
    await ensureHabilitationStructure('t_a')
    await bootstrapExistingUsers('t_a')
    const siege = st.subgroups.find((s) => s.kind === 'siege')!
    const union = new Set(st.assignments.flatMap((a) => a.permissions))
    expect(new Set(siege.ceiling)).toEqual(union)
    expect(siege.ceiling).toContain('payroll:close')
  })

  it('un admin, un inactif et un déjà affecté ne sont pas repris ; seconde exécution = 0', async () => {
    st.users = [
      { id: 'ad', role: 'admin', active: true, entityId: null },
      { id: 'in', role: 'hr_manager', active: false, entityId: null },
      { id: 'm0', role: 'hr_manager', active: true, entityId: null },
    ]
    st.assignments = [{ userId: 'm0', subgroupId: 'x', permissions: ['employees:view'], source: 'fiche' }]
    await ensureHabilitationStructure('t_a')
    expect(await bootstrapExistingUsers('t_a')).toBe(0)
    expect(st.assignments).toHaveLength(1)
    expect(audit).not.toHaveBeenCalled()
  })

  it('audit habilitation.bootstrap : nombre et identifiants, aucune donnée personnelle', async () => {
    st.users = [{ id: 'm0', role: 'hr_manager', active: true, entityId: null }]
    await ensureHabilitationStructure('t_a')
    await bootstrapExistingUsers('t_a')
    expect(audit).toHaveBeenCalledTimes(1)
    const [schema, entry] = audit.mock.calls[0] as [string, { action: string; changes: Record<string, unknown> }]
    expect(schema).toBe('t_a')
    expect(entry.action).toBe('habilitation.bootstrap')
    expect(entry.changes).toEqual({ count: 1, userIds: ['m0'] })
  })
})

describe('runHabilitationBootstrap', () => {
  it('reprend une fois et pose le marqueur ; la 2e passe ne fait rien', async () => {
    st.users = [{ id: 'm0', role: 'hr_manager', active: true, entityId: null }]
    await runHabilitationBootstrap('t_a')
    expect(st.marker).not.toBeNull()
    expect(st.assignments).toHaveLength(1)
    const rows = st.subgroups.length
    connect.mockClear()
    await runHabilitationBootstrap('t_a')
    expect(connect).not.toHaveBeenCalled()
    expect(st.subgroups).toHaveLength(rows)
  })

  it('échec : marqueur non posé, erreur journalisée, aucune exception', async () => {
    st.users = [{ id: 'm0', role: 'hr_manager', active: true, entityId: null }]
    st.fail = true
    await expect(runHabilitationBootstrap('t_a')).resolves.toBeUndefined()
    expect(st.marker).toBeNull()
    expect(console.error).toHaveBeenCalled()
    expect(st.log).toContain('ROLLBACK')
  })

  it('nom de schéma invalide : journalisé, aucune requête', async () => {
    query.mockClear()
    await expect(runHabilitationBootstrap('x; DROP')).resolves.toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })
})

describe('provisionHabilitationStructure (nouveau tenant)', () => {
  it('crée la structure et pose le marqueur : aucune reprise ensuite', async () => {
    st.users = [{ id: 'm0', role: 'hr_manager', active: true, entityId: null }]
    await provisionHabilitationStructure('t_a')
    expect(st.subgroups.map((s) => s.name)).toEqual(['RH Siège'])
    expect(st.marker).not.toBeNull()
    await runHabilitationBootstrap('t_a')
    expect(st.assignments).toHaveLength(0)
  })
})
