import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

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

vi.mock('../utils/crypto.js', () => ({
  decryptIfPresent: (v: string | null | undefined) => (v ? v.replace('enc:', '') : null),
}))

import {
  normalizeMmProvider, CI_MM_PHONE_RE, verifyNumber, initiateTransfer, resolveMmCreds,
  resolveAggregator,
} from './mobile-money-providers.js'

beforeEach(() => { queryMock.mockReset() })

describe('normalizeMmProvider', () => {
  it('mappe les codes hérités et canoniques', () => {
    expect(normalizeMmProvider('wave')).toBe('wave')
    expect(normalizeMmProvider('mtn')).toBe('mtn_momo')
    expect(normalizeMmProvider('MTN_MOMO')).toBe('mtn_momo')
    expect(normalizeMmProvider('orange')).toBe('orange_money')
    expect(normalizeMmProvider('orange_money')).toBe('orange_money')
  })
  it('renvoie null pour inconnu/vide', () => {
    expect(normalizeMmProvider('cofina')).toBeNull()
    expect(normalizeMmProvider(null)).toBeNull()
    expect(normalizeMmProvider('')).toBeNull()
  })
})

describe('CI_MM_PHONE_RE', () => {
  it('accepte +225 07/05 + 8 chiffres', () => {
    expect(CI_MM_PHONE_RE.test('+2250712345678')).toBe(true)
    expect(CI_MM_PHONE_RE.test('+2250512345678')).toBe(true)
  })
  it('rejette les autres formats', () => {
    expect(CI_MM_PHONE_RE.test('+33612345678')).toBe(false)
    expect(CI_MM_PHONE_RE.test('+2250612345678')).toBe(false) // 06 non valide
    expect(CI_MM_PHONE_RE.test('0712345678')).toBe(false)
  })
})

describe('resolveMmCreds', () => {
  it('repli plateforme si pas de config tenant', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const c = await resolveMmCreds('tenant_x', 'wave')
    expect(c.source).toBe('none') // env vide → none
    expect(c.apiUrl).toBe('https://wave.test')
  })
  it('utilise la config tenant (déchiffrée) si activée', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      api_key_enc: 'enc:tenant-key', api_url: 'https://custom', webhook_secret_enc: 'enc:wh',
      subscription_key_enc: null, merchant_key_enc: null, env: 'production', enabled: true,
    }] })
    const c = await resolveMmCreds('tenant_x', 'wave')
    expect(c.source).toBe('tenant')
    expect(c.apiKey).toBe('tenant-key')
    expect(c.apiUrl).toBe('https://custom')
  })
  it('tolère une table absente → repli env', async () => {
    queryMock.mockRejectedValueOnce(new Error('relation does not exist'))
    const c = await resolveMmCreds('tenant_x', 'mtn_momo')
    expect(c.source).toBe('none')
  })
})

describe('verifyNumber', () => {
  it('rejette un format invalide (sans appel provider)', async () => {
    const r = await verifyNumber('tenant_x', 'wave', '+33612345678')
    expect(r.valid).toBe(false)
    expect(r.active).toBe(false)
  })
  it('valide le format CI (provider non configuré → activité non vérifiée)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas de config tenant
    const r = await verifyNumber('tenant_x', 'wave', '+2250712345678')
    expect(r.valid).toBe(true)
    expect(r.provider).toBe('wave')
  })
})

describe('initiateTransfer', () => {
  it('provider inconnu → failed', async () => {
    const r = await initiateTransfer('tenant_x', 'cofina', { phone: '+2250712345678', amount: 1000, reference: 'R' })
    expect(r.success).toBe(false)
    expect(r.status).toBe('failed')
  })
  it('numéro invalide → failed', async () => {
    const r = await initiateTransfer('tenant_x', 'wave', { phone: '+33612345678', amount: 1000, reference: 'R' })
    expect(r.success).toBe(false)
  })
  it('aucun identifiant configuré → simulation (statut final)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas de config tenant, env vide
    const r = await initiateTransfer('tenant_x', 'wave', { phone: '+2250712345678', amount: 150000, reference: 'R' })
    expect(['completed', 'failed']).toContain(r.status)
  })
})

describe('resolveAggregator (CinetPay)', () => {
  it('null si aucun agrégateur activé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await resolveAggregator('tenant_x')).toBeNull()
  })
  it('renvoie l\'agrégateur activé avec clé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      provider: 'cinetpay', api_key_enc: 'enc:cp-key', api_url: 'https://client.cinetpay.com',
      subscription_key_enc: 'enc:pwd', merchant_key_enc: 'enc:site', env: 'production', enabled: true,
    }] })
    const agg = await resolveAggregator('tenant_x')
    expect(agg?.name).toBe('cinetpay')
    expect(agg?.creds.apiKey).toBe('cp-key')
  })
})

describe('initiateTransfer — routage agrégateur prioritaire', () => {
  it('route via l\'agrégateur quand activé (fetch mocké en échec → failed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    queryMock.mockResolvedValueOnce({ rows: [{
      provider: 'cinetpay', api_key_enc: 'enc:cp-key', api_url: 'https://client.cinetpay.com',
      subscription_key_enc: 'enc:pwd', merchant_key_enc: 'enc:site', env: 'production', enabled: true,
    }] })
    const r = await initiateTransfer('tenant_x', 'wave', { phone: '+2250712345678', amount: 150000, reference: 'R' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('agrégateur')
    vi.unstubAllGlobals()
  })
})
