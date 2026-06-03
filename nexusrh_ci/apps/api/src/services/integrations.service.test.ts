/**
 * Service Connectivité — clés API (hash/format/résolution), signature HMAC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() })) }))
vi.mock('../config.js', () => ({ config: { database: { url: 'postgresql://test' } } }))

import { hashApiKey, generateApiKey, signPayload, resolveApiKey, EVENT_KEYS, API_SCOPES } from './integrations.service.js'

describe('clés API', () => {
  it('hashApiKey est déterministe (sha256 hex 64)', () => {
    const h = hashApiKey('nxk_acme.secret')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashApiKey('nxk_acme.secret')).toBe(h)
    expect(hashApiKey('autre')).not.toBe(h)
  })
  it('generateApiKey : format nxk_{slug}.{rand} + préfixe + hash cohérent', () => {
    const { full, prefix, hash } = generateApiKey('sotra')
    expect(full.startsWith('nxk_sotra.')).toBe(true)
    expect(prefix.startsWith('nxk_sotra.')).toBe(true)
    expect(hash).toBe(hashApiKey(full))
  })
})

describe('signPayload (HMAC SHA-256)', () => {
  it('produit la signature HMAC attendue', () => {
    const body = '{"event":"x"}'
    const expected = createHmac('sha256', 'sek').update(body).digest('hex')
    expect(signPayload('sek', body)).toBe(expected)
  })
})

describe('catalogues', () => {
  it('événements et scopes non vides + clés stables', () => {
    expect(EVENT_KEYS).toContain('employee.created')
    expect(EVENT_KEYS).toContain('absence.approved')
    expect(API_SCOPES).toContain('employees:read')
    expect(API_SCOPES).toContain('payroll:read')
  })
})

describe('resolveApiKey', () => {
  function stubPool(rows: { tenants: unknown[]; keys: unknown[] }) {
    const q = vi.fn()
    q.mockResolvedValueOnce({ rows: rows.tenants }) // platform.tenants
    q.mockResolvedValueOnce({ rows: rows.keys })    // integration_api_keys
    q.mockResolvedValue({ rows: [] })               // UPDATE last_used (fire-forget) + reste
    return { query: q } as never
  }
  beforeEach(() => { vi.clearAllMocks() })

  it('format invalide → null (aucune requête)', async () => {
    const pool = stubPool({ tenants: [], keys: [] })
    expect(await resolveApiKey(pool, 'pas-une-cle')).toBeNull()
    expect(await resolveApiKey(pool, 'nxk_sans点')).toBeNull()
  })
  it('tenant introuvable → null', async () => {
    const pool = stubPool({ tenants: [], keys: [] })
    expect(await resolveApiKey(pool, 'nxk_ghost.abc')).toBeNull()
  })
  it('clé inexistante dans le tenant → null', async () => {
    const pool = stubPool({ tenants: [{ id: 't1', schema_name: 'tenant_acme', status: 'active' }], keys: [] })
    expect(await resolveApiKey(pool, 'nxk_acme.abc')).toBeNull()
  })
  it('clé valide → contexte tenant + scopes', async () => {
    const pool = stubPool({
      tenants: [{ id: 't1', schema_name: 'tenant_acme', status: 'active' }],
      keys: [{ id: 'k1', scopes: ['employees:read'] }],
    })
    const ctx = await resolveApiKey(pool, 'nxk_acme.abc')
    expect(ctx).toMatchObject({ schemaName: 'tenant_acme', tenantId: 't1', keyId: 'k1', scopes: ['employees:read'] })
  })
})
