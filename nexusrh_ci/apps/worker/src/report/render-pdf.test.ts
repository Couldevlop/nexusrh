import { describe, it, expect } from 'vitest'
import { renderPdf } from './render-pdf.js'
import { analyze } from './analyze.js'
import { weeklyPeriod } from './period.js'
import type { ReportData, TenantStats } from './types.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const NOW = new Date('2026-09-06T06:00:00Z')

function tenant(i: number): TenantStats {
  return {
    tenantId: `t${i}`, name: `Entreprise ${i}`, schemaName: `tenant_${i}`, status: 'active',
    planType: 'business', sector: 'transport', maxUsers: 100, maxEmployees: 150,
    trialEndsAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), collected: true,
    headcount: 100 - i, hires: 1, departures: 0, hiresByContract: { cdi: 1 },
    activeUsers: 10, usersLoggedIn: 7, lastLoginAt: NOW,
    loginSuccess: 40, loginFailed: i, loginLocked: 0, mfaRequired: 0,
    auditWrites: 100, loginsByDay: { '2026-09-05': 40 },
  }
}

describe('renderPdf', () => {
  it('produit un document PDF valide', async () => {
    const data: ReportData = { period, generatedAt: NOW, tenants: [tenant(1)], agencies: [] }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    expect(pdf.byteLength).toBeGreaterThan(1000)
  })

  it('reste borné quand le parc dépasse 50 entreprises', async () => {
    const many = Array.from({ length: 120 }, (_, i) => tenant(i + 1))
    const data: ReportData = { period, generatedAt: NOW, tenants: many, agencies: [] }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    // Borne des 50 : le document ne doit pas croître linéairement sans fin.
    expect(pdf.byteLength).toBeLessThan(2_000_000)
  })

  it('produit un document même sans aucune donnée', async () => {
    const data: ReportData = { period, generatedAt: NOW, tenants: [], agencies: [] }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
  })
})
