import { describe, it, expect, vi } from 'vitest'

vi.unmock('./habilitation.service.js')
vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }))

import {
  assertNotSelf, isSelfAction, SelfActionError, type HabContext,
} from './habilitation.service.js'

function ctx(selfEmployeeId: string | null): HabContext {
  return {
    userId: 'u1', subgroupId: 'sg', kind: 'siege', legalEntityId: null,
    permissions: new Set(['employees:update']), allEntities: true, sensitive: false,
    manageHabilitations: false, selfEmployeeId,
  }
}

describe('assertNotSelf', () => {
  it('lève pour un id identique', () => {
    expect(() => assertNotSelf(ctx('e1'), 'e1')).toThrow(SelfActionError)
  })
  it('insensible à la casse et aux espaces (UUID majuscules)', () => {
    const id = '11111111-2222-4333-8444-abcdefabcdef'
    expect(() => assertNotSelf(ctx(id), id.toUpperCase())).toThrow(SelfActionError)
    expect(() => assertNotSelf(ctx(id.toUpperCase()), ` ${id} `)).toThrow(SelfActionError)
  })
  it('ne lève rien pour ctx null, autre id ou sans fiche', () => {
    expect(() => assertNotSelf(null, 'e1')).not.toThrow()
    expect(() => assertNotSelf(ctx('e1'), 'e2')).not.toThrow()
    expect(() => assertNotSelf(ctx(null), 'e1')).not.toThrow()
  })
  it('isSelfAction ignore le rôle effectif employee', () => {
    expect(isSelfAction({ hab: ctx('e1'), user: { role: 'hr_manager' } }, 'e1')).toBe(true)
    expect(isSelfAction({ hab: ctx('e1'), user: { role: 'employee' } }, 'e1')).toBe(false)
    expect(isSelfAction({ hab: null, user: { role: 'hr_manager' } }, 'e1')).toBe(false)
  })
})
