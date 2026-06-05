/**
 * Tests de couverture ciblée — offline-status.service.
 *
 * Complète offline-mode.golden.test.ts (qui exerce le câblage routes + le
 * happy-path cache tenant) en couvrant :
 *   - getOfflineMessagePolicy : ligne settings présente / absente / erreur DB
 *   - getTenantOfflineStatus : repli pré-migration (offline_message absente)
 *     puis fail-open (DB totalement indisponible)
 *   - getAgencyOfflineStatus : happy path, repli pré-migration, fail-open, cache
 *
 * Le cache (cache.ts) est invalidé entre les cas (TTL 30 s) pour forcer la
 * relecture DB et exercer chaque branche.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import {
  getOfflineMessagePolicy,
  getTenantOfflineStatus,
  getAgencyOfflineStatus,
  invalidateOfflineStatusCache,
  DEFAULT_OFFLINE_MESSAGE,
} from './offline-status.service.js'
import { offlineStatusCache } from '../cache.js'

function poolOf(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool
}

beforeEach(() => {
  offlineStatusCache.invalidate()
})

// ─── getOfflineMessagePolicy ─────────────────────────────────────────────────
describe('getOfflineMessagePolicy', () => {
  it('ligne settings présente → valeurs lues (trim + required)', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ offline_message_default: '  Maintenance planifiée.  ', offline_message_required: true }],
    })
    const p = await getOfflineMessagePolicy(poolOf(query))
    expect(p.defaultMessage).toBe('Maintenance planifiée.')
    expect(p.required).toBe(true)
  })

  it('offline_message_required = false → message facultatif', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ offline_message_default: null, offline_message_required: false }],
    })
    const p = await getOfflineMessagePolicy(poolOf(query))
    expect(p.defaultMessage).toBe('') // null → ''
    expect(p.required).toBe(false)
  })

  it('aucune ligne settings (plateforme fraîche) → défauts sûrs (obligatoire)', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] })
    const p = await getOfflineMessagePolicy(poolOf(query))
    expect(p.defaultMessage).toBe(DEFAULT_OFFLINE_MESSAGE)
    expect(p.required).toBe(true)
  })

  it('colonnes non migrées (query throw) → défauts sûrs', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('column does not exist'))
    const p = await getOfflineMessagePolicy(poolOf(query))
    expect(p.defaultMessage).toBe(DEFAULT_OFFLINE_MESSAGE)
    expect(p.required).toBe(true)
  })
})

// ─── getTenantOfflineStatus — branches de repli ──────────────────────────────
describe('getTenantOfflineStatus — repli pré-migration et fail-open', () => {
  it('1re requête (avec offline_message) échoue → repli sur le statut seul', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('column "offline_message" does not exist')) // SELECT complet
      .mockResolvedValueOnce({ rows: [{ status: 'suspended' }] })                  // SELECT statut seul
    const s = await getTenantOfflineStatus(poolOf(query), 'tenant_legacy')
    expect(s).toEqual({ offline: true, message: null })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('repli statut seul, tenant actif → offline=false, message null', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('no column'))
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] })
    const s = await getTenantOfflineStatus(poolOf(query), 'tenant_legacy_active')
    expect(s).toEqual({ offline: false, message: null })
  })

  it('les deux requêtes échouent (DB indisponible) → fail-open (pas hors ligne)', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db still down'))
    const s = await getTenantOfflineStatus(poolOf(query), 'tenant_down')
    expect(s).toEqual({ offline: false, message: null })
  })

  it('résultat mis en cache (2e appel ne requête plus la DB)', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ status: 'suspended', offline_message: 'Hors ligne.' }],
    })
    const pool = poolOf(query)
    const s1 = await getTenantOfflineStatus(pool, 'tenant_cache')
    const s2 = await getTenantOfflineStatus(pool, 'tenant_cache')
    expect(s2).toEqual(s1)
    expect(query).toHaveBeenCalledTimes(1)
  })
})

// ─── getAgencyOfflineStatus ──────────────────────────────────────────────────
describe('getAgencyOfflineStatus', () => {
  it('happy path : statut non-active → hors ligne + message', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ status: 'suspended', offline_message: 'Cabinet fermé.' }],
    })
    const s = await getAgencyOfflineStatus(poolOf(query), 'agency-1')
    expect(s).toEqual({ offline: true, message: 'Cabinet fermé.' })
  })

  it('cabinet actif → offline=false', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ status: 'active', offline_message: null }],
    })
    const s = await getAgencyOfflineStatus(poolOf(query), 'agency-active')
    expect(s).toEqual({ offline: false, message: null })
  })

  it('repli pré-migration (offline_message absente) → statut seul', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('column "offline_message" does not exist'))
      .mockResolvedValueOnce({ rows: [{ status: 'suspended' }] })
    const s = await getAgencyOfflineStatus(poolOf(query), 'agency-legacy')
    expect(s).toEqual({ offline: true, message: null })
  })

  it('les deux requêtes échouent → fail-open', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down again'))
    const s = await getAgencyOfflineStatus(poolOf(query), 'agency-down')
    expect(s).toEqual({ offline: false, message: null })
  })

  it('cache : 2e appel servi sans requête DB', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ status: 'suspended', offline_message: 'Fermé.' }],
    })
    const pool = poolOf(query)
    const s1 = await getAgencyOfflineStatus(pool, 'agency-cache')
    const s2 = await getAgencyOfflineStatus(pool, 'agency-cache')
    expect(s2).toEqual(s1)
    expect(query).toHaveBeenCalledTimes(1)
  })
})

// ─── invalidateOfflineStatusCache ────────────────────────────────────────────
describe('invalidateOfflineStatusCache', () => {
  it('purge le cache → la requête DB est rejouée après invalidation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'suspended', offline_message: 'V1.' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', offline_message: null }] })
    const pool = poolOf(query)
    const s1 = await getTenantOfflineStatus(pool, 'tenant_inval')
    expect(s1.offline).toBe(true)
    invalidateOfflineStatusCache()
    const s2 = await getTenantOfflineStatus(pool, 'tenant_inval')
    expect(s2.offline).toBe(false)
    expect(query).toHaveBeenCalledTimes(2)
  })
})
