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
    ai: { apiKey: '', model: 'test', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import workflowRoutes from './payroll-workflow.routes.js'

const SCHEMA = 'tenant_multi'

function tokenFor(app: FastifyInstance, role: string, sub = 'u-' + role) {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@multi.ci`, firstName: 'X', lastName: 'Y', employeeId: null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(workflowRoutes, { prefix: '/payroll-workflow' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

describe('Workflow paie centralisé — création période parente', () => {
  it('refuse si le tenant n\'a pas activé hasSubsidiaries (400)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/multi-pays/i)
  })

  it('valide le format YYYY-MM', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '12-2024' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('crée la période en draft_central', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pp-1', status: 'draft_central', month: '2024-12' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.status).toBe('draft_central')
  })
})

describe('Workflow — déclinaison aux sites', () => {
  it('refuse un pack législatif inconnu', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/pp-1/send-to-sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { sites: [{ legalEntityId: 'le-1', rafUserId: 'u-raf', legislationPackCode: 'XXX-9999' }] },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/Pack législatif inconnu/i)
  })

  it('refuse si la période parente n\'est pas en draft_central (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ month: '2024-12', status: 'closed' }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/pp-1/send-to-sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { sites: [{ legalEntityId: 'le-1', rafUserId: 'u-raf', legislationPackCode: 'CIV-2024' }] },
    })
    expect(res.statusCode).toBe(409)
  })

  it('crée une période fille par site et passe le parent à sent_to_sites', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ month: '2024-12', status: 'draft_central' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'child-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'child-2' }] })
      .mockResolvedValueOnce({ rows: [] })  // UPDATE parent

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/pp-1/send-to-sites',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sites: [
          { legalEntityId: 'le-civ', rafUserId: 'u-raf-civ', legislationPackCode: 'CIV-2024' },
          { legalEntityId: 'le-ben', rafUserId: 'u-raf-ben', legislationPackCode: 'BEN-2024' },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.data.sites).toHaveLength(2)
  })
})

describe('Workflow — RAF soumet sa période', () => {
  it('un raf_site ne peut pas soumettre la période d\'un autre RAF (403)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ status: 'sent_to_sites', raf_user_id: 'u-other', parent_period_id: 'pp-1' }],
    })
    const token = tokenFor(app, 'raf_site', 'u-me')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/child-1/submit-by-raf',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un raf_site peut soumettre sa propre période', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'sent_to_sites', raf_user_id: 'u-me', parent_period_id: 'pp-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'child-1', status: 'completed_by_site' }] })
    const token = tokenFor(app, 'raf_site', 'u-me')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/child-1/submit-by-raf',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('completed_by_site')
  })

  it('refuse de soumettre une période parente (pas une fille)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ status: 'draft_central', raf_user_id: null, parent_period_id: null }],
    })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/pp-1/submit-by-raf',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('Workflow — validation centrale', () => {
  it('refuse si au moins un site n\'a pas soumis (409)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'sent_to_sites', parent_period_id: null }] })
      .mockResolvedValueOnce({
        rows: [
          { status: 'completed_by_site' },
          { status: 'sent_to_sites' },  // en attente
        ],
      })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/pp-1/validate-central',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/n'ont pas encore soumis/i)
  })

  it('valide quand tous les sites ont soumis', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'sent_to_sites', parent_period_id: null }] })
      .mockResolvedValueOnce({ rows: [{ status: 'completed_by_site' }, { status: 'completed_by_site' }] })
      .mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/pp-1/validate-central',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('validated_central')
  })
})

describe('Workflow — clôture', () => {
  it('refuse si pas en validated_central', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'sent_to_sites' }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/pp-1/close',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(409)
  })

  it('clôture une période validated_central', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'validated_central' }] })
      .mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods/pp-1/close',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('closed')
  })
})

describe('Workflow — listing', () => {
  it('un RAF site ne voit que ses propres périodes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'raf_site', 'u-me')
    const res = await app.inject({
      method: 'GET', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const args = queryMock.mock.calls[0]![1] as unknown[]
    expect(args[0]).toBe('u-me')
  })

  it('GET /statuses retourne les 5 statuts du workflow', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/payroll-workflow/statuses',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([
      'draft_central', 'sent_to_sites', 'completed_by_site',
      'validated_central', 'closed',
    ])
  })
})
