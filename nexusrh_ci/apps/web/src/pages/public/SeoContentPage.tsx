/**
 * Pages publiques de contenu (pages d'atterrissage + guides), pré-générées au
 * build pour les moteurs de recherche (src/prerender/entry.tsx).
 *
 * Mêmes contraintes que la vitrine : page INERTE (aucun appel API, aucune
 * donnée de tenant), aucune ressource externe (CSP `default-src 'self'`),
 * palette autonome. Le contenu est de la donnée (./seo/content) : le texte
 * affiché, les métadonnées et le JSON-LD viennent du même objet.
 */
import { useEffect } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { getSeoPage } from './seo/content'
import type { SeoBlock, SeoPageContent } from './seo/types'

const EMAIL    = 'waopron@openlabconsulting.com'
const PHONE_CI = '+225 07 09 32 05 94'
const WHATSAPP = 'https://wa.me/2250709320594'

const MONTHS = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
} as const

/** AAAA-MM-JJ → « 29 octobre 2026 » / « 29 October 2026 », sans dépendre de l'Intl de l'hôte. */
export function formatDate(iso: string, lang: 'fr' | 'en'): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[lang][(m ?? 1) - 1]} ${y}`
}

const UI = {
  fr: {
    home: 'Accueil', demo: 'Demander une démo', updated: 'Mis à jour le', faq: 'Questions fréquentes',
    related: 'À lire aussi', ctaTitle: 'Voir NexusRH CI sur vos propres cas de paie',
    ctaText: 'Une démonstration avec vos rubriques, vos catégories et vos filiales, par l’équipe d’OpenLab Consulting à Abidjan.',
    solutions: 'Solutions', guides: 'Guides', legal: 'Informations légales', contact: 'Contact', crumbs: 'Fil d’Ariane',
    address: 'Cocody, Rivièra Faya Lauriers 8, Abidjan, Côte d’Ivoire', skip: 'Aller au contenu',
  },
  en: {
    home: 'Home', demo: 'Request a demo', updated: 'Updated', faq: 'Frequently asked questions',
    related: 'Read next', ctaTitle: 'See NexusRH CI run your own payroll cases',
    ctaText: 'A demo with your pay items, job grades and subsidiaries, by the OpenLab Consulting team in Abidjan.',
    solutions: 'Solutions', guides: 'Guides (in French)', legal: 'Legal', contact: 'Contact', crumbs: 'Breadcrumb',
    address: 'Cocody, Rivièra Faya Lauriers 8, Abidjan, Côte d’Ivoire', skip: 'Skip to content',
  },
} as const

/** Maillage du pied de page : toutes les pages de contenu + vitrine. */
const FOOTER_SOLUTIONS = [
  { to: '/', label: "SIRH Côte d'Ivoire" },
  { to: '/logiciel-paie-cote-divoire', label: "Logiciel de paie Côte d'Ivoire" },
  { to: '/gestion-conges-cote-divoire', label: 'Gestion des congés' },
  { to: '/paiement-salaires-mobile-money', label: 'Salaires par Mobile Money' },
  { to: '/sirh-afrique-ouest', label: "SIRH Afrique de l'Ouest" },
  { to: '/logiciel-paie-senegal', label: 'Paie Sénégal' },
  { to: '/logiciel-paie-burkina-faso', label: 'Paie Burkina Faso' },
  { to: '/logiciel-paie-benin', label: 'Paie Bénin' },
  { to: '/en/hris-payroll-west-africa', label: 'HRIS West Africa (English)' },
]
const FOOTER_GUIDES = [
  { to: '/guides/calcul-its-2024-cote-divoire', label: "Calcul de l'ITS 2024" },
  { to: '/guides/cotisations-cnps-2024', label: 'Cotisations CNPS 2024' },
]

function Block({ block }: { block: SeoBlock }) {
  switch (block.type) {
    case 'p':
      return <p className="mt-4 text-[15px] leading-relaxed text-[#3F4B56]">{block.text}</p>
    case 'ul':
      return (
        <ul className="mt-4 space-y-2.5">
          {block.items.map((it) => (
            <li key={it} className="flex gap-3 text-[15px] leading-relaxed text-[#3F4B56]">
              <span aria-hidden className="mt-[0.6em] h-1.5 w-1.5 shrink-0 bg-[#F04E10]" />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <div className="mt-5 overflow-x-auto rounded-lg border border-[#E4E8EB]">
          <table className="w-full text-sm">
            <caption className="border-b border-[#E4E8EB] bg-[#F7F8F9] px-4 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[#5A6672]">
              {block.caption}
            </caption>
            <thead>
              <tr className="border-b border-[#E4E8EB] text-left">
                {block.head.map((h) => <th key={h} scope="col" className="px-4 py-2.5 font-semibold text-[#0F1214]">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i} className="border-b border-[#EDF0F2] last:border-0">
                  {r.map((c, j) => (
                    <td key={j} className={`px-4 py-2.5 ${j === 0 ? 'font-medium text-[#0F1214]' : 'tabular-nums text-[#3F4B56]'}`}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.note && <p className="border-t border-[#E4E8EB] px-4 py-2.5 text-xs leading-relaxed text-[#5A6672]">{block.note}</p>}
        </div>
      )
    case 'links':
      return (
        <ul className="mt-5 flex flex-wrap gap-3">
          {block.items.map((l) => (
            <li key={l.to}>
              <Link to={l.to} className="inline-block rounded-lg border border-[#E4E8EB] px-4 py-2 text-sm font-semibold text-[#C43C08] transition-colors hover:border-[#F04E10] hover:bg-[#FFF3EE]">
                {l.label} <span aria-hidden>→</span>
              </Link>
            </li>
          ))}
        </ul>
      )
  }
}

function Page({ page }: { page: SeoPageContent }) {
  const ui = UI[page.lang]

  // Navigation interne (SPA) : le document garde sinon le titre du gabarit.
  useEffect(() => {
    document.title = page.title
    document.documentElement.lang = page.lang
    document.querySelector('meta[name="description"]')?.setAttribute('content', page.description)
  }, [page])

  return (
    <div className="min-h-screen bg-white text-[#0F1214] antialiased">
      <a href="#contenu" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-[#0F1214] focus:px-4 focus:py-2 focus:text-white">
        {ui.skip}
      </a>
      <header className="border-b border-[#E4E8EB] bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link to="/" className="flex items-center gap-3">
            <img src="/openlab.png" alt="OpenLab Consulting" width="108" height="36" className="h-9 w-auto" />
            <span className="hidden h-7 w-px bg-[#E4E8EB] sm:block" />
            <span className="hidden text-[15px] font-bold tracking-tight sm:inline">NexusRH <span className="text-[#F04E10]">CI</span></span>
          </Link>
          <a href="/#demo" className="rounded-lg bg-[#F04E10] px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-[#C43C08]">
            {ui.demo}
          </a>
        </div>
      </header>

      <main id="contenu" className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <nav aria-label={ui.crumbs} className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#8A97A3]">
          <ol className="flex flex-wrap items-center gap-2">
            <li><Link to="/" className="hover:text-[#F04E10]">{ui.home}</Link></li>
            <li aria-hidden>/</li>
            <li aria-current="page" className="text-[#5A6672]">{page.crumb}</li>
          </ol>
        </nav>

        <article className="mt-6">
          <h1 className="text-3xl font-bold leading-tight tracking-[-0.02em] sm:text-[2.6rem]">{page.h1}</h1>
          <p className="mt-5 text-lg leading-relaxed text-[#5A6672]">{page.lead}</p>
          <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-[#8A97A3]">
            {ui.updated} <time dateTime={page.updated}>{formatDate(page.updated, page.lang)}</time> · OpenLab Consulting
          </p>

          {page.sections.map((s) => (
            <section key={s.h2} id={s.id} className="mt-12 scroll-mt-6">
              <h2 className="border-l-4 border-[#F04E10] pl-4 text-xl font-bold tracking-tight sm:text-2xl">{s.h2}</h2>
              {s.blocks.map((b, i) => <Block key={i} block={b} />)}
            </section>
          ))}

          {page.faq && page.faq.length > 0 && (
            <section className="mt-14">
              <h2 className="border-l-4 border-[#F04E10] pl-4 text-xl font-bold tracking-tight sm:text-2xl">{ui.faq}</h2>
              <div className="mt-5 divide-y divide-[#E4E8EB] border-y border-[#E4E8EB]">
                {page.faq.map((f) => (
                  <div key={f.q} className="py-5">
                    <h3 className="text-[15px] font-bold">{f.q}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-[#3F4B56]">{f.a}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </article>

        <aside className="mt-14 rounded-xl border-2 border-[#0F1214] p-6 shadow-[8px_8px_0_0_#F04E10] sm:p-8">
          <p className="text-lg font-bold">{ui.ctaTitle}</p>
          <p className="mt-2 text-sm leading-relaxed text-[#5A6672]">{ui.ctaText}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <a href="/#demo" className="rounded-lg bg-[#F04E10] px-5 py-3 text-sm font-bold text-white hover:bg-[#C43C08]">{ui.demo}</a>
            <a href={WHATSAPP} target="_blank" rel="noreferrer noopener" className="rounded-lg border-2 border-[#0F1214] px-5 py-2.5 text-sm font-bold tabular-nums hover:bg-[#0F1214] hover:text-white">
              WhatsApp {PHONE_CI}
            </a>
          </div>
        </aside>

        {page.related.length > 0 && (
          <nav aria-label={ui.related} className="mt-14">
            <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[#F04E10]">{ui.related}</p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {page.related.map((p) => {
                const target = getSeoPage(p)
                return target ? (
                  <li key={p}>
                    <Link to={p} className="block h-full rounded-lg border border-[#E4E8EB] p-4 transition-colors hover:border-[#F04E10]">
                      <span className="block text-sm font-bold">{target.h1}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-[#5A6672]">{target.description}</span>
                    </Link>
                  </li>
                ) : null
              })}
            </ul>
          </nav>
        )}
      </main>

      <footer className="border-t-2 border-[#0F1214] bg-[#F7F8F9]">
        <div className="mx-auto grid max-w-5xl gap-8 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          <nav aria-label={ui.solutions}>
            <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">{ui.solutions}</p>
            <ul className="space-y-2 text-sm text-[#5A6672]">
              {FOOTER_SOLUTIONS.map((l) => <li key={l.to}><Link to={l.to} className="hover:text-[#F04E10]">{l.label}</Link></li>)}
            </ul>
          </nav>
          <nav aria-label={ui.guides}>
            <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">{ui.guides}</p>
            <ul className="space-y-2 text-sm text-[#5A6672]">
              {FOOTER_GUIDES.map((l) => <li key={l.to}><Link to={l.to} className="hover:text-[#F04E10]">{l.label}</Link></li>)}
            </ul>
          </nav>
          <nav aria-label={ui.legal}>
            <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">{ui.legal}</p>
            <ul className="space-y-2 text-sm text-[#5A6672]">
              <li><Link to="/legal/mentions-legales" className="hover:text-[#F04E10]">Mentions légales</Link></li>
              <li><Link to="/legal/confidentialite" className="hover:text-[#F04E10]">Confidentialité</Link></li>
              <li><Link to="/legal/conditions" className="hover:text-[#F04E10]">Conditions d’utilisation</Link></li>
            </ul>
          </nav>
          <div>
            <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">{ui.contact}</p>
            <address className="space-y-2 text-sm not-italic text-[#5A6672]">
              <p>OpenLab Consulting</p>
              <p>{ui.address}</p>
              <p><a href={`tel:${PHONE_CI.replace(/\s/g, '')}`} className="tabular-nums hover:text-[#F04E10]">{PHONE_CI}</a></p>
              <p><a href={`mailto:${EMAIL}`} className="break-all hover:text-[#F04E10]">{EMAIL}</a></p>
            </address>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default function SeoContentPage() {
  const { pathname } = useLocation()
  const page = getSeoPage(pathname.replace(/\/+$/, '') || '/')
  if (!page) return <Navigate to="/" replace />
  return <Page page={page} />
}
