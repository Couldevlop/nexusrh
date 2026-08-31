import { describe, it, expect } from 'vitest'
import {
  DISCIPLINE_TYPES,
  DISCIPLINE_STATUSES,
  isValidStatus,
  canTransition,
} from './discipline.service.js'

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

})
