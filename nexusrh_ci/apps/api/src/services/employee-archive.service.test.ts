/**
 * GOLDEN — Cascade d'archivage employé (aucun processus orphelin).
 *
 * Vérifie que archiveEmployeeCascade rompt/annule TOUS les processus liés en une
 * opération cohérente : contrats actifs → terminated, sanctions non terminales →
 * cancelled, signatures en cours → cancelled ; et que les cascades secondaires
 * sont best-effort (une table absente n'interrompt pas l'archivage).
 */
import { describe, it, expect, vi } from 'vitest'
import { archiveEmployeeCascade } from './employee-archive.service.js'

const SCHEMA = 'tenant_sotra'
const EMP = '11111111-1111-1111-1111-111111111111'

// Mock pool minimal : on contrôle chaque réponse query() dans l'ordre d'appel.
function makePool(responses: Array<unknown | Error>) {
  let i = 0
  const query = vi.fn((sql: string) => {
    const r = responses[i++]
    if (r instanceof Error) return Promise.reject(r)
    return Promise.resolve(r ?? { rows: [] })
  })
  return { pool: { query } as never, query }
}

describe('archiveEmployeeCascade', () => {
  it('rompt contrats + annule sanctions + annule signatures et renvoie les compteurs', async () => {
    const { pool, query } = makePool([
      { rows: [] },                       // 1. UPDATE employees
      { rows: [] },                       // 2. UPDATE users
      { rows: [{ id: 'c1' }] },           // 3. UPDATE contracts → terminated
      { rows: [{ id: 'd1' }, { id: 'd2' }] }, // 4. UPDATE disciplinary_actions → cancelled
      { rows: [{ id: 's1' }] },           // 5. UPDATE signature_requests → cancelled
    ])
    const res = await archiveEmployeeCascade(pool, SCHEMA, EMP)
    expect(res).toEqual({ terminatedContracts: 1, cancelledDiscipline: 2, cancelledSignatures: 1 })

    const sqls = query.mock.calls.map(c => c[0] as string)
    expect(sqls[0]).toMatch(/UPDATE "tenant_sotra"\.employees SET deleted_at = now\(\), is_active = false/)
    expect(sqls[0]).toMatch(/deleted_at IS NULL/)        // idempotent
    expect(sqls[2]).toMatch(/UPDATE "tenant_sotra"\.contracts[\s\S]*status = 'terminated'/)
    expect(sqls[2]).toMatch(/status = 'active'/)         // n'agit que sur les actifs
    expect(sqls[3]).toMatch(/UPDATE "tenant_sotra"\.disciplinary_actions[\s\S]*status = 'cancelled'/)
    expect(sqls[3]).toMatch(/NOT IN \('closed', 'cancelled'\)/)
    expect(sqls[4]).toMatch(/UPDATE "tenant_sotra"\.signature_requests[\s\S]*status = 'cancelled'/)
    expect(sqls[4]).toMatch(/status IN \('draft', 'pending'\)/)
    // toutes les requêtes ciblent bien l'employé
    for (const c of query.mock.calls) expect(c[1]).toEqual([EMP])
  })

  it('best-effort : une table optionnelle absente (rejet) n\'interrompt pas l\'archivage', async () => {
    const { pool } = makePool([
      { rows: [] },                          // employees
      new Error('relation users does not exist'),   // users (catché)
      new Error('relation contracts does not exist'), // contracts (catché)
      new Error('relation disciplinary_actions does not exist'), // discipline (catché)
      new Error('relation signature_requests does not exist'),   // signatures (catché)
    ])
    const res = await archiveEmployeeCascade(pool, SCHEMA, EMP)
    // L'archivage de l'employé (étape 1) a réussi ; les compteurs retombent à 0.
    expect(res).toEqual({ terminatedContracts: 0, cancelledDiscipline: 0, cancelledSignatures: 0 })
  })
})
