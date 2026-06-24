/**
 * Couverture exhaustive des branches restantes de mobile-money.routes :
 *  - initiateMobileMoneyPayment : provider non configuré + numéro CI invalide ;
 *  - campagne : tous bulletins déjà payés (200 EMPTY) + aucun éligible (404)
 *    + lot trop volumineux (422) ;
 *  - exécution : bulletin introuvable, montant nul, plafond dépassé ;
 *  - GET /payments (succès + filtres) ; GET /payments/stats (succès + year HS) ;
 *  - retry : montant hors borne (422), provider inconnu (422), succès + maj bulletin ;
 *  - webhook : secret non configuré (503), schema tenant invalide (500).
 *
 * Config mock : le provider mtn_momo est volontairement NON configuré (apiKey
 * vide + webhookSecret vide) pour atteindre les branches fail-closed, tandis que
 * wave/orange restent configurés.
 */
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
      // mtn_momo NON configuré : déclenche les branches fail-closed (85-86, 545-548)
      mtn:    { apiKey: '',            apiUrl: 'https://test', subscriptionKey: '', env: 'sandbox', webhookSecret: '' },
      orange: { apiKey: 'orange-test', apiUrl: 'https://test', merchantKey: 'm', webhookSecret: 'orange-secret-test-32-chars-ccccc' },
    },
  },
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

// Service providers mocké : déterministe, sans HTTP réel ni requête DB. Chaque
// test règle le résultat via initiateTransferMock selon le scénario.
const { initiateTransferMock, verifyNumberMock } = vi.hoisted(() => ({
  initiateTransferMock: vi.fn().mockResolvedValue({ success: true, status: 'completed', transactionId: 'TXN_MOCK' }),
  verifyNumberMock: vi.fn().mockResolvedValue({ valid: true, active: true, provider: 'wave', reason: 'ok' }),
}))
vi.mock('../../services/mobile-money-providers.js', () => ({
  initiateTransfer: initiateTransferMock,
  verifyNumber: verifyNumberMock,
  normalizeMmProvider: (raw: string | null | undefined) => {
    const v = (raw ?? '').toLowerCase()
    if (v === 'wave') return 'wave'
    if (v === 'mtn' || v === 'mtn_momo') return 'mtn_momo'
    if (v === 'orange' || v === 'orange_money') return 'orange_money'
    return null
  },
  MM_PROVIDERS: ['wave', 'mtn_momo', 'orange_money'],
  CI_MM_PHONE_RE: /^\+2250[57]\d{8}$/,
}))

import authPlugin from '../../plugins/auth.js'
import mobileMoneyRoutes from './mobile-money.routes.js'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{
  sub: string; email: string; employeeId: string; schemaName: string
}> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? 'u-' + role,
    tenantId: 't1',
    schemaName: opts.schemaName ?? TENANT,
    role,
    email: opts.email ?? `${role}@sotra.ci`,
    firstName: 'Test',
    lastName: 'User',
    employeeId: opts.employeeId ?? null,
  })
}

function signBody(secret: string, body: unknown): string {
  return createHmac('sha256', secret).update(JSON.stringify(body ?? {})).digest('hex')
}
const WAVE_SECRET = 'wave-secret-test-32-chars-aaaaaa'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(mobileMoneyRoutes, { prefix: '/mobile-money' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }) })

describe('POST /mobile-money/campaigns — branches restantes', () => {
  it('aucun bulletin éligible mais déjà tous payés → 200 EMPTY', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                  // slips : aucun éligible
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })    // paidCount : 5 déjà payés
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.summary.alreadyPaid).toBe(5)
    expect(body.reference).toContain('EMPTY')
  })

  it('lot trop volumineux (> 1000 bulletins) → 422', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: UUID_A, employee_id: UUID_B, net_payable: '150000',
      payment_method: 'mobile_money', payment_status: 'pending',
      first_name: 'E', last_name: String(i),
      mobile_money_provider: 'wave', mobile_money_phone: '+2250712345678',
    }))
    queryMock.mockResolvedValueOnce({ rows })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('Lot trop volumineux')
  })

  it('aucun bulletin éligible et aucun payé → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                  // slips vides
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })    // paidCount 0
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /mobile-money/campaigns/:reference/execute — branches', () => {
  it('bulletin introuvable → résultat success:false sans erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })  // SELECT slip introuvable
      .mockResolvedValueOnce({ rows: [] })  // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/CAMP_OK/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: [UUID_A] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.results[0].success).toBe(false)
    expect(body.results[0].error).toContain('introuvable')
  })

  it('montant nul → success:false (Montant nul ou négatif)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, employee_id: UUID_B, net_payable: '0', month: '2024-12',
        first_name: 'K', last_name: 'J', mobile_money_provider: 'wave', mobile_money_phone: '+22507111222',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/CAMP_OK/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: [UUID_A] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).results[0].error).toContain('Montant nul')
  })

  it('montant > plafond → success:false (Plafond dépassé)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, employee_id: UUID_B, net_payable: '60000000', month: '2024-12',
        first_name: 'K', last_name: 'J', mobile_money_provider: 'wave', mobile_money_phone: '+22507111222',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/CAMP_OK/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: [UUID_A] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).results[0].error).toContain('Plafond dépassé')
  })

  it('numéro CI invalide → success:false (Numéro invalide)', async () => {
    initiateTransferMock.mockResolvedValueOnce({ success: false, status: 'failed', error: 'Numéro invalide pour la CI : +33612345678' })
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, employee_id: UUID_B, net_payable: '150000', month: '2024-12',
        first_name: 'K', last_name: 'J', mobile_money_provider: 'wave', mobile_money_phone: '+33612345678',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // INSERT mobile_money_payments
      .mockResolvedValueOnce({ rows: [] }) // UPDATE pay_slips
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/CAMP_OK/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: [UUID_A] },
    })
    expect(res.statusCode).toBe(200)
    const r = JSON.parse(res.body).results[0]
    expect(r.success).toBe(false)
    expect(r.error).toContain('Numéro invalide')
  })

  it('virement en échec (provider) → success:false + erreur propagée', async () => {
    initiateTransferMock.mockResolvedValueOnce({ success: false, status: 'failed', error: 'Provider mtn_momo non configuré' })
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, employee_id: UUID_B, net_payable: '150000', month: '2024-12',
        first_name: 'K', last_name: 'J', mobile_money_provider: 'mtn_momo', mobile_money_phone: '+22505111222',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // INSERT mobile_money_payments
      .mockResolvedValueOnce({ rows: [] }) // UPDATE pay_slips
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/campaigns/CAMP_OK/execute',
      headers: { authorization: `Bearer ${token}` },
      payload: { paySlipIds: [UUID_A] },
    })
    expect(res.statusCode).toBe(200)
    const r = JSON.parse(res.body).results[0]
    expect(r.success).toBe(false)
    expect(r.error).toContain('non configuré')
  })
})

describe('GET /mobile-money/payments — handler succès', () => {
  it('liste l\'historique sans filtre (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'p1', provider: 'wave', amount: 150000, status: 'completed' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/mobile-money/payments',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('applique les filtres month + status + employeeId', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: `/mobile-money/payments?month=2024-12&status=completed&employeeId=${UUID_B}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls[0]!
    expect(String(call[0])).toContain('ps.month = $1')
    expect(String(call[0])).toContain('mp.status = $2')
    expect(String(call[0])).toContain('mp.employee_id = $3')
    expect(call[1]).toEqual(['2024-12', 'completed', UUID_B])
  })
})

describe('GET /mobile-money/payments/stats', () => {
  it('renvoie les stats agrégées par provider (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ provider: 'wave', status: 'completed', count: '3', total_amount: '450000' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/mobile-money/payments/stats?year=2024',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.year).toBe(2024)
    expect(body.currency).toBe('XOF')
    expect(body.data).toHaveLength(1)
  })

  it('utilise l\'année courante par défaut (sans param)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/mobile-money/payments/stats',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).year).toBe(new Date().getFullYear())
  })

  it('year hors plage → 400', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/mobile-money/payments/stats?year=1990',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('hors plage')
  })

  it('year non numérique (Zod) → 400', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/mobile-money/payments/stats?year=abcd',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).issues).toBeDefined()
  })
})

describe('PATCH /mobile-money/payments/:id/retry — branches', () => {
  it('paiement introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/mobile-money/payments/${UUID_A}/retry`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('montant hors borne → 422', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: UUID_A, employee_id: UUID_B, pay_slip_id: UUID_A,
      provider: 'wave', phone_number: '+22507111222', amount: '0', reference: 'R',
      status: 'failed', first_name: 'K', last_name: 'J',
    }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/mobile-money/payments/${UUID_A}/retry`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('hors borne')
  })

  it('provider inconnu sur le paiement → 422', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: UUID_A, employee_id: UUID_B, pay_slip_id: UUID_A,
      provider: 'bitcoin', phone_number: '+22507111222', amount: '150000', reference: 'R',
      status: 'failed', first_name: 'K', last_name: 'J',
    }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/mobile-money/payments/${UUID_A}/retry`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('Provider inconnu')
  })

  it('retry succès (numéro valide) → maj paiement + bulletin payé', async () => {
    // Force le succès de la simulation (Math.random > 0.05)
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, employee_id: UUID_B, pay_slip_id: UUID_A,
        provider: 'wave', phone_number: '+2250712345678', amount: '150000', reference: 'R',
        status: 'failed', first_name: 'K', last_name: 'J',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE mobile_money_payments
      .mockResolvedValueOnce({ rows: [] }) // UPDATE pay_slips (succès)
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/mobile-money/payments/${UUID_A}/retry`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).success).toBe(true)
    // 2 UPDATE émis : mobile_money_payments + pay_slips
    const updates = queryMock.mock.calls.filter(c => String(c[0]).includes('UPDATE'))
    expect(updates.length).toBe(2)
    spy.mockRestore()
  })
})

describe('POST /mobile-money/webhooks/:provider — branches restantes', () => {
  it('provider sans secret configuré (mtn_momo) → 503 (fail-closed)', async () => {
    const body = { reference: 'R', transactionId: 'T', status: 'completed' as const }
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/mtn_momo?tenant=sotra',
      headers: { 'x-signature': 'abc' },
      payload: body,
    })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toContain('désactivé')
  })

  it('schema_name tenant invalide → 500', async () => {
    const body = { reference: 'CAMP_X', transactionId: 'TXN_X', status: 'completed' as const }
    const sig = signBody(WAVE_SECRET, body)
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: 'BAD SCHEMA!', status: 'active' }] })
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toContain('Configuration tenant')
  })

  it('webhook failed → met le paiement ET le bulletin en failed (MM-007)', async () => {
    const body = { reference: 'CAMP_F', transactionId: 'TXN_F', status: 'failed' as const, message: 'KO' }
    const sig = signBody(WAVE_SECRET, body)
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT, status: 'active' }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, pay_slip_id: UUID_B, status: 'pending', external_ref: null }] }) // payment
      .mockResolvedValueOnce({ rows: [] }) // UPDATE mobile_money_payments
      .mockResolvedValueOnce({ rows: [] }) // UPDATE pay_slips → failed (MM-007)
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('failed')
    // MM-007 : le bulletin repasse en 'failed' (avant : aucun update)
    const slipUpdate = queryMock.mock.calls.find(c => String(c[0]).includes('pay_slips'))
    expect(slipUpdate).toBeDefined()
    expect(String(slipUpdate?.[0])).toContain("payment_status = 'failed'")
  })

  it('tenant introuvable → 404', async () => {
    const body = { reference: 'R', transactionId: 'T', status: 'completed' as const }
    const sig = signBody(WAVE_SECRET, body)
    queryMock.mockResolvedValueOnce({ rows: [] }) // tenant introuvable
    const res = await app.inject({
      method: 'POST', url: '/mobile-money/webhooks/wave?tenant=sotra',
      headers: { 'x-signature': `sha256=${sig}` },
      payload: body,
    })
    expect(res.statusCode).toBe(404)
  })
})
