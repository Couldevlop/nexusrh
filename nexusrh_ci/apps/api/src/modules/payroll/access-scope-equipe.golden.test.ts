/**
 * GOLDEN — Isolation des données par périmètre (OWASP A01 / IDOR)
 *
 * Règle RBAC (matrice CLAUDE.md) : le manager n'a AUCUN accès à la paie. On
 * vérifie ici qu'un manager est refusé (403) sur le bulletin transparent — y
 * compris pour un employé de son équipe — et qu'un employee ne voit que SES
 * bulletins.
 *
 * Ces garanties sont critiques (RGPD + confidentialité salariale) : un bug de
 * scope exposerait les salaires de tout le tenant.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
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
    ai: { apiKey: '', model: 'test', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import payrollRoutes from './payroll.routes.js'

const TENANT = 'tenant_sotra'
const EMP_IN_TEAM  = '11111111-1111-1111-1111-111111111111'
const EMP_OUT_TEAM = '22222222-2222-2222-2222-222222222222'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{
  sub: string; email: string; employeeId: string
}> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? 'u-' + role,
    tenantId: 't1',
    schemaName: TENANT,
    role,
    email: opts.email ?? `${role}@sotra.ci`,
    firstName: 'Test',
    lastName: 'User',
    employeeId: opts.employeeId ?? null,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })
// Draine les éventuelles promesses (audit log fire-and-forget) lancées par le
// handler avant de réinitialiser les mocks au test suivant → isolation stricte.
afterEach(async () => { await new Promise((r) => setTimeout(r, 0)) })

const SLIP_ID = '33333333-3333-3333-3333-333333333333'

function slipRow(employeeId: string) {
  return {
    id: SLIP_ID, employee_id: employeeId, period_id: 'p1', month: '2025-01',
    base_salary: '300000', gross_salary: '300000', net_payable: '250000',
    total_cnps_sal: '18900', total_cnps_pat: '46950', its: '12000',
    employer_cost: '346950', total_deductions: '50000', lines: [],
    first_name: 'Kouassi', last_name: 'Yao', cnps_number: 'CI123', nni: 'NNI1',
    job_title: 'Dev', period_status: 'closed', initiated_at: null, closed_at: '2025-01-31',
    generated_at: '2025-01-31', viewed_by_employee_at: null,
    payment_status: 'paid', payment_method: 'mobile_money',
    payment_reference: 'TX1', paid_at: '2025-02-01',
  }
}

describe('GET /payroll/payslips/:id/transparency — scope manager', () => {
  // Le manager est refusé AVANT tout accès aux données (deny-by-default), donc
  // on renvoie le slip de façon permanente (mockResolvedValue) pour rendre les
  // tests insensibles à toute requête parasite et garantir l'isolation.
  it('manager → 403 MÊME sur le bulletin de son équipe (paie hors périmètre RBAC)', async () => {
    queryMock.mockResolvedValue({ rows: [slipRow(EMP_IN_TEAM)] })
    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('Rôle non autorisé')
  })

  it('manager → 403 sur le bulletin d\'un employé hors équipe', async () => {
    queryMock.mockResolvedValue({ rows: [slipRow(EMP_OUT_TEAM)] })
    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('employee NE voit QUE ses bulletins — 403 sur le bulletin d\'autrui', async () => {
    queryMock.mockResolvedValue({ rows: [slipRow(EMP_OUT_TEAM)] })
    const token = tokenFor(app, 'employee', { email: 'emp@sotra.ci', employeeId: 'me' })
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

// (Note d'implémentation : ces tests mockent la couche pg ; ils valident la
//  logique RBAC du handler, pas le SQL réel.)
