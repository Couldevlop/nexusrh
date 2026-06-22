/**
 * GOLDEN — Couplage sortie ↔ employé : clôturer un dossier de sortie archive
 * l'employé et rompt/annule ses processus liés (aucun dossier orphelin).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import offboardingRoutes from './offboarding.routes.js'

const TENANT = 'tenant_sotra'
const EMP = '11111111-1111-1111-1111-111111111111'
const CASE_ID = '99999999-9999-9999-9999-999999999999'

function token(app: FastifyInstance, role = 'hr_manager') {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` })
const sqlMatched = (re: RegExp) => queryMock.mock.calls.find(c => re.test(c[0] as string))

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(offboardingRoutes, { prefix: '/offboarding' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('PATCH /offboarding/:id — couplage clôture ↔ archivage employé', () => {
  it('clôturer (settled → closed) archive l\'employé + cascade', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'settled', employee_id: EMP }] }) // cur
      .mockResolvedValueOnce({ rows: [{ id: CASE_ID, status: 'closed' }] })       // UPDATE offboarding
    const res = await app.inject({
      method: 'PATCH', url: `/offboarding/${CASE_ID}`,
      headers: auth(token(app)), payload: { status: 'closed' },
    })
    expect(res.statusCode).toBe(200)
    // L'employé a été archivé via la cascade partagée.
    const archive = sqlMatched(/UPDATE "tenant_sotra"\.employees SET deleted_at = now\(\), is_active = false/)
    expect(archive).toBeTruthy()
    expect(archive![1]).toEqual([EMP])
    // La rupture des contrats actifs fait partie de la cascade.
    expect(sqlMatched(/UPDATE "tenant_sotra"\.contracts[\s\S]*status = 'terminated'/)).toBeTruthy()
    // Trace d'audit dédiée.
    expect(queryMock.mock.calls.some(c => Array.isArray(c[1]) && c[1].includes('offboarding.employee_archived'))).toBe(true)
  })

  it('une transition NON terminale (open → in_progress) n\'archive PAS l\'employé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'open', employee_id: EMP }] }) // cur
      .mockResolvedValueOnce({ rows: [{ id: CASE_ID, status: 'in_progress' }] }) // UPDATE
    const res = await app.inject({
      method: 'PATCH', url: `/offboarding/${CASE_ID}`,
      headers: auth(token(app)), payload: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(200)
    expect(sqlMatched(/UPDATE "tenant_sotra"\.employees SET deleted_at = now\(\)/)).toBeFalsy()
  })

  it('refuse une transition de statut interdite (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'closed', employee_id: EMP }] }) // cur (terminal)
    const res = await app.inject({
      method: 'PATCH', url: `/offboarding/${CASE_ID}`,
      headers: auth(token(app)), payload: { status: 'open' },
    })
    expect(res.statusCode).toBe(409)
  })
})
