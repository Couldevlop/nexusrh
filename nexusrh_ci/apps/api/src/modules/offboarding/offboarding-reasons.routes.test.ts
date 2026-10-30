/**
 * Motifs de départ structurés (marque employeur, lot 2) :
 *   - catégorie choisie dans la liste PARAMÉTRABLE du tenant (défauts sinon) ;
 *   - GET /offboarding/reason-stats : agrégats seulement, RBAC lecture d'indicateurs.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import offboardingRoutes from './offboarding.routes.js'
import {
  DEFAULT_DEPARTURE_REASON_CATEGORIES, parseDepartureReasonCategories, departureReasonCategoriesSchema,
} from '../../services/departure-reasons.service.js'

const SCHEMA = 'tenant_sotra'
const EMP = '11111111-1111-4111-8111-111111111111'
function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}

/** Répond selon le SQL : liste du tenant, agrégats, INSERT/UPDATE de dossier. */
function routeQueries(opts: { categories?: unknown; stats?: Array<Record<string, unknown>> } = {}) {
  queryMock.mockImplementation(async (sql: string) => {
    const s = String(sql)
    if (s.includes('departure_reason_categories FROM platform.tenants')) {
      return { rows: [{ departure_reason_categories: opts.categories ?? null }] }
    }
    if (s.includes('GROUP BY reason_category, departure_type')) return { rows: opts.stats ?? [] }
    if (s.includes('INSERT INTO "tenant_sotra".offboarding_cases')) return { rows: [{ id: 'case-1' }] }
    if (s.includes('SELECT status, employee_id')) return { rows: [{ status: 'open', employee_id: EMP, departure_date: '2026-10-01' }] }
    if (s.includes('UPDATE "tenant_sotra".offboarding_cases SET')) return { rows: [{ id: 'case-1' }] }
    return { rows: [] }
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(offboardingRoutes, { prefix: '/offboarding' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('Liste paramétrable des motifs', () => {
  it('défauts : rémunération, carrière, management, conditions, mobilité, personnel, autre', () => {
    expect(parseDepartureReasonCategories(null).map((c) => c.key)).toEqual(
      ['remuneration', 'career_growth', 'management', 'working_conditions', 'relocation', 'personal', 'other'])
  })
  it('liste illisible en base → défauts (jamais bloquant)', () => {
    expect(parseDepartureReasonCategories([{ key: 'BAD KEY', label: '' }])).toHaveLength(DEFAULT_DEPARTURE_REASON_CATEGORIES.length)
  })
  it('refuse les clés en double', () => {
    const r = departureReasonCategoriesSchema.safeParse([{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }])
    expect(r.success).toBe(false)
  })
})

describe('POST/PATCH /offboarding — catégorie de motif', () => {
  it('enregistre une catégorie de la liste par défaut (texte libre conservé)', async () => {
    routeQueries()
    const res = await app.inject({
      method: 'POST', url: '/offboarding',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: EMP, departureType: 'demission', departureDate: '2026-11-01', reasonCategory: 'remuneration', reason: 'Offre +30 % ailleurs' },
    })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO "tenant_sotra".offboarding_cases'))!
    expect(String(insert[0])).toContain('reason_category')
    expect(insert[1]).toContain('remuneration')
    expect(insert[1]).toContain('Offre +30 % ailleurs')
  })

  it('refuse une catégorie absente de la liste du tenant (400)', async () => {
    routeQueries({ categories: [{ key: 'salaire', label: 'Salaire' }] })
    const res = await app.inject({
      method: 'POST', url: '/offboarding',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: EMP, departureType: 'demission', departureDate: '2026-11-01', reasonCategory: 'remuneration' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).code).toBe('UNKNOWN_REASON_CATEGORY')
  })

  it('accepte une catégorie propre au tenant', async () => {
    routeQueries({ categories: [{ key: 'salaire', label: 'Salaire' }] })
    const res = await app.inject({
      method: 'PATCH', url: '/offboarding/case-1',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { reasonCategory: 'salaire' },
    })
    expect(res.statusCode).toBe(200)
    const upd = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE "tenant_sotra".offboarding_cases SET'))!
    expect(String(upd[0])).toContain('reason_category = $1')
  })

  it('sans catégorie : aucune lecture de la liste (comportement historique)', async () => {
    routeQueries()
    await app.inject({
      method: 'POST', url: '/offboarding',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: EMP, departureType: 'demission', departureDate: '2026-11-01' },
    })
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('departure_reason_categories'))).toBe(false)
  })
})

describe('GET /offboarding/reason-stats', () => {
  it('agrège par catégorie (libellés du tenant) et par type de départ', async () => {
    routeQueries({
      stats: [
        { reason_category: 'remuneration', departure_type: 'demission', count: 6 },
        { reason_category: 'management', departure_type: 'demission', count: 2 },
        { reason_category: null, departure_type: 'licenciement', count: 7 },
      ],
    })
    const res = await app.inject({
      method: 'GET', url: '/offboarding/reason-stats?from=2026-01-01&to=2026-12-31',
      headers: { authorization: `Bearer ${tokenFor(app, 'dg')}` },
    })
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body).data
    expect(d.total).toBe(15)
    expect(d.byCategory[0]).toEqual({ key: 'unspecified', label: null, count: 7, share: 46.7 })
    expect(d.byCategory[1]).toEqual({ key: 'remuneration', label: 'Rémunération', count: 6, share: 40 })
    expect(d.byDepartureType[0]).toEqual({ type: 'demission', count: 8, share: 53.3 })
    // Agrégats uniquement : aucun identifiant nominatif
    expect(res.body).not.toContain('employee_id')
  })

  it('anonymat : les catégories de moins de 5 départs sont regroupées (« Autres »)', async () => {
    routeQueries({
      stats: [
        { reason_category: 'remuneration', departure_type: 'demission', count: 5 },
        { reason_category: 'management', departure_type: 'demission', count: 2 },
        { reason_category: 'personal', departure_type: 'demission', count: 1 },
      ],
    })
    const res = await app.inject({
      method: 'GET', url: '/offboarding/reason-stats',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    const d = JSON.parse(res.body).data
    expect(d.minGroupSize).toBe(5)
    expect(d.byCategory.map((c: { key: string }) => c.key)).toEqual(['remuneration', 'others_small'])
    expect(d.byCategory[1]).toEqual({ key: 'others_small', label: 'Autres (effectif < 5)', count: 3, share: 37.5 })
    expect(JSON.stringify(d.byCategory)).not.toContain('management')
  })

  it('refuse une date mal formée (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/offboarding/reason-stats?from=hier',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it.each(['admin', 'hr_manager', 'dg', 'readonly'])('autorise %s', async (role) => {
    routeQueries()
    const res = await app.inject({
      method: 'GET', url: '/offboarding/reason-stats',
      headers: { authorization: `Bearer ${tokenFor(app, role)}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it.each(['hr_officer', 'manager', 'employee'])('refuse %s (403)', async (role) => {
    const res = await app.inject({
      method: 'GET', url: '/offboarding/reason-stats',
      headers: { authorization: `Bearer ${tokenFor(app, role)}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
