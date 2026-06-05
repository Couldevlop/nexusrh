/**
 * GOLDEN — Câblage POST /employees → auto-création du parcours d'intégration.
 *
 * La logique de matching (selectBestTemplate…) est couverte par
 * onboarding.golden.test.ts. Ici on vérifie le CÂBLAGE :
 *   - création d'employé OK → autoStartOnboarding appelé avec les données du
 *     nouvel employé (poste, séniorité, département, date d'embauche) ;
 *   - l'échec de l'onboarding NE bloque PAS la création (best-effort) ;
 *   - validation refusée → pas d'appel onboarding.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore:  {},
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/crypto.js', () => ({
  encryptIfPresent: vi.fn((v: string | null | undefined) => v ?? null),
  decryptIfPresent: vi.fn((v: string | null | undefined) => v ?? null),
}))

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }))
vi.mock('../../services/integrations.service.js', () => ({
  emitIntegrationEvent: emitMock,
}))

const { autoStartMock } = vi.hoisted(() => ({ autoStartMock: vi.fn() }))
vi.mock('../../services/onboarding.service.js', () => ({
  autoStartOnboarding: autoStartMock,
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

let app: FastifyInstance
const DEPT = '55555555-5555-5555-5555-555555555555'

function hrToken() {
  return app.jwt.sign({ sub: 'u-rh', tenantId: 't1', schemaName: 'tenant_sotra', role: 'hr_manager',
    email: 'rh@sotra.ci', firstName: 'R', lastName: 'H', employeeId: null })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  autoStartMock.mockReset().mockResolvedValue('journey-1')
  emitMock.mockReset()
})

describe('POST /employees — déclenchement automatique de l\'onboarding', () => {
  const payload = {
    firstName: 'Aminata', lastName: 'Koné', email: 'aminata.kone@sotra.ci',
    jobTitle: 'Conductrice de bus', jobLevel: 'junior',
    departmentId: DEPT, hireDate: '2026-07-01', baseSalary: 180_000,
  }

  it('création OK → 201 et autoStartOnboarding appelé avec les données du nouvel employé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-new', first_name: 'Aminata' }] }) // INSERT employees
      .mockResolvedValueOnce({ rows: [] })                                          // audit
    const res = await app.inject({ method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${hrToken()}` }, payload })
    expect(res.statusCode).toBe(201)

    // Laisser la micro-tâche du hook best-effort se résoudre
    await new Promise((r) => setImmediate(r))

    expect(autoStartMock).toHaveBeenCalledTimes(1)
    const [, schema, employee, createdBy] = autoStartMock.mock.calls[0]!
    expect(schema).toBe('tenant_sotra')
    expect(employee).toEqual({
      id: 'emp-new',
      job_title: 'Conductrice de bus',
      job_level: 'junior',
      department_id: DEPT,
      hire_date: '2026-07-01',
    })
    expect(createdBy).toBe('u-rh')
  })

  it('échec de l\'onboarding → la création d\'employé reste un 201 (best-effort)', async () => {
    autoStartMock.mockRejectedValueOnce(new Error('onboarding KO'))
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-new' }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${hrToken()}` }, payload })
    expect(res.statusCode).toBe(201)
    await new Promise((r) => setImmediate(r))
    expect(autoStartMock).toHaveBeenCalledTimes(1)
  })

  it('payload invalide → 400 et AUCUN parcours créé', async () => {
    const res = await app.inject({ method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${hrToken()}` },
      payload: { firstName: 'X' } })
    expect(res.statusCode).toBe(400)
    expect(autoStartMock).not.toHaveBeenCalled()
  })

  it('salaire < SMIG → 422 et AUCUN parcours créé', async () => {
    const res = await app.inject({ method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${hrToken()}` },
      payload: { ...payload, baseSalary: 50_000 } })
    expect(res.statusCode).toBe(422)
    expect(autoStartMock).not.toHaveBeenCalled()
  })
})
