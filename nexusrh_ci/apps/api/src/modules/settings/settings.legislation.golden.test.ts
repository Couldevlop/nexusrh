/**
 * GOLDEN — Paramétrage légal par PAYS (onglet Paramètres → Légal).
 *
 * Couvre la fonctionnalité « choisir un pays installe automatiquement la
 * convention / le SMIG / le barème d'imposition / les cotisations » :
 *   - GET  /settings/legislation  → pack appliqué + pays sélectionnables
 *   - PUT  /settings/legislation  → applique le pays, persiste default_country_code
 *   - garde-fous : RBAC admin-only, pays inconnu rejeté (400), pack stub signalé
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../db/provisioning.js', () => ({
  provisionTenantSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/email.js', () => ({ sendEmployeeWelcomeEmail: vi.fn().mockResolvedValue({ sent: true }) }))
vi.mock('../../utils/crypto.js', () => ({
  encrypt: (v: string) => `enc(${v})`,
  encryptIfPresent: (v: string | null | undefined) => (v ? `enc(${v})` : null),
  decryptIfPresent: (v: string | null | undefined) => (v ? `dec(${v})` : null),
}))
vi.mock('../../services/ai-credentials.service.js', () => ({
  maskKey: (k: string | null | undefined) => (k ? `••••${k.slice(-4)}` : null),
  isEncryptionAvailable: vi.fn(() => true),
}))
vi.mock('../../services/sourcing-config.service.js', () => ({ loadAiModels: vi.fn().mockResolvedValue([]) }))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test', appUrl: 'http://localhost:3001',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk', model: 'm' }, mistral: { apiKey: 'sk', model: 'm' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import settingsRoutes from './settings.routes.js'

const TENANT = 'tenant_sotra'
function tokenFor(app: FastifyInstance, role: string, tenantId: string | null = 't1') {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId, schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` })

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('GET /settings/legislation', () => {
  it('retourne le pack appliqué (CIV par défaut) + la liste des pays', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ default_country_code: 'CIV' }] })
    const res = await app.inject({
      method: 'GET', url: '/settings/legislation',
      headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.countryCode).toBe('CIV')
    expect(data.usable).toBe(true)
    expect(data.pack.smigMensuel).toBe(75_000)
    expect(data.pack.labelCaisseSociale).toBe('CNPS')
    expect(data.available).toHaveLength(16)
  })

  it('un tenant configuré sur le Sénégal voit le pack SEN (utilisable)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ default_country_code: 'SEN' }] })
    const res = await app.inject({
      method: 'GET', url: '/settings/legislation',
      headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.countryCode).toBe('SEN')
    expect(data.usable).toBe(true)        // actif → calcul paie autorisé
    expect(data.pack.currency).toBe('XOF')
  })

  it('refuse un rôle non-admin (RBAC)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/settings/legislation',
      headers: auth(tokenFor(app, 'hr_manager')),
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('PUT /settings/legislation', () => {
  it('applique un pays pris en charge et persiste default_country_code', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ default_country_code: 'CIV' }] }) // SELECT before
      .mockResolvedValueOnce({ rows: [] })                                // UPDATE
    const res = await app.inject({
      method: 'PUT', url: '/settings/legislation',
      headers: auth(tokenFor(app, 'admin')),
      payload: { countryCode: 'BEN' },
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.countryCode).toBe('BEN')
    expect(data.pack.labelCaisseSociale).toBe('CNSS')
    // l'UPDATE a bien reçu le nouveau pays
    const updateCall = queryMock.mock.calls.find(c => /UPDATE platform\.tenants/.test(c[0]))
    expect(updateCall).toBeTruthy()
    expect(updateCall![1]).toContain('BEN')
  })

  it('rejette un pays non pris en charge (400, aucun UPDATE)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/settings/legislation',
      headers: auth(tokenFor(app, 'admin')),
      payload: { countryCode: 'USA' },
    })
    expect(res.statusCode).toBe(400)
    expect(queryMock.mock.calls.some(c => /UPDATE platform\.tenants/.test(c[0]))).toBe(false)
  })

  it('rejette un format de code pays invalide (400)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/settings/legislation',
      headers: auth(tokenFor(app, 'admin')),
      payload: { countryCode: 'ci' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un rôle non-admin (RBAC)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/settings/legislation',
      headers: auth(tokenFor(app, 'manager')),
      payload: { countryCode: 'BEN' },
    })
    expect(res.statusCode).toBe(403)
  })
})
