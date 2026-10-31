import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
// Le setup global remplace loadHabContext : ce fichier teste le vrai.
vi.unmock('./habilitation.service.js')
vi.mock('../db/pool.js', () => ({ pool: { query: queryMock } }))

import { loadHabContext, can, hrScopeSql, type HabContext } from './habilitation.service.js'

const ENT = '11111111-1111-4111-8111-111111111111'
const row = (over: Record<string, unknown> = {}) => ({
  user_id: 'u1', subgroup_id: 'sg1', kind: 'entity', legal_entity_id: ENT,
  permissions: ['employees:view'], self_employee_id: 'e1', active: true,
  enforced: true, head_office_ids: [] as string[], ...over,
})

beforeEach(() => queryMock.mockReset())

type TestRow = ReturnType<typeof row>
/** Routeur de requêtes : interrupteur, affectation, ids du siège. */
function route(r: TestRow | null, opts: { headOfficeError?: Error } = {}) {
  queryMock.mockImplementation(async (sql: string) => {
    const q = String(sql)
    if (q.includes('habilitations_enforced')) return { rows: [{ enforced: r ? r.enforced : true }] }
    if (q.includes('hab_assignments')) return { rows: r ? [r] : [] }
    if (q.includes('is_head_office')) {
      if (opts.headOfficeError) throw opts.headOfficeError
      return { rows: (r?.head_office_ids ?? []).map((id) => ({ id })) }
    }
    return { rows: [] }
  })
}
const pgErr = (code: string) => Object.assign(new Error(code), { code })

describe('loadHabContext', () => {
  it('aucune ligne -> null (accès hérité) ; requête LEFT JOIN', async () => {
    route(null)
    const ctx = await loadHabContext('tenant_sotra', 'u1')
    expect(ctx).toBeNull()
    expect(hrScopeSql('tenant_sotra', 'e', ctx)).toBe('TRUE')
    expect(queryMock).toHaveBeenCalledTimes(2) // interrupteur + affectation
    const sql = String(queryMock.mock.calls[1]![0])
    expect(sql).toContain('LEFT JOIN "tenant_sotra".hab_subgroups')
    expect(sql).toContain('revoked_at IS NULL')
    expect(sql).toContain('effective_from <= current_date')
    expect(sql).toContain('INTERSECT')
  })

  it('interrupteur désactivé (enforced=false) -> null même avec une affectation', async () => {
    route(row({ enforced: false }))
    expect(await loadHabContext('tenant_sotra', 'u1')).toBeNull()
    expect(queryMock).toHaveBeenCalledTimes(1) // seule la lecture de l'interrupteur
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toContain('platform.tenants')
    expect(sql).toContain('habilitations_enforced')
  })

  it('interrupteur désactivé et ligne révoquée -> null (pas de refus)', async () => {
    route(row({ enforced: false, active: false }))
    expect(await loadHabContext('tenant_sotra', 'u1')).toBeNull()
  })

  it('enforced=true : contexte inchangé et ids du siège chargés', async () => {
    route(row({ kind: 'siege', legal_entity_id: null, head_office_ids: [ENT] }))
    const ctx = await loadHabContext('tenant_sotra', 'u1')
    expect(ctx!.kind).toBe('siege')
    expect(ctx!.headOfficeEntityIds).toEqual([ENT])
  })

  it('refus / filiale : headOfficeEntityIds vide', async () => {
    route(row({ head_office_ids: [ENT] }))
    expect((await loadHabContext('tenant_sotra', 'u1'))!.headOfficeEntityIds).toEqual([])
    route(row({ active: false, head_office_ids: [ENT] }))
    expect((await loadHabContext('tenant_sotra', 'u1'))!.headOfficeEntityIds).toEqual([])
  })

  const expectDeny = (ctx: HabContext | null) => {
    expect(ctx).not.toBeNull()
    expect(ctx!.kind).toBe('none')
    expect(ctx!.permissions.size).toBe(0)
    expect(ctx!.allEntities || ctx!.sensitive || ctx!.manageHabilitations).toBe(false)
    expect(can(ctx!, 'employees', 'view')).toBe(false)
    expect(hrScopeSql('tenant_sotra', 'e', ctx)).toBe('FALSE')
  }

  it('ligne révoquée -> contexte de refus', async () => {
    route(row({ active: false }))
    expectDeny(await loadHabContext('tenant_sotra', 'u1'))
  })

  it('ligne à effet futur -> contexte de refus', async () => {
    route(row({ active: false, permissions: [] }))
    expectDeny(await loadHabContext('tenant_sotra', 'u1'))
  })

  it('sous-groupe absent (colonnes sg nulles) -> contexte de refus', async () => {
    route(row({ active: false, kind: null, legal_entity_id: null, permissions: [] }))
    expectDeny(await loadHabContext('tenant_sotra', 'u1'))
  })

  it('subgroup_id NULL -> contexte de refus', async () => {
    route(row({ subgroup_id: null, active: false, kind: null, legal_entity_id: null }))
    expectDeny(await loadHabContext('tenant_sotra', 'u1'))
  })

  it('payroll:validate faux quand absent des droits effectifs (plafond)', async () => {
    route(row({ permissions: ['payroll:view'] }))
    const ctx = await loadHabContext('tenant_sotra', 'u1')
    expect(ctx).not.toBeNull()
    expect(can(ctx!, 'payroll', 'validate')).toBe(false)
    expect(can(ctx!, 'payroll', 'view')).toBe(true)
  })

  it('un plafond retiré se reflète au prochain appel (pas de cache)', async () => {
    route(row({ permissions: ['payroll:validate'] }))
    expect(can((await loadHabContext('tenant_sotra', 'u1'))!, 'payroll', 'validate')).toBe(true)
    route(row({ permissions: [] }))
    expect(can((await loadHabContext('tenant_sotra', 'u1'))!, 'payroll', 'validate')).toBe(false)
  })

  it('sensitive vrai avec payroll:view, ou sensitive_data', async () => {
    route(row({ permissions: ['payroll:view'] }))
    expect((await loadHabContext('tenant_sotra', 'u1'))!.sensitive).toBe(true)
    route(row({ permissions: ['sensitive_data'] }))
    expect((await loadHabContext('tenant_sotra', 'u1'))!.sensitive).toBe(true)
    route(row({ permissions: ['employees:view'] }))
    expect((await loadHabContext('tenant_sotra', 'u1'))!.sensitive).toBe(false)
  })

  it('allEntities ignoré pour une entité, actif pour le siège', async () => {
    route(row({ permissions: ['all_entities'] }))
    expect((await loadHabContext('tenant_sotra', 'u1'))!.allEntities).toBe(false)
    route(row({ kind: 'siege', legal_entity_id: null, permissions: ['all_entities', 'manage_habilitations'] }))
    const ctx = (await loadHabContext('tenant_sotra', 'u1'))!
    expect(ctx.allEntities).toBe(true)
    expect(ctx.manageHabilitations).toBe(true)
    expect(ctx.selfEmployeeId).toBe('e1')
  })

  it('tables habilitation absentes (42P01) -> null ; autre erreur relancée', async () => {
    route(row())
    const base = queryMock.getMockImplementation()!
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('hab_assignments')) throw pgErr('42P01')
      return base(sql)
    })
    expect(await loadHabContext('tenant_sotra', 'u1')).toBeNull()
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('hab_assignments')) throw Object.assign(new Error('boom'), { code: '08006' })
      return base(sql)
    })
    await expect(loadHabContext('tenant_sotra', 'u1')).rejects.toThrow('boom')
  })

  it('colonne plateforme habilitations_enforced absente (42703) -> null (accès hérité)', async () => {
    queryMock.mockRejectedValueOnce(pgErr('42703'))
    expect(await loadHabContext('tenant_sotra', 'u1')).toBeNull()
  })

  it('erreur sur interrupteur autre que schéma -> relancée', async () => {
    queryMock.mockRejectedValueOnce(pgErr('08006'))
    await expect(loadHabContext('tenant_sotra', 'u1')).rejects.toThrow()
  })

  it('enforced + is_head_office absent (42703) -> contexte conservé, headOfficeEntityIds vide', async () => {
    route(row({ kind: 'siege', legal_entity_id: null, permissions: ['employees:view'] }), { headOfficeError: pgErr('42703') })
    const ctx = await loadHabContext('tenant_sotra', 'u1')
    expect(ctx).not.toBeNull()
    expect(ctx!.kind).toBe('siege')
    expect(ctx!.headOfficeEntityIds).toEqual([])
    expect(can(ctx!, 'employees', 'view')).toBe(true)
    expect(hrScopeSql('tenant_sotra', 'e', ctx)).toBe('e.legal_entity_id IS NULL')
  })

  it('enforced + autre erreur sur les filiales siège -> relancée', async () => {
    route(row({ kind: 'siege', legal_entity_id: null }), { headOfficeError: pgErr('08006') })
    await expect(loadHabContext('tenant_sotra', 'u1')).rejects.toThrow()
  })

  it('schéma invalide rejeté', async () => {
    await expect(loadHabContext('x"; DROP', 'u1')).rejects.toThrow()
  })
})

describe('hrScopeSql', () => {
  const base: HabContext = {
    userId: 'u1', subgroupId: 'sg', kind: 'entity', legalEntityId: ENT, permissions: new Set(),
    allEntities: false, sensitive: false, manageHabilitations: false, selfEmployeeId: null,
    headOfficeEntityIds: [],
  }
  it('null -> TRUE', () => expect(hrScopeSql('tenant_sotra', 'e', null)).toBe('TRUE'))
  it('entité', () => expect(hrScopeSql('tenant_sotra', 'e', base)).toBe(`e.legal_entity_id = '${ENT}'`))
  it('siège sans allEntities', () =>
    expect(hrScopeSql('tenant_sotra', 'e', { ...base, kind: 'siege', legalEntityId: null })).toContain('legal_entity_id IS NULL'))
  const siege: HabContext = { ...base, kind: 'siege', legalEntityId: null }
  const OTHER = '22222222-2222-4222-8222-222222222222'
  it('siège + filiale siège social : NULL OU IN (...)', () =>
    expect(hrScopeSql('tenant_sotra', 'e', { ...siege, headOfficeEntityIds: [ENT] }))
      .toBe(`(e.legal_entity_id IS NULL OR e.legal_entity_id IN ('${ENT}'))`))
  it('siège + plusieurs filiales siège social', () =>
    expect(hrScopeSql('tenant_sotra', 'e', { ...siege, headOfficeEntityIds: [ENT, OTHER] }))
      .toBe(`(e.legal_entity_id IS NULL OR e.legal_entity_id IN ('${ENT}','${OTHER}'))`))
  it('siège + liste vide : NULL seul', () =>
    expect(hrScopeSql('tenant_sotra', 'e', { ...siege, headOfficeEntityIds: [] })).toBe('e.legal_entity_id IS NULL'))
  it('siège + id invalide dans la liste lève', () =>
    expect(() => hrScopeSql('tenant_sotra', 'e', { ...siege, headOfficeEntityIds: ["x' OR 1=1"] })).toThrow())
  it('siège allEntities ignore la liste', () =>
    expect(hrScopeSql('tenant_sotra', 'e', { ...siege, allEntities: true, headOfficeEntityIds: [ENT] })).toBe('TRUE'))
  it('filiale : la liste est ignorée', () =>
    expect(hrScopeSql('tenant_sotra', 'e', { ...base, headOfficeEntityIds: [OTHER] })).toBe(`e.legal_entity_id = '${ENT}'`))
  it('siège avec allEntities', () =>
    expect(hrScopeSql('tenant_sotra', 'e', { ...base, kind: 'siege', legalEntityId: null, allEntities: true })).toBe('TRUE'))
  it('entité avec allEntities forcé reste restreinte', () =>
    expect(hrScopeSql('tenant_sotra', 'e', { ...base, allEntities: true })).toContain("legal_entity_id = '"))
  it('uuid invalide lève', () =>
    expect(() => hrScopeSql('tenant_sotra', 'e', { ...base, legalEntityId: "x' OR 1=1" })).toThrow())
  it('entité sans uuid lève', () =>
    expect(() => hrScopeSql('tenant_sotra', 'e', { ...base, legalEntityId: null })).toThrow())
  it('alias invalide lève', () =>
    expect(() => hrScopeSql('tenant_sotra', 'e; DROP', base)).toThrow())
})
