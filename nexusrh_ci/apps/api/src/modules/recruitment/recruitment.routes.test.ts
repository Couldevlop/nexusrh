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
  sourceProfiles: vi.fn(),
  sourceProfilesCompare: vi.fn(),
  // Par défaut : claude OK, mistral KO (préserve le test capabilities existant).
  // Les tests de compare réécrivent ce mock à la volée si besoin.
  isModelAvailable: vi.fn((m: string) => m === 'claude'),
}))

// Credentials IA résolus sans requête BD (évite tout décalage des séquences de mocks).
vi.mock('../../services/ai-credentials.service.js', () => ({
  resolveAiCreds: vi.fn().mockResolvedValue({
    claude:  { apiKey: 'sk-ant-test', model: 'claude-sonnet-4' },
    mistral: { apiKey: null,          model: 'mistral-large' },
    preferredProvider: 'claude',
  }),
}))

import authPlugin from '../../plugins/auth.js'
import recruitmentRoutes from './recruitment.routes.js'
import {
  analyzeCV, sourceProfiles, sourceProfilesCompare, isModelAvailable,
} from '../../services/recruitment-ai.service.js'

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

beforeEach(() => {
  queryMock.mockReset()
  vi.mocked(analyzeCV).mockReset()
  vi.mocked(sourceProfiles).mockReset()
  vi.mocked(sourceProfilesCompare).mockReset()
})

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
      // 4e appel : INSERT audit_log (non bloquant, OWASP A09)
      .mockResolvedValueOnce({ rows: [] })

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
    // analyzeCV reçoit 5 args : model, job, cvText, decisionExamples?, pdfBuffer?
    expect(vi.mocked(analyzeCV)).toHaveBeenCalledWith(
      'claude', expect.any(Object), longCv, undefined, null, expect.any(Object),
    )
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

describe('POST /recruitment/jobs/:id/source — Sourcing IA', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source',
      headers: { authorization: `Bearer ${token}` },
      payload: { max_profiles: 5 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('retourne 404 si l\'offre est introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/missing/source',
      headers: { authorization: `Bearer ${token}` },
      payload: { max_profiles: 5 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('appelle sourceProfiles avec les bons paramètres et persiste un log audit', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          title: 'Lead Dev', description: 'Build cool stuff',
          requirements: 'TS', contractType: 'cdi',
          location: 'Abidjan', salaryMin: 800_000, salaryMax: 1_200_000,
          currency: 'XOF',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // audit_log INSERT

    vi.mocked(sourceProfiles).mockResolvedValueOnce({
      provider: 'claude', model: 'claude-sonnet-4-test',
      data: {
        strategy: {
          summary: 's', bestPlatforms: [], searchKeywords: [],
          booleanSearch: '', estimatedTimeToFill: '',
          salaryBenchmark: { min: 0, max: 0, median: 0, currency: 'XOF' },
          tips: [],
        },
        profiles: [{
          firstName: 'A', lastName: 'B', currentPosition: '', currentCompany: '',
          location: '', experienceYears: 0, keySkills: [], matchScore: 80,
          availabilityEstimate: 'passive', suggestedPlatform: '', linkedinSearch: '',
          approachStrategy: '', estimatedSalary: 0, estimatedSalaryCurrency: 'XOF',
        }],
      },
      jsonValid: true, richnessScore: 60, profilesGenerated: 1,
      latencyMs: 1500, inputTokens: 1000, outputTokens: 2000,
      estimatedCostEur: 0.034, error: null,
    })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude', countries: ['CI', 'SN'], platforms: ['LinkedIn'], max_profiles: 8 },
    })
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(sourceProfiles)).toHaveBeenCalledWith(
      'claude', expect.objectContaining({ title: 'Lead Dev' }),
      ['LinkedIn'], 8, ['CI', 'SN'], expect.any(Object),
    )
    const body = JSON.parse(res.body)
    expect(body.meta.provider).toBe('claude')
    expect(body.meta.richnessScore).toBe(60)
    expect(body.data.profiles[0].firstName).toBe('A')
  })

  it('cappe max_profiles à 20', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'X' }] })
      .mockResolvedValueOnce({ rows: [] })

    vi.mocked(sourceProfiles).mockResolvedValueOnce({
      provider: 'claude', model: 'm', data: null, jsonValid: false,
      richnessScore: 0, profilesGenerated: 0, latencyMs: 0,
      inputTokens: 0, outputTokens: 0, estimatedCostEur: 0, error: null,
    })

    const token = tokenFor(app, 'hr_manager')
    await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source',
      headers: { authorization: `Bearer ${token}` },
      payload: { max_profiles: 999 },
    })
    const call = vi.mocked(sourceProfiles).mock.calls[0]!
    expect(call[3]).toBe(20)
  })

  it('utilise des valeurs par défaut si countries/platforms absents', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'X' }] })
      .mockResolvedValueOnce({ rows: [] })

    vi.mocked(sourceProfiles).mockResolvedValueOnce({
      provider: 'claude', model: 'm', data: null, jsonValid: false,
      richnessScore: 0, profilesGenerated: 0, latencyMs: 0,
      inputTokens: 0, outputTokens: 0, estimatedCostEur: 0, error: null,
    })

    const token = tokenFor(app, 'hr_manager')
    await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    const call = vi.mocked(sourceProfiles).mock.calls[0]!
    expect(call[4]).toEqual(['CI'])
    expect(call[2]).toContain('LinkedIn')
  })
})

describe('GET /recruitment/jobs/:id/sourced-profiles — liste cache', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/job-1/sourced-profiles',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('retourne la liste des profils en cache ordonnés par match_score DESC', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'sp-1', job_id: 'job-1', first_name: 'A', last_name: 'X', match_score: 92, transferred_to_application_id: null },
        { id: 'sp-2', job_id: 'job-1', first_name: 'B', last_name: 'Y', match_score: 85, transferred_to_application_id: 'app-7' },
      ],
    })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/job-1/sourced-profiles',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].first_name).toBe('A')
    expect(body.data[1].transferred_to_application_id).toBe('app-7')
  })
})

describe('POST /recruitment/jobs/:id/sourced-profiles/:profileId/transfer', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/sp-1/transfer',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /recruitment/jobs/:id/source/compare — Claude vs Mistral', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source/compare',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('retourne 422 si MISTRAL_API_KEY absente', async () => {
    // isModelAvailable est mocké : claude=true, mistral=false → comparaison KO
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source/compare',
      headers: { authorization: `Bearer ${token}` },
      payload: { max_profiles: 3 },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toMatch(/MISTRAL/i)
  })

  it('appelle sourceProfilesCompare quand les deux modèles sont disponibles', async () => {
    vi.mocked(isModelAvailable).mockImplementation(() => true)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Lead', description: 'd', requirements: 'r' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    vi.mocked(sourceProfilesCompare).mockResolvedValueOnce({
      winner: 'claude',
      claude: {
        provider: 'claude', model: 'c', data: null, jsonValid: true,
        richnessScore: 75, profilesGenerated: 3, latencyMs: 2000,
        inputTokens: 500, outputTokens: 1500, estimatedCostEur: 0.025, error: null,
      },
      mistral: {
        provider: 'mistral', model: 'm', data: null, jsonValid: true,
        richnessScore: 60, profilesGenerated: 3, latencyMs: 1500,
        inputTokens: 500, outputTokens: 1500, estimatedCostEur: 0.011, error: null,
      },
      ratios: { latency: 'l', cost: 'c', richness: 'r' },
      recommendation: 'Claude recommandé',
    })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source/compare',
      headers: { authorization: `Bearer ${token}` },
      payload: { max_profiles: 5, countries: ['NG'] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.comparison.winner).toBe('claude')
    expect(body.comparison.recommendation).toContain('Claude')
    expect(body.comparison.summary.claude.richnessScore).toBe(75)
    expect(body.comparison.summary.mistral.richnessScore).toBe(60)

    // Restaure le mock par défaut
    vi.mocked(isModelAvailable).mockImplementation((m: string) => m === 'claude')
  })
})

describe('POST /recruitment/jobs/:id/preselect — pré-sélection en lot', () => {
  it('retourne 404 si l\'offre n\'existe pas', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/unknown-job/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuse un stage invalide (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: { stages: ['NOT_A_REAL_STAGE'] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('retourne total=0 quand aucune candidature à analyser', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Test', description: null, requirements: null }] })
      .mockResolvedValueOnce({ rows: [] })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(0)
    expect(body.analyzed).toBe(0)
    expect(body.top).toEqual([])
  })

  it('analyse plusieurs candidatures, ignore les CV trop courts, retourne top trié par score', async () => {
    const longCv = 'Excellent profil ivoirien avec 8 ans d\'expérience RH et certifications.'.repeat(5)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Chargé RH', description: 'desc', requirements: 'CNPS ITS' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'app-1', cv_text: 'court', cover_letter: null, first_name: 'A', last_name: 'B' },
          { id: 'app-2', cv_text: longCv, cover_letter: null, first_name: 'C', last_name: 'D' },
          { id: 'app-3', cv_text: longCv, cover_letter: null, first_name: 'E', last_name: 'F' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // recruitment_decisions (feedback loop, vide)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    vi.mocked(analyzeCV)
      .mockResolvedValueOnce({
        score: 70, recommendation: 'maybe', summary: 'ok', strengths: [], gaps: [], redFlags: [],
        interviewQuestions: ['Q1', 'Q2', 'Q3'], matchPercentage: 65, modelUsed: 'claude',
      })
      .mockResolvedValueOnce({
        score: 90, recommendation: 'strong_yes', summary: 'top', strengths: [], gaps: [], redFlags: [],
        interviewQuestions: ['Q1', 'Q2', 'Q3'], matchPercentage: 95, modelUsed: 'claude',
      })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(3)
    expect(body.analyzed).toBe(2)
    expect(body.skipped).toBe(1)
    expect(body.failed).toBe(0)
    expect(body.top).toHaveLength(2)
    expect(body.top[0].score).toBe(90)
    expect(body.top[1].score).toBe(70)
  })

  it('injecte criteria.focus dans les requirements de l\'offre passés à analyzeCV', async () => {
    const longCv = 'Candidat avec expérience SAP solide et anglais bilingue.'.repeat(5)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Consultant', description: 'desc', requirements: 'CNPS, OHADA', ai_focus_text: null }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE recruitment_jobs (persistance ai_focus_text)
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', cv_text: longCv, cover_letter: null, first_name: 'C', last_name: 'D' }] })
      .mockResolvedValueOnce({ rows: [] }) // recruitment_decisions (feedback loop)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    vi.mocked(analyzeCV).mockResolvedValueOnce({
      score: 80, recommendation: 'yes', summary: 'ok', strengths: [], gaps: [], redFlags: [],
      interviewQuestions: ['Q1', 'Q2', 'Q3'], matchPercentage: 80, modelUsed: 'claude',
    })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: { criteria: { focus: 'Privilégier les profils SAP avec anglais courant' } },
    })

    expect(res.statusCode).toBe(200)
    const callArgs = vi.mocked(analyzeCV).mock.calls[0]
    expect(callArgs?.[1].requirements).toContain('Priorité du recruteur : Privilégier les profils SAP avec anglais courant')
    expect(callArgs?.[1].requirements).toContain('CNPS, OHADA')
  })

  it('non-régression RBAC : un employee ne peut pas déclencher la pré-sélection (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('persistance : sauvegarde criteria.focus dans recruitment_jobs.ai_focus_text', async () => {
    const longCv = 'Candidat solide avec expérience confirmée.'.repeat(5)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Job', description: '', requirements: '', ai_focus_text: null }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE recruitment_jobs.ai_focus_text
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', cv_text: longCv, cover_letter: null, first_name: 'X', last_name: 'Y' }] })
      .mockResolvedValueOnce({ rows: [] }) // recruitment_decisions (feedback loop)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE applications
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    vi.mocked(analyzeCV).mockResolvedValueOnce({
      score: 75, recommendation: 'yes', summary: '', strengths: [], gaps: [], redFlags: [],
      interviewQuestions: ['Q1', 'Q2', 'Q3'], matchPercentage: 75, modelUsed: 'claude',
    })

    const token = tokenFor(app, 'hr_manager')
    await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: { criteria: { focus: 'Profils bilingues uniquement' } },
    })

    // Vérifie que la requête UPDATE ai_focus_text a bien été émise (2e call queryMock)
    const updateCall = queryMock.mock.calls[1]
    expect(updateCall?.[0]).toContain('UPDATE')
    expect(updateCall?.[0]).toContain('ai_focus_text')
    expect(updateCall?.[1]).toEqual(['Profils bilingues uniquement', 'job-1'])
  })

  it('feedback loop : injecte les décisions passées du tenant dans le prompt et retourne learningExamples', async () => {
    const longCv = 'Candidate experienced and qualified for the role.'.repeat(5)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Tech Lead', description: 'desc', requirements: 'React', ai_focus_text: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', cv_text: longCv, cover_letter: null, first_name: 'M', last_name: 'K' }] })
      .mockResolvedValueOnce({
        rows: [
          { decision: 'hired',    prior_ai_score: 78, candidate_anchor: 'Marie Konaté — 5 ans React/Node + leadership' },
          { decision: 'rejected', prior_ai_score: 82, candidate_anchor: 'Paul Diallo — solide tech mais aucune exp. équipe' },
          { decision: 'hired',    prior_ai_score: 71, candidate_anchor: 'Aïcha Bamba — bootcamp + 2 projets perso impressionnants' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE applications
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    vi.mocked(analyzeCV).mockResolvedValueOnce({
      score: 85, recommendation: 'yes', summary: '', strengths: [], gaps: [], redFlags: [],
      interviewQuestions: ['Q1', 'Q2', 'Q3'], matchPercentage: 85, modelUsed: 'claude',
    })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.learningExamples).toBe(3)
    // analyzeCV doit avoir reçu les 3 exemples
    const callArgs = vi.mocked(analyzeCV).mock.calls[0]
    expect(callArgs?.[3]).toHaveLength(3)
    const firstExample = callArgs?.[3]?.[0]
    expect(firstExample?.decision).toBe('hired')
    expect(firstExample?.anchor).toContain('Marie Konaté')
  })

  it('feedback loop : hired/rejected déclenche INSERT dans recruitment_decisions + audit_log', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          id: 'app-99', job_id: 'job-1', first_name: 'Test', last_name: 'User',
          stage: 'hired', ai_score: 75, ai_recommendation: 'yes',
          ai_summary: 'Bon profil senior\nAvec un retour à la ligne pour tester la sanitization',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // INSERT recruitment_decisions
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log (OWASP A09)

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/applications/app-99/stage',
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: 'hired' },
    })

    expect(res.statusCode).toBe(200)
    // 2e call : INSERT dans recruitment_decisions
    const insertDecision = queryMock.mock.calls[1]
    expect(insertDecision?.[0]).toContain('INSERT INTO')
    expect(insertDecision?.[0]).toContain('recruitment_decisions')
    expect(insertDecision?.[1]?.[2]).toBe('hired')
    expect(insertDecision?.[1]?.[4]).toBe(75)
    // Sanitization OWASP A03 : pas de \n dans le candidate_anchor stocké
    expect(insertDecision?.[1]?.[6]).not.toContain('\n')
    // 3e call : INSERT dans audit_log (OWASP A09)
    const insertAudit = queryMock.mock.calls[2]
    expect(insertAudit?.[0]).toContain('audit_log')
    expect(insertAudit?.[1]?.[1]).toBe('recruitment.hired')
  })

  it('decisions-history : refuse un jobId qui n\'est pas un UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/not-a-uuid/decisions-history',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('decisions-history : renvoie la liste triée par decided_at DESC avec counts', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'd-1', decision: 'hired',    decided_at: new Date('2026-05-15'), decided_by: 'u-1', prior_ai_score: 82, prior_ai_recommendation: 'yes',   candidate_anchor: 'Marie K — 5 ans RH' },
        { id: 'd-2', decision: 'rejected', decided_at: new Date('2026-05-10'), decided_by: 'u-1', prior_ai_score: 71, prior_ai_recommendation: 'maybe', candidate_anchor: 'Paul D — manque exp.' },
        { id: 'd-3', decision: 'hired',    decided_at: new Date('2026-05-05'), decided_by: 'u-2', prior_ai_score: 76, prior_ai_recommendation: 'yes',   candidate_anchor: 'Aïcha B — bootcamp solide' },
      ],
    })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/11111111-1111-1111-1111-111111111111/decisions-history',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(3)
    expect(body.counts.hired).toBe(2)
    expect(body.counts.rejected).toBe(1)
    expect(body.data[0].id).toBe('d-1')
  })

  it('decisions-history : LIMIT borné à 100 et 1 minimum', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/11111111-1111-1111-1111-111111111111/decisions-history?limit=99999',
      headers: { authorization: `Bearer ${token}` },
    })
    // Le 1er call doit avoir limit clampé à 100 (2e param de la requête SQL)
    expect(queryMock.mock.calls[0]?.[1]?.[1]).toBe(100)
  })

  it('decisions-history : renvoie [] proprement si la table n\'existe pas (tenant pré-migration)', async () => {
    queryMock.mockRejectedValueOnce(new Error('relation "tenant_sotra.recruitment_decisions" does not exist'))

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/22222222-2222-2222-2222-222222222222/decisions-history',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toEqual([])
    expect(body.total).toBe(0)
  })

  it('cv-file : refuse un id qui n\'est pas un UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/applications/not-a-uuid/cv-file',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('cv-file : 404 si aucun blob stocké', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ cv_blob: null, cv_mime_type: null, cv_filename: null }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/applications/11111111-1111-1111-1111-111111111111/cv-file',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('cv-file : streame le binaire avec Content-Type et X-Content-Type-Options nosniff', async () => {
    const blob = Buffer.from('%PDF-1.4 fake pdf payload', 'utf-8')
    queryMock.mockResolvedValueOnce({ rows: [{
      cv_blob: blob, cv_mime_type: 'application/pdf', cv_filename: 'cv-marie.pdf',
    }] })
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/applications/11111111-1111-1111-1111-111111111111/cv-file',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-disposition']).toContain('inline')
  })

  it('cv-file : un employee ne peut PAS télécharger un CV (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/applications/11111111-1111-1111-1111-111111111111/cv-file',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('decisions-history : un employee ne peut pas y accéder (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/11111111-1111-1111-1111-111111111111/decisions-history',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('fallback : utilise job.ai_focus_text si criteria.focus n\'est pas fourni', async () => {
    const longCv = 'Profil confirmé avec dossier solide.'.repeat(5)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Job', description: '', requirements: 'CNPS', ai_focus_text: 'Critère sauvegardé pour cette offre' }] })
      // PAS d'UPDATE recruitment_jobs car criteriaFocus=null (rien à persister)
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', cv_text: longCv, cover_letter: null, first_name: 'A', last_name: 'B' }] })
      .mockResolvedValueOnce({ rows: [] }) // recruitment_decisions (feedback loop)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE applications
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    vi.mocked(analyzeCV).mockResolvedValueOnce({
      score: 80, recommendation: 'yes', summary: '', strengths: [], gaps: [], redFlags: [],
      interviewQuestions: ['Q1', 'Q2', 'Q3'], matchPercentage: 80, modelUsed: 'claude',
    })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: {}, // pas de criteria
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.effectiveFocus).toBe('Critère sauvegardé pour cette offre')
    // analyzeCV doit avoir reçu un job dont requirements contient le focus sauvegardé
    const callArgs = vi.mocked(analyzeCV).mock.calls[0]
    expect(callArgs?.[1].requirements).toContain('Critère sauvegardé pour cette offre')
  })
})
