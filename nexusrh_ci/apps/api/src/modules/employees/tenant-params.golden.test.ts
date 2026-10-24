/**
 * GOLDEN — Paramétrage par tenant : champs personnalisés + règles par pays.
 *
 *   - PUT/GET /settings/employee-fields : config admin validée, lecture pour tous ;
 *   - POST/PATCH /employees : valeurs validées contre la config, fusion en
 *     modification, champs sensibles masqués aux managers ;
 *   - SMIG du pays de l'employé (filiale togolaise : 52 500, pas 75 000) ;
 *   - solde de tout compte : convention du tenant > pack du pays ; pays sans
 *     règles validées → postes non calculés signalés, jamais les règles CI.
 *
 * La base est simulée par un état en mémoire (dispatch par SQL) pour vérifier
 * l'aller-retour config → saisie → lecture.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  setTokenEpoch: vi.fn().mockResolvedValue(undefined),
  redisLockoutStore: {},
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../db/provisioning.js', () => ({ provisionTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: vi.fn().mockResolvedValue({ sent: true }),
  sendTestEmail: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@nexusrhci/shared/crypto', () => ({
  encrypt: (v: string) => `enc:${v}`,
  encryptIfPresent: (v: string | null | undefined) => (v ? `enc:${v}` : null),
  decryptIfPresent: (v: string | null | undefined) => (v?.startsWith('enc:') ? v.slice(4) : v ?? null),
}))
vi.mock('../../services/ai-credentials.service.js', () => ({
  maskKey: (k: string | null | undefined) => (k ? `••••${k.slice(-4)}` : null),
  isEncryptionAvailable: vi.fn(() => true),
}))
vi.mock('../../services/sourcing-config.service.js', () => ({ loadAiModels: vi.fn().mockResolvedValue([]) }))
vi.mock('../../services/integrations.service.js', () => ({ emitIntegrationEvent: vi.fn() }))
vi.mock('../../services/onboarding.service.js', () => ({ autoStartOnboarding: vi.fn().mockResolvedValue(null) }))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test', appUrl: 'http://localhost:3001',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk', model: 'm' }, mistral: { apiKey: 'sk', model: 'm' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'
import settingsRoutes from '../settings/settings.routes.js'
import offboardingRoutes from '../offboarding/offboarding.routes.js'

const SCHEMA = 'tenant_sotra'
const EMP = '66666666-6666-6666-6666-666666666666'
const TGO_ENTITY = '77777777-7777-7777-7777-777777777777'
const CASE_ID = '88888888-8888-8888-8888-888888888888'

const FIELDS = [
  { key: 'matricule', label: 'Matricule interne', type: 'text', required: true },
  { key: 'groupe_sanguin', label: 'Groupe sanguin', type: 'select', options: ['A+', 'O+'], sensitive: true },
]

// État simulé de la base.
let db: {
  tenant: { employee_custom_fields: unknown; termination_rules: unknown; default_country_code: string }
  employee: Record<string, unknown>
  offboardingCase: Record<string, unknown>
}

function fakeQuery(sql: unknown, params: unknown[] = []) {
  const q = String(sql)
  if (q.includes('UPDATE platform.tenants SET employee_custom_fields')) {
    db.tenant.employee_custom_fields = JSON.parse(params[0] as string)
    return { rows: [] }
  }
  if (q.includes('UPDATE platform.tenants SET termination_rules')) {
    db.tenant.termination_rules = params[0] === null ? null : JSON.parse(params[0] as string)
    return { rows: [{ id: 't1' }] }
  }
  if (q.includes('FROM platform.tenants')) {
    return { rows: [{ id: 't1', at_rate: '0.020', has_subsidiaries: true, ...db.tenant }] }
  }
  if (q.includes('.legal_entities')) {
    return params[0] === TGO_ENTITY
      ? { rows: [{ id: TGO_ENTITY, at_rate: '0.020', legislation_pack_code: 'TGO-2024', country_code: 'TGO' }] }
      : { rows: [] }
  }
  if (q.includes('.offboarding_cases o')) return { rows: [{ ...db.offboardingCase, ...db.employee }] }
  // 12 derniers bulletins au salaire de base (assiette de l'indemnité).
  if (q.includes('AVG(gross_salary)')) return { rows: [{ avg: String(db.offboardingCase.base_salary ?? '0'), n: '12' }] }
  if (q.startsWith('INSERT INTO') && q.includes('.employees')) {
    db.employee = { id: EMP, custom_fields: JSON.parse(params[26] as string), legal_entity_id: params[12] }
    return { rows: [db.employee] }
  }
  if (q.startsWith('SELECT base_salary, legal_entity_id, custom_fields')) return { rows: [db.employee] }
  if (q.startsWith('UPDATE') && q.includes('.employees SET')) {
    const set = q.match(/custom_fields = \$(\d+)::jsonb/)
    if (set) db.employee.custom_fields = JSON.parse(params[Number(set[1]) - 1] as string)
    return { rows: [db.employee] }
  }
  if (q.includes('FROM "tenant_sotra".employees e') && q.includes('WHERE e.id = $1')) {
    return { rows: [{ ...db.employee, email: 'x@sotra.ci' }] }
  }
  return { rows: [] }
}

function tokenFor(role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: role === 'manager' ? EMP : null,
  })
}
const auth = (role: string) => ({ authorization: `Bearer ${tokenFor(role)}` })

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.register(offboardingRoutes, { prefix: '/offboarding' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  db = {
    tenant: { employee_custom_fields: [], termination_rules: null, default_country_code: 'CIV' },
    employee: {},
    offboardingCase: {
      departure_type: 'licenciement', departure_date: '2026-10-01', notice_served: false,
      status: 'in_progress', base_salary: '300000', hire_date: '2019-10-01',
    },
  }
  queryMock.mockReset().mockImplementation(async (sql: unknown, params?: unknown[]) => fakeQuery(sql, params))
})

const basePayload = { firstName: 'Mariam', lastName: 'Touré', baseSalary: 250_000, hireDate: '2026-07-01' }

describe('Champs personnalisés — configuration', () => {
  it('admin définit les champs ; tout membre du tenant les lit', async () => {
    const put = await app.inject({ method: 'PUT', url: '/settings/employee-fields', headers: auth('admin'), payload: { fields: FIELDS } })
    expect(put.statusCode).toBe(200)
    const get = await app.inject({ method: 'GET', url: '/settings/employee-fields', headers: auth('employee') })
    expect(get.statusCode).toBe(200)
    expect(JSON.parse(get.body).data.map((f: { key: string }) => f.key)).toEqual(['matricule', 'groupe_sanguin'])
  })
  it('seul l\'admin configure (A01) et la config invalide est refusée (A03)', async () => {
    const rh = await app.inject({ method: 'PUT', url: '/settings/employee-fields', headers: auth('hr_manager'), payload: { fields: FIELDS } })
    expect(rh.statusCode).toBe(403)
    const bad = await app.inject({
      method: 'PUT', url: '/settings/employee-fields', headers: auth('admin'),
      payload: { fields: [{ key: '__proto__', label: 'X', type: 'text' }] },
    })
    expect(bad.statusCode).toBe(400)
    expect(db.tenant.employee_custom_fields).toEqual([])
  })
})

describe('Champs personnalisés — saisie et lecture du dossier', () => {
  beforeEach(() => { db.tenant.employee_custom_fields = FIELDS })

  it('création : valeurs validées puis persistées', async () => {
    const res = await app.inject({
      method: 'POST', url: '/employees', headers: auth('hr_manager'),
      payload: { ...basePayload, customFields: { matricule: ' M-042 ', groupe_sanguin: 'O+' } },
    })
    expect(res.statusCode).toBe(201)
    expect(db.employee.custom_fields).toEqual({ matricule: 'M-042', groupe_sanguin: 'O+' })
  })
  it('création : champ obligatoire manquant ou clé inconnue → 400 détaillé, rien n\'est écrit', async () => {
    const res = await app.inject({
      method: 'POST', url: '/employees', headers: auth('hr_manager'),
      payload: { ...basePayload, customFields: { inconnu: 'x' } },
    })
    expect(res.statusCode).toBe(400)
    const paths = JSON.parse(res.body).details.map((d: { path: string }) => d.path)
    expect(paths).toEqual(expect.arrayContaining(['customFields.inconnu', 'customFields.matricule']))
    expect(db.employee).toEqual({})
  })
  it('modification : fusion avec les valeurs existantes', async () => {
    db.employee = { id: EMP, base_salary: '250000', legal_entity_id: null, custom_fields: { matricule: 'M-042' } }
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`, headers: auth('hr_manager'),
      payload: { customFields: { groupe_sanguin: 'A+' } },
    })
    expect(res.statusCode).toBe(200)
    expect(db.employee.custom_fields).toEqual({ matricule: 'M-042', groupe_sanguin: 'A+' })
  })
  it('l\'employé ne peut pas écrire ses champs personnalisés (hors self-service)', async () => {
    db.employee = { id: EMP, custom_fields: { matricule: 'M-042' } }
    const token = app.jwt.sign({ sub: 'u-e', tenantId: 't1', schemaName: SCHEMA, role: 'employee',
      email: 'e@sotra.ci', firstName: 'E', lastName: 'E', employeeId: EMP })
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`, headers: { authorization: `Bearer ${token}` },
      payload: { customFields: { matricule: 'PIRATE' } },
    })
    expect(res.statusCode).toBe(400) // aucun champ autorisé restant
    expect(db.employee.custom_fields).toEqual({ matricule: 'M-042' })
  })
  it('lecture : champ sensible masqué au manager, visible pour la RH (A01)', async () => {
    db.employee = { id: EMP, manager_id: null, custom_fields: { matricule: 'M-042', groupe_sanguin: 'O+' } }
    const rh = await app.inject({ method: 'GET', url: `/employees/${EMP}`, headers: auth('hr_manager') })
    expect(JSON.parse(rh.body).data.custom_fields).toEqual({ matricule: 'M-042', groupe_sanguin: 'O+' })
    const ro = await app.inject({ method: 'GET', url: `/employees/${EMP}`, headers: auth('readonly') })
    expect(JSON.parse(ro.body).data.custom_fields).toEqual({ matricule: 'M-042' })
  })
})

describe('SMIG du pays de l\'employé', () => {
  it('filiale au Togo : 60 000 accepté (SMIG TGO 52 500), refusé en CI (SMIG 75 000)', async () => {
    const tgo = await app.inject({
      method: 'POST', url: '/employees', headers: auth('hr_manager'),
      payload: { ...basePayload, baseSalary: 60_000, legalEntityId: TGO_ENTITY },
    })
    expect(tgo.statusCode).toBe(201)
    const ci = await app.inject({
      method: 'POST', url: '/employees', headers: auth('hr_manager'),
      payload: { ...basePayload, baseSalary: 60_000 },
    })
    expect(ci.statusCode).toBe(422)
    expect(JSON.parse(ci.body).error).toBe('Le salaire ne peut pas être inférieur au SMIG (75 000 FCFA)')
  })
  it('modification : le SMIG suit la filiale déjà rattachée', async () => {
    db.employee = { id: EMP, base_salary: '50000', legal_entity_id: TGO_ENTITY, custom_fields: {} }
    const res = await app.inject({
      method: 'PATCH', url: `/employees/${EMP}`, headers: auth('hr_manager'), payload: { baseSalary: 30_000 },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toBe('Le salaire ne peut pas être inférieur au SMIG (52 500 FCFA)')
  })
})

describe('Solde de tout compte — règles du tenant / du pays', () => {
  const settle = () => app.inject({
    method: 'POST', url: `/offboarding/${CASE_ID}/settlement`, headers: auth('hr_manager'), payload: {},
  })

  it('employé CI : règles du pack CIV, devise et source tracées', async () => {
    db.employee = { legal_entity_id: null, professional_category: '4ème catégorie' }
    const body = JSON.parse((await settle()).body).data
    // Décret 96-200 : 7 ans d'ancienneté, payé au mois, catégorie 1 à 5 → 2 mois.
    expect(body).toMatchObject({ noticeMonths: 2, rulesSource: 'pack', legislationPackCode: 'CIV-2024', currency: 'XOF', warnings: [] })
    expect(body.indemnitePreavis).toBe(600_000)
  })
  it('employé CI cadre : 3 mois (6e catégorie et au-delà)', async () => {
    db.employee = { legal_entity_id: null, professional_category: 'Cadre (C1)' }
    const body = JSON.parse((await settle()).body).data
    expect(body).toMatchObject({ noticeMonths: 3, indemnitePreavis: 900_000, warnings: [] })
    expect(body.noticeCategory).toMatch(/6e catégorie/)
  })
  it('employé CI sans catégorie au dossier : barème par défaut + avertissement', async () => {
    db.employee = { legal_entity_id: null }
    const body = JSON.parse((await settle()).body).data
    expect(body.noticeMonths).toBe(2)
    expect(body.warnings.join(' ')).toMatch(/Catégorie professionnelle non renseignée/)
  })
  it('employé au Togo (pack sans règles validées) : postes non calculés + avertissements', async () => {
    db.employee = { legal_entity_id: TGO_ENTITY }
    const body = JSON.parse((await settle()).body).data
    expect(body.rulesSource).toBe('none')
    expect(body.indemnitePreavis).toBe(0)
    expect(body.indemniteLicenciement).toBe(0)
    expect(body.warnings).toHaveLength(2)
  })
  it('convention du tenant (admin) : prioritaire sur le pays', async () => {
    const rules = {
      noticeMonths: [{ upToSeniorityMonths: null, months: 4 }],
      severanceRates: [{ upToYear: null, rate: 0.5 }],
    }
    const put = await app.inject({ method: 'PUT', url: '/settings/termination-rules', headers: auth('admin'), payload: { rules } })
    expect(put.statusCode).toBe(200)
    db.employee = { legal_entity_id: TGO_ENTITY }
    const body = JSON.parse((await settle()).body).data
    expect(body).toMatchObject({ rulesSource: 'tenant', noticeMonths: 4, indemnitePreavis: 1_200_000 })
    expect(body.indemniteLicenciement).toBe(7 * 150_000)

    const get = await app.inject({ method: 'GET', url: '/settings/termination-rules', headers: auth('hr_manager') })
    expect(JSON.parse(get.body).data).toMatchObject({ source: 'tenant', tenantRules: rules })
  })
  it('convention invalide refusée (400) ; { rules: null } revient au pays', async () => {
    const bad = await app.inject({
      method: 'PUT', url: '/settings/termination-rules', headers: auth('admin'),
      payload: { rules: { noticeMonths: [{ upToSeniorityMonths: 12, months: 1 }], severanceRates: [] } },
    })
    expect(bad.statusCode).toBe(400)
    db.tenant.termination_rules = { noticeMonths: [{ upToSeniorityMonths: null, months: 4 }], severanceRates: [{ upToYear: null, rate: 0.5 }] }
    const reset = await app.inject({ method: 'PUT', url: '/settings/termination-rules', headers: auth('admin'), payload: { rules: null } })
    expect(reset.statusCode).toBe(200)
    expect(db.tenant.termination_rules).toBeNull()
  })
  it('préavis saisi au dossier : prime sur les règles', async () => {
    db.employee = { legal_entity_id: TGO_ENTITY }
    const res = await app.inject({
      method: 'POST', url: `/offboarding/${CASE_ID}/settlement`, headers: auth('hr_manager'), payload: { noticeMonths: 1 },
    })
    expect(JSON.parse(res.body).data).toMatchObject({ noticeMonths: 1, indemnitePreavis: 300_000 })
  })
})
