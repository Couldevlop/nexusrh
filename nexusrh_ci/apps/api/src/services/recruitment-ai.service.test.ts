import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    env: 'test',
    ai:      { apiKey: 'sk-ant-test', model: 'claude-sonnet-4-test', maxTokens: 2048, temperature: 0.3 },
    mistral: { apiKey: 'mistral-test', model: 'mistral-large-latest', apiUrl: 'https://api.mistral.ai/v1' },
    database: { url: 'postgresql://test' },
  },
}))

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}))

import { analyzeCV, isModelAvailable } from './recruitment-ai.service.js'

const JOB = {
  title:        'Chargé(e) RH',
  description:  'Gestion administration du personnel et paie',
  requirements: '3 ans d\'expérience, licence RH ou gestion',
  contractType: 'cdi',
  location:     'Abidjan',
  salaryMin:    400_000,
  salaryMax:    600_000,
}

const CV_SAMPLE = `Marie Konaté — 5 ans RH à Abidjan, licence GRH.
Expérience CNPS, ITS, gestion conflits, paie 80 salariés.
Maîtrise Excel, anglais professionnel, leadership.`

const VALID_ANALYSIS = JSON.stringify({
  score: 87,
  recommendation: 'strong_yes',
  summary: 'Profil senior aligné avec les prérequis du poste.',
  strengths: ['Expérience CNPS', 'Gestion équipe', 'Excel'],
  gaps: ['Pas d\'expérience en sourcing IA'],
  redFlags: [],
  interviewQuestions: ['Décrivez une clôture de paie complexe.', 'Comment gérez-vous un litige CNPS ?', 'Votre approche du SIRH ?'],
  matchPercentage: 92,
})

describe('recruitment-ai.service — isModelAvailable', () => {
  it('retourne true pour les modèles avec clé configurée', () => {
    expect(isModelAvailable('claude')).toBe(true)
    expect(isModelAvailable('mistral')).toBe(true)
  })
})

describe('recruitment-ai.service — analyzeCV (Claude)', () => {
  beforeEach(() => { createMock.mockReset() })

  it('refuse un CV trop court', async () => {
    await expect(analyzeCV('claude', JOB, 'court')).rejects.toThrow(/CV trop court/i)
  })

  it('parse correctement une réponse Claude valide', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: VALID_ANALYSIS }],
    })
    const result = await analyzeCV('claude', JOB, CV_SAMPLE)
    expect(result.score).toBe(87)
    expect(result.recommendation).toBe('strong_yes')
    expect(result.matchPercentage).toBe(92)
    expect(result.strengths).toHaveLength(3)
    expect(result.modelUsed).toBe('claude')
  })

  it('nettoie les balises markdown autour du JSON', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n' + VALID_ANALYSIS + '\n```' }],
    })
    const result = await analyzeCV('claude', JOB, CV_SAMPLE)
    expect(result.score).toBe(87)
  })

  it('normalise une recommendation inconnue vers "maybe"', async () => {
    const weird = JSON.stringify({ ...JSON.parse(VALID_ANALYSIS), recommendation: 'absolument' })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: weird }] })
    const result = await analyzeCV('claude', JOB, CV_SAMPLE)
    expect(result.recommendation).toBe('maybe')
  })

  it('clamp les scores hors plage [0,100]', async () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID_ANALYSIS), score: 250, matchPercentage: -10 })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: bad }] })
    const result = await analyzeCV('claude', JOB, CV_SAMPLE)
    expect(result.score).toBe(100)
    expect(result.matchPercentage).toBe(0)
  })

  it('échoue si la réponse Claude ne contient pas de JSON', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Je ne peux pas analyser ce CV.' }],
    })
    await expect(analyzeCV('claude', JOB, CV_SAMPLE)).rejects.toThrow()
  })
})

describe('recruitment-ai.service — analyzeCV (Mistral)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('parse correctement une réponse Mistral valide', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ choices: [{ message: { content: VALID_ANALYSIS } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const result = await analyzeCV('mistral', JOB, CV_SAMPLE)
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.mistral.ai/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.modelUsed).toBe('mistral')
    expect(result.score).toBe(87)
  })

  it('remonte une erreur si Mistral renvoie 4xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
    await expect(analyzeCV('mistral', JOB, CV_SAMPLE)).rejects.toThrow(/Erreur Mistral 401/)
  })
})
