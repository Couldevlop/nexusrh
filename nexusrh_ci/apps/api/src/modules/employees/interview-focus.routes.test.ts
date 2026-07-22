import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../db/pool.js', () => ({ pool: { query: queryMock } }))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/redis.js', () => ({
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('../../config.js', () => ({
  config: { jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' } },
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

const SCHEMA = 'tenant_sotra'
const EMP_ID = '11111111-1111-1111-1111-111111111111'
let app: FastifyInstance

function tokenFor(role: string, employeeId: string | null = null) {
  return app.jwt.sign({
    sub: 'u-1', tenantId: 't1', schemaName: SCHEMA, role,
    email: 'e@sotra.ci', firstName: 'E', lastName: 'M', employeeId,
  })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('GET /employees/:id/interview-focus', () => {
  it('401 sans token', async () => {
    const res = await app.inject({ method: 'GET', url: `/employees/${EMP_ID}/interview-focus` })
    expect(res.statusCode).toBe(401)
  })

  it('403 pour le rôle employee — même sur SA PROPRE fiche (pas de self-service ici)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('employee', EMP_ID)}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404 si employé introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('200 : profil vide par défaut si colonne NULL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ interview_focus: null }] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.focus).toEqual({ technologies: [], tools: [], methodologies: [], languages: [] })
  })
})

describe('PUT /employees/:id/interview-focus', () => {
  const validFocus = {
    technologies: [{ name: 'Comptabilité SYSCOHADA', yearsRequired: 4 }],
    tools: ['Sage'],
    methodologies: [],
    languages: [{ language: 'Français', level: 'C2' }],
  }

  it('403 pour le rôle employee', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('employee', EMP_ID)}` },
      payload: { focus: validFocus },
    })
    expect(res.statusCode).toBe(403)
  })

  it('400 si profil invalide', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
      payload: { focus: { technologies: [{ name: '', yearsRequired: 1 }], tools: [], methodologies: [], languages: [] } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('200 : persiste et journalise un audit_log', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('UPDATE') && s.includes('.employees')) return Promise.resolve({ rows: [{ id: EMP_ID }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'PUT', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
      payload: { focus: validFocus },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.focus).toEqual(validFocus)
    // L'action est un littéral dans le texte SQL (pas un paramètre).
    const audit = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(audit).toBeTruthy()
    expect(String(audit![0])).toContain('employees.interview_focus_updated')
  })
})
