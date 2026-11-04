import { describe, it, expect } from 'vitest'
import { isCivPayrollScope } from './civ-scope'

const ENTITIES = [
  { id: 'a', country_code: 'TGO', legislation_pack_code: 'CIV-2024' },
  { id: 'b', country_code: 'SEN', legislation_pack_code: null },
  { id: 'c', country_code: null, legislation_pack_code: '' },
  { id: 'd', country_code: 'CIV', legislation_pack_code: 'TGO-2024' },
]

// Même règle que cnps.routes (isCivEntity) : pack explicite CIV-*, sinon pays
// de la filiale (défaut CIV), sinon pays du tenant (défaut CIV).
describe('isCivPayrollScope', () => {
  it('pack explicite de la filiale prioritaire', () => {
    expect(isCivPayrollScope('a', ENTITIES, 'SEN')).toBe(true)
    expect(isCivPayrollScope('d', ENTITIES, 'CIV')).toBe(false)
  })
  it('sans pack : pays de la filiale, CIV par défaut', () => {
    expect(isCivPayrollScope('b', ENTITIES, 'CIV')).toBe(false)
    expect(isCivPayrollScope('c', ENTITIES, 'SEN')).toBe(true)
  })
  it('sans filiale (ou filiale inconnue) : pays du tenant, CIV par défaut', () => {
    expect(isCivPayrollScope(null, ENTITIES, 'SEN')).toBe(false)
    expect(isCivPayrollScope(null, ENTITIES, undefined)).toBe(true)
    expect(isCivPayrollScope('zz', [], 'civ')).toBe(true)
  })
})
