import { describe, it, expect } from 'vitest'
import {
  CRITICALITY_LEVELS,
  READINESS_LEVELS,
  isValidCriticality,
  isValidReadiness,
  isValidPlanStatus,
  summarizeCoverage,
} from './succession.service.js'

describe('succession.service — validations', () => {
  it('criticité / readiness / statut', () => {
    expect(isValidCriticality('critical')).toBe(true)
    expect(isValidCriticality('meh')).toBe(false)
    expect(isValidReadiness('ready_now')).toBe(true)
    expect(isValidReadiness('soon')).toBe(false)
    expect(isValidPlanStatus('archived')).toBe(true)
    expect(CRITICALITY_LEVELS.length).toBe(4)
    expect(READINESS_LEVELS[0]).toBe('ready_now')
  })
})

describe('succession.service — synthèse de couverture', () => {
  it('plan sans candidat → atRisk', () => {
    const s = summarizeCoverage([])
    expect(s.candidateCount).toBe(0)
    expect(s.readyNow).toBe(0)
    expect(s.atRisk).toBe(true)
  })
  it('candidats sans « ready_now » → atRisk', () => {
    const s = summarizeCoverage(['short_term', 'medium_term'])
    expect(s.candidateCount).toBe(2)
    expect(s.readyNow).toBe(0)
    expect(s.atRisk).toBe(true)
  })
  it('au moins un « ready_now » → couvert', () => {
    const s = summarizeCoverage(['ready_now', 'long_term'])
    expect(s.readyNow).toBe(1)
    expect(s.atRisk).toBe(false)
    expect(s.byReadiness.ready_now).toBe(1)
    expect(s.byReadiness.long_term).toBe(1)
  })
  it('valeurs inconnues comptées comme candidat mais non classées', () => {
    const s = summarizeCoverage(['ready_now', 'bogus', null, undefined])
    expect(s.candidateCount).toBe(2) // ready_now + bogus ; null/undefined ignorés
    expect(s.readyNow).toBe(1)
  })
})
