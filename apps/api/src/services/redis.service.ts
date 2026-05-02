import { createClient, type RedisClientType } from 'redis'
import { config } from '../config'
import { logger } from '../utils/logger'

// Explicit type annotation avoids TS2742 (inferred type too deep to be portable)
type RedisClient = RedisClientType<any, any, any>

let redisClient: RedisClient | null = null

export function getRedisClient(): RedisClient {
  if (!redisClient) {
    redisClient = createClient({ url: config.redis.url }) as RedisClient

    redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis client error')
    })

    redisClient.on('connect', () => {
      logger.info('Redis connecté')
    })

    redisClient.on('reconnecting', () => {
      logger.warn('Redis reconnexion...')
    })
  }
  return redisClient
}

export async function connectRedis(): Promise<void> {
  const client = getRedisClient()
  if (!client.isOpen) {
    await client.connect()
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit()
    redisClient = null
  }
}

export async function setCache<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  const client = getRedisClient()
  const serialized = JSON.stringify(value)
  if (ttlSeconds) {
    await client.setEx(key, ttlSeconds, serialized)
  } else {
    await client.set(key, serialized)
  }
}

export async function getCache<T>(key: string): Promise<T | null> {
  const client = getRedisClient()
  const value = await client.get(key)
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export async function deleteCache(key: string): Promise<void> {
  const client = getRedisClient()
  await client.del(key)
}

export async function deleteCachePattern(pattern: string): Promise<void> {
  const client = getRedisClient()
  const keys = await client.keys(pattern)
  if (keys.length > 0) {
    await client.del(keys)
  }
}

export async function publishEvent(channel: string, data: unknown): Promise<void> {
  const client = getRedisClient()
  await client.publish(channel, JSON.stringify(data))
}
