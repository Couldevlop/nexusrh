/**
 * Multi-filiales — trois anomalies corrigées :
 *  1. Export NEVA : n° CNPS employeur + raison sociale de la FILIALE (plus du
 *     tenant), filiale obligatoire en multi-filiales, refus hors CI, déclaration
 *     rattachée à la filiale demandée ;
 *  2. DISA : une ligne par (année, filiale) — ON CONFLICT (year, legal_entity_id),
 *     export / liste scopés filiale, pas de repli qui écraserait une autre filiale ;
 *  3. Audit de conformité : SMIG du pack du salarié (salaire de base ramené au
 *     temps plein) au lieu de 75 000 en dur, filtre ?legalEntityId, ventilation
 *     par filiale, contrôles CNPS réservés au périmètre ivoirien.
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
const DECL = '99999999-9999-4999-8999-999999999999'
const ABJ = '11111111-1111-4111-8111-111111111111'
const BKE = '33333333-3333-4333-8333-333333333333'
const BFA = '22222222-2222-4222-8222-222222222222'

const ENTITY_ABJ = {
  id: ABJ, name: 'SOTRA Abidjan', cnps_number: 'CI-ABJ-001', dgi_number: 'DGI-ABJ', rccm: 'RCCM-ABJ',
  city: 'Abidjan', address: 'Plateau', country_code: 'CIV', legislation_pack_code: 'CIV-2024', at_rate: '0.0200', is_active: true,
}
const ENTITY_BKE = {
  id: BKE, name: 'SOTRA Bouaké', cnps_number: 'CI-BKE-002', dgi_number: 'DGI-BKE', rccm: 'RCCM-BKE',
  city: 'Bouaké', address: null, country_code: 'CIV', legislation_pack_code: null, at_rate: '0.0200', is_active: true,
}
const ENTITY_BFA = {
  id: BFA, name: 'SOTRA Burkina', cnps_number: '', dgi_number: 'DGI-BF', rccm: 'RCCM-BF',
  city: 'Ouagadougou', address: null, country_code: 'BFA', legislation_pack_code: 'BFA-2024', at_rate: '0.0350', is_active: true,
}
const MULTI_TENANT = {
  name: 'SOTRA Groupe', cnps_number: 'CI-SIEGE', dgi_number: 'DGI-SIEGE', rccm: 'RCCM-SIEGE',
  slug: 'sotra', at_rate: '0.020', has_subsidiaries: true, default_country_code: 'CIV',
}

const DECL_ROW = {
  year: 2025, quarter: 2,
  data: [{ nni: 'NNI-1', last_name: 'Koné', first_name: 'Awa', cnps_number: 'C-1',
           gross_salary: '300000', total_cnps_sal: '18900', total_cnps_pat: '23100' }],
  total_cotisations_salariales: '18900', total_cotisations_patronales: '23100',
  total_cotisations: '42000', masse_salariale: '300000', employees_count: 1,
}

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
  queryMock.mockResolvedValue({ rows: [] })
})

// ───────────────────────────────────────────────────────────────────────────
// 1. NEVA
// ───────────────────────────────────────────────────────────────────────────
describe('GET /cnps/declarations/:id/neva — filiale', () => {
  it('multi-filiales sans legalEntityId → 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...DECL_ROW, legal_entity_id: ABJ }] })
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${DECL}/neva`, headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('legalEntityId requis')
  })

  it('filiale CI : raison sociale + n° CNPS employeur de la filiale (pas du tenant)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...DECL_ROW, legal_entity_id: ABJ }] })
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${DECL}/neva?legalEntityId=${ABJ}`, headers: authHeaders(app, 'hr_manager'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<N_CNPS_EMPLOYEUR>CI-ABJ-001</N_CNPS_EMPLOYEUR>')
    expect(res.body).toContain('<RAISON_SOCIALE>SOTRA Abidjan</RAISON_SOCIALE>')
    expect(res.body).not.toContain('CI-SIEGE')
    const audit = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(JSON.parse(audit?.[1]?.[4] as string).legalEntityId).toBe(ABJ)
  })

  it('déclaration générée pour une autre filiale → 409', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...DECL_ROW, legal_entity_id: BKE }] })
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${DECL}/neva?legalEntityId=${ABJ}`, headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('SOTRA Abidjan')
  })

  it('filiale hors CI (Burkina) → 400, même message que les autres déclarations', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...DECL_ROW, legal_entity_id: BFA }] })
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_BFA] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${DECL}/neva?legalEntityId=${BFA}`, headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('ne relève pas de la CNPS Côte d\'Ivoire')
  })

  it('legalEntityId non-UUID → 400', async () => {
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${DECL}/neva?legalEntityId=abc`, headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
  })

  it('mono-entité : inchangé, n° CNPS du tenant', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...DECL_ROW, legal_entity_id: null }] })
      .mockResolvedValueOnce({ rows: [{ name: 'Cabinet', cnps_number: 'CI-TENANT', slug: 'cab', has_subsidiaries: false }] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations/${DECL}/neva`, headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<N_CNPS_EMPLOYEUR>CI-TENANT</N_CNPS_EMPLOYEUR>')
    // Aucune lecture de filiale
    expect(sqlCalls().some(([sql]) => sql.includes('legal_entities'))).toBe(false)
  })
})

describe('GET /cnps/declarations — filtre filiale', () => {
  it('?legalEntityId filtre la liste sur la filiale', async () => {
    const res = await app.inject({
      method: 'GET', url: `/cnps/declarations?year=2025&legalEntityId=${ABJ}`, headers: authHeaders(app, 'readonly'),
    })
    expect(res.statusCode).toBe(200)
    const [sql, params] = sqlCalls()[0]!
    expect(sql).toContain('legal_entity_id = $2')
    expect(params).toEqual([2025, ABJ])
  })

  it('legalEntityId invalide → 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/cnps/declarations?legalEntityId=nope', headers: authHeaders(app, 'readonly'),
    })
    expect(res.statusCode).toBe(400)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. DISA
// ───────────────────────────────────────────────────────────────────────────
const DISA_EMP = {
  employee_id: 'e1', first_name: 'Awa', last_name: 'Koné', cnps_number: 'C', nni: 'N', job_title: 'Dev',
  total_sal: '3600000', total_cnps_sal: '226800', total_its: '120000',
}

describe('POST /cnps/disa/generate — une DISA par (année, filiale)', () => {
  it('upsert sur (year, legal_entity_id) avec la filiale en paramètre', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
      .mockResolvedValueOnce({ rows: [DISA_EMP] })
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate', headers: authHeaders(app, 'admin'),
      payload: { year: 2025, legalEntityId: ABJ },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.legalEntityId).toBe(ABJ)
    const insert = sqlCalls().find(([sql]) => sql.includes('INSERT INTO') && sql.includes('disa_records'))!
    expect(insert[0]).toContain('ON CONFLICT (year, legal_entity_id)')
    expect(insert[0]).not.toMatch(/ON CONFLICT \(year\)/)
    expect(insert[1]).toContain(ABJ)
  })

  it('multi-filiales : échec de l’upsert → 500 SANS repli ON CONFLICT (year) (qui écraserait une autre filiale)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
      .mockResolvedValueOnce({ rows: [DISA_EMP] })
      .mockRejectedValueOnce(new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification'))
    const res = await app.inject({
      method: 'POST', url: '/cnps/disa/generate', headers: authHeaders(app, 'admin'),
      payload: { year: 2025, legalEntityId: ABJ },
    })
    expect(res.statusCode).toBe(500)
    const inserts = sqlCalls().filter(([sql]) => sql.includes('INSERT INTO') && sql.includes('disa_records'))
    expect(inserts).toHaveLength(1)
  })
})

describe('GET /cnps/disa/:year/export — filiale', () => {
  const DISA_ROW = {
    data: [DISA_EMP], year: 2025, employees_count: 1,
    masse_salariale: '3600000', total_cnps: '226800', total_its: '120000',
  }

  it('multi-filiales sans legalEntityId → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [MULTI_TENANT] })
    const res = await app.inject({ method: 'GET', url: '/cnps/disa/2025/export', headers: authHeaders(app, 'admin') })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('legalEntityId requis')
  })

  it('filiale CI : en-tête de la filiale + DISA de cette filiale uniquement', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
      .mockResolvedValueOnce({ rows: [DISA_ROW] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/disa/2025/export?legalEntityId=${ABJ}`, headers: authHeaders(app, 'hr_officer'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Employeur : SOTRA Abidjan')
    expect(res.body).toContain('N° CNPS Employeur : CI-ABJ-001')
    expect(res.body).toContain('N° DGI : DGI-ABJ')
    const disaSel = sqlCalls().find(([sql]) => sql.includes('FROM "tenant_sotra".disa_records'))!
    expect(disaSel[0]).toContain('legal_entity_id = $2')
    expect(disaSel[1]).toEqual([2025, ABJ])
  })

  it('DISA non générée pour la filiale → 404 nommant la filiale', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_BKE] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/disa/2025/export?legalEntityId=${BKE}`, headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('SOTRA Bouaké')
  })

  it('filiale hors CI → 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_BFA] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/disa/2025/export?legalEntityId=${BFA}`, headers: authHeaders(app, 'admin'),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /cnps/disa — liste par filiale', () => {
  it('multi-filiales sans filiale → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
    const res = await app.inject({ method: 'GET', url: '/cnps/disa', headers: authHeaders(app, 'readonly') })
    expect(res.statusCode).toBe(400)
  })

  it('filiale CI → DISA de cette filiale', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
      .mockResolvedValueOnce({ rows: [{ year: 2025, legal_entity_id: ABJ }] })
    const res = await app.inject({ method: 'GET', url: `/cnps/disa?legalEntityId=${ABJ}`, headers: authHeaders(app, 'readonly') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
    const list = sqlCalls().find(([sql]) => sql.includes('disa_records'))!
    expect(list[0]).toContain('legal_entity_id = $1')
    expect(list[1]).toEqual([ABJ])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. Audit de conformité
// ───────────────────────────────────────────────────────────────────────────
function emp(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'e', first_name: 'A', last_name: 'B', job_title: 'Agent', nni: 'N', cnps_number: 'C',
    hire_date: '2020-01-01', exit_date: null, mobile_money_provider: 'wave', mobile_money_phone: '+2250700000000',
    contract_type: 'cdi', department_name: 'Ops', legal_entity_id: null, weekly_hours: '40',
    net_payable: '200000', gross_salary: '250000', base_salary: '250000', mois_ref: '2099-01',
    ...over,
  }
}
const COTIS = { masse: '0', cnps_sal: '0', cnps_pat: '0', its: '0', net: '0', nb: '0', nb_plaf_retraite: '0', nb_plaf_atpf: '0' }
// Année future : aucune déclaration encore exigible (pas d'anomalie DECL_*).
const FUTURE = new Date().getFullYear() + 2

describe('GET /cnps/audit-conformite — SMIG du pack et périmètre filiale', () => {
  it('mono-entité CI : salaire de base ramené au temps plein (20 h → ×2) comparé au SMIG 75 000', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Cab', cnps_number: 'C', dgi_number: 'D', rccm: 'R', at_rate: '0.020', has_subsidiaries: false, default_country_code: 'CIV' }] })
      .mockResolvedValueOnce({ rows: [
        emp({ id: 'ok', first_name: 'Mi', last_name: 'Temps', base_salary: '40000', weekly_hours: '20' }),   // 80 000 TP
        emp({ id: 'ko', first_name: 'Sous', last_name: 'Smig', base_salary: '30000', weekly_hours: '20' }),  // 60 000 TP
      ] })
      .mockResolvedValueOnce({ rows: [] })        // déclarations
      .mockResolvedValueOnce({ rows: [COTIS] })   // cotisations
      .mockResolvedValueOnce({ rows: [] })        // mensuel
      .mockResolvedValueOnce({ rows: [] })        // mobile
    const res = await app.inject({ method: 'GET', url: `/cnps/audit-conformite?year=${FUTURE}`, headers: authHeaders(app, 'admin') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.smigReference).toBe(75_000)
    expect(body.legislationPackCode).toBe('CIV-2024')
    const smig = body.anomalies.filter((a: { code: string }) => a.code === 'BELOW_SMIG')
    expect(smig).toHaveLength(1)
    expect(smig[0].employeeId).toBe('ko')
    expect(smig[0].message).toContain('soit 60 000 à temps plein')
    expect(body.resume.nbSousSmig).toBe(1)
    expect(body.filiales).toBeUndefined()
    // Mono-entité : aucune lecture de filiale, pas de filtre filiale
    expect(sqlCalls().some(([sql]) => sql.includes('legal_entities'))).toBe(false)
  })

  it('mono-entité d’un autre pays (Bénin) : SMIG 52 000 du pack, contrôles CNPS CI non appliqués', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Bénin SA', cnps_number: '', dgi_number: 'D', rccm: 'R', at_rate: '0.020', has_subsidiaries: false, default_country_code: 'BEN' }] })
      .mockResolvedValueOnce({ rows: [emp({ id: 'b1', base_salary: '60000', nni: '', cnps_number: '' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [COTIS] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: `/cnps/audit-conformite?year=${FUTURE}`, headers: authHeaders(app, 'admin') })
    const body = JSON.parse(res.body)
    expect(body.smigReference).toBe(52_000)
    expect(body.cnpsApplicable).toBe(false)
    const codes = body.anomalies.map((a: { code: string }) => a.code)
    expect(codes).not.toContain('BELOW_SMIG')       // 60 000 ≥ 52 000 (aurait été < 75 000)
    expect(codes).not.toContain('EMP_NO_CNPS')
    expect(codes).not.toContain('EMP_CNPS_MISSING')
    expect(body.plafonds).toBeNull()
  })

  it('?legalEntityId (filiale Burkina) : requêtes scopées, SMIG 45 000, pas de contrôle CNPS', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ, ENTITY_BFA] })  // filiales
      .mockResolvedValueOnce({ rows: [emp({ id: 'bf', legal_entity_id: BFA, base_salary: '50000', nni: '', cnps_number: '' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [COTIS] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/cnps/audit-conformite?year=${FUTURE}&legalEntityId=${BFA}`, headers: authHeaders(app, 'hr_manager'),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.legalEntityId).toBe(BFA)
    expect(body.legalEntityName).toBe('SOTRA Burkina')
    expect(body.smigReference).toBe(45_000)
    expect(body.cnpsApplicable).toBe(false)
    const codes = body.anomalies.map((a: { code: string }) => a.code)
    expect(codes).not.toContain('BELOW_SMIG')
    expect(codes).not.toContain('EMP_NO_NNI')
    expect(codes).not.toContain('EMP_CNPS_MISSING') // n° CNPS vide mais filiale hors CI
    expect(body.declarations).toEqual([])
    // Employés, déclarations, cotisations, mensuel, Mobile Money : tous filtrés sur la filiale
    const calls = sqlCalls()
    const empsSql = calls.find(([sql]) => sql.includes('LEFT JOIN LATERAL'))!
    expect(empsSql[0]).toContain('e.legal_entity_id = $2')
    expect(empsSql[1]).toEqual([expect.any(Array), BFA])
    const decl = calls.find(([sql]) => sql.includes('cnps_declarations'))!
    expect(decl[1]).toEqual([FUTURE, BFA])
    const cotis = calls.find(([sql]) => sql.includes('nb_plaf_retraite'))!
    expect(cotis[0]).toContain('ps.legal_entity_id = $4')
    expect(cotis[1]![3]).toBe(BFA)
    const mobile = calls.find(([sql]) => sql.includes('mobile_money_provider') && sql.includes('GROUP BY'))!
    expect(mobile[1]).toEqual([BFA])
  })

  it('vue tenant multi-filiales : ventilation par filiale, CNPS réservé aux filiales CI', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ, ENTITY_BFA] })
      .mockResolvedValueOnce({ rows: [
        emp({ id: 'ci', first_name: 'Awa', last_name: 'Koné', legal_entity_id: ABJ, base_salary: '50000', cnps_number: '' }),
        emp({ id: 'bf', first_name: 'Issa', last_name: 'Ouédraogo', legal_entity_id: BFA, base_salary: '50000', cnps_number: '' }),
      ] })
      .mockResolvedValueOnce({ rows: [] })        // déclarations
      .mockResolvedValueOnce({ rows: [COTIS] })   // cotisations (périmètre CI)
      .mockResolvedValueOnce({ rows: [] })        // mensuel
      .mockResolvedValueOnce({ rows: [] })        // mobile
      .mockResolvedValueOnce({ rows: [            // agrégats par filiale
        { legal_entity_id: ABJ, nb: '12', masse: '600000', cnps_sal: '37800', cnps_pat: '46200', its: '0' },
        { legal_entity_id: BFA, nb: '12', masse: '600000', cnps_sal: '33000', cnps_pat: '96000', its: '0' },
      ] })
    const res = await app.inject({ method: 'GET', url: `/cnps/audit-conformite?year=${FUTURE}`, headers: authHeaders(app, 'admin') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    const belowSmig = body.anomalies.filter((a: { code: string }) => a.code === 'BELOW_SMIG')
    expect(belowSmig.map((a: { employeeId: string }) => a.employeeId)).toEqual(['ci']) // 50 000 < 75 000 ; ≥ 45 000 au Burkina
    const noCnps = body.anomalies.filter((a: { code: string }) => a.code === 'EMP_NO_CNPS')
    expect(noCnps.map((a: { employeeId: string }) => a.employeeId)).toEqual(['ci'])
    // N° CNPS employeur manquant (vide) sur la filiale Burkina : hors périmètre CNPS CI
    expect(body.anomalies.some((a: { code: string; message: string }) =>
      a.code === 'EMP_CNPS_MISSING' && a.message.includes('Burkina'))).toBe(false)

    expect(body.filiales).toHaveLength(2)
    const abj = body.filiales.find((f: { legalEntityId: string }) => f.legalEntityId === ABJ)
    const bfa = body.filiales.find((f: { legalEntityId: string }) => f.legalEntityId === BFA)
    expect(abj).toMatchObject({ cnpsApplicable: true, smigReference: 75_000, nbSousSmig: 1, nbSansCnps: 1, masseSalariale: 600000, totalEmployes: 1 })
    expect(bfa).toMatchObject({ cnpsApplicable: false, smigReference: 45_000, nbSousSmig: 0, nbSansCnps: 0, legislationPackCode: 'BFA-2024' })
    expect(abj.bloquants).toBeGreaterThanOrEqual(2)
    expect(bfa.bloquants).toBe(0)
    // Déclarations attendues pour la seule filiale CI (4 trimestres)
    expect(body.declarations).toHaveLength(4)
    expect(body.declarations.every((d: { legalEntityName: string }) => d.legalEntityName === 'SOTRA Abidjan')).toBe(true)
    // Agrégats de cotisations restreints au périmètre CNPS CI (pas de somme Burkina + CI)
    const cotis = sqlCalls().find(([sql]) => sql.includes('nb_plaf_retraite'))!
    expect(cotis[0]).toContain('legal_entities pse')
  })

  it('déclarations manquantes signalées par filiale CI (année passée)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ, ENTITY_BKE, ENTITY_BFA] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [1, 2, 3, 4].map((q) => ({ quarter: q, status: 'submitted', total_cotisations: '1', employees_count: 1, legal_entity_id: ABJ })) })
      .mockResolvedValueOnce({ rows: [COTIS] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/cnps/audit-conformite?year=2020', headers: authHeaders(app, 'admin') })
    const body = JSON.parse(res.body)
    const missing = body.anomalies.filter((a: { code: string }) => a.code === 'DECL_MISSING')
    // Abidjan a tout soumis ; Bouaké n'a rien (4 manquantes) ; Burkina hors CNPS CI
    expect(missing).toHaveLength(4)
    expect(missing.every((a: { message: string; legalEntityId: string }) => a.message.includes('SOTRA Bouaké') && a.legalEntityId === BKE)).toBe(true)
    expect(body.kpis.declarationsSoumises).toBe(4)
  })

  it('filiale inconnue → 404 ; legalEntityId invalide → 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [MULTI_TENANT] })
      .mockResolvedValueOnce({ rows: [ENTITY_ABJ] })
    const res404 = await app.inject({
      method: 'GET', url: `/cnps/audit-conformite?legalEntityId=${BKE}`, headers: authHeaders(app, 'admin'),
    })
    expect(res404.statusCode).toBe(404)
    const res400 = await app.inject({
      method: 'GET', url: '/cnps/audit-conformite?legalEntityId=xyz', headers: authHeaders(app, 'admin'),
    })
    expect(res400.statusCode).toBe(400)
  })

  it('erreur SQL → 500 générique', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection reset'))
    const res = await app.inject({ method: 'GET', url: '/cnps/audit-conformite', headers: authHeaders(app, 'admin') })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('connection reset')
  })
})
