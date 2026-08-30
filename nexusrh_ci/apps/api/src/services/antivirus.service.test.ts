/**
 * Antivirus des dépôts de fichiers (OWASP A08).
 *
 * Un vrai clamd est lancé en mémoire (serveur TCP factice parlant le protocole
 * INSTREAM) : on teste le client réel, pas un mock de lui-même.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import { parseClamdReply } from './antivirus.service.js'

vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'antivirus-test-secret-minimum-32-characters'
  process.env.LOG_LEVEL    = 'silent'
})

/** Démarre un faux clamd qui répond `reply` après réception du flux. */
async function fakeClamd(reply: string | null, opts: { delayMs?: number } = {}): Promise<{ port: number; close: () => Promise<void>; received: () => Buffer }> {
  let received = Buffer.alloc(0)
  const server: Server = createServer((sock) => {
    sock.on('data', (d) => {
      received = Buffer.concat([received, d])
      // Fin de flux INSTREAM = bloc de longueur nulle en fin de trame.
      const tail = received.subarray(-4)
      if (tail.length === 4 && tail.readUInt32BE(0) === 0) {
        if (reply === null) return           // ne répond jamais → timeout
        setTimeout(() => { sock.write(reply); sock.end() }, opts.delayMs ?? 0)
      }
    })
    sock.on('error', () => { /* connexion coupée par le client : normal */ })
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as { port: number }).port
  return {
    port,
    received: () => received,
    close: () => new Promise<void>((res) => { server.close(() => res()) }),
  }
}

/** Recharge le service avec une config d'antivirus donnée. */
async function loadService(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return import('./antivirus.service.js')
}

beforeEach(() => {
  delete process.env.CLAMAV_HOST
  delete process.env.CLAMAV_PORT
  delete process.env.CLAMAV_TIMEOUT_MS
})

describe('parseClamdReply', () => {
  it('reconnaît un fichier propre', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ clean: true, scanned: true })
  })

  it('reconnaît une détection et en extrait la signature', () => {
    const r = parseClamdReply('stream: Eicar-Test-Signature FOUND\0')
    expect(r.clean).toBe(false)
    expect(r.signature).toBe('Eicar-Test-Signature')
  })

  it('traite une réponse inattendue comme un échec, jamais comme un succès', () => {
    expect(parseClamdReply('ERROR: size limit exceeded\0').clean).toBe(false)
    expect(parseClamdReply('').clean).toBe(false)
  })
})

describe('scanBuffer — antivirus désactivé (défaut)', () => {
  it('laisse passer sans analyser : aucun changement de comportement', async () => {
    const { scanBuffer, isAntivirusEnabled } = await loadService({ CLAMAV_HOST: undefined })
    expect(isAntivirusEnabled()).toBe(false)
    expect(await scanBuffer(Buffer.from('nimporte quoi'))).toEqual({ clean: true, scanned: false })
  })
})

describe('scanBuffer — antivirus activé', () => {
  it('accepte un fichier déclaré propre', async () => {
    const clamd = await fakeClamd('stream: OK\0')
    try {
      const { scanBuffer } = await loadService({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port) })
      const r = await scanBuffer(Buffer.from('%PDF-1.7 contenu honnête'))
      expect(r).toEqual({ clean: true, scanned: true })
      // Le protocole INSTREAM a bien été parlé.
      expect(clamd.received().subarray(0, 10).toString()).toBe('zINSTREAM\0')
    } finally { await clamd.close() }
  })

  it('refuse un fichier détecté comme malveillant', async () => {
    const clamd = await fakeClamd('stream: Win.Test.EICAR_HDB-1 FOUND\0')
    try {
      const { scanBuffer, scanRejectionMessage } = await loadService({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port) })
      const r = await scanBuffer(Buffer.from('X5O!P%@AP'))
      expect(r.clean).toBe(false)
      expect(r.signature).toBe('Win.Test.EICAR_HDB-1')
      // Le message rendu à l'utilisateur ne divulgue pas la signature (A09).
      expect(scanRejectionMessage(r)).not.toContain('EICAR')
    } finally { await clamd.close() }
  })

  it('ÉCHOUE FERMÉ si l’antivirus est injoignable', async () => {
    // Port fermé : aucune analyse possible → le dépôt doit être refusé, pas accepté.
    const { scanBuffer } = await loadService({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1' })
    const r = await scanBuffer(Buffer.from('contenu'))
    expect(r.clean).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('ÉCHOUE FERMÉ au dépassement du délai', async () => {
    const clamd = await fakeClamd(null)   // ne répond jamais
    try {
      const { scanBuffer } = await loadService({
        CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port), CLAMAV_TIMEOUT_MS: '150',
      })
      const r = await scanBuffer(Buffer.from('contenu'))
      expect(r.clean).toBe(false)
      expect(r.error).toMatch(/délai dépassé/)
    } finally { await clamd.close() }
  })

  it('découpe correctement les fichiers dépassant la taille de bloc', async () => {
    const clamd = await fakeClamd('stream: OK\0')
    try {
      const { scanBuffer } = await loadService({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port) })
      const big = Buffer.alloc(200 * 1024, 0x41)     // 200 Ko > chunkSize (64 Ko)
      expect((await scanBuffer(big)).clean).toBe(true)
      // en-tête + 4 blocs (64+64+64+8 Ko) × 4 octets de longueur + terminateur
      expect(clamd.received().length).toBe(10 + big.length + 4 * 4 + 4)
    } finally { await clamd.close() }
  })
})
