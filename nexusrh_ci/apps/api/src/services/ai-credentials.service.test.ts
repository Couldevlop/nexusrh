import { describe, it, expect, vi, beforeEach } from 'vitest'

// ENCRYPTION_KEY (64 hex) AVANT les imports — crypto.ts la lit au chargement.
vi.hoisted(() => { process.env['ENCRYPTION_KEY'] = 'a'.repeat(64) })

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../config.js', () => ({
  config: {
    database: { url: 'postgresql://test' },
    ai:       { apiKey: 'env-claude-key',  model: 'env-claude-model', defaultProvider: 'claude' },
    mistral:  { apiKey: 'env-mistral-key', model: 'env-mistral-model' },
  },
}))

import { resolveAiCreds, envCreds, maskKey, isEncryptionAvailable } from './ai-credentials.service.js'
import { encrypt } from '../utils/crypto.js'

beforeEach(() => queryMock.mockReset())

/**
 * resolveAiCreds émet deux requêtes : (1) le flag platform.tenants
 * (ai_platform_key_enabled), (2) le ai_settings du tenant. Ce harnais route la
 * réponse selon le SQL pour rester robuste à l'ordre.
 */
function mockDb(opts: {
  flagEnabled?: boolean | null     // ligne platform.tenants ; undefined = pas de ligne
  settingsRow?: Record<string, unknown> | null   // ligne ai_settings ; null = pas de ligne
  settingsError?: boolean
} = {}) {
  queryMock.mockImplementation((...args: unknown[]) => {
    const sql = String(args[0] ?? '')
    if (sql.includes('ai_platform_key_enabled')) {
      return Promise.resolve({
        rows: opts.flagEnabled === undefined ? [] : [{ ai_platform_key_enabled: opts.flagEnabled }],
      })
    }
    if (sql.includes('ai_settings')) {
      if (opts.settingsError) return Promise.reject(new Error('relation ai_settings does not exist'))
      return Promise.resolve({ rows: opts.settingsRow ? [opts.settingsRow] : [] })
    }
    return Promise.resolve({ rows: [] })
  })
}

describe('maskKey — ne révèle jamais la clé (OWASP A02)', () => {
  it('null/vide → null', () => {
    expect(maskKey(null)).toBeNull()
    expect(maskKey('')).toBeNull()
    expect(maskKey(undefined)).toBeNull()
  })
  it('ne montre que les 4 derniers caractères', () => {
    expect(maskKey('sk-ant-secret-1234')).toBe('••••••••1234')
  })
})

describe('isEncryptionAvailable', () => {
  it('true quand ENCRYPTION_KEY fait 64 hex', () => {
    expect(isEncryptionAvailable()).toBe(true)
  })
})

describe('envCreds — repli plateforme', () => {
  it('reflète config.ai / config.mistral avec source=platform quand clé présente', () => {
    expect(envCreds()).toEqual({
      claude:  { apiKey: 'env-claude-key',  model: 'env-claude-model',  source: 'platform' },
      mistral: { apiKey: 'env-mistral-key', model: 'env-mistral-model', source: 'platform' },
      preferredProvider: 'claude',
    })
  })
})

describe('resolveAiCreds — priorité tenant > plateforme, flag, source (OWASP A02/A10)', () => {
  it('schema null/platform/invalide → repli env sans requête', async () => {
    expect(await resolveAiCreds(null)).toEqual(envCreds())
    expect(await resolveAiCreds('platform')).toEqual(envCreds())
    expect(await resolveAiCreds('mauvais nom!')).toEqual(envCreds())
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('clé tenant déchiffrée prioritaire (source=tenant) ; provider sans clé tenant → repli plateforme (source=platform)', async () => {
    mockDb({
      flagEnabled: true,
      settingsRow: {
        claude_api_key_enc:  encrypt('tenant-claude-key'),
        claude_model:        'tenant-claude-model',
        mistral_api_key_enc: null,         // pas de clé Mistral tenant → repli env
        mistral_model:       null,
        preferred_provider:  'mistral',
      },
    })
    const c = await resolveAiCreds('tenant_sotra')
    expect(c.claude).toEqual({ apiKey: 'tenant-claude-key', model: 'tenant-claude-model', source: 'tenant' })
    expect(c.mistral).toEqual({ apiKey: 'env-mistral-key', model: 'env-mistral-model', source: 'platform' })
    expect(c.preferredProvider).toBe('mistral')
  })

  it('flag désactivé + pas de clé tenant → AUCUNE clé (source=null), pas de repli plateforme', async () => {
    mockDb({ flagEnabled: false, settingsRow: null })
    const c = await resolveAiCreds('tenant_sotra')
    expect(c.claude).toEqual({ apiKey: null, model: 'env-claude-model', source: null })
    expect(c.mistral).toEqual({ apiKey: null, model: 'env-mistral-model', source: null })
  })

  it('flag désactivé MAIS clé tenant présente → clé tenant utilisée (priorité absolue)', async () => {
    mockDb({
      flagEnabled: false,
      settingsRow: {
        claude_api_key_enc:  encrypt('tenant-claude-key'),
        claude_model:        null,
        mistral_api_key_enc: null,
        mistral_model:       null,
        preferred_provider:  'claude',
      },
    })
    const c = await resolveAiCreds('tenant_sotra')
    expect(c.claude).toEqual({ apiKey: 'tenant-claude-key', model: 'env-claude-model', source: 'tenant' })
    // Mistral sans clé tenant + flag off → aucune clé
    expect(c.mistral.apiKey).toBeNull()
    expect(c.mistral.source).toBeNull()
  })

  it('aucune ligne ai_settings + flag autorisé → repli plateforme (source=platform)', async () => {
    mockDb({ flagEnabled: true, settingsRow: null })
    const c = await resolveAiCreds('tenant_sotra')
    expect(c.claude).toEqual({ apiKey: 'env-claude-key', model: 'env-claude-model', source: 'platform' })
    expect(c.mistral.source).toBe('platform')
  })

  it('erreur BD ai_settings → repli env, jamais d\'exception', async () => {
    mockDb({ flagEnabled: true, settingsError: true })
    expect(await resolveAiCreds('tenant_sotra')).toEqual(envCreds())
  })

  it('clé chiffrée corrompue → repli plateforme (decryptIfPresent renvoie null)', async () => {
    mockDb({
      flagEnabled: true,
      settingsRow: {
        claude_api_key_enc:  'pas-un-chiffré-valide',
        claude_model:        null,
        mistral_api_key_enc: null,
        mistral_model:       null,
        preferred_provider:  'claude',
      },
    })
    const c = await resolveAiCreds('tenant_sotra')
    expect(c.claude.apiKey).toBe('env-claude-key') // repli car déchiffrement échoue
    expect(c.claude.source).toBe('platform')
  })
})
