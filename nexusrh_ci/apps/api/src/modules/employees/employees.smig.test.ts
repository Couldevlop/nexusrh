/**
 * GET /employees/:id/smig — SMIG applicable au salarié : pack de sa filiale,
 * sinon pays du tenant (plus de 75 000 FCFA ivoiriens en dur côté front).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
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

vi.mock('@nexusrhci/shared/crypto', () => ({
  encryptIfPresent: vi.fn((v) => v),
  decryptIfPresent: vi.fn((v) => v),
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

const EMP_ID = '11111111-1111-1111-1111-111111111111'
const LE_ID = '22222222-2222-2222-2222-222222222222'

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: 'tenant_sotra', role,
    email: `${role}@sotra.ci`, firstName: 'Test', lastName: 'User', employeeId: null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

const get = (role: string, id = EMP_ID) => app.inject({
  method: 'GET', url: `/employees/${id}/smig`,
  headers: { authorization: `Bearer ${tokenFor(app, role)}` },
})

describe('GET /employees/:id/smig', () => {
  it('filiale hors CI → SMIG du pack de la filiale', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ legal_entity_id: LE_ID }] })  // employé
      .mockResolvedValueOnce({ rows: [{ id: 't1', has_subsidiaries: true, default_country_code: 'CIV', at_rate: '0.02' }] })
      .mockResolvedValueOnce({ rows: [{ id: LE_ID, at_rate: null, legislation_pack_code: null, country_code: 'BFA' }] })
    const res = await get('hr_manager')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual({ smig: 45_000, currency: 'XOF', legislationPackCode: 'BFA-2024' })
  })

  it('sans filiale → SMIG du pays du tenant', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ legal_entity_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 't1', has_subsidiaries: false, default_country_code: 'SEN', at_rate: '0.03' }] })
    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.smig).toBe(64_710)
  })

  it('404 si employé introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await get('admin')).statusCode).toBe(404)
  })

  it('400 si id non UUID', async () => {
    expect((await get('admin', 'abc')).statusCode).toBe(400)
  })

  it('403 pour un employé (RBAC)', async () => {
    expect((await get('employee')).statusCode).toBe(403)
  })

  it('500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    expect((await get('admin')).statusCode).toBe(500)
  })
})
