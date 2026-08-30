/**
 * Questions éliminatoires — moteur pur.
 *
 * Le filtre porte sur des données DÉCLARÉES par le candidat au dépôt, pas
 * inférées d'un CV par un modèle : plus fiable, sans coût IA, et défendable
 * face au candidat comme au régulateur.
 *
 * Prudence identique au moteur de règles sur CV : une réponse manquante ne
 * provoque JAMAIS d'exclusion — elle bascule le dossier en revue humaine.
 */
import { describe, it, expect } from 'vitest'
import {
  sanitizeQuestions, evaluateQuestions, combineVerdicts,
  type ScreeningQuestion, type ScreeningVerdict,
} from './recruitment-screening.service.js'

const q = (over: Partial<ScreeningQuestion> = {}): ScreeningQuestion => ({
  id: 'q1', label: 'Question', type: 'boolean', required: true, knockout: true,
  rule: { op: 'is', value: true }, ...over,
})

describe('evaluateQuestions — types et opérateurs', () => {
  it('booléen : réponse conforme → aucune règle échouée', () => {
    expect(evaluateQuestions([q({ label: 'Permis B ?' })], { q1: true }).failedRules).toEqual([])
  })

  it('booléen : réponse non conforme → règle échouée, libellé lisible', () => {
    const r = evaluateQuestions([q({ label: 'Permis B ?' })], { q1: false })
    expect(r.failedRules).toHaveLength(1)
    expect(r.failedRules[0]).toContain('Permis B ?')
  })

  it('numérique min : sous le seuil → échoue ; au seuil → passe', () => {
    const question = q({ type: 'number', label: 'Années d’expérience', rule: { op: 'min', value: 5 } })
    expect(evaluateQuestions([question], { q1: 3 }).failedRules).toHaveLength(1)
    expect(evaluateQuestions([question], { q1: 5 }).failedRules).toEqual([])
    expect(evaluateQuestions([question], { q1: 8 }).failedRules).toEqual([])
  })

  it('numérique max : au-dessus du plafond → échoue', () => {
    const question = q({ type: 'number', label: 'Prétention', rule: { op: 'max', value: 500_000 } })
    expect(evaluateQuestions([question], { q1: 800_000 }).failedRules).toHaveLength(1)
    expect(evaluateQuestions([question], { q1: 500_000 }).failedRules).toEqual([])
  })

  it('choix : hors liste → échoue ; dans la liste → passe', () => {
    const question = q({
      type: 'choice', label: 'Ville de résidence', options: ['Abidjan', 'Bouaké', 'Yamoussoukro'],
      rule: { op: 'in', value: ['Abidjan'] },
    })
    expect(evaluateQuestions([question], { q1: 'Bouaké' }).failedRules).toHaveLength(1)
    expect(evaluateQuestions([question], { q1: 'Abidjan' }).failedRules).toEqual([])
  })

  it('cumule les motifs de plusieurs questions', () => {
    const r = evaluateQuestions(
      [
        q({ id: 'a', label: 'Permis B ?' }),
        q({ id: 'b', label: 'Expérience', type: 'number', rule: { op: 'min', value: 5 } }),
      ],
      { a: false, b: 2 },
    )
    expect(r.failedRules).toHaveLength(2)
  })
})

describe('evaluateQuestions — prudence (jamais d’exclusion sur une donnée absente)', () => {
  it('réponse manquante, nulle ou vide → jamais d’exclusion', () => {
    expect(evaluateQuestions([q()], {}).failedRules).toEqual([])
    expect(evaluateQuestions([q()], { q1: null }).failedRules).toEqual([])
    expect(evaluateQuestions([q()], { q1: '' }).failedRules).toEqual([])
  })

  it('question informative (knockout: false) → jamais d’exclusion', () => {
    expect(evaluateQuestions([q({ knockout: false })], { q1: false }).failedRules).toEqual([])
  })

  it('type et règle incohérents → ignorés plutôt qu’appliqués au hasard', () => {
    const bancal = q({ type: 'boolean', rule: { op: 'min', value: 5 } })
    expect(evaluateQuestions([bancal], { q1: false }).failedRules).toEqual([])
  })

  it('réponse d’un type inattendu → ignorée, pas d’exclusion', () => {
    const question = q({ type: 'number', rule: { op: 'min', value: 5 } })
    expect(evaluateQuestions([question], { q1: 'trois' }).failedRules).toEqual([])
  })

  it('aucune question → aucune règle échouée', () => {
    expect(evaluateQuestions([], { q1: false }).failedRules).toEqual([])
  })
})

describe('sanitizeQuestions', () => {
  it('rejette ce qui n’est pas un tableau', () => {
    expect(sanitizeQuestions(null)).toEqual([])
    expect(sanitizeQuestions(undefined)).toEqual([])
    expect(sanitizeQuestions({ a: 1 })).toEqual([])
    expect(sanitizeQuestions('[]')).toEqual([])
  })

  it('borne à 15 questions et tronque les libellés à 300 caractères', () => {
    const many = Array.from({ length: 30 }, (_, i) => q({ id: `q${i}`, label: 'x'.repeat(500) }))
    const out = sanitizeQuestions(many)
    expect(out).toHaveLength(15)
    expect(out[0]!.label).toHaveLength(300)
  })

  it('knockout sans règle applicable → dégradé en question informative', () => {
    const out = sanitizeQuestions([
      { id: 'q1', label: 'Permis B ?', type: 'boolean', required: true, knockout: true },
    ])
    expect(out[0]!.knockout).toBe(false)
    expect(out[0]!.rule).toBeUndefined()
  })

  it('écarte les entrées sans identifiant, sans libellé ou de type inconnu', () => {
    expect(sanitizeQuestions([
      { id: '', label: 'L', type: 'boolean', required: true, knockout: false },
      { id: 'q2', label: '  ', type: 'boolean', required: true, knockout: false },
      { id: 'q3', label: 'L', type: 'date', required: true, knockout: false },
      'pas un objet',
      null,
    ])).toEqual([])
  })

  it('borne les options d’un choix à 20 et ne les garde que pour ce type', () => {
    const out = sanitizeQuestions([
      { id: 'q1', label: 'Ville', type: 'choice', required: true, knockout: false,
        options: Array.from({ length: 40 }, (_, i) => `v${i}`) },
      { id: 'q2', label: 'Permis', type: 'boolean', required: true, knockout: false,
        options: ['a', 'b'] },
    ])
    expect(out[0]!.options).toHaveLength(20)
    expect(out[1]!.options).toBeUndefined()
  })
})

describe('combineVerdicts', () => {
  const cvOk: ScreeningVerdict = {
    decision: 'review', knockoutFailed: false, belowScoreThreshold: false,
    failedRules: [], passedRules: [], autoRejectReason: null,
  }

  it('questions OK + CV OK → pass', () => {
    expect(combineVerdicts({ failedRules: [] }, cvOk).verdict).toBe('pass')
  })

  it('CV non analysé → seules les questions comptent', () => {
    expect(combineVerdicts({ failedRules: [] }, null).verdict).toBe('pass')
    expect(combineVerdicts({ failedRules: ['Permis B exigé'] }, null).verdict).toBe('flagged')
  })

  it('l’un des deux échoue → flagged, motifs concaténés dans l’ordre', () => {
    const cvKo: ScreeningVerdict = {
      ...cvOk, decision: 'auto_reject', knockoutFailed: true, failedRules: ['5 ans exigés'],
    }
    const r = combineVerdicts({ failedRules: ['Permis B exigé'] }, cvKo)
    expect(r.verdict).toBe('flagged')
    expect(r.failedRules).toEqual(['Permis B exigé', '5 ans exigés'])
  })

  it('un CV en `review` ne signale pas à lui seul', () => {
    expect(combineVerdicts({ failedRules: [] }, { ...cvOk, decision: 'review' }).verdict).toBe('pass')
  })
})
