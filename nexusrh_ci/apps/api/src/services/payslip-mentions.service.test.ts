import { describe, it, expect, vi } from 'vitest'
import { loadPayslipMentions } from './payslip-mentions.service.js'

function dbWith(handler: (sql: string, params: unknown[]) => unknown[] | Error) {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const r = handler(sql, params)
      if (r instanceof Error) throw r
      return { rows: r }
    }),
  }
}

describe('loadPayslipMentions — mentions obligatoires du bulletin', () => {
  it('assemble embauche, catégorie, temps de travail, congés et RCCM/DGI', async () => {
    const db = dbWith((sql) => {
      if (sql.includes('FROM "tenant_sotra".employees')) return [{ hire_date: '2019-03-15', professional_category: '5ème catégorie', job_level: 'cadre', weekly_hours: '40.0' }]
      if (sql.includes('FROM "tenant_sotra".absences')) return [{ d: '2' }]
      if (sql.includes('absence_balances')) return [{ acquired: '22.0', taken: '5.0', remaining: '17.0' }]
      if (sql.includes('platform.tenants')) return [{ rccm: 'CI-ABJ-2010-B-0045', dgi_number: '1234567A' }]
      return []
    })
    const m = await loadPayslipMentions(db, 'tenant_sotra', 'emp-1', '2026-10')
    expect(m.employee).toEqual({ hireDate: '2019-03-15', category: '5ème catégorie' })
    expect(m.worked).toEqual({ days: 28, hours: 161.78 })
    expect(m.leaveBalance).toEqual({ year: 2026, acquired: 22, taken: 5, remaining: 17 })
    expect(m.employer).toEqual({ rccm: 'CI-ABJ-2010-B-0045', dgiNumber: '1234567A' })
    // Absences : bornées à la période, approuvées, non rémunérées.
    const absCall = db.query.mock.calls.find(c => String(c[0]).includes('.absences'))!
    expect(absCall[1]).toEqual(['emp-1', '2026-10-01', '2026-10-31'])
    expect(String(absCall[0])).toContain(`a.status = 'approved'`)
  })

  it('ne fait jamais échouer le bulletin : replis sur erreur DB', async () => {
    const db = dbWith(() => new Error('relation does not exist'))
    const m = await loadPayslipMentions(db, 'tenant_sotra', 'emp-1', '2026-02')
    expect(m.employee).toEqual({ hireDate: null, category: null })
    expect(m.worked).toEqual({ days: 30, hours: 173.33 })
    expect(m.leaveBalance).toBeNull()
    expect(m.employer).toEqual({ rccm: null, dgiNumber: null })
  })

  it('catégorie : repli sur le niveau de poste ; schéma non sûr refusé', async () => {
    const db = dbWith((sql) => sql.includes('employees') ? [{ hire_date: null, professional_category: null, job_level: 'agent_maitrise', weekly_hours: null }] : [])
    const m = await loadPayslipMentions(db, 'tenant_sotra', 'emp-1', '2026-10')
    expect(m.employee.category).toBe('agent_maitrise')
    await expect(loadPayslipMentions(db, 'x"; DROP', 'emp-1', '2026-10')).rejects.toThrow()
  })
})
