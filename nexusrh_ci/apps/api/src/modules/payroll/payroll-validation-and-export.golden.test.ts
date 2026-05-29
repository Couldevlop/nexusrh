/**
 * Golden test E2E — Validation 2-yeux de la paie (OWASP A04 — Segregation of
 * Duties) + Export livre de paie annuel.
 *
 * ── Workflow 2-yeux (POST /periods/:month/approve | /reject) ──────────────────
 * Après clôture (status `pending_validation`), la paie exige N validations par
 * des approbateurs DISTINCTS avant de passer `closed`. Règles verrouillées :
 *   - L'initiateur ne peut PAS s'auto-approuver (403).
 *   - Un même approbateur ne peut PAS valider deux niveaux (403).
 *   - À la N-ième validation par un approbateur distinct → status `closed`
 *     + audit_log `payroll.closed`.
 *   - approve/reject hors `pending_validation` → 409 ; période absente → 404.
 *   - reject exige un motif (≥ 5 car.) → 400 sinon ; reject valide purge les
 *     approbations, repasse `open`, audit_log `payroll.rejected`.
 *
 * ── Export livre de paie (GET /livre-de-paie/:year/export) ────────────────────
 * Export CSV annuel destiné aux inspecteurs du travail CI. Il est TENANT-WIDE
 * (`WHERE ps.month LIKE 'YYYY-%'`, sans filtre filiale) : pour un tenant groupe,
 * il CONSOLIDE donc les bulletins de toutes les filiales. RBAC : admin/hr_*
 * uniquement (employee → 403).
 *
 * Isolation : pg routé par SQL (aucune connexion), redis/config/migrations mockés.
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

const SCHEMA    = 'tenant_sotra'
const MONTH     = '2024-12'
const PERIOD_ID = '11111111-1111-1111-1111-111111111111'

function tokenFor(app: FastifyInstance, role: string, sub?: string) {
  return app.jwt.sign({
    sub: sub ?? `u-${role}`, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
}

function auditCallFor(action: string) {
  // L'action est inline dans le SQL (VALUES ($1, 'payroll.closed', ...)), pas un param.
  return queryMock.mock.calls.find(
    (c) => String(c[0]).includes('.audit_log') && String(c[0]).includes(`'${action}'`),
  )
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

// ════════════════════════════════════════════════════════════════════════════════
describe('Validation 2-yeux — Segregation of Duties (OWASP A04)', () => {
  // Mock routé par SQL pour le workflow d'approbation.
  function routeApprove(opts: {
    period: { id: string; status: string; initiated_by: string | null } | null
    levels?: number
    currentApprovals?: number
    approversSoFar?: string[]   // approbateurs ayant déjà validé un niveau
  }) {
    queryMock.mockImplementation(async (sql: unknown, params?: unknown) => {
      const q = String(sql)
      const p = (params as unknown[]) ?? []
      if (q.includes('.workflow_configs')) return { rows: [{ levels_count: opts.levels ?? 2 }] }
      if (q.includes('.pay_period_approvals')) {
        if (/^\s*INSERT/i.test(q)) return { rows: [] }
        if (/^\s*DELETE/i.test(q)) return { rows: [] }
        if (q.includes('count(')) return { rows: [{ cnt: opts.currentApprovals ?? 0 }] }
        // dup check : SELECT 1 ... WHERE period_id=$1 AND approver_id=$2
        const dup = (opts.approversSoFar ?? []).includes(String(p[1]))
        return { rows: dup ? [{ ok: 1 }] : [] }
      }
      if (q.includes('.audit_log')) return { rows: [] }
      if (q.includes('.pay_periods')) {
        if (/^\s*UPDATE/i.test(q)) return { rows: [] }
        return { rows: opts.period ? [opts.period] : [] }
      }
      return { rows: [] }
    })
  }

  it('l\'INITIATEUR ne peut pas s\'auto-approuver (403 SoD)', async () => {
    routeApprove({ period: { id: PERIOD_ID, status: 'pending_validation', initiated_by: 'u-init' } })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/approve`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager', 'u-init')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('séparation des tâches')
  })

  it('1ʳᵉ validation par un approbateur distinct → reste pending_validation (1/2)', async () => {
    routeApprove({
      period: { id: PERIOD_ID, status: 'pending_validation', initiated_by: 'u-init' },
      levels: 2, currentApprovals: 0, approversSoFar: [],
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/approve`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager', 'u-app1')}` },
      payload: { notes: 'RAS niveau 1' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.status).toBe('pending_validation')
    expect(body.data.level).toBe(1)
    expect(body.data.requiredLevels).toBe(2)
    // Pas encore clôturée → aucun audit payroll.closed
    expect(auditCallFor('payroll.closed')).toBeUndefined()
  })

  it('un approbateur déjà passé ne peut PAS valider un 2ᵉ niveau (403)', async () => {
    routeApprove({
      period: { id: PERIOD_ID, status: 'pending_validation', initiated_by: 'u-init' },
      levels: 2, currentApprovals: 1, approversSoFar: ['u-app1'],
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/approve`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', 'u-app1')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('déjà approuvé')
  })

  it('2ᵉ validation par un approbateur distinct → closed + audit payroll.closed', async () => {
    routeApprove({
      period: { id: PERIOD_ID, status: 'pending_validation', initiated_by: 'u-init' },
      levels: 2, currentApprovals: 1, approversSoFar: ['u-app1'],
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/approve`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', 'u-app2')}` },
      payload: { notes: 'Validation finale' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.status).toBe('closed')
    expect(body.data.level).toBe(2)
    const audit = auditCallFor('payroll.closed')
    expect(audit, 'audit_log payroll.closed attendu').toBeDefined()
    // params audit_log = [user_id, period_id($2), changes($3), ip($4)]
    expect((audit![1] as unknown[])[1]).toBe(PERIOD_ID)
  })

  it('approve sur période non pending_validation → 409', async () => {
    routeApprove({ period: { id: PERIOD_ID, status: 'open', initiated_by: 'u-init' } })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/approve`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', 'u-app2')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
  })

  it('approve sur période inexistante → 404', async () => {
    routeApprove({ period: null })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/approve`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', 'u-app2')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('reject sans motif valable (< 5 car.) → 400', async () => {
    routeApprove({ period: { id: PERIOD_ID, status: 'pending_validation', initiated_by: 'u-init' } })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/reject`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager', 'u-app1')}` },
      payload: { reason: 'no' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('reject valide → status open, purge des approbations, audit payroll.rejected', async () => {
    routeApprove({ period: { id: PERIOD_ID, status: 'pending_validation', initiated_by: 'u-init' } })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/reject`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager', 'u-app1')}` },
      payload: { reason: 'Erreur sur prime transport — recalculer' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('open')
    // DELETE des approbations partielles déclenché
    const del = queryMock.mock.calls.find(
      (c) => /^\s*DELETE/i.test(String(c[0])) && String(c[0]).includes('.pay_period_approvals'),
    )
    expect(del, 'DELETE pay_period_approvals attendu').toBeDefined()
    expect(auditCallFor('payroll.rejected'), 'audit_log payroll.rejected attendu').toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('Export livre de paie annuel (consolidé tenant-wide, inspection CI)', () => {
  const TENANT = { name: 'Groupe Syrse', cnps_number: 'CI-00123456-X', rccm: 'CI-ABJ-2005-B-1' }
  // Bulletins de DEUX filiales différentes (mois variés) — l'export ne filtre pas
  // sur legal_entity, il les consolide tous.
  const SLIP_ROWS = [
    {
      month: '2024-01', first_name: 'Awa', last_name: 'Koné', cnps_number: 'C1', nni: 'N1',
      job_title: 'Comptable', department_name: 'Admin', contract_type: 'cdi',
      base_salary: 300000, gross_salary: 300000, cnps_retraite_sal: 18900, cnps_pf_pat: 3500,
      cnps_at_pat: 1400, cnps_retraite_pat: 23100, total_cnps_sal: 18900, total_cnps_pat: 28000,
      its: 4200, net_payable: 276900, employer_cost: 328000, indemnite_absence: 0, payment_method: 'wave',
    },
    {
      month: '2024-02', first_name: 'Yao', last_name: 'Brou', cnps_number: 'C2', nni: 'N2',
      job_title: 'Chauffeur', department_name: 'Exploitation', contract_type: 'cdi',
      base_salary: 180000, gross_salary: 180000, cnps_retraite_sal: 11340, cnps_pf_pat: 2100,
      cnps_at_pat: 1400, cnps_retraite_pat: 13860, total_cnps_sal: 11340, total_cnps_pat: 17360,
      its: 1575, net_payable: 167085, employer_cost: 197360, indemnite_absence: 0, payment_method: 'orange_money',
    },
  ]

  function routeExport() {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('platform.tenants')) return { rows: [TENANT] }
      if (q.includes('.pay_slips'))       return { rows: SLIP_ROWS }
      return { rows: [] }
    })
  }

  it('hr_officer → 200 CSV (BOM + en-tête + 1 ligne/bulletin), headers attachment', async () => {
    routeExport()
    const res = await app.inject({
      method: 'GET', url: '/payroll/livre-de-paie/2024/export',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/csv')
    expect(String(res.headers['content-disposition'])).toContain('livre-paie-2024.csv')

    expect(res.body.startsWith('﻿')).toBe(true)          // BOM Excel
    const lines = res.body.replace('﻿', '').split('\n')
    expect(lines[0]).toContain('Livre de paie 2024')
    expect(lines[0]).toContain('Groupe Syrse')
    expect(lines[1]).toContain('Mois;Nom;Prénom')            // en-tête colonnes
    // 1 ligne de titre + 1 ligne d'en-tête + 1 ligne par bulletin (toutes filiales)
    expect(lines).toHaveLength(2 + SLIP_ROWS.length)
    expect(res.body).toContain('Koné')
    expect(res.body).toContain('Brou')
  })

  it('l\'export n\'est PAS filtré par filiale (consolidation groupe)', async () => {
    routeExport()
    await app.inject({
      method: 'GET', url: '/payroll/livre-de-paie/2024/export',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    const slipCall = queryMock.mock.calls.find((c) => String(c[0]).includes('.pay_slips'))
    expect(slipCall).toBeDefined()
    expect(String(slipCall![0])).not.toContain('legal_entity_id')
    expect(String(slipCall![0])).toContain('month LIKE')
  })

  it('un employee NE PEUT PAS exporter le livre de paie (403)', async () => {
    routeExport()
    const res = await app.inject({
      method: 'GET', url: '/payroll/livre-de-paie/2024/export',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
