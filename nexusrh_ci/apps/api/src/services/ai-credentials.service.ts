/**
 * Résolution des credentials IA par tenant (clé API + modèle), avec repli sur la
 * clé/modèle plateforme (variables d'environnement) — zéro régression pour les
 * tenants qui n'ont pas configuré leur propre clé.
 *
 * Sécurité :
 *   A02 — les clés tenant sont stockées CHIFFRÉES (AES-256-GCM, utils/crypto)
 *         dans "<schema>".ai_settings. La clé en clair ne transite que vers le
 *         fournisseur LLM au moment de l'appel ; elle n'est JAMAIS renvoyée par
 *         l'API (cf. maskKey pour l'affichage).
 *   A03 — schemaName validé avant interpolation SQL.
 *   A10 — toute erreur de lecture/déchiffrement → repli silencieux sur l'env
 *         (jamais d'exception qui casserait une fonctionnalité IA).
 */
import { config } from '../config.js'
import { pool } from '../db/pool.js'
import { decryptIfPresent } from '../utils/crypto.js'
import { isValidSchemaName } from '../utils/schema-name.js'

export type AiProvider = 'claude' | 'mistral'

/** D'où provient la clé effective : du tenant, de la plateforme, ou aucune. */
export type KeySource = 'tenant' | 'platform' | null

export interface ProviderCreds {
  /** Clé effective : clé tenant déchiffrée, sinon clé plateforme (env). */
  apiKey: string | null
  /** Modèle effectif : modèle tenant, sinon modèle plateforme (env). */
  model: string
  /**
   * Source de la clé effective. 'tenant' = clé propre du tenant (prioritaire),
   * 'platform' = repli sur la clé générale du super_admin, null = aucune clé
   * disponible (tenant sans clé ET repli plateforme désactivé/absent).
   * Le tracking de conso (platform.ai_usage) ne compte QUE source='platform'.
   */
  source: KeySource
}

export interface AiCreds {
  claude:  ProviderCreds
  mistral: ProviderCreds
  /** Fournisseur préféré du tenant (par défaut 'claude'). */
  preferredProvider: AiProvider
}

/** Credentials plateforme (env) — base de repli. */
export function envCreds(): AiCreds {
  const claudeKey  = config.ai.apiKey ?? null
  const mistralKey = config.mistral.apiKey ?? null
  return {
    claude:  { apiKey: claudeKey,  model: config.ai.model,      source: claudeKey  ? 'platform' : null },
    mistral: { apiKey: mistralKey, model: config.mistral.model, source: mistralKey ? 'platform' : null },
    // Fournisseur par défaut plateforme — paramétrable via AI_DEFAULT_PROVIDER
    // (au lieu d'être figé sur Claude). Un tenant peut le surcharger.
    preferredProvider: config.ai.defaultProvider === 'mistral' ? 'mistral' : 'claude',
  }
}

/**
 * Résout les credentials IA effectifs pour un schéma tenant.
 *
 * Priorité (non négociable) : clé du TENANT > clé PLATEFORME du super_admin.
 * Le repli sur la clé plateforme n'a lieu QUE si le tenant y est autorisé
 * (platform.tenants.ai_platform_key_enabled, true par défaut). Si le tenant
 * n'a pas sa propre clé et que le repli est désactivé, le provider concerné
 * n'a aucune clé (source=null) → l'IA est indisponible pour ce tenant.
 *
 * Non bloquant : toute erreur de lecture/déchiffrement → repli env.
 */
export async function resolveAiCreds(schemaName: string | null | undefined): Promise<AiCreds> {
  const fallback = envCreds()
  if (!schemaName || schemaName === 'platform' || !isValidSchemaName(schemaName)) return fallback

  // Le repli plateforme est-il autorisé pour ce tenant ? (true par défaut, et
  // si la colonne/le tenant n'existe pas encore — zéro régression.)
  let platformAllowed = true
  try {
    const t = await pool.query<{ ai_platform_key_enabled: boolean | null }>(
      `SELECT ai_platform_key_enabled FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
      [schemaName],
    )
    if (t.rows[0] && t.rows[0].ai_platform_key_enabled === false) platformAllowed = false
  } catch { /* colonne absente / erreur → autorisé (défaut) */ }

  // Construit les creds d'un provider : clé tenant prioritaire, sinon repli
  // plateforme si autorisé, sinon aucune clé.
  const pick = (tenantKey: string | null, tenantModel: string | null, fb: ProviderCreds): ProviderCreds => {
    if (tenantKey) return { apiKey: tenantKey, model: tenantModel || fb.model, source: 'tenant' }
    if (platformAllowed && fb.apiKey) return { apiKey: fb.apiKey, model: fb.model, source: 'platform' }
    return { apiKey: null, model: tenantModel || fb.model, source: null }
  }

  try {
    const res = await pool.query<{
      claude_api_key_enc:  string | null
      claude_model:        string | null
      mistral_api_key_enc: string | null
      mistral_model:       string | null
      preferred_provider:  string | null
    }>(
      `SELECT claude_api_key_enc, claude_model, mistral_api_key_enc, mistral_model, preferred_provider
         FROM "${schemaName}".ai_settings LIMIT 1`,
    )
    const r = res.rows[0]
    if (!r) {
      // Pas de réglage tenant : repli plateforme si autorisé, sinon aucune clé.
      return {
        claude:  pick(null, null, fallback.claude),
        mistral: pick(null, null, fallback.mistral),
        preferredProvider: fallback.preferredProvider,
      }
    }
    return {
      claude:  pick(decryptIfPresent(r.claude_api_key_enc),  r.claude_model,  fallback.claude),
      mistral: pick(decryptIfPresent(r.mistral_api_key_enc), r.mistral_model, fallback.mistral),
      preferredProvider: r.preferred_provider === 'mistral' ? 'mistral' : 'claude',
    }
  } catch {
    return fallback
  }
}

/** Le chiffrement des clés tenant est-il disponible (ENCRYPTION_KEY configurée) ? */
export function isEncryptionAvailable(): boolean {
  return (process.env['ENCRYPTION_KEY'] ?? '').length === 64
}

/**
 * Masque une clé pour l'affichage : ne révèle que les 4 derniers caractères.
 * `null`/vide → null. Ne renvoie JAMAIS la clé en clair (A02).
 */
export function maskKey(apiKey: string | null | undefined): string | null {
  if (!apiKey) return null
  const last4 = apiKey.slice(-4)
  return `••••••••${last4}`
}
