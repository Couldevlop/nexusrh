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
