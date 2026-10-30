import { describe, it, expect } from 'vitest'
import { CI_MM_PHONE } from './StageTransitionModals'

describe('embauche — numéro Mobile Money CI', () => {
  it('accepte +2250[57] + 8 chiffres', () => {
    expect(CI_MM_PHONE.test('+2250712345678')).toBe(true)
    expect(CI_MM_PHONE.test('+2250512345678')).toBe(true)
  })
  it('refuse les autres formats', () => {
    expect(CI_MM_PHONE.test('+22512345')).toBe(false)
    expect(CI_MM_PHONE.test('+2250112345678')).toBe(false)
    expect(CI_MM_PHONE.test('0712345678')).toBe(false)
  })
})
