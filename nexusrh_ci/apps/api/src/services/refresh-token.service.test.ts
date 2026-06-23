import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  issueRefreshToken, consumeRefreshToken, revokeRefreshToken, verifyAccountActive,
  type RefreshClaims,
} from './refresh-token.service.js'

const queryMock = vi.fn()
const pool = { query: queryMock } as never

const CLAIMS: RefreshClaims = {
  sub: 'u-1', tenantId: 't-1', schemaName: 'tenant_sotra', role: 'admin',
  email: 'admin@sotra.ci', firstName: 'A', lastName: 'B', employeeId: null,
}

beforeEach(() => queryMock.mockReset())

describe('issueRefreshToken', () => {
  it('insère le hash + claims et retourne un token 64 hex', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const tok = await issueRefreshToken(pool, CLAIMS)
    expect(tok).toMatch(/^[0-9a-f]{64}$/)
    const sql = String(queryMock.mock.calls[0][0])
    expect(sql).toContain('INSERT INTO platform.refresh_tokens')
    // le token EN CLAIR n'est jamais stocké : seul son hash (≠ token)
    expect(queryMock.mock.calls[0][1][0]).not.toBe(tok)
    expect(queryMock.mock.calls[0][1][0]).toMatch(/^[0-9a-f]{64}$/)
  })
  it('erreur DB → null (non bloquant)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    expect(await issueRefreshToken(pool, CLAIMS)).toBeNull()
  })
})

describe('consumeRefreshToken (rotation)', () => {
  it('token valide → révoque (UPDATE revoked_at) et retourne les claims', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ claims: CLAIMS }] })
    const c = await consumeRefreshToken(pool, 'a'.repeat(64))
    expect(c).toEqual(CLAIMS)
    expect(String(queryMock.mock.calls[0][0])).toContain('SET revoked_at = now()')
  })
  it('token inconnu/expiré/révoqué → null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await consumeRefreshToken(pool, 'b'.repeat(64))).toBeNull()
  })
  it('token vide/absent → null sans requête', async () => {
    expect(await consumeRefreshToken(pool, null)).toBeNull()
    expect(await consumeRefreshToken(pool, '')).toBeNull()
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('revokeRefreshToken', () => {
  it('révoque (UPDATE) ; non bloquant si erreur', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await revokeRefreshToken(pool, 'c'.repeat(64))
    expect(String(queryMock.mock.calls[0][0])).toContain('SET revoked_at = now()')
    queryMock.mockRejectedValueOnce(new Error('x'))
    await expect(revokeRefreshToken(pool, 'd'.repeat(64))).resolves.toBeUndefined()
  })
})

describe('verifyAccountActive', () => {
  it('platform : compte actif → rôle', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'super_admin', is_active: true }] })
    expect(await verifyAccountActive(pool, 'platform', 'u-1')).toEqual({ role: 'super_admin' })
    expect(String(queryMock.mock.calls[0][0])).toContain('platform.platform_users')
  })
  it('compte désactivé → null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin', is_active: false }] })
    expect(await verifyAccountActive(pool, 'tenant_sotra', 'u-1')).toBeNull()
  })
  it('compte introuvable → null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await verifyAccountActive(pool, 'tenant_sotra', 'u-1')).toBeNull()
  })
  it('tenant : requête le schéma de l\'utilisateur', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin', is_active: true }] })
    expect(await verifyAccountActive(pool, 'tenant_sotra', 'u-1')).toEqual({ role: 'admin' })
    expect(String(queryMock.mock.calls[0][0])).toContain('"tenant_sotra".users')
  })
  it('nom de schéma invalide → null sans requête (anti-injection)', async () => {
    expect(await verifyAccountActive(pool, 'bad schema!', 'u-1')).toBeNull()
    expect(queryMock).not.toHaveBeenCalled()
  })
})
