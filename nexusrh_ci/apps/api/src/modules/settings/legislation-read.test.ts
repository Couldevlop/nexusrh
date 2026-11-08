/**
 * GET /settings/legislation — lecture du paramétrage légal.
 *
 * Deux besoins du simulateur de salaire, qui n'est pas réservé aux admins :
 *  1. les rôles RH doivent pouvoir LIRE la liste des pays et le pack du
 *     tenant (l'écriture, qui change barème, cotisations et devise, reste à
 *     l'admin) ;
 *  2. `?country=ISO3` sert le pack d'un AUTRE pays, en lecture seule, pour que
 *     le formulaire se reconfigure (natures d'heures supplémentaires, santé,
 *     ancienneté, devise) AVANT le premier calcul. Cela ne touche pas au
 *     paramétrage du tenant.
 *
 * Le référentiel des niveaux de qualification voyage avec cette réponse : une
 * seule source pour le simulateur, le recrutement et les fiches de poste.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.hoisted(() => { process.env['EMAIL_WAIT_MS'] = '50' })
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  setTokenEpoch:      vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../db/provisioning.js', () => ({ provisionTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: vi.fn().mockResolvedValue({ sent: true }),
  sendTestEmail:            vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@nexusrhci/shared/ssrf-guard', () => ({
  isSafeOutboundUrl:      vi.fn(async () => ({ ok: true as const })),
  assertSafeOutboundUrl:  vi.fn(async (raw: string) => new URL(raw)),
  assertSafeOutboundHost: vi.fn(async () => undefined),
  SsrfBlockedError:       class extends Error {},
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import settingsRoutes from './settings.routes.js'

const TENANT = 'tenant_sotra'
let app: FastifyInstance

const token = (role: string) => app.jwt.sign({
  sub: `u-${role}`, tenantId: 't1', schemaName: TENANT, role,
  email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
})

const get = (url: string, role = 'hr_manager') =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token(role)}` } })

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [{ default_country_code: 'CIV' }], rowCount: 1 })
})

describe('Lecture du pays du tenant', () => {
  it('est ouverte aux rôles RH, pas seulement aux admins', async () => {
    for (const role of ['admin', 'hr_manager', 'hr_officer']) {
      const res = await get('/settings/legislation', role)
      expect(res.statusCode, `${role} : ${res.body}`).toBe(200)
    }
  })

  it('reste fermée à un rôle sans besoin de paie', async () => {
    const res = await get('/settings/legislation', 'employee')
    expect(res.statusCode).toBe(403)
  })

  it('renvoie le pack du tenant, la liste des pays et les niveaux de qualification', async () => {
    const d = (await get('/settings/legislation')).json().data
    expect(d.countryCode).toBe('CIV')
    expect(d.available.length).toBeGreaterThan(10)
    expect(d.qualificationLevels.map((q: { key: string }) => q.key)).toContain('bac5')
    // Les natures d'heures supplémentaires du pays, dont l'écran a besoin.
    expect(d.pack.leaveRules.overtimeRates.weekly).toBe(0.15)
  })
})

describe('Lecture du pack d’un autre pays (?country=)', () => {
  it('sert le pack demandé sans toucher au tenant', async () => {
    const res = await get('/settings/legislation?country=SEN')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.countryCode).toBe('SEN')
    // Aucune lecture du tenant : la réponse ne dépend que du pays demandé.
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('accepte un code en minuscules', async () => {
    expect((await get('/settings/legislation?country=sen')).json().data.countryCode).toBe('SEN')
  })

  it('refuse un pays sans pack plutôt que de replier sur la Côte d’Ivoire', async () => {
    for (const bad of ['FRA', 'XX', 'XXXX']) {
      const res = await get(`/settings/legislation?country=${bad}`)
      expect(res.statusCode, bad).toBe(400)
    }
  })
})
