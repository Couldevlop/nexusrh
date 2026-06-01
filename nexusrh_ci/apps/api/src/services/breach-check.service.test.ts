import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { isPasswordBreached } from './breach-check.service.js'

afterEach(() => { vi.unstubAllGlobals() })

// Construit une réponse "Pwned Passwords" valide : liste de SUFFIXES:count.
function pwnedBody(lines: string[]): string {
  return lines.join('\r\n')
}

function suffixOf(password: string): { prefix: string; suffix: string } {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()
  return { prefix: sha1.slice(0, 5), suffix: sha1.slice(5) }
}

function okResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response
}

describe('isPasswordBreached — k-anonymat HaveIBeenPwned (OWASP A02 + A10)', () => {
  it('mot de passe vide → null (rien à vérifier)', async () => {
    expect(await isPasswordBreached('')).toBeNull()
  })

  it('fetch indisponible (non-fonction) → null', async () => {
    const r = await isPasswordBreached('whatever', { fetchImpl: 123 as unknown as typeof fetch })
    expect(r).toBeNull()
  })

  it('mot de passe présent dans une fuite (count > 0) → true', async () => {
    const pwd = 'Password123!'
    const { suffix } = suffixOf(pwd)
    const fetchImpl = vi.fn(async () => okResponse(pwnedBody([
      '0000000000000000000000000000000000A:3',
      `${suffix}:1574`,
    ]))) as unknown as typeof fetch
    expect(await isPasswordBreached(pwd, { fetchImpl })).toBe(true)
  })

  it('n\'envoie que le préfixe (5 hex) — le mot de passe ne quitte pas le serveur', async () => {
    const pwd = 'Password123!'
    const { prefix } = suffixOf(pwd)
    let calledUrl = ''
    const fetchImpl = (async (url: string) => { calledUrl = url; return okResponse('AAAA:1') }) as unknown as typeof fetch
    await isPasswordBreached(pwd, { fetchImpl, rangeUrl: 'https://x/range/' })
    expect(calledUrl).toBe(`https://x/range/${prefix}`)
    expect(calledUrl).not.toContain(pwd)
  })

  it('mot de passe absent de la liste → false', async () => {
    const fetchImpl = vi.fn(async () => okResponse(pwnedBody([
      'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:9',
      'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE:2',
    ]))) as unknown as typeof fetch
    expect(await isPasswordBreached('Safe-Unique-Pass-9x', { fetchImpl })).toBe(false)
  })

  it('ligne de padding (count = 0) sur le suffixe → false (entrée factice ignorée)', async () => {
    const pwd = 'Padded!'
    const { suffix } = suffixOf(pwd)
    const fetchImpl = vi.fn(async () => okResponse(`${suffix}:0`)) as unknown as typeof fetch
    expect(await isPasswordBreached(pwd, { fetchImpl })).toBe(false)
  })

  it('suffixe sans compteur (ligne sans ":") → true', async () => {
    const pwd = 'NoCount!'
    const { suffix } = suffixOf(pwd)
    const fetchImpl = vi.fn(async () => okResponse(suffix)) as unknown as typeof fetch
    expect(await isPasswordBreached(pwd, { fetchImpl })).toBe(true)
  })

  it('réponse HTTP non OK → null (vérif impossible, non bloquant)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => '' } as unknown as Response)) as unknown as typeof fetch
    expect(await isPasswordBreached('x', { fetchImpl })).toBeNull()
  })

  it('erreur réseau / timeout (fetch rejette) → null (pas d\'accès internet)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    expect(await isPasswordBreached('x', { fetchImpl })).toBeNull()
  })

  it('respecte un timeoutMs explicite (branche option fournie)', async () => {
    const pwd = 'Timed!'
    const { suffix } = suffixOf(pwd)
    const fetchImpl = vi.fn(async () => okResponse(`${suffix}:7`)) as unknown as typeof fetch
    expect(await isPasswordBreached(pwd, { fetchImpl, timeoutMs: 9000 })).toBe(true)
  })

  it('ignore les lignes vides du corps (padding/CRLF)', async () => {
    const pwd = 'Blanks!'
    const { suffix } = suffixOf(pwd)
    const fetchImpl = vi.fn(async () => okResponse(`\n   \n${suffix}:4\n`)) as unknown as typeof fetch
    expect(await isPasswordBreached(pwd, { fetchImpl })).toBe(true)
  })

  it('utilise globalThis.fetch + l\'URL HIBP par défaut quand fetchImpl est omis', async () => {
    const pwd = 'DefaultFetch!'
    const { prefix, suffix } = suffixOf(pwd)
    let calledUrl = ''
    const stub = (async (url: string) => { calledUrl = url; return okResponse(`${suffix}:11`) }) as unknown as typeof fetch
    vi.stubGlobal('fetch', stub)
    expect(await isPasswordBreached(pwd)).toBe(true)
    expect(calledUrl).toBe(`https://api.pwnedpasswords.com/range/${prefix}`)
  })
})
