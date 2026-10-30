import { describe, it, expect } from 'vitest'
import { habilitationTableStatements } from './habilitations.js'

const TABLES = [
  'hab_groups', 'hab_subgroups', 'hab_assignments', 'hab_fiches',
  'hab_fiche_events', 'hab_delegations', 'hab_templates', 'hab_sod_rules',
]

describe('habilitationTableStatements', () => {
  const sql = habilitationTableStatements('tenant_x')

  it('crée les 8 tables en IF NOT EXISTS dans le schéma du tenant', () => {
    for (const t of TABLES) {
      expect(sql.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS "tenant_x".${t} (`))).toBe(true)
    }
  })

  it('pose les index uniques user_id (assignations) et legal_entity_id (sous-groupes)', () => {
    expect(sql.some((s) => /UNIQUE INDEX IF NOT EXISTS[\s\S]*hab_assignments\(user_id\)/.test(s))).toBe(true)
    expect(sql.some((s) => /UNIQUE INDEX IF NOT EXISTS[\s\S]*hab_subgroups\(legal_entity_id\)/.test(s))).toBe(true)
  })

  it('amorce les 4 règles SoD par défaut de façon idempotente', () => {
    const ins = sql.filter((s) => s.includes('INSERT INTO "tenant_x".hab_sod_rules'))
    expect(ins.length).toBeGreaterThan(0)
    for (const s of ins) expect(s).toContain('ON CONFLICT (left_perm, right_perm) DO NOTHING')
    const all = ins.join('\n')
    expect(all).toContain('payroll:validate')
    expect(all).toContain('payments:pay')
    expect(all).toContain('payroll:configure')
    expect(all).toContain('employees:create')
  })
})
