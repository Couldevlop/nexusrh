/**
 * Verrouillage de compte après N tentatives de connexion échouées
 * (OWASP A07 — protection brute-force / credential-stuffing, en complément du
 * rate-limiting par IP).
 *
 * Conception :
 *   - Compteurs éphémères en Redis (clé par email), pas de colonnes DB → aucune
 *     migration ni décalage des séquences de tests pg.
 *   - Logique PURE via un `LockoutStore` injecté → couverte à 100% par golden
 *     tests avec un store en mémoire.
 *   - FAIL-OPEN : Redis indisponible ne doit jamais empêcher une connexion
 *     légitime (on ne verrouille pas si le store échoue). Le rate-limiting IP
 *     reste la défense de secours.
 *
 * Compromis anti-énumération : un compte verrouillé renvoie un message distinct
 * (« compte temporairement verrouillé »), ce qui révèle l'existence de l'email.
 * Acceptable ici : déclencher le verrou exige déjà de connaître l'email, le
 * rate-limiting IP borne le sondage, et l'UX claire prime (l'utilisateur
 * légitime comprend pourquoi son mot de passe correct est refusé).
 */

export interface LockoutStore {
  /** INCR la clé et garantit un TTL (posé au 1er incrément). Retourne le compteur. */
  incrWithTtl(key: string, ttlSec: number): Promise<number>
  /** Pose une valeur avec TTL (le verrou lui-même). */
  setWithTtl(key: string, value: string, ttlSec: number): Promise<void>
  /** Lit une valeur (ou null si absente). */
  get(key: string): Promise<string | null>
  /** TTL restant en secondes (-2 = clé absente, -1 = pas d'expiration). */
  ttl(key: string): Promise<number>
  /** Supprime une ou plusieurs clés. */
  del(...keys: string[]): Promise<void>
}

export interface LockoutPolicy {
  enabled: boolean
  /** Seuil d'échecs déclenchant le verrou (<= 0 → désactivé). */
  maxAttempts: number
  /** Fenêtre de comptage des échecs (secondes). */
  windowSeconds: number
  /** Durée du verrou une fois le seuil atteint (secondes). */
  lockSeconds: number
}

const FAIL_PREFIX = 'lockout:fail:'
const LOCK_PREFIX = 'lockout:until:'

function norm(email: string): string {
  return email.trim().toLowerCase()
}
export function failKey(email: string): string { return `${FAIL_PREFIX}${norm(email)}` }
export function lockKey(email: string): string { return `${LOCK_PREFIX}${norm(email)}` }

function disabled(policy: LockoutPolicy): boolean {
  return !policy.enabled || policy.maxAttempts <= 0
}

/**
 * Le compte est-il actuellement verrouillé ? `retryAfterSec` = délai avant
 * nouvelle tentative. Fail-open (jamais d'exception → jamais verrouillé sur erreur).
 */
export async function checkLockout(
  store: LockoutStore, email: string, policy: LockoutPolicy,
): Promise<{ locked: boolean; retryAfterSec: number }> {
  if (disabled(policy)) return { locked: false, retryAfterSec: 0 }
  try {
    const v = await store.get(lockKey(email))
    if (v === null) return { locked: false, retryAfterSec: 0 }
    const ttl = await store.ttl(lockKey(email))
    return { locked: true, retryAfterSec: ttl > 0 ? ttl : policy.lockSeconds }
  } catch {
    return { locked: false, retryAfterSec: 0 }
  }
}

/**
 * Enregistre un échec de connexion. Pose le verrou si le seuil est atteint
 * (et purge le compteur). Fail-open.
 */
export async function registerFailure(
  store: LockoutStore, email: string, policy: LockoutPolicy,
): Promise<{ locked: boolean; attempts: number; retryAfterSec: number }> {
  if (disabled(policy)) return { locked: false, attempts: 0, retryAfterSec: 0 }
  try {
    const attempts = await store.incrWithTtl(failKey(email), policy.windowSeconds)
    if (attempts >= policy.maxAttempts) {
      await store.setWithTtl(lockKey(email), '1', policy.lockSeconds)
      await store.del(failKey(email))
      return { locked: true, attempts, retryAfterSec: policy.lockSeconds }
    }
    return { locked: false, attempts, retryAfterSec: 0 }
  } catch {
    return { locked: false, attempts: 0, retryAfterSec: 0 }
  }
}

/** Réinitialise compteur + verrou après une connexion réussie. Fail-open. */
export async function clearFailures(store: LockoutStore, email: string): Promise<void> {
  try {
    await store.del(failKey(email), lockKey(email))
  } catch {
    /* Redis indisponible : non bloquant */
  }
}
