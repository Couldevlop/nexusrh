/**
 * Mise hors ligne (tenant / cabinet de recrutement) — service partagé.
 *
 * Le super_admin peut mettre « hors usage » un tenant (et donc ses filiales,
 * qui vivent dans le même schéma) ou un cabinet (et, sur demande, ses tenants
 * clients). Un message est affiché aux utilisateurs bloqués :
 *   - variable système `offline_message_default` (platform_settings), modifiable
 *     dans les paramètres plateforme ;
 *   - surchargée au cas par cas au moment de la suspension (offline_message
 *     stocké sur le tenant / cabinet) ;
 *   - `offline_message_required` (variable système) rend le message obligatoire.
 *
 * Sécurité :
 *   A01 — l'enforcement est fait côté API (hook onRequest + login), pas
 *         seulement côté UI.
 *   A07 — au login, le message hors-ligne n'est révélé QU'APRÈS vérification
 *         du mot de passe (pas de fuite d'existence d'un tenant suspendu).
 *   A09 — les suspensions/réactivations sont auditées par les routes appelantes.
 *
 * Performance : statut mis en cache 30 s par organisation (cf. cache.ts), même
 * approche que le mode maintenance — aucune requête DB supplémentaire par
 * requête API en régime établi.
 */
import type { Pool } from 'pg'
import { offlineStatusCache, type OfflineStatus } from '../cache.js'

export const DEFAULT_OFFLINE_MESSAGE =
  'Ce site est temporairement hors service. Veuillez contacter votre administrateur.'

export interface OfflineMessagePolicy {
  /** Message hors-ligne par défaut (variable système). */
  defaultMessage: string
  /** Si true, la mise hors ligne exige un message (fourni ou défaut non vide). */
  required: boolean
}

/** Charge la politique de message hors-ligne (variable système, singleton). */
export async function getOfflineMessagePolicy(pool: Pool): Promise<OfflineMessagePolicy> {
  try {
    const r = await pool.query<{ offline_message_default: string | null; offline_message_required: boolean | null }>(
      `SELECT offline_message_default, offline_message_required
       FROM platform.platform_settings ORDER BY created_at ASC LIMIT 1`
    )
    const row = r.rows[0]
    // Ligne de settings absente (plateforme fraîche) → défauts sûrs, comme la
    // branche pré-migration : message générique disponible, obligatoire.
    if (!row) return { defaultMessage: DEFAULT_OFFLINE_MESSAGE, required: true }
    // Valeur stockée telle quelle : si le super_admin a vidé la variable système
    // ET que le message est obligatoire, la mise hors ligne sans message est
    // refusée (pas de substitution silencieuse).
    const def = typeof row.offline_message_default === 'string' ? row.offline_message_default.trim() : ''
    return {
      defaultMessage: def,
      required: row.offline_message_required !== false,
    }
  } catch {
    // Colonnes pas encore migrées → défauts sûrs (message présent, obligatoire).
    return { defaultMessage: DEFAULT_OFFLINE_MESSAGE, required: true }
  }
}

/**
 * Résout le message effectif à stocker lors d'une mise hors ligne.
 * @returns le message (borné à 2000 caractères), ou `null` si la politique
 *          exige un message et qu'aucun n'est disponible (ni fourni ni défaut).
 */
export function resolveOfflineMessage(provided: unknown, policy: OfflineMessagePolicy): string | null {
  const msg = typeof provided === 'string' ? provided.trim().slice(0, 2000) : ''
  const effective = msg || policy.defaultMessage
  if (policy.required && !effective) return null
  return effective
}

/** Statut hors-ligne d'un tenant (par schema_name), avec cache 30 s. */
export async function getTenantOfflineStatus(pool: Pool, schemaName: string): Promise<OfflineStatus> {
  const key = `tenant:${schemaName}`
  const cached = offlineStatusCache.get(key)
  if (cached) return cached
  let status: OfflineStatus = { offline: false, message: null }
  try {
    const r = await pool.query<{ status: string; offline_message: string | null }>(
      `SELECT status, offline_message FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
      [schemaName]
    )
    const row = r.rows[0]
    if (row) status = { offline: row.status === 'suspended', message: row.offline_message ?? null }
  } catch {
    // Colonne offline_message absente (pré-migration) → repli sur le statut seul.
    try {
      const r = await pool.query<{ status: string }>(
        `SELECT status FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
        [schemaName]
      )
      const row = r.rows[0]
      if (row) status = { offline: row.status === 'suspended', message: null }
    } catch { /* DB indisponible : ne pas bloquer (fail-open, cohérent maintenance) */ }
  }
  offlineStatusCache.set(key, status)
  return status
}

/** Statut hors-ligne d'un cabinet de recrutement (par id), avec cache 30 s. */
export async function getAgencyOfflineStatus(pool: Pool, agencyId: string): Promise<OfflineStatus> {
  const key = `agency:${agencyId}`
  const cached = offlineStatusCache.get(key)
  if (cached) return cached
  let status: OfflineStatus = { offline: false, message: null }
  try {
    const r = await pool.query<{ status: string; offline_message: string | null }>(
      `SELECT status, offline_message FROM platform.agencies WHERE id = $1 LIMIT 1`,
      [agencyId]
    )
    const row = r.rows[0]
    if (row) status = { offline: row.status !== 'active', message: row.offline_message ?? null }
  } catch {
    try {
      const r = await pool.query<{ status: string }>(
        `SELECT status FROM platform.agencies WHERE id = $1 LIMIT 1`,
        [agencyId]
      )
      const row = r.rows[0]
      if (row) status = { offline: row.status !== 'active', message: null }
    } catch { /* fail-open */ }
  }
  offlineStatusCache.set(key, status)
  return status
}

/** À appeler après toute suspension/réactivation (effet immédiat sur ce pod). */
export function invalidateOfflineStatusCache(): void {
  offlineStatusCache.invalidate()
}
