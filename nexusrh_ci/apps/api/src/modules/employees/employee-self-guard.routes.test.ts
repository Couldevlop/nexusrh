/**
 * Garde « son propre dossier » (habilitations) sur PATCH /employees/:id.
 * Le moteur (loadHabContext) est mocké ; le reste (authorize, handler) est réel.
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
import employeesRoutes from './employees.routes.js'
import type { HabContext } from '../../services/habilitation.service.js'

const ME = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

const hab: HabContext = {
  userId: 'u-drh', subgroupId: 'sg', kind: 'siege', legalEntityId: null,
  permissions: new Set(['employees:update', 'employees:view']), allEntities: true,
  sensitive: false, manageHabilitations: false, headOfficeEntityIds: [], selfEmployeeId: ME,
}

let app: FastifyInstance
const patch = (id: string, body: unknown) => app.inject({
  method: 'PATCH', url: `/employees/${id}`, payload: body as object,
  headers: { authorization: `Bearer ${app.jwt.sign({
    sub: 'u-drh', tenantId: 't1', schemaName: 'tenant_sotra', role: 'hr_manager',
    email: 'drh@sotra.ci', firstName: 'D', lastName: 'R', employeeId: ME,
  })}` },
})

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
  loadHabContextMock.mockReset()
})

/**
 * Requêtes MÉTIER : la trace d'audit des habilitations (tâche 13) est écrite
 * sur chaque requête d'un habilité, refus compris — c'est le but ; elle
 * n'entre pas dans l'invariant « la base n'est pas touchée ».
 */
const businessQueries = () =>
  queryMock.mock.calls.filter((c) => !/audit_log/i.test(String(c[0])))

describe('PATCH /employees/:id — son propre dossier', () => {
  it('DRH habilité modifiant son propre base_salary → 403 sans toucher la base', async () => {
    loadHabContextMock.mockResolvedValue(hab)
    const res = await patch(ME, { baseSalary: 9_000_000 })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('Action interdite sur votre propre dossier')
    expect(businessQueries()).toHaveLength(0)
  })

  it('id en MAJUSCULES (même fiche pour PostgreSQL) → 403 aussi', async () => {
    loadHabContextMock.mockResolvedValue(hab)
    const res = await patch(ME.toUpperCase(), { baseSalary: 9_000_000 })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('Action interdite sur votre propre dossier')
    expect(businessQueries()).toHaveLength(0)
  })

  it('DRH habilité modifiant un autre dossier → traité normalement (404, fiche absente)', async () => {
    loadHabContextMock.mockResolvedValue(hab)
    const res = await patch(OTHER, { firstName: 'Awa' })
    expect(res.statusCode).toBe(404)
  })

  it('utilisateur hérité (sans affectation) sur son propre id : non bloqué (404)', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const res = await patch(ME, { firstName: 'Awa' })
    expect(res.statusCode).toBe(404)
  })
})
