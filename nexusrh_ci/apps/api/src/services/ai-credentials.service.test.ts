import { describe, it, expect, vi, beforeEach } from 'vitest'

// ENCRYPTION_KEY (64 hex) AVANT les imports — crypto.ts la lit au chargement.
vi.hoisted(() => { process.env['ENCRYPTION_KEY'] = 'a'.repeat(64) })

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../config.js', () => ({
  config: {
    database: { url: 'postgresql://test' },
    ai:       { apiKey: 'env-claude-key',  model: 'env-claude-model' },
    mistral:  { apiKey: 'env-mistral-key', model: 'env-mistral-model' },
  },
}))

import { resolveAiCreds, envCreds, maskKey, isEncryptionAvailable } from './ai-credentials.service.js'
import { encrypt } from '../utils/crypto.js'

beforeEach(() => queryMock.mockReset())

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
  it('reflète config.ai / config.mistral', () => {
    expect(envCreds()).toEqual({
      claude:  { apiKey: 'env-claude-key',  model: 'env-claude-model' },
      mistral: { apiKey: 'env-mistral-key', model: 'env-mistral-model' },
      preferredProvider: 'claude',
    })
  })
})

describe('resolveAiCreds — clé tenant prioritaire, repli env (OWASP A02/A10)', () => {
  it('schema null/platform/invalide → repli env sans requête', async () => {
    expect(await resolveAiCreds(null)).toEqual(envCreds())
    expect(await resolveAiCreds('platform')).toEqual(envCreds())
    expect(await resolveAiCreds('mauvais nom!')).toEqual(envCreds())
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('clé tenant déchiffrée prioritaire ; champ absent → repli env', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      claude_api_key_enc:  encrypt('tenant-claude-key'),
      claude_model:        'tenant-claude-model',
      mistral_api_key_enc: null,         // pas de clé Mistral tenant → repli env
      mistral_model:       null,
      preferred_provider:  'mistral',
    }] })
    const c = await resolveAiCreds('tenant_sotra')
    expect(c.claude).toEqual({ apiKey: 'tenant-claude-key', model: 'tenant-claude-model' })
    expect(c.mistral).toEqual({ apiKey: 'env-mistral-key', model: 'env-mistral-model' })
    expect(c.preferredProvider).toBe('mistral')
  })

  it('aucune ligne → repli env', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await resolveAiCreds('tenant_sotra')).toEqual(envCreds())
  })

  it('erreur BD (table absente) → repli env, jamais d\'exception', async () => {
    queryMock.mockRejectedValueOnce(new Error('relation ai_settings does not exist'))
    expect(await resolveAiCreds('tenant_sotra')).toEqual(envCreds())
  })

  it('clé chiffrée corrompue → repli env (decryptIfPresent renvoie null)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      claude_api_key_enc:  'pas-un-chiffré-valide',
      claude_model:        null,
      mistral_api_key_enc: null,
      mistral_model:       null,
      preferred_provider:  'claude',
    }] })
    const c = await resolveAiCreds('tenant_sotra')
    expect(c.claude.apiKey).toBe('env-claude-key') // repli car déchiffrement échoue
  })
})
