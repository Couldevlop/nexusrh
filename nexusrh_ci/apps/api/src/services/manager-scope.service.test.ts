import { describe, it, expect, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  managerScopeSql, isInManagerScope, wouldCreateManagerCycle, resolveManagerEmployeeId,
} from './manager-scope.service.js'

const MGR = '11111111-1111-1111-1111-111111111111'
const EMP = '22222222-2222-2222-2222-222222222222'

function fakePool(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows })
  return { pool: { query } as unknown as Pool, query }
}

describe('managerScopeSql', () => {
  it('inclut toujours l’équipe directe', () => {
    expect(managerScopeSql('tenant_sotra', 'e', '$3')).toContain('e.manager_id = $3')
  })

  it('n’étend à la branche que si le tenant a choisi hierarchy (lu en SQL)', () => {
    const sql = managerScopeSql('tenant_sotra', 'e', '$3')
    expect(sql).toContain(`mst.schema_name = 'tenant_sotra' AND mst.manager_scope = 'hierarchy'`)
    expect(sql).toContain('WITH RECURSIVE branch')
  })

  it('UNION (pas UNION ALL) pour qu’un cycle ne boucle pas, et exclut le manager', () => {
    const sql = managerScopeSql('tenant_sotra', 'e', '$3')
    expect(sql).toMatch(/\bUNION\b(?!\s+ALL)/)
    expect(sql).toContain('WHERE id <> $3::uuid')
  })

  it('forceHierarchy ignore le réglage tenant', () => {
    const sql = managerScopeSql('tenant_sotra', 'e', '$2', { forceHierarchy: true })
    expect(sql).not.toContain('platform.tenants')
    expect(sql).toContain('WITH RECURSIVE branch')
  })

  it('refuse un nom de schéma injectable (interpolé comme littéral)', () => {
    expect(() => managerScopeSql("x'; DROP TABLE y; --", 'e', '$1')).toThrow()
  })
})

describe('isInManagerScope', () => {
  it('fail-closed sans dossier manager', async () => {
    const { pool, query } = fakePool([{ id: EMP }])
    expect(await isInManagerScope(pool, 'tenant_sotra', null, EMP)).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })

  it('jamais sur soi-même (anti auto-approbation)', async () => {
    const { pool, query } = fakePool([{ id: MGR }])
    expect(await isInManagerScope(pool, 'tenant_sotra', MGR, MGR)).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })

  it('vrai si la requête de périmètre trouve l’employé', async () => {
    const { pool, query } = fakePool([{ id: EMP }])
    expect(await isInManagerScope(pool, 'tenant_sotra', MGR, EMP)).toBe(true)
    expect(query.mock.calls[0]![1]).toEqual([EMP, MGR])
  })

  it('faux sinon', async () => {
    const { pool } = fakePool([])
    expect(await isInManagerScope(pool, 'tenant_sotra', MGR, EMP)).toBe(false)
  })
})

describe('wouldCreateManagerCycle', () => {
  it('soi-même comme responsable = cycle', async () => {
    const { pool, query } = fakePool()
    expect(await wouldCreateManagerCycle(pool, 'tenant_sotra', EMP, EMP)).toBe(true)
    expect(query).not.toHaveBeenCalled()
  })

  it('un subordonné comme responsable = cycle (branche complète, quel que soit le réglage)', async () => {
    const { pool, query } = fakePool([{ id: MGR }])
    expect(await wouldCreateManagerCycle(pool, 'tenant_sotra', EMP, MGR)).toBe(true)
    expect(query.mock.calls[0]![0]).not.toContain('platform.tenants')
    expect(query.mock.calls[0]![1]).toEqual([MGR, EMP])
  })

  it('pas de cycle sinon', async () => {
    const { pool } = fakePool([])
    expect(await wouldCreateManagerCycle(pool, 'tenant_sotra', EMP, MGR)).toBe(false)
  })
})

describe('resolveManagerEmployeeId', () => {
  it('employeeId du token prioritaire, sans requête', async () => {
    const { pool, query } = fakePool()
    expect(await resolveManagerEmployeeId(pool, 'tenant_sotra', { employeeId: MGR, email: 'm@x.ci' })).toBe(MGR)
    expect(query).not.toHaveBeenCalled()
  })

  it('repli sur l’email, null si aucun dossier', async () => {
    expect(await resolveManagerEmployeeId(fakePool([{ id: MGR }]).pool, 'tenant_sotra', { email: 'm@x.ci' })).toBe(MGR)
    expect(await resolveManagerEmployeeId(fakePool([]).pool, 'tenant_sotra', { email: 'm@x.ci' })).toBeNull()
  })
})
