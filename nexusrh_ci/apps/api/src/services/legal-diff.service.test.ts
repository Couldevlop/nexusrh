import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    env: 'test',
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4-test', maxTokens: 2048 },
    database: { url: 'postgresql://test' },
  },
}))

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: createMock } })),
}))

import { analyzeLegalDiff, __internals } from './legal-diff.service.js'

const VALID_RESPONSE = JSON.stringify({
  has_changes: true,
  confidence: 88,
  summary: 'Le taux CNPS retraite passe de 6,3% à 6,5%.',
  reasoning: 'Modification du taux salarial CNPS suite à la loi 2025-X.',
  key_changes: ['Taux retraite salarial 6.3 → 6.5%', 'Date effet 2026-01-01'],
  risk_level: 'high',
})

describe('legal-diff.service — analyzeLegalDiff', () => {
  beforeEach(() => { createMock.mockReset() })

  it('refuse texte vide', async () => {
    await expect(analyzeLegalDiff(null, '')).rejects.toThrow(/trop court/i)
  })

  it('refuse texte > 30k chars', async () => {
    await expect(analyzeLegalDiff(null, 'x'.repeat(40_000))).rejects.toThrow(/trop long/i)
  })

  it('parse correctement une réponse Claude valide', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID_RESPONSE }] })
    const r = await analyzeLegalDiff('Ancien texte sur cotisation CNPS', 'Nouveau texte avec taux 6.5%')
    expect(r.has_changes).toBe(true)
    expect(r.confidence).toBe(88)
    expect(r.risk_level).toBe('high')
    expect(r.key_changes).toHaveLength(2)
    expect(r.model_used).toBe('claude-sonnet-4-test')
  })

  it('clamp confidence hors plage [0,100]', async () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID_RESPONSE), confidence: 250 })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: bad }] })
    const r = await analyzeLegalDiff('a', 'b'.repeat(11))
    expect(r.confidence).toBe(100)
  })

  it('normalise risk_level inconnu vers "medium"', async () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID_RESPONSE), risk_level: 'critique' })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: bad }] })
    const r = await analyzeLegalDiff('a', 'b'.repeat(11))
    expect(r.risk_level).toBe('medium')
  })

  it('extractJson nettoie les balises markdown', () => {
    const wrapped = '```json\n' + VALID_RESPONSE + '\n```'
    const parsed = __internals.extractJson(wrapped) as { confidence: number }
    expect(parsed.confidence).toBe(88)
  })

  it('extractJson échoue si pas de JSON', () => {
    expect(() => __internals.extractJson('Je ne peux analyser')).toThrow(/sans JSON/i)
  })

  it('buildPrompt mentionne le contexte si fourni', () => {
    const p = __internals.buildPrompt('ancien', 'nouveau', 'Article 36 CNPS')
    expect(p).toContain('Article 36 CNPS')
    expect(p).toContain('ancien')
    expect(p).toContain('nouveau')
  })

  it('buildPrompt indique "création" si aucun texte actuel', () => {
    const p = __internals.buildPrompt(null, 'nouveau')
    expect(p).toMatch(/aucun|cr.ation/i)
  })
})
