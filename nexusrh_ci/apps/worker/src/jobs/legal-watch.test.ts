import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

/**
 * Tests du job de veille réglementaire, centrés sur le correctif OWASP A10-3 :
 * le corps de la source distante doit être lu de façon BORNÉE (comptage en
 * flux + annulation), et non bufferisé entièrement avant vérification.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))

import { processLegalWatchJob } from './legal-watch.js'

function jobFor(data: unknown): Job<unknown, void> {
  return { id: 'job-lw-1', data } as unknown as Job<unknown, void>
}

const PAYLOAD = {
  articleId: 'art-1',
  sourceUrl: 'https://droit.example.ci/code-travail/art-1',
  source: 'code_travail',
  countryCode: 'CIV',
}

beforeEach(() => {
  queryMock.mockReset()
  loggerMock.info.mockReset()
  loggerMock.error.mockReset()
  loggerMock.warn.mockReset()
  vi.stubGlobal('fetch', vi.fn())
})

describe('processLegalWatchJob — corps de réponse borné (A10-3)', () => {
  it('source qui streame un corps géant → échec borné, flux annulé, aucune écriture', async () => {
    const cancel = vi.fn()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(64_000).fill(0x61)) },
      cancel() { cancel() },
    })
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, body, headers: { get: () => null },
    })

    await expect(processLegalWatchJob(jobFor(PAYLOAD))).rejects.toThrow(/Body trop grand/)

    expect(cancel).toHaveBeenCalled()
    // MAX_BODY_BYTES = 1 Mo → au plus ~16 morceaux de 64 Ko lus, jamais plus.
    expect(pulls).toBeLessThanOrEqual(1_000_000 / 64_000 + 5)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('Content-Length au-dessus du cap → rejeté sans lire le corps', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64_000)) },
    })
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, body,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? '900000000' : null) },
    })

    await expect(processLegalWatchJob(jobFor(PAYLOAD))).rejects.toThrow(/Body trop grand/)

    expect(body.locked).toBe(false) // aucun reader acquis → rien n'a été lu
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('corps sous le cap et texte inchangé → court-circuit sans proposition', async () => {
    const texte = 'Article 1 — texte inchangé.'
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(texte)); controller.close() },
    })
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, body, headers: { get: () => null },
    })
    queryMock.mockResolvedValueOnce({ rows: [{ texte, checksum_sha256: null }] })

    await expect(processLegalWatchJob(jobFor(PAYLOAD))).resolves.toBeUndefined()

    expect(queryMock).toHaveBeenCalledTimes(1) // lecture seule, aucun INSERT
  })

  it('corps sous le cap et texte modifié → proposition pending insérée', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('Nouveau texte.')); controller.close() },
    })
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, body, headers: { get: () => null },
    })
    queryMock.mockResolvedValueOnce({ rows: [{ texte: 'Ancien texte.', checksum_sha256: null }] })
    queryMock.mockResolvedValueOnce({ rows: [] })                    // pas de doublon pending
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'prop-1' }] })    // INSERT

    await expect(processLegalWatchJob(jobFor(PAYLOAD))).resolves.toBeUndefined()

    expect(String(queryMock.mock.calls[2]![0])).toContain('INSERT INTO droit_ci.article_proposals')
  })

  it('statut HTTP non-2xx → erreur remontée (retry BullMQ), aucune écriture', async () => {
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, status: 503, body: null, headers: { get: () => null },
    })

    await expect(processLegalWatchJob(jobFor(PAYLOAD))).rejects.toThrow('HTTP 503')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('payload invalide → job rejeté proprement, aucun fetch, aucune requête DB', async () => {
    await expect(processLegalWatchJob(jobFor({ sourceUrl: 'file:///etc/passwd' }))).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
    expect(loggerMock.error).toHaveBeenCalled()
  })
})
