/**
 * COVERAGE — Parcours d'intégration (onboarding) : routes.
 *
 * Complète le golden : couvre toutes les branches d'erreur (400/401/403/404/
 * 409/422/429/500), les chemins nominaux (CRUD modèles, parcours, étapes,
 * self-service) et les blocs catch / RBAC restants non exercés par le golden.
 *
 * Pattern de mock identique au golden : Pool pg mocké (queryMock), migration
 * lazy neutralisée, service IA mocké, config minimale. La limite de débit IA
 * (5/min) est exercée via @fastify/rate-limit enregistré localement.
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

const { ensureMock } = vi.hoisted(() => ({ ensureMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: ensureMock,
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }))
vi.mock('../../services/onboarding-ai.service.js', () => ({
  generateOnboardingPlan: generateMock,
}))

const { startMock, refreshMock } = vi.hoisted(() => ({
  startMock: vi.fn(), refreshMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/onboarding.service.js', () => ({
  startOnboardingJourney: startMock,
  refreshJourneyStatus:   refreshMock,
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: '', maxTokens: 4096, model: 'claude-sonnet-4-20250514' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import onboardingRoutes from './onboarding.routes.js'

let app: FastifyInstance
const SID = '44444444-4444-4444-4444-444444444444'
const BAD_ID = 'not-a-uuid'

function token(role: string, over: Record<string, unknown> = {}) {
  return app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null, ...over })
}
function auth(role: string, over: Record<string, unknown> = {}) {
  return { authorization: `Bearer ${token(role, over)}` }
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  // Limite de débit globale large : la route IA a sa propre limite (5/min).
  await app.register(import('@fastify/rate-limit'), {
    global: true, max: 1000, timeWindow: '1 minute', keyGenerator: (req) => req.ip,
  })
  await app.register(onboardingRoutes, { prefix: '/onboarding' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  generateMock.mockReset()
  startMock.mockReset()
  refreshMock.mockClear().mockResolvedValue(undefined)
  ensureMock.mockClear().mockResolvedValue(undefined)
})

// ─── GET /templates ──────────────────────────────────────────────────────────
describe('GET /onboarding/templates', () => {
  it('admin → 200 + liste', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl1', name: 'M', steps_count: '2' }] })
    const res = await app.inject({ method: 'GET', url: '/onboarding/templates', headers: auth('admin') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
  it('readonly → 200 (lecture autorisée)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/onboarding/templates', headers: auth('readonly') })
    expect(res.statusCode).toBe(200)
  })
  it('manager → 403 (pas dans la liste autorisée)', async () => {
    const res = await app.inject({ method: 'GET', url: '/onboarding/templates', headers: auth('manager') })
    expect(res.statusCode).toBe(403)
  })
  it('erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({ method: 'GET', url: '/onboarding/templates', headers: auth('admin') })
    expect(res.statusCode).toBe(500)
  })
})

// ─── GET /templates/:id ──────────────────────────────────────────────────────
describe('GET /onboarding/templates/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'GET', url: `/onboarding/templates/${BAD_ID}`, headers: auth('admin') })
    expect(res.statusCode).toBe(400)
  })
  it('modèle introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: `/onboarding/templates/${SID}`, headers: auth('admin') })
    expect(res.statusCode).toBe(404)
  })
  it('trouvé → 200 + étapes', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, name: 'M' }] }) // template
      .mockResolvedValueOnce({ rows: [{ id: 's1', title: 'Etape' }] }) // steps
    const res = await app.inject({ method: 'GET', url: `/onboarding/templates/${SID}`, headers: auth('hr_officer') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.steps).toHaveLength(1)
  })
})

// ─── POST /templates ─────────────────────────────────────────────────────────
describe('POST /onboarding/templates', () => {
  it('corps invalide (name manquant) → 400 + détails', async () => {
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates',
      headers: auth('admin'), payload: { description: 'x' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).details).toBeDefined()
  })
  it('admin sans étape → 201 (boucle steps non exécutée)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'tplX' }] }) // INSERT template
      .mockResolvedValueOnce({ rows: [] })               // audit
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates',
      headers: auth('admin'), payload: { name: 'Sans étapes' } })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.id).toBe('tplX')
  })
  it('avec departmentId + plusieurs étapes → 201', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'tplD' }] })
      .mockResolvedValueOnce({ rows: [] }) // step 1
      .mockResolvedValueOnce({ rows: [] }) // step 2
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates',
      headers: auth('hr_manager'),
      payload: { name: 'Avec dept', departmentId: '11111111-1111-1111-1111-111111111111',
        steps: [
          { title: 'A', phase: 'day_one', ownerRole: 'hr', dueOffsetDays: 0, resources: [{ type: 'link', title: 'L', url: 'http://x' }] },
          { title: 'B' },
        ] } })
    expect(res.statusCode).toBe(201)
  })
  it('erreur DB sur INSERT → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert failed'))
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates',
      headers: auth('admin'), payload: { name: 'Boom' } })
    expect(res.statusCode).toBe(500)
  })
})

// ─── PATCH /templates/:id ────────────────────────────────────────────────────
describe('PATCH /onboarding/templates/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/templates/${BAD_ID}`,
      headers: auth('admin'), payload: { name: 'x' } })
    expect(res.statusCode).toBe(400)
  })
  it('corps invalide (champ inconnu) → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/templates/${SID}`,
      headers: auth('admin'), payload: { nope: true } })
    expect(res.statusCode).toBe(400)
  })
  it('maj métadonnées : modèle introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE renvoie rien
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/templates/${SID}`,
      headers: auth('admin'), payload: { name: 'Nouveau' } })
    expect(res.statusCode).toBe(404)
  })
  it('maj tous les champs + remplacement des étapes → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID }] }) // UPDATE meta
      .mockResolvedValueOnce({ rows: [] })            // DELETE steps
      .mockResolvedValueOnce({ rows: [] })            // INSERT step 1
      .mockResolvedValueOnce({ rows: [] })            // audit
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/templates/${SID}`,
      headers: auth('hr_manager'),
      payload: { name: 'N', description: 'D', seniority: 'cadre', jobKeywords: 'k',
        departmentId: null, isDefault: true, isActive: false,
        steps: [{ title: 'Etape rempl', description: 'desc' }] } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.updated).toBe(true)
  })
  it('remplacement des étapes uniquement (sans champ meta) → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // DELETE steps
      .mockResolvedValueOnce({ rows: [] }) // INSERT step
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/templates/${SID}`,
      headers: auth('admin'), payload: { steps: [{ title: 'Seule étape' }] } })
    expect(res.statusCode).toBe(200)
  })
  it('corps vide (aucun champ) → 200 sans requête de maj', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit seulement
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/templates/${SID}`,
      headers: auth('admin'), payload: {} })
    expect(res.statusCode).toBe(200)
  })
})

// ─── DELETE /templates/:id ───────────────────────────────────────────────────
describe('DELETE /onboarding/templates/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/onboarding/templates/${BAD_ID}`, headers: auth('admin') })
    expect(res.statusCode).toBe(400)
  })
  it('introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'DELETE', url: `/onboarding/templates/${SID}`, headers: auth('admin') })
    expect(res.statusCode).toBe(404)
  })
  it('supprimé → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID }] }) // DELETE
      .mockResolvedValueOnce({ rows: [] })            // audit
    const res = await app.inject({ method: 'DELETE', url: `/onboarding/templates/${SID}`, headers: auth('hr_manager') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.deleted).toBe(true)
  })
  it('hr_officer → 403', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/onboarding/templates/${SID}`, headers: auth('hr_officer') })
    expect(res.statusCode).toBe(403)
  })
})

// ─── POST /templates/generate ────────────────────────────────────────────────
describe('POST /onboarding/templates/generate', () => {
  it('paramètres invalides (jobTitle trop court) → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates/generate',
      headers: auth('admin'), payload: { jobTitle: 'a' } })
    expect(res.statusCode).toBe(400)
  })
  it('succès → 200 + audit', async () => {
    generateMock.mockResolvedValueOnce({ name: 'Plan', description: '', steps: [
      { title: 'X', description: '', phase: 'day_one', ownerRole: 'hr', dueOffsetDays: 0, resources: [] },
    ] })
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates/generate',
      headers: auth('hr_manager'), payload: { jobTitle: 'Comptable', department: 'Finance', companyContext: 'PME' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.name).toBe('Plan')
  })
  it('limite de débit : 6e appel en < 1 min → 429', async () => {
    generateMock.mockResolvedValue({ name: 'P', description: '', steps: [
      { title: 'X', description: '', phase: 'day_one', ownerRole: 'hr', dueOffsetDays: 0, resources: [] },
    ] })
    const tk = auth('admin')
    let last = 0
    for (let n = 0; n < 6; n++) {
      const r = await app.inject({ method: 'POST', url: '/onboarding/templates/generate',
        headers: tk, payload: { jobTitle: 'Comptable senior' } })
      last = r.statusCode
    }
    expect(last).toBe(429)
  })
})

// ─── GET /journeys ───────────────────────────────────────────────────────────
describe('GET /onboarding/journeys', () => {
  it('admin → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'j1', total_steps: '5', done_steps: '2', late_steps: '0' }] })
    const res = await app.inject({ method: 'GET', url: '/onboarding/journeys', headers: auth('admin') })
    expect(res.statusCode).toBe(200)
  })
  it('filtre status valide → ajoute la clause', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/onboarding/journeys?status=completed', headers: auth('hr_manager') })
    expect(res.statusCode).toBe(200)
    const sql = String(queryMock.mock.calls[0]?.[0])
    expect(sql).toContain('j.status = $1')
  })
  it('filtre status invalide → ignoré', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/onboarding/journeys?status=bogus', headers: auth('admin') })
    expect(res.statusCode).toBe(200)
    expect(String(queryMock.mock.calls[0]?.[0])).not.toContain('j.status = $1')
  })
  it('manager → filtre sur son équipe', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/onboarding/journeys', headers: auth('manager') })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls[0]
    expect(String(call?.[0])).toContain('e.manager_id =')
    expect(call?.[1]).toContain('manager@sotra.ci')
  })
  it('manager + status → deux paramètres', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await app.inject({ method: 'GET', url: '/onboarding/journeys?status=in_progress', headers: auth('manager') })
    const call = queryMock.mock.calls[0]
    expect(call?.[1]).toEqual(['in_progress', 'manager@sotra.ci'])
  })
})

// ─── POST /journeys ──────────────────────────────────────────────────────────
describe('POST /onboarding/journeys', () => {
  const body = { employeeId: '22222222-2222-2222-2222-222222222222', templateId: SID }
  it('corps invalide → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/onboarding/journeys',
      headers: auth('admin'), payload: { employeeId: 'x' } })
    expect(res.statusCode).toBe(400)
  })
  it('employé introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // employee lookup
    const res = await app.inject({ method: 'POST', url: '/onboarding/journeys', headers: auth('admin'), payload: body })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('Employé')
  })
  it('modèle introuvable/inactif → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: body.employeeId, hire_date: '2026-01-01' }] })
      .mockResolvedValueOnce({ rows: [] }) // template lookup
    const res = await app.inject({ method: 'POST', url: '/onboarding/journeys', headers: auth('admin'), payload: body })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('Modèle')
  })
  it('parcours déjà en cours → 409', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: body.employeeId }] })
      .mockResolvedValueOnce({ rows: [{ id: SID, name: 'M' }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // dup check
    const res = await app.inject({ method: 'POST', url: '/onboarding/journeys', headers: auth('hr_officer'), payload: body })
    expect(res.statusCode).toBe(409)
  })
  it('modèle sans étape → 422', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: body.employeeId }] })
      .mockResolvedValueOnce({ rows: [{ id: SID, name: 'M' }] })
      .mockResolvedValueOnce({ rows: [] }) // no dup
    startMock.mockResolvedValueOnce(null)
    const res = await app.inject({ method: 'POST', url: '/onboarding/journeys', headers: auth('admin'), payload: body })
    expect(res.statusCode).toBe(422)
  })
  it('création → 201', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: body.employeeId }] })
      .mockResolvedValueOnce({ rows: [{ id: SID, name: 'M' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // audit
    startMock.mockResolvedValueOnce('journey-new')
    const res = await app.inject({ method: 'POST', url: '/onboarding/journeys', headers: auth('admin'), payload: body })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.id).toBe('journey-new')
  })
})

// ─── GET /journeys/:id ───────────────────────────────────────────────────────
describe('GET /onboarding/journeys/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'GET', url: `/onboarding/journeys/${BAD_ID}`, headers: auth('admin') })
    expect(res.statusCode).toBe(400)
  })
  it('manager hors équipe → 403', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // managerOwnsJourney → false
    const res = await app.inject({ method: 'GET', url: `/onboarding/journeys/${SID}`, headers: auth('manager') })
    expect(res.statusCode).toBe(403)
  })
  it('manager de l\'équipe → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // managerOwnsJourney → true
      .mockResolvedValueOnce({ rows: [{ id: SID }] })       // journey
      .mockResolvedValueOnce({ rows: [{ id: 's1' }] })      // steps
    const res = await app.inject({ method: 'GET', url: `/onboarding/journeys/${SID}`, headers: auth('manager') })
    expect(res.statusCode).toBe(200)
  })
  it('parcours introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // journey lookup
    const res = await app.inject({ method: 'GET', url: `/onboarding/journeys/${SID}`, headers: auth('admin') })
    expect(res.statusCode).toBe(404)
  })
  it('admin → 200 + étapes', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, first_name: 'A' }] })
      .mockResolvedValueOnce({ rows: [{ id: 's1' }] })
    const res = await app.inject({ method: 'GET', url: `/onboarding/journeys/${SID}`, headers: auth('readonly') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.steps).toHaveLength(1)
  })
})

// ─── PATCH /journeys/:id ─────────────────────────────────────────────────────
describe('PATCH /onboarding/journeys/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/journeys/${BAD_ID}`,
      headers: auth('admin'), payload: { status: 'cancelled' } })
    expect(res.statusCode).toBe(400)
  })
  it('status invalide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/journeys/${SID}`,
      headers: auth('admin'), payload: { status: 'completed' } })
    expect(res.statusCode).toBe(400)
  })
  it('introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/journeys/${SID}`,
      headers: auth('admin'), payload: { status: 'cancelled' } })
    expect(res.statusCode).toBe(404)
  })
  it('annulation → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] })            // audit
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/journeys/${SID}`,
      headers: auth('hr_manager'), payload: { status: 'cancelled' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('cancelled')
  })
  it('hr_officer → 403', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/journeys/${SID}`,
      headers: auth('hr_officer'), payload: { status: 'cancelled' } })
    expect(res.statusCode).toBe(403)
  })
})

// ─── POST /journeys/:id/steps ────────────────────────────────────────────────
describe('POST /onboarding/journeys/:id/steps', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'POST', url: `/onboarding/journeys/${BAD_ID}/steps`,
      headers: auth('admin'), payload: { title: 'X' } })
    expect(res.statusCode).toBe(400)
  })
  it('étape invalide → 400', async () => {
    const res = await app.inject({ method: 'POST', url: `/onboarding/journeys/${SID}/steps`,
      headers: auth('admin'), payload: { title: '' } })
    expect(res.statusCode).toBe(400)
  })
  it('parcours introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // exists check
    const res = await app.inject({ method: 'POST', url: `/onboarding/journeys/${SID}/steps`,
      headers: auth('admin'), payload: { title: 'Etape' } })
    expect(res.statusCode).toBe(404)
  })
  it('création avec dueDate → 201 + refresh', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // exists
      .mockResolvedValueOnce({ rows: [{ id: 'step-new' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] })                   // audit
    const res = await app.inject({ method: 'POST', url: `/onboarding/journeys/${SID}/steps`,
      headers: auth('hr_officer'), payload: { title: 'Etape ad hoc', dueDate: '2026-07-01', ownerRole: 'employee' } })
    expect(res.statusCode).toBe(201)
    expect(refreshMock).toHaveBeenCalledWith(expect.anything(), 'tenant_sotra', SID)
  })
})

// ─── PATCH /steps/:id ────────────────────────────────────────────────────────
describe('PATCH /onboarding/steps/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${BAD_ID}`,
      headers: auth('admin'), payload: { status: 'done' } })
    expect(res.statusCode).toBe(400)
  })
  it('corps invalide (champ inconnu) → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: auth('admin'), payload: { foo: 1 } })
    expect(res.statusCode).toBe(400)
  })
  it('étape introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // step lookup
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: auth('admin'), payload: { status: 'done' } })
    expect(res.statusCode).toBe(404)
  })
  it('admin : maj complète (tous champs) + status done → 200 + refresh', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] }) // step lookup
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: auth('admin'),
      payload: { title: 'T', description: 'D', phase: 'first_week', ownerRole: 'it',
        dueDate: '2026-08-01', sortOrder: 3, notes: 'N',
        resources: [{ type: 'document', title: 'Doc' }], status: 'done' } })
    expect(res.statusCode).toBe(200)
    expect(refreshMock).toHaveBeenCalled()
  })
  it('status non-done → completed_at remis à NULL (branche else)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: auth('hr_manager'), payload: { status: 'in_progress' } })
    expect(res.statusCode).toBe(200)
    const upd = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('onboarding_steps'))
    expect(String(upd?.[0])).toContain('completed_at = NULL')
  })
  it('aucun champ à modifier (description seule undefined) → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] })
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: auth('admin'), payload: {} })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Aucun champ')
  })
  it('manager hors équipe → 403', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] })
      .mockResolvedValueOnce({ rows: [] }) // managerOwnsJourney → false
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: auth('manager'), payload: { status: 'done' } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('équipe')
  })
  it('manager : statut + notes autorisés → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // owns → true
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: auth('manager'), payload: { status: 'in_progress', notes: 'Avancement' } })
    expect(res.statusCode).toBe(200)
  })
  it('maj sans status (pas de refresh)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: auth('admin'), payload: { notes: 'Juste une note' } })
    expect(res.statusCode).toBe(200)
    expect(refreshMock).not.toHaveBeenCalled()
  })
})

// ─── DELETE /steps/:id ───────────────────────────────────────────────────────
describe('DELETE /onboarding/steps/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/onboarding/steps/${BAD_ID}`, headers: auth('admin') })
    expect(res.statusCode).toBe(400)
  })
  it('introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // DELETE
    const res = await app.inject({ method: 'DELETE', url: `/onboarding/steps/${SID}`, headers: auth('admin') })
    expect(res.statusCode).toBe(404)
  })
  it('supprimé → 200 + refresh', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ journey_id: 'j1' }] }) // DELETE
      .mockResolvedValueOnce({ rows: [] })                     // audit
    const res = await app.inject({ method: 'DELETE', url: `/onboarding/steps/${SID}`, headers: auth('hr_manager') })
    expect(res.statusCode).toBe(200)
    expect(refreshMock).toHaveBeenCalledWith(expect.anything(), 'tenant_sotra', 'j1')
  })
  it('hr_officer → 403', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/onboarding/steps/${SID}`, headers: auth('hr_officer') })
    expect(res.statusCode).toBe(403)
  })
})

// ─── GET /my-journey ─────────────────────────────────────────────────────────
describe('GET /onboarding/my-journey', () => {
  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/onboarding/my-journey' })
    expect(res.statusCode).toBe(401)
  })
  it('aucun employeeId (claim absent, lookup vide) → data null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // currentEmployeeId email lookup
    const res = await app.inject({ method: 'GET', url: '/onboarding/my-journey', headers: auth('employee') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toBeNull()
  })
  it('employeeId via claim, sans parcours → data null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // journey lookup vide
    const res = await app.inject({ method: 'GET', url: '/onboarding/my-journey',
      headers: auth('employee', { employeeId: 'emp1' }) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toBeNull()
  })
  it('employeeId résolu par email + parcours présent → 200 + étapes', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'empE' }] })       // currentEmployeeId email lookup
      .mockResolvedValueOnce({ rows: [{ id: 'jX' }] })         // journey
      .mockResolvedValueOnce({ rows: [{ id: 's1' }] })         // steps
    const res = await app.inject({ method: 'GET', url: '/onboarding/my-journey', headers: auth('employee') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.steps).toHaveLength(1)
  })
})

// ─── PATCH /my-steps/:id ─────────────────────────────────────────────────────
describe('PATCH /onboarding/my-steps/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/my-steps/${BAD_ID}`,
      headers: auth('employee', { employeeId: 'emp1' }), payload: { status: 'done' } })
    expect(res.statusCode).toBe(400)
  })
  it('status invalide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/my-steps/${SID}`,
      headers: auth('employee', { employeeId: 'emp1' }), payload: { status: 'archived' } })
    expect(res.statusCode).toBe(400)
  })
  it('aucun dossier employé → 403', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // currentEmployeeId email lookup vide
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/my-steps/${SID}`,
      headers: auth('employee'), payload: { status: 'done' } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('dossier')
  })
  it('coche une étape (done) → 200 + refresh', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] }) // guard
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/my-steps/${SID}`,
      headers: auth('employee', { employeeId: 'emp1' }), payload: { status: 'done' } })
    expect(res.statusCode).toBe(200)
    const upd = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('onboarding_steps'))
    expect(String(upd?.[0])).toContain('now()')
    expect(upd?.[1]).toEqual([SID, 'done', 'u1'])
  })
  it('décoche une étape (todo) → 200, completed_at NULL', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/my-steps/${SID}`,
      headers: auth('employee', { employeeId: 'emp1' }), payload: { status: 'todo' } })
    expect(res.statusCode).toBe(200)
    const upd = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('onboarding_steps'))
    expect(String(upd?.[0])).toContain('completed_at = NULL')
    expect(upd?.[1]).toEqual([SID, 'todo'])
  })
})
