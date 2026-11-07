/**
 * Fiche d'habilitation — circuit N+1 → N+2 → admin (tâche 9).
 *
 * La base est simulée par une table en mémoire : le circuit doit être
 * vérifiable sans PostgreSQL, et c'est le seul moyen d'observer qu'une étape
 * écrit bien son événement et sa notification, pas seulement son statut.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.unmock('../../services/habilitation.service.js')
// Le service importe le pool partagé pour son paramètre par défaut : config et
// pg sont neutralisés, les tests passant leur propre simulation de base.
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), end: vi.fn() })) }))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import {
  canCreateFiche, resolveApprovers, computeSodAlerts, createFiche, submitFiche,
  validateFiche, rejectFiche, editFiche, applyFiche, FicheError, type FicheDb,
} from './fiche.service.js'
import type { HabContext } from '../../services/habilitation.service.js'

const SCHEMA = 'tenant_sotra'
const SIEGE = '22222222-2222-4222-8222-222222222222'
const FILIALE = '33333333-3333-4333-8333-333333333333'
const TARGET = '55555555-5555-4555-8555-555555555555'
const CREATOR = '66666666-6666-4666-8666-666666666666'
const N1 = '77777777-7777-4777-8777-777777777777'
const N2 = '88888888-8888-4888-8888-888888888888'
const ADMIN = '99999999-9999-4999-8999-999999999999'
const FICHE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function ctx(over: Partial<HabContext> = {}): HabContext {
  return {
    userId: CREATOR, subgroupId: SIEGE, kind: 'siege', legalEntityId: null,
    permissions: new Set<string>(['manage_habilitations']), allEntities: true,
    sensitive: true, manageHabilitations: true, selfEmployeeId: null, headOfficeEntityIds: [],
    ...over,
  }
}

/** Fiche en base (colonnes utiles) + journal, notifications, affectations. */
interface Fiche {
  id: string; number: string; target_user_id: string; subgroup_id: string
  permissions: string[]; status: string; kind: 'grant' | 'revoke'
  n1_user_id: string | null; n2_user_id: string | null; created_by: string
  sod_alerts: Array<{ ruleId: string; label: string }>; motive: string | null
  effective_from: string | null; rejected_reason: string | null
}
interface Store {
  fiche: Fiche
  ceiling: string[]
  assignment: { user_id: string; permissions: string[]; revoked_at: string | null } | null
  sodRules: Array<{ id: string; label: string; left_perm: string; right_perm: string }>
  approvers: { n1: string | null; n2: string | null }
  manageHolder: string | null
  adminUser: string | null
  events: Array<{ event: string; actor: string | null; diff: unknown }>
  notifications: Array<{ user: string; type: string }>
  superseded: number
}
let store: Store

/** Simulation de la base : reconnaît les requêtes du service par leur texte. */
const db: FicheDb = {
  query: async (sql: string, params: unknown[] = []) => {
    const q = String(sql).replace(/\s+/g, ' ')
    if (q.includes('INSERT INTO') && q.includes('hab_fiche_events')) {
      store.events.push({ event: String(params[2]), actor: (params[1] as string) ?? null, diff: params[3] })
      return { rows: [], rowCount: 1 }
    }
    if (q.includes('INSERT INTO') && q.includes('notifications')) {
      store.notifications.push({ user: String(params[0]), type: String(params[1]) })
      return { rows: [], rowCount: 1 }
    }
    if (q.includes('audit_log')) return { rows: [], rowCount: 1 }
    if (q.includes('FROM') && q.includes('hab_sod_rules')) return { rows: store.sodRules as never[], rowCount: store.sodRules.length }
    if (q.includes('manage_habilitations')) {
      return { rows: (store.manageHolder ? [{ id: store.manageHolder }] : []) as never[], rowCount: store.manageHolder ? 1 : 0 }
    }
    if (q.includes("role = 'admin'")) {
      return { rows: (store.adminUser ? [{ id: store.adminUser }] : []) as never[], rowCount: store.adminUser ? 1 : 0 }
    }
    if (q.includes('manager_id')) {
      return { rows: [{ n1_user: store.approvers.n1, n2_user: store.approvers.n2 }] as never[], rowCount: 1 }
    }
    if (q.includes('INSERT INTO') && q.includes('hab_fiches')) {
      store.fiche = {
        ...store.fiche, id: FICHE, number: 'HAB-2026-0001', target_user_id: String(params[0]),
        subgroup_id: String(params[1]), permissions: params[2] as string[], status: 'draft',
        n1_user_id: (params[6] as string) ?? null, n2_user_id: (params[7] as string) ?? null,
        created_by: String(params[8]),
      }
      return { rows: [{ ...store.fiche }] as never[], rowCount: 1 }
    }
    if (q.includes('UPDATE') && q.includes('hab_fiches')) {
      // Le statut cible est écrit en clair dans le SQL (SET status = '...').
      const next = /SET status = '(\w+)'/.exec(q)?.[1]
      if (next === 'superseded') {
        store.superseded += 1
        return { rows: [], rowCount: 1 }
      }
      if (next) store.fiche.status = next
      if (q.includes('rejected_reason = $1')) store.fiche.rejected_reason = String(params[0])
      if (q.includes('permissions = COALESCE($1')) store.fiche.permissions = (params[0] as string[]) ?? store.fiche.permissions
      return { rows: [{ ...store.fiche }] as never[], rowCount: 1 }
    }
    if (q.includes('FROM') && q.includes('hab_fiches')) {
      return { rows: [{ ...store.fiche, ceiling: store.ceiling }] as never[], rowCount: 1 }
    }
    if (q.includes('ceiling') && q.includes('hab_subgroups')) {
      return { rows: [{ id: SIEGE, ceiling: store.ceiling }] as never[], rowCount: 1 }
    }
    if (q.includes('hab_assignments') && q.includes('INSERT INTO')) {
      store.assignment = { user_id: String(params[0]), permissions: params[2] as string[], revoked_at: null }
      return { rows: [{ id: 'assign-1' }] as never[], rowCount: 1 }
    }
    if (q.includes('hab_assignments') && q.includes('UPDATE')) {
      if (store.assignment) store.assignment.revoked_at = new Date().toISOString()
      return { rows: [{ id: 'assign-1' }] as never[], rowCount: 1 }
    }
    if (q.includes('hab_assignments')) {
      return { rows: (store.assignment ? [store.assignment] : []) as never[], rowCount: store.assignment ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  },
}

beforeEach(() => {
  store = {
    fiche: {
      id: FICHE, number: 'HAB-2026-0001', target_user_id: TARGET, subgroup_id: SIEGE,
      permissions: ['employees:view', 'payroll:validate'], status: 'draft', kind: 'grant',
      n1_user_id: N1, n2_user_id: N2, created_by: CREATOR, sod_alerts: [], motive: 'Prise de poste',
      effective_from: null, rejected_reason: null,
    },
    ceiling: ['employees:view', 'employees:create', 'payroll:validate', 'payments:pay', 'sensitive_data'],
    assignment: null,
    sodRules: [{ id: 'r1', label: 'Valider la paie et payer', left_perm: 'payroll:validate', right_perm: 'payments:pay' }],
    approvers: { n1: N1, n2: N2 },
    manageHolder: null, adminUser: ADMIN,
    events: [], notifications: [], superseded: 0,
  }
})

describe('canCreateFiche', () => {
  it('admin : toujours', () => {
    expect(canCreateFiche(null, 'admin', FILIALE, null)).toBe(true)
  })
  it('DRH Groupe (sous-groupe siège) : tout sous-groupe', () => {
    expect(canCreateFiche(ctx(), 'hr_manager', FILIALE, null)).toBe(true)
  })
  it('RH de filiale : son sous-groupe seulement', () => {
    const filialeCtx = ctx({ kind: 'entity', subgroupId: FILIALE, legalEntityId: '44444444-4444-4444-8444-444444444444', allEntities: false })
    expect(canCreateFiche(filialeCtx, 'hr_manager', FILIALE, null)).toBe(true)
    expect(canCreateFiche(filialeCtx, 'hr_manager', SIEGE, null)).toBe(false)
  })
  it('sans la case « gérer les habilitations » : non', () => {
    expect(canCreateFiche(ctx({ permissions: new Set(['employees:view']), manageHabilitations: false }), 'hr_manager', SIEGE, null)).toBe(false)
  })
  it('délégation active : le périmètre du délégant', () => {
    const none = ctx({ permissions: new Set<string>(), manageHabilitations: false })
    expect(canCreateFiche(none, 'hr_officer', FILIALE, { id: 'd1', delegatorId: CREATOR, subgroupId: FILIALE, endsAt: '2027-01-01' })).toBe(true)
    expect(canCreateFiche(none, 'hr_officer', SIEGE, { id: 'd1', delegatorId: CREATOR, subgroupId: FILIALE, endsAt: '2027-01-01' })).toBe(false)
  })
})

describe('resolveApprovers', () => {
  it('prend le N+1 puis le N+2 du dossier ciblé', async () => {
    await expect(resolveApprovers(SCHEMA, TARGET, CREATOR, db)).resolves.toEqual({ n1: N1, n2: N2 })
  })
  it('un créateur qui est aussi le N+1 fait monter le validateur suivant', async () => {
    store.approvers = { n1: CREATOR, n2: N2 }
    store.manageHolder = N1
    const res = await resolveApprovers(SCHEMA, TARGET, CREATOR, db)
    expect(res.n1).toBe(N2)
    expect(res.n2).toBe(N1)
  })
  it('saute la personne ciblée elle-même', async () => {
    store.approvers = { n1: TARGET, n2: N2 }
    const res = await resolveApprovers(SCHEMA, TARGET, CREATOR, db)
    expect(res.n1).toBe(N2)
  })
  it('sans N+2 : un titulaire de « gérer les habilitations » du siège', async () => {
    store.approvers = { n1: N1, n2: null }
    store.manageHolder = N2
    await expect(resolveApprovers(SCHEMA, TARGET, CREATOR, db)).resolves.toEqual({ n1: N1, n2: N2 })
  })
  it('sans N+2 ni titulaire : un admin', async () => {
    store.approvers = { n1: N1, n2: null }
    store.manageHolder = null
    await expect(resolveApprovers(SCHEMA, TARGET, CREATOR, db)).resolves.toEqual({ n1: N1, n2: ADMIN })
  })
})

describe('computeSodAlerts', () => {
  it('combine les droits de la fiche et ceux déjà affectés', async () => {
    store.assignment = { user_id: TARGET, permissions: ['payments:pay'], revoked_at: null }
    const alerts = await computeSodAlerts(SCHEMA, TARGET, ['payroll:validate'], db)
    expect(alerts).toEqual([{ ruleId: 'r1', label: 'Valider la paie et payer' }])
  })
  it('aucune alerte quand une seule des deux cases est présente', async () => {
    const alerts = await computeSodAlerts(SCHEMA, TARGET, ['payroll:validate'], db)
    expect(alerts).toEqual([])
  })
})

describe('createFiche', () => {
  it('refuse une fiche pour soi-même (403)', async () => {
    await expect(createFiche(SCHEMA, { actorId: TARGET, role: 'admin', ctx: null, ip: null }, {
      targetUserId: TARGET, subgroupId: SIEGE, permissions: ['employees:view'],
    }, db)).rejects.toMatchObject({ status: 403 })
  })

  it('refuse une case hors plafond (400) en la nommant', async () => {
    await expect(createFiche(SCHEMA, { actorId: CREATOR, role: 'admin', ctx: null, ip: null }, {
      targetUserId: TARGET, subgroupId: SIEGE, permissions: ['employees:view', 'payroll:close'],
    }, db)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('payroll:close') })
  })

  it('refuse une case hors catalogue (400)', async () => {
    await expect(createFiche(SCHEMA, { actorId: CREATOR, role: 'admin', ctx: null, ip: null }, {
      targetUserId: TARGET, subgroupId: SIEGE, permissions: ['employees:teleport'],
    }, db)).rejects.toMatchObject({ status: 400 })
  })

  it('refuse un RH de filiale sur un autre sous-groupe (403)', async () => {
    const filialeCtx = ctx({ kind: 'entity', subgroupId: FILIALE, legalEntityId: '44444444-4444-4444-8444-444444444444', allEntities: false })
    await expect(createFiche(SCHEMA, { actorId: CREATOR, role: 'hr_manager', ctx: filialeCtx, ip: null }, {
      targetUserId: TARGET, subgroupId: SIEGE, permissions: ['employees:view'],
    }, db)).rejects.toMatchObject({ status: 403 })
  })

  it('crée un brouillon, ses validateurs et son événement', async () => {
    const fiche = await createFiche(SCHEMA, { actorId: CREATOR, role: 'admin', ctx: null, ip: null }, {
      targetUserId: TARGET, subgroupId: SIEGE, permissions: ['employees:view', 'payroll:validate'], motive: 'Prise de poste',
    }, db)
    expect(fiche.status).toBe('draft')
    expect(fiche.n1_user_id).toBe(N1)
    expect(fiche.n2_user_id).toBe(N2)
    expect(store.events.map((e) => e.event)).toEqual(['created'])
  })
})

describe('circuit nominal', () => {
  it('draft → n1 → n2 → locked, notification des admins seulement à locked', async () => {
    await submitFiche(SCHEMA, FICHE, CREATOR, 'hr_manager', db)
    expect(store.fiche.status).toBe('n1')
    expect(store.notifications.map((n) => n.user)).toEqual([N1])

    store.notifications = []
    await validateFiche(SCHEMA, FICHE, N1, 'manager', {}, db)
    expect(store.fiche.status).toBe('n2')
    expect(store.notifications.map((n) => n.user)).toEqual([N2])

    store.notifications = []
    await validateFiche(SCHEMA, FICHE, N2, 'manager', {}, db)
    expect(store.fiche.status).toBe('locked')
    expect(store.notifications.map((n) => n.user)).toEqual([ADMIN])
    expect(store.events.map((e) => e.event)).toEqual(['submitted', 'validated', 'validated', 'locked'])
  })

  it('un validateur qui n\'est pas l\'acteur de l\'étape est refusé (403)', async () => {
    store.fiche.status = 'n1'
    await expect(validateFiche(SCHEMA, FICHE, N2, 'manager', {}, db)).rejects.toMatchObject({ status: 403 })
  })

  it('soumettre une fiche déjà soumise est refusé (409)', async () => {
    store.fiche.status = 'n1'
    await expect(submitFiche(SCHEMA, FICHE, CREATOR, 'hr_manager', db)).rejects.toMatchObject({ status: 409 })
  })
})

describe('cumul sensible', () => {
  it('bloque la validation sans acceptSod, passe avec, et trace l\'acceptation', async () => {
    store.fiche.status = 'n1'
    store.fiche.sod_alerts = [{ ruleId: 'r1', label: 'Valider la paie et payer' }]
    await expect(validateFiche(SCHEMA, FICHE, N1, 'manager', {}, db)).rejects.toMatchObject({ status: 409 })
    expect(store.fiche.status).toBe('n1')

    await validateFiche(SCHEMA, FICHE, N1, 'manager', { acceptSod: true }, db)
    expect(store.fiche.status).toBe('n2')
    expect(store.events.map((e) => e.event)).toContain('sod_accepted')
  })
})

describe('editFiche', () => {
  it('le N+1 édite à son étape, et le diff ne porte que des clés de permission', async () => {
    store.fiche.status = 'n1'
    await editFiche(SCHEMA, FICHE, N1, 'manager', { permissions: ['employees:view'] }, db)
    expect(store.fiche.permissions).toEqual(['employees:view'])
    const diff = JSON.stringify(store.events.find((e) => e.event === 'edited')?.diff ?? {})
    expect(diff).toContain('payroll:validate')
    expect(diff).not.toContain('Prise de poste')
    expect(diff).not.toContain(TARGET)
  })

  it('le créateur édite son brouillon', async () => {
    await editFiche(SCHEMA, FICHE, CREATOR, 'hr_manager', { permissions: ['employees:view'] }, db)
    expect(store.fiche.permissions).toEqual(['employees:view'])
  })

  it('un tiers ne peut pas éditer le brouillon (403)', async () => {
    await expect(editFiche(SCHEMA, FICHE, N2, 'manager', { permissions: ['employees:view'] }, db)).rejects.toMatchObject({ status: 403 })
  })

  it('après verrouillage, plus aucune édition (409)', async () => {
    store.fiche.status = 'locked'
    await expect(editFiche(SCHEMA, FICHE, CREATOR, 'admin', { permissions: ['employees:view'] }, db)).rejects.toMatchObject({ status: 409 })
  })

  it('une case hors plafond est refusée (400)', async () => {
    await expect(editFiche(SCHEMA, FICHE, CREATOR, 'hr_manager', { permissions: ['payroll:close'] }, db)).rejects.toMatchObject({ status: 400 })
  })
})

describe('rejectFiche', () => {
  it('exige un motif', async () => {
    store.fiche.status = 'n1'
    await expect(rejectFiche(SCHEMA, FICHE, N1, 'manager', '   ', db)).rejects.toMatchObject({ status: 400 })
    expect(store.fiche.status).toBe('n1')
  })

  it('renvoie la fiche au créateur, qui peut rééditer', async () => {
    store.fiche.status = 'n2'
    await rejectFiche(SCHEMA, FICHE, N2, 'manager', 'Trop large', db)
    expect(store.fiche.status).toBe('rejected')
    expect(store.fiche.rejected_reason).toBe('Trop large')
    expect(store.notifications.map((n) => n.user)).toEqual([CREATOR])
    // Rejetée, elle redevient éditable par son créateur (il resoumettra).
    await editFiche(SCHEMA, FICHE, CREATOR, 'hr_manager', { permissions: ['employees:view'] }, db)
    expect(store.fiche.permissions).toEqual(['employees:view'])
  })
})

describe('applyFiche', () => {
  it('réservée à l\'admin, sur une fiche verrouillée', async () => {
    store.fiche.status = 'locked'
    await expect(applyFiche(SCHEMA, FICHE, N1, 'hr_manager', null, db)).rejects.toMatchObject({ status: 403 })
    store.fiche.status = 'n2'
    await expect(applyFiche(SCHEMA, FICHE, ADMIN, 'admin', null, db)).rejects.toMatchObject({ status: 409 })
  })

  it('applique les droits, remplace l\'affectation et périme la fiche précédente', async () => {
    store.fiche.status = 'locked'
    await applyFiche(SCHEMA, FICHE, ADMIN, 'admin', null, db)
    expect(store.fiche.status).toBe('applied')
    expect(store.assignment).toMatchObject({ user_id: TARGET, permissions: ['employees:view', 'payroll:validate'] })
    expect(store.superseded).toBe(1)
    expect(store.notifications.map((n) => n.user)).toContain(TARGET)
  })

  it('une fiche de retrait révoque l\'affectation', async () => {
    store.fiche.status = 'locked'
    store.fiche.kind = 'revoke'
    store.assignment = { user_id: TARGET, permissions: ['employees:view'], revoked_at: null }
    await applyFiche(SCHEMA, FICHE, ADMIN, 'admin', null, db)
    expect(store.assignment?.revoked_at).not.toBeNull()
  })

  it('FicheError porte un statut HTTP exploitable par la route', async () => {
    store.fiche.status = 'draft'
    const err = await applyFiche(SCHEMA, FICHE, ADMIN, 'admin', null, db).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FicheError)
    expect((err as FicheError).status).toBe(409)
  })
})
