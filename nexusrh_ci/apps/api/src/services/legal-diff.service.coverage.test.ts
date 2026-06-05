/**
 * Couverture complémentaire de legal-diff.service.
 *
 * Cible les branches non couvertes par legal-diff.service.test.ts :
 *  - texte ACTUEL trop long (> 30k) — lignes 98-99
 *  - clé Anthropic absente — lignes 101-102
 *  - réponse Claude sans bloc texte — lignes 114-115
 *  - normalize : key_changes non-tableau + filtrage des non-strings + slice 20
 *  - buildPrompt sans contexte (branche ternaire context)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Config mutable : on peut basculer ai.apiKey à '' pour le test "clé absente".
const { mockConfig, createMock } = vi.hoisted(() => ({
  mockConfig: {
    env: 'test',
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4-test', maxTokens: 2048 },
    database: { url: 'postgresql://test' },
  },
  createMock: vi.fn(),
}))
vi.mock('../config.js', () => ({ config: mockConfig }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: createMock } })),
}))

import { analyzeLegalDiff, __internals } from './legal-diff.service.js'

describe('legal-diff.service — branches d\'erreur additionnelles', () => {
  beforeEach(() => {
    createMock.mockReset()
    mockConfig.ai.apiKey = 'sk-ant-test'
  })

  it('refuse un texte ACTUEL trop long (> 30k caractères)', async () => {
    await expect(
      analyzeLegalDiff('x'.repeat(40_000), 'nouveau texte légal valide'),
    ).rejects.toThrow(/texte actuel trop long/i)
  })

  it('refuse l\'analyse si la clé Anthropic n\'est pas configurée', async () => {
    mockConfig.ai.apiKey = ''
    await expect(
      analyzeLegalDiff(null, 'nouveau texte légal valide'),
    ).rejects.toThrow(/Cl.* Anthropic non configur/i)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('lève une erreur si la réponse Claude ne contient aucun bloc texte', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'tool_use', name: 'x', input: {} }] })
    await expect(
      analyzeLegalDiff(null, 'nouveau texte légal valide'),
    ).rejects.toThrow(/Claude vide/i)
  })

  it('lève une erreur si la réponse Claude a un contenu vide', async () => {
    createMock.mockResolvedValueOnce({ content: [] })
    await expect(
      analyzeLegalDiff(null, 'nouveau texte légal valide'),
    ).rejects.toThrow(/Claude vide/i)
  })
})

describe('legal-diff.service — normalize (exports internes)', () => {
  it('renvoie key_changes vide si la réponse n\'est pas un tableau', () => {
    const r = __internals.normalize(
      { has_changes: true, confidence: 50, key_changes: 'pas-un-tableau' },
      'model-x',
    )
    expect(r.key_changes).toEqual([])
    expect(r.model_used).toBe('model-x')
  })

  it('filtre les éléments non-string et tronque key_changes à 20 entrées', () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `chg-${i}`)
    // injecte des valeurs non-string qui doivent être filtrées
    const mixed: unknown[] = [...tooMany, 42, null, { a: 1 }]
    const r = __internals.normalize(
      { has_changes: false, confidence: 10, key_changes: mixed, summary: 'x', reasoning: 'y' },
      'model-x',
    )
    expect(r.key_changes).toHaveLength(20)
    expect(r.key_changes.every(c => typeof c === 'string')).toBe(true)
  })

  it('rejette une réponse non-objet', () => {
    expect(() => __internals.normalize(null, 'm')).toThrow(/invalide/i)
    expect(() => __internals.normalize('string', 'm')).toThrow(/invalide/i)
  })

  it('confidence non-numérique → 0 (fallback ||)', () => {
    const r = __internals.normalize(
      { has_changes: true, confidence: 'abc', summary: 's', reasoning: 'r' },
      'm',
    )
    expect(r.confidence).toBe(0)
  })

  it('défaut summary/reasoning vides si types non-string', () => {
    const r = __internals.normalize(
      { has_changes: true, confidence: 99, summary: 123, reasoning: false },
      'm',
    )
    expect(r.summary).toBe('')
    expect(r.reasoning).toBe('')
  })
})

describe('legal-diff.service — buildPrompt sans contexte', () => {
  it('n\'inclut pas de bloc CONTEXTE si context absent', () => {
    const p = __internals.buildPrompt('ancien', 'nouveau')
    expect(p).not.toContain('CONTEXTE :')
    expect(p).toContain('ancien')
    expect(p).toContain('nouveau')
  })
})
