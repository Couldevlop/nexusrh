/**
 * Entonnoir de recrutement fiable (marque employeur, lot 2) :
 *   - historique des étapes écrit dans la MÊME instruction que le changement ;
 *   - motif de rejet en liste fermée ; date d'embauche réelle ;
 *   - passage en `hired` ⇒ fiche employé (hireApplication) AVANT l'étape ;
 *   - GET /recruitment/funnel-stats : agrégats, RBAC indicateurs.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, hireMock, prefillMock, HireErrorMock } = vi.hoisted(() => {
  class HireErrorMock extends Error {
    constructor(readonly statusCode: number, message: string, readonly code: string) { super(message) }
  }
  return { queryMock: vi.fn(), hireMock: vi.fn(), prefillMock: vi.fn(), HireErrorMock }
})
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
vi.mock('../../db/provisioning.js', () => ({ ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./hire.service.js', () => ({
  hireApplication: hireMock,
  getHirePrefill: prefillMock,
  HireError: HireErrorMock,
}))

import authPlugin from '../../plugins/auth.js'
import recruitmentRoutes from './recruitment.routes.js'
import { buildFunnelStats, rate } from './funnel-stats.routes.js'

const SCHEMA = 'tenant_sotra'
const APP_ID = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
function tokenFor(app: FastifyInstance, role: string, sub = USER) {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
  hireMock.mockReset()
  prefillMock.mockReset()
})

const patchStage = (payload: Record<string, unknown>, role = 'hr_manager') => app.inject({
  method: 'PATCH', url: `/recruitment/applications/${APP_ID}/stage`,
  headers: { authorization: `Bearer ${tokenFor(app, role)}` }, payload,
})

describe('PATCH /applications/:id/stage — historique + motifs', () => {
  it('écrit l’historique dans la même instruction que le changement d’étape', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: APP_ID, stage: 'interview' }] })
    const res = await patchStage({ stage: 'interview' })
    expect(res.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]!
    expect(String(sql)).toContain('application_stage_history')
    expect(String(sql)).toMatch(/prev\.stage IS DISTINCT FROM upd\.stage/)
    expect(params).toEqual(['interview', null, APP_ID, null, null, USER])
  })

  it('rejet : motif de la liste fermée + note transmis', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: APP_ID, job_id: 'j', stage: 'rejected' }] })
    const res = await patchStage({ stage: 'rejected', rejection_reason: 'declined_by_candidate_salary', rejection_note: '  Attend 20 % de plus  ' })
    expect(res.statusCode).toBe(200)
    const params = queryMock.mock.calls[0]![1] as unknown[]
    expect(params[3]).toBe('declined_by_candidate_salary')
    expect(params[4]).toBe('Attend 20 % de plus')
  })

  it('refuse un motif hors liste (400)', async () => {
    const res = await patchStage({ stage: 'rejected', rejection_reason: 'trop_cher' })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('refuse une note > 500 caractères (400)', async () => {
    const res = await patchStage({ stage: 'rejected', rejection_reason: 'other', rejection_note: 'x'.repeat(501) })
    expect(res.statusCode).toBe(400)
  })

  it('rejet sans motif refusé (400) — aucune écriture', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: APP_ID, job_id: 'j', stage: 'rejected' }] })
    const res = await patchStage({ stage: 'rejected' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).code).toBe('REJECTION_REASON_REQUIRED')
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('UPDATE'))).toBe(false)
  })

  it('motif rejected_auto_screening réservé au pré-tri (400)', async () => {
    const res = await patchStage({ stage: 'rejected', rejection_reason: 'rejected_auto_screening' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).code).toBe('REJECTION_REASON_RESERVED')
  })

  it('motif inutile hors rejet : non exigé pour les autres étapes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: APP_ID, stage: 'interview' }] })
    const res = await patchStage({ stage: 'interview' })
    expect(res.statusCode).toBe(200)
  })

  it('hired_at posé au passage en hired, effacé sinon (SQL)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: APP_ID, stage: 'offer' }] })
    await patchStage({ stage: 'offer' })
    expect(String(queryMock.mock.calls[0]![0])).toMatch(/hired_at = CASE WHEN \$1::text = 'hired' THEN COALESCE\(a\.hired_at, now\(\)\) ELSE NULL END/)
  })

  it('auteur non UUID (jeton technique) → changed_by NULL, jamais d’échec', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: APP_ID, stage: 'test' }] })
    await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP_ID}/stage`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager', 'u-technique')}` },
      payload: { stage: 'test' },
    })
    expect((queryMock.mock.calls[0]![1] as unknown[])[5]).toBeNull()
  })

  it('RBAC : readonly et manager ne déplacent pas une candidature (403)', async () => {
    expect((await patchStage({ stage: 'interview' }, 'readonly')).statusCode).toBe(403)
    expect((await patchStage({ stage: 'interview' }, 'manager')).statusCode).toBe(403)
  })
})

describe('PATCH /applications/:id/stage — embauche', () => {
  it('crée la fiche employé AVANT le changement d’étape et la renvoie', async () => {
    const order: string[] = []
    hireMock.mockImplementation(async () => {
      order.push('hire')
      return { status: 'created', employeeId: 'emp-1', employeeNumber: 'MAT00042', toComplete: ['baseSalary'], onboarding: null, onboardingError: false }
    })
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('application_stage_history')) order.push('stage')
      return { rows: [{ id: APP_ID, job_id: 'j', stage: 'hired' }] }
    })
    const res = await patchStage({ stage: 'hired', employee: { hireDate: '2026-12-01', baseSalary: 250000, contractType: 'cdd' } })
    expect(res.statusCode).toBe(200)
    expect(order.slice(0, 2)).toEqual(['hire', 'stage'])
    expect(hireMock).toHaveBeenCalledWith(SCHEMA, APP_ID,
      { hireDate: '2026-12-01', baseSalary: 250000, contractType: 'cdd' },
      expect.objectContaining({ userId: USER }))
    expect(JSON.parse(res.body).hire.employeeId).toBe('emp-1')
  })

  it('échec de création (ex. SMIG) : l’étape ne bouge pas', async () => {
    hireMock.mockRejectedValue(new HireErrorMock(422, 'Le salaire ne peut pas être inférieur au SMIG', 'SALARY_BELOW_SMIG'))
    const res = await patchStage({ stage: 'hired', employee: { baseSalary: 1000 } })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).code).toBe('SALARY_BELOW_SMIG')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('candidature inconnue → 404 sans écriture', async () => {
    hireMock.mockResolvedValue(null)
    const res = await patchStage({ stage: 'hired' })
    expect(res.statusCode).toBe(404)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('hr_officer peut recruter (même RBAC que la création d’employé)', async () => {
    hireMock.mockResolvedValue({ status: 'already_linked', employeeId: 'emp-1', employeeNumber: null, toComplete: [], onboarding: null, onboardingError: false })
    queryMock.mockResolvedValue({ rows: [{ id: APP_ID, job_id: 'j', stage: 'hired' }] })
    expect((await patchStage({ stage: 'hired' }, 'hr_officer')).statusCode).toBe(200)
  })

  it('refuse des champs de fiche inconnus (400)', async () => {
    const res = await patchStage({ stage: 'hired', employee: { nni: 'CI123' } })
    expect(res.statusCode).toBe(400)
    expect(hireMock).not.toHaveBeenCalled()
  })
})

describe('GET /applications/:id/hire-prefill', () => {
  it('renvoie le pré-remplissage', async () => {
    prefillMock.mockResolvedValue({ firstName: 'Koffi', hireDate: '2026-12-01' })
    const res = await app.inject({
      method: 'GET', url: `/recruitment/applications/${APP_ID}/hire-prefill`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.firstName).toBe('Koffi')
  })
  it('404 si inconnue, 400 si id invalide, 403 pour readonly', async () => {
    prefillMock.mockResolvedValue(null)
    const h = { authorization: `Bearer ${tokenFor(app, 'admin')}` }
    expect((await app.inject({ method: 'GET', url: `/recruitment/applications/${APP_ID}/hire-prefill`, headers: h })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/recruitment/applications/xx/hire-prefill', headers: h })).statusCode).toBe(400)
    expect((await app.inject({
      method: 'GET', url: `/recruitment/applications/${APP_ID}/hire-prefill`,
      headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` },
    })).statusCode).toBe(403)
  })
})

describe('Création de candidature — entrée initiale de l’historique', () => {
  it('candidature interne : INSERT + historique dans la même instruction', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1', first_name: 'A', last_name: 'B', email: 'a@b.ci', phone: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: APP_ID, stage: 'new' }] })
    const res = await app.inject({
      method: 'POST', url: '/recruitment/internal-jobs/33333333-3333-4333-8333-333333333333/apply',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` }, payload: {},
    })
    expect(res.statusCode).toBe(201)
    const sql = String(queryMock.mock.calls[2]![0])
    expect(sql).toMatch(/WITH ins AS \(\s*INSERT INTO "tenant_sotra"\.applications/)
    expect(sql).toContain('INSERT INTO "tenant_sotra".application_stage_history')
    expect(queryMock.mock.calls[2]![1]).toContain(USER)
  })

  it('saisie RH : historique avec l’auteur', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: APP_ID, stage: 'new' }] })
    const res = await app.inject({
      method: 'POST', url: '/recruitment/applications',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { job_id: '33333333-3333-4333-8333-333333333333', first_name: 'A', last_name: 'B', email: 'a@b.ci' },
    })
    expect(res.statusCode).toBe(201)
    expect(String(queryMock.mock.calls[0]![0])).toContain('application_stage_history')
  })
})

describe('GET /recruitment/funnel-stats', () => {
  it('assemble conversions, acceptation des offres, délai et motifs', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (s.includes('AS reached_0')) {
        return { rows: [{ total: 10, reached_0: 10, reached_1: 8, reached_2: 5, reached_3: 4, reached_4: 3, reached_5: 2,
          hired: 2, rejected: 6, offers_declined: 1, candidate_withdrawals: 2 }] }
      }
      if (s.includes("COALESCE(rejection_reason, 'unspecified')")) {
        return { rows: [{ reason: 'rejected_profile', count: 3 }, { reason: 'declined_by_candidate_salary', count: 2 }, { reason: 'unspecified', count: 1 }] }
      }
      if (s.includes('percentile_cont')) return { rows: [{ hires: 2, avg_days: 21.26, median_days: 21.26, min_days: 14, max_days: 28.5 }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: '/recruitment/funnel-stats?from=2026-01-01&to=2026-12-31&jobId=33333333-3333-4333-8333-333333333333',
      headers: { authorization: `Bearer ${tokenFor(app, 'dg')}` },
    })
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body).data
    expect(d.totalApplications).toBe(10)
    expect(d.conversions[0]).toEqual({ from: 'new', to: 'screening', fromCount: 10, toCount: 8, rate: 80 })
    expect(d.offers).toEqual({ made: 3, accepted: 2, declinedByCandidate: 1, acceptanceRate: 66.7 })
    expect(d.timeToHire.averageDays).toBe(21.3)
    expect(d.rejectionReasons[0]).toEqual({ reason: 'rejected_profile', count: 3, share: 50 })
    // Filtres passés en paramètres liés (jamais interpolés)
    expect(queryMock.mock.calls[0]![1]).toEqual(['2026-01-01', '2026-12-31', '33333333-3333-4333-8333-333333333333'])
    // Agrégats uniquement
    expect(res.body).not.toMatch(/first_name|email/)
  })

  it('valide les filtres (400)', async () => {
    const h = { authorization: `Bearer ${tokenFor(app, 'admin')}` }
    expect((await app.inject({ method: 'GET', url: '/recruitment/funnel-stats?from=2026-13', headers: h })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/recruitment/funnel-stats?jobId=abc', headers: h })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/recruitment/funnel-stats?from=2026-05-01&to=2026-01-01', headers: h })).statusCode).toBe(400)
  })

  it.each(['admin', 'hr_manager', 'dg', 'readonly'])('autorise %s', async (role) => {
    const res = await app.inject({
      method: 'GET', url: '/recruitment/funnel-stats',
      headers: { authorization: `Bearer ${tokenFor(app, role)}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it.each(['hr_officer', 'manager', 'employee'])('refuse %s (403)', async (role) => {
    const res = await app.inject({
      method: 'GET', url: '/recruitment/funnel-stats',
      headers: { authorization: `Bearer ${tokenFor(app, role)}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('500 propre sur erreur base', async () => {
    queryMock.mockRejectedValue(new Error('boom'))
    const res = await app.inject({
      method: 'GET', url: '/recruitment/funnel-stats',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('buildFunnelStats — cas limites', () => {
  it('aucune donnée : taux null, jamais de division par zéro', () => {
    const s = buildFunnelStats({ from: null, to: null, jobId: null },
      { total: 0, hired: 0, rejected: 0, offers_declined: 0, candidate_withdrawals: 0 }, [],
      { hires: 0, avg_days: null, median_days: null, min_days: null, max_days: null })
    expect(s.conversions.every((c) => c.rate === null)).toBe(true)
    expect(s.offers.acceptanceRate).toBeNull()
    expect(s.timeToHire.averageDays).toBeNull()
    expect(rate(1, 3)).toBe(33.3)
  })
})
