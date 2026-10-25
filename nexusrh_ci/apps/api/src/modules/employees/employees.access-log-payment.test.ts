/**
 * Recette 10/2026 :
 *  - Journal d'accès ARTCI (GET /employees/me/access-log) : uniquement les
 *    accès aux données DU salarié connecté, jamais ses actions sur les autres.
 *  - Opérateur Mobile Money écrit sous forme canonique (mtn_momo → mtn).
 *  - Liste : RIB jamais renvoyé chiffré, seulement masqué (RH) ; compte lié.
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
    mobileMoney: { wave: {}, mtn: {}, orange: {} },
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
import { canonicalEmployeeMmProvider } from '../../services/mobile-money-providers.js'

const EMP_SELF = '11111111-1111-1111-1111-111111111111'
const USER_SELF = '22222222-2222-2222-2222-222222222222'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{ sub: string; email: string; employeeId: string | null }> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? USER_SELF, tenantId: 't1', schemaName: 'tenant_sotra', role,
    email: opts.email ?? `${role}@sotra.ci`, firstName: 'Test', lastName: 'User',
    employeeId: opts.employeeId === undefined ? null : opts.employeeId,
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

describe('GET /employees/me/access-log — journal ARTCI (loi 2013-450)', () => {
  it('filtre sur la fiche du salarié connecté, jamais sur les actions de l’utilisateur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ table_name: 'absences' }, { table_name: 'pay_slips' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a1', action: 'absence.approved', entity: 'absence', actor_first_name: 'Awa', actor_last_name: 'Koné', actor_role: 'hr_manager', actor_is_self: false }] })

    const res = await app.inject({
      method: 'GET', url: '/employees/me/access-log',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', { employeeId: EMP_SELF })}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data[0].actor_role).toBe('hr_manager')

    const [sql, params] = queryMock.mock.calls[1]! as [string, unknown[]]
    // $1 = fiche du salarié connecté ; $2 = utilisateur (uniquement pour « c'est vous »)
    expect(params).toEqual([EMP_SELF, USER_SELF])
    const where = sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER BY'))
    expect(where).not.toMatch(/al\.user_id\s*=/)
    expect(where).toContain(`al.entity IN ('employee', 'career') AND al.entity_id = $1`)
    expect(where).toContain('"tenant_sotra".absences WHERE employee_id = $1')
    expect(where).toContain('"tenant_sotra".pay_slips WHERE employee_id = $1')
    // Tables absentes du schéma (tenant ancien) : pas interrogées.
    expect(where).not.toContain('disciplinary_actions')
    expect(sql).toContain('LEFT JOIN "tenant_sotra".users u ON u.id = al.user_id')
  })

  it('sans fiche employé liée → liste vide (fail-closed, aucun repli sur ses propres actions)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: null }] }) // résolution compte → fiche
    const res = await app.inject({
      method: 'GET', url: '/employees/me/access-log',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
    expect(queryMock).toHaveBeenCalledTimes(1)
    // La résolution préfère le lien explicite users.employee_id.
    expect(String(queryMock.mock.calls[0]![0])).toContain('u.employee_id')
  })

  it('erreur DB → 500 générique', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const res = await app.inject({
      method: 'GET', url: '/employees/me/access-log',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { employeeId: EMP_SELF })}` },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('boom')
  })
})

describe('Opérateur Mobile Money — forme canonique', () => {
  it('canonicalEmployeeMmProvider accepte les formes historiques', () => {
    expect(canonicalEmployeeMmProvider('mtn_momo')).toBe('mtn')
    expect(canonicalEmployeeMmProvider('ORANGE_MONEY')).toBe('orange')
    expect(canonicalEmployeeMmProvider('wave')).toBe('wave')
    expect(canonicalEmployeeMmProvider('cofina')).toBe('cofina')
    expect(canonicalEmployeeMmProvider('bitcoin')).toBeNull()
    expect(canonicalEmployeeMmProvider(null)).toBeNull()
  })

  it('PATCH self-service avec mtn_momo → écrit « mtn »', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP_SELF }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] })                 // audit
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP_SELF}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { employeeId: EMP_SELF })}` },
      payload: { mobileMoneyProvider: 'mtn_momo' },
    })
    expect(res.statusCode).toBe(200)
    const update = queryMock.mock.calls.find(c => String(c[0]).includes('UPDATE'))!
    expect(update[1]).toContain('mtn')
    expect(update[1]).not.toContain('mtn_momo')
  })
})

describe('GET /employees — mode de paiement et compte lié', () => {
  it('RH : RIB masqué, jamais le chiffré ; compte lié exposé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: EMP_SELF, payment_method: 'bank_transfer', bank_name: 'SGCI', iban: 'CI93 CI00 0101 2345 6789', linked_user_id: USER_SELF, linked_user_role: 'manager' }] })
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const row = JSON.parse(res.body).data[0]
    expect(row.iban).toBeUndefined()
    expect(row.iban_masked).toBe('•••• 6789')
    expect(row.linked_user_role).toBe('manager')
    expect(String(queryMock.mock.calls[1]![0])).toContain('u.employee_id = e.id')
  })

  it('readonly : ni RIB ni compte lié', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: EMP_SELF, iban: 'CI93XXXX6789', linked_user_id: USER_SELF, linked_user_role: 'admin', custom_fields: {} }] })
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` },
    })
    const row = JSON.parse(res.body).data[0]
    expect(row.iban).toBeUndefined()
    expect(row.iban_masked).toBeNull()
    expect(row.linked_user_role).toBeNull()
  })
})
