import { describe, it, expect } from 'vitest'
import { renderHtml, escapeHtml } from './render-html.js'
import { analyze } from './analyze.js'
import { weeklyPeriod } from './period.js'
import type { ReportData, TenantStats } from './types.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const NOW = new Date('2026-09-06T06:00:00Z')

function tenant(over: Partial<TenantStats> = {}): TenantStats {
  return {
    tenantId: 't1', name: 'SOTRA', schemaName: 'tenant_sotra', status: 'active',
    planType: 'business', sector: 'transport', maxUsers: 100, maxEmployees: 150,
    trialEndsAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), collected: true,
    headcount: 82, hires: 3, departures: 1, hiresByContract: { cdi: 3 },
    activeUsers: 10, usersLoggedIn: 7, lastLoginAt: NOW,
    loginSuccess: 40, loginFailed: 2, loginLocked: 0, mfaRequired: 1,
    auditWrites: 300, loginsByDay: { '2026-09-05': 40 }, ...over,
  }
}

describe('escapeHtml', () => {
  it('neutralise les caracteres actifs', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">&'`))
      .toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;')
  })
})

describe('renderHtml', () => {
  const data: ReportData = { period, generatedAt: NOW, tenants: [tenant()], agencies: [], trend: [] }

  it('presente les sections attendues', () => {
    const html = renderHtml(data, analyze(data, NOW))
    for (const section of ['Vue plateforme', 'Cabinets', 'Entreprises', 'Connexions', 'attention']) {
      expect(html).toContain(section)
    }
  })

  it('echappe un nom d\'entreprise hostile', () => {
    const hostile: ReportData = { ...data, tenants: [tenant({ name: '<script>alert(1)</script>' })] }
    const html = renderHtml(hostile, analyze(hostile, NOW))
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('le dit explicitement quand il n\'y a aucune donnee', () => {
    const vide: ReportData = { period, generatedAt: NOW, tenants: [], agencies: [], trend: [] }
    expect(renderHtml(vide, analyze(vide, NOW))).toContain('Aucune')
  })
})
