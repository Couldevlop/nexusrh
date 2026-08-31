/**
 * Garde anti-SSRF — épinglage IP (anti DNS-rebinding / TOCTOU, OWASP A10).
 *
 * `resolveSafeOutbound` doit épingler la connexion sur l'IP EXACTE que la garde
 * a validée (issue de la résolution DNS de contrôle), et NON sur le hostname —
 * sinon `fetch` re-résoudrait indépendamment et un DNS malveillant pourrait
 * renvoyer une IP interne à la connexion. On mocke `dns/promises` pour prouver
 * que l'IP épinglée provient bien de la validation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }))
vi.mock('dns/promises', () => ({ lookup: lookupMock }))

import {
  resolveSafeOutbound, resolveSafeOutboundResult, pinnedDispatcher, pinnedLookupFor, SsrfBlockedError,
} from './ssrf-guard.js'

beforeEach(() => { lookupMock.mockReset() })

describe('resolveSafeOutbound — épinglage sur l\'IP validée', () => {
  it('hôte DNS public : épingle sur l\'IP RÉSOLUE (pas le hostname) + fournit un dispatcher', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])

    const safe = await resolveSafeOutbound('https://rebind.example.com/webhook')

    // L'IP épinglée vient de la résolution de contrôle, jamais du hostname.
    expect(safe.ip).toBe('93.184.216.34')
    expect(safe.family).toBe(4)
    expect(safe.url.toString()).toBe('https://rebind.example.com/webhook')
    expect(typeof safe.dispatcher.close).toBe('function')
    expect(lookupMock).toHaveBeenCalledWith('rebind.example.com', { all: true })

    await safe.dispatcher.close()
  })

  it('hôte DNS multi-adresses toutes publiques : épingle la PREMIÈRE', async () => {
    lookupMock.mockResolvedValue([
      { address: '198.51.100.7', family: 4 },
      { address: '203.0.113.9', family: 4 },
    ])

    const safe = await resolveSafeOutbound('https://api.example.com/')

    expect(safe.ip).toBe('198.51.100.7')
    await safe.dispatcher.close()
  })

  it('rejette si UNE SEULE adresse résolue est interne (défense rebinding au contrôle)', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 }, // metadata cloud
    ])

    await expect(resolveSafeOutbound('https://sneaky.example.com/')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('IP littérale publique : épingle directement, sans DNS', async () => {
    const safe = await resolveSafeOutbound('https://8.8.8.8/hook')

    expect(safe.ip).toBe('8.8.8.8')
    expect(safe.family).toBe(4)
    expect(lookupMock).not.toHaveBeenCalled()
    await safe.dispatcher.close()
  })

  it('hôte DNS résolvant en IPv6 public : épingle l\'adresse + famille 6', async () => {
    lookupMock.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }])

    const safe = await resolveSafeOutbound('https://v6.example.com/')

    expect(safe.ip).toBe('2606:4700:4700::1111')
    expect(safe.family).toBe(6)
    await safe.dispatcher.close()
  })

  it('IP littérale privée : lève sans construire de dispatcher', async () => {
    await expect(resolveSafeOutbound('http://10.0.0.5/')).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('DNS introuvable : lève SsrfBlockedError', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(resolveSafeOutbound('https://nx.example.com/')).rejects.toBeInstanceOf(SsrfBlockedError)
  })
})

describe('resolveSafeOutboundResult — variante non-levante', () => {
  it('hôte public : { ok:true, value } avec dispatcher épinglé', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const r = await resolveSafeOutboundResult('https://ok.example.com/')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.ip).toBe('93.184.216.34')
      expect(typeof r.value.dispatcher.close).toBe('function')
      await r.value.dispatcher.close()
    }
  })

  it('hôte interne : { ok:false, reason } sans jamais lever', async () => {
    const r = await resolveSafeOutboundResult('http://127.0.0.1/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/privée|interne/i)
  })
})

describe('pinnedLookupFor — le lookup renvoie TOUJOURS l\'IP épinglée', () => {
  it('forme undici (options.all=true) : rend [{ address, family }] épinglés, quel que soit le hostname', () => {
    const lookup = pinnedLookupFor('93.184.216.34', 4)
    const cb = vi.fn()
    // undici demande la résolution d'un hostname arbitraire (potentiellement
    // rebindé) — le lookup doit ignorer le hostname et rendre l'IP validée.
    lookup('evil-rebind.example.com', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }])
  })

  it('forme héritée (err, address, family) quand all n\'est pas demandé', () => {
    const lookup = pinnedLookupFor('198.51.100.7', 4)
    const cb = vi.fn()
    lookup('host.example.com', {}, cb)
    expect(cb).toHaveBeenCalledWith(null, '198.51.100.7', 4)
  })

  it('IPv6 (famille 6) préservée', () => {
    const lookup = pinnedLookupFor('2606:4700:4700::1111', 6)
    const cb = vi.fn()
    lookup('host.example.com', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(null, [{ address: '2606:4700:4700::1111', family: 6 }])
  })

  it('famille inconnue normalisée en IPv4 (4)', () => {
    const lookup = pinnedLookupFor('203.0.113.5', 0)
    const cb = vi.fn()
    lookup('host.example.com', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(null, [{ address: '203.0.113.5', family: 4 }])
  })

  it('pinnedDispatcher renvoie un Agent undici fermable', async () => {
    const agent = pinnedDispatcher('93.184.216.34', 4)
    expect(typeof agent.close).toBe('function')
    await agent.close()
  })
})
