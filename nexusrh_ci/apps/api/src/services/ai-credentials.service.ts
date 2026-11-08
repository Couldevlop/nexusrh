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
import { decryptIfPresent } from '@nexusrhci/shared/crypto'
import { isValidSchemaName } from '../utils/schema-name.js'

export type AiProvider = 'claude' | 'mistral'

/** Modèle local de dernier recours : une API OpenAI-compatible, clé facultative. */
export interface LocalModel {
  apiUrl: string
  model:  string
  apiKey: string | null
  /** Libellé affiché à l'utilisateur (« Lucie 7B », « Qwen 2.5 »…). */
  label:  string
}

/**
 * Modèle auto-hébergé configuré par VARIABLE D'ENVIRONNEMENT, s'il y en a un.
 *
 * Seule l'URL décide : la clé est facultative (un service interne au cluster
 * n'en demande pas).
 */
export function localModel(): LocalModel | null {
  const apiUrl = (config.aiLocal?.apiUrl ?? '').trim()
  if (!apiUrl) return null
  return {
    apiUrl,
    model: config.aiLocal.model,
    apiKey: config.aiLocal.apiKey ?? null,
    label: DEFAULT_LOCAL_LABEL,
  }
}

/** Libellé affiché quand l'exploitant n'en a pas choisi un. */
export const DEFAULT_LOCAL_LABEL = 'modèle local'

/**
 * Une URL de modèle est-elle utilisable ?
 *
 * http(s) seulement, et pas de crédentials dans l'URL. Les adresses privées
 * sont ici LÉGITIMES — c'est précisément un service du cluster — donc le
 * garde-fou SSRF habituel ne s'applique pas : ce qui protège, c'est que seul le
 * super_admin écrit cette valeur.
 */
export function isUsableModelUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.username || u.password) return false
    return u.hostname.length > 0
  } catch { return false }
}

/**
 * Modèle auto-hébergé effectif : la configuration PLATEFORME (réglée par le
 * super_admin dans l'écran Paramètres) passe devant les variables
 * d'environnement.
 *
 * Pourquoi la base plutôt que l'environnement seul : changer de modèle ne doit
 * pas demander un redéploiement ni une modification du chart Helm. Lucie 7B
 * aujourd'hui, Qwen demain — même protocole OpenAI-compatible, donc l'adresse
 * et le nom suffisent. L'environnement reste le repli, pour une installation
 * qui préfère tout décrire en variables.
 *
 * Non bloquant : toute erreur de lecture → repli sur l'environnement.
 */
export async function loadLocalModel(): Promise<LocalModel | null> {
  const fromEnv = localModel()
  try {
    const res = await pool.query<{
      ai_local_api_url: string | null; ai_local_model: string | null; ai_local_label: string | null
    }>(
      `SELECT ai_local_api_url, ai_local_model, ai_local_label
         FROM platform.platform_settings ORDER BY created_at ASC LIMIT 1`,
    )
    const r = res.rows[0]
    const apiUrl = (r?.ai_local_api_url ?? '').trim()
    if (!apiUrl) return fromEnv
    if (!isUsableModelUrl(apiUrl)) return fromEnv
    return {
      apiUrl,
      // Le nom du modèle est obligatoire côté serveur OpenAI-compatible : à
      // défaut, celui de l'environnement, qui a au moins une valeur par défaut.
      model: (r?.ai_local_model ?? '').trim() || config.aiLocal?.model || 'local',
      apiKey: config.aiLocal?.apiKey ?? null,
      label:  (r?.ai_local_label ?? '').trim() || DEFAULT_LOCAL_LABEL,
    }
  } catch {
    return fromEnv
  }
}

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

/** Fournisseur qui servira réellement le chat. */
export type ChatProvider = 'claude' | 'mistral' | 'local'

/**
 * Choix du fournisseur du chat, en UN seul endroit.
 *
 * `GET /ai/status` et `POST /ai/chat` répondaient chacun avec leur propre copie
 * de cette cascade : le jour où l'une a changé, l'écran a annoncé une IA
 * disponible que la route refusait. La règle vit donc ici, et les deux l'appellent.
 *
 * Ordre : préférence du tenant si sa clé existe → l'autre fournisseur clé en
 * main → le modèle LOCAL en dernier recours → rien.
 */
export function selectChatProvider(creds: AiCreds, local: LocalModel | null): ChatProvider | null {
  if (creds.preferredProvider === 'mistral' && creds.mistral.apiKey) return 'mistral'
  if (creds.preferredProvider === 'claude'  && creds.claude.apiKey)  return 'claude'
  if (creds.mistral.apiKey) return 'mistral'
  if (creds.claude.apiKey)  return 'claude'
  if (local) return 'local'
  return null
}
