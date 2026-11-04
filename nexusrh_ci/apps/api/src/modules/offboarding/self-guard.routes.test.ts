/**
 * Garde « son propre dossier » sur offboarding. Routes et authorize réels ;
 * seul le chargeur de contexte d'habilitation est mocké.
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
import offboardingRoutes from './offboarding.routes.js'
import type { HabContext } from '../../services/habilitation.service.js'

const ME = '11111111-2222-4333-8444-abcdefabcdef'
const OTHER = '99999999-2222-4333-8444-555555555555'
const RES = '33333333-2222-4333-8444-555555555555'
const DENIED = 'Action interdite sur votre propre dossier'
const ACTIONS = ['view', 'create', 'update', 'delete', 'close', 'validate']

const hab: HabContext = {
  userId: 'u-drh', subgroupId: 'sg', kind: 'siege', legalEntityId: null,
  permissions: new Set(ACTIONS.map((a) => `lifecycle:${a}`)),
  allEntities: true, sensitive: true, manageHabilitations: false, headOfficeEntityIds: [], selfEmployeeId: ME,
}

let app: FastifyInstance
const auth = () => ({ authorization: `Bearer ${app.jwt.sign({
  sub: 'u-drh', tenantId: 't1', schemaName: 'tenant_sotra', role: 'hr_manager',
  email: 'drh@sotra.ci', firstName: 'D', lastName: 'R', employeeId: ME,
})}` })
const writes = () => queryMock.mock.calls.filter((c) => /\b(INSERT|UPDATE|DELETE)\b/i.test(String(c[0])))

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
  loadHabContextMock.mockReset()
  loadHabContextMock.mockResolvedValue(hab)
})

const idCases = [['id exact', ME], ['id MAJUSCULES', ME.toUpperCase()]] as const
const openBody = (id: string) => ({ employeeId: id, departureType: 'demission', departureDate: '2026-12-01' })

describe('offboarding — garde « propre dossier »', () => {
  for (const [label, id] of idCases) {
    it(`POST /offboarding (${label}) → 403, aucune écriture`, async () => {
      const res = await app.inject({ method: 'POST', url: '/offboarding', headers: auth(), payload: openBody(id) })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toBe(DENIED)
      expect(writes()).toHaveLength(0)
    })

    const routes: Array<['PATCH' | 'POST' | 'DELETE', string, Record<string, unknown>]> = [
      ['PATCH', `/offboarding/${RES}`, { reason: 'x' }],
      ['POST', `/offboarding/${RES}/settlement`, {}],
      ['DELETE', `/offboarding/${RES}`, {}],
    ]
    for (const [method, url, payload] of routes) {
      it(`${method} ${url.replace(RES, ':id')} dossier de soi (${label}) → 403, aucune écriture`, async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ employee_id: id, status: 'open' }] })
        const res = await app.inject({
          method, url, headers: auth(), ...(method === 'DELETE' ? {} : { payload }),
        })
        expect(res.statusCode).toBe(403)
        expect(JSON.parse(res.body).error).toBe(DENIED)
        expect(writes()).toHaveLength(0)
      })
    }
  }

  it("contrôle négatif : dossier d'un autre → pas 403", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ employee_id: OTHER, status: 'open' }] })
    const res = await app.inject({ method: 'PATCH', url: `/offboarding/${RES}`, headers: auth(), payload: { reason: 'x' } })
    expect(res.statusCode).not.toBe(403)
  })

  it('contrôle négatif : ouverture pour un autre → pas 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/offboarding', headers: auth(), payload: openBody(OTHER) })
    expect(res.statusCode).not.toBe(403)
  })

  for (const [method, suffix] of [['PATCH', ''], ['POST', '/settlement'], ['DELETE', '']] as const) {
    it(`${method} /offboarding/pas-un-uuid${suffix} → 400, aucune requête`, async () => {
      const res = await app.inject({
        method, url: `/offboarding/pas-un-uuid${suffix}`, headers: auth(),
        ...(method === 'DELETE' ? {} : { payload: { reason: 'x' } }),
      })
      expect(res.statusCode).toBe(400)
      expect(queryMock).not.toHaveBeenCalled()
    })
  }
})
