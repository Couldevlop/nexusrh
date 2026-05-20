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
    mobileMoney: {
      wave:   { apiKey: 'wave-test',   apiUrl: 'https://test', webhookSecret: 'w' },
      mtn:    { apiKey: 'mtn-test',    apiUrl: 'https://test', subscriptionKey: 's', env: 'sandbox' },
      orange: { apiKey: 'orange-test', apiUrl: 'https://test', merchantKey: 'm' },
    },
  },
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import mobileMoneyRoutes from './mobile-money.routes.js'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

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
  await app.register(mobileMoneyRoutes, { prefix: '/mobile-money' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

describe('POST /mobile-money/campaigns — Zod stricte (OWASP A03)', () => {
  it('refuse body sans month (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'wave' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse month au format libre (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '01/2024' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse provider hors énum (400) — bloque SQL injection ligne ex-84', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12', provider: "wave' OR '1'='1" },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse champs inconnus (.strict)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12', provider: 'wave', force: true },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /mobile-money/campaigns — RBAC + audit_log (OWASP A01 + A09)', () => {
  it('un employee NE PEUT PAS créer une campagne (403)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un hr_manager crée la campagne et trace audit_log mobile_money.campaign.prepared', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, employee_id: UUID_B, net_payable: '180000',
        payment_method: 'mobile_money', payment_status: 'pending',
        first_name: 'Aïcha', last_name: 'Diallo',
        mobile_money_provider: 'wave', mobile_money_phone: '+22507111222',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12', provider: 'wave' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.summary.total).toBe(1)
    expect(body.summary.currency).toBe('XOF')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mobile_money.campaign.prepared')
  })

  it('provider valide passe par param binding ($2), pas par interpolation', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })

    const token = tokenFor(app, 'admin')
    await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12', provider: 'orange_money' },
    })
    const selectCall = queryMock.mock.calls.find((c) => String(c[0]).includes('mobile_money_provider'))
    // ligne reformatée : utilise $2, plus d'interpolation littérale
    expect(String(selectCall?.[0])).toContain('mobile_money_provider = $2')
    expect(selectCall?.[1]).toEqual(['2024-12', 'orange_money'])
  })
})

describe('POST /mobile-money/campaigns — bornes anti-fraude (OWASP A04)', () => {
  it('refuse 422 si un montant dépasse 50 M FCFA', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: UUID_A, employee_id: UUID_B, net_payable: '60000000',
      payment_method: 'mobile_money', payment_status: 'pending',
      first_name: 'Test', last_name: 'Suspect',
      mobile_money_provider: 'wave', mobile_money_phone: '+22507111222',
    }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('Montant suspect')
  })
})

describe('POST /mobile-money/campaigns/:reference/execute — Zod + UUID (OWASP A03)', () => {
  it('refuse référence non alphanumérique (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/REF.with.dots/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: [UUID_A] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse paySlipIds vide (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/CAMP_TEST/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse paySlipId non-UUID (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/CAMP_TEST/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: ['not-a-uuid'] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('execute trace audit_log mobile_money.campaign.executed', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, employee_id: UUID_B, net_payable: '150000', month: '2024-12',
        first_name: 'Kouassi', last_name: 'Jean',
        mobile_money_provider: 'wave', mobile_money_phone: '+22507111222',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // INSERT mobile_money_payments
      .mockResolvedValueOnce({ rows: [] }) // UPDATE pay_slips
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/CAMP_TEST_123/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: [UUID_A] },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mobile_money.campaign.executed')
  })
})

describe('GET /mobile-money/payments — Zod query (OWASP A03)', () => {
  it('refuse month au mauvais format (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/mobile-money/payments?month=invalid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse status hors énum (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/mobile-money/payments?status=arbitrary',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse employeeId non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/mobile-money/payments?employeeId=not-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /mobile-money/payments/:id/retry — UUID + audit (OWASP A03 + A09)', () => {
  it('refuse id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/mobile-money/payments/not-uuid/retry',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse paiement déjà complété (422)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: UUID_A, employee_id: UUID_B, pay_slip_id: UUID_A,
      provider: 'wave', phone_number: '+22507111222', amount: '150000', reference: 'R',
      status: 'completed', first_name: 'K', last_name: 'J',
    }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/mobile-money/payments/${UUID_A}/retry`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(422)
  })

  it('retry trace audit_log mobile_money.payment.retried', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, employee_id: UUID_B, pay_slip_id: UUID_A,
        provider: 'wave', phone_number: '+22507111222', amount: '150000', reference: 'R',
        status: 'failed', first_name: 'K', last_name: 'J',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE mobile_money_payments
      .mockResolvedValueOnce({ rows: [] }) // UPDATE pay_slips (si success)
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/mobile-money/payments/${UUID_A}/retry`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mobile_money.payment.retried')
  })
})
