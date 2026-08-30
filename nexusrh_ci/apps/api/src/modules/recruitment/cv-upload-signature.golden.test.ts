/**
 * Golden — le contrôle de signature de fichier (magic bytes) est CÂBLÉ sur les
 * dépôts de CV, pas seulement écrit et testé unitairement.
 *
 * Régression corrigée : `services/cv-extraction.service.ts` exportait
 * `isMagicByteConsistent` (documenté OWASP A03, couvert par ses propres tests)
 * mais n'était importé NULLE PART — `recruitment.routes.ts` hébergeait une copie
 * locale d'`extractCvText` uniquement. Le dépôt public de CV n'acceptait donc
 * que le MIME DÉCLARÉ par le client : n'importe quel binaire annoncé
 * `application/pdf` était stocké, puis servi à un RH via
 * `GET /recruitment/applications/:id/cv-file` en `Content-Disposition: inline`.
 *
 * Ce test attaque l'endpoint public réel avec un faux PDF et exige un rejet.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'cv-signature-secret-minimum-32-characters!'
  process.env.LOG_LEVEL    = 'silent'
})
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
}))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn(), connect: vi.fn() })),
}))
vi.mock('../../services/redis.js', () => ({
  redis:              { quit: vi.fn(), disconnect: vi.fn() },
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch:      vi.fn().mockResolvedValue(0),
}))

import { buildApp } from '../../app.js'

const BOUNDARY = '----nexusrhCvTest'

/** Construit un corps multipart/form-data avec un fichier `cv` et des champs. */
function multipart(fileBytes: Buffer, mime: string, filename: string): Buffer {
  const fields: Array<[string, string]> = [
    ['first_name', 'Awa'],
    ['last_name', 'Koné'],
    ['email', 'awa.kone@example.ci'],
  ]
  const parts: Buffer[] = []
  for (const [k, v] of fields) {
    parts.push(Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    ))
  }
  parts.push(Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="cv"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`,
  ))
  parts.push(fileBytes)
  parts.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`))
  return Buffer.concat(parts)
}

let app: FastifyInstance
beforeAll(async () => { app = await buildApp(); await app.ready() })
afterAll(async () => { await app?.close() })

const URL = '/recruitment/public/demo-tenant/jobs/11111111-1111-4111-8111-111111111111/apply'
const HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }

describe('Dépôt public de CV — signature de fichier (OWASP A03)', () => {
  it('rejette un exécutable Windows déguisé en PDF', async () => {
    // En-tête MZ d'un .exe, annoncé `application/pdf`.
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(2048)])
    const res = await app.inject({
      method: 'POST', url: URL, headers: HEADERS,
      payload: multipart(exe, 'application/pdf', 'cv.pdf'),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/ne correspond pas au format annoncé/i)
  })

  it('rejette du HTML déguisé en PDF', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>')
    const res = await app.inject({
      method: 'POST', url: URL, headers: HEADERS,
      payload: multipart(html, 'application/pdf', 'cv.pdf'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette une archive ZIP déguisée en document Word (.doc OLE)', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])
    const res = await app.inject({
      method: 'POST', url: URL, headers: HEADERS,
      payload: multipart(zip, 'application/msword', 'cv.doc'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('laisse passer un PDF dont la signature est correcte (pas de faux positif)', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(256)])
    const res = await app.inject({
      method: 'POST', url: URL, headers: HEADERS,
      payload: multipart(pdf, 'application/pdf', 'cv.pdf'),
    })
    // La signature est acceptée : on progresse jusqu'au lookup du tenant, qui
    // n'existe pas avec un pool mocké → 404. Surtout : PAS le 400 de signature.
    expect(res.statusCode).not.toBe(400)
  })
})
