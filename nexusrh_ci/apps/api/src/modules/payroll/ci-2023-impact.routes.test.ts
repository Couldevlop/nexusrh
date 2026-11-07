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
    ai: { apiKey: '', model: 'test', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))

// ensureTenantSchema est mocké : la migration lazy (ALTER / UPDATE des
// libellés de rubriques, jamais pay_slips) n'est donc pas couverte par les
// assertions « aucune écriture » ci-dessous, qui portent sur les requêtes du
// rapport lui-même (décision M3 : migration lazy acceptée sur cette route).
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import ci2023ImpactRoutes, {
  computeSlipImpact, buildImpactReport, isCivSlip, slipAtRate, type ImpactSlipRow, type OpenPeriodOvertimeRow,
} from './ci-2023-impact.routes.js'

const TENANT = 'tenant_sotra'
const EMP_A = '11111111-1111-1111-1111-111111111111'
const EMP_B = '22222222-2222-2222-2222-222222222222'
const EMP_C = '33333333-3333-3333-3333-333333333333'

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'Test', lastName: 'User', employeeId: null,
  })
}

function slip(over: Partial<ImpactSlipRow>): ImpactSlipRow {
  return {
    id: 's', employee_id: EMP_A, month: '2023-01', gross_salary: '0', lines: [],
    legal_entity_id: null, first_name: 'Awa', last_name: 'Koné', employee_number: 'M001',
    marital_status: 'single', children_count: 0, cmu_spouse_covered: false, cmu_children_covered: null,
    le_pack_code: null, le_country_code: null, ...over,
  }
}

// Cadre à 2 000 000 F, ancien paramétrage (plafonds 1 647 315 / 70 000), marié 2 enfants.
const CADRE = slip({
  id: 's1', gross_salary: '2000000', marital_status: 'married', children_count: 2,
  lines: [
    { code: '2000', label: 'CNPS Retraite salarié (6,3%)', base: 1647315, amount: 103780 },
    { code: '3100', label: 'CNPS Prestations familiales', base: 70000, amount: 3500 },
    { code: '3300', label: 'CNPS Accidents du travail (2.00%)', base: 70000, amount: 1400 },
  ],
})
// Bas salaire, heures supp. de nuit (1500) : pas d'écart de plafond, CMU seule.
const BAS = slip({
  id: 's2', employee_id: EMP_B, month: '2023-02', gross_salary: 60000, first_name: 'Yao', last_name: 'Brou',
  employee_number: 'M002',
  lines: JSON.stringify([
    { code: '1500', label: 'Heures supplémentaires (+50%)', base: 0, amount: 5000 },
    { code: '2000', label: 'CNPS Retraite', base: 60000, amount: 3780 },
    { code: '3100', label: 'CNPS PF', base: 60000, amount: 3000 },
  ]),
})
// Filiale togolaise : exclue.
const TOGO = slip({ id: 's3', employee_id: EMP_C, legal_entity_id: 'le-tg', le_pack_code: 'TGO-2024', gross_salary: 5000000 })
// Déjà au nouveau paramétrage (bases 3 375 000 / 75 000, CMU 2200 présente) : aucun écart.
const NOUVEAU = slip({
  id: 's4', month: '2023-02', gross_salary: '4000000',
  lines: [
    { code: '2000', label: 'Retraite', base: 3375000, amount: 212625 },
    { code: '2200', label: 'CMU — part salarié', base: 0, amount: 500 },
    { code: '3100', label: 'PF', base: 75000, amount: 3750 },
  ],
})

// Éléments variables saisis sur des périodes OUVERTES (I2).
const OPEN_VE: OpenPeriodOvertimeRow[] = [
  { employee_id: EMP_B, month: '2026-11', period_status: 'open', rule_code: 'HEURES_SUPP_NUIT', amount: '12000',
    first_name: 'Yao', last_name: 'Brou', employee_number: 'M002', legal_entity_id: null, le_pack_code: null, le_country_code: null },
  { employee_id: EMP_A, month: '2026-11', period_status: 'sent_to_sites', rule_code: 'HEURES_SUPP_FERIE', amount: 8000,
    first_name: 'Awa', last_name: 'Koné', employee_number: 'M001', legal_entity_id: null, le_pack_code: null, le_country_code: null },
  // Filiale togolaise : hors périmètre
  { employee_id: EMP_C, month: '2026-11', period_status: 'open', rule_code: 'HEURES_SUPP_NUIT', amount: 5000,
    first_name: 'K', last_name: 'T', employee_number: 'M003', legal_entity_id: 'le-tg', le_pack_code: 'TGO-2024', le_country_code: null },
]

describe('ci-2023-impact — calcul pur', () => {
  it('cadre 2 000 000 : retraite, AT/PF et CMU estimée', () => {
    const r = computeSlipImpact(CADRE, 0.02)
    // base 2000 / 3100 = ancien plafond → assiette = brut : estimation majorante
    expect(r.retraiteEstimationMajorante).toBe(true)
    expect(r.atPfEstimationMajorante).toBe(true)
    // (2 000 000 − 1 647 315) = 352 685 × 6,3 % = 22 219,155 → 22 219 ; × 7,7 % = 27 156,745 → 27 156
    expect(r.retraiteSal).toBe(22_219)
    expect(r.retraitePat).toBe(27_156)
    // (75 000 − 70 000) × (5 % + 0,75 % + 2 %) = 387,5 → 387
    expect(r.atPfPat).toBe(387)
    // 3 bénéficiaires (salarié + 2 enfants ; conjoint non couvert par défaut) × 500
    expect(r.cmuSal).toBe(1_500)
    expect(r.cmuPat).toBe(1_500)
    expect(r.heuresSuppAVerifier).toBe(false)
  })

  it('bas salaire : aucun écart de plafond, CMU 500/500, heures supp. à vérifier', () => {
    const r = computeSlipImpact(BAS, 0.02)
    expect([r.retraiteSal, r.retraitePat, r.atPfPat]).toEqual([0, 0, 0])
    expect([r.cmuSal, r.cmuPat]).toEqual([500, 500])
    expect(r.heuresSuppAVerifier).toBe(true)
    expect(r.retraiteEstimationMajorante).toBe(false)
    expect(r.atPfEstimationMajorante).toBe(false)
  })

  it('bulletin déjà au nouveau paramétrage : écart nul', () => {
    const r = computeSlipImpact(NOUVEAU, 0.02)
    expect([r.retraiteSal, r.retraitePat, r.atPfPat, r.cmuSal, r.cmuPat]).toEqual([0, 0, 0, 0, 0])
  })

  it('sans ligne de base : le brut sert d’assiette (plafonnée au nouveau plafond)', () => {
    const r = computeSlipImpact(slip({ gross_salary: 5_000_000 }), 0.03)
    // (3 375 000 − 1 647 315) = 1 727 685 × 6,3 % = 108 844,155 → 108 844 ; × 7,7 % = 133 031,745 → 133 031
    expect(r.retraiteSal).toBe(108_844)
    expect(r.retraitePat).toBe(133_031)
    // 5 000 × (5 % + 0,75 % + 3 %) = 437,5 → 437
    expect(r.atPfPat).toBe(437)
  })

  it('CMU estimée UNE fois par salarié et par mois (deux bulletins clôturés le même mois)', () => {
    const second = { ...BAS, id: 's2b', lines: [] }
    const rep = buildImpactReport([BAS, second], 'CIV', 0.02)
    // 2 bulletins, mais une seule CMU (500 + 500) pour Yao en 2023-02
    expect(rep.totals.slips).toBe(2)
    expect(rep.totals.cmuSal).toBe(500)
    expect(rep.totals.cmuPat).toBe(500)
  })

  it('CMU déjà retenue sur un des bulletins du mois : aucune estimation pour ce mois', () => {
    const withCmu = { ...BAS, id: 's2c', lines: [{ code: '2200', label: 'CMU', base: 0, amount: 500 }] }
    const rep = buildImpactReport([BAS, withCmu], 'CIV', 0.02)
    expect(rep.totals.cmuSal).toBe(0)
  })

  it('CMU : +1 000 F par enfant au-delà du 6e, à la charge du salarié', () => {
    const r = computeSlipImpact(slip({ children_count: 8, gross_salary: 60000 }), 0.02)
    expect(r.cmuPat).toBe(3_500)        // 7 partagés × 500
    expect(r.cmuSal).toBe(5_500)        // 7 × 500 + 2 × 1 000
  })

  it('conjoint à vérifier : marié et situation du conjoint non renseignée', () => {
    const toVerify = slip({ id: 's9', employee_id: EMP_C, marital_status: 'married', cmu_spouse_covered: null, last_name: 'Zadi', first_name: 'Ama' })
    const rep = buildImpactReport([toVerify, CADRE], 'CIV', 0.02)
    expect(rep.cmuSpouseToVerify).toEqual([{ employeeId: EMP_C, employeeNumber: 'M001', name: 'Zadi Ama' }])
    expect(rep.byEmployeeMonth.find(r => r.employeeId === EMP_C)?.conjointAVerifier).toBe(true)
    expect(rep.byEmployeeMonth.find(r => r.employeeId === EMP_A)?.conjointAVerifier).toBe(false)
    // conjoint non compté tant qu'il n'est pas renseigné : salarié seul
    expect(rep.byEmployeeMonth.find(r => r.employeeId === EMP_C)?.cmuSal).toBe(500)
  })

  it('périodes ouvertes : HEURES_SUPP_NUIT / FERIE à revoir avant clôture, CIV seulement', () => {
    const rep = buildImpactReport([], 'CIV', 0.02, OPEN_VE)
    expect(rep.openPeriodOvertime).toEqual([
      { employeeId: EMP_B, employeeNumber: 'M002', name: 'Brou Yao', month: '2026-11', periodStatus: 'open',
        code: 'HEURES_SUPP_NUIT', amount: 12000, flag: 'à revoir avant clôture',
        meaning: 'heures de nuit, +75 % (décret n° 2024-898, art. 25)' },
      { employeeId: EMP_A, employeeNumber: 'M001', name: 'Koné Awa', month: '2026-11', periodStatus: 'sent_to_sites',
        code: 'HEURES_SUPP_FERIE', amount: 8000, flag: 'à revoir avant clôture',
        meaning: 'heures de nuit des dimanches et jours fériés, +100 % (décret n° 2024-898, art. 25)' },
    ])
  })

  it('taux AT : libellé, puis montant/base, puis taux tenant', () => {
    expect(slipAtRate([{ code: '3300', label: 'AT (4.00%)', base: 70000, amount: 2800 }], 0.02)).toBe(0.04)
    expect(slipAtRate([{ code: '3300', label: 'AT', base: 70000, amount: 2100 }], 0.02)).toBe(0.03)
    expect(slipAtRate([], 0.05)).toBe(0.05)
  })

  it('filtre CIV : pack explicite, pays de la filiale, pays du tenant', () => {
    expect(isCivSlip({ legal_entity_id: 'x', le_pack_code: 'CIV-2024', le_country_code: 'TGO' }, 'TGO')).toBe(true)
    expect(isCivSlip({ legal_entity_id: 'x', le_pack_code: 'TGO-2024', le_country_code: null }, 'CIV')).toBe(false)
    expect(isCivSlip({ legal_entity_id: 'x', le_pack_code: null, le_country_code: 'SEN' }, 'CIV')).toBe(false)
    expect(isCivSlip({ legal_entity_id: null, le_pack_code: null, le_country_code: null }, null)).toBe(true)
    expect(isCivSlip({ legal_entity_id: null, le_pack_code: null, le_country_code: null }, 'SEN')).toBe(false)
  })

  it('agrège par salarié et par mois, exclut les bulletins non CIV', () => {
    const rep = buildImpactReport([CADRE, BAS, TOGO, NOUVEAU], 'CIV', 0.02)
    expect(rep.slipsAnalyzed).toBe(3)
    expect(rep.slipsExcludedNonCiv).toBe(1)
    expect(rep.cmuNote).toBe('estimation (bénéficiaires actuels)')
    expect(rep.totals.retraiteSal).toBe(22_219)
    expect(rep.totals.cmuSal).toBe(2_000)
    expect(rep.totals.heuresSuppAVerifier).toBe(1)
    // 22 219 + 27 156 + 387 + 1 500 + 1 500 + 500 + 500
    expect(rep.totals.total).toBe(53_762)
    const a = rep.byEmployee.find(e => e.employeeId === EMP_A)
    expect(a?.slips).toBe(2)
    expect(a?.total).toBe(52_762)
    expect(rep.byMonth.map(m => [m.month, m.slips, m.total])).toEqual([['2023-01', 1, 52_762], ['2023-02', 2, 1_000]])
    expect(rep.byEmployeeMonth).toHaveLength(3)
  })
})

describe('GET /payroll/ci-2023-impact — route', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify()
    await app.register(authPlugin)
    await app.register(ci2023ImpactRoutes, { prefix: '/payroll' })
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    queryMock.mockReset()
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('platform.tenants')) return { rows: [{ default_country_code: 'CIV', at_rate: '0.020' }] }
      if (sql.includes('pay_slips')) return { rows: [CADRE, BAS, TOGO, NOUVEAU] }
      if (sql.includes('variable_elements')) return { rows: OPEN_VE }
      return { rows: [] }
    })
  })

  function sqls(): string[] {
    return queryMock.mock.calls.map(c => String(c[0]))
  }

  it.each(['hr_officer', 'manager', 'employee', 'readonly'])('403 pour %s, sans lecture des bulletins', async (role) => {
    const res = await app.inject({
      method: 'GET', url: '/payroll/ci-2023-impact', headers: { authorization: `Bearer ${tokenFor(app, role)}` },
    })
    expect(res.statusCode).toBe(403)
    expect(sqls().some(s => s.includes('pay_slips'))).toBe(false)
  })

  it('401 sans jeton', async () => {
    const res = await app.inject({ method: 'GET', url: '/payroll/ci-2023-impact' })
    expect(res.statusCode).toBe(401)
  })

  it.each(['admin', 'hr_manager'])('200 JSON pour %s, lecture seule, schéma du jeton, clôturés depuis 2023-01', async (role) => {
    const res = await app.inject({
      method: 'GET', url: '/payroll/ci-2023-impact', headers: { authorization: `Bearer ${tokenFor(app, role)}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { totals: { total: number }; slipsAnalyzed: number } }
    expect(body.data.slipsAnalyzed).toBe(3)
    expect(body.data.totals.total).toBe(53_762)
    const all = sqls()
    expect(all.some(s => /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i.test(s))).toBe(false)
    const slipSql = all.find(s => s.includes('pay_slips')) ?? ''
    expect(slipSql).toContain(`"${TENANT}".pay_slips`)
    expect(slipSql).toContain("pp.status = 'closed'")
    const slipCall = queryMock.mock.calls.find(c => String(c[0]).includes('pay_slips'))
    expect(slipCall?.[1]).toEqual(['2023-01'])
    const veSql = all.find(s => s.includes('variable_elements')) ?? ''
    expect(veSql).toContain(`"${TENANT}".variable_elements`)
    expect(veSql).toContain("pp.status <> 'closed'")
    expect(veSql).toContain("'HEURES_SUPP_NUIT'")
    expect(veSql).toContain("'HEURES_SUPP_FERIE'")
    expect((res.json() as { data: { openPeriodOvertime: unknown[] } }).data.openPeriodOvertime).toHaveLength(2)
  })

  it('export CSV avec BOM, en-tête et ligne TOTAL', async () => {
    const res = await app.inject({
      method: 'GET', url: '/payroll/ci-2023-impact?format=csv', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('impact_paie_ci_2023.csv')
    expect(res.body.startsWith('﻿')).toBe(true)
    const rows = res.body.slice(1).split('\r\n')
    expect(rows[0]).toContain('retraite_non_cotisee_salarie')
    expect(rows[0]).toContain('estimation (bénéficiaires actuels)')
    expect(rows[0]).toContain('retraite_estimation;')
    expect(rows[0]).toContain('conjoint_a_verifier')
    // Koné 2023-01 : bases à l'ancien plafond → estimation majorante
    expect(rows.find(r => r.startsWith('2023-01;M001;'))).toBe('2023-01;M001;Koné Awa;1;22219;27156;estimation majorante;387;estimation majorante;1500;1500;non;0;52762')
    expect(rows[1]).toBe('2023-02;M002;Brou Yao;1;0;0;;0;;500;500;non;1;1000')
    expect(rows[4]).toBe('TOTAL;;;3;22219;27156;;387;;2000;2000;0;1;53762')
    // Section périodes ouvertes (I2)
    expect(rows[5]).toBe('')
    expect(rows[6]).toBe('periodes_ouvertes;matricule;salarie;code;montant;statut_periode;alerte;sens_depuis_decret_2024_898')
    expect(rows[7]).toBe('2026-11;M002;Brou Yao;HEURES_SUPP_NUIT;12000;open;à revoir avant clôture;heures de nuit, +75 % (décret n° 2024-898, art. 25)')
    expect(rows).toHaveLength(9)
    expect(sqls().some(s => /\b(INSERT|UPDATE|DELETE)\b/i.test(s))).toBe(false)
  })

  it('400 sur format inconnu', async () => {
    const res = await app.inject({
      method: 'GET', url: '/payroll/ci-2023-impact?format=xlsx', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('500 générique si la base échoue', async () => {
    queryMock.mockImplementation(async () => { throw new Error('boom') })
    const res = await app.inject({
      method: 'GET', url: '/payroll/ci-2023-impact', headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('boom')
  })
})
