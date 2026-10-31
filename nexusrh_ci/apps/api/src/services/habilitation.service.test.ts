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

describe('loadHabContext', () => {
  it('aucune ligne -> null (accès hérité) ; une seule requête LEFT JOIN', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const ctx = await loadHabContext('tenant_sotra', 'u1')
    expect(ctx).toBeNull()
    expect(hrScopeSql('tenant_sotra', 'e', ctx)).toBe('TRUE')
    expect(queryMock).toHaveBeenCalledTimes(1)
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toContain('LEFT JOIN "tenant_sotra".hab_subgroups')
    expect(sql).toContain('revoked_at IS NULL')
    expect(sql).toContain('effective_from <= current_date')
    expect(sql).toContain('INTERSECT')
  })

  it('interrupteur désactivé (enforced=false) -> null même avec une affectation', async () => {
    queryMock.mockResolvedValue({ rows: [row({ enforced: false })] })
    expect(await loadHabContext('tenant_sotra', 'u1')).toBeNull()
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toContain('platform.tenants')
    expect(sql).toContain('habilitations_enforced')
    expect(sql).toContain('is_head_office')
  })

  it('interrupteur désactivé et ligne révoquée -> null (pas de refus)', async () => {
    queryMock.mockResolvedValue({ rows: [row({ enforced: false, active: false })] })
    expect(await loadHabContext('tenant_sotra', 'u1')).toBeNull()
  })

  it('enforced=true : contexte inchangé et ids du siège chargés', async () => {
    queryMock.mockResolvedValue({ rows: [row({ kind: 'siege', legal_entity_id: null, head_office_ids: [ENT] })] })
    const ctx = await loadHabContext('tenant_sotra', 'u1')
    expect(ctx!.kind).toBe('siege')
    expect(ctx!.headOfficeEntityIds).toEqual([ENT])
  })

  it('refus / filiale : headOfficeEntityIds vide', async () => {
    queryMock.mockResolvedValue({ rows: [row({ head_office_ids: [ENT] })] })
    expect((await loadHabContext('tenant_sotra', 'u1'))!.headOfficeEntityIds).toEqual([])
    queryMock.mockResolvedValue({ rows: [row({ active: false, head_office_ids: [ENT] })] })
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
    queryMock.mockResolvedValue({ rows: [row({ active: false })] })
    expectDeny(await loadHabContext('tenant_sotra', 'u1'))
  })

  it('ligne à effet futur -> contexte de refus', async () => {
    queryMock.mockResolvedValue({ rows: [row({ active: false, permissions: [] })] })
    expectDeny(await loadHabContext('tenant_sotra', 'u1'))
  })

  it('sous-groupe absent (colonnes sg nulles) -> contexte de refus', async () => {
    queryMock.mockResolvedValue({ rows: [row({ active: false, kind: null, legal_entity_id: null, permissions: [] })] })
    expectDeny(await loadHabContext('tenant_sotra', 'u1'))
  })

  it('subgroup_id NULL -> contexte de refus', async () => {
    queryMock.mockResolvedValue({ rows: [row({ subgroup_id: null, active: false, kind: null, legal_entity_id: null })] })
    expectDeny(await loadHabContext('tenant_sotra', 'u1'))
  })

  it('payroll:validate faux quand absent des droits effectifs (plafond)', async () => {
    queryMock.mockResolvedValue({ rows: [row({ permissions: ['payroll:view'] })] })
    const ctx = await loadHabContext('tenant_sotra', 'u1')
    expect(ctx).not.toBeNull()
    expect(can(ctx!, 'payroll', 'validate')).toBe(false)
    expect(can(ctx!, 'payroll', 'view')).toBe(true)
  })

  it('un plafond retiré se reflète au prochain appel (pas de cache)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ permissions: ['payroll:validate'] })] })
    expect(can((await loadHabContext('tenant_sotra', 'u1'))!, 'payroll', 'validate')).toBe(true)
    queryMock.mockResolvedValueOnce({ rows: [row({ permissions: [] })] })
    expect(can((await loadHabContext('tenant_sotra', 'u1'))!, 'payroll', 'validate')).toBe(false)
  })

  it('sensitive vrai avec payroll:view, ou sensitive_data', async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ permissions: ['payroll:view'] })] })
    expect((await loadHabContext('tenant_sotra', 'u1'))!.sensitive).toBe(true)
    queryMock.mockResolvedValueOnce({ rows: [row({ permissions: ['sensitive_data'] })] })
    expect((await loadHabContext('tenant_sotra', 'u1'))!.sensitive).toBe(true)
    queryMock.mockResolvedValueOnce({ rows: [row({ permissions: ['employees:view'] })] })
    expect((await loadHabContext('tenant_sotra', 'u1'))!.sensitive).toBe(false)
  })

  it('allEntities ignoré pour une entité, actif pour le siège', async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ permissions: ['all_entities'] })] })
    expect((await loadHabContext('tenant_sotra', 'u1'))!.allEntities).toBe(false)
    queryMock.mockResolvedValueOnce({ rows: [row({ kind: 'siege', legal_entity_id: null, permissions: ['all_entities', 'manage_habilitations'] })] })
    const ctx = (await loadHabContext('tenant_sotra', 'u1'))!
    expect(ctx.allEntities).toBe(true)
    expect(ctx.manageHabilitations).toBe(true)
    expect(ctx.selfEmployeeId).toBe('e1')
  })

  it('table absente (42P01) -> null ; autre erreur relancée', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '42P01' }))
    expect(await loadHabContext('tenant_sotra', 'u1')).toBeNull()
    queryMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '08006' }))
    await expect(loadHabContext('tenant_sotra', 'u1')).rejects.toThrow('boom')
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
