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

// Mock sourcing-config pour éviter les appels DB (timeout) en tests unitaires.
// Retourne directement les valeurs par défaut.
vi.mock('./sourcing-config.service.js', () => ({
  loadAiModels:     vi.fn().mockResolvedValue([]),
  loadSourcingSettings: vi.fn().mockResolvedValue({
    maxProfilesMin: 1, maxProfilesMax: 20, maxProfilesDefault: 8,
    maxCostEurPerRequest: 0,
    claudeSystemPrompt: '', mistralSystemPrompt: '',
    richnessWeights: {
      hasProfiles: 20, fiveProfiles: 10, perProfile: 2,
      hasBooleanSearch: 10, hasKeywords: 10, hasSalaryBenchmark: 10,
      hasBestPlatforms: 10, hasTips: 5,
      firstProfileLinkedin: 5, firstProfileApproach: 5, firstProfileSkills: 5,
    },
  }),
  defaultRichnessWeights: () => ({
    hasProfiles: 20, fiveProfiles: 10, perProfile: 2,
    hasBooleanSearch: 10, hasKeywords: 10, hasSalaryBenchmark: 10,
    hasBestPlatforms: 10, hasTips: 5,
    firstProfileLinkedin: 5, firstProfileApproach: 5, firstProfileSkills: 5,
  }),
  invalidateSourcingConfigCache: vi.fn(),
}))

import {
  analyzeCV, isModelAvailable,
  sourceProfiles, sourceProfilesCompare,
  computeSourcingRichness,
  __internals,
  type SourcingResult,
} from './recruitment-ai.service.js'

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

  it('parse les signaux utilisés et la note de biais démographique', async () => {
    const withAudit = JSON.stringify({
      ...JSON.parse(VALID_ANALYSIS),
      signalsUsed: ['5 ans RH', 'CNPS confirmé', 'Excel avancé', 'leadership équipe 12 pers'],
      demographicRiskNote: 'Score légèrement influencé par l\'école citée (HEC Côte d\'Ivoire) — à pondérer.',
    })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: withAudit }] })
    const result = await analyzeCV('claude', JOB, CV_SAMPLE)
    expect(result.signalsUsed).toHaveLength(4)
    expect(result.signalsUsed?.[0]).toContain('5 ans')
    expect(result.demographicRiskNote).toContain('HEC')
  })

  it('demographicRiskNote = null quand aucun biais détecté', async () => {
    const noRisk = JSON.stringify({
      ...JSON.parse(VALID_ANALYSIS),
      signalsUsed: ['CNPS', 'Excel'],
      demographicRiskNote: null,
    })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: noRisk }] })
    const result = await analyzeCV('claude', JOB, CV_SAMPLE)
    expect(result.demographicRiskNote).toBeNull()
  })

  it('rétro-compat : sans signalsUsed ni demographicRiskNote dans la réponse IA', async () => {
    // Anciennes fixtures / réponses partielles ne doivent pas casser le parsing
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID_ANALYSIS }] })
    const result = await analyzeCV('claude', JOB, CV_SAMPLE)
    expect(result.signalsUsed).toEqual([])
    expect(result.demographicRiskNote).toBeNull()
    expect(result.score).toBe(87)
  })

  it('hybride PDF : reste en mode texte si l\'extraction est satisfaisante (> 200 chars lisibles)', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID_ANALYSIS }] })
    const richText = 'Marie Konaté, 5 ans expérience RH Abidjan, licence GRH. '.repeat(8)
    const fakePdf = Buffer.from('%PDF-1.4 fake binary content', 'utf-8')
    const result = await analyzeCV('claude', JOB, richText, undefined, fakePdf)
    expect(result.ingestionMode).toBe('text')
    // Le 1er param du content n'est PAS un tableau (pas de document block)
    const callArgs = createMock.mock.calls[0]?.[0]
    expect(Array.isArray(callArgs?.messages?.[0]?.content)).toBe(false)
  })

  it('hybride PDF : bascule en mode document si l\'extraction texte est trop courte', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID_ANALYSIS }] })
    const fakePdf = Buffer.from('%PDF-1.4 fake binary content for document mode', 'utf-8')
    // Texte extrait insuffisant (< 200 chars) → fallback PDF document mode
    const result = await analyzeCV('claude', JOB, 'CV trop court à analyser en texte.', undefined, fakePdf)
    expect(result.ingestionMode).toBe('pdf-document')
    // Le content envoyé à Claude est un tableau [document, text]
    const callArgs = createMock.mock.calls[0]?.[0]
    const content = callArgs?.messages?.[0]?.content
    expect(Array.isArray(content)).toBe(true)
    expect(content?.[0]?.type).toBe('document')
    expect(content?.[0]?.source?.media_type).toBe('application/pdf')
  })

  it('hybride PDF : bascule en mode document si extraction garbage (ratio printable bas)', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID_ANALYSIS }] })
    const garbage = '\x00\x01\x02\x03'.repeat(80) + 'CV'  // 322 chars dont 320 non-printables
    const fakePdf = Buffer.from('%PDF-1.4', 'utf-8')
    const result = await analyzeCV('claude', JOB, garbage, undefined, fakePdf)
    expect(result.ingestionMode).toBe('pdf-document')
  })
})

describe('recruitment-ai.service — analyzeCV (Mistral)', () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// SOURCING IA
// ─────────────────────────────────────────────────────────────────────────────

const SOURCING_JOB = {
  title:        'Chef de projet IT',
  description:  'Pilotage de projets digitaux pour filiales africaines',
  requirements: '5 ans d\'expérience, anglais professionnel',
  contractType: 'cdi',
  location:     'Abidjan',
  salaryMin:    1_200_000,
  salaryMax:    1_800_000,
  currency:     'XOF',
}

const RICH_SOURCING_PAYLOAD: SourcingResult = {
  strategy: {
    summary:             'Cible des PM expérimentés en filiales panafricaines.',
    bestPlatforms: [
      { name: 'LinkedIn', rationale: 'Forte densité PM cadres', estimatedPool: 1200, url: 'https://linkedin.com' },
      { name: 'Africawork', rationale: 'Spécifique Afrique', estimatedPool: 250, url: 'https://africawork.com' },
    ],
    searchKeywords:      ['chef de projet', 'PMO', 'transformation digitale'],
    booleanSearch:       '("chef de projet" OR "project manager") AND digital AND Abidjan',
    estimatedTimeToFill: '4-6 semaines',
    salaryBenchmark:     { min: 1_200_000, max: 1_800_000, median: 1_500_000, currency: 'XOF' },
    tips:                ['Cibler la diaspora ivoirienne à Paris', 'Approche via WhatsApp Business'],
  },
  profiles: [
    {
      firstName:               'Yao',
      lastName:                'Kouadio',
      currentPosition:         'PM Senior',
      currentCompany:          'Orange CI',
      location:                'Abidjan, CI',
      experienceYears:         8,
      keySkills:               ['Scrum', 'Jira'],
      matchScore:              88,
      availabilityEstimate:    '1month',
      suggestedPlatform:       'LinkedIn',
      linkedinSearch:          'PM Orange CI',
      approachStrategy:        'Approche directe sur LinkedIn',
      estimatedSalary:         1_500_000,
      estimatedSalaryCurrency: 'XOF',
    },
  ],
}

describe('recruitment-ai.service — buildSourcingPrompt', () => {
  it('intègre le pays cible et la devise associée', () => {
    const prompt = __internals.buildSourcingPrompt(SOURCING_JOB, ['LinkedIn'], 5, ['CI'])
    expect(prompt).toContain('CI')
    expect(prompt).toContain('XOF')
    expect(prompt).toContain('Chef de projet IT')
    expect(prompt).toContain('LinkedIn')
  })

  it('détecte la devise par défaut quand l\'offre n\'a pas de currency', () => {
    const prompt = __internals.buildSourcingPrompt(
      { title: 'Lead Dev', currency: null },
      ['LinkedIn'], 3, ['NG'],
    )
    expect(prompt).toContain('NGN')
  })

  it('utilise un défaut générique si pas de pays', () => {
    const prompt = __internals.buildSourcingPrompt(
      { title: 'Lead Dev' }, ['LinkedIn'], 3, [],
    )
    expect(prompt).toContain('Afrique')
  })
})

describe('recruitment-ai.service — computeSourcingRichness', () => {
  it('retourne 0 pour null', () => {
    expect(computeSourcingRichness(null)).toBe(0)
  })

  it('attribue un score élevé à un résultat riche', () => {
    const score = computeSourcingRichness(RICH_SOURCING_PAYLOAD)
    expect(score).toBeGreaterThanOrEqual(70)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('attribue un score faible à un résultat pauvre', () => {
    const poor: SourcingResult = {
      strategy: {
        summary: '', bestPlatforms: [], searchKeywords: [],
        booleanSearch: '', estimatedTimeToFill: '',
        salaryBenchmark: { min: 0, max: 0, median: 0, currency: 'XOF' },
        tips: [],
      },
      profiles: [],
    }
    expect(computeSourcingRichness(poor)).toBeLessThan(20)
  })
})

describe('recruitment-ai.service — normalizeSourcing', () => {
  it('retourne null si la stratégie manque', () => {
    expect(__internals.normalizeSourcing({ profiles: [] })).toBeNull()
  })

  it('clamp les matchScore hors plage', () => {
    const norm = __internals.normalizeSourcing({
      strategy: { summary: 'x' },
      profiles: [{ firstName: 'A', lastName: 'B', matchScore: 250 }],
    })
    expect(norm!.profiles[0]!.matchScore).toBe(100)
  })

  it('mappe une availabilityEstimate inconnue vers "passive"', () => {
    const norm = __internals.normalizeSourcing({
      strategy: { summary: 'x' },
      profiles: [{ firstName: 'A', lastName: 'B', availabilityEstimate: 'maybe' }],
    })
    expect(norm!.profiles[0]!.availabilityEstimate).toBe('passive')
  })

  it('utilise la devise du pays cible en repli quand l\'IA omet estimatedSalaryCurrency (SRC-008)', () => {
    const norm = __internals.normalizeSourcing({
      strategy: { summary: 'x' },
      profiles: [{ firstName: 'A', lastName: 'B' }],
    }, 'NGN')
    expect(norm!.profiles[0]!.estimatedSalaryCurrency).toBe('NGN')
    expect(norm!.strategy.salaryBenchmark.currency).toBe('NGN')
  })

  it('repli XOF par défaut si aucune devise fournie', () => {
    const norm = __internals.normalizeSourcing({
      strategy: { summary: 'x' },
      profiles: [{ firstName: 'A', lastName: 'B' }],
    })
    expect(norm!.profiles[0]!.estimatedSalaryCurrency).toBe('XOF')
  })
})

describe('recruitment-ai.service — resolveDefaultCurrency', () => {
  it('mappe le pays cible vers sa devise (NG→NGN, CM→XAF, GH→GHS, CI→XOF)', () => {
    const base = { title: 'X' } as Parameters<typeof __internals.resolveDefaultCurrency>[0]
    expect(__internals.resolveDefaultCurrency(base, ['NG'])).toBe('NGN')
    expect(__internals.resolveDefaultCurrency(base, ['CM'])).toBe('XAF')
    expect(__internals.resolveDefaultCurrency(base, ['GH'])).toBe('GHS')
    expect(__internals.resolveDefaultCurrency(base, ['CI'])).toBe('XOF')
    expect(__internals.resolveDefaultCurrency(base, [])).toBe('XOF')
  })

  it('la devise du pays cible prime sur la devise de l\'offre (profils dans le pays cible)', () => {
    const ctx = { title: 'X', currency: 'EUR' } as Parameters<typeof __internals.resolveDefaultCurrency>[0]
    expect(__internals.resolveDefaultCurrency(ctx, ['NG'])).toBe('NGN')
  })

  it('repli sur la devise de l\'offre si le pays cible n\'a pas de devise connue', () => {
    const ctx = { title: 'X', currency: 'EUR' } as Parameters<typeof __internals.resolveDefaultCurrency>[0]
    expect(__internals.resolveDefaultCurrency(ctx, ['XX'])).toBe('EUR')
  })
})

describe('recruitment-ai.service — sourceProfiles', () => {
  beforeEach(() => { createMock.mockReset() })

  it('appelle Claude et retourne le résultat normalisé + métadonnées', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH_SOURCING_PAYLOAD) }],
      usage:   { input_tokens: 1000, output_tokens: 1500 },
    })
    const result = await sourceProfiles('claude', SOURCING_JOB, ['LinkedIn'], 5, ['CI'])
    expect(result.provider).toBe('claude')
    expect(result.jsonValid).toBe(true)
    expect(result.profilesGenerated).toBe(1)
    expect(result.richnessScore).toBeGreaterThan(0)
    expect(result.estimatedCostEur).toBeGreaterThan(0)
    expect(result.data?.profiles[0]?.firstName).toBe('Yao')
  })

  it('cappe à 20 profils maximum', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH_SOURCING_PAYLOAD) }],
      usage:   { input_tokens: 100, output_tokens: 100 },
    })
    await sourceProfiles('claude', SOURCING_JOB, ['LinkedIn'], 999, ['CI'])
    const sentPrompt = createMock.mock.calls[0]![0]!.messages[0].content as string
    expect(sentPrompt).toContain('20 profils')
  })

  it('retourne jsonValid=false si la réponse n\'est pas du JSON', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Je ne peux pas générer ces profils.' }],
      usage:   { input_tokens: 100, output_tokens: 50 },
    })
    const result = await sourceProfiles('claude', SOURCING_JOB, ['LinkedIn'], 5, ['CI'])
    expect(result.jsonValid).toBe(false)
    expect(result.data).toBeNull()
  })
})

describe('recruitment-ai.service — sourceProfilesCompare', () => {
  beforeEach(() => { createMock.mockReset() })

  it('lance Claude et Mistral en parallèle et retourne un gagnant', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH_SOURCING_PAYLOAD) }],
      usage:   { input_tokens: 1000, output_tokens: 1500 },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(RICH_SOURCING_PAYLOAD) } }],
        usage:   { prompt_tokens: 1000, completion_tokens: 1500 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    const result = await sourceProfilesCompare(SOURCING_JOB, ['LinkedIn'], 3, ['CI'])
    expect(['claude', 'mistral']).toContain(result.winner)
    expect(result.claude.jsonValid).toBe(true)
    expect(result.mistral.jsonValid).toBe(true)
    expect(result.recommendation).toBeTruthy()
    expect(result.ratios).not.toBeNull()
  })

  it('encaisse une erreur Mistral sans casser la comparaison', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH_SOURCING_PAYLOAD) }],
      usage:   { input_tokens: 100, output_tokens: 100 },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const result = await sourceProfilesCompare(SOURCING_JOB, ['LinkedIn'], 3, ['CI'])
    expect(result.claude.jsonValid).toBe(true)
    expect(result.mistral.jsonValid).toBe(false)
    expect(result.mistral.error).toBeTruthy()
    expect(result.winner).toBe('claude')
  })
})
