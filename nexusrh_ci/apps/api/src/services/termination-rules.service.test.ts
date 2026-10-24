import { describe, it, expect } from 'vitest'
import {
  effectiveTerminationRules, parseTerminationRules, terminationRulesSchema,
} from './termination-rules.service.js'
import { CIV_2024, LEGISLATION_PACKS } from './legislation-packs.js'

const CONVENTION = {
  noticeMonths: [{ upToSeniorityMonths: 24, months: 2 }, { upToSeniorityMonths: null, months: 3 }],
  severanceRates: [{ upToYear: null, rate: 0.5 }],
}

describe('terminationRulesSchema', () => {
  it('accepte des paliers croissants terminés par un palier sans borne', () => {
    expect(terminationRulesSchema.safeParse(CONVENTION).success).toBe(true)
    expect(terminationRulesSchema.safeParse(CIV_2024.terminationRules).success).toBe(true)
  })
  it('refuse un dernier palier borné (ancienneté non couverte)', () => {
    expect(terminationRulesSchema.safeParse({
      ...CONVENTION, noticeMonths: [{ upToSeniorityMonths: 24, months: 2 }],
    }).success).toBe(false)
  })
  it('refuse des bornes non croissantes ou un palier sans borne au milieu', () => {
    expect(terminationRulesSchema.safeParse({
      ...CONVENTION, severanceRates: [{ upToYear: 10, rate: 0.3 }, { upToYear: 5, rate: 0.3 }, { upToYear: null, rate: 0.4 }],
    }).success).toBe(false)
    expect(terminationRulesSchema.safeParse({
      ...CONVENTION, severanceRates: [{ upToYear: null, rate: 0.3 }, { upToYear: null, rate: 0.4 }],
    }).success).toBe(false)
  })
  it('borne les valeurs (préavis ≤ 24 mois, taux ≤ 200 %)', () => {
    expect(terminationRulesSchema.safeParse({
      ...CONVENTION, noticeMonths: [{ upToSeniorityMonths: null, months: 36 }],
    }).success).toBe(false)
    expect(terminationRulesSchema.safeParse({
      ...CONVENTION, severanceRates: [{ upToYear: null, rate: 3 }],
    }).success).toBe(false)
  })
})

describe('effectiveTerminationRules — priorité tenant > pack > aucune', () => {
  it('convention du tenant valide → prioritaire', () => {
    expect(effectiveTerminationRules(CONVENTION, CIV_2024)).toEqual({ rules: CONVENTION, source: 'tenant' })
  })
  it('sans convention → règles du pack', () => {
    expect(effectiveTerminationRules(null, CIV_2024)).toEqual({ rules: CIV_2024.terminationRules, source: 'pack' })
  })
  it('convention corrompue en base → ignorée, repli sur le pack', () => {
    expect(parseTerminationRules({ noticeMonths: 'x' })).toBeNull()
    expect(effectiveTerminationRules({ noticeMonths: 'x' }, CIV_2024).source).toBe('pack')
  })
  it('pack sans règles validées → aucune règle (jamais celles de la CI)', () => {
    const tgo = LEGISLATION_PACKS['TGO-2024']!
    expect(tgo.terminationRules).toBeUndefined()
    expect(effectiveTerminationRules(null, tgo)).toEqual({ rules: null, source: 'none' })
  })
})
