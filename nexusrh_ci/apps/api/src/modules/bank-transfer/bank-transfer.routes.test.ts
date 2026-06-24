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
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: 'NexusRH <no@reply>' },
  },
}))

vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../utils/crypto.js', () => ({ decryptIfPresent: (v: string | null) => (v ? v.replace('enc:', '') : null) }))

const { sendBankTransferEmailMock } = vi.hoisted(() => ({ sendBankTransferEmailMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/email.js', () => ({ sendBankTransferEmail: sendBankTransferEmailMock }))

import authPlugin from '../../plugins/auth.js'
import bankTransferRoutes from './bank-transfer.routes.js'

const TENANT = 'tenant_sotra'
let app: FastifyInstance

function tokenFor(role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(bankTransferRoutes, { prefix: '/bank-transfer' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); sendBankTransferEmailMock.mockClear() })

describe('GET /bank-transfer/preview', () => {
  it('refuse un employee (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/preview?month=2025-01', headers: { authorization: `Bearer ${tokenFor('employee')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('refuse un month invalide (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/preview?month=2025', headers: { authorization: `Bearer ${tokenFor('hr_manager')}` } })
    expect(res.statusCode).toBe(400)
  })
  it('renvoie les banques agrégées (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', count: 3, total: '900000', email: 'paie@sgci.ci' }] })
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/preview?month=2025-01', headers: { authorization: `Bearer ${tokenFor('admin')}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data[0]).toMatchObject({ bank: 'SGCI', count: 3, total: 900000, email: 'paie@sgci.ci' })
  })
})

describe('POST /bank-transfer/send', () => {
  it('refuse un body sans banques (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/send', headers: { authorization: `Bearer ${tokenFor('admin')}` }, payload: { month: '2025-01', banks: [] } })
    expect(res.statusCode).toBe(400)
  })
  it('refuse un email banque invalide (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/send', headers: { authorization: `Bearer ${tokenFor('admin')}` }, payload: { month: '2025-01', banks: [{ name: 'SGCI', email: 'pas-un-email' }] } })
    expect(res.statusCode).toBe(400)
  })
  it('génère, envoie l\'email (expéditeur tenant) et confirme (200)', async () => {
    queryMock
      // tenant mail config (AVANT la boucle)
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: '#E85D04', sender_email: 'paie@sotra.ci', sender_name: 'SOTRA Paie', smtp_host: null, smtp_port: null, smtp_secure: null, smtp_user: null, smtp_pass_enc: null }] })
      // fetchTransfers (banque SGCI)
      .mockResolvedValueOnce({ rows: [{ first_name: 'Awa', last_name: 'Koné', nni: 'enc:CI123', iban: 'enc:CI0710', net_payable: '300000' }] })
      // upsert bank_directory
      .mockResolvedValueOnce({ rows: [] })
      // audit
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/send', headers: { authorization: `Bearer ${tokenFor('admin')}` }, payload: { month: '2025-01', banks: [{ name: 'SGCI', email: 'paie@sgci.ci' }] } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.success).toBe(true)
    expect(body.results[0]).toMatchObject({ bank: 'SGCI', count: 1, total: 300000, sent: true })
    // L'expéditeur passé à l'email est celui du tenant
    expect(sendBankTransferEmailMock).toHaveBeenCalledTimes(1)
    const arg = sendBankTransferEmailMock.mock.calls[0][0]
    expect(arg.from).toBe('SOTRA Paie <paie@sotra.ci>')
    expect(arg.attachment.filename).toContain('.xlsx')
  })
})
