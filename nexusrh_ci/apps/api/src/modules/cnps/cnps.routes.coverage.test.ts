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

vi.mock('../../services/rns-pdf.js', () => ({
  generateRnsPdf: vi.fn().mockResolvedValue(Buffer.from('FAKE_PDF')),
  listRnsFields:  vi.fn().mockResolvedValue([]),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import cnpsRoutes from './cnps.routes.js'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'

function tokenFor(app: FastifyInstance, role: string): string {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
}

function authHeaders(app: FastifyInstance, role: string): { authorization: string } {
  return { authorization: `Bearer ${tokenFor(app, role)}` }
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(cnpsRoutes, { prefix: '/cnps' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/declarations — liste + validation year/status
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/declarations — liste des déclarations', () => {
  it('refuse un non authentifié (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/cnps/declarations' })
    expect(res.statusCode).toBe(401)
  })

  it('refuse un employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations',
      headers: authHeaders(app, 'employee'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('liste sans filtre → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'd1', year: 2024, quarter: 4 }] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations',
      headers: authHeaders(app, 'readonly'),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('liste avec year + status valides → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations?year=2024&status=draft',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuse year invalide format (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations?year=abcd',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('year invalide')
  })

  it('refuse year hors plage (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations?year=1999',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse status hors whitelist (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations?status=bogus',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('status invalide')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// POST /cnps/declarations/generate — chemins non couverts
// ───────────────────────────────────────────────────────────────────────────
describe('POST /cnps/declarations/generate — branches restantes', () => {
  it('filiale fournie introuvable/inactive → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // tenant
      .mockResolvedValueOnce({ rows: [] }) // legal_entity introuvable
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2024, quarter: 1, legalEntityId: UUID_A },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('Filiale introuvable')
  })

  it('déclaration déjà soumise → 422', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: 'decl-x', status: 'submitted' }] }) // existing submitted
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: authHeaders(app, 'hr_manager'),
      payload: { year: 2024, quarter: 2 },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('déjà soumise')
  })

  it('déclaration existante draft → UPDATE (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: 'decl-up', status: 'draft' }] }) // existing draft
      .mockResolvedValueOnce({ rows: [{
        employee_id: UUID_A, first_name: 'A', last_name: 'D',
        cnps_number: 'C', nni: 'N',
        total_cnps_sal: '15000', total_cnps_pat: '20000',
        cnps_retraite_sal: '10000', cnps_retraite_pat: '14000',
        cnps_pf_pat: '4000', cnps_at_pat: '2000',
        gross_salary: '200000', net_payable: '170000',
      }] }) // slipsRes
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: authHeaders(app, 'hr_manager'),
      payload: { year: 2024, quarter: 3 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.id).toBe('decl-up')
    expect(body.data.employeesCount).toBe(1)
  })

  it('SELECT existing échoue → fallback de la requête sans legal_entity (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // tenant
      .mockRejectedValueOnce(new Error('colonne legal_entity_id inconnue')) // existing main -> catch
      .mockResolvedValueOnce({ rows: [] }) // existing fallback
      .mockResolvedValueOnce({ rows: [] }) // slipsRes vide
      .mockResolvedValueOnce({ rows: [{ id: 'decl-fb' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2024, quarter: 4 },
    })
    expect(res.statusCode).toBe(200)
  })

  it('INSERT principal échoue → fallback INSERT sans legal_entity (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // tenant
      .mockResolvedValueOnce({ rows: [] }) // existing
      .mockResolvedValueOnce({ rows: [{
        employee_id: UUID_A, first_name: 'A', last_name: 'D',
        cnps_number: 'C', nni: 'N',
        total_cnps_sal: '15000', total_cnps_pat: '20000',
        cnps_retraite_sal: '0', cnps_retraite_pat: '0',
        cnps_pf_pat: '0', cnps_at_pat: '0',
        gross_salary: '200000', net_payable: '170000',
      }] }) // slipsRes
      .mockRejectedValueOnce(new Error('colonne legal_entity_id inconnue')) // INSERT main -> catch
      .mockResolvedValueOnce({ rows: [{ id: 'decl-ins-fb' }] }) // INSERT fallback
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2024, quarter: 4 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.id).toBe('decl-ins-fb')
  })

  it('body manquant → 400 Zod', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: authHeaders(app, 'admin'),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).details).toBeDefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// POST /cnps/declarations/:id/submit
// ───────────────────────────────────────────────────────────────────────────
describe('POST /cnps/declarations/:id/submit', () => {
  it('refuse id non-UUID (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/not-uuid/submit',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse hr_officer (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/cnps/declarations/${UUID_A}/submit`,
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('déclaration introuvable / non-draft → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE no row
    const res = await app.inject({
      method: 'POST', url: `/cnps/declarations/${UUID_A}/submit`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
  })

  it('soumission OK → 200 + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, year: 2024, quarter: 4, masse_salariale: '200000', total_cotisations: '28000' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: `/cnps/declarations/${UUID_A}/submit`,
      headers: authHeaders(app, 'hr_manager'),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toContain('soumise')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('cnps.declaration_submitted')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/declarations/:id/export — CSV e-CNPS
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/declarations/:id/export — CSV e-CNPS', () => {
  it('refuse id non-UUID (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations/not-uuid/export',
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('déclaration introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${UUID_A}/export`,
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(404)
  })

  it('export CSV OK → 200 + entête e-CNPS', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      year: 2024, quarter: 4,
      data: [{ employee_id: UUID_A, first_name: 'Aïcha', last_name: 'Diallo',
               cnps_number: 'CNPS-1', nni: 'NNI-1',
               gross_salary: '200000', total_cnps_sal: '12600', total_cnps_pat: '15400' }],
      total_cotisations: '28000', employees_count: 1,
    }] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${UUID_A}/export`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body).toContain('NNI;NOM;PRENOM')
    expect(res.body).toContain('DIALLO')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/disa — liste DISA
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/disa — liste DISA annuelles', () => {
  it('refuse employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/disa', headers: authHeaders(app, 'employee'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('liste DISA → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ year: 2024 }] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/disa', headers: authHeaders(app, 'readonly'),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// POST /cnps/disa/generate — branches restantes
// ───────────────────────────────────────────────────────────────────────────
describe('POST /cnps/disa/generate — branches restantes', () => {
  it('refuse body invalide Zod (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 'x' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse employee (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: authHeaders(app, 'employee'),
      payload: { year: 2024 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('has_subsidiaries=true sans legalEntityId → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2024 },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('legalEntityId requis')
  })

  it('filiale introuvable → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // tenant
      .mockResolvedValueOnce({ rows: [] }) // legal_entity introuvable
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2024, legalEntityId: UUID_A },
    })
    expect(res.statusCode).toBe(404)
  })

  it('avec legalEntityId valide → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: UUID_A }] }) // legal_entity valide
      .mockResolvedValueOnce({ rows: [{
        employee_id: UUID_A, first_name: 'A', last_name: 'D',
        cnps_number: 'C', nni: 'N', job_title: 'Dev',
        total_sal: '1200000', total_cnps_sal: '75600', total_its: '12000',
      }] }) // empsRes
      .mockResolvedValueOnce({ rows: [] }) // INSERT/UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2024, legalEntityId: UUID_A },
    })
    expect(res.statusCode).toBe(200)
  })

  it('INSERT disa principal échoue → fallback INSERT (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // tenant
      .mockResolvedValueOnce({ rows: [{
        employee_id: UUID_A, first_name: 'A', last_name: 'D',
        cnps_number: 'C', nni: 'N', job_title: 'Dev',
        total_sal: '1200000', total_cnps_sal: '75600', total_its: '12000',
      }] }) // empsRes
      .mockRejectedValueOnce(new Error('colonne legal_entity_id inconnue')) // INSERT main -> catch
      .mockResolvedValueOnce({ rows: [] }) // INSERT fallback
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2024 },
    })
    expect(res.statusCode).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/declarations/:id/neva — XML NEVA
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/declarations/:id/neva — branches restantes', () => {
  it('refuse hr_officer (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${UUID_A}/neva`,
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('déclaration introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${UUID_A}/neva`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
  })

  it('échappe les caractères XML spéciaux & tenant absent', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        year: 2024, quarter: 4,
        data: [{ nni: 'N&1', last_name: 'O<Brien>', first_name: 'A&B',
                 cnps_number: 'C', gross_salary: '200000', total_cnps_sal: '12600', total_cnps_pat: '15400' }],
        total_cotisations_salariales: '12600', total_cotisations_patronales: '15400',
        total_cotisations: '28000', masse_salariale: '200000', employees_count: 1,
      }] })
      .mockResolvedValueOnce({ rows: [] }) // tenant absent
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${UUID_A}/neva`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('&amp;')
    expect(res.body).toContain('&lt;')
    expect(res.body).toContain('&gt;')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// POST /cnps/events/cessation
// ───────────────────────────────────────────────────────────────────────────
describe('POST /cnps/events/cessation', () => {
  it('refuse body invalide (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cnps/events/cessation',
      headers: authHeaders(app, 'admin'),
      payload: { employeeId: 'not-uuid', exitDate: 'bad', reason: 'unknown' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('cessation invalides')
  })

  it('refuse hr_officer (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/cnps/events/cessation',
      headers: authHeaders(app, 'hr_officer'),
      payload: { employeeId: UUID_A, exitDate: '2024-12-31', reason: 'resignation' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('employé introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/cnps/events/cessation',
      headers: authHeaders(app, 'admin'),
      payload: { employeeId: UUID_A, exitDate: '2024-12-31', reason: 'resignation' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('cessation < 1 an ancienneté → préavis 30j, indemnité 0', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, first_name: 'Jean', last_name: 'Kouassi',
        cnps_number: 'C', nni: 'N',
        hire_date: '2024-06-01', base_salary: '300000',
      }] }) // employee
      .mockResolvedValueOnce({ rows: [] }) // INSERT hr_events
      .mockResolvedValueOnce({ rows: [] }) // UPDATE employees
    const res = await app.inject({
      method: 'POST', url: '/cnps/events/cessation',
      headers: authHeaders(app, 'admin'),
      payload: { employeeId: UUID_A, exitDate: '2024-12-31', reason: 'resignation' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.droitsLegaux.preavisJours).toBe(30)
    expect(body.droitsLegaux.indemniteLicenciement).toBe(0)
  })

  it('cessation 1–5 ans → préavis 60j, indemnité > 0', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, first_name: 'Jean', last_name: 'Kouassi',
        cnps_number: 'C', nni: 'N',
        hire_date: '2021-01-01', base_salary: '300000',
      }] }) // employee
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
    const res = await app.inject({
      method: 'POST', url: '/cnps/events/cessation',
      headers: authHeaders(app, 'hr_manager'),
      payload: { employeeId: UUID_A, exitDate: '2024-12-31', reason: 'dismissal', comment: 'faute' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.droitsLegaux.preavisJours).toBe(60)
    expect(body.droitsLegaux.indemniteLicenciement).toBeGreaterThan(0)
  })

  it('cessation > 5 ans → préavis 90j', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: UUID_A, first_name: 'Jean', last_name: 'Kouassi',
        cnps_number: 'C', nni: 'N',
        hire_date: '2010-01-01', base_salary: '600000',
      }] }) // employee
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
    const res = await app.inject({
      method: 'POST', url: '/cnps/events/cessation',
      headers: authHeaders(app, 'admin'),
      payload: { employeeId: UUID_A, exitDate: '2024-12-31', reason: 'retirement' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).droitsLegaux.preavisJours).toBe(90)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/summary
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/summary — récapitulatif annuel', () => {
  it('refuse year hors plage (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/summary?year=1800',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/summary',
      headers: authHeaders(app, 'employee'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('récap OK → totaux agrégés (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { month: '2024-01', gross: '1000000', cnps_sal: '63000', cnps_pat: '77000', its: '50000', net: '850000' },
      { month: '2024-02', gross: '1000000', cnps_sal: '63000', cnps_pat: '77000', its: '50000', net: '850000' },
    ] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/summary?year=2024',
      headers: authHeaders(app, 'readonly'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.totals.gross).toBe(2000000)
    expect(body.year).toBe(2024)
  })

  it('récap sans year → année courante par défaut', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/summary',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/validate/:year/:quarter
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/validate/:year/:quarter — validateur pré-DSN', () => {
  it('refuse year/quarter invalides (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/validate/1800/4',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse quarter hors plage (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/validate/2024/9',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('détecte tous les blocages : pas de CNPS employeur, pas de bulletins, employés sans CNPS/NNI, sous SMIG', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: null }] }) // tenant sans cnps
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] }) // slipCount 0
      .mockResolvedValueOnce({ rows: [{ id: 'e1', first_name: 'A', last_name: 'X' }] }) // no cnps
      .mockResolvedValueOnce({ rows: [{ id: 'e2', first_name: 'B', last_name: 'Y' }] }) // no nni
      .mockResolvedValueOnce({ rows: [{ id: 'e3', first_name: 'C', last_name: 'Z', net: '50000' }] }) // below smig
    const res = await app.inject({
      method: 'GET', url: '/cnps/validate/2024/1',
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.valid).toBe(false)
    expect(body.summary.blocking).toBeGreaterThan(0)
    const codes = body.errors.map((e: { code: string }) => e.code)
    expect(codes).toContain('CNPS_EMPLOYER_MISSING')
    expect(codes).toContain('NO_PAYSLIPS')
    expect(codes).toContain('EMPLOYEE_NO_CNPS')
    expect(codes).toContain('EMPLOYEE_NO_NNI')
  })

  it('déclaration valide passée (deadline dépassée) → warning DEADLINE_PASSED', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'CI-123' }] }) // tenant ok
      .mockResolvedValueOnce({ rows: [{ cnt: '10' }] }) // slipCount > 0
      .mockResolvedValueOnce({ rows: [] }) // no cnps missing
      .mockResolvedValueOnce({ rows: [] }) // no nni missing
      .mockResolvedValueOnce({ rows: [] }) // below smig none
    const res = await app.inject({
      method: 'GET', url: '/cnps/validate/2020/1',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.valid).toBe(true)
    expect(body.summary.message).toContain('prête')
    const wcodes = body.warnings.map((w: { code: string }) => w.code)
    expect(wcodes).toContain('DEADLINE_PASSED')
  })

  it('deadline à moins de 5 jours → warning DEADLINE_SOON', async () => {
    // On fige "aujourd'hui" au 11 avril : pour T1 (jan-mar), la deadline est le
    // 15 avril (mois M+1 du dernier mois du trimestre) → 4 jours restants.
    const fixedNow = new Date(2025, 3, 11, 12, 0, 0) // 2025-04-11
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    try {
      queryMock
        .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'CI-123' }] })
        .mockResolvedValueOnce({ rows: [{ cnt: '5' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
      const res = await app.inject({
        method: 'GET', url: '/cnps/validate/2025/1',
        headers: authHeaders(app, 'admin'),
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      const wcodes = body.warnings.map((w: { code: string }) => w.code)
      expect(wcodes).toContain('DEADLINE_SOON')
      expect(wcodes).not.toContain('DEADLINE_PASSED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('déclaration future (deadline non dépassée) → pas de DEADLINE_PASSED', async () => {
    const nextYear = new Date().getFullYear() + 1
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'CI-123' }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '5' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/validate/${nextYear}/4`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const wcodes = body.warnings.map((w: { code: string }) => w.code)
    expect(wcodes).not.toContain('DEADLINE_PASSED')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/rns/fields
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/rns/fields', () => {
  it('refuse hr_officer (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/fields',
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('aucun champ AcroForm → message PDF plat', async () => {
    const rnsPdf = await import('../../services/rns-pdf.js')
    vi.mocked(rnsPdf.listRnsFields).mockResolvedValueOnce([])
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/fields',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.hasAcroForm).toBe(false)
    expect(body.message).toContain('PDF plat')
  })

  it('champs détectés → message remplissable', async () => {
    const rnsPdf = await import('../../services/rns-pdf.js')
    vi.mocked(rnsPdf.listRnsFields).mockResolvedValueOnce(['NOM', 'PRENOM'])
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/fields',
      headers: authHeaders(app, 'hr_manager'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.hasAcroForm).toBe(true)
    expect(body.fields).toHaveLength(2)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/rns/:year/pdf — branches restantes
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/rns/:year/pdf — branches restantes', () => {
  it('tenant introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // tenant absent
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/pdf',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('Tenant introuvable')
  })

  it('aucun employé → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'C', city: 'Abidjan',
        cnps_affiliation_date: '01/01/2020', address: 'Abidjan, CI' }] })
      .mockResolvedValueOnce({ rows: [] }) // aucun employé
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/pdf',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('Aucun employé')
  })

  it('avec employeeId filtré → PDF OK + suffixe nom', async () => {
    const rnsPdf = await import('../../services/rns-pdf.js')
    vi.mocked(rnsPdf.generateRnsPdf).mockResolvedValueOnce(Buffer.from('OK'))
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'C', city: 'Abidjan',
        cnps_affiliation_date: '01/01/2020', address: 'Abidjan, CI' }] })
      .mockResolvedValueOnce({ rows: [{ first_name: 'A', last_name: 'KOUASSI', cnps_number: 'C',
        hire_date: '2020-01-01', exit_date: '2024-06-01', annual_salary: 1000000, months_worked: 6 }] })
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: `/cnps/rns/2024/pdf?employeeId=${UUID_A}`,
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('KOUASSI')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/rns/:year/export — CSV RNS
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/rns/:year/export — CSV RNS', () => {
  it('refuse year hors plage (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/1800/export',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/export',
      headers: authHeaders(app, 'employee'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('aucun bulletin → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'C', rccm: 'R', dgi_number: 'D' }] })
      .mockResolvedValueOnce({ rows: [] }) // aucun employé
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/export',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
  })

  it('export CSV RNS OK → 200 + totaux + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'C', rccm: 'R', dgi_number: 'D' }] })
      .mockResolvedValueOnce({ rows: [{
        employee_id: UUID_A, first_name: 'Aïcha', last_name: 'Diallo',
        cnps_number: 'C', nni: 'N', job_title: 'Dev',
        mois_travailles: '12', salaire_brut_annuel: '2400000',
        cotis_sal_annuelle: '151200', cotis_pat_annuelle: '184800', its_annuel: '120000',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/export',
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body).toContain('RELEVÉ NOMINATIF')
    expect(res.body).toContain('TOTAL GÉNÉRAL')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('cnps.rns_csv_exported')
  })

  it('export CSV RNS avec tenant absent → 200 (fallbacks vides)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // tenant absent
      .mockResolvedValueOnce({ rows: [{
        employee_id: UUID_A, first_name: 'A', last_name: 'D',
        cnps_number: 'C', nni: 'N', job_title: 'Dev',
        mois_travailles: '12', salaire_brut_annuel: '2400000',
        cotis_sal_annuelle: '151200', cotis_pat_annuelle: '184800', its_annuel: '120000',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/export',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/disa/:year/export — branches restantes
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/disa/:year/export — branches restantes', () => {
  it('DISA non générée → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'C', dgi_number: 'D' }] }) // tenant
      .mockResolvedValueOnce({ rows: [] }) // disa absente
    const res = await app.inject({
      method: 'GET', url: '/cnps/disa/2024/export',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('non générée')
  })

  it('export DISA avec tenant absent → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // tenant absent
      .mockResolvedValueOnce({ rows: [{
        data: [{ employee_id: UUID_A, first_name: 'A', last_name: 'D',
                 nni: 'N', cnps_number: 'C', job_title: 'Dev',
                 total_sal: '1200000', total_cnps_sal: '75600', total_its: '12000' }],
        year: 2024, employees_count: 1,
        masse_salariale: '1200000', total_cnps: '75600', total_its: '12000',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: '/cnps/disa/2024/export',
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('DÉCLARATION INDIVIDUELLE')
    expect(res.body).toContain('TOTAL GÉNÉRAL')
  })

  it('refuse employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/disa/2024/export',
      headers: authHeaders(app, 'employee'),
    })
    expect(res.statusCode).toBe(403)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// GET /cnps/audit-conformite — audit 360°
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/audit-conformite — audit conformité 360°', () => {
  it('refuse employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/audit-conformite',
      headers: authHeaders(app, 'employee'),
    })
    expect(res.statusCode).toBe(403)
  })

  function mockAuditQueries(opts: {
    tenant?: Record<string, unknown> | null
    emps?: Array<Record<string, unknown>>
    decls?: Array<Record<string, unknown>>
    cotis?: Record<string, unknown>
    monthly?: Array<Record<string, unknown>>
    mobile?: Array<Record<string, unknown>>
  }): void {
    queryMock
      .mockResolvedValueOnce({ rows: opts.tenant === null ? [] : [opts.tenant ?? { name: 'Sotra', cnps_number: 'C', dgi_number: 'D', rccm: 'R', at_rate: '0.030' }] }) // tenant
      .mockResolvedValueOnce({ rows: opts.emps ?? [] }) // emps
      .mockResolvedValueOnce({ rows: opts.decls ?? [] }) // declarations
      .mockResolvedValueOnce({ rows: [opts.cotis ?? { masse: '1000000', cnps_sal: '63000', cnps_pat: '77000', its: '50000', net: '810000', nb: '5', nb_plaf_retraite: '0', nb_plaf_atpf: '4' }] }) // cotis
      .mockResolvedValueOnce({ rows: opts.monthly ?? [{ month: '2024-01', nb: '5', masse: '1000000', cnps_sal: '63000', cnps_pat: '77000', its: '50000', net: '810000' }] }) // monthly
      .mockResolvedValueOnce({ rows: opts.mobile ?? [{ provider: 'wave', cnt: '3' }] }) // mobile
  }

  it('tenant conforme sans anomalies → statut conforme', async () => {
    const futureYear = new Date().getFullYear() + 2
    mockAuditQueries({
      emps: [{
        id: 'e1', first_name: 'A', last_name: 'D', job_title: 'Dev',
        nni: 'N', cnps_number: 'C', hire_date: '2020-01-01', exit_date: null,
        mobile_money_provider: 'wave', mobile_money_phone: '+2250700000000',
        contract_type: 'cdi', department_name: 'IT',
        net_payable: '300000', gross_salary: '350000', mois_ref: `${futureYear}-01`,
      }],
    })
    const res = await app.inject({
      method: 'GET', url: `/cnps/audit-conformite?year=${futureYear}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.statut).toBe('conforme')
    expect(body.scoreConformite).toBe(100)
  })

  it('tenant sans CNPS/DGI/RCCM + employés incomplets → non_conforme avec anomalies', async () => {
    mockAuditQueries({
      tenant: { name: 'Sotra', cnps_number: '', dgi_number: '', rccm: '', at_rate: '0.020' },
      emps: [{
        id: 'e1', first_name: 'A', last_name: 'D', job_title: 'Dev',
        nni: '', cnps_number: '', hire_date: '2020-01-01', exit_date: null,
        mobile_money_provider: null, mobile_money_phone: null,
        contract_type: 'cdi', department_name: '',
        net_payable: '50000', gross_salary: '50000', mois_ref: '2024-01',
      }],
    })
    const res = await app.inject({
      method: 'GET', url: '/cnps/audit-conformite?year=2024',
      headers: authHeaders(app, 'hr_manager'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.statut).toBe('non_conforme')
    const codes = body.anomalies.map((a: { code: string }) => a.code)
    expect(codes).toContain('EMP_CNPS_MISSING')
    expect(codes).toContain('EMP_NO_NNI')
    expect(codes).toContain('EMP_NO_CNPS')
    expect(codes).toContain('BELOW_SMIG')
    expect(codes).toContain('NO_MOBILE')
    expect(codes).toContain('DECL_MISSING')
  })

  it('déclaration en brouillon échue → anomalie DECL_DRAFT', async () => {
    mockAuditQueries({
      decls: [
        { quarter: 1, status: 'draft', total_cotisations: '100000', employees_count: 5 },
        { quarter: 2, status: 'submitted', total_cotisations: '100000', employees_count: 5 },
      ],
    })
    const res = await app.inject({
      method: 'GET', url: '/cnps/audit-conformite?year=2020',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const codes = body.anomalies.map((a: { code: string }) => a.code)
    expect(codes).toContain('DECL_DRAFT')
    expect(body.kpis.declarationsSoumises).toBe(1)
  })

  it('checks désactivés via query (?checkCnps=false…) → seulement avertissements', async () => {
    mockAuditQueries({
      tenant: { name: 'Sotra', cnps_number: 'C', dgi_number: '', rccm: 'R', at_rate: '0.020' },
      emps: [{
        id: 'e1', first_name: 'A', last_name: 'D', job_title: 'Dev',
        nni: '', cnps_number: '', hire_date: '2020-01-01', exit_date: null,
        mobile_money_provider: null, mobile_money_phone: null,
        contract_type: 'cdi', department_name: '',
        net_payable: '50000', gross_salary: '50000', mois_ref: '2024-01',
      }],
      decls: [
        { quarter: 1, status: 'submitted', total_cotisations: '1', employees_count: 1 },
        { quarter: 2, status: 'submitted', total_cotisations: '1', employees_count: 1 },
        { quarter: 3, status: 'submitted', total_cotisations: '1', employees_count: 1 },
        { quarter: 4, status: 'submitted', total_cotisations: '1', employees_count: 1 },
      ],
    })
    const futureYear = new Date().getFullYear() + 2
    const res = await app.inject({
      method: 'GET',
      url: `/cnps/audit-conformite?year=${futureYear}&checkCnps=false&checkSmig=false&checkMobile=false&checkDecl=false&checkPlafonds=false`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // checkEmployeur reste actif : DGI manquant → avertissement
    expect(body.statut).toBe('avertissements')
    expect(body.resume.bloquants).toBe(0)
  })
})
