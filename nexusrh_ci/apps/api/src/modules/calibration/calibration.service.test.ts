import { describe, it, expect } from 'vitest'
import {
  SESSION_STATUSES, canTransition, isValidScore, nineBox, summarizeSession,
} from './calibration.service.js'

describe('calibration.service — statuts', () => {
  it('cycle draft → in_progress → closed', () => {
    expect(canTransition('draft', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'closed')).toBe(true)
    expect(canTransition('closed', 'draft')).toBe(false)
    expect(SESSION_STATUSES).toContain('in_progress')
  })
  it('scores bornés 1–3', () => {
    expect(isValidScore(1)).toBe(true)
    expect(isValidScore(3)).toBe(true)
    expect(isValidScore(0)).toBe(false)
    expect(isValidScore(4)).toBe(false)
    expect(isValidScore(2.5)).toBe(false)
  })
})

describe('calibration.service — matrice 9-box', () => {
  it('coins : (3,3)=star, (1,1)=risk, (1,3)=enigma, (3,1)=expert', () => {
    expect(nineBox(3, 3)?.key).toBe('star')
    expect(nineBox(1, 1)?.key).toBe('risk')
    expect(nineBox(1, 3)?.key).toBe('enigma')
    expect(nineBox(3, 1)?.key).toBe('expert')
    expect(nineBox(2, 2)?.key).toBe('core')
  })
  it('cellules 1..9 uniques', () => {
    const cells = new Set<number>()
    for (let p = 1; p <= 3; p++) for (let q = 1; q <= 3; q++) cells.add(nineBox(p, q)!.cell)
    expect(cells.size).toBe(9)
  })
  it('scores absents/invalides → null', () => {
    expect(nineBox(null, 2)).toBeNull()
    expect(nineBox(2, undefined)).toBeNull()
    expect(nineBox(5, 5)).toBeNull()
  })
})

describe('calibration.service — synthèse', () => {
  it('compte par case ; l\'état APRÈS prime sur AVANT', () => {
    const s = summarizeSession([
      { performance_before: 2, potential_before: 2, performance_after: 3, potential_after: 3 }, // après → star
      { performance_before: 1, potential_before: 1, performance_after: null, potential_after: null }, // avant → risk
      { performance_before: null, potential_before: null, performance_after: null, potential_after: null }, // ignoré
    ])
    expect(s.total).toBe(2)
    expect(s.byKey.star).toBe(1)
    expect(s.byKey.risk).toBe(1)
  })
})
