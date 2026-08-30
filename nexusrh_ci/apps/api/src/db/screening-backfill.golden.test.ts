/**
 * Golden — le rattrapage du pré-tri n'est PAS rejouable.
 *
 * `ensureRecruitmentSchemaMigrated` n'est pas mémoïsée : elle rejoue toutes ses
 * instructions à chaque appel, et le dépôt ne possède aucune table de suivi des
 * migrations. Un rattrapage naïf (`UPDATE … WHERE screening_decision IS NULL`)
 * approuverait donc, à chaque requête, tous les dossiers en attente de revue —
 * détruisant exactement la garantie que le pré-tri est censé apporter (aucun
 * rejet ni aucune validation sans décision humaine).
 *
 * La non-rejouabilité est ici STRUCTURELLE : le `SET NOT NULL` posé en fin de
 * séquence rend la condition du rattrapage insatisfiable pour toujours.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
}))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../config.js', () => ({
  config: {
    env: 'test',
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
  },
}))

import { ensureRecruitmentSchemaMigrated } from './provisioning.js'

/** Aplatit le SQL de chaque appel pour rendre les assertions lisibles. */
const sqlOf = (calls: unknown[][]): string[] =>
  calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim())

beforeEach(() => {
  queryMock.mockClear()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('Rattrapage du pré-tri', () => {
  it('pose le verdict en NOT NULL APRÈS le rattrapage, jamais avant', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const sql = sqlOf(queryMock.mock.calls)

    const iAdd = sql.findIndex((s) => /ADD COLUMN IF NOT EXISTS screening_verdict/.test(s))
    const iFill = sql.findIndex((s) =>
      /UPDATE .*applications SET screening_decision = COALESCE/.test(s))
    const iDefault = sql.findIndex((s) =>
      /ALTER COLUMN screening_verdict SET DEFAULT/.test(s))
    const iNotNull = sql.findIndex((s) =>
      /ALTER COLUMN screening_verdict SET NOT NULL/.test(s))

    expect(iAdd, 'colonne screening_verdict ajoutée').toBeGreaterThanOrEqual(0)
    expect(iFill, 'rattrapage présent').toBeGreaterThan(iAdd)
    expect(iDefault, 'défaut posé après le rattrapage').toBeGreaterThan(iFill)
    expect(iNotNull, 'NOT NULL posé après le rattrapage').toBeGreaterThan(iFill)
  })

  it('le rattrapage ne cible que les lignes SANS verdict', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const fill = sqlOf(queryMock.mock.calls).find((s) =>
      /UPDATE .*applications SET screening_decision = COALESCE/.test(s))

    expect(fill).toBeDefined()
    // La condition DOIT porter sur screening_verdict. Si elle portait sur
    // screening_decision, chaque réexécution trancherait les dossiers en attente.
    expect(fill).toMatch(/WHERE screening_verdict IS NULL/)
    expect(fill).not.toMatch(/WHERE screening_decision IS NULL/)
  })

  it('préserve une décision humaine déjà prise (COALESCE, jamais d’écrasement)', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const fill = sqlOf(queryMock.mock.calls).find((s) =>
      /UPDATE .*applications SET screening_decision = COALESCE/.test(s))
    expect(fill).toMatch(/screening_decision = COALESCE\(screening_decision, 'kept'\)/)
    expect(fill).toMatch(/screening_reason = COALESCE\(screening_reason/)
  })

  it('rejouer dix fois produit exactement la même séquence', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const first = sqlOf(queryMock.mock.calls)
    expect(first.length).toBeGreaterThan(0)

    for (let i = 0; i < 9; i++) {
      queryMock.mockClear()
      await ensureRecruitmentSchemaMigrated('tenant_demo')
      expect(sqlOf(queryMock.mock.calls)).toEqual(first)
    }
  })

  it('ajoute les colonnes de décision humaine et les questions de l’offre', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const sql = sqlOf(queryMock.mock.calls).join(' | ')
    for (const col of [
      'screening_answers', 'screening_decided_by',
      'screening_decided_at', 'screening_reason',
    ]) {
      expect(sql, `colonne ${col}`).toContain(`ADD COLUMN IF NOT EXISTS ${col}`)
    }
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS screening_questions')
  })
})
