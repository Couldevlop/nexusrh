import { describe, it, expect } from 'vitest'
import {
  BLOOM_LEVELS, BLOOM_KEYS, isValidBloom, clampBloom, compareRequirements,
  type RequirementItem,
} from './competencies.service.js'

describe('competencies.service — Bloom', () => {
  it('6 niveaux avec clés i18n', () => {
    expect(BLOOM_LEVELS).toEqual([1, 2, 3, 4, 5, 6])
    expect(BLOOM_KEYS[1]).toBe('remember')
    expect(BLOOM_KEYS[6]).toBe('create')
  })
  it('isValidBloom', () => {
    expect(isValidBloom(1)).toBe(true)
    expect(isValidBloom(6)).toBe(true)
    expect(isValidBloom(0)).toBe(false)
    expect(isValidBloom(7)).toBe(false)
    expect(isValidBloom(2.5)).toBe(false)
    expect(isValidBloom('3')).toBe(false)
  })
  it('clampBloom borne dans [1,6]', () => {
    expect(clampBloom(0)).toBe(1)
    expect(clampBloom(9)).toBe(6)
    expect(clampBloom(3.4)).toBe(3)
  })
})

describe('competencies.service — comparateur de postes', () => {
  const a: RequirementItem[] = [
    { competencyId: 'c1', label: 'Excel', requiredLevel: 3 },
    { competencyId: 'c2', label: 'Leadership', requiredLevel: 4 },
  ]
  const b: RequirementItem[] = [
    { competencyId: 'c2', label: 'Leadership', requiredLevel: 5 },
    { competencyId: 'c3', label: 'Anglais', requiredLevel: 2 },
  ]

  it('union des compétences, niveaux par fiche et écart', () => {
    const rows = compareRequirements(a, b)
    expect(rows.map((r) => r.label)).toEqual(['Anglais', 'Excel', 'Leadership']) // trié
    const excel = rows.find((r) => r.competencyId === 'c1')!
    expect(excel.levelA).toBe(3)
    expect(excel.levelB).toBeNull()
    expect(excel.diff).toBeNull() // requis seulement par A
    const lead = rows.find((r) => r.competencyId === 'c2')!
    expect(lead.levelA).toBe(4)
    expect(lead.levelB).toBe(5)
    expect(lead.diff).toBe(1) // B exige 1 niveau de plus
    const eng = rows.find((r) => r.competencyId === 'c3')!
    expect(eng.levelA).toBeNull()
    expect(eng.levelB).toBe(2)
  })

  it('listes vides → aucun écart', () => {
    expect(compareRequirements([], [])).toEqual([])
  })
})
