import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveSafeOutboundResult } from '../../services/ssrf-guard.js'
import { fetchDevicePunches } from './attendance.fetch.js'
import type { FieldMapping } from './attendance.types.js'

vi.mock('../../services/ssrf-guard.js', () => ({
  resolveSafeOutboundResult: vi.fn(),
}))

const mockedResolve = vi.mocked(resolveSafeOutboundResult)

// Résolution « sûre » simulée : renvoie l'URL demandée + un dispatcher épinglé
// factice (dont `close()` est appelé en finally par le code sous test).
const okResolve = async (raw: string) => ({
  ok: true as const,
  value: {
    url: new URL(raw),
    ip: '93.184.216.34',
    family: 4,
    dispatcher: { close: vi.fn().mockResolvedValue(undefined) } as never,
  },
})

const mapping: FieldMapping = {
  recordsPath: 'records',
  employeePath: 'badge',
  employeeMatchBy: 'badge_id',
  timestampPath: 'ts',
  timestampFormat: 'iso8601',
  directionPath: 'dir',
  directionInValue: 'IN',
  directionOutValue: 'OUT',
}

function baseDevice(overrides: Partial<Parameters<typeof fetchDevicePunches>[0]> = {}) {
  return {
    baseUrl: 'https://badge.example.com/api/punches',
    authType: 'none',
    authSecret: null,
    authHeaderName: null,
    defaultHeaders: {},
    fieldMapping: mapping,
    syncCursor: null,
    ...overrides,
  }
}

describe('fetchDevicePunches', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    global.fetch = vi.fn()
  })

  it('(a) refuse une URL SSRF-dangereuse sans jamais appeler fetch', async () => {
    mockedResolve.mockResolvedValue({ ok: false, reason: 'Adresse IP privée/interne interdite' })

    const result = await fetchDevicePunches(baseDevice({ baseUrl: 'http://10.0.0.1/punches' }))

    expect(result.ok).toBe(false)
    expect(result.punches).toEqual([])
    expect(result.error).toBe('Adresse IP privée/interne interdite')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('(b) appelle fetch et mappe les pointages sur une réponse OK', async () => {
    mockedResolve.mockImplementation(okResolve)
    const body = {
      records: [
        { badge: 'B001', ts: '2026-07-15T08:00:00.000Z', dir: 'IN' },
        { badge: 'B002', ts: '2026-07-15T08:05:00.000Z', dir: 'OUT' },
      ],
    }
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    }) as unknown as typeof fetch

    const result = await fetchDevicePunches(baseDevice())

    expect(result.ok).toBe(true)
    expect(result.punches).toHaveLength(2)
    expect(result.punches[0]?.rawEmployeeRef).toBe('B001')
    expect(result.punches[1]?.direction).toBe('out')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('(c) renvoie ok:false + error quand fetch rejette (réseau/timeout)', async () => {
    mockedResolve.mockImplementation(okResolve)
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed: timeout')) as unknown as typeof fetch

    const result = await fetchDevicePunches(baseDevice())

    expect(result.ok).toBe(false)
    expect(result.punches).toEqual([])
    expect(result.error).toContain('timeout')
  })

  it('(d) renvoie ok:false sur un statut HTTP non-2xx', async () => {
    mockedResolve.mockImplementation(okResolve)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof fetch

    const result = await fetchDevicePunches(baseDevice())

    expect(result.ok).toBe(false)
    expect(result.punches).toEqual([])
    expect(result.error).toBe('HTTP 503')
  })

  it('construit l\'en-tête Authorization Bearer quand authType=bearer', async () => {
    mockedResolve.mockImplementation(okResolve)
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch

    await fetchDevicePunches(baseDevice({ authType: 'bearer', authSecret: 'sekrit-token' }))

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    if (!callArgs) throw new Error('fetch non appelé')
    const init = callArgs[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sekrit-token')
    // Anti DNS-rebinding : la connexion badgeuse est épinglée (dispatcher undici).
    expect((init as { dispatcher?: unknown }).dispatcher).toBeDefined()
  })

  it('construit l\'en-tête api_key personnalisé quand authType=api_key', async () => {
    mockedResolve.mockImplementation(okResolve)
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch

    await fetchDevicePunches(baseDevice({ authType: 'api_key', authSecret: 'my-api-key', authHeaderName: 'X-Device-Key' }))

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    if (!callArgs) throw new Error('fetch non appelé')
    const init = callArgs[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Device-Key']).toBe('my-api-key')
  })

  it('filtre les pointages par syncCursor (garde seulement les postérieurs)', async () => {
    mockedResolve.mockImplementation(okResolve)
    const body = {
      records: [
        { badge: 'B001', ts: '2026-07-15T08:00:00.000Z', dir: 'IN' },
        { badge: 'B002', ts: '2026-07-15T09:00:00.000Z', dir: 'IN' },
      ],
    }
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }) as unknown as typeof fetch

    const result = await fetchDevicePunches(baseDevice({ syncCursor: '2026-07-15T08:00:00.000Z' }))

    expect(result.ok).toBe(true)
    expect(result.punches).toHaveLength(1)
    expect(result.punches[0]?.rawEmployeeRef).toBe('B002')
  })

  it('ne fuite jamais le secret dans le message d\'erreur', async () => {
    mockedResolve.mockImplementation(okResolve)
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch

    const result = await fetchDevicePunches(baseDevice({ authType: 'bearer', authSecret: 'top-secret-value' }))

    expect(result.error).not.toContain('top-secret-value')
  })

  it('construit l\'en-tête Authorization Basic avec le secret base64-encodé', async () => {
    mockedResolve.mockImplementation(okResolve)
    const body = {
      records: [
        { badge: 'B001', ts: '2026-07-15T08:00:00.000Z', dir: 'IN' },
      ],
    }
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }) as unknown as typeof fetch

    await fetchDevicePunches(baseDevice({ authType: 'basic', authSecret: 'dXNlcjpwYXNz' }))

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    if (!callArgs) throw new Error('fetch non appelé')
    const init = callArgs[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Basic dXNlcjpwYXNz')
  })

  it('ne fuite jamais le secret sur toutes les branches d\'échec', async () => {
    const secretToken = 'SUPER_SECRET_TOKEN'

    // Branche 1 : SSRF bloqué
    mockedResolve.mockResolvedValueOnce({ ok: false, reason: 'Blocked' })
    let result = await fetchDevicePunches(baseDevice({ authType: 'bearer', authSecret: secretToken }))
    expect(JSON.stringify(result)).not.toContain(secretToken)

    // Branche 2 : fetch rejeté (réseau/timeout)
    mockedResolve.mockImplementationOnce(okResolve)
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('network timeout'))
    result = await fetchDevicePunches(baseDevice({ authType: 'bearer', authSecret: secretToken }))
    expect(JSON.stringify(result)).not.toContain(secretToken)

    // Branche 3 : statut HTTP non-2xx
    mockedResolve.mockImplementationOnce(okResolve)
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as unknown as typeof fetch
    result = await fetchDevicePunches(baseDevice({ authType: 'bearer', authSecret: secretToken }))
    expect(JSON.stringify(result)).not.toContain(secretToken)

    // Branche 4 : réponse JSON invalide
    mockedResolve.mockImplementationOnce(okResolve)
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Invalid JSON')
      },
    }) as unknown as typeof fetch
    result = await fetchDevicePunches(baseDevice({ authType: 'bearer', authSecret: secretToken }))
    expect(JSON.stringify(result)).not.toContain(secretToken)
  })

  // ── OWASP A10-3 — lecture bornée du corps de réponse ─────────────────────
  it('(i) abandonne (sans OOM) une badgeuse qui streame un corps géant', async () => {
    mockedResolve.mockImplementation(okResolve)
    const cancel = vi.fn()
    let pulls = 0
    // Cible hostile : flux quasi infini de 64 Ko par morceau.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(64_000).fill(0x61)) },
      cancel() { cancel() },
    })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body, headers: { get: () => null } }) as unknown as typeof fetch

    const result = await fetchDevicePunches(baseDevice())

    expect(result.ok).toBe(false)
    expect(result.punches).toEqual([])
    expect(result.error).toBe('Réponse badgeuse trop volumineuse — abandon')
    // Le flux a été ANNULÉ, pas drainé : moins de 5 Mo + une marge de morceaux.
    expect(cancel).toHaveBeenCalled()
    expect(pulls).toBeLessThanOrEqual(5_000_000 / 64_000 + 5)
  })

  it('(j) rejette sans rien lire un Content-Length déjà au-dessus du cap', async () => {
    mockedResolve.mockImplementation(okResolve)
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64_000)) },
      cancel() { cancel() },
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, body,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? '900000000' : null) },
    }) as unknown as typeof fetch

    const result = await fetchDevicePunches(baseDevice())

    expect(result.ok).toBe(false)
    expect(result.error).toBe('Réponse badgeuse trop volumineuse — abandon')
    // Aucun reader n'a été acquis (`locked === false`) : le corps n'a jamais
    // été lu, et le flux a été annulé pour libérer le socket.
    expect(body.locked).toBe(false)
    expect(cancel).toHaveBeenCalled()
  })

  it('(k) lit normalement un corps en flux sous le cap', async () => {
    mockedResolve.mockImplementation(okResolve)
    const payload = JSON.stringify({ records: [{ badge: 'B009', ts: '2026-07-15T09:00:00.000Z', dir: 'IN' }] })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close() },
    })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body, headers: { get: () => null } }) as unknown as typeof fetch

    const result = await fetchDevicePunches(baseDevice())

    expect(result.ok).toBe(true)
    expect(result.punches).toHaveLength(1)
    expect(result.punches[0]?.rawEmployeeRef).toBe('B009')
  })
})
