/**
 * COVERAGE — onboarding-ai.service (génération IA d'un parcours, Claude).
 *
 * Couvre : résolution des credentials par tenant (mock ai-credentials —
 * piège connu), absence de clé → erreur, réponse JSON valide, réponse sans
 * JSON exploitable, réponse hors-format (Zod rejette), réponse Claude vide,
 * nettoyage des fences markdown, assainissement des entrées (prompt).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    env: 'test',
    ai: { apiKey: 'sk-ant-env', model: 'claude-sonnet-4-env', maxTokens: 8192, temperature: 0.3 },
    mistral: { apiKey: null, model: 'mistral-large-latest', apiUrl: 'https://api.mistral.ai/v1' },
    database: { url: 'postgresql://test' },
  },
}))

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }))
vi.mock('./ai-credentials.service.js', () => ({
  resolveAiCreds: resolveMock,
}))

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}))

import { generateOnboardingPlan } from './onboarding-ai.service.js'

const CREDS_OK = {
  claude:  { apiKey: 'sk-ant-tenant', model: 'claude-sonnet-tenant' },
  mistral: { apiKey: null, model: 'mistral-large-latest' },
  preferredProvider: 'claude' as const,
}
const CREDS_NO_KEY = {
  claude:  { apiKey: null, model: 'claude-sonnet-tenant' },
  mistral: { apiKey: null, model: 'mistral-large-latest' },
  preferredProvider: 'claude' as const,
}

function validPlan() {
  const steps = Array.from({ length: 4 }, (_, n) => ({
    title: `Etape ${n}`, description: 'desc', phase: 'first_week',
    ownerRole: 'hr', dueOffsetDays: n, resources: [{ type: 'document', title: 'Doc', url: '' }],
  }))
  return { name: 'Parcours Comptable', description: 'Plan généré', steps }
}

const INPUT = {
  jobTitle: 'Comptable Senior', seniority: 'senior',
  department: 'Finance', companyContext: 'PME ivoirienne', schemaName: 'tenant_sotra',
}

beforeEach(() => {
  resolveMock.mockReset().mockResolvedValue(CREDS_OK)
  createMock.mockReset()
})

describe('generateOnboardingPlan — credentials', () => {
  it('résout les credentials du tenant avant l\'appel', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(validPlan()) }] })
    await generateOnboardingPlan(INPUT)
    expect(resolveMock).toHaveBeenCalledWith('tenant_sotra')
    // utilise le modèle du tenant
    expect(createMock.mock.calls[0]?.[0]?.model).toBe('claude-sonnet-tenant')
  })

  it('clé API absente (tenant + env) → erreur explicite', async () => {
    resolveMock.mockResolvedValueOnce(CREDS_NO_KEY)
    await expect(generateOnboardingPlan(INPUT)).rejects.toThrow(/Clé Anthropic non configurée/)
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe('generateOnboardingPlan — réponse IA', () => {
  it('JSON valide → plan validé par Zod', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(validPlan()) }] })
    const plan = await generateOnboardingPlan(INPUT)
    expect(plan.name).toBe('Parcours Comptable')
    expect(plan.steps).toHaveLength(4)
  })

  it('JSON entouré de fences markdown ```json → nettoyé puis validé', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(validPlan()) + '\n```' }] })
    const plan = await generateOnboardingPlan(INPUT)
    expect(plan.steps.length).toBeGreaterThanOrEqual(3)
  })

  it('texte sans accolades → "Réponse IA sans JSON exploitable"', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Désolé, aucun JSON ici.' }] })
    await expect(generateOnboardingPlan(INPUT)).rejects.toThrow(/sans JSON exploitable/)
  })

  it('JSON hors-format (moins de 3 étapes) → Zod rejette', async () => {
    const bad = { name: 'X', description: '', steps: [{ title: 'A', phase: 'day_one', ownerRole: 'hr', dueOffsetDays: 0 }] }
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(bad) }] })
    await expect(generateOnboardingPlan(INPUT)).rejects.toThrow()
  })

  it('JSON avec phase invalide → Zod rejette', async () => {
    const bad = validPlan()
    bad.steps[0]!.phase = 'phase_inexistante'
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(bad) }] })
    await expect(generateOnboardingPlan(INPUT)).rejects.toThrow()
  })

  it('aucun bloc texte dans la réponse → "Réponse Claude vide"', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'tool_use', name: 'x', input: {} }] })
    await expect(generateOnboardingPlan(INPUT)).rejects.toThrow(/Réponse Claude vide/)
  })

  it('content vide → "Réponse Claude vide"', async () => {
    createMock.mockResolvedValueOnce({ content: [] })
    await expect(generateOnboardingPlan(INPUT)).rejects.toThrow(/Réponse Claude vide/)
  })

  it('erreur API Anthropic propagée', async () => {
    createMock.mockRejectedValueOnce(new Error('rate_limit'))
    await expect(generateOnboardingPlan(INPUT)).rejects.toThrow(/rate_limit/)
  })
})

describe('generateOnboardingPlan — assainissement des entrées', () => {
  it('neutralise sauts de ligne et applique les défauts dans le prompt', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(validPlan()) }] })
    await generateOnboardingPlan({
      jobTitle: 'Dev\nFull   Stack',
      seniority: undefined,
      department: undefined,
      companyContext: undefined,
      schemaName: 'tenant_sotra',
    })
    const userPrompt = createMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string
    expect(userPrompt).toContain('Dev Full Stack')      // \n + espaces multiples écrasés
    expect(userPrompt).toContain('non précisée')        // séniorité défaut
    expect(userPrompt).toContain('non précisé')         // département défaut
    expect(userPrompt).toContain('PME ivoirienne')      // contexte défaut
  })

  it('schemaName null → resolveAiCreds(null), repli env utilisé', async () => {
    resolveMock.mockResolvedValueOnce({
      claude: { apiKey: 'sk-ant-env', model: 'claude-sonnet-4-env' },
      mistral: { apiKey: null, model: 'm' }, preferredProvider: 'claude' as const,
    })
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(validPlan()) }] })
    await generateOnboardingPlan({ jobTitle: 'Analyste', schemaName: null })
    expect(resolveMock).toHaveBeenCalledWith(null)
    expect(createMock.mock.calls[0]?.[0]?.model).toBe('claude-sonnet-4-env')
  })
})
