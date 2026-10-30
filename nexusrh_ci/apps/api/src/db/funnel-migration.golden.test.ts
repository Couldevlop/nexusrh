/**
 * Golden — migration « entonnoir de recrutement » (marque employeur, lot 2).
 *
 * `ensureRecruitmentSchemaMigrated` rejoue tout à chaque appel (prod : le corps
 * du seed ne tourne jamais) : la table, les colonnes et les rattrapages
 * doivent être idempotents et ne cibler que des lignes non traitées.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn().mockResolvedValue({ rows: [] }) }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../config.js', () => ({
  config: { env: 'test', database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 } },
}))

import { ensureRecruitmentSchemaMigrated } from './provisioning.js'
import { onboardingTableStatements } from './onboarding-tables.js'

const sqlOf = (calls: unknown[][]): string[] => calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim())

beforeEach(() => {
  queryMock.mockClear()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('Migration entonnoir', () => {
  it('crée l’historique des étapes (FK cascade) et ses index uniques', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const sql = sqlOf(queryMock.mock.calls).join(' | ')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "tenant_demo".application_stage_history')
    expect(sql).toContain('REFERENCES "tenant_demo".applications(id) ON DELETE CASCADE')
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_demo_stage_hist_initial .* WHERE from_stage IS NULL/)
  })

  it('ajoute hired_at, rejection_reason (liste fermée), rejection_note, offer_details, employee_id', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const sql = sqlOf(queryMock.mock.calls).join(' | ')
    for (const col of ['hired_at timestamptz', 'rejection_reason varchar(50)', 'rejection_note varchar(500)', 'offer_details jsonb', 'employee_id uuid', 'contract_pdf bytea', 'contract_pdf_name varchar(255)']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`)
    }
    expect(sql).toContain("'declined_by_candidate_salary'")
    expect(sql).toContain("'rejected_auto_screening'")
  })

  it('rattrapage hired_at : seulement les embauches sans date, décision IA sinon updated_at', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const fill = sqlOf(queryMock.mock.calls).find((s) => s.includes('SET hired_at = COALESCE'))
    expect(fill).toBeDefined()
    expect(fill).toMatch(/WHERE a\.stage = 'hired' AND a\.hired_at IS NULL/)
    expect(fill).toContain("d.decision = 'hired'")
  })

  it('rattrapage historique : seulement les candidatures SANS historique, ON CONFLICT DO NOTHING', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const fill = sqlOf(queryMock.mock.calls).find((s) => s.startsWith('WITH legacy AS'))
    expect(fill).toBeDefined()
    expect(fill).toContain('WHERE NOT EXISTS (SELECT 1 FROM "tenant_demo".application_stage_history h WHERE h.application_id = a.id)')
    expect(fill!.match(/ON CONFLICT DO NOTHING/g)).toHaveLength(2)
  })

  it('les colonnes sont ajoutées AVANT les rattrapages', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const sql = sqlOf(queryMock.mock.calls)
    const iCol = sql.findIndex((s) => s.includes('ADD COLUMN IF NOT EXISTS hired_at'))
    const iFill = sql.findIndex((s) => s.includes('SET hired_at = COALESCE'))
    const iHist = sql.findIndex((s) => s.startsWith('WITH legacy AS'))
    expect(iCol).toBeGreaterThanOrEqual(0)
    expect(iFill).toBeGreaterThan(iCol)
    expect(iHist).toBeGreaterThan(iFill)
  })
})

describe('Onboarding — colonnes d’embauche', () => {
  it('parcours lié à une candidature (unique) + modèle intégré identifié', () => {
    const sql = onboardingTableStatements('tenant_demo').join(' | ')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS application_id uuid')
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_onb_journeys_application .* WHERE application_id IS NOT NULL/)
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS builtin_key varchar(40)')
  })
})
