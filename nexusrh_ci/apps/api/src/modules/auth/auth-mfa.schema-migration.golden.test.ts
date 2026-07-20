/**
 * GOLDEN — migration lazy du schéma CIBLE sur les routes auth/MFA.
 *
 * Régression de production (19/07/2026) : `POST /auth/mfa/setup` renvoyait 500
 * « relation "tenant_xxx.mfa_backup_codes" does not exist » sur les tenants
 * provisionnés avant l'ajout de la table. La MFA étant OBLIGATOIRE
 * (mfa_required_tenant_users=true), ces utilisateurs étaient définitivement
 * bloqués : token restreint + enrôlement impossible.
 *
 * Cause : le plugin installait un hook d'INSTANCE `preHandler` lisant
 * `request.user.schemaName`. Or les hooks d'instance s'exécutent AVANT les
 * `preHandler` de ROUTE — et c'est `fastify.authenticate` (preHandler de route)
 * qui renseigne `request.user`. Le schéma était donc toujours `undefined` et
 * `ensureTenantSchema` n'était JAMAIS appelé.
 *
 * Ce golden verrouille : pour chaque route touchant `mfa_backup_codes` /
 * `password_reset_tokens`, le schéma cible EST migré, et le cas `platform`
 * (super_admin) continue de passer par `ensurePlatformSchema`.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.hoisted(() => { process.env['ENCRYPTION_KEY'] = 'a'.repeat(64) })

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:      vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe:  vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted:  vi.fn().mockResolvedValue(false),
  consumeTotpStep:     vi.fn().mockResolvedValue(true),
  setTokenEpoch:       vi.fn().mockResolvedValue(undefined),
  getTokenEpoch:       vi.fn().mockResolvedValue(0),
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema:   vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import { ensureTenantSchema, ensurePlatformSchema } from '../../utils/schema-migrations.js'
import authPlugin from '../../plugins/auth.js'
import authMfaRoutes from './auth-mfa.routes.js'

// Schéma réellement touché en production par le 500 (2 utilisateurs bloqués)
const TENANT = 'tenant_cabinet_expertise_ci'
const UUID_A = '11111111-1111-1111-1111-111111111111'

const ensureTenantMock   = vi.mocked(ensureTenantSchema)
const ensurePlatformMock = vi.mocked(ensurePlatformSchema)

let app: FastifyInstance

function tokenFor(schemaName: string, role = 'admin'): string {
  return app.jwt.sign({
    sub: UUID_A, tenantId: 't1', schemaName, role,
    email: 'bloque@cabinet-expertise.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authMfaRoutes, { prefix: '/auth' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  ensureTenantMock.mockClear()
  ensurePlatformMock.mockClear()
})

describe('GOLDEN — routes MFA authentifiées : le schéma TENANT est migré', () => {
  // `findUserScope` renvoie {rows: []} → 404 immédiat : on court-circuite le
  // handler (pas de bcrypt 12 rounds) mais la migration doit DÉJÀ avoir eu lieu.
  const routes = ['/auth/mfa/setup', '/auth/mfa/verify', '/auth/mfa/disable'] as const

  for (const url of routes) {
    it(`POST ${url} appelle ensureTenantSchema('${TENANT}')`, async () => {
      queryMock.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'POST', url,
        headers: { authorization: `Bearer ${tokenFor(TENANT)}` },
        payload: { code: '123456', password: 'Motdepasse1!' },
      })
      // 404 (user introuvable) ou 400 (validation) — jamais 500
      expect(res.statusCode).not.toBe(500)
      expect(ensureTenantMock).toHaveBeenCalledWith(TENANT)
    })
  }
})

describe('GOLDEN — POST /auth/mfa/login-verify : schéma issu du challenge JWT', () => {
  it('migre le schéma du challenge (aucun request.user disponible)', async () => {
    const challengePayload = {
      sub: UUID_A, schemaName: TENANT, tenantId: 't1',
      aud: 'mfa-challenge', userId: UUID_A,
    } as unknown as Parameters<typeof app.jwt.sign>[0]
    const challenge = app.jwt.sign(challengePayload, { expiresIn: '3m' })

    // findUserScope → aucune ligne : 409 « MFA non actif », mais la migration
    // doit avoir eu lieu AVANT toute requête sur mfa_backup_codes.
    queryMock.mockResolvedValue({ rows: [] })

    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code: '123456' },
    })
    expect(res.statusCode).not.toBe(500)
    expect(ensureTenantMock).toHaveBeenCalledWith(TENANT)
  })

  it('ne migre rien pour un challenge invalide (401)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge: 'pas-un-jwt', code: '123456' },
    })
    expect(res.statusCode).toBe(401)
    expect(ensureTenantMock).not.toHaveBeenCalled()
  })
})

describe('GOLDEN — POST /auth/forgot-password : migre le schéma du tenant trouvé', () => {
  it('migre le tenant porteur du compte avant d\'écrire password_reset_tokens', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                                  // platform_users : absent
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT }] })           // tenants actifs
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, first_name: 'A' }] })   // users du tenant
      .mockResolvedValue({ rows: [] })                                      // DELETE + INSERT + audit

    const res = await app.inject({
      method: 'POST', url: '/auth/forgot-password',
      payload: { email: 'bloque@cabinet-expertise.ci' },
    })
    expect(res.statusCode).toBe(200)
    expect(ensureTenantMock).toHaveBeenCalledWith(TENANT)
  })
})

describe('GOLDEN — non-régression super_admin (schéma platform)', () => {
  it('POST /auth/mfa/setup en platform passe par ensurePlatformSchema, jamais ensureTenantSchema', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${tokenFor('platform', 'super_admin')}` },
    })
    expect(res.statusCode).not.toBe(500)
    expect(ensurePlatformMock).toHaveBeenCalled()
    expect(ensureTenantMock).not.toHaveBeenCalled()
  })

  it('POST /auth/reset-password migre platform avant de lire platform.password_reset_tokens', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })   // platform.password_reset_tokens : absent
      .mockResolvedValueOnce({ rows: [] })   // tenants actifs : aucun

    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(43), newPassword: 'Motdepasse1!' },
    })
    expect(res.statusCode).toBe(404)
    expect(ensurePlatformMock).toHaveBeenCalled()
  })
})
