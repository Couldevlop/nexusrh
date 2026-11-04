/**
 * Garde « son propre dossier » sur POST /payroll/calculate (cible un seul
 * employé) ; /simulate non gardé ; id non UUID sur settings/variable-elements.
 * Routes et authorize réels ; seul le chargeur d'habilitation est mocké.
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
import payrollRoutes from './payroll.routes.js'
import settingsRoutes from '../settings/settings.routes.js'
import type { HabContext } from '../../services/habilitation.service.js'

const ME = '11111111-2222-4333-8444-abcdefabcdef'
const OTHER = '99999999-2222-4333-8444-555555555555'
const DENIED = 'Action interdite sur votre propre dossier'
const ACTIONS = ['view', 'create', 'update', 'delete', 'close', 'validate']

const hab: HabContext = {
  userId: 'u-drh', subgroupId: 'sg', kind: 'siege', legalEntityId: null,
  permissions: new Set(ACTIONS.map((a) => `payroll:${a}`)),
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
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
  loadHabContextMock.mockReset()
  loadHabContextMock.mockResolvedValue(hab)
})

describe('payroll /calculate — garde « propre dossier »', () => {
  for (const [label, id] of [['id exact', ME], ['id MAJUSCULES', ME.toUpperCase()]] as const) {
    it(`POST /payroll/calculate (${label}) → 403, aucune écriture`, async () => {
      const res = await app.inject({
        method: 'POST', url: '/payroll/calculate', headers: auth(), payload: { employeeId: id, month: '2026-10' },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toBe(DENIED)
      expect(writes()).toHaveLength(0)
    })
  }

  it("contrôle négatif : calcul pour un autre → pas 403", async () => {
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate', headers: auth(), payload: { employeeId: OTHER, month: '2026-10' },
    })
    expect(res.statusCode).not.toBe(403)
  })

  it('DELETE /settings/variable-elements/pas-un-uuid → 400, aucune requête', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/settings/variable-elements/pas-un-uuid', headers: auth() })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })
})
