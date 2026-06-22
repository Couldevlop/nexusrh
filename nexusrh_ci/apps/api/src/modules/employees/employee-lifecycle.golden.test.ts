/**
 * GOLDEN — Cycle de vie complet d'un collaborateur (spine bout-en-bout).
 *
 * Couvre l'enchaînement métier demandé : embauche → génération AUTOMATIQUE du
 * parcours d'intégration → contrat OHADA → paie (CNPS + ITS) → sortie avec
 * archivage cohérent (contrats rompus). Les étapes notes de frais / congés /
 * formation / carrière disposent déjà de golden tests de module dédiés ; ce
 * test verrouille la colonne vertébrale et les transitions que cette session a
 * corrigées (onboarding auto, simulation paie, cohérence employé↔contrat).
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

// Onboarding auto : on vérifie qu'il est déclenché à l'embauche (génération auto
// du parcours d'intégration), sans dépendre de la logique de matching réelle.
const { autoStartMock } = vi.hoisted(() => ({ autoStartMock: vi.fn() }))
vi.mock('../../services/onboarding.service.js', () => ({ autoStartOnboarding: autoStartMock }))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: '', model: 'test', maxTokens: 1024 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'
import contractsRoutes from '../contracts/contracts.routes.js'
import payrollRoutes from '../payroll/payroll.routes.js'

const TENANT = 'tenant_sotra'
const EMP = '11111111-1111-1111-1111-111111111111'
const CONTRACT = '33333333-3333-3333-3333-333333333333'
const DEPT = '55555555-5555-5555-5555-555555555555'

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
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] })
  autoStartMock.mockReset().mockResolvedValue('journey-1')
})

describe('Cycle de vie collaborateur — recrutement → sortie', () => {
  it('1. EMBAUCHE : création employé → 201 + parcours d\'intégration auto-généré', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: EMP, first_name: 'Aya', last_name: 'Koné' }] }) // INSERT employees
    const res = await app.inject({
      method: 'POST', url: '/employees', headers: auth(token(app)),
      payload: {
        firstName: 'Aya', lastName: 'Koné', baseSalary: 250000,
        departmentId: DEPT, jobTitle: 'Comptable', jobLevel: 'confirme',
        contractType: 'cdi', hireDate: '2026-01-06',
      },
    })
    expect(res.statusCode).toBe(201)
    // Génération automatique du parcours d'intégration déclenchée à l'embauche.
    expect(autoStartMock).toHaveBeenCalledTimes(1)
    expect(autoStartMock.mock.calls[0][2]).toMatchObject({ id: EMP, job_title: 'Comptable' })
  })

  it('2. CONTRAT : création d\'un CDI OHADA → 201', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: CONTRACT, employee_id: EMP, status: 'active' }] }) // INSERT contracts
      .mockResolvedValueOnce({ rows: [] })                                                      // UPDATE employees salaire
    const res = await app.inject({
      method: 'POST', url: '/contracts', headers: auth(token(app)),
      payload: {
        employee_id: EMP, type: 'cdi', start_date: '2026-01-06',
        base_salary: 250000, job_title: 'Comptable', job_level: 'confirme',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.status).toBe('active')
  })

  it('3. PAIE : simulation du bulletin → 200 (CNPS + ITS, net > 0)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: EMP, base_salary: '250000', marital_status: 'single', children_count: 0,
        first_name: 'Aya', last_name: 'Koné', cnps_number: 'CI-1', nni: 'enc',
        mobile_money_provider: 'wave', mobile_money_phone: '+22507', hire_date: '2026-01-06',
        legal_entity_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 't1', at_rate: '0.020', has_subsidiaries: false, default_country_code: 'CIV' }] })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate', headers: auth(token(app)),
      payload: { employeeId: EMP, month: '2026-01' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().result.netPayable).toBeGreaterThan(0)
  })

  it('4. SORTIE : archivage employé → 200 + contrats actifs rompus (archive)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ first_name: 'Aya', last_name: 'Koné', email: 'a@x.ci', job_title: 'Comptable' }] }) // snapshot
      .mockResolvedValueOnce({ rows: [] })                 // UPDATE employees deleted_at
      .mockResolvedValueOnce({ rows: [] })                 // UPDATE users
      .mockResolvedValueOnce({ rows: [{ id: CONTRACT }] }) // UPDATE contracts → terminated
    const res = await app.inject({
      method: 'DELETE', url: `/employees/${EMP}`, headers: auth(token(app)),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().terminatedContracts).toBe(1)
    const cascade = sqlMatched(/UPDATE "tenant_sotra"\.contracts[\s\S]*status = 'terminated'/)
    expect(cascade).toBeTruthy()
  })
})
