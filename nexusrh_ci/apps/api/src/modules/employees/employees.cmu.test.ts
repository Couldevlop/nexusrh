/**
 * Bénéficiaires CMU (loi n° 2014-131) sur la fiche employé : conjoint sans
 * emploi couvert et nombre d'enfants couverts, modifiables par les RH (PATCH).
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
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@nexusrhci/shared/crypto', () => ({
  encryptIfPresent: vi.fn((v) => v),
  decryptIfPresent: vi.fn((v) => v),
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

const SCHEMA = 'tenant_sotra'
const EMP_ID = '22222222-2222-2222-2222-222222222222'

function tokenFor(app: FastifyInstance, role: string, employeeId: string | null = null) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId,
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
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

const updateCall = () => queryMock.mock.calls.find((c) => String(c[0]).startsWith('UPDATE "tenant_sotra".employees SET'))

describe('PATCH /employees/:id — bénéficiaires CMU (loi n° 2014-131)', () => {
  it('conjoint couvert + enfants couverts : colonnes cmu_* mises à jour', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: EMP_ID }] }) // UPDATE
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { cmuSpouseCovered: true, cmuChildrenCovered: 2 },
    })
    expect(res.statusCode).toBe(200)
    const upd = updateCall()
    expect(String(upd?.[0])).toContain('cmu_spouse_covered = $1')
    expect(String(upd?.[0])).toContain('cmu_children_covered = $2')
    expect(upd?.[1]).toEqual([true, 2, EMP_ID])
  })

  it('enfants couverts remis à null : retour au nombre d’enfants à charge', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: EMP_ID }] })
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { cmuChildrenCovered: null },
    })
    expect(res.statusCode).toBe(200)
    expect(updateCall()?.[1]).toEqual([null, EMP_ID])
  })

  it('valeurs invalides → 400 (négatif, décimal, booléen texte)', async () => {
    for (const payload of [{ cmuChildrenCovered: -1 }, { cmuChildrenCovered: 1.5 }, { cmuSpouseCovered: 'oui' }]) {
      const res = await app.inject({
        method: 'PATCH', url: `/employees/${EMP_ID}`,
        headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` }, payload,
      })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(updateCall()).toBeUndefined()
  })

  it('un salarié ne peut pas modifier sa propre couverture CMU (champ hors self-service)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', EMP_ID)}` },
      payload: { cmuSpouseCovered: true },
    })
    expect(res.statusCode).toBe(400)
    expect(updateCall()).toBeUndefined()
  })
})
