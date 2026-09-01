import { describe, it, expect } from 'vitest'
import { renderPdf, texte } from './render-pdf.js'
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
    loginSuccess: 40, blockedOffline: 0, mfaRequired: 0,
    auditWrites: 100, loginsByDay: { '2026-09-05': 40 },
  }
}

/** Champs communs à toutes les fixtures : total plateforme, parc complet. */
const RESTE = {
  platformAuth: { loginFailed: 0, loginLocked: 0 }, truncated: false, trend: [],
}

describe('renderPdf', () => {
  it('produit un document PDF valide', async () => {
    const data: ReportData = { period, generatedAt: NOW, tenants: [tenant(1)], agencies: [], ...RESTE }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    expect(pdf.byteLength).toBeGreaterThan(1000)
  })

  it('reste borné quand le parc dépasse 50 entreprises', async () => {
    const many = Array.from({ length: 120 }, (_, i) => tenant(i + 1))
    const data: ReportData = { period, generatedAt: NOW, tenants: many, agencies: [], ...RESTE }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    // Borne des 50 : le document ne doit pas croître linéairement sans fin.
    expect(pdf.byteLength).toBeLessThan(2_000_000)
  })

  it('produit un document même sans aucune donnée', async () => {
    const data: ReportData = { period, generatedAt: NOW, tenants: [], agencies: [], ...RESTE }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
  })
  it('rend un nom d’entreprise hors WinAnsi sans lever, plutôt que de perdre le rapport', async () => {
    // « ɛ », « ɔ » et « ŋ » appartiennent aux orthographes baoulé et dioula ;
    // un emoji ou un idéogramme arrive par un simple copier-coller. Helvetica
    // ne les encode pas : sans assainissement, pdf-lib lève et le rapport
    // n'est JAMAIS envoyé, à cause d'un seul nom saisi par un client.
    const hostile = {
      ...tenant(1),
      name: 'Sɔcietɛ Baoulɛ ŋ 🚍 東京 ' + 'x'.repeat(120),
      sector: 'transpɔrt', planType: 'businɛss',
    }
    const data: ReportData = {
      period, generatedAt: NOW, tenants: [hostile],
      agencies: [{
        agencyId: 'a1', name: 'Cabinet ɛxpertise 🏢', status: 'active',
        tenantIds: ['t1'], managedTenants: 1, headcount: 99, attached: 1, detached: 0,
      }],
      ...RESTE,
    }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    expect(pdf.byteLength).toBeGreaterThan(1000)
  })

  it('dessine les deux graphiques d’évolution quand la tendance n’est pas vide', async () => {
    const trend = Array.from({ length: 12 }, (_, i) => ({
      label: `2026-${String(i + 1).padStart(2, '0')}-01`, hires: i, logins: i * 7,
    }))
    const data: ReportData = {
      period, generatedAt: NOW, tenants: [tenant(1)], agencies: [], ...RESTE, trend,
    }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    // Une tendance dessinée pèse plus qu'une tendance vide : c'est la preuve
    // la plus simple que les barres ont bien été tracées.
    const vide: ReportData = { period, generatedAt: NOW, tenants: [tenant(1)], agencies: [], ...RESTE }
    const pdfVide = await renderPdf(vide, analyze(vide, NOW))
    expect(pdf.byteLength).toBeGreaterThan(pdfVide.byteLength)
  })

  it('porte les points d’attention, qui n’étaient que dans le mail', async () => {
    const data: ReportData = {
      period, generatedAt: NOW,
      tenants: [{ ...tenant(1), collected: false }], agencies: [], ...RESTE,
    }
    const analyse = analyze(data, NOW)
    expect(analyse.alerts.length).toBeGreaterThan(0)
    const pdf = await renderPdf(data, analyse)
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
  })

  it('ne transforme pas la puce des points d’attention en « ? » parasite', () => {
    // Régression : la puce « • » (U+2022) dépasse 0xFF et se faisait avaler
    // par le remplacement générique par `?` dans `texte()`, avant même
    // d'atteindre pdf-lib — chaque ligne de « Points d'attention » affichait
    // donc « ? SOTRA — détail » au lieu de « - SOTRA — détail ».
    const rendu = texte('• SOTRA — données indisponibles')
    expect(rendu).not.toContain('?')
    expect(rendu).toContain('- SOTRA')
  })
})
