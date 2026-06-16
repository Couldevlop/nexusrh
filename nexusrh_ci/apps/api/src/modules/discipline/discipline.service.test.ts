import { describe, it, expect } from 'vitest'
import {
  DISCIPLINE_TYPES,
  DISCIPLINE_STATUSES,
  isValidType,
  isValidStatus,
  severityOf,
  canTransition,
  isTerminal,
} from './discipline.service.js'

describe('discipline.service — types & statuts', () => {
  it('échelle disciplinaire ordonnée par sévérité croissante', () => {
    const sevs = DISCIPLINE_TYPES.map(severityOf)
    for (let i = 1; i < sevs.length; i++) {
      expect(sevs[i]!).toBeGreaterThan(sevs[i - 1]!)
    }
    expect(severityOf('observation')).toBe(1)
    expect(severityOf('licenciement')).toBe(5)
  })

  it('isValidType / isValidStatus', () => {
    expect(isValidType('blame')).toBe(true)
    expect(isValidType('inconnu')).toBe(false)
    expect(isValidStatus('issued')).toBe(true)
    expect(isValidStatus(42)).toBe(false)
  })
})

describe('discipline.service — transitions de statut', () => {
  it('transitions valides depuis draft', () => {
    expect(canTransition('draft', 'issued')).toBe(true)
    expect(canTransition('draft', 'cancelled')).toBe(true)
    expect(canTransition('draft', 'closed')).toBe(false)
  })

  it('transitions valides depuis issued', () => {
    expect(canTransition('issued', 'contested')).toBe(true)
    expect(canTransition('issued', 'closed')).toBe(true)
    expect(canTransition('issued', 'draft')).toBe(false)
  })

  it('idempotence : from === to toujours autorisé', () => {
    for (const s of DISCIPLINE_STATUSES) expect(canTransition(s, s)).toBe(true)
  })

  it('états terminaux closed / cancelled', () => {
    expect(isTerminal('closed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('draft')).toBe(false)
    expect(canTransition('closed', 'issued')).toBe(false)
    expect(canTransition('cancelled', 'issued')).toBe(false)
  })
})
