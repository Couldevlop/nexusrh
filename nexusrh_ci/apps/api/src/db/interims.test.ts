/**
 * Table des intérims : ce que le provisioning et la migration lazy posent.
 *
 * Deux propriétés comptent ici et nulle part ailleurs : les ordres sont
 * rejouables sur un tenant déjà migré (le même tableau sert aux deux chemins),
 * et la base refuse elle-même ce que l'API refuse déjà — on ne se désigne pas
 * son propre suppléant, même par un accès direct à PostgreSQL.
 */
import { describe, it, expect } from 'vitest'
import { interimTableStatements } from './interims.js'

describe('interimTableStatements', () => {
  const sql = interimTableStatements('tenant_x')

  it('crée la table dans le schéma du tenant, jamais ailleurs', () => {
    expect(sql.some(s => s.includes('CREATE TABLE IF NOT EXISTS "tenant_x".approval_interims ('))).toBe(true)
    // Aucune table partagée ni publique : l'isolation tenant est non négociable.
    for (const s of sql) expect(s).not.toMatch(/\bpublic\.|\bshared\./)
  })

  it('interdit en base de se désigner soi-même suppléant', () => {
    expect(sql.some(s => /CHECK \(absent_user_id <> interim_user_id\)/.test(s))).toBe(true)
  })

  it('garde le congé d’origine, y compris sur un tenant déjà provisionné', () => {
    expect(sql.some(s => s.includes('absence_id      uuid'))).toBe(true)
    expect(sql.some(s => /ALTER TABLE .* ADD COLUMN IF NOT EXISTS absence_id uuid/.test(s))).toBe(true)
  })

  it('indexe les intérims EN COURS, par suppléant et par remplacé', () => {
    const idx = sql.filter(s => s.includes('CREATE INDEX IF NOT EXISTS'))
    expect(idx).toHaveLength(2)
    // Partiels : les intérims révoqués ne pèsent pas sur la recherche.
    for (const s of idx) expect(s).toContain('WHERE revoked_at IS NULL')
    expect(idx.some(s => s.includes('(interim_user_id)'))).toBe(true)
    expect(idx.some(s => s.includes('(absent_user_id)'))).toBe(true)
  })

  it('est rejouable : chaque ordre est idempotent', () => {
    for (const s of sql) {
      expect(s).toMatch(/IF NOT EXISTS/)
    }
  })
})
