import { describe, it, expect } from 'vitest'
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
    activeUsers: 10, usersLoggedIn: 7, lastLoginAt: new Date('2026-09-05T10:00:00Z'),
    loginSuccess: 40, loginFailed: 2, loginLocked: 0, mfaRequired: 1,
    auditWrites: 300, loginsByDay: { '2026-09-05': 40 }, ...over,
  }
}
const data = (tenants: TenantStats[]): ReportData =>
  ({ period, generatedAt: NOW, tenants, agencies: [], trend: [] })

describe('analyze', () => {
  it('alerte sur une entreprise sans connexion depuis 14 jours', () => {
    const a = analyze(data([tenant({ lastLoginAt: new Date('2026-08-01T00:00:00Z') })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('connexion'))).toBe(true)
  })

  it('n alerte pas une entreprise jamais connectée créée il y a 2 jours', () => {
    const a = analyze(data([tenant({
      lastLoginAt: null,
      createdAt: new Date('2026-09-04T06:00:00Z'),
    })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('connexion'))).toBe(false)
  })

  it('alerte une entreprise jamais connectée créée il y a 60 jours, avec un libellé lié à la création', () => {
    const a = analyze(data([tenant({
      lastLoginAt: null,
      createdAt: new Date('2026-07-08T06:00:00Z'),
    })]), NOW)
    const alerte = a.alerts.find(x => x.detail.includes('connexion'))
    expect(alerte).toBeDefined()
    expect(alerte?.detail).toContain('création')
  })

  it('alerte sur un essai arrivant a echéance sous 14 jours', () => {
    const a = analyze(data([tenant({ status: 'trial', trialEndsAt: new Date('2026-09-10T00:00:00Z') })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('essai'))).toBe(true)
  })

  it('alerte quand un plafond est atteint a 90 %', () => {
    const a = analyze(data([tenant({ headcount: 140, maxEmployees: 150 })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('plafond'))).toBe(true)
  })

  it('alerte quand l effectif baisse sur la periode', () => {
    const a = analyze(data([tenant({ hires: 0, departures: 4 })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('effectif'))).toBe(true)
  })

  it('signale les tenants dont la collecte a échoué', () => {
    const a = analyze(data([tenant({ collected: false })]), NOW)
    expect(a.unavailable).toContain('SOTRA')
    expect(a.alerts.some(x => x.severity === 'high')).toBe(true)
  })

  it('n invente rien quand il n y a aucune donnée', () => {
    const a = analyze(data([]), NOW)
    expect(a.totals.tenants).toBe(0)
    expect(a.alerts).toEqual([])
    expect(a.byPlan).toEqual([])
  })

  it('classe les entreprises par échecs de connexion décroissants', () => {
    const a = analyze(data([
      tenant({ tenantId: 'a', name: 'A', loginFailed: 2 }),
      tenant({ tenantId: 'b', name: 'B', loginFailed: 9 }),
    ]), NOW)
    expect(a.topFailures[0]?.label).toBe('B')
  })
})
