import { Redis } from 'ioredis'
import { config } from '../config.js'

export const redis = new Redis(config.redis.url, { lazyConnect: true, maxRetriesPerRequest: 3 })

const TOKEN_BLACKLIST_PREFIX = 'bl:jwt:'

export async function blacklistToken(jti: string, ttlSeconds: number): Promise<void> {
  await redis.set(`${TOKEN_BLACKLIST_PREFIX}${jti}`, '1', 'EX', ttlSeconds)
}

export async function isTokenBlacklisted(jti: string): Promise<boolean> {
  try {
    const val = await redis.get(`${TOKEN_BLACKLIST_PREFIX}${jti}`)
    return val !== null
  } catch {
    return false // Redis indisponible → on laisse passer (fail open)
  }
}

export async function blacklistTokenSafe(jti: string, ttlSeconds: number): Promise<void> {
  try { await blacklistToken(jti, ttlSeconds) } catch { /* Redis indisponible */ }
}

// ── Anti-rejeu TOTP (OWASP A07) ───────────────────────────────────────────────
// Un code TOTP ne doit être accepté qu'UNE fois : on mémorise le dernier
// « timestep » consommé par utilisateur et on refuse tout step <= au dernier.
// TTL court (le temps que la fenêtre TOTP expire). Fail-open si Redis indisponible
// (cohérent avec le lockout) : la fenêtre de rejeu reste de ~90 s au pire.
const TOTP_STEP_PREFIX = 'mfa:totpstep:'

/**
 * Tente d'« épuiser » un timestep TOTP. Retourne true si le step est nouveau
 * (donc acceptable), false s'il a déjà été consommé (rejeu).
 */
export async function consumeTotpStep(
  schema: string, userId: string, step: number, ttlSeconds = 180,
): Promise<boolean> {
  const key = `${TOTP_STEP_PREFIX}${schema}:${userId}`
  try {
    const last = await redis.get(key)
    if (last !== null && Number(last) >= step) return false // rejeu
    await redis.set(key, String(step), 'EX', ttlSeconds)
    return true
  } catch {
    return true // Redis indisponible → fail-open
  }
}

// ── Époque d'invalidation de session par utilisateur (OWASP A01/A02) ─────────
// Un changement de privilège (rôle, désactivation) ou de mot de passe doit
// invalider IMMÉDIATEMENT tout JWT déjà émis pour cet utilisateur — sans
// bloquer le nouveau token qui vient d'être émis pour le remplacer (ce que
// ferait blacklistTokenSafe, qui blackliste par `sub` : impossible ici, aucun
// jti n'est jamais miné). On mémorise à la place une « époque » (epoch-seconds)
// par utilisateur : tout token dont le `iat` est ANTÉRIEUR à cette époque est
// rejeté au choke point verifyAndCheckBlacklist (plugins/auth.ts) ; un token
// émis APRÈS (nouveau login/refresh) a un iat >= epoch et reste valide.
// TTL généreux (8 jours, > durée de vie JWT 7 jours) pour couvrir tout token
// déjà en circulation au moment de l'événement. Fail-open sur erreur Redis
// (cohérent avec la posture du reste du module).
const TOKEN_EPOCH_PREFIX = 'token_epoch:'
const TOKEN_EPOCH_TTL_SECONDS = 8 * 24 * 60 * 60 // 8 jours

export async function setTokenEpoch(userId: string): Promise<void> {
  try {
    await redis.set(`${TOKEN_EPOCH_PREFIX}${userId}`, String(Math.floor(Date.now() / 1000)), 'EX', TOKEN_EPOCH_TTL_SECONDS)
  } catch {
    // Redis indisponible → fail-open (pas d'invalidation rétroactive)
  }
}

export async function getTokenEpoch(userId: string): Promise<number> {
  try {
    const val = await redis.get(`${TOKEN_EPOCH_PREFIX}${userId}`)
    return val !== null ? Number(val) : 0
  } catch {
    return 0 // Redis indisponible → fail-open (aucun token rejeté)
  }
}

// OWASP A07 — store Redis pour le verrouillage de compte (brute-force).
// Implémente l'interface LockoutStore de account-lockout.service (logique pure).
import type { LockoutStore } from './account-lockout.service.js'

export const redisLockoutStore: LockoutStore = {
  async incrWithTtl(key: string, ttlSec: number): Promise<number> {
    const n = await redis.incr(key)
    // Pose le TTL uniquement au 1er incrément (fenêtre glissante depuis le 1er échec)
    if (n === 1) await redis.expire(key, ttlSec)
    return n
  },
  async setWithTtl(key: string, value: string, ttlSec: number): Promise<void> {
    await redis.set(key, value, 'EX', ttlSec)
  },
  async get(key: string): Promise<string | null> {
    return redis.get(key)
  },
  async ttl(key: string): Promise<number> {
    return redis.ttl(key)
  },
  async del(...keys: string[]): Promise<void> {
    if (keys.length) await redis.del(...keys)
  },
}
