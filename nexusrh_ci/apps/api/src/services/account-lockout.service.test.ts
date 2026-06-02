import { describe, it, expect } from 'vitest'
import {
  checkLockout, registerFailure, clearFailures, failKey, lockKey,
  type LockoutStore, type LockoutPolicy,
} from './account-lockout.service.js'

const ON: LockoutPolicy  = { enabled: true,  maxAttempts: 3, windowSeconds: 900, lockSeconds: 900 }
const OFF: LockoutPolicy = { enabled: false, maxAttempts: 3, windowSeconds: 900, lockSeconds: 900 }

// Store en mémoire conforme à LockoutStore (TTL ignoré, suffisant pour la logique).
function memStore(): LockoutStore & { data: Map<string, string>; ttls: Map<string, number> } {
  const data = new Map<string, string>()
  const ttls = new Map<string, number>()
  return {
    data, ttls,
    async incrWithTtl(key, ttlSec) {
      const n = (parseInt(data.get(key) ?? '0', 10) || 0) + 1
      data.set(key, String(n))
      if (n === 1) ttls.set(key, ttlSec)
      return n
    },
    async setWithTtl(key, value, ttlSec) { data.set(key, value); ttls.set(key, ttlSec) },
    async get(key) { return data.get(key) ?? null },
    async ttl(key) { return ttls.get(key) ?? -2 },
    async del(...keys) { for (const k of keys) { data.delete(k); ttls.delete(k) } },
  }
}

// Store qui échoue systématiquement (test du fail-open).
const throwingStore: LockoutStore = {
  incrWithTtl: async () => { throw new Error('redis down') },
  setWithTtl:  async () => { throw new Error('redis down') },
  get:         async () => { throw new Error('redis down') },
  ttl:         async () => { throw new Error('redis down') },
  del:         async () => { throw new Error('redis down') },
}

describe('clés de verrouillage — normalisation email', () => {
  it('minuscule + trim, préfixes distincts', () => {
    expect(failKey('  Admin@Sotra.CI ')).toBe('lockout:fail:admin@sotra.ci')
    expect(lockKey('Admin@Sotra.CI')).toBe('lockout:until:admin@sotra.ci')
  })
})

describe('checkLockout (OWASP A07)', () => {
  it('politique désactivée → jamais verrouillé', async () => {
    expect(await checkLockout(memStore(), 'a@b.ci', OFF)).toEqual({ locked: false, retryAfterSec: 0 })
  })
  it('maxAttempts <= 0 → désactivé', async () => {
    const r = await checkLockout(memStore(), 'a@b.ci', { ...ON, maxAttempts: 0 })
    expect(r.locked).toBe(false)
  })
  it('aucun verrou posé → non verrouillé', async () => {
    expect(await checkLockout(memStore(), 'a@b.ci', ON)).toEqual({ locked: false, retryAfterSec: 0 })
  })
  it('verrou présent → verrouillé avec retryAfterSec = ttl', async () => {
    const s = memStore()
    await s.setWithTtl(lockKey('a@b.ci'), '1', 600)
    expect(await checkLockout(s, 'a@b.ci', ON)).toEqual({ locked: true, retryAfterSec: 600 })
  })
  it('verrou présent sans ttl (-1/-2) → retryAfterSec = lockSeconds (repli)', async () => {
    const s = memStore()
    s.data.set(lockKey('a@b.ci'), '1') // pas de ttl enregistré → ttl() renvoie -2
    expect(await checkLockout(s, 'a@b.ci', ON)).toEqual({ locked: true, retryAfterSec: ON.lockSeconds })
  })
  it('store en erreur → fail-open (non verrouillé)', async () => {
    expect(await checkLockout(throwingStore, 'a@b.ci', ON)).toEqual({ locked: false, retryAfterSec: 0 })
  })
})

describe('registerFailure (OWASP A07)', () => {
  it('politique désactivée → ne compte rien', async () => {
    const s = memStore()
    expect(await registerFailure(s, 'a@b.ci', OFF)).toEqual({ locked: false, attempts: 0, retryAfterSec: 0 })
    expect(s.data.size).toBe(0)
  })
  it('sous le seuil → incrémente sans verrouiller, pose le TTL au 1er échec', async () => {
    const s = memStore()
    const r1 = await registerFailure(s, 'a@b.ci', ON)
    expect(r1).toEqual({ locked: false, attempts: 1, retryAfterSec: 0 })
    expect(s.ttls.get(failKey('a@b.ci'))).toBe(ON.windowSeconds)
    const r2 = await registerFailure(s, 'a@b.ci', ON)
    expect(r2.attempts).toBe(2)
    expect(r2.locked).toBe(false)
  })
  it('au seuil → verrouille, pose le verrou et purge le compteur', async () => {
    const s = memStore()
    await registerFailure(s, 'a@b.ci', ON)
    await registerFailure(s, 'a@b.ci', ON)
    const r3 = await registerFailure(s, 'a@b.ci', ON) // 3e = maxAttempts
    expect(r3).toEqual({ locked: true, attempts: 3, retryAfterSec: ON.lockSeconds })
    expect(s.data.get(lockKey('a@b.ci'))).toBe('1')
    expect(s.data.get(failKey('a@b.ci'))).toBeUndefined() // compteur purgé
  })
  it('store en erreur → fail-open (ne verrouille pas)', async () => {
    expect(await registerFailure(throwingStore, 'a@b.ci', ON)).toEqual({ locked: false, attempts: 0, retryAfterSec: 0 })
  })
})

describe('clearFailures (OWASP A07)', () => {
  it('supprime compteur ET verrou', async () => {
    const s = memStore()
    await registerFailure(s, 'a@b.ci', ON)
    await s.setWithTtl(lockKey('a@b.ci'), '1', 600)
    await clearFailures(s, 'a@b.ci')
    expect(s.data.get(failKey('a@b.ci'))).toBeUndefined()
    expect(s.data.get(lockKey('a@b.ci'))).toBeUndefined()
  })
  it('store en erreur → ne lève pas', async () => {
    await expect(clearFailures(throwingStore, 'a@b.ci')).resolves.toBeUndefined()
  })
})
