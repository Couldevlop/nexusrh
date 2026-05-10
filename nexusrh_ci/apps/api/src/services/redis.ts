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
