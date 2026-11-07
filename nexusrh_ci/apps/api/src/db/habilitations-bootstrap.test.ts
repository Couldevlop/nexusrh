/**
 * Reprise d'office des habilitations — la base est simulée par un petit routeur
 * SQL à état (groupes, sous-groupes, affectations, audit, marqueur) avec
 * transactions (BEGIN/ROLLBACK restaurent l'état). Chaque test décrit l'état du
 * tenant puis vérifie le résultat. L'équivalence avec l'accès d'aujourd'hui,
 * route par route, est vérifiée par modules/habilitations/takeover-fidelity.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Ent { id: string; name: string; active: boolean; head: boolean; raf: string | null }
interface Usr { id: string; role: string; active: boolean; entityId: string | null; rafEntities?: number }
interface Sg { id: string; name: string; kind: 'siege' | 'entity'; entityId: string | null; ceiling: string[] }
interface Asg { userId: string; subgroupId: string; permissions: string[]; source: string; revokedAt?: string }
interface AuditRow { action: string; entityId: unknown; changes: Record<string, unknown> }

const { st, query, connect } = vi.hoisted(() => {
  const st = {
    groups: [] as string[],
    subgroups: [] as Sg[],
    assignments: [] as Asg[],
    audits: [] as AuditRow[],
    entities: [] as Ent[],
    users: [] as Usr[],
    marker: null as string | null,
    tenantRow: true,
    failMarker: false,
    log: [] as string[],
    snap: null as string | null,
  }
  let n = 0
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  const snapshot = () => JSON.stringify({ g: st.groups, s: st.subgroups, a: st.assignments, au: st.audits, m: st.marker })
  const restore = (j: string) => {
    const o = JSON.parse(j) as { g: string[]; s: Sg[]; a: Asg[]; au: AuditRow[]; m: string | null }
    st.groups = o.g; st.subgroups = o.s; st.assignments = o.a; st.audits = o.au; st.marker = o.m
  }
  const query = vi.fn(async (raw: string, p: unknown[] = []) => {
    const sql = flat(raw)
    st.log.push(sql.split(' ').slice(0, 3).join(' '))
    if (sql === 'BEGIN') { st.snap = snapshot(); return { rows: [], rowCount: 0 } }
    if (sql === 'COMMIT') { st.snap = null; return { rows: [], rowCount: 0 } }
    if (sql === 'ROLLBACK') { if (st.snap) restore(st.snap); st.snap = null; return { rows: [], rowCount: 0 } }
    if (/SAVEPOINT/.test(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [], rowCount: 0 }
    if (sql.includes('hab_bootstrapped_at IS NOT NULL')) {
      return { rows: st.tenantRow ? [{ done: st.marker !== null }] : [], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE platform.tenants SET hab_bootstrapped_at')) {
      if (st.failMarker) throw new Error('boom')
      if (st.tenantRow) st.marker = 'now'
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('.audit_log')) {
      st.audits.push({ action: String(p[1]), entityId: p[3], changes: JSON.parse(String(p[4])) as Record<string, unknown> })
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
          raf_entities: u.rafEntities ?? (u.role === 'raf_site' ? 1 : 0),
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
    if (sql.startsWith('UPDATE "t_a".hab_assignments SET revoked_at')) {
      const hit = st.assignments.filter((a) => a.userId === p[0] && !a.revokedAt)
      for (const a of hit) a.revokedAt = 'now'
      return { rows: hit.map((a, i) => ({ id: `as${i}` })), rowCount: hit.length }
    }
    throw new Error(`SQL non prévu : ${sql}`)
  })
  const connect = vi.fn(async () => ({ query, release: vi.fn() }))
  return { st, query, connect }
})

vi.mock('./pool.js', () => ({ pool: { query, connect } }))

import {
  ensureHabilitationStructure,
  bootstrapExistingUsers,
  runHabilitationBootstrap,
  provisionHabilitationStructure,
  revokeHabilitationOnRoleChange,
  takeoverPermissions,
  ROLE_DEFAULT_PERMISSIONS,
} from './habilitations-bootstrap.js'
import { isPermission, HAB_GRID } from '../modules/habilitations/catalog.js'

beforeEach(() => {
  st.groups = []
  st.subgroups = []
  st.assignments = []
  st.audits = []
  st.entities = []
  st.users = []
  st.marker = null
  st.tenantRow = true
  st.failMarker = false
  st.log = []
  st.snap = null
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('ROLE_DEFAULT_PERMISSIONS / takeoverPermissions', () => {
  it('ne contient que des clés du catalogue', () => {
    for (const role of ['hr_manager', 'hr_officer', 'raf_site'] as const) {
      for (const p of takeoverPermissions(role)) expect(isPermission(p), p).toBe(true)
    }
  })
  it('raf_site : payroll_multi view|update seulement (ni close, ni validate : séparation des tâches)', () => {
    expect(ROLE_DEFAULT_PERMISSIONS.raf_site).toEqual(['payroll_multi:view', 'payroll_multi:update'])
    expect(takeoverPermissions('raf_site')).toEqual(['payroll_multi:view', 'payroll_multi:update', 'sensitive_data'])
  })
  it('hr_officer : garde ses validations et suppressions actuelles, mais pas la clôture ni le paiement', () => {
    const o = ROLE_DEFAULT_PERMISSIONS.hr_officer
    for (const p of ['absences:validate', 'expenses:validate', 'payroll:validate', 'payroll_multi:validate', 'payroll_multi:close', 'talent:delete', 'training:delete']) {
      expect(o, p).toContain(p)
    }
    expect(o).not.toContain('payroll:close')
    expect(o.some((p) => p.startsWith('payments:'))).toBe(false)
    expect(o).not.toContain('hr_settings:configure')
  })
  it('hr_manager : toutes les cases, y compris configure (paramétrage RH et paie)', () => {
    const m = ROLE_DEFAULT_PERMISSIONS.hr_manager
    for (const a of HAB_GRID.employees) expect(m).toContain(`employees:${a}`)
    expect(m).toContain('hr_settings:configure')
    expect(m).toContain('payroll:configure')
    expect(m).toContain('payments:pay')
  })
  it('all_entities pour hr_manager et hr_officer (ils voient tout le tenant aujourd\'hui), jamais pour raf_site', () => {
    expect(takeoverPermissions('hr_manager')).toContain('all_entities')
    expect(takeoverPermissions('hr_officer')).toContain('all_entities')
    expect(takeoverPermissions('raf_site')).not.toContain('all_entities')
  })
  it('hr_officer : pas de sensitive_data explicite, mais payroll:view l\'implique (SENSITIVE_IMPLIED) — conforme à l\'accès d\'aujourd\'hui', () => {
    const perms = takeoverPermissions('hr_officer')
    expect(perms).not.toContain('sensitive_data')
    expect(perms).toContain('payroll:view')
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
  const subgroupName = (id: string) => st.subgroups.find((s) => s.id === st.assignments.find((a) => a.userId === id)!.subgroupId)?.name

  it('raf_site de la filiale B -> RH Filiale B, sans all_entities', async () => {
    st.users = [{ id: 'rafB', role: 'raf_site', active: true, entityId: null }]
    await ensureHabilitationStructure('t_a')
    expect(await bootstrapExistingUsers('t_a')).toBe(1)
    const a = st.assignments[0]!
    expect(subgroupName('rafB')).toBe('RH Filiale B')
    expect(a.permissions).not.toContain('all_entities')
    expect(a.permissions).toContain('sensitive_data')
    expect(a.source).toBe('reprise')
  })

  it('hr_officer du siège : all_entities, pas payroll:close', async () => {
    st.users = [{ id: 'o1', role: 'hr_officer', active: true, entityId: 'eA' }]
    await ensureHabilitationStructure('t_a')
    await bootstrapExistingUsers('t_a')
    const a = st.assignments[0]!
    expect(subgroupName('o1')).toBe('RH Siège')
    expect(a.permissions).toContain('all_entities')
    expect(a.permissions).not.toContain('payroll:close')
  })

  it('hr_manager / hr_officer d\'une filiale, ou sans fiche : RH Siège avec all_entities (aucun cantonnement)', async () => {
    st.users = [
      { id: 'm0', role: 'hr_manager', active: true, entityId: null },
      { id: 'mB', role: 'hr_manager', active: true, entityId: 'eB' },
      { id: 'oB', role: 'hr_officer', active: true, entityId: 'eB' },
    ]
    await ensureHabilitationStructure('t_a')
    await bootstrapExistingUsers('t_a')
    for (const id of ['m0', 'mB', 'oB']) {
      expect(subgroupName(id), id).toBe('RH Siège')
      expect(st.assignments.find((a) => a.userId === id)!.permissions, id).toContain('all_entities')
    }
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
    expect(st.audits).toHaveLength(0)
  })

  it('audit habilitation.bootstrap : nombre et identifiants, aucune donnée personnelle', async () => {
    st.users = [{ id: 'm0', role: 'hr_manager', active: true, entityId: null }]
    await ensureHabilitationStructure('t_a')
    await bootstrapExistingUsers('t_a')
    expect(st.audits).toHaveLength(1)
    expect(st.audits[0]!.action).toBe('habilitation.bootstrap')
    expect(st.audits[0]!.changes).toEqual({ count: 1, userIds: ['m0'], skipped: [] })
  })

  it('RAF dont la filiale a disparu : ignoré, compté, journalisé et listé dans l\'audit (jamais replacé au siège)', async () => {
    st.entities = [{ id: 'eA', name: 'A', active: true, head: true, raf: null }]
    st.users = [
      { id: 'rafGone', role: 'raf_site', active: true, entityId: 'eZ' },
      { id: 'm0', role: 'hr_manager', active: true, entityId: null },
    ]
    await ensureHabilitationStructure('t_a')
    expect(await bootstrapExistingUsers('t_a')).toBe(1)
    expect(st.assignments.map((a) => a.userId)).toEqual(['m0'])
    expect(console.warn).toHaveBeenCalled()
    expect(st.audits[0]!.changes).toEqual({ count: 1, userIds: ['m0'], skipped: ['rafGone'] })
  })

  it('RAF de plusieurs filiales : une seule affectation (index unique), cas listé dans l\'audit', async () => {
    st.users = [{ id: 'rafB', role: 'raf_site', active: true, entityId: null, rafEntities: 2 }]
    await ensureHabilitationStructure('t_a')
    await bootstrapExistingUsers('t_a')
    expect(st.assignments).toHaveLength(1)
    expect(st.audits[0]!.changes).toMatchObject({ multiEntityRaf: ['rafB'] })
  })
})

describe('runHabilitationBootstrap', () => {
  it('reprend une fois et pose le marqueur ; la 2e passe ne refait pas la reprise', async () => {
    st.users = [{ id: 'm0', role: 'hr_manager', active: true, entityId: null }]
    await runHabilitationBootstrap('t_a')
    expect(st.marker).not.toBeNull()
    expect(st.assignments).toHaveLength(1)
    st.users.push({ id: 'm1', role: 'hr_manager', active: true, entityId: null })
    await runHabilitationBootstrap('t_a')
    expect(st.assignments).toHaveLength(1)
  })

  it('marqueur posé : la structure est tout de même réassurée (filiale créée par script)', async () => {
    st.marker = 'deja'
    st.entities = [{ id: 'eB', name: 'B', active: true, head: false, raf: null }]
    await runHabilitationBootstrap('t_a')
    expect(st.subgroups.map((s) => s.name).sort()).toEqual(['RH Filiale B', 'RH Siège'])
    expect(st.assignments).toHaveLength(0)
  })

  it('échec : marqueur non posé, ni affectation ni audit conservés (même transaction), erreur journalisée', async () => {
    st.users = [{ id: 'm0', role: 'hr_manager', active: true, entityId: null }]
    st.failMarker = true
    await expect(runHabilitationBootstrap('t_a')).resolves.toBeUndefined()
    expect(st.marker).toBeNull()
    expect(st.assignments).toHaveLength(0)
    expect(st.audits).toHaveLength(0)
    expect(console.error).toHaveBeenCalled()
    expect(st.log).toContain('ROLLBACK')
    // La structure, committée à part, subsiste.
    expect(st.subgroups.map((s) => s.name)).toEqual(['RH Siège'])
  })

  it('aucun ALTER TABLE sur platform.tenants dans ce chemin', async () => {
    await runHabilitationBootstrap('t_a')
    expect(st.log.some((l) => l.startsWith('ALTER TABLE'))).toBe(false)
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

describe('revokeHabilitationOnRoleChange', () => {
  beforeEach(() => {
    st.assignments = [{ userId: 'u1', subgroupId: 'sg1', permissions: ['employees:view'], source: 'reprise' }]
  })
  it('un rôle qui quitte la grille révoque l\'affectation active', async () => {
    expect(await revokeHabilitationOnRoleChange('t_a', 'u1', 'employee', 'admin1', '1.2.3.4')).toBe(true)
    expect(st.assignments[0]!.revokedAt).toBeDefined()
    // L'audit part en tâche de fond sur le pool ; on le laisse se poser.
    await new Promise((r) => setTimeout(r, 0))
    const a = st.audits.find((x) => x.action === 'habilitation.revoked')
    expect(a?.changes).toMatchObject({ reason: 'role_changed', newRole: 'employee' })
    expect(a?.entityId).toBe('u1')
  })
  it('un rôle qui reste dans la grille ne révoque rien', async () => {
    expect(await revokeHabilitationOnRoleChange('t_a', 'u1', 'hr_officer', 'admin1', null)).toBe(false)
    expect(st.assignments[0]!.revokedAt).toBeUndefined()
  })
  it('sans affectation active : rien, pas d\'audit', async () => {
    st.assignments = []
    expect(await revokeHabilitationOnRoleChange('t_a', 'u1', 'manager', 'admin1', null)).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(st.audits).toHaveLength(0)
  })
})
