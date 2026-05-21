import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac } from 'crypto'

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
      wave:   { apiKey: 'wave-test',   apiUrl: 'https://test', webhookSecret: 'wave-secret-test-32-chars-aaaaaa' },
      mtn:    { apiKey: 'mtn-test',    apiUrl: 'https://test', subscriptionKey: 's', env: 'sandbox', webhookSecret: 'mtn-secret-test-32-chars-bbbbbbb' },
      orange: { apiKey: 'orange-test', apiUrl: 'https://test', merchantKey: 'm', webhookSecret: 'orange-secret-test-32-chars-ccccc' },
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

describe('POST /mobile-money/webhooks/:provider — HMAC + idempotence (OWASP A02 + A04)', () => {
  // Helper : signe un body avec un secret HMAC SHA-256 (comme un vrai provider)
  function signBody(secret: string, body: unknown): { raw: string; sig: string } {
    const raw = JSON.stringify(body ?? {})
    const sig = createHmac('sha256', secret).update(raw).digest('hex')
    return { raw, sig }
  }
  const WAVE_SECRET = 'wave-secret-test-32-chars-aaaaaa'

  it('refuse provider hors whitelist (404)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/bitcoin?tenant=sotra',
      headers: { 'x-signature': 'abc' },
      payload: { reference: 'R', transactionId: 'T', status: 'completed' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuse query tenant manquant (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave',
      headers: { 'x-signature': 'abc' },
      payload: { reference: 'R', transactionId: 'T', status: 'completed' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse signature absente (401)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      payload: { reference: 'CAMP_2024-12_X', transactionId: 'TXN_123', status: 'completed' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('Signature manquante')
  })

  it('refuse signature HMAC invalide (401, timing-safe)', async () => {
    const body = { reference: 'CAMP_2024-12_X', transactionId: 'TXN_123', status: 'completed' as const }
    const { sig } = signBody('WRONG-SECRET', body)
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('Signature invalide')
  })

  it('signature OK + transaction inconnue → 202 (anti-énumération)', async () => {
    const body = { reference: 'CAMP_2024-12_GHOST', transactionId: 'TXN_X', status: 'completed' as const }
    const { sig } = signBody(WAVE_SECRET, body)
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT, status: 'active' }] }) // SELECT tenant
      .mockResolvedValueOnce({ rows: [] })                                            // SELECT payment (introuvable)

    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body).processed).toBe(false)
  })

  it('signature OK + completed → update payment + bulletin + audit', async () => {
    const body = { reference: 'CAMP_2024-12_OK', transactionId: 'TXN_42', status: 'completed' as const }
    const { sig } = signBody(WAVE_SECRET, body)
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT, status: 'active' }] }) // SELECT tenant
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, pay_slip_id: UUID_B, status: 'pending', external_ref: null,
      }] })                                                                          // SELECT payment
      .mockResolvedValueOnce({ rows: [] })                                            // UPDATE mobile_money_payments
      .mockResolvedValueOnce({ rows: [] })                                            // UPDATE pay_slips
      .mockResolvedValueOnce({ rows: [] })                                            // audit_log

    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    const body200 = JSON.parse(res.body)
    expect(body200.processed).toBe(true)
    expect(body200.status).toBe('completed')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mobile_money.webhook.completed')
  })

  it('idempotence : 2e webhook même transactionId → 200 sans rejouer (anti-replay A04)', async () => {
    const body = { reference: 'CAMP_2024-12_DUP', transactionId: 'TXN_77', status: 'completed' as const }
    const { sig } = signBody(WAVE_SECRET, body)
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, pay_slip_id: UUID_B, status: 'completed', external_ref: 'TXN_77', // déjà completed avec MÊME ref
      }] })

    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    const r = JSON.parse(res.body)
    expect(r.processed).toBe(false)
    expect(r.reason).toBe('already_completed')
    // Vérifier qu'on n'a PAS appelé d'UPDATE pay_slips (anti-double paiement)
    const updateCalls = queryMock.mock.calls.filter((c) => String(c[0]).includes('UPDATE'))
    expect(updateCalls.length).toBe(0)
  })

  it('conflit : 2e webhook avec transactionId différent sur paiement complété → 409', async () => {
    const body = { reference: 'CAMP_2024-12_CONF', transactionId: 'TXN_NEW', status: 'completed' as const }
    const { sig } = signBody(WAVE_SECRET, body)
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, pay_slip_id: UUID_B, status: 'completed', external_ref: 'TXN_OLD',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log conflict

    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(409)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mobile_money.webhook.conflict')
  })

  it('tenant suspendu → 403', async () => {
    const body = { reference: 'CAMP_X', transactionId: 'TXN_X', status: 'completed' as const }
    const { sig } = signBody(WAVE_SECRET, body)
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: TENANT, status: 'suspended' }] })

    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuse status hors énum (Zod strict)', async () => {
    const body = { reference: 'R', transactionId: 'T', status: 'magic' }
    const { sig } = signBody(WAVE_SECRET, body)
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(400)
  })
})
