/**
 * Charge la configuration Sourcing IA depuis platform.* avec fallback aux
 * valeurs par défaut (zéro régression si les tables sont vides).
 *
 * Toutes les "constantes" du module sourcing passent par ce service —
 * plateformes par pays, devises, modèles IA, tarifs token, prompts système,
 * pondérations richesse, slider profils, budget max.
 *
 * Conformité OWASP A02 : aucune clé/credential ici, uniquement de la config
 * métier paramétrable par le super_admin.
 */
import { pool } from '../db/pool.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AiModelRow {
  id:                     string
  provider:               'claude' | 'mistral' | string
  model_id:               string
  display_name:           string
  max_tokens:             number
  input_cost_per_1m_eur:  number
  output_cost_per_1m_eur: number
  is_active:              boolean
  sort_order:             number
}

export interface SourcingPlatformRow {
  id:            string
  code:          string
  name:          string
  country_code:  string | null
  url:           string | null
  est_pool:      number | null
  is_active:     boolean
  is_panafrican: boolean
  sort_order:    number
}

export interface RichnessWeights {
  hasProfiles:        number  // points si ≥1 profil
  fiveProfiles:       number  // points si ≥5 profils
  perProfile:         number  // points par profil (jusqu'à 10)
  hasBooleanSearch:   number
  hasKeywords:        number  // si ≥3 mots-clés
  hasSalaryBenchmark: number
  hasBestPlatforms:   number  // si ≥2 plateformes
  hasTips:            number  // si ≥2 conseils
  firstProfileLinkedin: number
  firstProfileApproach: number
  firstProfileSkills:   number
}

export interface SourcingSettings {
  maxProfilesMin:        number
  maxProfilesMax:        number
  maxProfilesDefault:    number
  maxCostEurPerRequest:  number  // budget max IA par requête (0 = pas de limite)
  claudeSystemPrompt:    string  // override du prompt Claude
  mistralSystemPrompt:   string  // override du prompt Mistral
  richnessWeights:       RichnessWeights
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallbacks (valeurs par défaut = comportement avant paramétrage)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODELS: AiModelRow[] = [
  {
    id: 'default-claude-sonnet-4', provider: 'claude',
    model_id: process.env['AI_MODEL'] ?? 'claude-sonnet-4-20250514',
    display_name: 'Claude Sonnet 4 (par défaut)',
    max_tokens: 4000,
    input_cost_per_1m_eur: 2.76, output_cost_per_1m_eur: 13.80, // 3$ / 15$ × 0.92
    is_active: true, sort_order: 10,
  },
  {
    id: 'default-mistral-large', provider: 'mistral',
    model_id: process.env['MISTRAL_MODEL'] ?? 'mistral-large-latest',
    display_name: 'Mistral Large',
    max_tokens: 4000,
    input_cost_per_1m_eur: 1.84, output_cost_per_1m_eur: 5.52, // 2$ / 6$ × 0.92
    is_active: true, sort_order: 20,
  },
]

const DEFAULT_RICHNESS_WEIGHTS: RichnessWeights = {
  hasProfiles:        20,
  fiveProfiles:       10,
  perProfile:         2,
  hasBooleanSearch:   10,
  hasKeywords:        10,
  hasSalaryBenchmark: 10,
  hasBestPlatforms:   10,
  hasTips:            5,
  firstProfileLinkedin: 5,
  firstProfileApproach: 5,
  firstProfileSkills:   5,
}

const DEFAULT_SETTINGS: SourcingSettings = {
  maxProfilesMin:       1,
  maxProfilesMax:       20,
  maxProfilesDefault:   8,
  maxCostEurPerRequest: 0,  // 0 = pas de limite
  claudeSystemPrompt:   '',  // vide = utiliser le prompt par défaut codé
  mistralSystemPrompt:  '',
  richnessWeights:      DEFAULT_RICHNESS_WEIGHTS,
}

// Plateformes panafricaines + locales par pays (fallback identique à l'ancienne
// constante SOURCING_PLATFORMS_BY_COUNTRY de recruitment-ai.service.ts).
const DEFAULT_PLATFORMS: SourcingPlatformRow[] = [
  { id: 'd-linkedin',     code: 'linkedin',     name: 'LinkedIn',     country_code: null, url: 'https://linkedin.com', est_pool: null, is_active: true, is_panafrican: true,  sort_order: 1 },
  { id: 'd-africawork',   code: 'africawork',   name: 'Africawork',   country_code: null, url: 'https://africawork.com', est_pool: null, is_active: true, is_panafrican: true,  sort_order: 2 },
  { id: 'd-jobnetafrica', code: 'jobnetafrica', name: 'JobnetAfrica', country_code: null, url: 'https://jobnetafrica.com', est_pool: null, is_active: true, is_panafrican: true,  sort_order: 3 },
  { id: 'd-indeed',       code: 'indeed',       name: 'Indeed',       country_code: null, url: 'https://indeed.com', est_pool: null, is_active: true, is_panafrican: true,  sort_order: 4 },
  { id: 'd-glassdoor',    code: 'glassdoor',    name: 'Glassdoor',    country_code: null, url: 'https://glassdoor.com', est_pool: null, is_active: true, is_panafrican: true,  sort_order: 5 },

  { id: 'd-emploici',  code: 'emploi_ci', name: 'Emploi.ci',           country_code: 'CI', url: 'https://www.emploi.ci', est_pool: null, is_active: true, is_panafrican: false, sort_order: 10 },
  { id: 'd-rmoci',     code: 'rmo_ci',    name: 'RMO Côte d\'Ivoire',  country_code: 'CI', url: null, est_pool: null, is_active: true, is_panafrican: false, sort_order: 11 },
  { id: 'd-novojob',   code: 'novojob',   name: 'Novojob',             country_code: 'CI', url: 'https://www.novojob.com', est_pool: null, is_active: true, is_panafrican: false, sort_order: 12 },
  { id: 'd-emploisn',  code: 'emploi_sn', name: 'Emploi.sn',           country_code: 'SN', url: 'https://www.emploi.sn', est_pool: null, is_active: true, is_panafrican: false, sort_order: 20 },
  { id: 'd-senjob',    code: 'senjob',    name: 'Senjob',              country_code: 'SN', url: 'https://www.senjob.com', est_pool: null, is_active: true, is_panafrican: false, sort_order: 21 },
  { id: 'd-emploibj',  code: 'emploi_bj', name: 'EmploiBénin',         country_code: 'BJ', url: null, est_pool: null, is_active: true, is_panafrican: false, sort_order: 30 },
  { id: 'd-emploitg',  code: 'emploi_tg', name: 'Emploi-Togo',         country_code: 'TG', url: null, est_pool: null, is_active: true, is_panafrican: false, sort_order: 40 },
  { id: 'd-minajobs',  code: 'minajobs',  name: 'MinaJobs',            country_code: 'CM', url: null, est_pool: null, is_active: true, is_panafrican: false, sort_order: 50 },
  { id: 'd-jobberman', code: 'jobberman', name: 'Jobberman',           country_code: 'NG', url: 'https://www.jobberman.com', est_pool: null, is_active: true, is_panafrican: false, sort_order: 60 },
  { id: 'd-wttj',      code: 'wttj',      name: 'Welcome to the Jungle', country_code: 'FR', url: 'https://welcometothejungle.com', est_pool: null, is_active: true, is_panafrican: false, sort_order: 99 },
  { id: 'd-apec',      code: 'apec',      name: 'Apec',                country_code: 'FR', url: 'https://www.apec.fr', est_pool: null, is_active: true, is_panafrican: false, sort_order: 98 },
]

// ─────────────────────────────────────────────────────────────────────────────
// Cache en mémoire — TTL court pour ne pas surcharger la DB sur chaque appel
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry<T> { value: T; expiresAt: number }
const CACHE_TTL_MS = 60_000  // 1 minute — ajustable
let modelsCache:    CacheEntry<AiModelRow[]> | null = null
let platformsCache: CacheEntry<SourcingPlatformRow[]> | null = null
let settingsCache:  CacheEntry<SourcingSettings> | null = null

export function invalidateSourcingConfigCache(): void {
  modelsCache = null
  platformsCache = null
  settingsCache = null
}

function isFresh<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null && entry.expiresAt > Date.now()
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────

export async function loadAiModels(): Promise<AiModelRow[]> {
  if (isFresh(modelsCache)) return modelsCache.value
  try {
    const res = await pool.query<AiModelRow>(
      `SELECT id, provider, model_id, display_name, max_tokens,
              input_cost_per_1m_eur::float AS input_cost_per_1m_eur,
              output_cost_per_1m_eur::float AS output_cost_per_1m_eur,
              is_active, sort_order
         FROM platform.ai_models
        WHERE is_active = true
        ORDER BY sort_order, provider, model_id`,
    )
    const rows = res.rows.length > 0 ? res.rows : DEFAULT_MODELS
    modelsCache = { value: rows, expiresAt: Date.now() + CACHE_TTL_MS }
    return rows
  } catch {
    return DEFAULT_MODELS
  }
}

export async function loadSourcingPlatforms(): Promise<SourcingPlatformRow[]> {
  if (isFresh(platformsCache)) return platformsCache.value
  try {
    const res = await pool.query<SourcingPlatformRow>(
      `SELECT id, code, name, country_code, url,
              est_pool, is_active, is_panafrican, sort_order
         FROM platform.sourcing_platforms
        WHERE is_active = true
        ORDER BY sort_order, name`,
    )
    const rows = res.rows.length > 0 ? res.rows : DEFAULT_PLATFORMS
    platformsCache = { value: rows, expiresAt: Date.now() + CACHE_TTL_MS }
    return rows
  } catch {
    return DEFAULT_PLATFORMS
  }
}

export async function loadSourcingSettings(): Promise<SourcingSettings> {
  if (isFresh(settingsCache)) return settingsCache.value
  try {
    const res = await pool.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM platform.sourcing_settings`,
    )
    const map = new Map(res.rows.map(r => [r.key, r.value]))
    const merged: SourcingSettings = {
      maxProfilesMin:       num(map.get('max_profiles_min'),     DEFAULT_SETTINGS.maxProfilesMin),
      maxProfilesMax:       num(map.get('max_profiles_max'),     DEFAULT_SETTINGS.maxProfilesMax),
      maxProfilesDefault:   num(map.get('max_profiles_default'), DEFAULT_SETTINGS.maxProfilesDefault),
      maxCostEurPerRequest: num(map.get('max_cost_eur_per_request'), DEFAULT_SETTINGS.maxCostEurPerRequest),
      claudeSystemPrompt:   str(map.get('claude_system_prompt'),  DEFAULT_SETTINGS.claudeSystemPrompt),
      mistralSystemPrompt:  str(map.get('mistral_system_prompt'), DEFAULT_SETTINGS.mistralSystemPrompt),
      richnessWeights:      mergeWeights(map.get('richness_weights')),
    }
    settingsCache = { value: merged, expiresAt: Date.now() + CACHE_TTL_MS }
    return merged
  } catch {
    return DEFAULT_SETTINGS
  }
}

function num(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'object' && v !== null && 'value' in v) {
    const inner = (v as { value: unknown }).value
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown, fallback: string): string {
  if (typeof v === 'string') return v
  if (typeof v === 'object' && v !== null && 'value' in v) {
    const inner = (v as { value: unknown }).value
    if (typeof inner === 'string') return inner
  }
  return fallback
}

function mergeWeights(v: unknown): RichnessWeights {
  if (!v || typeof v !== 'object') return DEFAULT_RICHNESS_WEIGHTS
  const obj = v as Record<string, unknown>
  return {
    hasProfiles:        num(obj['hasProfiles'],        DEFAULT_RICHNESS_WEIGHTS.hasProfiles),
    fiveProfiles:       num(obj['fiveProfiles'],       DEFAULT_RICHNESS_WEIGHTS.fiveProfiles),
    perProfile:         num(obj['perProfile'],         DEFAULT_RICHNESS_WEIGHTS.perProfile),
    hasBooleanSearch:   num(obj['hasBooleanSearch'],   DEFAULT_RICHNESS_WEIGHTS.hasBooleanSearch),
    hasKeywords:        num(obj['hasKeywords'],        DEFAULT_RICHNESS_WEIGHTS.hasKeywords),
    hasSalaryBenchmark: num(obj['hasSalaryBenchmark'], DEFAULT_RICHNESS_WEIGHTS.hasSalaryBenchmark),
    hasBestPlatforms:   num(obj['hasBestPlatforms'],   DEFAULT_RICHNESS_WEIGHTS.hasBestPlatforms),
    hasTips:            num(obj['hasTips'],            DEFAULT_RICHNESS_WEIGHTS.hasTips),
    firstProfileLinkedin: num(obj['firstProfileLinkedin'], DEFAULT_RICHNESS_WEIGHTS.firstProfileLinkedin),
    firstProfileApproach: num(obj['firstProfileApproach'], DEFAULT_RICHNESS_WEIGHTS.firstProfileApproach),
    firstProfileSkills:   num(obj['firstProfileSkills'],   DEFAULT_RICHNESS_WEIGHTS.firstProfileSkills),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers : convertir modèles en tarifs (utilisés par costClaude/Mistral)
// ─────────────────────────────────────────────────────────────────────────────

export async function getCostRatesForProvider(provider: 'claude' | 'mistral'): Promise<{ inputEur: number; outputEur: number } | null> {
  const models = await loadAiModels()
  const m = models.find(x => x.provider === provider && x.is_active)
  if (!m) return null
  return { inputEur: m.input_cost_per_1m_eur, outputEur: m.output_cost_per_1m_eur }
}

// Pour rester compatible avec les tests existants qui appellent
// computeSourcingRichness avec une signature sans config DB, on expose
// aussi les pondérations par défaut.
export function defaultRichnessWeights(): RichnessWeights {
  return { ...DEFAULT_RICHNESS_WEIGHTS }
}

export function defaultSettings(): SourcingSettings {
  return { ...DEFAULT_SETTINGS, richnessWeights: { ...DEFAULT_RICHNESS_WEIGHTS } }
}
