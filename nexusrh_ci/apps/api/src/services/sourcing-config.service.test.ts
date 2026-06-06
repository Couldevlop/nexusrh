/**
 * Sourcing IA 100% paramétrable — couverture exhaustive de sourcing-config.service.
 *
 * Tout passe par les tables platform.* (ai_models, sourcing_platforms,
 * sourcing_settings). Le pool pg est mocké au niveau module (new Pool() à
 * l'import). On contrôle finement chaque réponse SQL + branches d'erreur,
 * cache TTL (fake timers), helpers de coercition (num/str), fusion de
 * pondérations et fallbacks par défaut.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))
vi.mock('../config.js', () => ({
  config: { database: { url: 'postgresql://test' } },
}))

import {
  loadAiModels,
  loadSourcingPlatforms,
  loadSourcingSettings,
  getCostRatesForProvider,
  defaultRichnessWeights,
  defaultSettings,
  invalidateSourcingConfigCache,
  type AiModelRow,
  type SourcingPlatformRow,
} from './sourcing-config.service.js'

const DB_MODEL: AiModelRow = {
  id: 'm-claude', provider: 'claude', model_id: 'claude-db-1',
  display_name: 'Claude DB', max_tokens: 4096,
  input_cost_per_1m_eur: 3.0, output_cost_per_1m_eur: 15.0,
  is_active: true, sort_order: 5,
}

const DB_PLATFORM: SourcingPlatformRow = {
  id: 'p-db', code: 'db_platform', name: 'DB Platform',
  country_code: 'CI', url: 'https://db.example', est_pool: 500,
  is_active: true, is_panafrican: false, sort_order: 1,
}

beforeEach(() => {
  queryMock.mockReset()
  invalidateSourcingConfigCache()
})
afterEach(() => {
  vi.useRealTimers()
  invalidateSourcingConfigCache()
})

// ── loadAiModels ────────────────────────────────────────────────────────────
describe('loadAiModels', () => {
  it('retourne les modèles de la DB quand présents', async () => {
    queryMock.mockResolvedValueOnce({ rows: [DB_MODEL] })
    const rows = await loadAiModels()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.model_id).toBe('claude-db-1')
  })

  it('replie sur DEFAULT_MODELS quand la DB est vide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const rows = await loadAiModels()
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.some(r => r.provider === 'claude')).toBe(true)
    expect(rows.some(r => r.provider === 'mistral')).toBe(true)
  })

  it('replie sur DEFAULT_MODELS si la requête échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const rows = await loadAiModels()
    expect(rows.some(r => r.id === 'default-claude-sonnet-4')).toBe(true)
  })

  it('sert le cache au 2e appel sans retoucher la DB (fresh)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [DB_MODEL] })
    await loadAiModels()
    const rows2 = await loadAiModels()
    expect(rows2[0]!.model_id).toBe('claude-db-1')
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('rerequête la DB une fois le TTL expiré', async () => {
    vi.useFakeTimers()
    queryMock.mockResolvedValue({ rows: [DB_MODEL] })
    await loadAiModels()
    vi.advanceTimersByTime(60_001)
    await loadAiModels()
    expect(queryMock).toHaveBeenCalledTimes(2)
  })
})

// ── loadSourcingPlatforms ────────────────────────────────────────────────────
describe('loadSourcingPlatforms', () => {
  it('retourne les plateformes de la DB quand présentes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [DB_PLATFORM] })
    const rows = await loadSourcingPlatforms()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.code).toBe('db_platform')
  })

  it('replie sur DEFAULT_PLATFORMS quand la DB est vide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const rows = await loadSourcingPlatforms()
    expect(rows.some(r => r.code === 'linkedin')).toBe(true)
    expect(rows.some(r => r.code === 'emploi_ci')).toBe(true)
  })

  it('replie sur DEFAULT_PLATFORMS si la requête échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const rows = await loadSourcingPlatforms()
    expect(rows.some(r => r.is_panafrican)).toBe(true)
  })

  it('sert le cache au 2e appel (fresh)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [DB_PLATFORM] })
    await loadSourcingPlatforms()
    await loadSourcingPlatforms()
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('rerequête après expiration du TTL', async () => {
    vi.useFakeTimers()
    queryMock.mockResolvedValue({ rows: [DB_PLATFORM] })
    await loadSourcingPlatforms()
    vi.advanceTimersByTime(60_001)
    await loadSourcingPlatforms()
    expect(queryMock).toHaveBeenCalledTimes(2)
  })
})

// ── loadSourcingSettings ─────────────────────────────────────────────────────
describe('loadSourcingSettings', () => {
  it('fusionne les settings DB (valeurs nombre/string brutes)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { key: 'max_profiles_min', value: 2 },
        { key: 'max_profiles_max', value: 15 },
        { key: 'max_profiles_default', value: 6 },
        { key: 'max_cost_eur_per_request', value: 0.5 },
        { key: 'claude_system_prompt', value: 'Prompt Claude custom' },
        { key: 'mistral_system_prompt', value: 'Prompt Mistral custom' },
        { key: 'richness_weights', value: { hasProfiles: 30, perProfile: 3 } },
      ],
    })
    const s = await loadSourcingSettings()
    expect(s.maxProfilesMin).toBe(2)
    expect(s.maxProfilesMax).toBe(15)
    expect(s.maxProfilesDefault).toBe(6)
    expect(s.maxCostEurPerRequest).toBe(0.5)
    expect(s.claudeSystemPrompt).toBe('Prompt Claude custom')
    expect(s.mistralSystemPrompt).toBe('Prompt Mistral custom')
    expect(s.richnessWeights.hasProfiles).toBe(30)
    expect(s.richnessWeights.perProfile).toBe(3)
    // Pondération non fournie → défaut conservé
    expect(s.richnessWeights.fiveProfiles).toBe(10)
  })

  it('gère les valeurs JSONB enveloppées { value: ... } (num + str)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { key: 'max_profiles_min', value: { value: 4 } },
        { key: 'claude_system_prompt', value: { value: 'wrapped prompt' } },
      ],
    })
    const s = await loadSourcingSettings()
    expect(s.maxProfilesMin).toBe(4)
    expect(s.claudeSystemPrompt).toBe('wrapped prompt')
  })

  it('coerce une string numérique via Number()', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ key: 'max_profiles_max', value: '12' }],
    })
    const s = await loadSourcingSettings()
    expect(s.maxProfilesMax).toBe(12)
  })

  it('replie sur le défaut quand une valeur est invalide (NaN)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { key: 'max_profiles_min', value: 'pas un nombre' },
        { key: 'claude_system_prompt', value: 42 }, // pas une string → défaut ''
      ],
    })
    const s = await loadSourcingSettings()
    expect(s.maxProfilesMin).toBe(1)         // DEFAULT_SETTINGS.maxProfilesMin
    expect(s.claudeSystemPrompt).toBe('')    // DEFAULT_SETTINGS.claudeSystemPrompt
  })

  it('richness_weights non-objet → pondérations par défaut intégrales', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ key: 'richness_weights', value: 'invalide' }],
    })
    const s = await loadSourcingSettings()
    expect(s.richnessWeights).toEqual(defaultRichnessWeights())
  })

  it('richness_weights null → pondérations par défaut', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ key: 'richness_weights', value: null }],
    })
    const s = await loadSourcingSettings()
    expect(s.richnessWeights).toEqual(defaultRichnessWeights())
  })

  it('aucune ligne → tous les défauts', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const s = await loadSourcingSettings()
    expect(s).toEqual(defaultSettings())
  })

  it('replie sur DEFAULT_SETTINGS si la requête échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const s = await loadSourcingSettings()
    expect(s.maxProfilesDefault).toBe(8)
  })

  it('sert le cache au 2e appel (fresh)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await loadSourcingSettings()
    await loadSourcingSettings()
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('rerequête après expiration du TTL', async () => {
    vi.useFakeTimers()
    queryMock.mockResolvedValue({ rows: [] })
    await loadSourcingSettings()
    vi.advanceTimersByTime(60_001)
    await loadSourcingSettings()
    expect(queryMock).toHaveBeenCalledTimes(2)
  })
})

// ── getCostRatesForProvider ──────────────────────────────────────────────────
describe('getCostRatesForProvider', () => {
  it('retourne les tarifs du modèle DB actif du provider demandé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [DB_MODEL] })
    const r = await getCostRatesForProvider('claude')
    expect(r).toEqual({ inputEur: 3.0, outputEur: 15.0 })
  })

  it('replie sur les modèles par défaut (provider mistral)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const r = await getCostRatesForProvider('mistral')
    expect(r).not.toBeNull()
    expect(r!.inputEur).toBeCloseTo(1.84)
    expect(r!.outputEur).toBeCloseTo(5.52)
  })

  it('retourne null si aucun modèle actif pour le provider', async () => {
    // Modèle DB d'un autre provider seulement → find échoue
    queryMock.mockResolvedValueOnce({
      rows: [{ ...DB_MODEL, provider: 'autre-provider' }],
    })
    const r = await getCostRatesForProvider('mistral')
    expect(r).toBeNull()
  })
})

// ── helpers par défaut (copies défensives) ───────────────────────────────────
describe('defaultRichnessWeights / defaultSettings', () => {
  it('defaultRichnessWeights retourne une copie indépendante', () => {
    const a = defaultRichnessWeights()
    a.hasProfiles = 999
    const b = defaultRichnessWeights()
    expect(b.hasProfiles).toBe(20)
  })

  it('defaultSettings contient des pondérations clonées', () => {
    const s = defaultSettings()
    s.richnessWeights.hasProfiles = 999
    expect(defaultSettings().richnessWeights.hasProfiles).toBe(20)
    expect(s.maxProfilesDefault).toBe(8)
  })
})

describe('invalidateSourcingConfigCache', () => {
  it('force une nouvelle lecture DB après invalidation', async () => {
    queryMock.mockResolvedValue({ rows: [DB_MODEL] })
    await loadAiModels()
    invalidateSourcingConfigCache()
    await loadAiModels()
    expect(queryMock).toHaveBeenCalledTimes(2)
  })
})
