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
  },
}))
vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import contractProposalRoutes from './contract-proposal.routes.js'

const SCHEMA = 'tenant_sotra'
const APP_ID = '22222222-2222-4222-8222-222222222222'
const EMP_ID = '33333333-3333-4333-8333-333333333333'
const DOC_ID = '44444444-4444-4444-8444-444444444444'
const USER_ID = '55555555-5555-4555-8555-555555555555'

let app: FastifyInstance

function auth(role: string) {
  const token = app.jwt.sign({
    sub: USER_ID, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
  return { authorization: `Bearer ${token}` }
}

const sqlCalls = () => queryMock.mock.calls.map((c) => String(c[0]))

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(contractProposalRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
})

describe('GET /recruitment/contract-proposal/settings', () => {
  it('renvoie l’option tenant (RH)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ enabled: true }] })
    const res = await app.inject({ method: 'GET', url: '/recruitment/contract-proposal/settings', headers: auth('hr_officer') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual({ enabled: true })
  })

  it('fail-closed sur erreur DB', async () => {
    queryMock.mockRejectedValueOnce(new Error('down'))
    const res = await app.inject({ method: 'GET', url: '/recruitment/contract-proposal/settings', headers: auth('admin') })
    expect(JSON.parse(res.body).data).toEqual({ enabled: false })
  })

  it('interdit à un employé (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/recruitment/contract-proposal/settings', headers: auth('employee') })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /recruitment/applications/:id/contract-proposal', () => {
  it('renvoie la version courante (markdown) et l’historique', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'v2', version: 2, is_current: true, created_at: '2026-10-30', created_by: USER_ID, contract_type: 'cdi_ci', legal_entity_id: null, size_bytes: 1200, markdown: '# Contrat v2' },
          { id: 'v1', version: 1, is_current: false, created_at: '2026-10-29', created_by: USER_ID, contract_type: 'cdi_ci', legal_entity_id: null, size_bytes: 1100, markdown: null },
        ],
      })
    const res = await app.inject({ method: 'GET', url: `/recruitment/applications/${APP_ID}/contract-proposal`, headers: auth('hr_manager') })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.enabled).toBe(true)
    expect(data.current).toMatchObject({ version: 2, markdown: '# Contrat v2' })
    expect(data.versions).toHaveLength(2)
    expect(data.versions[1]).toMatchObject({ version: 1, isCurrent: false })
    // Le markdown n'est lu que pour la version courante.
    expect(sqlCalls().some((q) => q.includes('CASE WHEN is_current THEN markdown END'))).toBe(true)
  })

  it('aucune proposition : current = null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ enabled: true }] })
    const res = await app.inject({ method: 'GET', url: `/recruitment/applications/${APP_ID}/contract-proposal`, headers: auth('admin') })
    expect(JSON.parse(res.body).data).toMatchObject({ current: null, versions: [] })
  })

  it('identifiant invalide → 400 ; rôle manager → 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/recruitment/applications/xx/contract-proposal', headers: auth('admin') })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/recruitment/applications/${APP_ID}/contract-proposal`, headers: auth('manager') })).statusCode).toBe(403)
  })

  it('erreur DB → 500 avec message', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ enabled: true }] }).mockRejectedValueOnce(new Error('boom'))
    const res = await app.inject({ method: 'GET', url: `/recruitment/applications/${APP_ID}/contract-proposal`, headers: auth('admin') })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toMatch(/proposition/)
  })
})

describe('PUT /recruitment/applications/:id/contract-proposal', () => {
  const url = `/recruitment/applications/${APP_ID}/contract-proposal`

  it('enregistre une nouvelle version et re-rend le PDF habillé (filiale)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ enabled: true }] }) // option
      .mockResolvedValueOnce({ rows: [{ id: APP_ID, last_name: 'Traoré', legal_entity_id: EMP_ID, contract_type: 'cdi_ci', version: 1 }] })
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', city: 'Abidjan', cnps_number: 'C1', rccm: 'R1', dgi_number: null, primary_color: '#E85D04', logo_url: null }] })
      .mockResolvedValueOnce({ rows: [{ id: EMP_ID, name: 'SOTRA Filiale Nord', legal_form: 'SA', rccm: 'CI-BKE-1', cnps_number: '999', dgi_number: '123A', address: 'Rue 12', city: 'Bouaké', collective_agreement: 'CCI 1977' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cp-2', version: 2, created_at: '2026-10-30' }] })
    const res = await app.inject({
      method: 'PUT', url, headers: auth('hr_officer'),
      payload: { markdown: '# Contrat\r\n\r\n## Article 1\r\nTexte édité par la RH.' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ id: 'cp-2', version: 2 })
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO "tenant_sotra".contract_proposals'))!
    const params = insert[1] as unknown[]
    expect(params[0]).toBe(APP_ID)
    expect(params[1]).toBe(EMP_ID) // filiale retenue
    expect(params[3]).toBeNull() // conditions de l'offre conservées
    expect(params[4]).toBe('# Contrat\n\n## Article 1\nTexte édité par la RH.')
    expect(Buffer.isBuffer(params[5]) && (params[5] as Buffer).subarray(0, 4).toString()).toBe('%PDF')
    expect(params[6]).toBe(USER_ID)
    expect(String(insert[0])).toContain('is_current = false')
    expect(sqlCalls().some((q) => q.includes('UPDATE "tenant_sotra".applications') && q.includes('contract_pdf = $3'))).toBe(true)
  })

  it('option désactivée → 403 explicite', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ enabled: false }] })
    const res = await app.inject({ method: 'PUT', url, headers: auth('admin'), payload: { markdown: 'x' } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/pas activée/)
  })

  it('valide le corps (vide, trop long, champ inconnu)', async () => {
    for (const payload of [{ markdown: '   ' }, { markdown: 'a'.repeat(100_001) }, { markdown: 'ok', extra: 1 }]) {
      const res = await app.inject({ method: 'PUT', url, headers: auth('admin'), payload })
      expect(res.statusCode).toBe(400)
    }
  })

  it('sans proposition préalable → 409 ; candidature inconnue → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })
      .mockResolvedValueOnce({ rows: [{ id: APP_ID, last_name: 'X', legal_entity_id: null, contract_type: null, version: null }] })
    expect((await app.inject({ method: 'PUT', url, headers: auth('admin'), payload: { markdown: 'x' } })).statusCode).toBe(409)
    queryMock.mockResolvedValueOnce({ rows: [{ enabled: true }] }).mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'PUT', url, headers: auth('admin'), payload: { markdown: 'x' } })).statusCode).toBe(404)
  })

  it('interdit en lecture seule (403)', async () => {
    const res = await app.inject({ method: 'PUT', url, headers: auth('readonly'), payload: { markdown: 'x' } })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /recruitment/applications/:id/contract-proposal/pdf', () => {
  const url = `/recruitment/applications/${APP_ID}/contract-proposal/pdf`

  it('renvoie la version demandée', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ pdf: Buffer.from('%PDF-1.7 v1'), version: 1 }] })
    const res = await app.inject({ method: 'GET', url: `${url}?version=1&download=1`, headers: auth('admin') })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.headers['content-disposition']).toContain('attachment; filename="proposition_contrat_v1.pdf"')
    const call = queryMock.mock.calls.find((c) => String(c[0]).includes('version = $2'))!
    expect(call[1]).toEqual([APP_ID, 1])
  })

  it('version courante par défaut ; 404 si aucune ; 400 si version invalide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'GET', url, headers: auth('admin') })).statusCode).toBe(404)
    expect(sqlCalls().some((q) => q.includes('is_current = true'))).toBe(true)
    expect((await app.inject({ method: 'GET', url: `${url}?version=abc`, headers: auth('admin') })).statusCode).toBe(400)
  })
})

describe('Propositions versées au dossier salarié', () => {
  it('liste uniquement la catégorie contract_proposal (readonly autorisé)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DOC_ID, title: 'Proposition de contrat (générée au recrutement)', file_name: 'p.pdf', size_bytes: 10, version: 1, is_current: true, created_at: '2026-10-30' }] })
    const res = await app.inject({ method: 'GET', url: `/recruitment/contract-proposals/employee/${EMP_ID}`, headers: auth('readonly') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data[0]).toMatchObject({ id: DOC_ID, isCurrent: true })
    const call = queryMock.mock.calls.find((c) => String(c[0]).includes('employee_documents'))!
    expect(call[1]).toEqual([EMP_ID, 'contract_proposal'])
  })

  it('téléchargement filtré par catégorie ; 404 sinon ; employé interdit', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DOC_ID, employee_id: EMP_ID, bytes: Buffer.from('%PDF-1.7'), file_name: 'proposition cdi.pdf' }] })
    const ok = await app.inject({ method: 'GET', url: `/recruitment/contract-proposals/documents/${DOC_ID}/file`, headers: auth('hr_manager') })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-disposition']).toContain('inline; filename="proposition_cdi.pdf"')
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'GET', url: `/recruitment/contract-proposals/documents/${DOC_ID}/file`, headers: auth('admin') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/recruitment/contract-proposals/documents/${DOC_ID}/file`, headers: auth('employee') })).statusCode).toBe(403)
  })
})
