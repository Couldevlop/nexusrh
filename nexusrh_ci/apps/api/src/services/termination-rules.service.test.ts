import { describe, it, expect } from 'vitest'
import {
  categoryLevel, effectiveTerminationRules, parseTerminationRules, resolveNotice, severanceAmount,
  terminationRulesSchema,
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

describe('categoryLevel — libellé saisi au dossier', () => {
  it('déduit le niveau de la grille CCI', () => {
    expect(categoryLevel('1ère catégorie')).toBe(1)
    expect(categoryLevel('5ème catégorie')).toBe(5)
    expect(categoryLevel('Catégorie 6')).toBe(6)
    expect(categoryLevel('Agent de maîtrise (AM2)')).toBe(7)
    expect(categoryLevel('Cadre (C1)')).toBe(8)
    expect(categoryLevel('Ingénieur')).toBe(8)
    expect(categoryLevel('Hors catégorie')).toBe(8)
    expect(categoryLevel('4')).toBe(4)
  })
  it('null quand non déterminable', () => {
    expect(categoryLevel(null)).toBeNull()
    expect(categoryLevel('')).toBeNull()
    expect(categoryLevel('Chauffeur')).toBeNull()
  })
})

describe('règles par catégorie', () => {
  it('le schéma accepte les lignes par catégorie et les paliers en jours', () => {
    expect(terminationRulesSchema.safeParse({
      ...CONVENTION,
      noticeByCategory: [{
        key: 'cadres', label: 'Cadres', minCategoryLevel: 6,
        tiers: [{ upToSeniorityMonths: 6, months: 0, days: 15 }, { upToSeniorityMonths: null, months: 3 }],
      }],
      severanceMinSeniorityMonths: 12,
    }).success).toBe(true)
  })
  it('le schéma refuse une clé de catégorie invalide', () => {
    expect(terminationRulesSchema.safeParse({
      ...CONVENTION,
      noticeByCategory: [{ key: 'Cadres !', label: 'Cadres', tiers: [{ upToSeniorityMonths: null, months: 3 }] }],
    }).success).toBe(false)
  })
  it('resolveNotice : catégorie inconnue signalée seulement si des lignes par catégorie existent', () => {
    const e = { seniorityMonths: 24, categoryLevel: null, payBasis: 'monthly' as const }
    expect(resolveNotice(CIV_2024.terminationRules!, e)?.categoryUnknown).toBe(true)
    expect(resolveNotice(CONVENTION, e)?.categoryUnknown).toBe(false)
    expect(resolveNotice(null, e)).toBeNull()
  })
  it('severanceAmount : progressif par tranche, fraction d\'année incluse', () => {
    expect(severanceAmount(0, 100_000, CONVENTION)).toBe(0)
    expect(severanceAmount(18, 100_000, CONVENTION)).toBe(75_000)
  })
})
