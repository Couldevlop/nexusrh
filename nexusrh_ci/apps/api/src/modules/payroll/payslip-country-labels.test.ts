/**
 * Recette multi-filiales (CI + Burkina + Bénin) — libellés pays des bulletins.
 *
 * Constat : la modale « Bulletin transparent » et la liste « Bulletins de paie »
 * affichaient « CNPS » / « ITS » en dur alors que les lignes du bulletin suivaient
 * le pack de la filiale (« CNSS Retraite salarié », « IUTS — … »).
 * La réponse transparency expose désormais les libellés du pack du bulletin, et
 * la liste les libellés courts par bulletin.
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
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import payrollRoutes from './payroll.routes.js'
import {
  payslipLabelsFromPack, shortCaisseLabel, shortImpotLabel,
} from '../../services/payslip-labels.service.js'
import { BEN_2024, BFA_2024, CIV_2024, SEN_2024 } from '../../services/legislation-packs.js'

const SCHEMA = 'tenant_groupe'
const SLIP_ID = '33333333-3333-3333-3333-333333333333'
const EMP = '11111111-1111-1111-1111-111111111111'
const LE_CIV = 'aaaaaaaa-0000-0000-0000-00000000000c'
const LE_BFA = 'aaaaaaaa-0000-0000-0000-00000000000b'
const LE_BEN = 'aaaaaaaa-0000-0000-0000-00000000000e'

const ENTITIES: Record<string, { id: string; at_rate: string; legislation_pack_code: string | null; country_code: string }> = {
  [LE_CIV]: { id: LE_CIV, at_rate: '0.02', legislation_pack_code: 'CIV-2024', country_code: 'CIV' },
  [LE_BFA]: { id: LE_BFA, at_rate: '0.035', legislation_pack_code: 'BFA-2024', country_code: 'BFA' },
  // Pack non renseigné : déduit du pays de la filiale.
  [LE_BEN]: { id: LE_BEN, at_rate: '0.02', legislation_pack_code: null, country_code: 'BEN' },
}

function token(app: FastifyInstance, role = 'admin') {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@groupe.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}

function slipRow() {
  return {
    id: SLIP_ID, employee_id: EMP, period_id: null, month: '2026-09',
    base_salary: '300000', gross_salary: '300000', net_payable: '260000',
    total_cnps_sal: '16500', total_cnps_pat: '48000', its: '23500',
    employer_cost: '348000', total_deductions: '40000', lines: [],
    first_name: 'Awa', last_name: 'Ouédraogo', cnps_number: 'BF-7700100', nni: null, job_title: 'Comptable',
    period_status: 'closed', initiated_at: null, closed_at: null,
    generated_at: null, viewed_by_employee_at: null,
    payment_status: 'pending', payment_method: 'wave', payment_reference: null, paid_at: null,
  }
}

/** Faux pg : tenant multi-filiales, bulletin rattaché à `slipEntity`. */
function route(opts: { hasSubsidiaries: boolean; slipEntity: string | null; listEntities?: Array<string | null> }) {
  queryMock.mockImplementation(async (sqlIn: unknown, paramsIn?: unknown) => {
    const q = String(sqlIn)
    const params = (paramsIn as unknown[] | undefined) ?? []
    if (q.includes('platform.tenants')) {
      return { rows: [{ id: 't1', at_rate: '0.02', has_subsidiaries: opts.hasSubsidiaries, default_country_code: 'CIV' }] }
    }
    if (q.includes('SELECT legal_entity_id FROM')) return { rows: [{ legal_entity_id: opts.slipEntity }] }
    if (q.includes('.legal_entities WHERE id = ANY')) {
      const ids = (params[0] as string[]) ?? []
      return { rows: ids.map(id => ENTITIES[id]).filter(Boolean) }
    }
    if (q.includes('period_status') && q.includes('WHERE ps.id = $1')) return { rows: [slipRow()] }
    if (q.includes('WHERE 1=1')) {
      return { rows: (opts.listEntities ?? []).map((le, i) => ({
        id: `s${i}`, month: '2026-09', employee_id: EMP, legal_entity_id: le,
        first_name: 'A', last_name: String(i), cnps_number: null,
        gross_salary: '300000', net_payable: '260000', its: '1000', total_cnps_sal: '1000',
      })) }
    }
    return { rows: [] }
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('libellés courts caisse / impôt', () => {
  it('abréviation de l\'impôt = partie avant « — »', () => {
    expect(shortImpotLabel('ITS — Impôt sur Traitements et Salaires')).toBe('ITS')
    expect(shortImpotLabel('IUTS — Impôt Unique sur Traitements et Salaires')).toBe('IUTS')
    expect(shortImpotLabel('PAYE — Pay As You Earn (PIT)')).toBe('PAYE')
    expect(shortImpotLabel('Imposto Profissional')).toBe('Imposto Profissional')
    expect(shortImpotLabel('')).toBe('ITS')
  })
  it('caisse courte = premier mot', () => {
    expect(shortCaisseLabel('IPRES + CSS')).toBe('IPRES')
    expect(shortCaisseLabel('CNPS Tchad')).toBe('CNPS')
    expect(shortCaisseLabel('PenCom / NHF')).toBe('PenCom')
    expect(shortCaisseLabel(null)).toBe('CNPS')
  })
  it('libellés par pack (CIV / BFA / BEN / SEN)', () => {
    expect(payslipLabelsFromPack(CIV_2024)).toMatchObject({ caisseShort: 'CNPS', impotShort: 'ITS', countryName: 'Côte d\'Ivoire' })
    expect(payslipLabelsFromPack(BFA_2024)).toMatchObject({ caisseShort: 'CNSS', impotShort: 'IUTS', countryName: 'Burkina Faso' })
    expect(payslipLabelsFromPack(BEN_2024)).toMatchObject({ caisseShort: 'CNSS', impotShort: 'ITS', countryName: 'Bénin' })
    expect(payslipLabelsFromPack(SEN_2024)).toMatchObject({ caisseShort: 'IPRES', impotShort: 'IR' })
  })
})

describe('GET /payroll/payslips/:id/transparency — libellés du pack du bulletin', () => {
  async function labelsOf() {
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${token(app)}` },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.body).labels
  }

  it('filiale Burkina → CNSS / IUTS / Burkina Faso', async () => {
    route({ hasSubsidiaries: true, slipEntity: LE_BFA })
    expect(await labelsOf()).toMatchObject({
      packCode: 'BFA-2024', countryCode: 'BFA', countryName: 'Burkina Faso',
      caisse: 'CNSS', caisseShort: 'CNSS', impotShort: 'IUTS',
    })
  })

  it('filiale Bénin sans pack explicite → pack déduit du pays (CNSS / ITS)', async () => {
    route({ hasSubsidiaries: true, slipEntity: LE_BEN })
    expect(await labelsOf()).toMatchObject({ packCode: 'BEN-2024', countryName: 'Bénin', caisseShort: 'CNSS', impotShort: 'ITS' })
  })

  it('filiale Côte d\'Ivoire → CNPS / ITS', async () => {
    route({ hasSubsidiaries: true, slipEntity: LE_CIV })
    expect(await labelsOf()).toMatchObject({ packCode: 'CIV-2024', caisseShort: 'CNPS', impotShort: 'ITS' })
  })

  it('bulletin sans filiale (tenant mono-entité CI) → pack du tenant', async () => {
    route({ hasSubsidiaries: false, slipEntity: null })
    expect(await labelsOf()).toMatchObject({ packCode: 'CIV-2024', countryName: 'Côte d\'Ivoire', caisseShort: 'CNPS' })
  })
})

describe('GET /payroll/payslips — libellés courts par bulletin', () => {
  it('chaque bulletin porte la caisse et l\'impôt de son pack', async () => {
    route({ hasSubsidiaries: true, slipEntity: null, listEntities: [LE_CIV, LE_BFA, LE_BEN, null] })
    const res = await app.inject({
      method: 'GET', url: '/payroll/payslips',
      headers: { authorization: `Bearer ${token(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const rows = JSON.parse(res.body).data as Array<{ caisse_short: string; impot_short: string; country_code: string }>
    expect(rows.map(r => [r.country_code, r.caisse_short, r.impot_short])).toEqual([
      ['CIV', 'CNPS', 'ITS'],
      ['BFA', 'CNSS', 'IUTS'],
      ['BEN', 'CNSS', 'ITS'],
      ['CIV', 'CNPS', 'ITS'],
    ])
  })
})
