/**
 * Embauche → fiche employé + parcours d'intégration.
 *
 * La base est simulée par un petit routeur SQL (et non une séquence de mocks) :
 * chaque test décrit l'ÉTAT du tenant (candidature, fiches, modèles, parcours)
 * et vérifie les ÉCRITURES produites — exactement une fiche, jamais de doublon.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeState {
  application: Record<string, unknown> | null
  employees: Array<{ id: string; email: string | null; deleted_at: string | null; employee_number: string | null }>
  templates: Array<{ id: string; name: string; seniority: string; job_keywords: string | null; department_id: string | null; is_active: boolean; is_default: boolean; steps: number }>
  journeys: Array<{ id: string; employee_id: string; application_id: string | null; status: string; template_name: string | null }>
  builtinExists: boolean
  inserts: { employees: unknown[][]; journeys: unknown[][]; builtin: number; steps: number }
  appUpdates: unknown[][]
  documents: Array<{ id: string; employee_id: string; bytes: string; params: unknown[] }>
}

const { state, queryMock, auditMock, emitMock } = vi.hoisted(() => {
  const state = {} as FakeState
  const auditMock = vi.fn()
  const emitMock = vi.fn()
  const flat = (sql: string) => sql.replace(/\s+/g, ' ')
  const queryMock = vi.fn(async (rawSql: string, params: unknown[] = []) => {
    const sql = flat(String(rawSql))
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
    if (sql.includes('FROM "tenant_sotra".applications a LEFT JOIN')) {
      return { rows: state.application ? [state.application] : [] }
    }
    if (sql.startsWith('SELECT id, employee_number')) {
      const v = String(params[0])
      const rows = state.employees.filter((e) => {
        if (sql.includes('lower(email) = $1')) {
          const emailOk = e.email !== null && e.email.toLowerCase() === v
          return sql.includes('deleted_at IS NULL') ? emailOk && !e.deleted_at : emailOk
        }
        return e.id === v && !e.deleted_at
      })
      return { rows: rows.slice(0, 1).map((e) => ({ ...e, job_title: null, job_level: null, department_id: null, hire_date: null })) }
    }
    if (sql.startsWith('INSERT INTO "tenant_sotra".employees')) {
      state.inserts.employees.push(params)
      const id = `emp-${state.inserts.employees.length}`
      state.employees.push({ id, email: (params[2] as string | null) ?? null, deleted_at: null, employee_number: 'MAT00099' })
      return { rows: [{ id, employee_number: 'MAT00099' }] }
    }
    if (sql.startsWith('UPDATE "tenant_sotra".applications SET employee_id')) {
      state.appUpdates.push(params)
      if (state.application) state.application.employee_id = params[1]
      return { rows: [] }
    }
    if (sql.startsWith(`SELECT employee_id FROM "tenant_sotra".applications WHERE id = $1 AND stage = 'hired'`)) {
      const app = state.application
      return { rows: app && app.stage === 'hired' && app.employee_id ? [{ employee_id: app.employee_id }] : [] }
    }
    // ── Contrat généré → dossier salarié (une seule instruction, idempotente) ──
    if (sql.startsWith('WITH src AS (') && sql.includes('employee_documents')) {
      const pdf = state.application?.contract_pdf as string | undefined
      const employeeId = String(params[1])
      if (!pdf || state.documents.some((d) => d.employee_id === employeeId && d.bytes === pdf)) return { rows: [] }
      const id = `doc-${state.documents.length + 1}`
      state.documents.push({ id, employee_id: employeeId, bytes: pdf, params })
      return { rows: [{ id }] }
    }
    // ── Onboarding ──
    if (sql.startsWith('SELECT id, template_name FROM "tenant_sotra".onboarding_journeys WHERE application_id')) {
      return { rows: state.journeys.filter((j) => j.application_id === params[0]) }
    }
    if (sql.startsWith('UPDATE "tenant_sotra".onboarding_journeys SET application_id')) {
      const j = state.journeys.find((x) => x.employee_id === params[0] && x.status === 'in_progress' && !x.application_id)
      if (!j) return { rows: [] }
      j.application_id = String(params[1])
      return { rows: [{ id: j.id, template_name: j.template_name }] }
    }
    if (sql.includes('FROM "tenant_sotra".onboarding_templates WHERE is_active = true')) {
      return { rows: state.templates.filter((t) => t.is_active) }
    }
    if (sql.includes('FROM "tenant_sotra".onboarding_template_steps WHERE template_id')) {
      const tpl = state.templates.find((t) => t.id === params[0])
      const n = tpl ? tpl.steps : 0
      return { rows: Array.from({ length: n }, (_, i) => ({ title: `S${i}`, description: null, phase: 'day_one', owner_role: 'hr', due_offset_days: i, sort_order: i, resources: [] })) }
    }
    if (sql.startsWith('WITH tpl AS ( INSERT INTO "tenant_sotra".onboarding_templates')) {
      if (state.builtinExists) return { rows: [] }
      state.builtinExists = true
      state.inserts.builtin++
      const steps = JSON.parse(String(params[4])) as unknown[]
      state.templates.push({ id: 'tpl-builtin', name: String(params[0]), seniority: 'any', job_keywords: null, department_id: null, is_active: true, is_default: true, steps: steps.length })
      return { rows: [{ id: 'tpl-builtin', name: params[0] }] }
    }
    if (sql.includes('WHERE builtin_key = $1')) {
      const t = state.templates.find((x) => x.id === 'tpl-builtin')
      return { rows: t ? [{ id: t.id, name: t.name }] : [] }
    }
    if (sql.startsWith('INSERT INTO "tenant_sotra".onboarding_journeys')) {
      state.inserts.journeys.push(params)
      const id = `j-${state.inserts.journeys.length}`
      state.journeys.push({ id, employee_id: String(params[0]), application_id: (params[4] as string | null) ?? null, status: 'in_progress', template_name: String(params[2]) })
      return { rows: [{ id }] }
    }
    if (sql.startsWith('INSERT INTO "tenant_sotra".onboarding_steps')) {
      state.inserts.steps++
      return { rows: [] }
    }
    return { rows: [] }
  })
  return { state, queryMock, auditMock, emitMock }
})

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
vi.mock('../../utils/audit-log.js', () => ({ auditTenant: auditMock }))
vi.mock('../../services/integrations.service.js', () => ({ emitIntegrationEvent: emitMock }))
vi.mock('../../services/employee-tenant-context.service.js', () => ({
  loadEmployeeTenantContext: vi.fn().mockResolvedValue({
    legislation: { legislationPack: { smigMensuel: 75_000, currency: 'XOF' } },
    tenantTerminationRules: null,
    customFields: [],
  }),
}))

import { hireApplication, buildHirePrefill, HireError, fileProposalForHiredApplication } from './hire.service.js'

const SCHEMA = 'tenant_sotra'
const APP_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR = { userId: '22222222-2222-4222-8222-222222222222', ip: '127.0.0.1' }

function application(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APP_ID, first_name: 'Koffi', last_name: 'Yao', email: 'koffi.yao@mail.ci', phone: '+2250707070707',
    internal_employee_id: null, employee_id: null, offer_details: null,
    job_title: 'Comptable', job_department_id: '33333333-3333-4333-8333-333333333333',
    job_legal_entity_id: null, job_contract_type: 'CDI',
    ...overrides,
  }
}

beforeEach(() => {
  state.application = application()
  state.employees = []
  state.templates = []
  state.journeys = []
  state.builtinExists = false
  state.inserts = { employees: [], journeys: [], builtin: 0, steps: 0 }
  state.appUpdates = []
  state.documents = []
  queryMock.mockClear()
  auditMock.mockClear()
  emitMock.mockClear()
})

describe('hireApplication — fiche employé', () => {
  it('crée exactement UNE fiche pré-remplie depuis la candidature et l’offre', async () => {
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.status).toBe('created')
    expect(state.inserts.employees).toHaveLength(1)
    const p = state.inserts.employees[0]!
    expect(p[0]).toBe('Koffi')
    expect(p[1]).toBe('Yao')
    expect(p[2]).toBe('koffi.yao@mail.ci')
    expect(p[3]).toBe('+2250707070707')
    expect(p[10]).toBe('33333333-3333-4333-8333-333333333333') // département de l'offre
    expect(p[13]).toBe('Comptable')                           // poste = intitulé de l'offre
    expect(p[15]).toBe('cdi')
    expect(p[17]).toBe(0)                                      // salaire inconnu → hors paie
    expect(r?.toComplete).toContain('baseSalary')
    // Lien mémorisé sur la candidature
    expect(state.appUpdates).toEqual([[APP_ID, 'emp-1']])
    // Voie partagée avec POST /employees : audit + webhook employee.created
    expect(auditMock).toHaveBeenCalledWith(SCHEMA, expect.objectContaining({ action: 'employee.created' }))
    expect(emitMock).toHaveBeenCalledWith(expect.anything(), SCHEMA, 'employee.created', expect.anything(), expect.any(Function))
  })

  it('réutilise les conditions du dernier contrat généré (salaire, type, date, catégorie)', async () => {
    state.application = application({
      offer_details: { type: 'cdd_ci', salary: 450_000, startDate: '2026-11-15', category: '5e catégorie' },
    })
    await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    const p = state.inserts.employees[0]!
    expect(p[15]).toBe('cdd')
    expect(p[16]).toBe('2026-11-15')
    expect(p[17]).toBe(450_000)
    expect(p[19]).toBe('5e catégorie')
  })

  it('les valeurs saisies dans la modale priment', async () => {
    await hireApplication(SCHEMA, APP_ID, { hireDate: '2026-12-01', baseSalary: 300_000, departmentId: null }, ACTOR)
    const p = state.inserts.employees[0]!
    expect(p[16]).toBe('2026-12-01')
    expect(p[17]).toBe(300_000)
    expect(p[10]).toBeNull()
  })

  it('est idempotent : réembaucher réutilise la fiche liée, sans nouvelle création', async () => {
    const first = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    const second = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(state.inserts.employees).toHaveLength(1)
    expect(second?.status).toBe('already_linked')
    expect(second?.employeeId).toBe(first?.employeeId)
    // Un seul parcours pour cette embauche
    expect(state.inserts.journeys).toHaveLength(1)
  })

  it('candidat sans email (téléphone seul) : fiche créée, email à compléter', async () => {
    state.application = application({ email: null })
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.status).toBe('created')
    expect(state.inserts.employees[0]![2]).toBeNull()
    expect(state.inserts.employees[0]![3]).toBe('+2250707070707')
    expect(r?.toComplete).toContain('email')
  })

  it('email synthétique d’un profil sourcé : jamais recopié sur la fiche', async () => {
    state.application = application({ email: 'koffi.yao.sourced@example.com' })
    await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(state.inserts.employees[0]![2]).toBeNull()
  })

  it('fiche active portant le même email : liée, pas de doublon', async () => {
    state.employees = [{ id: 'emp-existing', email: 'koffi.yao@mail.ci', deleted_at: null, employee_number: 'MAT00007' }]
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.status).toBe('linked_existing')
    expect(r?.employeeId).toBe('emp-existing')
    expect(state.inserts.employees).toHaveLength(0)
    expect(auditMock).toHaveBeenCalledWith(SCHEMA, expect.objectContaining({ action: 'recruitment.employee_linked' }))
  })

  it('fiche ARCHIVÉE portant le même email : nouvelle fiche sans email (unicité)', async () => {
    state.employees = [{ id: 'emp-old', email: 'koffi.yao@mail.ci', deleted_at: '2025-01-01', employee_number: 'MAT00001' }]
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.status).toBe('created')
    expect(state.inserts.employees[0]![2]).toBeNull()
    expect(r?.toComplete).toContain('email')
  })

  it('candidature interne : relie la fiche du collaborateur candidat', async () => {
    state.employees = [{ id: 'emp-int', email: 'autre@sotra.ci', deleted_at: null, employee_number: 'MAT00003' }]
    state.application = application({ internal_employee_id: 'emp-int' })
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.status).toBe('linked_internal')
    expect(state.inserts.employees).toHaveLength(0)
  })

  it('salaire sous le SMIG : refus 422, aucune écriture', async () => {
    await expect(hireApplication(SCHEMA, APP_ID, { baseSalary: 50_000 }, ACTOR))
      .rejects.toBeInstanceOf(HireError)
    expect(state.inserts.employees).toHaveLength(0)
    expect(state.appUpdates).toHaveLength(0)
  })

  it('candidature inconnue → null', async () => {
    state.application = null
    expect(await hireApplication(SCHEMA, APP_ID, {}, ACTOR)).toBeNull()
  })
})

describe('hireApplication — parcours d’intégration', () => {
  it('aucun modèle : crée le modèle standard du tenant PUIS le parcours', async () => {
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(state.inserts.builtin).toBe(1)
    expect(state.inserts.journeys).toHaveLength(1)
    expect(state.inserts.journeys[0]![4]).toBe(APP_ID) // lié à la candidature
    expect(state.inserts.steps).toBeGreaterThanOrEqual(8)
    expect(r?.onboarding?.outcome).toBe('builtin')
    expect(r?.onboarding?.builtinTemplateCreated).toBe(true)
  })

  it('modèle standard déjà présent : réutilisé, jamais dupliqué', async () => {
    state.application = application({ id: APP_ID })
    await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    // seconde embauche (autre candidature, autre email)
    state.application = application({ id: '44444444-4444-4444-8444-444444444444', email: 'awa@mail.ci', employee_id: null })
    state.templates = state.templates.map((t) => ({ ...t, is_active: false })) // modèle désactivé par l'admin
    await hireApplication(SCHEMA, '44444444-4444-4444-8444-444444444444', {}, ACTOR)
    expect(state.inserts.builtin).toBe(1)
    expect(state.inserts.journeys).toHaveLength(2)
  })

  it('modèle actif correspondant au poste : ce modèle est utilisé', async () => {
    state.templates = [{
      id: 'tpl-compta', name: 'Intégration Finance', seniority: 'any', job_keywords: 'comptable',
      department_id: null, is_active: true, is_default: false, steps: 3,
    }]
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.onboarding?.outcome).toBe('template')
    expect(r?.onboarding?.templateName).toBe('Intégration Finance')
    expect(state.inserts.builtin).toBe(0)
    expect(state.inserts.journeys).toHaveLength(1)
  })

  it('collaborateur relié avec un parcours en cours : rattaché, pas de second parcours', async () => {
    state.employees = [{ id: 'emp-existing', email: 'koffi.yao@mail.ci', deleted_at: null, employee_number: 'MAT00007' }]
    state.journeys = [{ id: 'j-old', employee_id: 'emp-existing', application_id: null, status: 'in_progress', template_name: 'X' }]
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.onboarding?.outcome).toBe('existing')
    expect(state.inserts.journeys).toHaveLength(0)
    expect(state.journeys[0]!.application_id).toBe(APP_ID)
  })

  it('échec du parcours : la fiche reste créée, l’échec est signalé', async () => {
    const original = queryMock.getMockImplementation()!
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('onboarding_journeys WHERE application_id')) throw new Error('boom')
      return original(sql, params)
    })
    let r: Awaited<ReturnType<typeof hireApplication>>
    try {
      r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    } finally {
      queryMock.mockImplementation(original)
    }
    expect(r?.status).toBe('created')
    expect(r?.onboardingError).toBe(true)
  })
})

describe('buildHirePrefill', () => {
  it('type de contrat de l’offre (libellé libre) ramené au référentiel', () => {
    const app = application({ job_contract_type: 'Stage' }) as unknown as Parameters<typeof buildHirePrefill>[0]
    expect(buildHirePrefill(app).contractType).toBe('stage')
    const unknown = application({ job_contract_type: 'Freelance' }) as unknown as Parameters<typeof buildHirePrefill>[0]
    expect(buildHirePrefill(unknown).contractType).toBe('cdi')
  })

  it('date d’embauche par défaut = aujourd’hui', () => {
    const app = application() as unknown as Parameters<typeof buildHirePrefill>[0]
    expect(buildHirePrefill(app).hireDate).toBe(new Date().toISOString().slice(0, 10))
  })
})

describe('hireApplication — niveau de poste et contrat généré', () => {
  it('recopie le job_level de l’offre sur la fiche créée (lecture tolérante de la colonne)', async () => {
    state.application = application({ job_level: 'cadre' })
    await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    const p = state.inserts.employees[0]!
    expect(p[14]).toBe('cadre')
    const select = queryMock.mock.calls.find((c) => String(c[0]).includes('FROM "tenant_sotra".applications a'))!
    expect(String(select[0])).toContain("to_jsonb(rj) ->> 'job_level'")
  })

  it('offre sans niveau : job_level NULL', async () => {
    await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(state.inserts.employees[0]![14]).toBeNull()
  })

  it('verse le contrat généré au dossier salarié (version courante), une seule fois', async () => {
    state.application = application({ contract_pdf: '%PDF-1.4 contrat' })
    const first = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(first?.contractDocumentId).toBe('doc-1')
    expect(state.documents).toHaveLength(1)
    const params = state.documents[0]!.params
    expect(params[0]).toBe(APP_ID)
    expect(params[1]).toBe('emp-1')
    // Proposition NON signée : jamais versée comme contrat signé.
    expect(params[2]).toBe('contract_proposal')
    expect(params[3]).toBe('Proposition de contrat (générée au recrutement)')
    // Historique des versions rattaché à la nouvelle fiche.
    const link = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE "tenant_sotra".contract_proposals SET employee_id'))
    expect(link?.[1]).toEqual([APP_ID, 'emp-1'])
    const sql = String(queryMock.mock.calls.find((c) => String(c[0]).includes('employee_documents'))![0])
    expect(sql).toContain('is_current = false')
    expect(sql).toContain('COALESCE(MAX(version), 0) + 1')
    expect(auditMock).toHaveBeenCalledWith(SCHEMA, expect.objectContaining({ action: 'recruitment.contract_filed' }))

    const second = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(second?.status).toBe('already_linked')
    expect(second?.contractDocumentId).toBeNull()
    expect(state.documents).toHaveLength(1)
  })

  it('sans contrat généré : aucun document', async () => {
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.contractDocumentId).toBeNull()
    expect(state.documents).toHaveLength(0)
  })

  it('fiche préexistante reliée (même email) : son contrat courant n’est pas remplacé', async () => {
    state.application = application({ contract_pdf: '%PDF-1.4 contrat' })
    state.employees = [{ id: 'emp-old', email: 'koffi.yao@mail.ci', deleted_at: null, employee_number: 'MAT00001' }]
    const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
    expect(r?.status).toBe('linked_existing')
    expect(r?.contractDocumentId).toBeNull()
    expect(state.documents).toHaveLength(0)
  })

  it('échec de l’écriture du document : embauche maintenue', async () => {
    state.application = application({ contract_pdf: '%PDF-1.4 contrat' })
    const impl = queryMock.getMockImplementation()!
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes('employee_documents')) throw new Error('db down')
      return impl(sql, params)
    })
    try {
      const r = await hireApplication(SCHEMA, APP_ID, {}, ACTOR)
      expect(r?.status).toBe('created')
      expect(r?.contractDocumentId).toBeNull()
    } finally {
      queryMock.mockImplementation(impl)
    }
  })
})

describe("fileProposalForHiredApplication — proposition modifiée après l'embauche", () => {
  it('verse la nouvelle version au dossier de la fiche liée', async () => {
    state.application = application({ stage: 'hired', employee_id: 'emp-7', contract_pdf: '%PDF-1.4 v2' })
    const id = await fileProposalForHiredApplication(SCHEMA, APP_ID, ACTOR)
    expect(id).toBe('doc-1')
    expect(state.documents[0]!.employee_id).toBe('emp-7')
    expect(state.documents[0]!.params[2]).toBe('contract_proposal')
    const link = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE "tenant_sotra".contract_proposals SET employee_id'))
    expect(link?.[1]).toEqual([APP_ID, 'emp-7'])
  })

  it("ne fait rien tant que la candidature n'est pas recrutée", async () => {
    state.application = application({ stage: 'offer', employee_id: null, contract_pdf: '%PDF-1.4 v1' })
    expect(await fileProposalForHiredApplication(SCHEMA, APP_ID, ACTOR)).toBeNull()
    expect(state.documents).toHaveLength(0)
  })
})
