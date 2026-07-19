import { describe, it, expect, vi } from 'vitest'
import {
  readBodyCapped,
  readJsonCapped,
  BodyTooLargeError,
  DEFAULT_MAX_BODY_BYTES,
  type CappedReadable,
} from './http-body-limit.js'

/**
 * Fabrique une réponse dont le corps est un flux web émettant `chunkCount`
 * morceaux de `chunkSize` octets. `onCancel` permet de vérifier que le flux est
 * bien ANNULÉ dès le dépassement du cap (et non lu jusqu'au bout).
 */
function streamResponse(opts: {
  chunks: Uint8Array[]
  contentLength?: string | null
  onCancel?: () => void
  onPull?: (index: number) => void
}): CappedReadable {
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      opts.onPull?.(i)
      if (i >= opts.chunks.length) { controller.close(); return }
      controller.enqueue(opts.chunks[i]!)
      i += 1
    },
    cancel() { opts.onCancel?.() },
  })
  return {
    body: stream,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? (opts.contentLength ?? null) : null) },
  }
}

function bytes(n: number, fill = 0x61): Uint8Array {
  return new Uint8Array(n).fill(fill)
}

describe('readBodyCapped', () => {
  it('lit intégralement un corps sous le cap', async () => {
    const res = streamResponse({ chunks: [new TextEncoder().encode('{"a":'), new TextEncoder().encode('1}')] })
    await expect(readBodyCapped(res, 1000)).resolves.toBe('{"a":1}')
  })

  it('assemble correctement un multi-octets UTF-8 réparti sur plusieurs chunks', async () => {
    const full = new TextEncoder().encode('éàü')
    const res = streamResponse({ chunks: [full.slice(0, 3), full.slice(3)] })
    await expect(readBodyCapped(res, 1000)).resolves.toBe('éàü')
  })

  it('lève BodyTooLargeError ET annule le flux dès le dépassement du cap', async () => {
    const onCancel = vi.fn()
    const pulled: number[] = []
    // Cible « hostile » : 10 000 morceaux de 100 octets (~1 Mo) pour un cap de
    // 150 octets. Le point du correctif est là : on ne doit JAMAIS drainer.
    const res = streamResponse({
      chunks: Array.from({ length: 10_000 }, () => bytes(100)),
      onCancel,
      onPull: i => { pulled.push(i) },
    })
    await expect(readBodyCapped(res, 150)).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(onCancel).toHaveBeenCalledTimes(1)
    // Le flux n'a PAS été drainé : seuls quelques morceaux ont été tirés.
    expect(pulled.length).toBeLessThanOrEqual(5)
  })

  it('accepte un corps exactement à la taille du cap', async () => {
    const res = streamResponse({ chunks: [bytes(64)] })
    await expect(readBodyCapped(res, 64)).resolves.toHaveLength(64)
  })

  it('rejette SANS LIRE quand Content-Length dépasse déjà le cap', async () => {
    const onCancel = vi.fn()
    const res = streamResponse({ chunks: [bytes(10)], contentLength: String(50_000_000), onCancel })
    await expect(readBodyCapped(res, DEFAULT_MAX_BODY_BYTES)).rejects.toBeInstanceOf(BodyTooLargeError)
    // `locked === false` prouve qu'aucun reader n'a été acquis : rien n'a été lu.
    expect(res.body?.locked).toBe(false)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignore un Content-Length absent ou non numérique et se fie au comptage réel', async () => {
    const res = streamResponse({ chunks: [bytes(10)], contentLength: 'not-a-number' })
    await expect(readBodyCapped(res, 1000)).resolves.toHaveLength(10)
    const menteur = streamResponse({ chunks: [bytes(400)], contentLength: '1' })
    await expect(readBodyCapped(menteur, 100)).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('message d\'erreur générique — ne fuite aucun détail réseau', async () => {
    const err = new BodyTooLargeError(5_000_000)
    expect(err.name).toBe('BodyTooLargeError')
    expect(err.message).toBe('Réponse distante trop volumineuse (limite 5000000 octets)')
    expect(err.maxBytes).toBe(5_000_000)
  })

  it('chemin dégradé (pas de flux web) : lit via text() et applique le même cap', async () => {
    await expect(readBodyCapped({ text: async () => 'ok' }, 100)).resolves.toBe('ok')
    await expect(readBodyCapped({ text: async () => 'x'.repeat(200) }, 100))
      .rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('chemin dégradé : ni flux ni text() → chaîne vide, jamais d\'exception', async () => {
    await expect(readBodyCapped({}, 100)).resolves.toBe('')
  })

  it('chemin dégradé : un text() qui échoue ne propage pas d\'erreur', async () => {
    await expect(readBodyCapped({ text: async () => { throw new Error('socket') } }, 100)).resolves.toBe('')
  })

  it('propage (après annulation) une erreur de flux qui n\'est pas un dépassement', async () => {
    const onCancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      pull() { throw new Error('flux rompu') },
      cancel() { onCancel() },
    })
    await expect(readBodyCapped({ body: stream }, 1000)).rejects.toThrow('flux rompu')
  })

  it('utilise DEFAULT_MAX_BODY_BYTES (5 Mo) quand aucun cap n\'est fourni', async () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(5_000_000)
    const res = streamResponse({ chunks: [bytes(1024)] })
    await expect(readBodyCapped(res)).resolves.toHaveLength(1024)
  })
})

describe('readJsonCapped', () => {
  it('parse un JSON sous le cap', async () => {
    const res = streamResponse({ chunks: [new TextEncoder().encode('{"punches":[1,2]}')] })
    await expect(readJsonCapped(res, 1000)).resolves.toEqual({ punches: [1, 2] })
  })

  it('lève BodyTooLargeError au-delà du cap (JSON jamais parsé)', async () => {
    const res = streamResponse({ chunks: [bytes(500), bytes(500)] })
    await expect(readJsonCapped(res, 100)).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('lève une SyntaxError sur JSON invalide sous le cap', async () => {
    const res = streamResponse({ chunks: [new TextEncoder().encode('{oops')] })
    await expect(readJsonCapped(res, 1000)).rejects.toBeInstanceOf(SyntaxError)
  })

  it('chemin dégradé : utilise json() si aucun flux web, en respectant Content-Length', async () => {
    await expect(readJsonCapped({ json: async () => ({ a: 1 }) }, 1000)).resolves.toEqual({ a: 1 })
    const trop: CappedReadable = {
      json: async () => ({ a: 1 }),
      headers: { get: () => String(9_000_000) },
    }
    await expect(readJsonCapped(trop, 1000)).rejects.toBeInstanceOf(BodyTooLargeError)
  })
})
