import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks globaux ──────────────────────────────────────────────────────────────
// vi.hoisted permet aux variables d'être disponibles dans vi.mock (qui est hoisté)
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
    ai:      { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))

vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/recruitment-ai.service.js', () => ({
  analyzeCV: vi.fn(),
  isModelAvailable: (m: string) => m === 'claude',
}))

import authPlugin from '../../plugins/auth.js'
import recruitmentRoutes from './recruitment.routes.js'
import { analyzeCV } from '../../services/recruitment-ai.service.js'

const TENANT_SCHEMA = 'tenant_sotra'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{
  sub: string; email: string; employeeId: string
}> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? 'u-' + role,
    tenantId: 't1',
    schemaName: TENANT_SCHEMA,
    role,
    email: opts.email ?? `${role}@sotra-ci.com`,
    firstName: 'Test',
    lastName:  'User',
    employeeId: opts.employeeId ?? null,
  })
}

// ── Setup ──────────────────────────────────────────────────────────────────────
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

// ── Tests ──────────────────────────────────────────────────────────────────────
describe('POST /recruitment/jobs — visibility & ciblage', () => {
  it('refuse une requête sans titre (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { visibility: 'internal' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('normalise une visibility invalide à "external"', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'job-1', visibility: 'external' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Test', visibility: 'invalid' },
    })
    expect(res.statusCode).toBe(201)
    // 12e param = visibility (zero-indexed 11)
    const args = queryMock.mock.calls[0]![1] as unknown[]
    expect(args[11]).toBe('external')
  })

  it('persiste les critères de ciblage pour une offre interne', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'job-2' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Lead Dev',
        visibility: 'internal',
        target_departments: ['dept-eng'],
        target_job_levels:  ['cadre'],
        target_min_seniority_months: 24,
      },
    })
    expect(res.statusCode).toBe(201)
    const args = queryMock.mock.calls[0]![1] as unknown[]
    expect(args[11]).toBe('internal')
    expect(args[12]).toEqual(['dept-eng'])
    expect(args[13]).toEqual(['cadre'])
    expect(args[14]).toBe(24)
  })

  it('rejette un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Test' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /recruitment/internal-jobs — filtrage interne', () => {
  it('retourne [] si aucun profil employé trouvé', async () => {
    // Premier appel : SELECT employee → vide
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/internal-jobs',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })

  it('passe les critères de l\'employé à la requête SQL', async () => {
    const hireDate = new Date()
    hireDate.setMonth(hireDate.getMonth() - 36) // 3 ans d'ancienneté
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          id: 'emp-1', department_id: 'dept-eng', job_level: 'cadre',
          hire_date: hireDate.toISOString(), legal_entity_id: 'le-1',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', title: 'Lead' }] })

    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/internal-jobs',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    // Le second appel SQL est le filtre — vérifie que les params sont l'employé
    const secondCallArgs = queryMock.mock.calls[1]![1] as unknown[]
    expect(secondCallArgs[0]).toBe('emp-1')
    expect(secondCallArgs[1]).toBe('dept-eng')
    expect(secondCallArgs[2]).toBe('cadre')
    expect(secondCallArgs[3]).toBeGreaterThanOrEqual(35)  // ~36 mois
    expect(secondCallArgs[3]).toBeLessThanOrEqual(37)
    expect(secondCallArgs[4]).toBe('le-1')
  })
})

describe('POST /recruitment/internal-jobs/:id/apply — candidature interne', () => {
  it('refuse si le profil employé est introuvable (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'employee', { email: 'inconnu@sotra-ci.com' })
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/internal-jobs/job-1/apply',
      headers: { authorization: `Bearer ${token}` },
      payload: { cover_letter: 'Lettre.' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuse une seconde candidature au même poste (409)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1', first_name: 'A', last_name: 'B', email: 'a@b.com', phone: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'existing-app' }] })  // déjà postulé

    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/internal-jobs/job-1/apply',
      headers: { authorization: `Bearer ${token}` },
      payload: { cover_letter: 'Je postule.' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('crée la candidature avec source="internal"', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1', first_name: 'Alice', last_name: 'M', email: 'alice@x.com', phone: '+225...' }] })
      .mockResolvedValueOnce({ rows: [] })  // pas de doublon
      .mockResolvedValueOnce({ rows: [{ id: 'app-new', source: 'internal' }] })

    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/internal-jobs/job-1/apply',
      headers: { authorization: `Bearer ${token}` },
      payload: { cover_letter: 'Je suis motivée.' },
    })
    expect(res.statusCode).toBe(201)
    // Le dernier INSERT contient source = 'internal' implicite (en dur)
    expect(JSON.parse(res.body).data.source).toBe('internal')
  })
})

describe('POST /recruitment/applications/:id/analyze-cv', () => {
  it('refuse si le CV est absent ou trop court (400)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'app-1', job_id: 'job-1', cv_text: 'court', cover_letter: null }],
    })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/analyze-cv',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('appelle le service IA et persiste le résultat', async () => {
    const longCv = 'Marie Konaté, 5 ans expérience RH Abidjan, licence GRH, CNPS, ITS, Excel.'.repeat(3)
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', cv_text: longCv, cover_letter: null }] })
      .mockResolvedValueOnce({ rows: [{ title: 'Chargé RH', description: '…', requirements: '…', salaryMin: 400000, salaryMax: 600000 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', ai_score: 85, ai_recommendation: 'yes' }] })

    vi.mocked(analyzeCV).mockResolvedValueOnce({
      score: 85,
      recommendation: 'yes',
      summary: 'OK',
      strengths: ['CNPS', 'ITS'],
      gaps: [],
      redFlags: [],
      interviewQuestions: ['Q1', 'Q2', 'Q3'],
      matchPercentage: 88,
      modelUsed: 'claude',
    })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/analyze-cv',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude' },
    })
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(analyzeCV)).toHaveBeenCalledWith('claude', expect.any(Object), longCv)
    const body = JSON.parse(res.body)
    expect(body.analysis.score).toBe(85)
  })
})

describe('GET /recruitment/ai/capabilities', () => {
  it('retourne le statut de chaque modèle', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/ai/capabilities',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ claude: true, mistral: false })
  })
})
