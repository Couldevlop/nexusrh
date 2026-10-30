import { describe, it, expect } from 'vitest'
import {
  SURVEY_STATUSES,
  canTransition,
  validateQuestions,
  aggregateResults,
  aggregateByGroup,
  suppressSmallGroups,
  resolveMinResponses,
  DEFAULT_MIN_RESPONSES,
  type SurveyQuestion,
} from './climate.service.js'

describe('climate.service — statuts & transitions', () => {
  it('cycle draft → open → closed', () => {
    expect(canTransition('draft', 'open')).toBe(true)
    expect(canTransition('open', 'closed')).toBe(true)
    expect(canTransition('draft', 'closed')).toBe(false)
    expect(canTransition('closed', 'open')).toBe(false)
    expect(SURVEY_STATUSES).toContain('open')
  })
})

describe('climate.service — validation des questions', () => {
  it('génère des clés et refuse une liste vide', () => {
    expect(() => validateQuestions([])).toThrow()
    const qs = validateQuestions([{ label: 'Satisfaction ?', type: 'scale' }])
    expect(qs[0]?.key).toBe('q1')
    expect(qs[0]?.type).toBe('scale')
  })
  it('refuse les clés dupliquées et les libellés manquants', () => {
    expect(() => validateQuestions([{ key: 'a', label: 'X', type: 'scale' }, { key: 'a', label: 'Y', type: 'text' }])).toThrow(/dupliqu/)
    expect(() => validateQuestions([{ key: 'a', label: '', type: 'scale' }])).toThrow(/Libellé/)
  })
})

describe('climate.service — agrégation (anonymat : aucune donnée nominative)', () => {
  const questions: SurveyQuestion[] = [
    { key: 'sat', label: 'Satisfaction', type: 'scale' },
    { key: 'reco', label: 'Recommanderiez-vous ?', type: 'boolean' },
    { key: 'libre', label: 'Commentaire', type: 'text' },
  ]
  const responses = [
    { sat: 5, reco: true, libre: 'Super' },
    { sat: 3, reco: false, libre: '' },
    { sat: 4, reco: true, libre: 'Bien' },
  ]

  it('scale : moyenne, compte et distribution', () => {
    const r = aggregateResults(questions, responses)
    const sat = r.questions.find((q) => q.key === 'sat')
    expect(sat?.type).toBe('scale')
    if (sat?.type === 'scale') {
      expect(sat.count).toBe(3)
      expect(sat.average).toBe(4) // (5+3+4)/3 = 4
      expect(sat.distribution['5']).toBe(1)
      expect(sat.distribution['3']).toBe(1)
    }
    expect(r.responseCount).toBe(3)
  })

  it('boolean : taux de oui', () => {
    const r = aggregateResults(questions, responses)
    const reco = r.questions.find((q) => q.key === 'reco')
    if (reco?.type === 'boolean') {
      expect(reco.yes).toBe(2)
      expect(reco.yesRate).toBeCloseTo(0.67, 1)
    }
  })

  it('text : ne compte que les réponses non vides', () => {
    const r = aggregateResults(questions, responses)
    const libre = r.questions.find((q) => q.key === 'libre')
    if (libre?.type === 'text') {
      expect(libre.count).toBe(2)
      expect(libre.answers).toContain('Super')
    }
  })

  it('aucune clé inattendue (employee_id) dans les agrégats', () => {
    const r = aggregateResults(questions, [{ sat: 4, employee_id: 'secret' } as Record<string, unknown>])
    const json = JSON.stringify(r)
    expect(json).not.toContain('secret')
    expect(json).not.toContain('employee_id')
  })
})

describe("climate.service — seuil d'anonymat", () => {
  it('resolveMinResponses : défaut 5, bornes 2..100, valeurs invalides → défaut', () => {
    expect(DEFAULT_MIN_RESPONSES).toBe(5)
    expect(resolveMinResponses(null)).toBe(5)
    expect(resolveMinResponses(undefined)).toBe(5)
    expect(resolveMinResponses('abc')).toBe(5)
    expect(resolveMinResponses(3.5)).toBe(5)
    expect(resolveMinResponses(8)).toBe(8)
    expect(resolveMinResponses('7')).toBe(7)
    expect(resolveMinResponses(1)).toBe(2)
    expect(resolveMinResponses(1000)).toBe(100)
  })

  it('suppressSmallGroups : masque les petits groupes + suppression secondaire', () => {
    const g = (k: string, n: number) => ({ key: k, responseCount: n })
    // aucun groupe sous le seuil → rien de masqué
    expect(suppressSmallGroups([g('a', 6), g('b', 5)], 5)).toEqual({ visible: [g('a', 6), g('b', 5)], hiddenGroups: 0 })
    // c (1) masqué ; total masqué 1 < 5 → b (le plus petit visible) masqué aussi
    const r = suppressSmallGroups([g('a', 9), g('b', 6), g('c', 1)], 5)
    expect(r.visible.map((x) => x.key)).toEqual(['a'])
    expect(r.hiddenGroups).toBe(2)
    // masqués cumulant déjà ≥ seuil → pas de suppression secondaire
    const r2 = suppressSmallGroups([g('a', 9), g('b', 3), g('c', 3)], 5)
    expect(r2.visible.map((x) => x.key)).toEqual(['a'])
    expect(r2.hiddenGroups).toBe(2)
  })

  it('aggregateByGroup : jamais de texte libre par sous-groupe', () => {
    const qs: SurveyQuestion[] = [
      { key: 'sat', label: 'Sat', type: 'scale' },
      { key: 'ok', label: 'Ok', type: 'boolean' },
      { key: 'txt', label: 'Txt', type: 'text' },
    ]
    const rows = Array.from({ length: 10 }, (_, i) => ({
      groupKey: i < 5 ? 'd1' : 'd2', groupLabel: i < 5 ? 'A' : 'B', answers: { sat: 4, ok: true, txt: 'secret' },
    }))
    const out = aggregateByGroup(qs, rows, 5)
    expect(out.groups).toHaveLength(2)
    expect(JSON.stringify(out)).not.toContain('secret')
    for (const grp of out.groups) expect(grp.questions.map((q) => q.key)).toEqual(['sat', 'ok'])
  })
})
