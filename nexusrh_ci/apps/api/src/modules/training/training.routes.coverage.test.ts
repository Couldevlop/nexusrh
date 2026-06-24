/**
 * Couverture exhaustive des branches restantes de training.routes :
 * GET /catalog (succès + filtres + 500), POST /catalog (500), GET /sessions
 * (succès + filtres + 500), POST /sessions (500 + inscription en masse à la
 * planification), POST /sessions/:id/participants (id invalide + 500), POST
 * /enroll (500), GET /my-enrollments (employeeId du token, lookup email vide,
 * lookup email trouvé, 500), GET /fdfp/eligible.
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
const UUID_C = '33333333-3333-3333-3333-333333333333'

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

describe('GET /training/catalog', () => {
  it('liste le catalogue (200) — sans filtre', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tr-1', title: 'React', sessions_count: 2, enrollments_count: 5 }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/training/catalog',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('applique les filtres is_fdfp_eligible + category', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/training/catalog?is_fdfp_eligible=true&category=IT',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls[0]!
    expect(String(call[0])).toContain('is_fdfp_eligible = true')
    expect(call[1]).toEqual(['IT'])
  })

  it('erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/training/catalog',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('DELETE /training/enroll/:id — désinscription (FRM-006)', () => {
  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'DELETE', url: '/training/enroll/not-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un employee annule SA propre inscription (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, employee_id: UUID_A, status: 'enrolled' }] }) // SELECT enrollment
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'DELETE', url: `/training/enroll/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.cancelled).toBe(true)
  })

  it('un employee NE PEUT PAS annuler l\'inscription d\'un autre (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A, employee_id: 'autre-emp', status: 'enrolled' }] })
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'DELETE', url: `/training/enroll/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('formation terminée → désinscription impossible (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A, employee_id: UUID_A, status: 'completed' }] })
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'DELETE', url: `/training/enroll/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('GET /training/enrollments/:id/attestation (FRM-007)', () => {
  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/training/enrollments/not-uuid/attestation',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('formation non terminée → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      status: 'enrolled', completed_at: null, employee_id: UUID_A,
      first_name: 'Kouassi', last_name: 'Jean', emp_email: null,
      training_title: 'Excel', duration: 8, duration_unit: 'hours',
      session_start: '2026-09-01', session_end: null, location: 'Abidjan', trainer: 'M. Koné',
    }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: `/training/enrollments/${UUID_A}/attestation`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(409)
  })

  it('formation terminée → PDF (200, application/pdf)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        status: 'completed', completed_at: '2026-09-02T10:00:00Z', employee_id: UUID_A,
        first_name: 'Kouassi', last_name: 'Jean', emp_email: null,
        training_title: 'Excel avancé', duration: 8, duration_unit: 'hours',
        session_start: '2026-09-01', session_end: '2026-09-02', location: 'Abidjan', trainer: 'M. Koné',
      }] })
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', city: 'Abidjan' }] }) // tenant
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: `/training/enrollments/${UUID_A}/attestation`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
  })
})

describe('POST /training/catalog — erreur serveur', () => {
  it('erreur DB sur INSERT → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert failed'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/catalog',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Formation KO' },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('GET /training/sessions', () => {
  it('liste les sessions (200) — sans filtre', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'sess-1', training_title: 'React', enrolled_count: 3 }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/training/sessions',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('applique filtres status + training_id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: `/training/sessions?status=planned&training_id=${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls[0]!
    expect(String(call[0])).toContain('ts.status = $1')
    expect(String(call[0])).toContain('ts.training_id = $2')
    expect(call[1]).toEqual(['planned', UUID_A])
  })

  it('erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/training/sessions',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('POST /training/sessions', () => {
  it('erreur DB sur INSERT session → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert session failed'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { training_id: UUID_A, start_date: '2026-06-01' },
    })
    expect(res.statusCode).toBe(500)
  })

  it('planification avec employee_ids → inscrit en masse les sélectionnés', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'sess-X' }] })               // INSERT session
      .mockResolvedValueOnce({ rows: [] })                              // audit_log session_created
      // enrollEmployeesBulk :
      .mockResolvedValueOnce({ rows: [{ max_places: 20, enrolled: 0 }] }) // cap
      .mockResolvedValueOnce({ rows: [{ id: UUID_B }] })                // employés valides
      .mockResolvedValueOnce({ rows: [] })                              // déjà inscrits
      .mockResolvedValueOnce({ rows: [{ id: 'enr-1' }] })               // INSERT enrollment
      .mockResolvedValueOnce({ rows: [] })                              // audit_log participants_added
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { training_id: UUID_A, start_date: '2026-06-01', employee_ids: [UUID_B] },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.enrollment.added).toBe(1)
  })
})

describe('POST /training/sessions/:id/participants', () => {
  it('refuse un id de session non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/training/sessions/not-uuid/participants',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_ids: [UUID_B] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse une liste employee_ids vide (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: `/training/sessions/${UUID_A}/participants`,
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_ids: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('erreur DB pendant l\'inscription en masse → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('cap query failed'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: `/training/sessions/${UUID_A}/participants`,
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_ids: [UUID_B] },
    })
    expect(res.statusCode).toBe(500)
  })

  it('places épuisées : skippedFull renvoyé sans erreur (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ max_places: 1, enrolled: 1 }] })  // cap : déjà plein
      .mockResolvedValueOnce({ rows: [{ id: UUID_B }] })                 // employés valides
      .mockResolvedValueOnce({ rows: [] })                               // déjà inscrits
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: `/training/sessions/${UUID_A}/participants`,
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_ids: [UUID_B] },
    })
    expect(res.statusCode).toBe(201)
    const r = JSON.parse(res.body).data
    expect(r.added).toBe(0)
    expect(r.skippedFull).toBe(1)
  })

  it('employé hors tenant ignoré (skippedInvalid)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ max_places: 20, enrolled: 0 }] }) // cap
      .mockResolvedValueOnce({ rows: [] })                               // aucun employé valide
      .mockResolvedValueOnce({ rows: [] })                               // déjà inscrits
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: `/training/sessions/${UUID_A}/participants`,
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_ids: [UUID_C] },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.skippedInvalid).toBe(1)
  })
})

describe('POST /training/enroll — branches restantes', () => {
  it('manager de l\'équipe directe : inscription réussie (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })              // team check OK
      .mockResolvedValueOnce({ rows: [] })                              // duplicate check empty
      .mockResolvedValueOnce({ rows: [{ max_places: 20, enrolled: 1 }] }) // session check
      .mockResolvedValueOnce({ rows: [{ id: 'enr-new' }] })             // INSERT
      .mockResolvedValueOnce({ rows: [] })                              // audit_log
    const token = tokenFor(app, 'manager')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(201)
  })

  it('session introuvable → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })  // duplicate check empty
      .mockResolvedValueOnce({ rows: [] })  // session check : introuvable
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(404)
  })

  it('session complète → 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })  // duplicate check empty
      .mockResolvedValueOnce({ rows: [{ max_places: 5, enrolled: 5 }] }) // pleine
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('complète')
  })

  it('erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: UUID_A, employee_id: UUID_B },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('GET /training/my-enrollments', () => {
  it('employeeId présent dans le token → requête directe (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'enr-1', training_title: 'React' }] })
    const token = tokenFor(app, 'employee', { employeeId: UUID_B })
    const res = await app.inject({
      method: 'GET', url: '/training/my-enrollments',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('pas d\'employeeId : lookup par email introuvable → data vide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup email : aucun employé
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/training/my-enrollments',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })

  it('pas d\'employeeId : lookup par email trouvé → liste les inscriptions', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_B }] })            // lookup email
      .mockResolvedValueOnce({ rows: [{ id: 'enr-2' }] })           // inscriptions
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/training/my-enrollments',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'employee', { employeeId: UUID_B })
    const res = await app.inject({
      method: 'GET', url: '/training/my-enrollments',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('GET /training/enrollments — handler succès', () => {
  it('liste les inscriptions sans filtre (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'enr-1', first_name: 'K', last_name: 'J', training_title: 'React' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/training/enrollments',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('applique filtres session_id + employee_id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: `/training/enrollments?session_id=${UUID_A}&employee_id=${UUID_B}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls[0]!
    expect(String(call[0])).toContain('te.session_id = $1')
    expect(String(call[0])).toContain('te.employee_id = $2')
    expect(call[1]).toEqual([UUID_A, UUID_B])
  })

  it('refuse employee_id non-UUID en query (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/training/enrollments?employee_id=bad',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/training/enrollments',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('GET /training/fdfp/eligible', () => {
  it('liste les formations agréées FDFP (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tr-1', title: 'Sécurité', sessions_count: 1 }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/training/fdfp/eligible',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/training/fdfp/eligible',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
