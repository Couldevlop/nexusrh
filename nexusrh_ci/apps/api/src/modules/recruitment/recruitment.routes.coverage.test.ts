/**
 * Couverture exhaustive de recruitment.routes.ts.
 *
 * Complète recruitment.routes.test.ts et recruitment-public-cv.routes.test.ts en
 * ciblant les endpoints et branches encore non couverts :
 *   - extractCvText interne (chemin PDF via unpdf)
 *   - GET /jobs (liste + filtres + erreur 500)
 *   - PATCH /jobs/:id (champs scalaires, énums APEC, visibility, arrays, aucun champ, 500)
 *   - GET/PUT /jobs/:id/screening-criteria (lecture, 404, écriture, 500)
 *   - DELETE /jobs/:id (succès, 500, RBAC)
 *   - GET /applications (liste, filtres, 500)
 *   - POST /applications (création, 500)
 *   - PATCH /applications/:id/stage (stage invalide, MAJ simple, 500)
 *   - POST /applications/:id/upload-cv (succès, MIME interdit, trop gros, no file, 404, 500)
 *   - GET /applications/:id/cv-file (stream, 500)
 *   - POST /applications/:id/analyze-cv (offre liée 404, branche IA actionnable, 500)
 *   - POST /jobs/:id/preselect (failed candidate, 500)
 *   - GET /public/:slug/jobs (+ détail) (404 tenant, succès, 404 offre)
 *   - POST /jobs/:id/source (catch user-actionable + générique)
 *   - GET /jobs/:id/sourced-profiles (500)
 *   - transfer / transfer-all (succès, déjà transféré, 404, 500)
 *   - source/compare (succès, 404 offre, catch)
 *
 * Mocks reproduits à l'identique des tests existants.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, connectMock, clientQueryMock, releaseMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn()
  const releaseMock = vi.fn()
  return {
    queryMock: vi.fn(),
    clientQueryMock,
    releaseMock,
    connectMock: vi.fn(async () => ({ query: clientQueryMock, release: releaseMock })),
  }
})

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, connect: connectMock, end: vi.fn() })),
}))

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

vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/recruitment-ai.service.js', () => ({
  analyzeCV: vi.fn(),
  sourceProfiles: vi.fn(),
  sourceProfilesCompare: vi.fn(),
  isModelAvailable: vi.fn((m: string) => m === 'claude'),
}))

vi.mock('../../services/ai-credentials.service.js', () => ({
  resolveAiCreds: vi.fn().mockResolvedValue({
    claude: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4' },
    mistral: { apiKey: null, model: 'mistral-large' },
    preferredProvider: 'claude',
  }),
}))

vi.mock('../../services/sourcing-countries.service.js', () => ({
  resolveSourcingCountries: vi.fn(async (_p: unknown, _s: unknown, requested?: string[]) => ({
    countries: requested && requested.length ? requested : ['CI'],
    multiCountry: true, tenantCountry: 'CI',
  })),
}))

// unpdf mocké pour couvrir le chemin PDF de extractCvText interne aux routes.
const { getDocumentProxyMock, extractTextMock } = vi.hoisted(() => ({
  getDocumentProxyMock: vi.fn(),
  extractTextMock: vi.fn(),
}))
vi.mock('unpdf', () => ({
  getDocumentProxy: getDocumentProxyMock,
  extractText: extractTextMock,
}))

import authPlugin from '../../plugins/auth.js'
import recruitmentRoutes from './recruitment.routes.js'
import {
  analyzeCV, sourceProfiles, sourceProfilesCompare, isModelAvailable,
} from '../../services/recruitment-ai.service.js'

const SCHEMA = 'tenant_sotra'
const UUID = '11111111-1111-1111-1111-111111111111'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{
  sub: string; email: string
}> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? 'u-' + role,
    tenantId: 't1',
    schemaName: SCHEMA,
    role,
    email: opts.email ?? `${role}@sotra-ci.com`,
    firstName: 'Test',
    lastName: 'User',
    employeeId: null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 12 * 1024 * 1024 } })
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  clientQueryMock.mockReset()
  releaseMock.mockReset()
  connectMock.mockClear()
  getDocumentProxyMock.mockReset()
  extractTextMock.mockReset()
  vi.mocked(analyzeCV).mockReset()
  vi.mocked(sourceProfiles).mockReset()
  vi.mocked(sourceProfilesCompare).mockReset()
  vi.mocked(isModelAvailable).mockImplementation((m: string) => m === 'claude')
})

function multipartBody(boundary: string, fields: Record<string, string>, file?: { name: string; filename: string; type: string; content: string | Buffer }) {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf-8'))
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`, 'utf-8'))
    parts.push(typeof file.content === 'string' ? Buffer.from(file.content, 'utf-8') : file.content)
    parts.push(Buffer.from('\r\n', 'utf-8'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
  return Buffer.concat(parts)
}

// ── GET /jobs ────────────────────────────────────────────────────────────────
describe('GET /recruitment/jobs', () => {
  it('liste les offres avec filtres status + visibility', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'job-1', title: 'X' }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs?status=open&visibility=external&limit=10&offset=5',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toContain('rj.status = $1')
    expect(sql).toContain('rj.visibility = $2')
    const params = queryMock.mock.calls[0]![1] as unknown[]
    expect(params).toContain('open')
    expect(params).toContain('external')
    expect(params).toContain(10)
    expect(params).toContain(5)
  })

  it('liste sans filtre (valeurs par défaut limit/offset)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'readonly')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /jobs — branches restantes ────────────────────────────────────────────
describe('POST /recruitment/jobs — branches restantes', () => {
  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert fail'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Test', status: 'draft' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /jobs/:id ──────────────────────────────────────────────────────────────
describe('GET /recruitment/jobs/:id', () => {
  it('retourne 404 si offre introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/job-x',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/job-x',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── PATCH /jobs/:id ────────────────────────────────────────────────────────────
describe('PATCH /recruitment/jobs/:id', () => {
  it('met à jour des champs scalaires + visibility + arrays', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'job-1', title: 'New' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/jobs/job-1',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'New', salary_min: 100000, visibility: 'both',
        target_departments: ['d1'], target_job_levels: ['cadre'],
        sector: 'finance',
      },
    })
    expect(res.statusCode).toBe(200)
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toContain('UPDATE')
    expect(sql).toContain('visibility =')
    expect(sql).toContain('target_departments =')
    expect(sql).toContain('target_job_levels =')
  })

  it('défaut [] si target_departments/target_job_levels présents mais null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'job-1' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/jobs/job-1',
      headers: { authorization: `Bearer ${token}` },
      payload: { target_departments: null, target_job_levels: null },
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejette une énumération APEC invalide (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/jobs/job-1',
      headers: { authorization: `Bearer ${token}` },
      payload: { job_level: 'pas_un_niveau' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('retourne 400 si aucun champ', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/jobs/job-1',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/jobs/job-1',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'X' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── screening-criteria ─────────────────────────────────────────────────────────
describe('GET/PUT /recruitment/jobs/:id/screening-criteria', () => {
  it('GET retourne les critères normalisés', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ screening_criteria: { min_experience_years: 3 } }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/job-1/screening-criteria',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.criteria).toBeTruthy()
  })

  it('GET retourne 404 si offre introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/job-x/screening-criteria',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/job-x/screening-criteria',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })

  it('PUT enregistre les critères nettoyés', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'job-1' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PUT',
      url: '/recruitment/jobs/job-1/screening-criteria',
      headers: { authorization: `Bearer ${token}` },
      payload: { criteria: { min_experience_years: 5, required_keywords: ['React'] } },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.criteria).toBeTruthy()
  })

  it('PUT avec body vide normalise vers critères par défaut', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'job-1' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PUT',
      url: '/recruitment/jobs/job-1/screening-criteria',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('PUT retourne 404 si offre introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PUT',
      url: '/recruitment/jobs/job-x/screening-criteria',
      headers: { authorization: `Bearer ${token}` },
      payload: { criteria: {} },
    })
    expect(res.statusCode).toBe(404)
  })

  it('PUT retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PUT',
      url: '/recruitment/jobs/job-x/screening-criteria',
      headers: { authorization: `Bearer ${token}` },
      payload: { criteria: {} },
    })
    expect(res.statusCode).toBe(500)
  })

  it('PUT refuse un readonly (403)', async () => {
    const token = tokenFor(app, 'readonly')
    const res = await app.inject({
      method: 'PUT',
      url: '/recruitment/jobs/job-1/screening-criteria',
      headers: { authorization: `Bearer ${token}` },
      payload: { criteria: {} },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── DELETE /jobs/:id ───────────────────────────────────────────────────────────
describe('DELETE /recruitment/jobs/:id', () => {
  it('supprime une offre (success)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'DELETE',
      url: '/recruitment/jobs/job-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).success).toBe(true)
  })

  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'DELETE',
      url: '/recruitment/jobs/job-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })

  it('refuse un hr_officer (403)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'DELETE',
      url: '/recruitment/jobs/job-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── internal-jobs — branches restantes ─────────────────────────────────────────
describe('GET /recruitment/internal-jobs — branches restantes', () => {
  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/internal-jobs',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })

  it('employé sans hire_date (ancienneté 0) renvoie quand même la liste', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1', department_id: null, job_level: null, hire_date: null, legal_entity_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'job-1' }] })
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/internal-jobs',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(queryMock.mock.calls[1]![1]![3]).toBe(0)
  })
})

describe('POST /recruitment/internal-jobs/:id/apply — branches restantes', () => {
  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/internal-jobs/job-1/apply',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /applications ──────────────────────────────────────────────────────────
describe('GET /recruitment/applications', () => {
  it('liste avec filtres job_id + stage', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'a1', cv_blob: Buffer.from('x') }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/applications?job_id=job-1&stage=new',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const apps = JSON.parse(res.body).data
    expect(apps[0]).not.toHaveProperty('cv_blob')
    expect(apps[0].has_cv).toBe(true)
  })

  it('liste sans filtre', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'readonly')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/applications',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/applications',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /applications ─────────────────────────────────────────────────────────
describe('POST /recruitment/applications', () => {
  it('crée une candidature manuelle', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'app-new', source: 'manual' }] })
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications',
      headers: { authorization: `Bearer ${token}` },
      payload: { job_id: 'job-1', first_name: 'A', last_name: 'B', email: 'a@b.com' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications',
      headers: { authorization: `Bearer ${token}` },
      payload: { job_id: 'job-1', first_name: 'A', last_name: 'B', email: 'a@b.com' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── PATCH /applications/:id/stage ───────────────────────────────────────────────
describe('PATCH /recruitment/applications/:id/stage', () => {
  it('refuse un stage invalide (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/applications/app-1/stage',
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: 'NOPE' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('met à jour un stage non final (screening) sans feedback loop', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'app-1', stage: 'screening' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/applications/app-1/stage',
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: 'screening', notes: 'Bon profil' },
    })
    expect(res.statusCode).toBe(200)
    // pas d'INSERT recruitment_decisions
    expect(queryMock.mock.calls).toHaveLength(1)
  })

  it('met à jour en "rejected" et déclenche les inserts feedback', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', first_name: 'A', last_name: 'B', stage: 'rejected', ai_score: 40, ai_recommendation: 'no', ai_summary: 'faible' }] })
      .mockResolvedValueOnce({ rows: [] }) // recruitment_decisions
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/applications/app-1/stage',
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: 'rejected' },
    })
    expect(res.statusCode).toBe(200)
    expect(queryMock.mock.calls[2]![1]![1]).toBe('recruitment.rejected')
  })

  it('retourne 500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/recruitment/applications/app-1/stage',
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: 'interview' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── upload-cv ──────────────────────────────────────────────────────────────────
describe('POST /recruitment/applications/:id/upload-cv', () => {
  it('refuse si aucun fichier reçu (400)', async () => {
    const boundary = '----up0'
    const payload = multipartBody(boundary, { foo: 'bar' })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/upload-cv',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un MIME interdit (400)', async () => {
    const boundary = '----up1'
    const payload = multipartBody(boundary, {}, { name: 'file', filename: 'x.exe', type: 'application/x-msdownload', content: 'MZ' })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/upload-cv',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('upload TXT : extrait le texte et persiste (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'app-1', cv_url: 'local://cv.txt', cv_filename: 'cv.txt' }] })
    const boundary = '----up2'
    const payload = multipartBody(boundary, {}, { name: 'file', filename: 'cv.txt', type: 'text/plain', content: 'Développeur React 5 ans' })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/upload-cv',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(200)
    const args = queryMock.mock.calls[0]![1] as unknown[]
    expect(String(args[1])).toContain('Développeur')
  })

  it('upload PDF : extrait le texte via unpdf', async () => {
    getDocumentProxyMock.mockResolvedValueOnce({})
    extractTextMock.mockResolvedValueOnce({ text: 'CV PDF extrait Konaté' })
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'app-1' }] })
    const boundary = '----up3'
    const payload = multipartBody(boundary, {}, { name: 'file', filename: 'cv.pdf', type: 'application/pdf', content: '%PDF-1.4 fake' })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/upload-cv',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(200)
    const args = queryMock.mock.calls[0]![1] as unknown[]
    expect(String(args[1])).toContain('Konaté')
  })

  it('upload trop volumineux (> 10 Mo) : 400', async () => {
    const boundary = '----up4'
    const big = Buffer.alloc(10 * 1024 * 1024 + 100, 0x41)
    const payload = multipartBody(boundary, {}, { name: 'file', filename: 'big.txt', type: 'text/plain', content: big })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/upload-cv',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si candidature introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const boundary = '----up5'
    const payload = multipartBody(boundary, {}, { name: 'file', filename: 'cv.txt', type: 'text/plain', content: 'texte' })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-x/upload-cv',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(404)
  })

  it('500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const boundary = '----up6'
    const payload = multipartBody(boundary, {}, { name: 'file', filename: 'cv.txt', type: 'text/plain', content: 'texte' })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/upload-cv',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── cv-file — branches restantes ────────────────────────────────────────────────
describe('GET /recruitment/applications/:id/cv-file — branches restantes', () => {
  it('500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: `/recruitment/applications/${UUID}/cv-file`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })

  it('utilise un filename par défaut si null et nettoie les caractères', async () => {
    const blob = Buffer.from('data')
    queryMock.mockResolvedValueOnce({ rows: [{ cv_blob: blob, cv_mime_type: null, cv_filename: null }] })
    const token = tokenFor(app, 'manager')
    const res = await app.inject({
      method: 'GET',
      url: `/recruitment/applications/${UUID}/cv-file`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
  })
})

// ── analyze-cv — branches restantes ─────────────────────────────────────────────
describe('POST /recruitment/applications/:id/analyze-cv — branches restantes', () => {
  it('404 si candidature introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-x/analyze-cv',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('404 si offre liée introuvable', async () => {
    const longCv = 'Profil RH expérimenté CNPS ITS Abidjan licence GRH Excel.'.repeat(3)
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', cv_text: longCv, cover_letter: null }] })
      .mockResolvedValueOnce({ rows: [] }) // offre introuvable
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/analyze-cv',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'mistral' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('500 message générique si erreur IA non actionnable', async () => {
    const longCv = 'Profil RH expérimenté CNPS ITS Abidjan licence GRH Excel.'.repeat(3)
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', cv_text: longCv, cover_letter: null }] })
      .mockResolvedValueOnce({ rows: [{ title: 'RH' }] })
    vi.mocked(analyzeCV).mockRejectedValueOnce(new Error('network timeout'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/analyze-cv',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toMatch(/Réessayez/)
  })

  it('500 message actionnable si erreur IA explicite (clé non configurée)', async () => {
    const longCv = 'Profil RH expérimenté CNPS ITS Abidjan licence GRH Excel.'.repeat(3)
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', cv_text: longCv, cover_letter: null }] })
      .mockResolvedValueOnce({ rows: [{ title: 'RH' }] })
    vi.mocked(analyzeCV).mockRejectedValueOnce(new Error('Clé Mistral non configurée'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/analyze-cv',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toMatch(/configurée/)
  })

  it('utilise le PDF stocké comme fallback vision pour analyzeCV', async () => {
    const longCv = 'Profil RH expérimenté CNPS ITS Abidjan licence GRH Excel.'.repeat(3)
    const pdfBlob = Buffer.from('%PDF-1.4 fake')
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', cv_text: longCv, cover_letter: null, cv_blob: pdfBlob, cv_mime_type: 'application/pdf' }] })
      .mockResolvedValueOnce({ rows: [{ title: 'RH' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-1' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    vi.mocked(analyzeCV).mockResolvedValueOnce({
      score: 80, recommendation: 'yes', summary: '', strengths: [], gaps: [], redFlags: [],
      interviewQuestions: ['Q1', 'Q2', 'Q3'], matchPercentage: 80, modelUsed: 'claude',
      signalsUsed: ['CNPS'], demographicRiskNote: 'aucun',
    })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/applications/app-1/analyze-cv',
      headers: { authorization: `Bearer ${token}` },
      payload: { cv_text: longCv },
    })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(analyzeCV).mock.calls[0]!
    expect(Buffer.isBuffer(call[4])).toBe(true)
  })
})

// ── preselect — failed candidate + 500 ──────────────────────────────────────────
describe('POST /recruitment/jobs/:id/preselect — branches restantes', () => {
  it('compte un échec quand analyzeCV jette pour un candidat', async () => {
    const longCv = 'Candidat solide expérience confirmée Abidjan.'.repeat(5)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Job', description: '', requirements: '', ai_focus_text: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', cv_text: longCv, cover_letter: null, first_name: 'A', last_name: 'B', cv_mime_type: 'application/pdf', cv_blob: Buffer.from('%PDF') }] })
      .mockResolvedValueOnce({ rows: [] }) // recruitment_decisions
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    vi.mocked(analyzeCV).mockRejectedValueOnce(new Error('IA error'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.failed).toBe(1)
    expect(body.analyzed).toBe(0)
  })

  it('utilise cover_letter quand cv_text absent', async () => {
    const longLetter = 'Lettre de motivation très détaillée et qualifiée pour le poste.'.repeat(3)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Job', description: '', requirements: '', ai_focus_text: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', cv_text: null, cover_letter: longLetter, first_name: 'A', last_name: 'B', cv_mime_type: null, cv_blob: null }] })
      .mockResolvedValueOnce({ rows: [] }) // recruitment_decisions
      .mockResolvedValueOnce({ rows: [] }) // UPDATE applications
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    vi.mocked(analyzeCV).mockResolvedValueOnce({
      score: 60, recommendation: 'maybe', summary: '', strengths: [], gaps: [], redFlags: [],
      interviewQuestions: ['Q1', 'Q2', 'Q3'], matchPercentage: 60, modelUsed: 'claude',
    })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'mistral', stages: ['new'], force: true, maxCandidates: 5 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).analyzed).toBe(1)
  })

  it('500 si la requête principale échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/preselect',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── public jobs (liste + détail) ────────────────────────────────────────────────
describe('GET /recruitment/public/:slug/jobs', () => {
  it('404 si tenant introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/recruitment/public/inconnu/jobs' })
    expect(res.statusCode).toBe(404)
  })

  it('retourne le branding + offres (avec fallback couleurs)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: SCHEMA, name: 'SOTRA', slug: 'sotra', primary_color: null, secondary_color: null, logo_url: null, city: 'Abidjan', sector: 'transport' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', title: 'Dév' }], rowCount: 1 })
    const res = await app.inject({ method: 'GET', url: '/recruitment/public/sotra/jobs' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.tenant.primaryColor).toBe('#E85D04')
    expect(body.count).toBe(1)
  })
})

describe('GET /recruitment/public/:slug/jobs/:jobId', () => {
  it('404 si tenant introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/recruitment/public/inconnu/jobs/job-1' })
    expect(res.statusCode).toBe(404)
  })

  it('404 si offre introuvable ou fermée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: SCHEMA, name: 'SOTRA', slug: 'sotra', primary_color: '#111', secondary_color: '#222', logo_url: 'x', city: 'Abidjan' }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/recruitment/public/sotra/jobs/job-x' })
    expect(res.statusCode).toBe(404)
  })

  it('retourne le détail de l\'offre avec branding', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: SCHEMA, name: 'SOTRA', slug: 'sotra', primary_color: null, secondary_color: null, logo_url: null, city: 'Abidjan' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', title: 'Dév' }] })
    const res = await app.inject({ method: 'GET', url: '/recruitment/public/sotra/jobs/job-1' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.id).toBe('job-1')
  })
})

// ── source — catch branches ─────────────────────────────────────────────────────
describe('POST /recruitment/jobs/:id/source — catch', () => {
  it('500 message générique si erreur sourcing non actionnable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ title: 'Lead' }] })
    vi.mocked(sourceProfiles).mockRejectedValueOnce(new Error('network down'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toMatch(/Réessayez/)
  })

  it('500 message actionnable si erreur sourcing explicite', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ title: 'Lead' }] })
    vi.mocked(sourceProfiles).mockRejectedValueOnce(new Error('clé non configurée'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toMatch(/configurée/)
  })
})

// ── sourced-profiles list — 500 ─────────────────────────────────────────────────
describe('GET /recruitment/jobs/:id/sourced-profiles — 500', () => {
  it('500 sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/recruitment/jobs/job-1/sourced-profiles',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── transfer ────────────────────────────────────────────────────────────────────
describe('POST /recruitment/jobs/:id/sourced-profiles/:profileId/transfer', () => {
  it('404 si profil introuvable (ROLLBACK)', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE → vide
      .mockResolvedValueOnce({}) // ROLLBACK
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/sp-1/transfer',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
    expect(releaseMock).toHaveBeenCalled()
  })

  it('409 si profil déjà transféré', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'sp-1', transferred_to_application_id: 'app-7' }] })
      .mockResolvedValueOnce({}) // ROLLBACK
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/sp-1/transfer',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).applicationId).toBe('app-7')
  })

  it('201 transfert réussi (avec email synthétique)', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'sp-1', job_id: 'job-1', first_name: 'Jean', last_name: 'Brou', email: null, phone: '+225', match_score: 88, current_position: 'Dev', current_company: 'ACME', key_skills: ['React'], transferred_to_application_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-new' }] }) // INSERT applications
      .mockResolvedValueOnce({}) // UPDATE sourced_profiles
      .mockResolvedValueOnce({}) // COMMIT
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log (pool)
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/sp-1/transfer',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.applicationId).toBe('app-new')
  })

  it('500 sur erreur (ROLLBACK)', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('boom')) // SELECT fail
      .mockResolvedValueOnce({}) // ROLLBACK
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/sp-1/transfer',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── transfer-all ─────────────────────────────────────────────────────────────────
describe('POST /recruitment/jobs/:id/sourced-profiles/transfer-all', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/transfer-all',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('transfère tous les profils en attente', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [
        { id: 'sp-1', first_name: 'A', last_name: 'B', email: 'a@b.com', phone: null, match_score: 90, current_position: 'Dev', current_company: null, key_skills: ['TS'] },
        { id: 'sp-2', first_name: 'C', last_name: 'D', email: null, phone: null, match_score: null, current_position: null, current_company: 'X', key_skills: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-1' }] }) // INSERT 1
      .mockResolvedValueOnce({}) // UPDATE 1
      .mockResolvedValueOnce({ rows: [{ id: 'app-2' }] }) // INSERT 2
      .mockResolvedValueOnce({}) // UPDATE 2
      .mockResolvedValueOnce({}) // COMMIT
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/transfer-all',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.transferred).toBe(2)
  })

  it('500 sur erreur (ROLLBACK)', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({}) // ROLLBACK
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/transfer-all',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── source/compare — succès + 404 + catch ────────────────────────────────────────
describe('POST /recruitment/jobs/:id/source/compare — branches restantes', () => {
  it('404 si offre introuvable (mistral dispo)', async () => {
    vi.mocked(isModelAvailable).mockImplementation(() => true)
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-x/source/compare',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('500 générique si sourceProfilesCompare jette', async () => {
    vi.mocked(isModelAvailable).mockImplementation(() => true)
    queryMock.mockResolvedValueOnce({ rows: [{ title: 'Lead' }] })
    vi.mocked(sourceProfilesCompare).mockRejectedValueOnce(new Error('network'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source/compare',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toMatch(/Réessayez/)
  })

  it('500 actionnable si erreur explicite', async () => {
    vi.mocked(isModelAvailable).mockImplementation(() => true)
    queryMock.mockResolvedValueOnce({ rows: [{ title: 'Lead' }] })
    vi.mocked(sourceProfilesCompare).mockRejectedValueOnce(new Error('clé non configurée'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source/compare',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toMatch(/configurée/)
  })

  it('utilise des plateformes par défaut quand body.platforms vide (ligne 1664)', async () => {
    vi.mocked(isModelAvailable).mockImplementation(() => true)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Lead' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    vi.mocked(sourceProfilesCompare).mockResolvedValueOnce({
      winner: 'mistral',
      claude: { provider: 'claude', model: 'c', data: null, jsonValid: true, richnessScore: 50, profilesGenerated: 2, latencyMs: 100, inputTokens: 1, outputTokens: 1, estimatedCostEur: 0.01, error: null },
      mistral: { provider: 'mistral', model: 'm', data: null, jsonValid: true, richnessScore: 70, profilesGenerated: 2, latencyMs: 90, inputTokens: 1, outputTokens: 1, estimatedCostEur: 0.005, error: null },
      ratios: { latency: 'l', cost: 'c', richness: 'r' },
      recommendation: 'Mistral recommandé',
    })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source/compare',
      headers: { authorization: `Bearer ${token}` },
      payload: { max_profiles: 4 }, // pas de platforms → défaut
    })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(sourceProfilesCompare).mock.calls[0]!
    expect(call[1]).toContain('LinkedIn') // platforms par défaut
  })
})

// ── scoreToRecommendation via transfer (branches 135-138) ────────────────────────
describe('scoreToRecommendation — toutes les bornes via transfer', () => {
  async function transferWithScore(score: number | null) {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'sp-1', job_id: 'job-1', first_name: 'J', last_name: 'B', email: 'j@b.com', phone: null, match_score: score, current_position: null, current_company: null, key_skills: [], transferred_to_application_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-new' }] }) // INSERT
      .mockResolvedValueOnce({}) // UPDATE
      .mockResolvedValueOnce({}) // COMMIT
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'hr_manager')
    return app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/sourced-profiles/sp-1/transfer',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
  }

  function insertRecommendation(): unknown {
    const insertCall = clientQueryMock.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('applications'),
    )!
    return (insertCall[1] as unknown[])[6]
  }

  it('score "yes" (>=70)', async () => {
    const res = await transferWithScore(75)
    expect(res.statusCode).toBe(201)
    expect(insertRecommendation()).toBe('yes')
  })

  it('score "maybe" (>=55)', async () => {
    const res = await transferWithScore(60)
    expect(res.statusCode).toBe(201)
    expect(insertRecommendation()).toBe('maybe')
  })

  it('score "no" (<55)', async () => {
    const res = await transferWithScore(30)
    expect(res.statusCode).toBe(201)
    expect(insertRecommendation()).toBe('no')
  })

  it('score null → recommendation null', async () => {
    const res = await transferWithScore(null)
    expect(res.statusCode).toBe(201)
    expect(insertRecommendation()).toBeNull()
  })
})

// ── decisions-history — catch non lié à table absente (1113-1117) ─────────────────
describe('GET /recruitment/jobs/:id/decisions-history — 500 erreur générique', () => {
  it('500 si l\'erreur n\'est pas "table absente"', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection reset by peer'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: `/recruitment/jobs/${UUID}/decisions-history`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── public apply — branches multipart + validation + doublon + CV (1237-1320) ─────
describe('POST /recruitment/public/:slug/jobs/:jobId/apply — branches restantes', () => {
  const SLUG = 'sotra'
  const JOB = 'job-1'

  function mockApplyHappyPath(opts: { dup?: boolean } = {}) {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ schema_name: SCHEMA, name: 'SOTRA' }] })
      if (s.includes('recruitment_jobs') && s.includes('visibility')) return Promise.resolve({ rows: [{ id: JOB, title: 'Développeur' }] })
      if (s.includes('lower(email)')) return Promise.resolve({ rows: opts.dup ? [{ id: 'existing-app' }] : [] })
      if (s.includes('INSERT INTO') && s.includes('applications')) return Promise.resolve({ rows: [{ id: 'app-new' }] })
      if (s.includes('audit_log')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
  }

  it('400 si la validation Zod échoue (email invalide)', async () => {
    mockApplyHappyPath()
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      payload: { first_name: 'A', last_name: 'B', email: 'pas-un-email' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).issues).toBeTruthy()
  })

  it('409 si le même email a déjà postulé', async () => {
    mockApplyHappyPath({ dup: true })
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      payload: { first_name: 'Awa', last_name: 'Kone', email: 'awa@example.com' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).applicationId).toBe('existing-app')
  })

  it('multipart : ignore les champs fichier non "cv" et stocke le CV PDF extrait', async () => {
    mockApplyHappyPath()
    getDocumentProxyMock.mockResolvedValueOnce({})
    extractTextMock.mockResolvedValueOnce({ text: 'CV PDF Konaté Abidjan' })
    const boundary = '----pub1'
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="first_name"\r\n\r\nJean\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="last_name"\r\n\r\nBrou\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\njean@example.com\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="autre"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nignored\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="cv.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 fake\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    })
    expect(res.statusCode).toBe(201)
  })

  it('multipart : CV trop volumineux (> 5 Mo) → 400', async () => {
    mockApplyHappyPath()
    const boundary = '----pub2'
    const big = Buffer.alloc(5 * 1024 * 1024 + 100, 0x41)
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`, 'utf-8'))
    parts.push(big)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'))
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    })
    expect(res.statusCode).toBe(400)
  })

  it('multipart : MIME interdit → 400', async () => {
    mockApplyHappyPath()
    const boundary = '----pub3'
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="evil.exe"\r\nContent-Type: application/x-msdownload\r\n\r\nMZ\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    })
    expect(res.statusCode).toBe(400)
  })

  it('extractCvText non bloquant : PDF illisible mais 201 (fallback UTF-8 interne)', async () => {
    mockApplyHappyPath()
    getDocumentProxyMock.mockRejectedValueOnce(new Error('PDF corrompu'))
    const boundary = '----pub4'
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="first_name"\r\n\r\nMimi\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="last_name"\r\n\r\nKone\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\nmimi@example.com\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="cv.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-broken\r\n`, 'utf-8'))
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    })
    expect(res.statusCode).toBe(201)
  })

  it('404 si tenant introuvable (JSON)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM platform.tenants')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/inconnu/jobs/${JOB}/apply`,
      payload: { first_name: 'A', last_name: 'B', email: 'a@b.com' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('404 si offre fermée/introuvable (JSON)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ schema_name: SCHEMA, name: 'SOTRA' }] })
      if (s.includes('recruitment_jobs') && s.includes('visibility')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      payload: { first_name: 'A', last_name: 'B', email: 'a@b.com' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('multipart : flux dépassant la limite globale → catch parts() (400, lignes 1248-1250)', async () => {
    mockApplyHappyPath()
    // Dépasse la limite globale @fastify/multipart (12 Mo enregistrés) : le flux
    // multipart jette pendant l'itération request.parts() → catch → 400.
    const boundary = '----puboverflow'
    const huge = Buffer.alloc(13 * 1024 * 1024, 0x41)
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="huge.txt"\r\nContent-Type: text/plain\r\n\r\n`, 'utf-8'))
    parts.push(huge)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'))
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── source/compare — platforms fournis (branche 1664) ────────────────────────────
describe('POST /recruitment/jobs/:id/source/compare — platforms explicites', () => {
  it('transmet les platforms du body quand fournis (ligne 1664)', async () => {
    vi.mocked(isModelAvailable).mockImplementation(() => true)
    queryMock
      .mockResolvedValueOnce({ rows: [{ title: 'Lead' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    vi.mocked(sourceProfilesCompare).mockResolvedValueOnce({
      winner: 'claude',
      claude: { provider: 'claude', model: 'c', data: null, jsonValid: true, richnessScore: 70, profilesGenerated: 2, latencyMs: 100, inputTokens: 1, outputTokens: 1, estimatedCostEur: 0.01, error: null },
      mistral: { provider: 'mistral', model: 'm', data: null, jsonValid: true, richnessScore: 50, profilesGenerated: 2, latencyMs: 90, inputTokens: 1, outputTokens: 1, estimatedCostEur: 0.005, error: null },
      ratios: { latency: 'l', cost: 'c', richness: 'r' },
      recommendation: 'Claude recommandé',
    })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/recruitment/jobs/job-1/source/compare',
      headers: { authorization: `Bearer ${token}` },
      payload: { platforms: ['Africawork'], max_profiles: 3 },
    })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(sourceProfilesCompare).mock.calls[0]!
    expect(call[1]).toEqual(['Africawork'])
  })
})
