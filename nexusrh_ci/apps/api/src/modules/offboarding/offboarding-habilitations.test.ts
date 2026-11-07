/**
 * Coupure des droits au départ (tâche 14).
 *
 * Ce que ce banc protège : le jour où quelqu'un quitte l'entreprise, ses
 * habilitations RH doivent tomber avec son compte — et ses délégations aussi,
 * dans les deux sens. Un départ qui laisse une procuration vivante laisse
 * quelqu'un agir au nom d'une personne partie ; c'est le pire cas d'un contrôle
 * d'accès, et il ne se voit pas à l'écran.
 *
 * La révocation est posée DANS la cascade d'archivage (le seul chemin commun à
 * la clôture d'un dossier de sortie et à l'archivage manuel d'un employé) : il
 * n'existe donc pas de départ qui l'oublie.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.unmock('../../services/habilitation.service.js')
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('../../db/pool.js', () => ({ pool: { query: queryMock } }))

import { revokeAllForUser, loadHabContext } from '../../services/habilitation.service.js'
import { archiveEmployeeCascade } from '../../services/employee-archive.service.js'
import type { Pool } from 'pg'

const SCHEMA = 'tenant_sotra'
const USER = '66666666-6666-4666-8666-666666666666'
const EMP = '77777777-7777-4777-8777-777777777777'

interface Store {
  /** Affectation encore active ? (le moteur ne doit plus rien rendre après coup) */
  assignmentActive: boolean
  sqls: string[]
  audits: Array<{ action: string; entityId: string; changes: Record<string, unknown> }>
  userIdsForEmployee: string[]
}
let store: Store

beforeEach(() => {
  store = { assignmentActive: true, sqls: [], audits: [], userIdsForEmployee: [USER] }
  queryMock.mockReset()
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const q = String(sql).replace(/\s+/g, ' ')
    store.sqls.push(q)
    if (q.includes('platform.tenants')) return { rows: [{ enforced: true }] }
    if (q.includes('INSERT INTO') && q.includes('audit_log')) {
      store.audits.push({
        action: String(params[1]), entityId: String(params[3]),
        changes: JSON.parse(String(params[4])) as Record<string, unknown>,
      })
      return { rows: [], rowCount: 1 }
    }
    // Révocation de l'affectation : marque le magasin, le moteur rendra null.
    if (q.includes('UPDATE') && q.includes('hab_assignments')) {
      store.assignmentActive = false
      return { rows: [{ id: 'a-1' }], rowCount: 1 }
    }
    if (q.includes('UPDATE') && q.includes('hab_delegations')) {
      return { rows: [{ id: 'd-1' }, { id: 'd-2' }], rowCount: 2 }
    }
    // Contexte d'habilitation (INTERSECT fiche ∩ plafond).
    if (q.includes('INTERSECT')) {
      if (!store.assignmentActive) return { rows: [] }
      return {
        rows: [{
          user_id: USER, subgroup_id: 'sg-1', kind: 'siege', legal_entity_id: null,
          permissions: ['employees:view'], active: true, self_employee_id: EMP,
        }],
      }
    }
    if (q.includes('is_head_office = true')) return { rows: [] }
    if (q.includes('FROM') && q.includes('users') && q.includes('employee_id')) {
      return { rows: store.userIdsForEmployee.map((id) => ({ id })) }
    }
    return { rows: [], rowCount: 0 }
  })
})

describe('revokeAllForUser', () => {
  it('coupe l\'affectation : le moteur ne rend plus aucun droit', async () => {
    expect(await loadHabContext(SCHEMA, USER)).not.toBeNull()
    await revokeAllForUser(SCHEMA, USER, 'offboarding')
    expect(await loadHabContext(SCHEMA, USER)).toBeNull()
  })

  it('révoque les délégations DONNÉES et REÇUES', async () => {
    await revokeAllForUser(SCHEMA, USER, 'offboarding')
    const deleg = store.sqls.find((s) => s.includes('UPDATE') && s.includes('hab_delegations'))
    expect(deleg).toBeDefined()
    expect(deleg).toContain('delegator_id')
    expect(deleg).toContain('delegate_id')
    expect(deleg).toContain('revoked_at IS NULL')
  })

  it('trace la révocation avec sa cause', async () => {
    await revokeAllForUser(SCHEMA, USER, 'user_disabled')
    const t = store.audits.find((a) => a.action === 'habilitation.revoked')
    expect(t).toBeDefined()
    expect(t?.entityId).toBe(USER)
    expect(t?.changes).toMatchObject({ reason: 'user_disabled' })
  })

  it('un identifiant non-UUID n\'écrit rien', async () => {
    await revokeAllForUser(SCHEMA, 'pas-un-uuid', 'offboarding')
    expect(store.sqls.filter((s) => s.includes('hab_'))).toEqual([])
  })

  it('un tenant sans les tables d\'habilitation ne fait pas échouer le départ', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }))
    await expect(revokeAllForUser(SCHEMA, USER, 'offboarding')).resolves.toBeUndefined()
  })
})

describe('archiveEmployeeCascade — le départ emporte les habilitations', () => {
  const fakePool = { query: queryMock } as unknown as Pool

  it('révoque les droits du compte lié à l\'employé', async () => {
    const res = await archiveEmployeeCascade(fakePool, SCHEMA, EMP)
    expect(res.revokedHabilitations).toBe(1)
    expect(store.sqls.some((s) => s.includes('UPDATE') && s.includes('hab_assignments'))).toBe(true)
    expect(store.audits.map((a) => a.action)).toContain('habilitation.revoked')
  })

  it('un employé sans compte de connexion : rien à révoquer, aucune erreur', async () => {
    store.userIdsForEmployee = []
    const res = await archiveEmployeeCascade(fakePool, SCHEMA, EMP)
    expect(res.revokedHabilitations).toBe(0)
    expect(store.sqls.some((s) => s.includes('hab_assignments'))).toBe(false)
  })
})
