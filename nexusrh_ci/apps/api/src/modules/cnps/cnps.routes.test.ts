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

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
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

describe('POST /cnps/declarations/generate — audit_log (OWASP A09)', () => {
  it('génère + trace audit cnps.declaration_generated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // SELECT tenant (Palier 3 multi-filiales)
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [{
        employee_id: UUID_A, first_name: 'A', last_name: 'D',
        cnps_number: 'CNPS-123', nni: 'NNI-1',
        total_cnps_sal: '15000', total_cnps_pat: '20000',
        cnps_retraite_sal: '10000', cnps_retraite_pat: '14000',
        cnps_pf_pat: '4000', cnps_at_pat: '2000',
        gross_salary: '200000', net_payable: '170000',
      }] }) // slipsRes
      .mockResolvedValueOnce({ rows: [{ id: 'decl-1' }] }) // INSERT cnps_declarations RETURNING id
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { year: 2024, quarter: 4 },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('cnps.declaration_generated')
  })

  it('refuse year out-of-range / quarter > 4 via Zod (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { year: 1800, quarter: 5 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un employee NE PEUT PAS générer de déclaration (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { year: 2024, quarter: 4 },
    })
    expect(res.statusCode).toBe(403)
  })

  // ── Palier 3 multi-filiales ────────────────────────────────────────────────
  it('tenant has_subsidiaries=true → refuse SANS legalEntityId (400)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { year: 2024, quarter: 4 },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('legalEntityId requis')
  })

  it('tenant has_subsidiaries=true + legalEntityId UUID + filiale valide → OK', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })        // SELECT tenant
      .mockResolvedValueOnce({ rows: [{ id: UUID_A }] })                    // SELECT legal_entity (valide)
      .mockResolvedValueOnce({ rows: [] })                                  // SELECT existing
      .mockResolvedValueOnce({ rows: [] })                                  // slipsRes (vide ok)
      .mockResolvedValueOnce({ rows: [{ id: 'decl-multi' }] })              // INSERT cnps_declarations
      .mockResolvedValueOnce({ rows: [] })                                  // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { year: 2024, quarter: 4, legalEntityId: UUID_A },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    // params: [userId, action, entityId, changes_json, ip]
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.legalEntityId).toBe(UUID_A)
  })

  it('legalEntityId non-UUID → refus Zod 400', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { year: 2024, quarter: 4, legalEntityId: 'not-uuid' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /cnps/disa/generate — cap + audit (OWASP A04 + A09)', () => {
  it('refuse 413 si > 2000 employés (cap anti-fraude)', async () => {
    const fakeRows = Array.from({ length: 2001 }, (_, i) => ({
      employee_id: `e${i}`, first_name: 'E', last_name: 'X',
      cnps_number: 'C', nni: 'N', job_title: 'Dev',
      total_sal: '100000', total_cnps_sal: '6300', total_its: '500',
    }))
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // SELECT tenant
      .mockResolvedValueOnce({ rows: fakeRows })

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { year: 2024 },
    })
    expect(res.statusCode).toBe(413)
    expect(JSON.parse(res.body).error).toContain('2000')
  })

  it('trace audit cnps.disa_generated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: false }] }) // SELECT tenant
      .mockResolvedValueOnce({ rows: [{
        employee_id: UUID_A, first_name: 'A', last_name: 'D',
        cnps_number: 'C', nni: 'N', job_title: 'Dev',
        total_sal: '1200000', total_cnps_sal: '75600', total_its: '12000',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // INSERT/UPDATE disa_records
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { year: 2024 },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('cnps.disa_generated')
  })
})

describe('GET /cnps/declarations/:id/neva — UUID + audit (OWASP A03 + A09)', () => {
  it('refuse id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations/not-uuid/neva',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('export NEVA OK → trace audit cnps.declaration_neva_exported', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        year: 2024, quarter: 4,
        data: [{ nni: 'NNI-1', last_name: 'Diallo', first_name: 'Aïcha',
                 cnps_number: 'C', gross_salary: '200000', total_cnps_sal: '12600', total_cnps_pat: '15400' }],
        total_cotisations_salariales: '12600', total_cotisations_patronales: '15400',
        total_cotisations: '28000', masse_salariale: '200000', employees_count: 1,
      }] })
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'CI-X', slug: 'sotra' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${UUID_A}/neva`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<DECLARATION_CNPS')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('cnps.declaration_neva_exported')
  })
})

describe('GET /cnps/rns/:year/pdf — year strict + PDF error masking (OWASP A03 + A10)', () => {
  it('refuse year hors plage (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/1800/pdf',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse employeeId non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/pdf?employeeId=not-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('erreur génération PDF masquée en 500 générique (OWASP A10)', async () => {
    const rnsPdf = await import('../../services/rns-pdf.js')
    vi.mocked(rnsPdf.generateRnsPdf).mockRejectedValueOnce(new Error('PDFKit: font not found /usr/secret/path/Helvetica.afm'))
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'C', city: 'Abidjan',
        cnps_affiliation_date: '01/01/2020', address: 'Abidjan, CI' }] })
      .mockResolvedValueOnce({ rows: [{ first_name: 'A', last_name: 'D', cnps_number: 'C',
        hire_date: '2020-01-01', exit_date: null, annual_salary: 1000000, months_worked: 12 }] })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/pdf',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('/usr/secret/path')
    expect(res.body).not.toContain('PDFKit')
    expect(JSON.parse(res.body).error).toBe('Échec de la génération du RNS PDF')
  })

  it('export PDF OK → audit cnps.rns_pdf_exported', async () => {
    const rnsPdf = await import('../../services/rns-pdf.js')
    vi.mocked(rnsPdf.generateRnsPdf).mockResolvedValueOnce(Buffer.from('OK'))
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'C', city: 'Abidjan',
        cnps_affiliation_date: '01/01/2020', address: 'Abidjan, CI' }] })
      .mockResolvedValueOnce({ rows: [{ first_name: 'A', last_name: 'D', cnps_number: 'C',
        hire_date: '2020-01-01', exit_date: null, annual_salary: 1000000, months_worked: 12 }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2024/pdf',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('cnps.rns_pdf_exported')
  })
})

describe('GET /cnps/disa/:year/export — year strict + audit (OWASP A03 + A09)', () => {
  it('refuse year hors plage (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/cnps/disa/1800/export',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('export CSV OK → trace audit cnps.disa_csv_exported', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Sotra', cnps_number: 'C', dgi_number: 'D' }] })
      .mockResolvedValueOnce({ rows: [{
        data: [{ employee_id: UUID_A, first_name: 'A', last_name: 'D',
                 nni: 'N', cnps_number: 'C', job_title: 'Dev',
                 total_sal: '1200000', total_cnps_sal: '75600', total_its: '12000' }],
        year: 2024, employees_count: 1,
        masse_salariale: '1200000', total_cnps: '75600', total_its: '12000',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/cnps/disa/2024/export',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('cnps.disa_csv_exported')
  })
})
