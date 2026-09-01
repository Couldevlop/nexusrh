import { describe, it, expect } from 'vitest'
import { renderHtml, renderText, escapeHtml } from './render-html.js'
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
    loginSuccess: 40, blockedOffline: 0, mfaRequired: 1,
    auditWrites: 300, loginsByDay: { '2026-09-05': 40 }, ...over,
  }
}

/** Champs communs à toutes les fixtures : total plateforme, parc complet. */
const RESTE = {
  platformAuth: { loginFailed: 0, loginLocked: 0 }, truncated: false, trend: [],
}

describe('escapeHtml', () => {
  it('neutralise les caracteres actifs', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">&'`))
      .toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;')
  })
})

describe('renderHtml', () => {
  const data: ReportData = { period, generatedAt: NOW, tenants: [tenant()], agencies: [], ...RESTE }

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
    const vide: ReportData = { period, generatedAt: NOW, tenants: [], agencies: [], ...RESTE }
    expect(renderHtml(vide, analyze(vide, NOW))).toContain('Aucune')
  })

  it('dit la vérité sur la portée des échecs de connexion', () => {
    const avecEchecs: ReportData = { ...data, platformAuth: { loginFailed: 12, loginLocked: 3 } }
    const html = renderHtml(avecEchecs, analyze(avecEchecs, NOW))
    expect(html).toContain('ensemble de la plateforme')
    expect(html).toContain('12')
    // Le tableau par entreprise ne doit plus afficher de colonne « Échecs » :
    // ces échecs ne sont pas attribuables à une entreprise.
    expect(html).not.toContain('<th style="text-align:left;padding:6px 8px;background:#0f2a44;color:#fff;font-weight:600">Échecs</th>')
  })

  it('affiche la variation d’effectif et le volume d’activité', () => {
    const html = renderHtml(data, analyze(data, NOW))
    expect(html).toContain('variation')
    expect(html).toContain("écritures d'audit")
  })
})

describe('renderText', () => {
  const data: ReportData = { period, generatedAt: NOW, tenants: [tenant()], agencies: [], ...RESTE }

  it('produit un corps texte non vide, pour les clients en mode texte', () => {
    const texte = renderText(data, analyze(data, NOW))
    expect(texte.length).toBeGreaterThan(100)
    expect(texte).toContain('SOTRA')
    expect(texte).toContain('ENSEMBLE DE LA PLATEFORME')
    expect(texte).not.toContain('<')
  })
})
