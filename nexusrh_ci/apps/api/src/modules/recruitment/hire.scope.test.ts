/**
 * Embauche × périmètre filiale (habilitations) : une filiale cible ou une fiche
 * existante hors périmètre ne produit aucune écriture, et la réponse est celle
 * d'une candidature inconnue (pas de fuite d'existence inter-filiales).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock, state } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  state: { inScope: false, internalEmployee: null as string | null },
}))

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
    connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
    end: vi.fn(),
  })),
}))
vi.mock('../../config.js', () => ({
  config: { env: 'test', database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 } },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../utils/audit-log.js', () => ({ auditTenant: vi.fn() }))
vi.mock('../../services/integrations.service.js', () => ({ emitIntegrationEvent: vi.fn() }))
vi.mock('../../services/employee-tenant-context.service.js', () => ({
  loadEmployeeTenantContext: vi.fn().mockResolvedValue({
    legislation: { legislationPack: { smigMensuel: 75_000, currency: 'XOF' } },
    tenantTerminationRules: null,
    customFields: [],
  }),
}))

import { hireApplication, getHirePrefill, HireError } from './hire.service.js'

const SCHEMA = 'tenant_sotra'
const APP_ID = '11111111-1111-4111-8111-111111111111'
const ENTITY_A = 'aaaaaaaa-1111-4222-8333-444444444444'
const SCOPE = `e.legal_entity_id = '${ENTITY_A}'`
const ACTOR = { userId: '22222222-2222-4222-8222-222222222222', ip: '127.0.0.1', scopeSql: SCOPE }
const OTHER_EMP = '99999999-1111-4222-8333-444444444444'

const writes: string[] = []

beforeEach(() => {
  writes.length = 0
  state.inScope = false
  state.internalEmployee = null
  queryMock.mockReset()
  queryMock.mockImplementation(async (rawSql: string) => {
    const sql = String(rawSql).replace(/\s+/g, ' ')
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
    if (/^(INSERT|UPDATE)/.test(sql)) writes.push(sql)
    if (sql.includes('FROM "tenant_sotra".applications a LEFT JOIN')) {
      return { rows: [{
        id: APP_ID, first_name: 'Koffi', last_name: 'Yao', email: 'koffi@mail.ci', phone: null,
        internal_employee_id: state.internalEmployee, employee_id: null, offer_details: null,
        job_title: 'Comptable', job_department_id: null, job_legal_entity_id: ENTITY_A,
        job_contract_type: 'CDI', job_level: null,
      }] }
    }
    if (sql.startsWith('SELECT id, employee_number')) {
      return { rows: state.internalEmployee
        ? [{ id: state.internalEmployee, employee_number: null, job_title: null, job_level: null, department_id: null, hire_date: null, deleted_at: null }]
        : [] }
    }
    // Contrôle de périmètre (ligne virtuelle ou fiche existante)
    if (sql.includes(SCOPE)) return { rows: state.inScope ? [{ '?column?': 1 }] : [] }
    return { rows: [] }
  })
})

describe('hireApplication — périmètre filiale', () => {
  it('filiale cible hors périmètre : OUT_OF_SCOPE (404 générique), aucune écriture', async () => {
    const err = await hireApplication(SCHEMA, APP_ID, {}, ACTOR).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HireError)
    const he = err as HireError
    expect(he.code).toBe('OUT_OF_SCOPE')
    expect(he.statusCode).toBe(404)
    expect(he.message).toBe('Candidature introuvable')
    expect(writes).toEqual([])
  })

  it('fiche existante reliée hors périmètre : OUT_OF_SCOPE, aucune écriture', async () => {
    state.internalEmployee = OTHER_EMP
    const err = await hireApplication(SCHEMA, APP_ID, {}, ACTOR).catch((e: unknown) => e)
    expect((err as HireError).code).toBe('OUT_OF_SCOPE')
    expect(writes).toEqual([])
  })
})

describe('getHirePrefill — pas de fuite inter-filiales', () => {
  it('existingEmployeeId masqué quand la fiche est hors périmètre', async () => {
    state.internalEmployee = OTHER_EMP
    const p = await getHirePrefill(SCHEMA, APP_ID, SCOPE)
    expect(p?.existingEmployeeId).toBeNull()
  })

  it('existingEmployeeId conservé quand la fiche est dans le périmètre', async () => {
    state.internalEmployee = OTHER_EMP
    state.inScope = true
    const p = await getHirePrefill(SCHEMA, APP_ID, SCOPE)
    expect(p?.existingEmployeeId).toBe(OTHER_EMP)
  })

  it('périmètre ouvert : aucune requête de contrôle', async () => {
    state.internalEmployee = OTHER_EMP
    const p = await getHirePrefill(SCHEMA, APP_ID)
    expect(p?.existingEmployeeId).toBe(OTHER_EMP)
  })
})
