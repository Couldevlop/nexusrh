/**
 * Exports SAGE en multi-filiales : colonnes Societe / NumeroEmployeur ajoutées
 * EN FIN de ligne seulement pour un tenant multi-filiales (format historique
 * inchangé en mono-entité), filtre optionnel ?legalEntityId= (UUID validé).
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
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))

import authPlugin from '../../plugins/auth.js'
import sageRoutes from './sage.routes.js'
import { isMultiEntityTenant, sageColumnsFor, SAGE_COLUMNS } from './sage.service.js'

const SCHEMA = 'tenant_groupe'
const LE_A = '11111111-1111-4111-8111-111111111111'
const LE_B = '22222222-2222-4222-8222-222222222222'
const CFG = { id: 1, enabled: true, separator: 'semicolon', include_header: true, matricule_source: 'employee_number' }
const MULTI = { rows: [
  { id: LE_A, name: 'Groupe Abidjan', cnps_number: '1234567', has_subsidiaries: true },
  { id: LE_B, name: 'Groupe Dakar', cnps_number: 'SN-998', has_subsidiaries: true },
] }
const MONO = { rows: [{ id: LE_A, name: 'Entreprise unique', cnps_number: '1234567', has_subsidiaries: false }] }

function token(app: FastifyInstance, role = 'admin') {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@groupe.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}
const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token(app)}` } })
const dataCall = (needle: string) => queryMock.mock.calls.find((c) => String(c[0]).includes(needle))

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(sageRoutes, { prefix: '/sage' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('Règle multi-filiales (service pur)', () => {
  it('0 entité → mono ; 1 entité sans drapeau → mono ; 1 entité « à filiales » ou ≥ 2 → multi', () => {
    expect(isMultiEntityTenant(true, 0)).toBe(false)
    expect(isMultiEntityTenant(false, 1)).toBe(false)
    expect(isMultiEntityTenant(true, 1)).toBe(true)
    expect(isMultiEntityTenant(false, 2)).toBe(true)
  })
  it('colonnes filiale ajoutées EN FIN : positions historiques inchangées', () => {
    for (const kind of ['employees', 'variable_elements', 'payroll'] as const) {
      expect(sageColumnsFor(kind, false)).toEqual(SAGE_COLUMNS[kind])
      const multi = sageColumnsFor(kind, true)
      expect(multi.slice(0, SAGE_COLUMNS[kind].length)).toEqual(SAGE_COLUMNS[kind])
      expect(multi.slice(-2).map((c) => c.header)).toEqual(['Societe', 'NumeroEmployeur'])
    }
  })
})

describe('Colonne filiale présente / absente selon le tenant', () => {
  it('tenant multi-filiales : employés avec Societe + NumeroEmployeur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [CFG] })
      .mockResolvedValueOnce({ rows: [{ matricule: 'MAT00001', last_name: 'Kouassi', first_name: 'Jean', entity_name: 'Groupe Dakar', entity_employer_number: 'SN-998' }], rowCount: 1 })
      .mockResolvedValueOnce(MULTI)
    const res = await get('/sage/export/employees.csv')
    expect(res.statusCode).toBe(200)
    const [header, line] = res.body.replace(/^\uFEFF/, '').split('\r\n')
    expect(header?.endsWith(';IBAN;Societe;NumeroEmployeur')).toBe(true)
    expect(line?.startsWith('MAT00001;Kouassi;Jean')).toBe(true)
    expect(line?.endsWith(';Groupe Dakar;SN-998')).toBe(true)
    expect(String(dataCall('FROM "tenant_groupe".employees e')?.[0])).toContain('LEFT JOIN "tenant_groupe".legal_entities le ON le.id = e.legal_entity_id')
  })

  it('tenant mono-entité : format historique strict (aucune colonne en plus)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [CFG] })
      .mockResolvedValueOnce({ rows: [{ matricule: 'MAT00001', last_name: 'Kouassi', first_name: 'Jean', entity_name: 'Entreprise unique' }], rowCount: 1 })
      .mockResolvedValueOnce(MONO)
    const res = await get('/sage/export/employees.csv')
    const header = res.body.replace(/^\uFEFF/, '').split('\r\n')[0]
    expect(header).toBe(SAGE_COLUMNS.employees.map((c) => c.header).join(';'))
    expect(res.body).not.toContain('Entreprise unique')
  })

  it('paie multi-filiales : filiale du bulletin (repli sur le salarié) en fin de ligne', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [CFG] })
      .mockResolvedValueOnce({ rows: [{ matricule: 'MAT00002', month: '2026-09', net_payable: 210000, entity_name: 'Groupe Abidjan', entity_employer_number: '1234567' }], rowCount: 1 })
      .mockResolvedValueOnce(MULTI)
    const res = await get('/sage/export/payroll.csv?period=2026-09')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('CoutEmployeur;Societe;NumeroEmployeur')
    expect(res.body).toContain(';Groupe Abidjan;1234567')
    expect(String(dataCall('FROM "tenant_groupe".pay_slips ps')?.[0])).toContain('COALESCE(ps.legal_entity_id, e.legal_entity_id)')
  })

  it('éléments variables multi-filiales : filiale de la période (repli sur le salarié)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [CFG] })
      .mockResolvedValueOnce({ rows: [{ matricule: 'MAT00002', month: '2026-09', rule_code: 'PRIME', label: 'Prime', amount: 5000, entity_name: 'Groupe Dakar', entity_employer_number: 'SN-998' }], rowCount: 1 })
      .mockResolvedValueOnce(MULTI)
    const res = await get('/sage/export/variable-elements.csv?period=2026-09')
    expect(res.body).toContain('Montant;Societe;NumeroEmployeur')
    expect(res.body).toContain('MAT00002;2026-09;PRIME;Prime;5000;Groupe Dakar;SN-998')
    expect(String(dataCall('FROM "tenant_groupe".variable_elements ve')?.[0])).toContain('COALESCE(pp.legal_entity_id, e.legal_entity_id)')
  })

  it('lecture des filiales en échec → repli mono-entité (export non bloqué)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [CFG] })
      .mockResolvedValueOnce({ rows: [{ matricule: 'MAT00001' }], rowCount: 1 })
      .mockRejectedValueOnce(new Error('relation does not exist'))
    const res = await get('/sage/export/employees.csv')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('Societe')
  })
})

describe('Filtre filiale ?legalEntityId=', () => {
  it('UUID invalide → 400 avant toute requête (OWASP A03)', async () => {
    const res = await get('/sage/export/employees.csv?legalEntityId=1%20OR%201=1')
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('legalEntityId')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('UUID invalide sur la paie (période valide) → 400', async () => {
    const res = await get('/sage/export/payroll.csv?period=2026-09&legalEntityId=abc')
    expect(res.statusCode).toBe(400)
  })

  it('employés filtrés : paramètre lié (jamais interpolé)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [CFG] }).mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce(MULTI)
    const res = await get(`/sage/export/employees.csv?legalEntityId=${LE_B}`)
    expect(res.statusCode).toBe(200)
    const call = dataCall('FROM "tenant_groupe".employees e')
    expect(String(call?.[0])).toContain('AND e.legal_entity_id = $1::uuid')
    expect(String(call?.[0])).not.toContain(LE_B)
    expect(call?.[1]).toEqual([LE_B])
  })

  it('paie filtrée : période $1 + filiale $2', async () => {
    queryMock.mockResolvedValueOnce({ rows: [CFG] }).mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce(MULTI)
    await get(`/sage/export/payroll.csv?period=2026-09&legalEntityId=${LE_A}`)
    const call = dataCall('FROM "tenant_groupe".pay_slips ps')
    expect(String(call?.[0])).toContain('AND COALESCE(ps.legal_entity_id, e.legal_entity_id) = $2::uuid')
    expect(call?.[1]).toEqual(['2026-09', LE_A])
  })

  it('sans filtre : aucune clause filiale', async () => {
    queryMock.mockResolvedValueOnce({ rows: [CFG] }).mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce(MULTI)
    await get('/sage/export/variable-elements.csv?period=2026-09')
    const call = dataCall('FROM "tenant_groupe".variable_elements ve')
    expect(String(call?.[0])).not.toContain('::uuid')
    expect(call?.[1]).toEqual(['2026-09'])
  })
})

describe('GET /sage/legal-entities (sélecteur web)', () => {
  it('multi-filiales : liste des filiales', async () => {
    queryMock.mockResolvedValueOnce(MULTI)
    const res = await get('/sage/legal-entities')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual({
      multiEntity: true,
      entities: [
        { id: LE_A, name: 'Groupe Abidjan', cnps_number: '1234567' },
        { id: LE_B, name: 'Groupe Dakar', cnps_number: 'SN-998' },
      ],
    })
  })
  it('mono-entité : aucun sélecteur', async () => {
    queryMock.mockResolvedValueOnce(MONO)
    const res = await get('/sage/legal-entities')
    expect(JSON.parse(res.body).data).toEqual({ multiEntity: false, entities: [] })
  })
  it('hr_officer → 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/sage/legal-entities', headers: { authorization: `Bearer ${token(app, 'hr_officer')}` } })
    expect(res.statusCode).toBe(403)
  })
})