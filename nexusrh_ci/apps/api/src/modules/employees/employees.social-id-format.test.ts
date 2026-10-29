import { describe, it, expect } from 'vitest'
import { isValidSocialId as valid } from './social-id.js'

describe('format du n° de sécurité sociale (multi-pays)', () => {
  it('accepte le format CNPS ivoirien strict', () => {
    expect(valid('CI12345678A')).toBe(true)
  })
  it('refuse un numéro CI mal formé (pas de repli sur le format étranger)', () => {
    expect(valid('CI-1234567')).toBe(false)
    expect(valid('CI1234567')).toBe(false)
  })
  it('accepte un numéro CNSS préfixé du code pays (Bénin, Burkina)', () => {
    expect(valid('BJ-7700100')).toBe(true)
    expect(valid('BF2200001')).toBe(true)
  })
  it('refuse un numéro sans code pays ou trop court', () => {
    expect(valid('7700100')).toBe(false)
    expect(valid('BJ-12')).toBe(false)
  })
})
