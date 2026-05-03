import Redis from 'ioredis'

export function createClient() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6380'
  return new Redis(url, { maxRetriesPerRequest: null })
}
