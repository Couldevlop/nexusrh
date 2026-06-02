/**
 * Politique de sécurité plateforme — paramétrable par le super_admin et stockée
 * dans `platform.platform_settings` (une seule ligne). Couvre :
 *   - MFA obligatoire (super_admin / employés tenant) — désactivé par défaut
 *   - Durée de vie du mot de passe (défaut 30 j ; 0 = jamais)
 *   - Historique anti-réutilisation (défaut 5 derniers ; 0 = pas d'historique)
 *   - Vérification de fuite (HaveIBeenPwned) — activée par défaut
 *
 * Toutes les fonctions sont pures (sauf getSecurityPolicy qui lit la BD) afin
 * d'être couvertes à 100 % par des golden tests.
 */
import type { Pool } from 'pg'
import bcrypt from 'bcryptjs'

export interface SecurityPolicy {
  /** super_admin doit avoir activé le MFA pour accéder à la plateforme. */
  mfaRequiredSuperAdmin: boolean
  /** Politique globale : employés tenant doivent activer le MFA. */
  mfaRequiredTenantUsers: boolean
  /** Durée de vie max d'un mot de passe en jours (0 = pas d'expiration). */
  passwordMaxAgeDays: number
  /** Nombre d'anciens mots de passe interdits à la réutilisation (0 = aucun). */
  passwordHistoryCount: number
  /** Vérifier le mot de passe contre les fuites connues (si internet). */
  breachCheckEnabled: boolean
  /** Verrouiller un compte après N échecs de connexion (OWASP A07). */
  lockoutEnabled: boolean
  /** Seuil d'échecs déclenchant le verrou (0 = désactivé). */
  lockoutMaxAttempts: number
  /** Fenêtre de comptage des échecs (minutes). */
  lockoutWindowMinutes: number
  /** Durée du verrou une fois le seuil atteint (minutes). */
  lockoutDurationMinutes: number
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  mfaRequiredSuperAdmin: false,
  mfaRequiredTenantUsers: false,
  passwordMaxAgeDays: 30,
  passwordHistoryCount: 5,
  breachCheckEnabled: true,
  lockoutEnabled: true,
  lockoutMaxAttempts: 5,
  lockoutWindowMinutes: 15,
  lockoutDurationMinutes: 15,
}

// pg renvoie les booleans/ints typés, mais selon le driver/colonne manquante on
// peut recevoir 't'/'f'/'true'/string/undefined — on normalise défensivement.
function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === null || v === undefined) return fallback
  if (typeof v === 'string') return v === 'true' || v === 't' || v === '1'
  if (typeof v === 'number') return v !== 0
  return fallback
}

function toNonNegInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * Mappe une ligne brute `platform_settings` vers une SecurityPolicy complète.
 * Robuste aux colonnes absentes (ancienne table non encore migrée) → défauts.
 */
export function mapSecurityPolicyRow(row: Record<string, unknown> | null | undefined): SecurityPolicy {
  if (!row) return { ...DEFAULT_SECURITY_POLICY }
  return {
    mfaRequiredSuperAdmin:  toBool(row['mfa_required_super_admin'],  DEFAULT_SECURITY_POLICY.mfaRequiredSuperAdmin),
    mfaRequiredTenantUsers: toBool(row['mfa_required_tenant_users'], DEFAULT_SECURITY_POLICY.mfaRequiredTenantUsers),
    passwordMaxAgeDays:     toNonNegInt(row['password_max_age_days'], DEFAULT_SECURITY_POLICY.passwordMaxAgeDays),
    passwordHistoryCount:   toNonNegInt(row['password_history_count'], DEFAULT_SECURITY_POLICY.passwordHistoryCount),
    breachCheckEnabled:     toBool(row['breach_check_enabled'],      DEFAULT_SECURITY_POLICY.breachCheckEnabled),
    lockoutEnabled:         toBool(row['lockout_enabled'],          DEFAULT_SECURITY_POLICY.lockoutEnabled),
    lockoutMaxAttempts:     toNonNegInt(row['lockout_max_attempts'], DEFAULT_SECURITY_POLICY.lockoutMaxAttempts),
    lockoutWindowMinutes:   toNonNegInt(row['lockout_window_minutes'], DEFAULT_SECURITY_POLICY.lockoutWindowMinutes),
    lockoutDurationMinutes: toNonNegInt(row['lockout_duration_minutes'], DEFAULT_SECURITY_POLICY.lockoutDurationMinutes),
  }
}

/**
 * Construit la LockoutPolicy (account-lockout.service) à partir de la politique
 * de sécurité. Convertit les minutes en secondes. Si la durée de fenêtre/verrou
 * est nulle, on retombe sur 15 min (évite un TTL de 0 = jamais expirant côté Redis).
 */
export function toLockoutPolicy(policy: SecurityPolicy): {
  enabled: boolean; maxAttempts: number; windowSeconds: number; lockSeconds: number
} {
  const windowMin = policy.lockoutWindowMinutes > 0 ? policy.lockoutWindowMinutes : 15
  const lockMin   = policy.lockoutDurationMinutes > 0 ? policy.lockoutDurationMinutes : 15
  return {
    enabled:       policy.lockoutEnabled,
    maxAttempts:   policy.lockoutMaxAttempts,
    windowSeconds: windowMin * 60,
    lockSeconds:   lockMin * 60,
  }
}

/**
 * Lit la politique de sécurité depuis la BD. Ne lève jamais : si la table ou la
 * ligne n'existe pas encore, retourne les défauts (non bloquant pour le login).
 */
export async function getSecurityPolicy(pool: Pick<Pool, 'query'>): Promise<SecurityPolicy> {
  try {
    const res = await pool.query('SELECT * FROM platform.platform_settings LIMIT 1')
    return mapSecurityPolicyRow(res.rows[0] as Record<string, unknown> | undefined)
  } catch {
    return { ...DEFAULT_SECURITY_POLICY }
  }
}

/**
 * Un mot de passe est-il expiré ?
 *   maxAgeDays <= 0  → jamais (fonction désactivée)
 *   changedAt absent → non (grâce : on ne verrouille pas un compte hérité sans
 *                      `password_changed_at`, la migration backfill = now()).
 */
export function isPasswordExpired(
  changedAt: Date | string | null | undefined,
  maxAgeDays: number,
  now: Date = new Date(),
): boolean {
  if (!maxAgeDays || maxAgeDays <= 0) return false
  if (!changedAt) return false
  const changed = changedAt instanceof Date ? changedAt : new Date(changedAt)
  if (Number.isNaN(changed.getTime())) return false
  const ageMs = now.getTime() - changed.getTime()
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000
}

/**
 * MFA effectif pour un employé tenant : durcissement uniquement.
 * Politique globale OU surcharge tenant=true. Un tenant ne peut pas assouplir.
 */
export function effectiveTenantMfaRequired(
  policy: Pick<SecurityPolicy, 'mfaRequiredTenantUsers'>,
  tenantOverride: boolean | null | undefined,
): boolean {
  return policy.mfaRequiredTenantUsers || tenantOverride === true
}

/**
 * Le mot de passe en clair correspond-il à l'un des hashs d'historique fournis
 * (mots de passe précédents interdits à la réutilisation) ? Compare en bcrypt.
 * Un hash corrompu est ignoré (jamais d'exception).
 */
export async function isPasswordReused(plain: string, historyHashes: Array<string | null | undefined>): Promise<boolean> {
  for (const h of historyHashes) {
    if (!h) continue
    try {
      if (await bcrypt.compare(plain, h)) return true
    } catch {
      /* hash invalide : on ignore cette entrée */
    }
  }
  return false
}
