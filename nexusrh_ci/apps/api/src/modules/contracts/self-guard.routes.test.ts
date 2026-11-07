/**
 * Garde « son propre dossier » sur contracts et signed-contracts. Routes et
 * authorize réels ; seul le chargeur de contexte d'habilitation est mocké.
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
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

const { loadHabContextMock } = vi.hoisted(() => ({ loadHabContextMock: vi.fn() }))
vi.mock('../../services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})

import authPlugin from '../../plugins/auth.js'
import contractsRoutes from './contracts.routes.js'
import signedRoutes from './signed-contracts.routes.js'
import type { HabContext } from '../../services/habilitation.service.js'

const ME = '11111111-2222-4333-8444-abcdefabcdef'
const OTHER = '99999999-2222-4333-8444-555555555555'
const RES = '33333333-2222-4333-8444-555555555555'
const DENIED = 'Action interdite sur votre propre dossier'
const ACTIONS = ['view', 'create', 'update', 'delete', 'close', 'validate']

const hab: HabContext = {
  userId: 'u-drh', subgroupId: 'sg', kind: 'siege', legalEntityId: null,
  permissions: new Set(ACTIONS.map((a) => `contracts:${a}`)),
  allEntities: true, sensitive: true, manageHabilitations: false, headOfficeEntityIds: [], selfEmployeeId: ME,
}

let app: FastifyInstance
const auth = (role = 'hr_manager') => ({ authorization: `Bearer ${app.jwt.sign({
  sub: 'u-drh', tenantId: 't1', schemaName: 'tenant_sotra', role,
  email: 'drh@sotra.ci', firstName: 'D', lastName: 'R', employeeId: ME,
})}` })
// Écritures MÉTIER : la trace d'audit des habilitations (tâche 13) est écrite
// sur CHAQUE requête d'un habilité, refus compris — c'est le but ; elle
// n'entre donc pas dans l'invariant « aucune écriture » d'un refus.
const writes = () => queryMock.mock.calls
  .filter((c) => /\b(INSERT|UPDATE|DELETE)\b/i.test(String(c[0])))
  .filter((c) => !/audit_log/i.test(String(c[0])))

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.register(signedRoutes, { prefix: '/contracts/signed' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
  loadHabContextMock.mockReset()
  loadHabContextMock.mockResolvedValue(hab)
})

const newContract = (id: string) => ({ employee_id: id, type: 'cdi', start_date: '2026-01-01', base_salary: 500000 })
const idCases = [['id exact', ME], ['id MAJUSCULES', ME.toUpperCase()]] as const

/**
 * Requêtes MÉTIER : la trace d'audit des habilitations (tâche 13) est écrite
 * sur chaque requête d'un habilité, refus compris — c'est le but ; elle
 * n'entre pas dans l'invariant « aucune requête ».
 */
const businessQueries = () =>
  queryMock.mock.calls.filter((c) => !/audit_log/i.test(String(c[0])))

describe('contrats — garde « propre dossier »', () => {
  for (const [label, id] of idCases) {
    it(`POST /contracts (${label}) → 403, aucune écriture`, async () => {
      const res = await app.inject({ method: 'POST', url: '/contracts', headers: auth(), payload: newContract(id) })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toBe(DENIED)
      expect(writes()).toHaveLength(0)
    })

    const routes: Array<['PATCH' | 'POST' | 'DELETE', string, Record<string, unknown>]> = [
      ['PATCH', `/contracts/${RES}`, { base_salary: 1 }],
      ['POST', `/contracts/${RES}/terminate`, { termination_date: '2026-12-01', termination_reason: 'other' }],
      ['POST', `/contracts/${RES}/renew`, { new_end_date: '2027-12-01' }],
    ]
    for (const [method, url, payload] of routes) {
      it(`${method} ${url.replace(RES, ':id')} contrat de soi (${label}) → 403, aucune écriture`, async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ employee_id: id, type: 'cdd', status: 'active' }] })
        const res = await app.inject({
          method, url, headers: auth(), ...(method === 'DELETE' ? {} : { payload }),
        })
        expect(res.statusCode).toBe(403)
        expect(JSON.parse(res.body).error).toBe(DENIED)
        expect(writes()).toHaveLength(0)
      })
    }

    it(`POST /contracts/signed/employee/:id (${label}) → 403, avant tout stockage`, async () => {
      const res = await app.inject({ method: 'POST', url: `/contracts/signed/employee/${id}`, headers: auth() })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toBe(DENIED)
      expect(businessQueries()).toHaveLength(0)
    })
  }

  it("contrôle négatif : contrat d'un autre → pas 403", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ employee_id: OTHER }] })
    const res = await app.inject({ method: 'PATCH', url: `/contracts/${RES}`, headers: auth(), payload: { base_salary: 1 } })
    expect(res.statusCode).not.toBe(403)
  })

  it('contrôle négatif : création pour un autre → pas 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/contracts', headers: auth(), payload: newContract(OTHER) })
    expect(res.statusCode).not.toBe(403)
  })

  // DELETE est réservé à l'admin du tenant (hors grille, sans garde) : seul le 400 est vérifié.
  for (const [method, suffix] of [['PATCH', ''], ['POST', '/terminate'], ['POST', '/renew'], ['DELETE', '']] as const) {
    it(`${method} /contracts/pas-un-uuid${suffix} → 400, aucune requête`, async () => {
      const res = await app.inject({
        method, url: `/contracts/pas-un-uuid${suffix}`, headers: auth(method === 'DELETE' ? 'admin' : 'hr_manager'),
        ...(method === 'DELETE' ? {} : { payload: { base_salary: 1 } }),
      })
      expect(res.statusCode).toBe(400)
      expect(businessQueries()).toHaveLength(0)
    })
  }
})
