/**
 * Garde anti-SSRF (OWASP A10) — les appels sortants tenant ne doivent jamais
 * cibler le réseau interne. Tests sur IP littérales (pas de DNS réseau).
 */
import { describe, it, expect } from 'vitest'
import { isSafeOutboundUrl, assertSafeOutboundUrl, assertSafeSmtpHost, isSafeSmtpHost, assertSafeOutboundHost, SsrfBlockedError } from './ssrf-guard.js'

describe('ssrf-guard — adresses internes bloquées', () => {
  const blocked = [
    'http://127.0.0.1/x',
    'http://10.0.0.5/',
    'http://192.168.1.10/',
    'http://172.16.4.4/',
    'http://169.254.169.254/latest/meta-data',  // metadata cloud
    'http://100.64.0.1/',                        // CGNAT
    'http://[::1]/',                             // IPv6 loopback
    'http://0.0.0.0/',
  ]
  for (const u of blocked) {
    it(`bloque ${u}`, async () => {
      const r = await isSafeOutboundUrl(u)
      expect(r.ok).toBe(false)
    })
  }

  it('bloque localhost / .local / .internal (hostname)', async () => {
    expect((await isSafeOutboundUrl('http://localhost/')).ok).toBe(false)
    expect((await isSafeOutboundUrl('http://api.local/')).ok).toBe(false)
    expect((await isSafeOutboundUrl('http://svc.internal/')).ok).toBe(false)
  })

  it('bloque les schémas non http(s) et les identifiants dans l\'URL', async () => {
    expect((await isSafeOutboundUrl('ftp://8.8.8.8/')).ok).toBe(false)
    expect((await isSafeOutboundUrl('file:///etc/passwd')).ok).toBe(false)
    expect((await isSafeOutboundUrl('http://user:pass@8.8.8.8/')).ok).toBe(false)
  })

  it('autorise une IP publique littérale', async () => {
    expect((await isSafeOutboundUrl('http://8.8.8.8/')).ok).toBe(true)
    expect((await isSafeOutboundUrl('https://1.1.1.1/hook')).ok).toBe(true)
  })

  it('assertSafeOutboundUrl lève SsrfBlockedError sur IP privée', async () => {
    await expect(assertSafeOutboundUrl('http://192.168.0.1/')).rejects.toBeInstanceOf(SsrfBlockedError)
  })
})

describe('ssrf-guard — assertSafeSmtpHost (SMTP tenant, OWASP A10)', () => {
  const blockedHosts = [
    '127.0.0.1', '10.0.0.5', '192.168.1.1', '192.168.1.10', '172.16.4.4',
    '169.254.169.254', // metadata cloud
    '100.64.0.1',       // CGNAT
    '::1',               // IPv6 loopback
    '0.0.0.0',
  ]
  for (const h of blockedHosts) {
    it(`bloque l'hôte ${h}`, async () => {
      await expect(assertSafeSmtpHost(h)).rejects.toBeInstanceOf(SsrfBlockedError)
    })
  }

  it('bloque localhost / .local / .internal', async () => {
    await expect(assertSafeSmtpHost('localhost')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeSmtpHost('foo.internal')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeSmtpHost('mail.local')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeSmtpHost('smtp.internal')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('bloque un hôte vide', async () => {
    await expect(assertSafeSmtpHost('')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('autorise une IP publique littérale', async () => {
    await expect(assertSafeSmtpHost('8.8.8.8')).resolves.toBeUndefined()
    await expect(assertSafeSmtpHost('1.1.1.1')).resolves.toBeUndefined()
  })

  it('isSafeSmtpHost — variante non-levante ({ok})', async () => {
    expect((await isSafeSmtpHost('169.254.169.254')).ok).toBe(false)
    expect((await isSafeSmtpHost('8.8.8.8')).ok).toBe(true)
  })
})

describe('ssrf-guard — assertSafeOutboundHost (SMTP tenant, OWASP A10 — utilisé par /settings/email)', () => {
  const blockedHosts = [
    '127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.4.4',
    '169.254.169.254', // metadata cloud
    '100.64.0.1',       // CGNAT
    '::1',               // IPv6 loopback
    '0.0.0.0',
  ]
  for (const h of blockedHosts) {
    it(`bloque l'hôte ${h}`, async () => {
      await expect(assertSafeOutboundHost(h)).rejects.toBeInstanceOf(SsrfBlockedError)
    })
  }

  it('bloque localhost / .local / .internal', async () => {
    await expect(assertSafeOutboundHost('localhost')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeOutboundHost('mail.local')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeOutboundHost('smtp.internal')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('bloque un hôte vide', async () => {
    await expect(assertSafeOutboundHost('')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('autorise une IP publique littérale', async () => {
    await expect(assertSafeOutboundHost('8.8.8.8')).resolves.toBeUndefined()
    await expect(assertSafeOutboundHost('1.1.1.1')).resolves.toBeUndefined()
  })
})
