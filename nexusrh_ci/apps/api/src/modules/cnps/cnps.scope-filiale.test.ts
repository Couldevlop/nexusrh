/**
 * Périmètre CNPS Côte d'Ivoire en multi-filiales :
 *  - validateur pré-DSN mensuel + filiale (n° CNPS de la filiale, bulletins filtrés) ;
 *  - refus des filiales hors CI (Burkina, Bénin…) sur validate / generate / DISA / RNS ;
 *  - SMIG du pack (salaire de base ramené au temps plein) au lieu de 75 000 en dur ;
 *  - tuiles de synthèse et RNS restreints aux bulletins CI.
 */
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
const ABJ = '11111111-1111-1111-1111-111111111111'
const BFA = '22222222-2222-2222-2222-222222222222'

const ENTITY_ABJ = {
  id: ABJ, name: 'SOTRA Abidjan', cnps_number: 'CI-ABJ-001', dgi_number: 'DGI-ABJ', rccm: 'RCCM-ABJ',
  city: 'Abidjan', address: 'Plateau, Abidjan', country_code: 'CIV', legislation_pack_code: 'CIV-2024', at_rate: '0.0200',
}
const ENTITY_BFA = {
  id: BFA, name: 'SOTRA Burkina', cnps_number: 'BF-001', dgi_number: null, rccm: null,
  city: 'Ouagadougou', address: null, country_code: 'BFA', legislation_pack_code: 'BFA-2024', at_rate: '0.0350',
}
const MULTI_TENANT = { name: 'SOTRA', cnps_number: 'CI-SIEGE', has_subsidiaries: true, default_country_code: 'CIV', at_rate: '0.020' }

function authHeaders(app: FastifyInstance, role: string): { authorization: string } {
  const token = app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
  return { authorization: `Bearer ${token}` }
}

/** Appels SQL (hors audit_log fire-and-forget). */
function sqlCalls(): Array<[string, unknown[]]> {
  return queryMock.mock.calls
    .map((c) => [String(c[0]), (c[1] ?? []) as unknown[]] as [string, unknown[]])
    .filter(([sql]) => !sql.includes('audit_log'))
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
  // Repli (audit_log fire-and-forget, requêtes non scénarisées) : aucune ligne.
  queryMock.mockResolvedValue({ rows: [] })
})

// ───────────────────────────────────────────────────────────────────────────
// Validateur pré-DSN
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/validate — périodicité mensuelle + filiale', () => {
  it('mensuel + filiale CI : n° CNPS de la filiale, bulletins filtrés sur la filiale et le mois', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })     // tenant
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })       // filiale
      .mockResolvedValueOnce({ rows: [{ cnt: '12' }] })    // slipCount
      .mockResolvedValueOnce({ rows: [] })                 // sans CNPS
      .mockResolvedValueOnce({ rows: [] })                 // sans NNI
      .mockResolvedValueOnce({ rows: [] })                 // sous SMIG
    const res = await app.inject({
      method: 'GET', url: `/cnps/validate/2025/1?month=2025-05&legalEntityId=${ABJ}`,
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.valid).toBe(true)
    expect(body.employerCnps).toBe('CI-ABJ-001')
    expect(body.months).toEqual(['2025-05'])
    expect(body.periodType).toBe('monthly')
    expect(body.quarter).toBe(2) // dérivé du mois, pas du trimestre de l'URL
    expect(body.legalEntityId).toBe(ABJ)
    expect(body.totalPayslips).toBe(12)

    const calls = sqlCalls()
    const slipCount = calls.find(([sql]) => sql.includes('COUNT(*)::text AS cnt'))!
    expect(slipCount[0]).toContain('ps.legal_entity_id = $2')
    expect(slipCount[1]).toEqual([['2025-05'], ABJ])
    // Les 4 requêtes bulletins sont toutes scopées filiale
    const scoped = calls.filter(([sql]) => sql.includes('pay_slips') && sql.includes('ps.legal_entity_id = $2'))
    expect(scoped).toHaveLength(4)
  })

  it('multi-filiales sans legalEntityId → 400 (filiale obligatoire comme pour générer)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [MULTI_TENANT] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/validate/2025/2',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('filiale')
  })

  it('filiale CI sans n° CNPS → blocage pointant Paramètres → Entités juridiques (pas le n° du tenant)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [{ ...ENTITY_ABJ, cnps_number: null }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '3' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/validate/2025/2?legalEntityId=${ABJ}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.valid).toBe(false)
    expect(body.employerCnps).toBeNull()
    const err = body.errors.find((e: { code: string }) => e.code === 'CNPS_EMPLOYER_MISSING')
    expect(err.message).toContain('Entités juridiques')
    expect(err.message).toContain('SOTRA Abidjan')
  })

  it('filiale hors CI (Burkina) → 400 déclaration non prise en charge', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_BFA] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/validate/2025/2?legalEntityId=${BFA}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('non prise en charge pour ce pays')
    expect(sqlCalls().some(([sql]) => sql.includes('pay_slips'))).toBe(false)
  })

  it('filiale introuvable → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/validate/2025/2?legalEntityId=${ABJ}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
  })

  it.each([
    ['month au mauvais format', '/cnps/validate/2025/2?month=2025-13'],
    ["month d'une autre année", '/cnps/validate/2025/2?month=2024-05'],
    ['legalEntityId non UUID', '/cnps/validate/2025/2?legalEntityId=abc'],
  ])('refuse %s (400)', async (_label, url) => {
    const res = await app.inject({ method: 'GET', url, headers: authHeaders(app, 'admin') })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('mono-entité : bulletins restreints au périmètre CI, n° CNPS du tenant', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Cabinet', cnps_number: 'CI-CAB', has_subsidiaries: false, default_country_code: 'CIV' }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '4' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/validate/2025/3',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.employerCnps).toBe('CI-CAB')
    expect(body.months).toEqual(['2025-07', '2025-08', '2025-09'])
    const slipCount = sqlCalls().find(([sql]) => sql.includes('COUNT(*)::text AS cnt'))!
    expect(slipCount[0]).toContain("LIKE 'CIV-%'")
    expect(slipCount[1]).toEqual([['2025-07', '2025-08', '2025-09']])
  })
})

describe('GET /cnps/validate — contrôle SMIG du pack', () => {
  it('compare le salaire de base (ramené au temps plein) au SMIG du pack CIV-2024', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
      .mockResolvedValueOnce({ rows: [{ cnt: '2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        { id: 'e1', first_name: 'Awa', last_name: 'KONE', month: '2025-05', base: '60000', full_time_base: '60000', weekly_hours: '40.0' },
        { id: 'e2', first_name: 'Yao', last_name: 'N', month: '2025-05', base: '35000', full_time_base: '70000', weekly_hours: '20.0' },
      ] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/validate/2025/2?month=2025-05&legalEntityId=${ABJ}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.smigReference).toBe(75_000)
    expect(body.legislationPackCode).toBe('CIV-2024')
    const smigWarnings = body.warnings.filter((w: { code: string }) => w.code === 'BELOW_SMIG')
    expect(smigWarnings).toHaveLength(2)
    expect(smigWarnings[0].message).toContain('salaire de base 60 000 FCFA')
    expect(smigWarnings[0].message).toContain('SMIG 75 000 FCFA (pack CIV-2024)')
    expect(smigWarnings[1].message).toContain('soit 70 000 à temps plein')

    const smigCall = sqlCalls().find(([sql]) => sql.includes('base_salary * 40.0'))!
    expect(smigCall[0]).not.toContain('net_payable')
    expect(smigCall[1][smigCall[1].length - 1]).toBe(75_000)
  })

  it('le SMIG suit le pack du pays du tenant (plus de 75 000 en dur)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Dakar SA', cnps_number: 'SN-1', has_subsidiaries: false, default_country_code: 'SEN' }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/validate/2025/1',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.smigReference).toBe(64_710)
    const smigCall = sqlCalls().find(([sql]) => sql.includes('base_salary * 40.0'))!
    expect(smigCall[1][smigCall[1].length - 1]).toBe(64_710)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Génération : déclaration + DISA refusées hors CI
// ───────────────────────────────────────────────────────────────────────────
describe('POST /cnps/declarations/generate & /cnps/disa/generate — filiale hors CI', () => {
  it('déclaration pour une filiale Burkina → 400, rien n’est agrégé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [ENTITY_BFA] })
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2025, month: '2025-05', legalEntityId: BFA },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('SOTRA Burkina')
    expect(sqlCalls().some(([sql]) => sql.includes('pay_slips') || sql.includes('cnps_declarations'))).toBe(false)
  })

  it('DISA pour une filiale Bénin (pays seul, sans pack) → 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [{ id: BFA, name: 'SOTRA Bénin', country_code: 'BEN', legislation_pack_code: null }] })
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate',
      headers: authHeaders(app, 'admin'),
      payload: { year: 2025, legalEntityId: BFA },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('non prise en charge pour ce pays')
  })

  it('déclaration pour une filiale CI (Bouaké, pack CIV-2024) → acceptée et scopée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [{ ...ENTITY_ABJ, name: 'SOTRA Bouaké', city: 'Bouaké' }] })
      .mockResolvedValueOnce({ rows: [] })                // existing
      .mockResolvedValueOnce({ rows: [] })                // slips
      .mockResolvedValueOnce({ rows: [{ id: 'decl-1' }] }) // INSERT
    const res = await app.inject({
      method: 'POST', url: '/cnps/declarations/generate',
      headers: authHeaders(app, 'hr_manager'),
      payload: { year: 2025, month: '2025-05', legalEntityId: ABJ },
    })
    expect(res.statusCode).toBe(200)
    const slips = sqlCalls().find(([sql]) => sql.includes('FROM "tenant_sotra".pay_slips ps'))!
    expect(slips[1]).toEqual([['2025-05'], ABJ])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Tuiles de synthèse
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/summary — périmètre CNPS CI', () => {
  it('exclut les bulletins des filiales hors CI (filtre SQL sur le pack/pays de la filiale)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { month: '2025-01', gross: '500000', cnps_sal: '31500', cnps_pat: '38500', its: '20000', net: '440000' },
    ] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/summary?year=2025',
      headers: authHeaders(app, 'readonly'),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).totals.gross).toBe(500_000)
    const [sql, params] = sqlCalls()[0]!
    expect(sql).toContain('ps.legal_entity_id IS NULL OR EXISTS')
    expect(sql).toContain('"tenant_sotra".legal_entities pse')
    expect(sql).toContain("LIKE 'CIV-%'")
    expect(params).toEqual(['2025-%'])
  })

  it('filtrable par filiale (?legalEntityId)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/summary?year=2025&legalEntityId=${ABJ}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const [sql, params] = sqlCalls()[0]!
    expect(sql).toContain('ps.legal_entity_id = $2')
    expect(params).toEqual(['2025-%', ABJ])
  })

  it('refuse un legalEntityId non UUID (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/summary?year=2025&legalEntityId=1%20OR%201=1',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// RNS
// ───────────────────────────────────────────────────────────────────────────
describe('RNS — bulletins hors CI exclus, filiale optionnelle', () => {
  const RNS_ROW = {
    employee_id: ABJ, first_name: 'Awa', last_name: 'Kone', cnps_number: 'C1', nni: 'N1', job_title: 'Agent',
    mois_travailles: '12', salaire_brut_annuel: '2400000', cotis_sal_annuelle: '151200',
    cotis_pat_annuelle: '184800', its_annuel: '120000',
  }

  it('export CSV sans filiale : bulletins restreints au périmètre CI', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', cnps_number: 'CI-SIEGE', rccm: 'R', dgi_number: 'D' }] })
      .mockResolvedValueOnce({ rows: [RNS_ROW] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2025/export',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    const emps = sqlCalls().find(([sql]) => sql.includes('mois_travailles'))!
    expect(emps[0]).toContain('ps.legal_entity_id IS NULL OR EXISTS')
  })

  it('export CSV pour une filiale CI : en-tête au n° CNPS de la filiale', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', cnps_number: 'CI-SIEGE', rccm: 'R', dgi_number: 'D' }] })
      .mockResolvedValueOnce({ rows: [RNS_ROW] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/rns/2025/export?legalEntityId=${ABJ}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('N° CNPS Employeur : CI-ABJ-001')
    expect(res.body).toContain('Employeur : SOTRA Abidjan')
    const emps = sqlCalls().find(([sql]) => sql.includes('mois_travailles'))!
    expect(emps[1]).toEqual([expect.any(Array), ABJ])
  })

  it('export CSV / PDF pour une filiale Burkina → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ENTITY_BFA] })
    const csv = await app.inject({
      method: 'GET', url: `/cnps/rns/2025/export?legalEntityId=${BFA}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(csv.statusCode).toBe(400)
    queryMock.mockResolvedValueOnce({ rows: [ENTITY_BFA] })
    const pdf = await app.inject({
      method: 'GET', url: `/cnps/rns/2025/pdf?legalEntityId=${BFA}`,
      headers: authHeaders(app, 'admin'),
    })
    expect(pdf.statusCode).toBe(400)
    expect(JSON.parse(pdf.body).error).toContain('non prise en charge pour ce pays')
  })

  it('PDF pour une filiale CI : identité + n° CNPS de la filiale transmis au gabarit', async () => {
    const rnsPdf = await import('../../services/rns-pdf.js')
    vi.mocked(rnsPdf.generateRnsPdf).mockClear()
    queryMock
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', cnps_number: 'CI-SIEGE', city: 'Abidjan',
        cnps_affiliation_date: '01/01/2020', address: 'Abidjan, Côte d\'Ivoire' }] })
      .mockResolvedValueOnce({ rows: [{ first_name: 'Awa', last_name: 'KONE', cnps_number: 'C1',
        hire_date: '2020-01-01', exit_date: null, annual_salary: 2400000, months_worked: 12 }] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/rns/2025/pdf?legalEntityId=${ABJ}`,
      headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(200)
    const employer = vi.mocked(rnsPdf.generateRnsPdf).mock.calls[0]![0]
    expect(employer.cnpsNumber).toBe('CI-ABJ-001')
    expect(employer.name).toBe('SOTRA Abidjan')
    const emps = sqlCalls().find(([sql]) => sql.includes('months_worked'))!
    expect(emps[0]).toContain('e.legal_entity_id = $2')
    expect(emps[1]).toEqual([expect.any(Array), ABJ])
  })

  it('PDF sans filiale : filiales étrangères et leurs bulletins exclus', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', cnps_number: 'CI-SIEGE', city: 'Abidjan',
        cnps_affiliation_date: '01/01/2020', address: 'Abidjan, Côte d\'Ivoire' }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/cnps/rns/2025/pdf',
      headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
    const emps = sqlCalls().find(([sql]) => sql.includes('months_worked'))!
    expect(emps[0]).toContain('ps.legal_entity_id IS NULL OR EXISTS')
    expect(emps[0]).toContain("UPPER(le.legislation_pack_code) LIKE 'CIV-%'")
  })
})
