/**
 * Pages de contenu : les chiffres publiés doivent être ceux du moteur de paie.
 *
 * Les packs législatifs de l'API sont la source de vérité. Ce test les lit
 * directement : un taux, un plafond ou un barème modifié dans un pack sans
 * être reporté dans les pages publiques fait échouer la CI.
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { createElement } from 'react'
import { LEGISLATION_PACKS, CIV_2024 } from '../../../../../api/src/services/legislation-packs'
import { SEO_PATHS } from './paths'
import { SEO_PAGES, getSeoPage } from './content'
import { COUNTRY_FACTS } from './content-west-africa'
import { GUIDE_CNPS, GUIDE_ITS } from './content-ci'
import SeoContentPage from '../SeoContentPage'
import { contentJsonLd } from '@/prerender/entry'

const fmt = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const render = (path: string) =>
  renderToString(createElement(StaticRouter, { location: path }, createElement(SeoContentPage)))

/** ITS brut CI : chaque tranche taxée depuis la borne haute précédente. */
function itsBrut(brut: number): number {
  let tax = 0
  let prev = 0
  for (const t of CIV_2024.tranchesImpotSalaire) {
    const top = Math.min(brut, t.max)
    if (top > prev) tax += (top - prev) * t.taux
    prev = t.max
    if (brut <= t.max) break
  }
  return Math.round(tax)
}
const ricf = (parts: number) =>
  CIV_2024.reductionChargesFamille!.montantsParParts.find((x) => x.parts === parts)!.montant

function tableRows(page: typeof GUIDE_ITS, caption: RegExp): string[][] {
  for (const s of page.sections) for (const b of s.blocks) {
    if (b.type === 'table' && caption.test(b.caption)) return b.rows
  }
  throw new Error(`table ${caption} introuvable`)
}

describe('contenu des pages publiques', () => {
  it('une page de contenu par chemin, dans l’ordre', () => {
    expect(SEO_PAGES.map((p) => p.path)).toEqual([...SEO_PATHS])
  })

  it('maillage : chaque lien interne pointe vers une page publique existante', () => {
    const known = new Set<string>(['/', ...SEO_PATHS])
    for (const p of SEO_PAGES) {
      for (const r of p.related) expect(known.has(r), `${p.path} → ${r}`).toBe(true)
      for (const s of p.sections) for (const b of s.blocks) {
        if (b.type === 'links') for (const l of b.items) expect(known.has(l.to), `${p.path} → ${l.to}`).toBe(true)
      }
      if (p.alternate) expect(getSeoPage(p.alternate)?.alternate).toBe(p.path)
    }
  })

  it('chaque page est rendue avec son h1, son contenu et la FAQ annoncée dans le JSON-LD', () => {
    for (const p of SEO_PAGES) {
      const html = render(p.path)
      expect(html).toContain(p.h1.replace(/'/g, '&#x27;'))
      expect(html).toContain('Cocody, Rivièra Faya Lauriers 8')
      const ld = JSON.stringify(contentJsonLd(p))
      if (p.faq) {
        expect(ld).toContain('"FAQPage"')
        for (const f of p.faq) expect(html).toContain(f.q.replace(/'/g, '&#x27;'))
      } else {
        expect(ld).not.toContain('FAQPage')
      }
    }
  })

  it('chemin inconnu → aucune page (redirection vers l’accueil)', () => {
    expect(getSeoPage('/logiciel-paie-guinee')).toBeUndefined()
  })
})

describe('chiffres conformes aux packs législatifs', () => {
  it('pages pays : SMIG, taux, plafonds et congés = valeurs du pack', () => {
    for (const [key, f] of Object.entries(COUNTRY_FACTS)) {
      const pack = LEGISLATION_PACKS[f.pack]
      expect(pack, key).toBeDefined()
      expect(pack!.status, key).toBe('active')
      expect(pack!.currency, key).toBe(f.currency)
      expect(pack!.smigMensuel, key).toBe(f.smig)
      expect(pack!.tauxCotisationRetraiteSalarie, key).toBe(f.retraiteSal)
      expect(pack!.tauxCotisationRetraitePatronal, key).toBe(f.retraitePat)
      expect(pack!.tauxCotisationPfPatronal, key).toBe(f.pf)
      expect(pack!.plafondCnpsRetraite, key).toBe(f.plafondRetraite)
      expect(pack!.plafondCnpsAtPf, key).toBe(f.plafondAtPf)
      expect(pack!.leaveRules?.annualLeaveDaysPerMonth, key).toBe(f.congesParMois)
      expect(pack!.leaveRules?.workingDaysPerWeek, key).toBe(f.joursParSemaine)
    }
  })

  it('barèmes publiés (Burkina Faso, Bénin, Côte d’Ivoire) = barèmes des packs', () => {
    const check = (path: string, packCode: string) => {
      const page = getSeoPage(path)!
      const rows = page.sections.flatMap((s) => s.blocks)
        .find((b) => b.type === 'table' && /Barème/.test(b.caption))
      expect(rows?.type).toBe('table')
      const rates = (rows as { rows: string[][] }).rows.map((r) => Number(r[1]!.replace(' %', '').replace(',', '.')) / 100)
      const expected = LEGISLATION_PACKS[packCode]!.tranchesImpotSalaire.map((t) => t.taux)
      expect(rates.map((x) => Math.round(x * 1000))).toEqual(expected.map((x) => Math.round(x * 1000)))
    }
    check('/logiciel-paie-burkina-faso', 'BFA-2024')
    check('/logiciel-paie-benin', 'BEN-2024')
    check('/guides/calcul-its-2024-cote-divoire', 'CIV-2024')
  })

  it('guide ITS : exemples recalculés depuis le barème et la RICF du pack CI', () => {
    const rows = tableRows(GUIDE_ITS, /ITS mensuel selon/)
    for (const [brutStr, brutItsStr, seul, marie] of rows) {
      const brut = Number(brutStr!.replace(/ /g, ''))
      const b = itsBrut(brut)
      expect(brutItsStr).toBe(fmt(b))
      expect(seul).toBe(fmt(Math.max(0, b - ricf(1))))
      expect(marie).toBe(fmt(Math.max(0, b - ricf(3))))
    }
    const r = tableRows(GUIDE_ITS, /Réduction mensuelle/)
    expect(r.map((x) => x[1])).toEqual(CIV_2024.reductionChargesFamille!.montantsParParts.map((x) => fmt(x.montant)))
  })

  it('guide CNPS : exemple à 2 000 000 FCFA recalculé (double plafond)', () => {
    const p = CIV_2024
    const rows = tableRows(GUIDE_CNPS, /Cotisations CNPS mensuelles/)
    const base = Math.min(2_000_000, p.plafondCnpsRetraite)
    const small = Math.min(2_000_000, p.plafondCnpsAtPf)
    const expected = [
      Math.round(base * p.tauxCotisationRetraiteSalarie),
      Math.round(base * p.tauxCotisationRetraitePatronal),
      Math.round(small * p.tauxCotisationPfPatronal),
      Math.round(small * p.tauxCotisationMaternitePatronal),
      Math.round(small * p.tauxAtDefaultPatronal),
    ]
    expect(rows.map((r) => r[3])).toEqual(expected.map(fmt))
    expect(rows[0]![1]).toBe(fmt(p.plafondCnpsRetraite))
    expect(rows[2]![1]).toBe(fmt(p.plafondCnpsAtPf))
  })
})
