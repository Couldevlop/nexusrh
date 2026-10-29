/**
 * Matricule (employee_number) via POST/PATCH /employees : saisie facultative
 * (sinon générée par la base), format borné, unicité contrôlée avec un message
 * lisible (409), y compris quand c'est l'index UNIQUE qui tranche (course).
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
const TAKEN = 'Ce matricule est déjà attribué à un autre employé.'

function tokenFor(app: FastifyInstance, role: string, employeeId: string | null = null) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId,
  })
}
const base = { firstName: 'Marie', lastName: 'Konaté', baseSalary: 350000, hireDate: '2024-01-15' }

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

const insertCall = () => queryMock.mock.calls.find((c) => /INSERT INTO "tenant_sotra"\.employees/.test(String(c[0])))
const takenCall = () => queryMock.mock.calls.find((c) => String(c[0]).includes('WHERE employee_number = $1 AND deleted_at IS NULL'))

describe('POST /employees — matricule', () => {
  it('sans matricule : NULL transmis (généré par la base), aucun contrôle d\'unicité', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // contexte tenant
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1', employee_number: 'MAT00042' }] }) // INSERT
    const res = await app.inject({
      method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` }, payload: base,
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.employee_number).toBe('MAT00042')
    const ins = insertCall()
    expect(String(ins?.[0])).toContain('employee_number')
    expect((ins?.[1] as unknown[])[28]).toBeNull()
    expect(takenCall()).toBeUndefined()
  })

  it('matricule saisi et libre : contrôlé puis enregistré tel quel (espaces retirés)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // contexte tenant
      .mockResolvedValueOnce({ rows: [] }) // unicité : libre
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1', employee_number: 'RH-0042' }] }) // INSERT
    const res = await app.inject({
      method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...base, employeeNumber: '  RH-0042 ' },
    })
    expect(res.statusCode).toBe(201)
    expect(takenCall()?.[1]).toEqual(['RH-0042', null])
    expect((insertCall()?.[1] as unknown[])[28]).toBe('RH-0042')
  })

  it('matricule déjà attribué → 409 message lisible, aucun INSERT', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })            // contexte tenant
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // unicité : pris
    const res = await app.inject({
      method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { ...base, employeeNumber: 'MAT00001' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: TAKEN, code: 'EMPLOYEE_NUMBER_TAKEN' })
    expect(insertCall()).toBeUndefined()
  })

  it('course perdue (index UNIQUE, 23505 sur employee_number) → même 409 lisible', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'tenant_sotra_employees_employee_number_uniq',
        detail: 'Key (employee_number)=(MAT00001) already exists.',
      }))
    const res = await app.inject({
      method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { ...base, employeeNumber: 'MAT00001' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe(TAKEN)
  })

  it('format invalide (espace, caractère spécial) → 400 détaillé sur employeeNumber', async () => {
    const res = await app.inject({
      method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { ...base, employeeNumber: 'MAT 01;=1' },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.details[0].path).toBe('employeeNumber')
    expect(body.details[0].message).toContain('Matricule invalide')
  })

  it('matricule trop long (> 50) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/employees',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { ...base, employeeNumber: 'M'.repeat(51) },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /employees/:id — matricule', () => {
  it('modification vers un matricule libre : unicité vérifiée HORS fiche courante, puis UPDATE', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // unicité
      .mockResolvedValueOnce({ rows: [{ id: EMP_ID, employee_number: 'RH-7' }] }) // UPDATE
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeNumber: 'RH-7' },
    })
    expect(res.statusCode).toBe(200)
    expect(takenCall()?.[1]).toEqual(['RH-7', EMP_ID])
    const upd = queryMock.mock.calls.find((c) => String(c[0]).startsWith('UPDATE "tenant_sotra".employees SET'))
    expect(String(upd?.[0])).toContain('employee_number = $1')
    expect(upd?.[1]).toEqual(['RH-7', EMP_ID])
  })

  it('matricule porté par un autre salarié → 409 lisible, aucun UPDATE', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employeeNumber: 'MAT00003' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe(TAKEN)
    expect(queryMock.mock.calls.some((c) => String(c[0]).startsWith('UPDATE'))).toBe(false)
  })

  it('matricule vidé : ignoré (un matricule ne s\'efface pas)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeNumber: '   ' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('Aucun champ valide')
  })

  it('un salarié ne peut pas changer son propre matricule (champ hors self-service)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', EMP_ID)}` },
      payload: { employeeNumber: 'HACK-1' },
    })
    expect(res.statusCode).toBe(400)
    expect(takenCall()).toBeUndefined()
  })
})

describe('GET /employees — recherche par matricule', () => {
  it('le terme de recherche porte aussi sur employee_number', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ c: 0 }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/employees?search=MAT0004',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(String(queryMock.mock.calls[0]?.[0])).toContain('lower(e.employee_number) LIKE $1')
    expect(queryMock.mock.calls[0]?.[1]).toEqual(['%mat0004%'])
  })
})