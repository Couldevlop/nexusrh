import { describe, it, expect } from 'vitest'
import {
  MOBILITY_STATUSES, canTransition, isDecision, gapAnalysis, type RequiredItem,
} from './mobility.service.js'

describe('mobility.service — workflow', () => {
  it('proposed → in_review → approved/rejected', () => {
    expect(canTransition('proposed', 'in_review')).toBe(true)
    expect(canTransition('in_review', 'approved')).toBe(true)
    expect(canTransition('in_review', 'rejected')).toBe(true)
    expect(canTransition('proposed', 'approved')).toBe(false) // doit passer par in_review
    expect(canTransition('approved', 'in_review')).toBe(false)
    expect(MOBILITY_STATUSES).toContain('cancelled')
  })
  it('isDecision', () => {
    expect(isDecision('approved')).toBe(true)
    expect(isDecision('rejected')).toBe(true)
    expect(isDecision('in_review')).toBe(false)
  })
})

describe('mobility.service — analyse d\'écart', () => {
  const required: RequiredItem[] = [
    { competencyId: 'c1', label: 'Excel', requiredLevel: 4 },
    { competencyId: 'c2', label: 'Leadership', requiredLevel: 5 },
    { competencyId: 'c3', label: 'Anglais', requiredLevel: 3 },
  ]
  it('calcule l\'écart (requis − acquis), couverture et prêt', () => {
    const assessed = new Map<string, number>([['c1', 4], ['c2', 3]]) // c3 non évalué
    const g = gapAnalysis(required, assessed)
    expect(g.rows.map((r) => r.label)).toEqual(['Anglais', 'Excel', 'Leadership']) // trié
    const excel = g.rows.find((r) => r.competencyId === 'c1')!
    expect(excel.gap).toBe(0) // 4 requis, 4 acquis
    const lead = g.rows.find((r) => r.competencyId === 'c2')!
    expect(lead.gap).toBe(2) // 5 − 3
    const eng = g.rows.find((r) => r.competencyId === 'c3')!
    expect(eng.currentLevel).toBeNull()
    expect(eng.gap).toBe(3) // 3 − 0
    expect(g.gapsCount).toBe(2)
    expect(g.ready).toBe(false)
    expect(g.coveragePct).toBe(33) // 1/3 sans écart
  })
  it('prêt si aucun écart', () => {
    const g = gapAnalysis(required, new Map([['c1', 4], ['c2', 5], ['c3', 3]]))
    expect(g.gapsCount).toBe(0)
    expect(g.ready).toBe(true)
    expect(g.coveragePct).toBe(100)
  })
  it('poste sans compétence requise → non prêt (rien à comparer)', () => {
    const g = gapAnalysis([], new Map())
    expect(g.ready).toBe(false)
    expect(g.coveragePct).toBe(100)
  })
})
