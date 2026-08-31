/**
 * Mobile Money — correctif OWASP A10-3 : la réponse d'un opérateur/agrégateur
 * (URL issue d'une config TENANT) est lue de façon BORNÉE. Une cible qui
 * streame plusieurs Go ne peut plus épuiser la mémoire du process API partagé.
 *
 * Fichier séparé du test principal car il mocke `ssrf-guard` (le test principal
 * s'appuie sur le comportement réel de la garde).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }))

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('@nexusrhci/shared/ssrf-guard', () => ({
  resolveSafeOutbound: resolveMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))
vi.mock('../config.js', () => ({
  config: {
    env: 'test',
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
    mobileMoney: {
      wave:   { apiKey: '', apiUrl: 'https://wave.test', webhookSecret: 'w' },
      mtn:    { apiKey: '', apiUrl: 'https://mtn.test', subscriptionKey: 's', env: 'sandbox', webhookSecret: 'm' },
      orange: { apiKey: '', apiUrl: 'https://orange.test', merchantKey: 'o', webhookSecret: 'r' },
    },
  },
}))
vi.mock('@nexusrhci/shared/crypto', () => ({
  decryptIfPresent: (v: string | null | undefined) => (v ? v.replace('enc:', '') : null),
}))

import { initiateTransfer } from './mobile-money-providers.js'

const fetchSpy = vi.fn()

beforeEach(() => {
  queryMock.mockReset()
  resolveMock.mockReset()
  resolveMock.mockImplementation(async (raw: string) => ({
    url: new URL(raw), ip: '93.184.216.34', family: 4,
    dispatcher: { close: vi.fn().mockResolvedValue(undefined) },
  }))
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})

/** Aucun agrégateur, puis config Wave tenant activée avec clé. */
function waveTenantConfig(): void {
  queryMock.mockResolvedValueOnce({ rows: [] }) // resolveAggregator
  queryMock.mockResolvedValueOnce({ rows: [{
    api_key_enc: 'enc:wave-key', api_url: 'https://wave.test', webhook_secret_enc: null,
    subscription_key_enc: null, merchant_key_enc: null, env: null, enabled: true,
  }] })
}

const PAYMENT = { phone: '+2250712345678', amount: 150_000, reference: 'REF-1' }

describe('fetchJson — corps de réponse borné (A10-3)', () => {
  it('opérateur qui streame un corps géant → flux annulé, aucun buffer illimité', async () => {
    waveTenantConfig()
    const cancel = vi.fn()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(64_000).fill(0x61)) },
      cancel() { cancel() },
    })
    fetchSpy.mockResolvedValue({ ok: true, status: 200, body, headers: { get: () => null } })

    const r = await initiateTransfer('tenant_x', 'wave', PAYMENT)

    expect(cancel).toHaveBeenCalled()
    // Cap 5 Mo → au plus ~78 morceaux de 64 Ko lus, jamais le flux entier.
    expect(pulls).toBeLessThanOrEqual(5_000_000 / 64_000 + 5)
    // Corps illisible ⇒ traité comme une réponse vide (aucune exception).
    expect(r.status).toBe('pending')
  })

  it('Content-Length au-dessus du cap → rejeté sans lire le corps', async () => {
    waveTenantConfig()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64_000)) },
    })
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, body,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? '900000000' : null) },
    })

    const r = await initiateTransfer('tenant_x', 'wave', PAYMENT)

    expect(body.locked).toBe(false) // aucun reader acquis → rien n'a été lu
    expect(r.success).toBe(true)
    expect(r.status).toBe('pending')
  })

  it('corps en flux sous le cap → JSON parsé normalement', async () => {
    waveTenantConfig()
    const payload = JSON.stringify({ id: 'WAVE-777', payment_status: 'succeeded' })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close() },
    })
    fetchSpy.mockResolvedValue({ ok: true, status: 200, body, headers: { get: () => null } })

    const r = await initiateTransfer('tenant_x', 'wave', PAYMENT)

    expect(r).toMatchObject({ success: true, status: 'completed', transactionId: 'WAVE-777' })
  })
})
