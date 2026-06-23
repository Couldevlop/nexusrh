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

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
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

import authPlugin from '../../plugins/auth.js'
import trainingRoutes from './training.routes.js'

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
  await app.register(trainingRoutes, { prefix: '/training' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

describe('POST /training/catalog — Zod (OWASP A03)', () => {
  it('refuse un body sans title (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/catalog',
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Sans titre' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un format hors énum (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/catalog',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'React', format: 'metaverse' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte body valide et trace audit_log training.created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'tr-1', title: 'React Advanced' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/catalog',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'React Advanced', format: 'presentiel', is_fdfp_eligible: true, category: 'IT' },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('training.created')
  })
})

describe('POST /training/sessions — Zod (OWASP A03)', () => {
  it('refuse training_id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { training_id: 'not-uuid', start_date: '2026-06-01' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte body valide et trace audit_log training.session_created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'sess-1' }] })
      .mockResolvedValueOnce({ rows: [] })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { training_id: UUID_A, start_date: '2026-06-01', max_places: 25 },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('training.session_created')
  })
})

describe('POST /training/enroll — RH/manager + self-service employé (OWASP A01 + A03 + A04)', () => {
  it('employee : auto-inscription self-service réussie (201) + employee_id du token', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                         // duplicate check empty
      .mockResolvedValueOnce({ rows: [{ max_places: 20, enrolled: 5 }] }) // session check
      .mockResolvedValueOnce({ rows: [{ id: 'enr-self' }] })       // INSERT enrollment
      .mockResolvedValueOnce({ rows: [] })                         // audit_log

    const token = tokenFor(app, 'employee', { employeeId: UUID_B })
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A }, // employee_id NON fourni : dérivé du token
    })
    expect(res.statusCode).toBe(201)
    // OWASP A01 : l'INSERT doit cibler l'employeeId du token (UUID_B)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('training_enrollments'))
    expect(insertCall?.[1]).toEqual([UUID_A, UUID_B])
  })

  it('employee : un employee_id forgé dans le body est REFUSÉ (400, schema strict)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_B })
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: '33333333-3333-3333-3333-333333333333' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('employee sans dossier employé lié → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup employee par email : aucun
    const token = tokenFor(app, 'employee') // pas d'employeeId dans le token
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuse l\'inscription par un readonly (403)', async () => {
    const token = tokenFor(app, 'readonly')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuse session_id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: 'pas-uuid', employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse employee_id manquant (400) — plus d\'auto-inscription', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse une seconde inscription à la même session (409)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'enr-existing' }] }) // duplicate check finds row

    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('déjà inscrit')
  })

  it('inscription RH réussie trace audit_log training.enrolled', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                         // duplicate check empty
      .mockResolvedValueOnce({ rows: [{ max_places: 20, enrolled: 5 }] }) // session check
      .mockResolvedValueOnce({ rows: [{ id: 'enr-new' }] })       // INSERT enrollment
      .mockResolvedValueOnce({ rows: [] })                         // audit_log

    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('training.enrolled')
  })

  it('manager hors équipe directe → 403', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // team check : pas dans l'équipe
    const token = tokenFor(app, 'manager')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /training/sessions/:id/participants — ajout RH des sélectionnés', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_B })
    const res = await app.inject({
      method: 'POST', url: `/training/sessions/${UUID_A}/participants`,
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_ids: [UUID_B] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('ajoute les employés sélectionnés (201) + trace participants_added', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ max_places: 20, enrolled: 0 }] })  // capacité
      .mockResolvedValueOnce({ rows: [{ id: UUID_B }] })                   // employés valides du tenant
      .mockResolvedValueOnce({ rows: [] })                                 // déjà inscrits
      .mockResolvedValueOnce({ rows: [{ id: 'enr-1' }] })                  // INSERT enrollment
      .mockResolvedValueOnce({ rows: [] })                                 // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: `/training/sessions/${UUID_A}/participants`,
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_ids: [UUID_B] },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.added).toBe(1)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('training.participants_added')
  })

  it('session inexistante → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // capacité : session absente
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: `/training/sessions/${UUID_A}/participants`,
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_ids: [UUID_B] },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /training/fdfp/request — bornes anti-fraude (OWASP A04)', () => {
  it('refuse total_cost > 50M FCFA (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/fdfp/request',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        training_title: 'Formation X', session_date: '2026-05-15',
        employees_count: 10, total_cost: 999_999_999, provider_name: 'Org',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse employees_count > 1000 (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/fdfp/request',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        training_title: 'Formation X', session_date: '2026-05-15',
        employees_count: 50_000, total_cost: 5_000_000, provider_name: 'Org',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('demande valide trace audit_log training.fdfp_requested avec remboursement estimé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] }) // INSERT hr_events
      .mockResolvedValueOnce({ rows: [] })                  // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/fdfp/request',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        training_title: 'Excel Avancé', session_date: '2026-05-15',
        employees_count: 12, total_cost: 4_000_000, provider_name: 'CFOPCI',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.data.estimated_refund).toBe(2_000_000) // 50% du total
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('training.fdfp_requested')
  })

  it('accepte training_id vide (formulaire sans formation liée) → 201, pas de 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'evt-2' }] }) // INSERT hr_events
      .mockResolvedValueOnce({ rows: [] })                  // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/fdfp/request',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        training_title: 'Sécurité chantier', training_id: '', fdfp_code: '',
        session_date: '2026-07-01', employees_count: 5, total_cost: 1_000_000,
        provider_name: 'BTP Formation',
      },
    })
    expect(res.statusCode).toBe(201)
    // L'INSERT hr_events niveau entreprise ne référence PAS employee_id (nullable).
    const insCall = queryMock.mock.calls.find((c) => String(c[0]).includes('hr_events'))
    expect(String(insCall?.[0])).not.toContain('employee_id')
  })

  it('refuse FDFP par un employee (admin/hr seulement, 403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST', url: '/training/fdfp/request',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        training_title: 'X', session_date: '2026-05-15',
        employees_count: 1, total_cost: 100_000, provider_name: 'Y',
      },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /training/enrollments — UUID validation query', () => {
  it('refuse session_id non-UUID en query (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/training/enrollments?session_id=not-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})
