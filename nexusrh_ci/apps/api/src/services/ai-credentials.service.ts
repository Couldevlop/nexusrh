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

export interface ProviderCreds {
  /** Clé effective : clé tenant déchiffrée, sinon clé plateforme (env). */
  apiKey: string | null
  /** Modèle effectif : modèle tenant, sinon modèle plateforme (env). */
  model: string
}

export interface AiCreds {
  claude:  ProviderCreds
  mistral: ProviderCreds
  /** Fournisseur préféré du tenant (par défaut 'claude'). */
  preferredProvider: AiProvider
}

/** Credentials plateforme (env) — base de repli. */
export function envCreds(): AiCreds {
  return {
    claude:  { apiKey: config.ai.apiKey ?? null,      model: config.ai.model },
    mistral: { apiKey: config.mistral.apiKey ?? null, model: config.mistral.model },
    // Fournisseur par défaut plateforme — paramétrable via AI_DEFAULT_PROVIDER
    // (au lieu d'être figé sur Claude). Un tenant peut le surcharger.
    preferredProvider: config.ai.defaultProvider === 'mistral' ? 'mistral' : 'claude',
  }
}

/**
 * Résout les credentials IA effectifs pour un schéma tenant : clé/modèle du
 * tenant si présents, sinon repli env. Non bloquant.
 */
export async function resolveAiCreds(schemaName: string | null | undefined): Promise<AiCreds> {
  const fallback = envCreds()
  if (!schemaName || schemaName === 'platform' || !isValidSchemaName(schemaName)) return fallback
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
    if (!r) return fallback
    return {
      claude: {
        apiKey: decryptIfPresent(r.claude_api_key_enc) ?? fallback.claude.apiKey,
        model:  r.claude_model || fallback.claude.model,
      },
      mistral: {
        apiKey: decryptIfPresent(r.mistral_api_key_enc) ?? fallback.mistral.apiKey,
        model:  r.mistral_model || fallback.mistral.model,
      },
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
