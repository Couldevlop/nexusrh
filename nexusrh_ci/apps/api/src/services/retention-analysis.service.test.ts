import { describe, it, expect } from 'vitest'
import { analyzeRetentionRisk } from './retention-analysis.service.js'

const EID = '11111111-1111-1111-1111-111111111111'

// Fake pool routant par mots-clés SQL.
function fakePool(rows: { emp?: unknown; sick?: unknown; training?: unknown; eval?: unknown }) {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM "tenant_sotra".employees') && sql.includes('hire_date'))
        return { rows: rows.emp ? [rows.emp] : [] }
      if (sql.includes('absences')) return { rows: [rows.sick ?? { d: '0' }] }
      if (sql.includes('training_enrollments')) return { rows: [rows.training ?? { last: null }] }
      if (sql.includes('evaluations')) return { rows: [rows.eval ?? { s: null }] }
      return { rows: [] }
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const recentHire = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10) // ~2 mois

describe('analyzeRetentionRisk (CAR-006 / AI-008)', () => {
  it('employé introuvable → null', async () => {
    const r = await analyzeRetentionRisk(fakePool({}), 'tenant_sotra', EID)
    expect(r).toBeNull()
  })

  it('cumul de facteurs → risque high + recommandations FR', async () => {
    const r = await analyzeRetentionRisk(fakePool({
      emp: { id: EID, hire_date: recentHire, base_salary: '60000' },
      sick: { d: '7' }, training: { last: null }, eval: { s: '2' },
    }), 'tenant_sotra', EID)
    expect(r).not.toBeNull()
    expect(r!.risk).toBe('high')
    expect(r!.score).toBeGreaterThanOrEqual(60)
    expect(r!.factors.length).toBeGreaterThanOrEqual(4)
    expect(r!.recommendations.length).toBeGreaterThan(0)
    expect(r!.factors.some(f => /SMIG/.test(f))).toBe(true)
  })

  it('profil sain (ancienneté, salaire élevé, formé, bonne éval) → risque low', async () => {
    const r = await analyzeRetentionRisk(fakePool({
      emp: { id: EID, hire_date: '2018-01-01', base_salary: '800000' },
      sick: { d: '0' },
      training: { last: new Date().toISOString().slice(0, 10) },
      eval: { s: '4.5' },
    }), 'tenant_sotra', EID)
    expect(r!.risk).toBe('low')
    expect(r!.score).toBeLessThan(30)
  })

  it('borne le score à 100 et classe les bandes', async () => {
    const r = await analyzeRetentionRisk(fakePool({
      emp: { id: EID, hire_date: recentHire, base_salary: '60000' },
      sick: { d: '30' }, training: { last: null }, eval: { s: '1' },
    }), 'tenant_sotra', EID)
    expect(r!.score).toBeLessThanOrEqual(100)
    expect(['low', 'medium', 'high']).toContain(r!.risk)
  })
})
