import { describe, it, expect } from 'vitest'
import { CI_OVERTIME_RULES, CI_OVERTIME_LEGACY_LABELS, ciOvertimeRuleMigrations } from './payroll-rules-ci-2023.js'

describe('rubriques heures supplémentaires CI (décret n° 2024-898)', () => {
  it('5 rubriques, une par clé du moteur', () => {
    expect(CI_OVERTIME_RULES.map(r => [r.code, r.formula])).toEqual([
      ['1400', 'VAR:HEURES_SUPP_NORM'],
      ['1450', 'VAR:HEURES_SUPP_47'],
      ['1500', 'VAR:HEURES_SUPP_NUIT'],
      ['1520', 'VAR:HEURES_SUPP_DIM'],
      ['1550', 'VAR:HEURES_SUPP_FERIE'],
    ])
  })

  it('migration lazy : libellé mis à jour SEULEMENT s’il vaut encore le libellé d’origine', () => {
    const sql = ciOvertimeRuleMigrations('tenant_x')
    const updates = sql.filter(q => q.startsWith('UPDATE'))
    expect(updates).toHaveLength(3)
    for (const [code, legacy] of Object.entries(CI_OVERTIME_LEGACY_LABELS)) {
      const u = updates.find(q => q.includes(`code = '${code}'`))
      expect(u, code).toBeDefined()
      expect(u).toContain(`label = '${legacy}'`)
      expect(u).toContain('"tenant_x".payroll_rules')
    }
  })

  it('migration lazy : rubriques 1450 / 1520 ajoutées si absentes, pour les tenants à rubriques CI', () => {
    const inserts = ciOvertimeRuleMigrations('tenant_x').filter(q => q.startsWith('INSERT'))
    expect(inserts).toHaveLength(2)
    for (const [code, key] of [['1450', 'HEURES_SUPP_47'], ['1520', 'HEURES_SUPP_DIM']] as const) {
      const q = inserts.find(i => i.includes(`'${code}'`))
      expect(q, code).toBeDefined()
      expect(q).toContain(`NOT EXISTS (SELECT 1 FROM "tenant_x".payroll_rules WHERE formula = 'VAR:${key}')`)
      expect(q).toContain(`EXISTS (SELECT 1 FROM "tenant_x".payroll_rules WHERE formula = 'VAR:HEURES_SUPP_NORM')`)
    }
  })

  it('refuse un nom de schéma invalide', () => {
    expect(() => ciOvertimeRuleMigrations('x"; DROP')).toThrow()
  })
})
