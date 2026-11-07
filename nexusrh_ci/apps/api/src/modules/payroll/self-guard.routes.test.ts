/**
 * Garde « son propre dossier » sur payroll-workflow (variables PUT/validate),
 * discipline (POST) et settings (DELETE variable-elements). Moteur
 * d'habilitation mocké ; authorize et handlers réels.
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
import payrollWorkflowRoutes from './payroll-workflow.routes.js'
import disciplineRoutes from '../discipline/discipline.routes.js'
import settingsRoutes from '../settings/settings.routes.js'
import type { HabContext } from '../../services/habilitation.service.js'

const ME = '11111111-2222-4333-8444-abcdefabcdef'
const PERIOD = '22222222-2222-4333-8444-555555555555'
const DENIED = 'Action interdite sur votre propre dossier'

const hab: HabContext = {
  userId: 'u-drh', subgroupId: 'sg', kind: 'siege', legalEntityId: null,
  permissions: new Set([
    'payroll_multi:update', 'payroll_multi:view', 'payroll_multi:validate', 'payroll_multi:create', 'payroll_multi:close', 'discipline:create',
    'discipline:update', 'discipline:view', 'payroll:update', 'payroll:delete',
  ]),
  allEntities: true, sensitive: true, manageHabilitations: false, headOfficeEntityIds: [], selfEmployeeId: ME,
}

let app: FastifyInstance
const auth = () => ({ authorization: `Bearer ${app.jwt.sign({
  sub: 'u-drh', tenantId: 't1', schemaName: 'tenant_sotra', role: 'hr_manager',
  email: 'drh@sotra.ci', firstName: 'D', lastName: 'R', employeeId: ME,
})}` })

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(payrollWorkflowRoutes, { prefix: '/payroll-workflow' })
  await app.register(disciplineRoutes, { prefix: '/discipline' })
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

/**
 * Requetes METIER : la trace d'audit des habilitations (tache 13) est ecrite
 * sur chaque requete d'un habilite, refus compris -- c'est le but ; elle
 * n'entre pas dans l'invariant « la base n'est pas touchee ».
 */
const businessQueries = () =>
  queryMock.mock.calls.filter((c) => !/audit_log/i.test(String(c[0])))

describe('garde « propre dossier » — paie / discipline / éléments variables', () => {
  for (const [label, id] of [['id exact', ME], ['id MAJUSCULES', ME.toUpperCase()]] as const) {
    it(`PUT payroll-workflow variables/:employeeId (${label}) → 403`, async () => {
      const res = await app.inject({
        method: 'PUT', url: `/payroll-workflow/periods/${PERIOD}/variables/${id}`,
        headers: auth(), payload: { values: {} },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toBe(DENIED)
    })

    it(`POST payroll-workflow variables/:employeeId/validate (${label}) → 403`, async () => {
      const res = await app.inject({
        method: 'POST', url: `/payroll-workflow/periods/${PERIOD}/variables/${id}/validate`,
        headers: auth(), payload: { mode: 'none' },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toBe(DENIED)
    })

    it(`POST discipline (${label}) → 403, aucune insertion`, async () => {
      const res = await app.inject({
        method: 'POST', url: '/discipline', headers: auth(),
        payload: { employeeId: id, type: 'avertissement', reason: 'Retards répétés', actionDate: '2026-10-01' },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toBe(DENIED)
      expect(businessQueries()).toHaveLength(0)
    })
  }

  it('DELETE settings/variable-elements/:id sur sa propre ligne → 403, pas de DELETE', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ employee_id: ME.toUpperCase() }] })
    const res = await app.inject({ method: 'DELETE', url: '/settings/variable-elements/33333333-2222-4333-8444-555555555555', headers: auth() })
    expect(res.statusCode).toBe(403)
    expect(businessQueries()).toHaveLength(1)
  })

  it("PUT variables d'un autre salarié → non bloqué par la garde", async () => {
    const res = await app.inject({
      method: 'PUT', url: `/payroll-workflow/periods/${PERIOD}/variables/99999999-2222-4333-8444-555555555555`,
      headers: auth(), payload: { values: {} },
    })
    expect(res.statusCode).not.toBe(403)
  })
})
