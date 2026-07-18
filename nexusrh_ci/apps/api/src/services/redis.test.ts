import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Faux client ioredis : chaque méthode est un mock que les tests peuvent
 * reprogrammer (mockResolvedValueOnce / mockRejectedValueOnce).
 * vi.hoisted garantit que ces mocks existent avant l'exécution des factories
 * vi.mock (hoistées en tête de module).
 */
const { mockGet, mockSet, mockIncr, mockExpire, mockTtl, mockDel } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockIncr: vi.fn(),
  mockExpire: vi.fn(),
  mockTtl: vi.fn(),
  mockDel: vi.fn(),
}))

vi.mock('../config.js', () => ({
  config: { redis: { url: 'redis://localhost:6380' } },
}))

vi.mock('ioredis', () => {
  class Redis {
    get = mockGet
    set = mockSet
    incr = mockIncr
    expire = mockExpire
    ttl = mockTtl
    del = mockDel
  }
  return { Redis, default: Redis }
})

// Import unique : le module n'a pas d'état dépendant de l'env (seul le client
// est créé à l'import, et il est mocké). On le charge une fois.
import {
  blacklistToken,
  isTokenBlacklisted,
  blacklistTokenSafe,
  redisLockoutStore,
  setTokenEpoch,
  getTokenEpoch,
} from './redis.js'

describe('services/redis — blacklist JWT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blacklistToken pose une clé préfixée avec EX et le TTL fourni', async () => {
    mockSet.mockResolvedValueOnce('OK')
    await blacklistToken('jti-123', 900)
    expect(mockSet).toHaveBeenCalledWith('bl:jwt:jti-123', '1', 'EX', 900)
  })

  it('isTokenBlacklisted retourne true quand la valeur est présente', async () => {
    mockGet.mockResolvedValueOnce('1')
    await expect(isTokenBlacklisted('jti-abc')).resolves.toBe(true)
    expect(mockGet).toHaveBeenCalledWith('bl:jwt:jti-abc')
  })

  it('isTokenBlacklisted retourne false quand la valeur est absente (null)', async () => {
    mockGet.mockResolvedValueOnce(null)
    await expect(isTokenBlacklisted('jti-absent')).resolves.toBe(false)
  })

  it('isTokenBlacklisted fail-open : retourne false si Redis lève une erreur', async () => {
    mockGet.mockRejectedValueOnce(new Error('Redis indisponible'))
    await expect(isTokenBlacklisted('jti-err')).resolves.toBe(false)
  })

  it('blacklistTokenSafe délègue à blacklistToken en cas de succès', async () => {
    mockSet.mockResolvedValueOnce('OK')
    await blacklistTokenSafe('jti-safe', 60)
    expect(mockSet).toHaveBeenCalledWith('bl:jwt:jti-safe', '1', 'EX', 60)
  })

  it('blacklistTokenSafe avale l\'erreur Redis sans rejeter', async () => {
    mockSet.mockRejectedValueOnce(new Error('Redis down'))
    await expect(blacklistTokenSafe('jti-safe-err', 60)).resolves.toBeUndefined()
  })
})

describe('services/redis — époque d\'invalidation de session par utilisateur (OWASP A01/A02)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')) // epoch-seconds = 1767225600
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('setTokenEpoch pose la clé token_epoch:<userId> = epoch-seconds courant avec un TTL ≥ durée de vie max token', async () => {
    mockSet.mockResolvedValueOnce('OK')
    await setTokenEpoch('user-1')
    expect(mockSet).toHaveBeenCalledWith('token_epoch:user-1', '1767225600', 'EX', expect.any(Number))
    const ttl = mockSet.mock.calls[0]?.[3] as number
    expect(ttl).toBeGreaterThanOrEqual(8 * 24 * 60 * 60) // ≥ 8 jours
  })

  it('setTokenEpoch fail-open : n\'échoue pas si Redis lève une erreur', async () => {
    mockSet.mockRejectedValueOnce(new Error('Redis down'))
    await expect(setTokenEpoch('user-1')).resolves.toBeUndefined()
  })

  it('getTokenEpoch renvoie l\'epoch-seconds stocké (nombre)', async () => {
    mockGet.mockResolvedValueOnce('1767225600')
    await expect(getTokenEpoch('user-1')).resolves.toBe(1767225600)
    expect(mockGet).toHaveBeenCalledWith('token_epoch:user-1')
  })

  it('getTokenEpoch renvoie 0 quand aucune époque n\'est enregistrée (utilisateur jamais invalidé)', async () => {
    mockGet.mockResolvedValueOnce(null)
    await expect(getTokenEpoch('user-1')).resolves.toBe(0)
  })

  it('getTokenEpoch fail-open : renvoie 0 si Redis lève une erreur (aucun token rejeté)', async () => {
    mockGet.mockRejectedValueOnce(new Error('Redis down'))
    await expect(getTokenEpoch('user-1')).resolves.toBe(0)
  })
})

describe('services/redis — redisLockoutStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('incrWithTtl pose le TTL au 1er incrément (n === 1)', async () => {
    mockIncr.mockResolvedValueOnce(1)
    mockExpire.mockResolvedValueOnce(1)
    const n = await redisLockoutStore.incrWithTtl('lockout:fail:a@b.c', 300)
    expect(n).toBe(1)
    expect(mockIncr).toHaveBeenCalledWith('lockout:fail:a@b.c')
    expect(mockExpire).toHaveBeenCalledWith('lockout:fail:a@b.c', 300)
  })

  it('incrWithTtl ne repose pas le TTL aux incréments suivants (n > 1)', async () => {
    mockIncr.mockResolvedValueOnce(3)
    const n = await redisLockoutStore.incrWithTtl('lockout:fail:a@b.c', 300)
    expect(n).toBe(3)
    expect(mockExpire).not.toHaveBeenCalled()
  })

  it('setWithTtl pose une valeur avec EX et TTL', async () => {
    mockSet.mockResolvedValueOnce('OK')
    await redisLockoutStore.setWithTtl('lockout:until:a@b.c', '1', 900)
    expect(mockSet).toHaveBeenCalledWith('lockout:until:a@b.c', '1', 'EX', 900)
  })

  it('get délègue au client Redis', async () => {
    mockGet.mockResolvedValueOnce('1')
    await expect(redisLockoutStore.get('lockout:until:a@b.c')).resolves.toBe('1')
    expect(mockGet).toHaveBeenCalledWith('lockout:until:a@b.c')
  })

  it('get retourne null quand la clé est absente', async () => {
    mockGet.mockResolvedValueOnce(null)
    await expect(redisLockoutStore.get('absent')).resolves.toBeNull()
  })

  it('ttl délègue au client Redis', async () => {
    mockTtl.mockResolvedValueOnce(120)
    await expect(redisLockoutStore.ttl('lockout:until:a@b.c')).resolves.toBe(120)
    expect(mockTtl).toHaveBeenCalledWith('lockout:until:a@b.c')
  })

  it('del supprime les clés fournies', async () => {
    mockDel.mockResolvedValueOnce(2)
    await redisLockoutStore.del('lockout:fail:a@b.c', 'lockout:until:a@b.c')
    expect(mockDel).toHaveBeenCalledWith('lockout:fail:a@b.c', 'lockout:until:a@b.c')
  })

  it('del ne fait aucun appel quand aucune clé n\'est fournie', async () => {
    await redisLockoutStore.del()
    expect(mockDel).not.toHaveBeenCalled()
  })

  it('incrWithTtl propage l\'erreur du client (gérée fail-open par l\'appelant)', async () => {
    mockIncr.mockRejectedValueOnce(new Error('Redis down'))
    await expect(redisLockoutStore.incrWithTtl('k', 300)).rejects.toThrow('Redis down')
  })
})
