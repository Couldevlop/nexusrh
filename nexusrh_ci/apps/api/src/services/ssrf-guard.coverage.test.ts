/**
 * Garde anti-SSRF (OWASP A10) — couverture exhaustive : résolution DNS (succès
 * vers public, échec, résolution vers privé), IPv6 (loopback, ULA, link-local,
 * IPv4-mapped), formats d'IP invalides. Le DNS est mocké (aucun appel réseau).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }))
vi.mock('dns/promises', () => ({ lookup: lookupMock }))

import { isSafeOutboundUrl, assertSafeOutboundUrl, SsrfBlockedError } from './ssrf-guard.js'

beforeEach(() => { lookupMock.mockReset() })

describe('ssrf-guard — résolution DNS (hostnames non littéraux)', () => {
  it('autorise un hostname qui résout vers une IP publique', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const r = await isSafeOutboundUrl('https://example.com/webhook')
    expect(r.ok).toBe(true)
    expect(lookupMock).toHaveBeenCalledWith('example.com', { all: true })
  })

  it('bloque un hostname qui résout vers une IP privée (DNS rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }])
    const r = await isSafeOutboundUrl('https://evil.example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/interne/)
  })

  it('bloque si une seule des IP résolues est privée', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.0.5', family: 4 },
    ])
    expect((await isSafeOutboundUrl('https://mixed.example.com/')).ok).toBe(false)
  })

  it('bloque si la résolution DNS échoue (hôte introuvable)', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'))
    const r = await isSafeOutboundUrl('https://inexistant.example.invalid/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/DNS/)
  })

  it('bloque si la résolution ne renvoie aucune adresse', async () => {
    lookupMock.mockResolvedValue([])
    const r = await isSafeOutboundUrl('https://vide.example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/introuvable/)
  })

  it('assertSafeOutboundUrl lève si le hostname résout vers du privé', async () => {
    lookupMock.mockResolvedValue([{ address: '172.16.0.1', family: 4 }])
    await expect(assertSafeOutboundUrl('https://rebind.example.com/'))
      .rejects.toBeInstanceOf(SsrfBlockedError)
  })
})

describe('ssrf-guard — IPv6 résolus via DNS (couvre isPrivateIPv6)', () => {
  // Dans le guard, un hostname IPv6 littéral est entre crochets ([::1]) donc
  // isIP() le rejette : il passe par la résolution DNS. On contrôle donc les
  // adresses IPv6 renvoyées par le lookup mocké.
  it('bloque ::1 (loopback) et :: (non spécifié)', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '::1', family: 6 }])
    expect((await isSafeOutboundUrl('http://host-v6-loop.example/')).ok).toBe(false)
    lookupMock.mockResolvedValueOnce([{ address: '::', family: 6 }])
    expect((await isSafeOutboundUrl('http://host-v6-unspec.example/')).ok).toBe(false)
  })
  it('bloque fe80 (link-local), fc / fd (ULA)', async () => {
    lookupMock.mockResolvedValueOnce([{ address: 'fe80::1', family: 6 }])
    expect((await isSafeOutboundUrl('http://ll.example/')).ok).toBe(false)
    lookupMock.mockResolvedValueOnce([{ address: 'fc00::1', family: 6 }])
    expect((await isSafeOutboundUrl('http://ula1.example/')).ok).toBe(false)
    lookupMock.mockResolvedValueOnce([{ address: 'fd12:3456::1', family: 6 }])
    expect((await isSafeOutboundUrl('http://ula2.example/')).ok).toBe(false)
  })
  it('bloque ::ffff:127.0.0.1 (IPv4-mapped vers loopback)', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '::ffff:127.0.0.1', family: 6 }])
    expect((await isSafeOutboundUrl('http://mapped.example/')).ok).toBe(false)
  })
  it('autorise une IPv6 publique résolue', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '2001:4860:4860::8888', family: 6 }])
    expect((await isSafeOutboundUrl('http://v6pub.example/')).ok).toBe(true)
  })
})

describe('ssrf-guard — formats et URL', () => {
  it('rejette une URL syntaxiquement invalide', async () => {
    const r = await isSafeOutboundUrl('pas une url')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/invalide/)
  })
  it('bloque metadata.google.internal (hostname blacklisté)', async () => {
    expect((await isSafeOutboundUrl('http://metadata.google.internal/')).ok).toBe(false)
  })
  it('isPrivateIPv4 — un quadruplet malformé est traité comme privé (prudence)', async () => {
    // 1.2.3 a moins de 4 octets une fois passé à isIP : non reconnu comme IP,
    // donc résolution DNS. On force le DNS à renvoyer un octet manquant via
    // une IP textuelle anormale pour couvrir la branche prudente isPrivateIPv4.
    lookupMock.mockResolvedValue([{ address: '1.2.3', family: 4 }])
    expect((await isSafeOutboundUrl('http://weird.example.com/')).ok).toBe(false)
  })

  it('isPrivateIPv4 — octet NaN traité comme privé (prudence)', async () => {
    lookupMock.mockResolvedValue([{ address: '1.2.x.4', family: 4 }])
    expect((await isSafeOutboundUrl('http://nan.example.com/')).ok).toBe(false)
  })

  it('bloque une IP multicast/réservée résolue (>= 224)', async () => {
    lookupMock.mockResolvedValue([{ address: '224.0.0.1', family: 4 }])
    expect((await isSafeOutboundUrl('http://mcast.example.com/')).ok).toBe(false)
  })
})
