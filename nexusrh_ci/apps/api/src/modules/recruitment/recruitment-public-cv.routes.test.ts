/**
 * Réception et lecture des CV déposés depuis l'extérieur (page carrières publique)
 * + exposition côté RH (liste sans binaire, drapeau has_cv).
 *
 * Couvre :
 *  - POST /public/:slug/jobs/:jobId/apply en JSON (compat) → pas de CV stocké
 *  - idem en multipart AVEC fichier CV → cv_blob + cv_text extrait + métadonnées
 *  - rejet d'un MIME non autorisé (OWASP A03 content-type spoofing)
 *  - GET /jobs/:id : la liste ne renvoie JAMAIS cv_blob, expose has_cv
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
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
  resolveSourcingCountries: vi.fn(async () => ({ countries: ['CI'], multiCountry: true, tenantCountry: 'CI' })),
}))

import authPlugin from '../../plugins/auth.js'
import recruitmentRoutes from './recruitment.routes.js'

const SLUG = 'sotra'
const SCHEMA = 'tenant_sotra'
const JOB = 'job-1'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 10 * 1024 * 1024 } })
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})

afterAll(async () => { await app.close() })

// Séquence de requêtes du parcours de candidature publique.
function mockApplyHappyPath() {
  queryMock.mockImplementation((sql: string) => {
    const s = String(sql)
    if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ schema_name: SCHEMA, name: 'SOTRA' }] })
    if (s.includes('recruitment_jobs') && s.includes('visibility')) return Promise.resolve({ rows: [{ id: JOB, title: 'Développeur' }] })
    if (s.includes('lower(email)')) return Promise.resolve({ rows: [] }) // anti-doublon
    if (s.includes('INSERT INTO') && s.includes('applications')) return Promise.resolve({ rows: [{ id: 'app-1' }] })
    if (s.includes('audit_log')) return Promise.resolve({ rows: [] })
    return Promise.resolve({ rows: [] })
  })
}

function applicationsInsertCall() {
  return queryMock.mock.calls.find(
    (c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('applications'),
  )
}

beforeEach(() => { queryMock.mockReset() })

function multipartBody(boundary: string, fields: Record<string, string>, file?: { name: string; filename: string; type: string; content: string }) {
  let body = ''
  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
  }
  if (file) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n${file.content}\r\n`
  }
  body += `--${boundary}--\r\n`
  return Buffer.from(body, 'utf-8')
}

describe('POST /recruitment/public/:slug/jobs/:id/apply — réception CV', () => {
  it('JSON sans fichier : 201, aucune donnée CV stockée', async () => {
    mockApplyHappyPath()
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      payload: { first_name: 'Awa', last_name: 'Kone', email: 'awa.kone@example.com' },
    })
    expect(res.statusCode).toBe(201)
    const params = applicationsInsertCall()?.[1] as unknown[]
    expect(params).toBeTruthy()
    // ordre INSERT : [...,cv_text(6), cv_blob(7), cv_mime(8), cv_filename(9), ...]
    expect(params[7]).toBeNull()  // cv_blob
    expect(params[6]).toBeNull()  // cv_text
  })

  it('multipart AVEC fichier CV : 201, binaire + texte extrait + métadonnées stockés', async () => {
    mockApplyHappyPath()
    const boundary = '----nexustest1234'
    const payload = multipartBody(
      boundary,
      { first_name: 'Jean', last_name: 'Brou', email: 'jean.brou@example.com', expected_salary: '450000' },
      { name: 'cv', filename: 'cv_jean.txt', type: 'text/plain', content: 'Developpeur 5 ans React Node CNPS Abidjan' },
    )
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(201)
    const params = applicationsInsertCall()?.[1] as unknown[]
    expect(params).toBeTruthy()
    expect(Buffer.isBuffer(params[7])).toBe(true)               // cv_blob
    expect(String(params[6])).toContain('Developpeur')          // cv_text extrait
    expect(params[8]).toBe('text/plain')                        // cv_mime_type
    expect(params[9]).toBe('cv_jean.txt')                       // cv_filename
    expect(params[12]).toBe(450000)                             // expected_salary
  })

  it('multipart avec MIME interdit : 400 (allowlist stricte)', async () => {
    mockApplyHappyPath()
    const boundary = '----nexustest5678'
    const payload = multipartBody(
      boundary,
      { first_name: 'Mal', last_name: 'Ware', email: 'mal.ware@example.com' },
      { name: 'cv', filename: 'evil.exe', type: 'application/x-msdownload', content: 'MZ...' },
    )
    const res = await app.inject({
      method: 'POST',
      url: `/recruitment/public/${SLUG}/jobs/${JOB}/apply`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(400)
    expect(applicationsInsertCall()).toBeFalsy() // rien inséré
  })
})

describe('GET /recruitment/jobs/:id — la liste protège le binaire CV', () => {
  it('ne renvoie jamais cv_blob et expose has_cv', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('recruitment_jobs')) return Promise.resolve({ rows: [{ id: JOB, title: 'Dév' }] })
      if (s.includes('FROM') && s.includes('applications')) {
        return Promise.resolve({ rows: [
          { id: 'a1', first_name: 'A', cv_blob: Buffer.from('PDFDATA'), cv_filename: 'a.pdf' },
          { id: 'a2', first_name: 'B', cv_blob: null },
        ] })
      }
      return Promise.resolve({ rows: [] })
    })
    const token = app.jwt.sign({
      sub: 'u-admin', tenantId: 't1', schemaName: SCHEMA, role: 'admin',
      email: 'admin@sotra.ci', firstName: 'A', lastName: 'D', employeeId: null,
    })
    const res = await app.inject({
      method: 'GET', url: `/recruitment/jobs/${JOB}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const apps = res.json().data.applications as Array<Record<string, unknown>>
    expect(apps).toHaveLength(2)
    expect(apps[0]).not.toHaveProperty('cv_blob')
    expect(apps[0]?.has_cv).toBe(true)
    expect(apps[1]?.has_cv).toBe(false)
  })
})
