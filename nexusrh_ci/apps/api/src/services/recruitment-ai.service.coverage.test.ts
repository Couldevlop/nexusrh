/**
 * recruitment-ai.service — complément de couverture exhaustif.
 *
 * Reproduit les patterns de mock de recruitment-ai.service.test.ts (config,
 * @anthropic-ai/sdk, sourcing-config). Cible les branches non couvertes :
 *   - buildUserPrompt avec décisions passées (few-shot + sanitize anti-injection)
 *   - normalize : extracted highestDiploma/location "null" → null
 *   - analyzeWithClaude/Mistral : clé absente, réponse vide
 *   - isModelAvailable modèle inconnu + creds tenant
 *   - analyzeCV : repli de modèle, aucun modèle configuré
 *   - costEur : tarif depuis modèle DB + repli historique
 *   - budget max dépassé (console.warn)
 *   - sourceProfiles : repli + aucun modèle
 *   - buildSourcingRecommendation : toutes les branches
 *   - sourceProfilesCompare : clé Claude/Mistral manquante
 *
 * Aucun appel réseau réel : SDK Anthropic mocké + fetch espionné.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Config mutable : on bascule les clés à null pour tester les replis.
const { mutableConfig, createMock, loadAiModelsMock, loadSourcingSettingsMock } = vi.hoisted(() => ({
  mutableConfig: {
    env: 'test',
    ai:      { apiKey: 'sk-ant-test' as string | undefined, model: 'claude-sonnet-4-test', maxTokens: 2048, temperature: 0.3 },
    mistral: { apiKey: 'mistral-test' as string | undefined, model: 'mistral-large-latest', apiUrl: 'https://api.mistral.ai/v1' },
    database: { url: 'postgresql://test' },
  },
  createMock: vi.fn(),
  loadAiModelsMock: vi.fn(),
  loadSourcingSettingsMock: vi.fn(),
}))
vi.mock('../config.js', () => ({ config: mutableConfig }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}))

// loadAiModels / loadSourcingSettings contrôlables par test.
const DEFAULT_WEIGHTS = {
  hasProfiles: 20, fiveProfiles: 10, perProfile: 2,
  hasBooleanSearch: 10, hasKeywords: 10, hasSalaryBenchmark: 10,
  hasBestPlatforms: 10, hasTips: 5,
  firstProfileLinkedin: 5, firstProfileApproach: 5, firstProfileSkills: 5,
}
vi.mock('./sourcing-config.service.js', () => ({
  loadAiModels:         (...a: unknown[]) => loadAiModelsMock(...a),
  loadSourcingSettings: (...a: unknown[]) => loadSourcingSettingsMock(...a),
  defaultRichnessWeights: () => ({ ...DEFAULT_WEIGHTS }),
  invalidateSourcingConfigCache: vi.fn(),
}))

import {
  analyzeCV, isModelAvailable,
  sourceProfiles, sourceProfilesCompare,
  __internals,
  type SourcingProviderResult,
  type SourcingResult,
} from './recruitment-ai.service.js'
import type { AiCreds } from './ai-credentials.service.js'

const JOB = {
  title: 'Chargé(e) RH', description: 'Admin RH', requirements: '3 ans',
  contractType: 'cdi', location: 'Abidjan', salaryMin: 400_000, salaryMax: 600_000,
}
const LONG_CV = 'Marie Konaté, 5 ans expérience RH Abidjan, licence GRH. '.repeat(8)

const VALID = JSON.stringify({
  score: 80, recommendation: 'yes', summary: 'ok',
  strengths: ['a'], gaps: [], redFlags: [], interviewQuestions: ['q'],
  matchPercentage: 80,
})

const RICH: SourcingResult = {
  strategy: {
    summary: 'sum',
    bestPlatforms: [
      { name: 'LinkedIn', rationale: 'r', estimatedPool: 1000, url: 'https://l' },
      { name: 'Africawork', rationale: 'r2', estimatedPool: 200, url: 'https://a' },
    ],
    searchKeywords: ['a', 'b', 'c'],
    booleanSearch: '("x" OR "y")',
    estimatedTimeToFill: '4 semaines',
    salaryBenchmark: { min: 1, max: 2, median: 1_500_000, currency: 'XOF' },
    tips: ['t1', 't2'],
  },
  profiles: [{
    firstName: 'Yao', lastName: 'K', currentPosition: 'PM', currentCompany: 'Orange',
    location: 'Abidjan', experienceYears: 8, keySkills: ['Scrum'], matchScore: 88,
    availabilityEstimate: '1month', suggestedPlatform: 'LinkedIn',
    linkedinSearch: 's', approachStrategy: 'a', estimatedSalary: 1_500_000,
    estimatedSalaryCurrency: 'XOF',
  }],
}

const SRC_JOB = { title: 'PM', currency: 'XOF' as string | null }

function tenantCreds(claudeKey: string | null, mistralKey: string | null): AiCreds {
  return {
    claude:  { apiKey: claudeKey,  model: 'claude-tenant', source: claudeKey ? 'tenant' : null },
    mistral: { apiKey: mistralKey, model: 'mistral-tenant', source: mistralKey ? 'tenant' : null },
    preferredProvider: 'claude',
  }
}

const realFetch = globalThis.fetch
beforeEach(() => {
  createMock.mockReset()
  globalThis.fetch = realFetch
  loadAiModelsMock.mockReset().mockResolvedValue([])
  loadSourcingSettingsMock.mockReset().mockResolvedValue({
    maxProfilesMin: 1, maxProfilesMax: 20, maxProfilesDefault: 8,
    maxCostEurPerRequest: 0, claudeSystemPrompt: '', mistralSystemPrompt: '',
    richnessWeights: { ...DEFAULT_WEIGHTS },
  })
  mutableConfig.ai.apiKey = 'sk-ant-test'
  mutableConfig.mistral.apiKey = 'mistral-test'
})
afterEach(() => { globalThis.fetch = realFetch })

// ── buildUserPrompt avec décisions passées (few-shot) ────────────────────────
describe('buildSourcingPrompt + analyzeCV — décisions passées', () => {
  it('injecte le bloc DÉCISIONS PASSÉES + sanitise les anchors', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID }] })
    const decisions = [
      { decision: 'hired' as const, priorAiScore: 75, anchor: 'Awa Diomandé\n\n  DRH\tconfirmée   '.repeat(20) },
      { decision: 'rejected' as const, priorAiScore: null, anchor: 'Profil junior' },
    ]
    await analyzeCV('claude', JOB, LONG_CV, decisions)
    const sentPrompt = createMock.mock.calls[0]![0]!.messages[0].content as string
    expect(sentPrompt).toContain('DÉCISIONS PASSÉES')
    expect(sentPrompt).toContain('[RECRUTÉ]')
    expect(sentPrompt).toContain('[REJETÉ]')
    expect(sentPrompt).toContain('score IA initial=75')
    // anchor tronquée à 220 chars + sauts de ligne neutralisés
    expect(sentPrompt).not.toContain('\n\n  DRH')
  })
})

// ── normalize : extracted "null" littéral → null ─────────────────────────────
describe('normalize — extracted diplôme/localisation "null"', () => {
  it('highestDiploma/location valant "null" textuel → null', async () => {
    const payload = JSON.stringify({
      score: 70, recommendation: 'maybe', summary: 's',
      strengths: [], gaps: [], redFlags: [], interviewQuestions: [],
      matchPercentage: 70,
      extracted: {
        yearsExperience: 200,            // borné à 60
        skills: ['React'],
        highestDiploma: 'null',
        location: 'null',
        languages: ['Français'],
      },
    })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: payload }] })
    const r = await analyzeCV('claude', JOB, LONG_CV)
    expect(r.extracted?.highestDiploma).toBeNull()
    expect(r.extracted?.location).toBeNull()
    expect(r.extracted?.yearsExperience).toBe(60)
  })

  it('extracted absent → yearsExperience null + listes vides', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID }] })
    const r = await analyzeCV('claude', JOB, LONG_CV)
    expect(r.extracted?.yearsExperience).toBeNull()
    expect(r.extracted?.skills).toEqual([])
  })

  it('highestDiploma/location réels conservés (branche ternaire vraie)', async () => {
    const payload = JSON.stringify({
      score: 70, recommendation: 'maybe', summary: 's',
      strengths: [], gaps: [], redFlags: [], interviewQuestions: [], matchPercentage: 70,
      extracted: {
        yearsExperience: 4, skills: [],
        highestDiploma: '  Master 2 Informatique  ',
        location: '  Abidjan, Cocody  ',
        languages: [],
      },
    })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: payload }] })
    const r = await analyzeCV('claude', JOB, LONG_CV)
    expect(r.extracted?.highestDiploma).toBe('Master 2 Informatique')
    expect(r.extracted?.location).toBe('Abidjan, Cocody')
  })
})

describe('buildUserPrompt — offre sans salaire ni champs', () => {
  it('salaire/desc/reqs manquants → libellés par défaut', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID }] })
    await analyzeCV('claude', { title: 'Dev' }, LONG_CV)
    const sent = createMock.mock.calls[0]![0]!.messages[0].content as string
    expect(sent).toContain('(non précisée)')   // salaire + description
    expect(sent).toContain('(non précisés)')   // prérequis
    expect(sent).toContain('CDI')              // contractType défaut
    expect(sent).toContain('Abidjan')          // location défaut
  })
})

// ── analyzeWithClaude : clé absente + réponse vide ───────────────────────────
describe('analyzeWithClaude — erreurs', () => {
  it('clé Claude absente (creds tenant sans clé) → erreur explicite', async () => {
    await expect(
      analyzeCV('claude', JOB, LONG_CV, undefined, undefined, tenantCreds(null, null)),
    ).rejects.toThrow(/Aucun modèle IA configuré/)
  })

  it('clé Claude absente côté plateforme uniquement → bascule impossible si mistral aussi vide', async () => {
    mutableConfig.ai.apiKey = undefined
    mutableConfig.mistral.apiKey = undefined
    await expect(analyzeCV('claude', JOB, LONG_CV)).rejects.toThrow(/Aucun modèle IA configuré/)
  })

  it('réponse Claude sans bloc texte → "Réponse Claude vide"', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'image', source: {} }] })
    await expect(analyzeCV('claude', JOB, LONG_CV)).rejects.toThrow(/Réponse Claude vide/)
  })

  it('utilise les creds tenant (clé + modèle) pour Claude', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: VALID }] })
    await analyzeCV('claude', JOB, LONG_CV, undefined, undefined, tenantCreds('sk-tenant', null))
    expect(createMock.mock.calls[0]![0]!.model).toBe('claude-tenant')
  })
})

// ── analyzeWithMistral : clé absente + réponse vide ──────────────────────────
describe('analyzeWithMistral — erreurs', () => {
  it('réponse Mistral vide (content manquant) → erreur', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ choices: [{ message: {} }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    await expect(analyzeCV('mistral', JOB, LONG_CV)).rejects.toThrow(/Réponse Mistral vide/)
  })

  it('bascule sur Mistral si seule la clé Mistral est dispo', async () => {
    mutableConfig.ai.apiKey = undefined
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ choices: [{ message: { content: VALID } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const r = await analyzeCV('claude', JOB, LONG_CV) // claude demandé mais indispo
    expect(r.modelUsed).toBe('mistral')
  })
})

// ── isModelAvailable — modèle inconnu + creds ────────────────────────────────
describe('isModelAvailable', () => {
  it('modèle inconnu → false', () => {
    expect(isModelAvailable('inconnu' as never)).toBe(false)
  })
  it('respecte les creds tenant', () => {
    expect(isModelAvailable('claude', tenantCreds('k', null))).toBe(true)
    expect(isModelAvailable('mistral', tenantCreds('k', null))).toBe(false)
  })
})

// ── costEur — modèle DB trouvé + repli ───────────────────────────────────────
describe('costEur via sourceProfiles', () => {
  it('utilise les tarifs du modèle DB quand présent', async () => {
    loadAiModelsMock.mockResolvedValue([{
      id: 'm', provider: 'claude', model_id: 'x', display_name: 'X', max_tokens: 4000,
      input_cost_per_1m_eur: 10, output_cost_per_1m_eur: 20, is_active: true, sort_order: 1,
    }])
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH) }],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    })
    const r = await sourceProfiles('claude', SRC_JOB, ['LinkedIn'], 5, ['CI'])
    expect(r.estimatedCostEur).toBeCloseTo(10) // 1M * 10 / 1M
  })

  it('repli sur le tarif historique Claude si aucun modèle DB', async () => {
    loadAiModelsMock.mockResolvedValue([])
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH) }],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    })
    const r = await sourceProfiles('claude', SRC_JOB, ['LinkedIn'], 5, ['CI'])
    expect(r.estimatedCostEur).toBeCloseTo(3 * 0.92) // (1M*3)/1M * 0.92
  })
})

// ── budget max dépassé → warning ─────────────────────────────────────────────
describe('sourceWithProvider — budget max', () => {
  it('logge un warning quand le coût dépasse le budget configuré', async () => {
    loadSourcingSettingsMock.mockResolvedValue({
      maxProfilesMin: 1, maxProfilesMax: 20, maxProfilesDefault: 8,
      maxCostEurPerRequest: 0.0001, claudeSystemPrompt: '', mistralSystemPrompt: '',
      richnessWeights: { ...DEFAULT_WEIGHTS },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH) }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    })
    await sourceProfiles('claude', SRC_JOB, ['LinkedIn'], 5, ['CI'])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[sourcing] coût IA'))
  })

  it('settings null (échec chargement) → pas de crash, pas de warning', async () => {
    loadSourcingSettingsMock.mockRejectedValue(new Error('settings down'))
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH) }],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    const r = await sourceProfiles('claude', SRC_JOB, ['LinkedIn'], 5, ['CI'])
    expect(r.jsonValid).toBe(true)
  })
})

// ── sourceProfiles — repli + aucun modèle ────────────────────────────────────
describe('sourceProfiles — sélection de modèle', () => {
  it('bascule sur Mistral si Claude indisponible', async () => {
    mutableConfig.ai.apiKey = undefined
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(RICH) } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const r = await sourceProfiles('claude', SRC_JOB, ['LinkedIn'], 5, ['CI'])
    expect(r.provider).toBe('mistral')
  })

  it('aucun modèle configuré → throw', async () => {
    mutableConfig.ai.apiKey = undefined
    mutableConfig.mistral.apiKey = undefined
    await expect(sourceProfiles('claude', SRC_JOB, ['LinkedIn'], 5, ['CI']))
      .rejects.toThrow(/Aucun modèle IA configuré/)
  })

  it('erreur provider → résultat error structuré (catch)', async () => {
    createMock.mockRejectedValueOnce(new Error('API boom'))
    const r = await sourceProfiles('claude', SRC_JOB, ['LinkedIn'], 5, ['CI'])
    expect(r.error).toContain('API boom')
    expect(r.jsonValid).toBe(false)
    expect(r.model).toBe('claude-sonnet-4-test')
  })
})

// ── buildSourcingRecommendation — toutes les branches ────────────────────────
describe('sourceProfilesCompare — recommandations & garde-fous', () => {
  it('clé Claude absente → bascule sur deux paliers Mistral (pas de throw)', async () => {
    mutableConfig.ai.apiKey = undefined
    // Une seule clé (Mistral) : la comparaison reste fonctionnelle en opposant
    // deux paliers du même fournisseur (Small vs Large). Deux appels fetch.
    const mistralOk = () => new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(RICH) } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mistralOk()).mockResolvedValueOnce(mistralOk())
    const r = await sourceProfilesCompare(SRC_JOB, ['LinkedIn'], 3, ['CI'])
    expect(r.claude.label).toBe('Mistral Small')
    expect(r.mistral.label).toBe('Mistral Large')
  })

  it('les deux clés IA absentes → throw "Aucune clé IA configurée"', async () => {
    mutableConfig.ai.apiKey = undefined
    mutableConfig.mistral.apiKey = undefined
    await expect(sourceProfilesCompare(SRC_JOB, ['LinkedIn'], 3, ['CI']))
      .rejects.toThrow(/Aucune clé IA configurée/)
  })

  // Pour couvrir buildSourcingRecommendation on appelle compare avec des
  // réponses mockées produisant chaque branche.
  it('Claude nettement plus riche → recommande Claude', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH) }],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    // Mistral renvoie un payload pauvre (richesse faible)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          strategy: { summary: 'x', bestPlatforms: [], searchKeywords: [], booleanSearch: '',
            estimatedTimeToFill: '', salaryBenchmark: { min: 0, max: 0, median: 0, currency: 'XOF' }, tips: [] },
          profiles: [],
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const r = await sourceProfilesCompare(SRC_JOB, ['LinkedIn'], 3, ['CI'])
    expect(r.winner).toBe('claude')
    expect(r.recommendation).toMatch(/Claude recommandé/)
  })

  it('Mistral indisponible (json invalide) → recommande Claude', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(RICH) }],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const r = await sourceProfilesCompare(SRC_JOB, ['LinkedIn'], 3, ['CI'])
    expect(r.recommendation).toMatch(/Mistral indisponible/)
    expect(r.ratios).toBeNull()
  })

  it('Claude indisponible (json invalide) → recommande Mistral', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'pas de json' }],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(RICH) } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const r = await sourceProfilesCompare(SRC_JOB, ['LinkedIn'], 3, ['CI'])
    expect(r.recommendation).toMatch(/Claude indisponible/)
    expect(r.winner).toBe('mistral')
  })

  // Branches de buildSourcingRecommendation testées directement via comportements
  // déterministes. On exerce les chemins restants par des doublons riches/égaux.
  it('les deux indisponibles → message "Aucun résultat exploitable"', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'pas de json' }],
      usage: { input_tokens: 100, output_tokens: 100 },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const r = await sourceProfilesCompare(SRC_JOB, ['LinkedIn'], 3, ['CI'])
    expect(r.recommendation).toMatch(/Aucun résultat exploitable/)
  })
})

// ── buildSourcingRecommendation — branches restantes (test direct) ───────────
describe('buildSourcingRecommendation — toutes les branches comparatives', () => {
  function provider(over: Partial<SourcingProviderResult>): SourcingProviderResult {
    const base = {
      provider: 'claude' as const, model: 'm', data: RICH, jsonValid: true,
      richnessScore: 50, profilesGenerated: 1, latencyMs: 1000,
      inputTokens: 100, outputTokens: 100, estimatedCostEur: 0.01, error: null,
      ...over,
    }
    // Le libellé suit le fournisseur (buildSourcingRecommendation raisonne sur label).
    return { ...base, label: over.label ?? (base.provider === 'claude' ? 'Claude' : 'Mistral') }
  }
  const reco = __internals.buildSourcingRecommendation

  it('Claude >15 pts plus riche → "Claude recommandé" avec surcoût', () => {
    const c = provider({ provider: 'claude',  richnessScore: 90, estimatedCostEur: 0.05 })
    const m = provider({ provider: 'mistral', richnessScore: 60, estimatedCostEur: 0.01 })
    expect(reco(c, m)).toMatch(/Claude recommandé/)
  })

  it('Mistral >15 pts plus riche → "Mistral recommandé" qualité supérieure', () => {
    const c = provider({ provider: 'claude',  richnessScore: 60 })
    const m = provider({ provider: 'mistral', richnessScore: 90 })
    expect(reco(c, m)).toMatch(/Mistral recommandé — qualité supérieure/)
  })

  it('costRatio>2 & richnessGap<10 → "qualité comparable" moins cher', () => {
    const c = provider({ provider: 'claude',  richnessScore: 55, estimatedCostEur: 0.10 })
    const m = provider({ provider: 'mistral', richnessScore: 50, estimatedCostEur: 0.01 })
    expect(reco(c, m)).toMatch(/qualité comparable/)
  })

  it('Mistral nettement plus rapide → recommandé pour la réactivité', () => {
    const c = provider({ provider: 'claude',  richnessScore: 50, estimatedCostEur: 0.01, latencyMs: 10_000 })
    const m = provider({ provider: 'mistral', richnessScore: 50, estimatedCostEur: 0.01, latencyMs: 1_000 })
    expect(reco(c, m)).toMatch(/réactivité/)
  })

  it('qualité & coût & latence équivalents → message neutre', () => {
    const c = provider({ provider: 'claude',  richnessScore: 50, estimatedCostEur: 0.01, latencyMs: 1_000 })
    const m = provider({ provider: 'mistral', richnessScore: 50, estimatedCostEur: 0.01, latencyMs: 1_000 })
    expect(reco(c, m)).toMatch(/Qualité équivalente/)
  })
})
