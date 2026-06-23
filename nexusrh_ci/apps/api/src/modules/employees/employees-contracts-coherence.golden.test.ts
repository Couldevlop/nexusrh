/**
 * GOLDEN — Cohérence employé ↔ contrat + modification d'un employé.
 *
 * Régressions corrigées :
 *   1. « On n'arrive pas à modifier un employé » — la modification d'un champ
 *      simple (ajout du n° CNPS a posteriori, salaire…) doit aboutir (200).
 *   2. Champ `address` (colonne jsonb) modifié → 500 (« invalid input syntax for
 *      type json »). Désormais encodé en JSON (cast ::jsonb).
 *   3. « Impossible de rompre un contrat » / contrat orphelin : à l'archivage
 *      d'un employé, ses contrats ACTIFS doivent basculer en `terminated`
 *      (cohérence — plus de contrat actif sur un dossier qui n'existe plus).
 *   4. Les contrats d'un employé archivé restent CONSULTABLES (liste sans filtre
 *      deleted_at + drapeau employee_archived) au lieu de disparaître.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore: {},
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../utils/crypto.js', () => ({
  encryptIfPresent: vi.fn((v: string | null | undefined) => (v ? `enc(${v})` : null)),
  decryptIfPresent: vi.fn((v: string | null | undefined) => v ?? null),
}))
vi.mock('../../services/integrations.service.js', () => ({ emitIntegrationEvent: vi.fn() }))
vi.mock('../../services/onboarding.service.js', () => ({ autoStartOnboarding: vi.fn().mockResolvedValue(null) }))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'
import contractsRoutes from '../contracts/contracts.routes.js'

const TENANT = 'tenant_sotra'
const EMP = '11111111-1111-1111-1111-111111111111'
const CONTRACT = '33333333-3333-3333-3333-333333333333'

function token(app: FastifyInstance, role = 'hr_manager') {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` })
const calls = () => queryMock.mock.calls
const sqlMatched = (re: RegExp) => calls().find(c => re.test(c[0] as string))

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('PATCH /employees/:id — modification d\'un dossier', () => {
  it('ajout du numéro CNPS a posteriori (premier emploi) → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: EMP, cnps_number: 'CI12345678A' }] }) // UPDATE RETURNING
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: auth(token(app)), payload: { cnpsNumber: 'CI12345678A' },
    })
    expect(res.statusCode).toBe(200)
    const upd = sqlMatched(/UPDATE "tenant_sotra"\.employees SET/)
    expect(upd).toBeTruthy()
    expect(upd![0]).toMatch(/cnps_number = \$1/)
  })

  it('modification de l\'adresse (colonne jsonb) → 200, encodée en JSON (anti-500)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: EMP }] })
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`,
      headers: auth(token(app)), payload: { address: '2 rue des Jardins, Cocody' },
    })
    expect(res.statusCode).toBe(200)
    const upd = sqlMatched(/UPDATE "tenant_sotra"\.employees SET/)!
    expect(upd[0]).toMatch(/address = \$1::jsonb/)            // cast jsonb explicite
    expect(upd[1]).toContain(JSON.stringify('2 rue des Jardins, Cocody'))
  })
})

describe('DELETE /employees/:id — archivage + cascade contrats', () => {
  it('archive l\'employé ET rompt ses contrats actifs (cohérence)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ first_name: 'Kouassi', last_name: 'Jean', email: 'k@x.ci', job_title: 'Chauffeur' }] }) // snapshot
      .mockResolvedValueOnce({ rows: [] })                       // UPDATE employees deleted_at
      .mockResolvedValueOnce({ rows: [] })                       // UPDATE users
      .mockResolvedValueOnce({ rows: [{ id: CONTRACT }] })       // UPDATE contracts RETURNING
    const res = await app.inject({
      method: 'DELETE', url: `/employees/${EMP}`,
      headers: auth(token(app)),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().terminatedContracts).toBe(1)
    // La cascade a bien rompu les contrats actifs de l'employé.
    const cascade = sqlMatched(/UPDATE "tenant_sotra"\.contracts[\s\S]*status = 'terminated'/)
    expect(cascade).toBeTruthy()
    expect(cascade![0]).toMatch(/status = 'active'/)   // seulement les actifs
    expect(cascade![1]).toEqual([EMP])
  })
})

describe('GET /contracts — visibilité archive (employé supprimé)', () => {
  it('n\'exclut plus les contrats d\'un employé archivé et expose employee_archived', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { id: CONTRACT, status: 'terminated', first_name: 'Kouassi', last_name: 'Jean', employee_archived: true },
    ] })
    const res = await app.inject({
      method: 'GET', url: '/contracts',
      headers: auth(token(app)),
    })
    expect(res.statusCode).toBe(200)
    const sql = (calls().find(c => /FROM "tenant_sotra"\.contracts/.test(c[0] as string))![0]) as string
    expect(sql).toMatch(/employee_archived/)
    expect(sql).not.toMatch(/e\.deleted_at IS NULL/)   // plus de filtre qui masquait l'archive
    expect(res.json().data[0].employee_archived).toBe(true)
  })
})

describe('POST /contracts/:id/terminate — rupture + désactivation employé', () => {
  it('rompt le contrat et désactive l\'employé lié (cohérence inverse)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP }] }) // UPDATE contracts RETURNING employee_id
      .mockResolvedValueOnce({ rows: [] })                     // UPDATE employees is_active=false
      .mockResolvedValueOnce({ rows: [] })                     // INSERT hr_events
    const res = await app.inject({
      method: 'POST', url: `/contracts/${CONTRACT}/terminate`,
      headers: auth(token(app)),
      payload: { termination_date: '2026-06-30', termination_reason: 'resignation' },
    })
    expect(res.statusCode).toBe(200)
    expect(sqlMatched(/UPDATE "tenant_sotra"\.contracts[\s\S]*status = 'terminated'/)).toBeTruthy()
    expect(sqlMatched(/UPDATE "tenant_sotra"\.employees SET is_active = false/)).toBeTruthy()
  })
})
