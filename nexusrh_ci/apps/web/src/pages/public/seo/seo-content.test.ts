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
import { COUNTRY_FACTS, PAYROLL_PENDING_FR, PAYROLL_PENDING_EN } from './content-west-africa'
import { GUIDE_CNPS, GUIDE_ITS } from './content-ci'
import SeoContentPage from '../SeoContentPage'
import frHome from '@/i18n/locales/fr/home.json'
import enHome from '@/i18n/locales/en/home.json'
import { contentJsonLd } from '@/prerender/entry'
import { PROOF_CNPS } from '../home-content'

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

  it('page « SaaS ou on-premise » : FR et EN réciproques, deux modes, sans restriction de pays sur l’hébergement', () => {
    const fr = getSeoPage('/sirh-saas-ou-on-premise')!
    const en = getSeoPage('/en/hris-saas-or-on-premise')!
    expect(fr.alternate).toBe(en.path)
    expect(en.alternate).toBe(fr.path)
    const html = render(fr.path)
    expect(html).toContain('Le mode SaaS')
    expect(html).toContain('Le mode on-premise')
    expect(html).toContain('Installé sur vos serveurs ou dans le datacenter de votre choix.')
    const onPrem = [fr, en].flatMap((p) => p.sections.filter((s) => s.id === 'on-premise' || s.h2 === 'Comparatif' || s.h2 === 'Comparison'))
    expect(JSON.stringify(onPrem)).not.toMatch(/Côte d['’]Ivoire|ivoirien|Ivorian/i)
  })

  it('les pages ivoiriennes renvoient vers la couverture UEMOA', () => {
    for (const p of ['/logiciel-paie-cote-divoire', '/gestion-conges-cote-divoire', '/paiement-salaires-mobile-money',
      '/guides/calcul-its-2024-cote-divoire', '/guides/cotisations-cnps-2024'] as const) {
      expect(getSeoPage(p)!.related, p).toContain('/sirh-afrique-ouest')
    }
  })

  it('marque « NexusRH » et coordonnées à jour sur toutes les pages de contenu', () => {
    for (const p of SEO_PAGES) {
      const html = render(p.path)
      const all = JSON.stringify(p) + html
      expect(all, p.path).not.toMatch(/NexusRH CI/)
      expect(all, p.path).not.toMatch(/07 ?09 ?32 ?05 ?94|0709320594/)
      expect(html, p.path).toContain('href="tel:+2250709334238"')
      expect(html, p.path).toContain('href="https://wa.me/2250749439203"')
    }
  })

  it('hub Afrique de l’Ouest : formulation de couverture validée, sans pays hors UEMOA', () => {
    for (const p of [getSeoPage('/sirh-afrique-ouest')!, getSeoPage('/en/hris-payroll-west-africa')!]) {
      const all = JSON.stringify(p)
      expect(all).toMatch(/Paie : Côte d'Ivoire et UEMOA, extensible aux autres pays de la CEDEAO et de la CEMAC|Payroll: Côte d'Ivoire and WAEMU, extendable to other ECOWAS and CEMAC countries/)
      expect(all).not.toMatch(/Ghana|Nigeria|Cameroun|Cameroon|Gabon/)
    }
  })

  it('chemin inconnu → aucune page (redirection vers l’accueil)', () => {
    expect(getSeoPage('/logiciel-paie-guinee')).toBeUndefined()
  })
})

describe('chiffres conformes aux packs législatifs', () => {
  it("pays UEMOA hors Côte d'Ivoire : données de paie en cours de vérification, aucun chiffre publié", () => {
    // Les chiffres de paie des pays autres que la Côte d'Ivoire ne sont pas encore vérifiés :
    // aucune page n'en publie. Pour réactiver un pays : passer son `payroll` à 'verified' dans
    // COUNTRY_FACTS, remettre ses tableaux, puis ajouter ici la comparaison de ses chiffres
    // au pack (SMIG, taux, plafonds, barème, congés), sur le modèle du guide ITS ci-dessous.
    for (const [key, f] of Object.entries(COUNTRY_FACTS)) {
      const pack = LEGISLATION_PACKS[f.pack]
      expect(pack, key).toBeDefined()
      expect(pack!.status, key).toBe('active')
      expect(pack!.currency, key).toBe(f.currency)
      expect(f.payroll, key).toBe(key === 'CIV' ? 'verified' : 'pending')
    }
    const figure = /\d+(,\d+)? ?%|\d{1,3}( \d{3})+|\d{4,}|\d+(,\d+)? jours?|\d+ (heures|semaines)/
    for (const path of ['/logiciel-paie-senegal', '/logiciel-paie-burkina-faso', '/logiciel-paie-benin']) {
      const page = getSeoPage(path)!
      const text = JSON.stringify({ ...page, updated: '' })
      expect(text, path).toContain(PAYROLL_PENDING_FR)
      expect(text, path).not.toMatch(figure)
      expect(page.sections.flatMap((s) => s.blocks).some((b) => b.type === 'table'), path).toBe(false)
    }
    for (const [path, pending] of [['/sirh-afrique-ouest', PAYROLL_PENDING_FR], ['/en/hris-payroll-west-africa', PAYROLL_PENDING_EN]] as const) {
      const page = getSeoPage(path)!
      const rows = page.sections.flatMap((s) => s.blocks).flatMap((b) => (b.type === 'table' ? b.rows : []))
      expect(rows).toHaveLength(8)
      for (const r of rows.slice(1)) expect(r[3], `${path} ${r[0]}`).toBe(pending)
      expect(JSON.stringify(rows.slice(1)), path).not.toMatch(figure)
      expect(JSON.stringify({ ...page, updated: '' }), path).not.toMatch(/FCFA/)
    }
  })

  it('hub : liens uniquement vers les pages pays existantes', () => {
    const page = getSeoPage('/sirh-afrique-ouest')!
    const links = page.sections.flatMap((s) => s.blocks).flatMap((b) => (b.type === 'links' ? b.items : []))
    for (const l of links) expect(getSeoPage(l.to), l.to).toBeDefined()
    expect(JSON.stringify(SEO_PAGES)).not.toMatch(/sur la page du pays|on each country page/)
  })

  it("barème ITS publié (Côte d'Ivoire) = barème du pack", () => {
    const page = getSeoPage('/guides/calcul-its-2024-cote-divoire')!
    const rows = page.sections.flatMap((s) => s.blocks)
      .find((b) => b.type === 'table' && /Barème/.test(b.caption))
    expect(rows?.type).toBe('table')
    const rates = (rows as { rows: string[][] }).rows.map((r) => Number(r[1]!.replace(' %', '').replace(',', '.')) / 100)
    const expected = CIV_2024.tranchesImpotSalaire.map((t) => t.taux)
    expect(rates.map((x) => Math.round(x * 1000))).toEqual(expected.map((x) => Math.round(x * 1000)))
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

  it('guide CNPS : exemple à 2 000 000 FCFA recalculé (double plafond, CMU)', () => {
    const p = CIV_2024
    const rows = tableRows(GUIDE_CNPS, /Cotisations CNPS mensuelles/)
    const base = Math.min(2_000_000, p.plafondCnpsRetraite)
    const small = Math.min(2_000_000, p.plafondCnpsAtPf)
    const expected = [
      // Le moteur de paie arrondit à l'entier inférieur : 75 000 x 0,75 % = 562,5 -> 562.
      Math.floor(base * p.tauxCotisationRetraiteSalarie),
      Math.floor(base * p.tauxCotisationRetraitePatronal),
      Math.floor(small * p.tauxCotisationPfPatronal),
      Math.floor(small * p.tauxCotisationMaternitePatronal),
      Math.floor(small * p.tauxAtDefaultPatronal),
    ]
    expect(rows.slice(0, 5).map((r) => r[3])).toEqual(expected.map(fmt))
    expect(rows[0]![1]).toBe(fmt(base))
    expect(rows[2]![1]).toBe(fmt(small))
    // CMU (loi n° 2014-131) : 1 000 FCFA par bénéficiaire, moitié salarié, moitié employeur.
    expect(rows[5]).toEqual(['CMU (1 bénéficiaire)', '1 000 par bénéficiaire', '50 % / 50 %', '500 + 500'])
    const total = (xs: number[]) => fmt(xs.reduce((a, b) => a + b, 0))
    const note = GUIDE_CNPS.sections.flatMap((s) => s.blocks).find((b) => b.type === 'table' && /mensuelles/.test(b.caption))
    expect(note?.type === 'table' ? note.note : '').toContain(`Total salarié : ${total([expected[0]!, 500])} FCFA`)
    expect(note?.type === 'table' ? note.note : '').toContain(`Total employeur : ${total([...expected.slice(1), 500])} FCFA`)
  })

  it('vitrine : démonstration du double plafond recalculée depuis le pack CIV-2024', () => {
    const p = CIV_2024
    const g = PROOF_CNPS.gross
    const pct = (t: number) => `${(t * 100).toFixed(1).replace('.', ',')} %`
    const retraite = Math.min(g, p.plafondCnpsRetraite)
    const atPf = Math.min(g, p.plafondCnpsAtPf)
    const trancheHaute = p.tranchesImpotSalaire.find((t) => g <= t.max)!
    const expected = {
      '2000': [fmt(retraite), pct(p.tauxCotisationRetraiteSalarie), fmt(Math.floor(retraite * p.tauxCotisationRetraiteSalarie))],
      '3300': [fmt(atPf), pct(p.tauxAtDefaultPatronal), fmt(Math.floor(atPf * p.tauxAtDefaultPatronal))],
      '3100': [fmt(atPf), pct(p.tauxCotisationPfPatronal), fmt(Math.floor(atPf * p.tauxCotisationPfPatronal))],
      '2100': [fmt(g), `0→${Math.round(trancheHaute.taux * 100)} %`, fmt(itsBrut(g))],
    }
    expect(Object.fromEntries(PROOF_CNPS.rows.map((r) => [r.code, [r.base, r.rate, r.amount]]))).toEqual(expected)
    // Compteur des chiffres clés et notes affichées sous les rubriques.
    expect(PROOF_CNPS.retirementCeiling).toBe(p.plafondCnpsRetraite)
    expect(frHome.proof.rows.retirementNote).toContain(fmt(p.plafondCnpsRetraite))
    expect(frHome.proof.rows.accidentNote).toContain(fmt(p.plafondCnpsAtPf))
    expect(enHome.proof.rows.retirementNote).toContain(p.plafondCnpsRetraite.toLocaleString('en-US'))
    expect(enHome.proof.rows.accidentNote).toContain(p.plafondCnpsAtPf.toLocaleString('en-US'))
    expect(frHome.proof.case).toContain(fmt(g))
    expect(enHome.proof.case).toContain(g.toLocaleString('en-US'))
  })

  it('plafonds CNPS publiés partout (vitrine, FAQ, pages CI) : 3 375 000 et 75 000, plus aucun ancien plafond', () => {
    const all = JSON.stringify(SEO_PAGES) + JSON.stringify(frHome) + JSON.stringify(enHome)
    expect(all).not.toMatch(/1 647 315|1,647,315|1647315|70 000 FCFA|70,000 FCFA/)
    expect(JSON.stringify(frHome.faq.items.compliance)).toContain('3 375 000')
    expect(JSON.stringify(frHome.faq.items.compliance)).toContain('75 000')
    expect(JSON.stringify(frHome.compliance.cnps)).toContain('CMU')
  })
})
