/**
 * GOLDEN — Dossier salarié complet à la création / modification d'un employé.
 *
 * Couvre les champs ajoutés au dossier :
 *   - heures hebdomadaires (weekly_hours, défaut 40 h — base légale CI) ;
 *   - catégorie professionnelle (convention collective) ;
 *   - RIB (iban chiffré AES-256 en base, comme le NNI — RGPD) + banque ;
 *   - lecture : l'IBAN est déchiffré dans GET /employees/:id ;
 *   - self-service : l'employé peut mettre à jour SON RIB, jamais son salaire ;
 *   - bornes : salaire < SMIG refusé, heures hors bornes refusées.
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

// Chiffrement traçable : permet d'asserter que NNI et IBAN passent par
// encryptIfPresent avant l'écriture SQL (RGPD AES-256).
vi.mock('../../utils/crypto.js', () => ({
  encryptIfPresent: vi.fn((v: string | null | undefined) => (v ? `enc:${v}` : null)),
  decryptIfPresent: vi.fn((v: string | null | undefined) => (v?.startsWith('enc:') ? v.slice(4) : v ?? null)),
}))

vi.mock('../../services/integrations.service.js', () => ({
  emitIntegrationEvent: vi.fn(),
}))

vi.mock('../../services/onboarding.service.js', () => ({
  autoStartOnboarding: vi.fn().mockResolvedValue(null),
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
const EMP = '66666666-6666-6666-6666-666666666666'

function hrToken() {
  return app.jwt.sign({ sub: 'u-rh', tenantId: 't1', schemaName: 'tenant_sotra', role: 'hr_manager',
    email: 'rh@sotra.ci', firstName: 'R', lastName: 'H', employeeId: null })
}
function selfToken() {
  return app.jwt.sign({ sub: 'u-emp', tenantId: 't1', schemaName: 'tenant_sotra', role: 'employee',
    email: 'employe@sotra.ci', firstName: 'K', lastName: 'C', employeeId: EMP })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }) })

describe('POST /employees — heures, catégorie, RIB', () => {
  const basePayload = {
    firstName: 'Mariam', lastName: 'Touré', baseSalary: 250_000,
    jobTitle: 'Comptable', hireDate: '2026-07-01',
  }

  it('capture heures hebdo + catégorie + RIB (IBAN chiffré, jamais en clair en SQL)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] })            // audit
    const res = await app.inject({ method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${hrToken()}` },
      payload: { ...basePayload, weeklyHours: 38.5, professionalCategory: '5ème catégorie',
        iban: 'CI93CI0080111301134291200589', bankName: 'SGBCI' } })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO'))!
    const sql = String(insert[0])
    expect(sql).toContain('weekly_hours')
    expect(sql).toContain('professional_category')
    expect(sql).toContain('iban')
    expect(sql).toContain('bank_name')
    const params = insert[1] as unknown[]
    expect(params).toContain(38.5)
    expect(params).toContain('5ème catégorie')
    expect(params).toContain('SGBCI')
    // RGPD — l'IBAN est chiffré avant l'écriture (jamais en clair)
    expect(params).toContain('enc:CI93CI0080111301134291200589')
    expect(params).not.toContain('CI93CI0080111301134291200589')
  })

  it('défauts : 40 h hebdo, pas de catégorie ni RIB', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${hrToken()}` }, payload: basePayload })
    expect(res.statusCode).toBe(201)
    const params = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO'))![1] as unknown[]
    expect(params).toContain(40) // base légale CI
  })

  it('heures hors bornes (0 ou 80) → 400', async () => {
    for (const weeklyHours of [0, 80]) {
      const res = await app.inject({ method: 'POST', url: '/employees',
        headers: { authorization: `Bearer ${hrToken()}` },
        payload: { ...basePayload, weeklyHours } })
      expect(res.statusCode).toBe(400)
    }
  })

  it('salaire sous le SMIG → 422', async () => {
    const res = await app.inject({ method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${hrToken()}` },
      payload: { ...basePayload, baseSalary: 60_000 } })
    expect(res.statusCode).toBe(422)
  })
})

describe('GET /employees/:id — restitution', () => {
  it('l\'IBAN stocké chiffré est déchiffré pour l\'affichage', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: EMP, email: 'rh@sotra.ci', first_name: 'M', last_name: 'T',
      nni: 'enc:CI123456789', iban: 'enc:CI93CI0080111301134291200589',
      weekly_hours: '38.5', professional_category: '5ème catégorie',
    }] })
    const res = await app.inject({ method: 'GET', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${hrToken()}` } })
    expect(res.statusCode).toBe(200)
    const emp = JSON.parse(res.body).data
    expect(emp.iban).toBe('CI93CI0080111301134291200589')
    expect(emp.nni).toBe('CI123456789')
    expect(emp.weekly_hours).toBe('38.5')
    expect(emp.professional_category).toBe('5ème catégorie')
  })
})

describe('PATCH /employees/:id — self-service RIB (A01)', () => {
  it('l\'employé met à jour SON RIB → chiffré, accepté', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP }] }) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] })            // audit
    const res = await app.inject({ method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${selfToken()}` },
      payload: { iban: 'CI93CI0080111301134291200589', bankName: 'NSIA Banque' } })
    expect(res.statusCode).toBe(200)
    const update = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))!
    expect(String(update[0])).toContain('iban = $')
    expect(update[1]).toContain('enc:CI93CI0080111301134291200589')
    expect((update[1] as unknown[])).not.toContain('CI93CI0080111301134291200589')
  })

  it('l\'employé ne peut PAS toucher son salaire / sa catégorie / ses heures (filtrés)', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/employees/${EMP}`,
      headers: { authorization: `Bearer ${selfToken()}` },
      payload: { baseSalary: 9_000_000, weeklyHours: 10, professionalCategory: 'Cadre (C3)' } })
    // Tous les champs interdits sont retirés → plus aucun champ valide → 400
    expect(res.statusCode).toBe(400)
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('UPDATE'))).toBe(false)
  })

  it('l\'employé ne modifie pas le profil d\'un autre → 403', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/employees/77777777-7777-7777-7777-777777777777',
      headers: { authorization: `Bearer ${selfToken()}` },
      payload: { iban: 'CI93XXX' } })
    expect(res.statusCode).toBe(403)
  })
})
