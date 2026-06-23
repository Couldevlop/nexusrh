/**
 * Couverture exhaustive — payroll-workflow.routes.ts
 *
 * Complète payroll-workflow.routes.test.ts + golden en exerçant les branches non
 * couvertes :
 *   - GET /periods : succès admin (auditWorkflow non sollicité) + catch (describeWorkflowError)
 *   - POST /periods : doublon (409 via ON CONFLICT vide) + catch PG mappé
 *   - POST /periods/:id/send-to-sites : auto-population legal_entities,
 *     filiales sans RAF (400), aucune filiale active (400), parent introuvable (404)
 *   - POST /periods/:id/submit-by-raf : période introuvable (404), pack stub (422),
 *     filiale introuvable (500), legal_entity_id null (500), génération bulletins
 *   - POST /periods/:id/validate-central : période introuvable (404),
 *     période fille refusée (400), consolidation OK
 *   - POST /periods/:id/close : période introuvable (404), clôture OK + audit
 *   - GET /periods/:id/timeline : UUID invalide (400), parent introuvable (404),
 *     RAF non concerné (403), reconstruction chronologie nominative
 *   - describeWorkflowError : codes 23505 / 23503 / 42xxx / défaut
 *
 * Isolation : pg routé par SQL, redis/config/migrations mockés.
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
import workflowRoutes from './payroll-workflow.routes.js'

const SCHEMA   = 'tenant_multi'
const PARENT   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CHILD    = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const LE_ID    = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const RAF_SUB  = 'u-raf'

function tokenFor(app: FastifyInstance, role: string, sub = 'u-' + role) {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@multi.ci`, firstName: 'X', lastName: 'Y', employeeId: null,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(workflowRoutes, { prefix: '/payroll-workflow' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll-workflow/periods', () => {
  it('admin liste toutes les périodes (200, pas de filtre RAF)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: PARENT, month: '2024-12', legal_entity_name: null }] })
    const res = await app.inject({
      method: 'GET', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
    // pas de paramètre RAF
    expect((queryMock.mock.calls[0]![1] as unknown[])).toEqual([])
  })

  it('erreur PG → describeWorkflowError (table absente, 500)', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('no table'), { code: '42P01' }))
    const res = await app.inject({
      method: 'GET', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toContain('pas encore à jour')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll-workflow/periods — création parente', () => {
  it('ON CONFLICT DO NOTHING (aucune ligne) → 409 doublon', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] }) // assertMultiCountryTenant
      .mockResolvedValueOnce({ rows: [] })                            // INSERT → DO NOTHING
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('déjà existante')
  })

  it('succès → 201 + auditWorkflow inséré', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [{ id: PARENT, status: 'draft_central', month: '2024-12' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log INSERT
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall).toBeDefined()
  })

  it('erreur PG unique_violation (23505) → 409 mappé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('déjà été effectuée')
  })

  it('échec audit_log non-bloquant : la création réussit quand même (201)', async () => {
    // auditWorkflow.catch (lignes 50-51) : l'INSERT audit échoue mais l'action passe.
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true }] })
      .mockResolvedValueOnce({ rows: [{ id: PARENT, status: 'draft_central', month: '2024-12' }] })
      .mockRejectedValueOnce(Object.assign(new Error('no audit table'), { code: '42P01' })) // audit INSERT échoue
    const res = await app.inject({
      method: 'POST', url: '/payroll-workflow/periods',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { month: '2024-12' },
    })
    expect(res.statusCode).toBe(201)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll-workflow/periods/:id/send-to-sites', () => {
  it('période parente introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/send-to-sites`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { sites: [{ legalEntityId: LE_ID, rafUserId: RAF_SUB, legislationPackCode: 'CIV-2024' }] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('auto-population : filiale sans RAF → 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ month: '2024-12', status: 'draft_central' }] }) // parent
      .mockResolvedValueOnce({ rows: [                                                   // legal_entities
        { id: LE_ID, raf_user_id: null, legislation_pack_code: 'CIV-2024', country_code: 'CIV', name: 'Filiale Sans RAF' },
      ] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/send-to-sites`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: {}, // pas de sites → auto-population
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('sans RAF')
  })

  it('auto-population : aucune filiale active → 400', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ month: '2024-12', status: 'draft_central' }] })
      .mockResolvedValueOnce({ rows: [] }) // aucune legal_entity active
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/send-to-sites`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Aucune filiale active')
  })

  it('auto-population réussie depuis legal_entities (pack résolu par country_code)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ month: '2024-12', status: 'draft_central' }] })
      .mockResolvedValueOnce({ rows: [                                                   // legal_entities
        { id: LE_ID, raf_user_id: RAF_SUB, legislation_pack_code: null, country_code: 'CIV', name: 'Filiale CIV' },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: CHILD }] }) // INSERT child
      .mockResolvedValueOnce({ rows: [] })              // UPDATE parent
      .mockResolvedValueOnce({ rows: [] })              // audit
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/send-to-sites`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.sites).toHaveLength(1)
  })

  it('erreur PG foreign_key_violation (23503) → 400 mappé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ month: '2024-12', status: 'draft_central' }] })
      .mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' })) // INSERT child rejette
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/send-to-sites`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { sites: [{ legalEntityId: LE_ID, rafUserId: RAF_SUB, legislationPackCode: 'CIV-2024' }] },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Référence invalide')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll-workflow/periods/:id/submit-by-raf', () => {
  function periodRow(over: Record<string, unknown> = {}) {
    return {
      id: CHILD, month: '2024-12', status: 'sent_to_sites',
      raf_user_id: RAF_SUB, parent_period_id: PARENT,
      legal_entity_id: LE_ID, legislation_pack_code: 'CIV-2024', ...over,
    }
  }

  it('période introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('legal_entity_id null → 500 (incohérence)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [periodRow({ legal_entity_id: null })] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toContain('legal_entity_id')
  })

  it('filiale introuvable → 500', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [periodRow()] })
      .mockResolvedValueOnce({ rows: [] }) // legal_entities SELECT vide
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toContain('Filiale introuvable')
  })

  it('période non éligible (status != sent_to_sites) → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [periodRow({ status: 'completed_by_site' })] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('sent_to_sites')
  })

  it('erreur PG pendant la génération → catch describeWorkflowError (500)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [periodRow()] })             // période
      .mockRejectedValueOnce(Object.assign(new Error('col'), { code: '42703' })) // legal_entities SELECT rejette
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toContain('pas encore à jour')
  })

  it('pack actif (BEN-2024) n\'est plus refusé pour stub', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [periodRow({ legislation_pack_code: 'BEN-2024' })] })
      .mockResolvedValueOnce({ rows: [{ at_rate: '0.020', name: 'Filiale Bénin' }] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    // BEN-2024 est désormais ACTIF (valeurs sourcées) : la garde stub ne le bloque plus.
    expect(JSON.parse(res.body).error ?? '').not.toContain('stub')
  })

  it('génère les bulletins de la filiale (1 employé, at_rate null → défaut 2%)', async () => {
    const employee = { id: 'emp-1', base_salary: '300000', marital_status: 'married', children_count: 2 }
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_multi".pay_periods WHERE id = $1') && !/UPDATE/i.test(q)) {
        return { rows: [periodRow()] }
      }
      if (q.includes('.legal_entities')) return { rows: [{ at_rate: null, name: 'Filiale CIV' }] }
      if (q.includes('.employees'))      return { rows: [employee] }
      if (q.includes('.variable_elements')) return { rows: [] }
      if (q.includes('.pay_slips'))      return { rows: [] }
      if (/UPDATE/i.test(q) && q.includes('.pay_periods')) {
        return { rows: [{ id: CHILD, status: 'completed_by_site', total_gross: 300000 }] }
      }
      if (q.includes('.audit_log'))      return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF_SUB)}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.status).toBe('completed_by_site')
    expect(body.summary.inserted).toBe(1)
    expect(body.summary.totalGross).toBeGreaterThan(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll-workflow/periods/:id/validate-central', () => {
  it('période introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/validate-central`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('période fille (parent_period_id non-null) → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'completed_by_site', parent_period_id: PARENT }] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/validate-central`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('période parente')
  })

  it('toutes les filles soumises → consolidation des totaux + 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'sent_to_sites', parent_period_id: null }] }) // parent
      .mockResolvedValueOnce({ rows: [                                                          // children
        { id: CHILD, status: 'completed_by_site', legal_entity_id: LE_ID, total_gross: '300000', total_net: '270000', total_cnps: '46000', total_its: '4200' },
        { id: 'child-2', status: 'completed_by_site', legal_entity_id: 'le-2', total_gross: '200000', total_net: '180000', total_cnps: '30000', total_its: '2000' },
      ] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE parent
      .mockResolvedValueOnce({ rows: [] }) // UPDATE children
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/validate-central`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.status).toBe('validated_central')
    expect(body.consolidated.sites).toBe(2)
    expect(body.consolidated.sumGross).toBe(500000)
    expect(body.consolidated.sumNet).toBe(450000)
    expect(body.consolidated.sumIts).toBe(6200)
  })

  it('erreur PG → catch describeWorkflowError (500)', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'XX000' }))
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/validate-central`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toContain('Réessayez')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll-workflow/periods/:id/close', () => {
  it('période parente introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('clôture validated_central → 200 + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'validated_central' }] }) // parent
      .mockResolvedValueOnce({ rows: [] })                                // UPDATE
      .mockResolvedValueOnce({ rows: [] })                                // audit
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('closed')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall).toBeDefined()
  })

  it('erreur PG → catch describeWorkflowError (500)', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'XX000' }))
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll-workflow/periods/:id/timeline', () => {
  it('UUID invalide → 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/payroll-workflow/periods/not-a-uuid/timeline',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('parent introuvable (ou période fille) → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: CHILD, month: '2024-12', status: 'sent_to_sites', parent_period_id: PARENT }] })
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${CHILD}/timeline`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('RAF non concerné par le draft → 403', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: PARENT, month: '2024-12', status: 'sent_to_sites', parent_period_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: CHILD, legal_entity_id: LE_ID, raf_user_id: 'u-autre', legal_entity_name: 'Filiale X' }] })
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${PARENT}/timeline`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF_SUB)}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('admin → chronologie nominative reconstruite depuis audit_log', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: PARENT, month: '2024-12', status: 'sent_to_sites', parent_period_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: CHILD, legal_entity_id: LE_ID, raf_user_id: RAF_SUB, legal_entity_name: 'Filiale CIV' }] })
      .mockResolvedValueOnce({ rows: [
        { action: 'workflow.create_draft', created_at: '2024-12-01T08:00:00Z', changes: { month: '2024-12' }, entity_id: PARENT, first_name: 'Awa', last_name: 'Koné' },
        { action: 'workflow.submit_by_raf', created_at: '2024-12-05T10:00:00Z', changes: { legalEntityName: 'Filiale CIV', inserted: 3 }, entity_id: CHILD, first_name: null, last_name: null },
      ] })
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${PARENT}/timeline`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.totalSites).toBe(1)
    expect(body.data.events).toHaveLength(2)
    expect(body.data.events[0].label).toBe('Brouillon initié')
    expect(body.data.events[0].actorName).toBe('Awa Koné')
    expect(body.data.events[1].actorName).toBe('Système') // pas de nom → Système
    expect(body.data.events[1].filiale).toBe('Filiale CIV')
  })

  it('audit_log SELECT en échec → events vides (.catch fallback), 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: PARENT, month: '2024-12', status: 'sent_to_sites', parent_period_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: CHILD, legal_entity_id: LE_ID, raf_user_id: RAF_SUB, legal_entity_name: 'Filiale CIV' }] })
      .mockRejectedValueOnce(Object.assign(new Error('no audit'), { code: '42P01' })) // events SELECT → .catch
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${PARENT}/timeline`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.events).toEqual([])
  })

  it('erreur PG sur le SELECT parent → describeWorkflowError (défaut 500)', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'XX999' }))
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${PARENT}/timeline`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toContain('Réessayez')
  })
})
