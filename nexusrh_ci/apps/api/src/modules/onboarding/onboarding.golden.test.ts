/**
 * GOLDEN — Parcours d'intégration (onboarding).
 *
 * Couvre :
 *   - selectBestTemplate (pure) : matching séniorité / mots-clés / défaut ;
 *   - computeDueDate (pure) : échéances relatives à l'embauche ;
 *   - RBAC : modèles réservés admin/hr_manager, parcours interdits sans token ;
 *   - IDOR (A01) : un collaborateur ne coche QUE ses étapes (owner employee)
 *     de SON parcours ; un manager ne touche pas hors équipe ;
 *   - génération IA : brouillon retourné (service mocké), RBAC appliqué.
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

// La migration lazy exécute ~200 DDL : neutralisée pour ne pas polluer queryMock.
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }))
vi.mock('../../services/onboarding-ai.service.js', () => ({
  generateOnboardingPlan: generateMock,
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
import {
  selectBestTemplate,
  computeDueDate,
  type OnboardingTemplateRow,
} from '../../services/onboarding.service.js'

let app: FastifyInstance
const SID = '44444444-4444-4444-4444-444444444444'

function token(role: string, over: Record<string, unknown> = {}) {
  return app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null, ...over })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(onboardingRoutes, { prefix: '/onboarding' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  generateMock.mockReset()
})

// ─── selectBestTemplate (pure) ───────────────────────────────────────────────
describe('selectBestTemplate — matching séniorité / type de poste', () => {
  const tpl = (over: Partial<OnboardingTemplateRow>): OnboardingTemplateRow => ({
    id: 't', name: 'T', seniority: 'any', job_keywords: null, department_id: null,
    is_active: true, is_default: false, ...over,
  })

  it('mots-clés du poste prioritaires sur le modèle générique', () => {
    const best = selectBestTemplate(
      [
        tpl({ id: 'generic', is_default: true }),
        tpl({ id: 'driver', job_keywords: 'conducteur, chauffeur' }),
      ],
      { job_title: 'Chauffeur de bus ligne 12', job_level: null, department_id: null },
    )
    expect(best?.id).toBe('driver')
  })

  it('séniorité exacte (cadre) bat le modèle générique', () => {
    const best = selectBestTemplate(
      [tpl({ id: 'generic', is_default: true }), tpl({ id: 'exec', seniority: 'cadre' })],
      { job_title: 'Directeur Financier', job_level: 'cadre', department_id: null },
    )
    expect(best?.id).toBe('exec')
  })

  it('un modèle à séniorité explicite NON correspondante est écarté', () => {
    const best = selectBestTemplate(
      [tpl({ id: 'exec', seniority: 'cadre' })],
      { job_title: 'Agent de guichet', job_level: 'junior', department_id: null },
    )
    expect(best).toBeNull()
  })

  it('repli sur le modèle par défaut quand rien ne matche mieux', () => {
    const best = selectBestTemplate(
      [tpl({ id: 'generic', is_default: true }), tpl({ id: 'other' })],
      { job_title: 'Poste quelconque', job_level: null, department_id: null },
    )
    expect(best?.id).toBe('generic')
  })

  it('les modèles inactifs sont ignorés', () => {
    const best = selectBestTemplate(
      [tpl({ id: 'off', is_active: false, is_default: true })],
      { job_title: 'X', job_level: null, department_id: null },
    )
    expect(best).toBeNull()
  })
})

describe('computeDueDate — échéances relatives à l\'embauche', () => {
  it('offset positif, négatif (pré-boarding) et zéro', () => {
    expect(computeDueDate('2026-06-15', 0)).toBe('2026-06-15')
    expect(computeDueDate('2026-06-15', 7)).toBe('2026-06-22')
    expect(computeDueDate('2026-06-15', -3)).toBe('2026-06-12')
  })
  it('sans date d\'embauche → null', () => {
    expect(computeDueDate(null, 5)).toBeNull()
  })
})

// ─── RBAC ────────────────────────────────────────────────────────────────────
describe('RBAC onboarding', () => {
  it('GET /onboarding/journeys sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/onboarding/journeys' })
    expect(res.statusCode).toBe(401)
  })

  it('POST /onboarding/templates par hr_officer → 403 (réservé admin/hr_manager)', async () => {
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates',
      headers: { authorization: `Bearer ${token('hr_officer')}` },
      payload: { name: 'X' } })
    expect(res.statusCode).toBe(403)
  })

  it('POST /onboarding/templates par hr_manager → 201 + étapes insérées', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'tpl1' }] }) // INSERT template
      .mockResolvedValueOnce({ rows: [] })               // INSERT step 1
      .mockResolvedValueOnce({ rows: [] })               // audit
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates',
      headers: { authorization: `Bearer ${token('hr_manager')}` },
      payload: { name: 'Parcours cadre', seniority: 'cadre',
        steps: [{ title: 'Accueil DG', phase: 'day_one', ownerRole: 'manager', dueOffsetDays: 0 }] } })
    expect(res.statusCode).toBe(201)
    const stepInsert = queryMock.mock.calls.find((c) => String(c[0]).includes('onboarding_template_steps'))
    expect(stepInsert?.[1]?.[1]).toBe('Accueil DG')
  })

  it('GET /onboarding/templates accessible en lecture à hr_officer', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/onboarding/templates',
      headers: { authorization: `Bearer ${token('hr_officer')}` } })
    expect(res.statusCode).toBe(200)
  })

  it('employee → 403 sur les routes RH', async () => {
    const res = await app.inject({ method: 'GET', url: '/onboarding/journeys',
      headers: { authorization: `Bearer ${token('employee')}` } })
    expect(res.statusCode).toBe(403)
  })
})

// ─── IDOR self-service (A01) ─────────────────────────────────────────────────
describe('PATCH /onboarding/my-steps/:id — IDOR', () => {
  it('étape hors de mon parcours (ou non assignée employee) → 403', async () => {
    // currentEmployeeId via claim → pas de requête ; lookup étape → vide
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/my-steps/${SID}`,
      headers: { authorization: `Bearer ${token('employee', { employeeId: 'emp1' })}` },
      payload: { status: 'done' } })
    expect(res.statusCode).toBe(403)
  })

  it('ma propre étape (owner employee) → 200 + parcours recalculé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] }) // étape de MON parcours
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE step
      .mockResolvedValueOnce({ rows: [] })                              // refreshJourneyStatus
      .mockResolvedValueOnce({ rows: [] })                              // audit
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/my-steps/${SID}`,
      headers: { authorization: `Bearer ${token('employee', { employeeId: 'emp1' })}` },
      payload: { status: 'done' } })
    expect(res.statusCode).toBe(200)
    // La requête de contrôle verrouille bien owner_role = 'employee' + employee_id
    const guard = queryMock.mock.calls[0]
    expect(String(guard?.[0])).toContain(`owner_role = 'employee'`)
    expect(guard?.[1]).toEqual([SID, 'emp1'])
    // Le statut du parcours est recalculé
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('onboarding_journeys j'))).toBe(true)
  })
})

// ─── Manager : limité à son équipe ───────────────────────────────────────────
describe('PATCH /onboarding/steps/:id — périmètre manager', () => {
  it('manager hors équipe → 403', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] }) // étape
      .mockResolvedValueOnce({ rows: [] })                              // managerOwnsJourney → non
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: { authorization: `Bearer ${token('manager')}` },
      payload: { status: 'done' } })
    expect(res.statusCode).toBe(403)
  })

  it('manager de l\'équipe : statut OK, mais replanification interdite', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SID, journey_id: 'j1' }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // managerOwnsJourney → oui
    const res = await app.inject({ method: 'PATCH', url: `/onboarding/steps/${SID}`,
      headers: { authorization: `Bearer ${token('manager')}` },
      payload: { status: 'done', dueDate: '2026-07-01' } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('statut')
  })
})

// ─── Génération IA ───────────────────────────────────────────────────────────
describe('POST /onboarding/templates/generate — IA', () => {
  it('hr_manager → 200 avec le brouillon généré (service mocké)', async () => {
    generateMock.mockResolvedValueOnce({
      name: 'Intégration Comptable Senior',
      description: 'Parcours généré',
      steps: [{ title: 'Accueil', description: '', phase: 'day_one', ownerRole: 'hr', dueOffsetDays: 0, resources: [] }],
    })
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates/generate',
      headers: { authorization: `Bearer ${token('hr_manager')}` },
      payload: { jobTitle: 'Comptable Senior', seniority: 'senior' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.name).toBe('Intégration Comptable Senior')
    expect(generateMock).toHaveBeenCalledWith(expect.objectContaining({
      jobTitle: 'Comptable Senior', schemaName: 'tenant_sotra',
    }))
  })

  it('IA indisponible → 502 sans détails internes', async () => {
    generateMock.mockRejectedValueOnce(new Error('boom interne avec secrets'))
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates/generate',
      headers: { authorization: `Bearer ${token('admin')}` },
      payload: { jobTitle: 'Comptable' } })
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain('boom interne')
  })

  it('manager → 403 (génération réservée admin/hr_manager)', async () => {
    const res = await app.inject({ method: 'POST', url: '/onboarding/templates/generate',
      headers: { authorization: `Bearer ${token('manager')}` },
      payload: { jobTitle: 'X Y' } })
    expect(res.statusCode).toBe(403)
  })
})
