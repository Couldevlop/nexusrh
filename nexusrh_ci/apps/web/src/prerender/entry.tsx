/**
 * Pré-génération (SSG) des pages publiques indexables.
 *
 * Construit par `vite build --ssr` puis exécuté par scripts/prerender.mjs : le
 * HTML produit est servi tel quel par nginx aux robots ET aux visiteurs (le
 * bundle client reprend ensuite la main normalement). Seules ces pages sont
 * indexables — tout le reste de l'application garde le gabarit `noindex`.
 *
 * Aucune donnée de tenant ici : uniquement la vitrine, les pages de contenu
 * (pages d'atterrissage + guides) et les pages légales, 100 % statiques.
 */
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { Route, Routes } from 'react-router-dom'
import i18n from '@/i18n'
import HomePage from '@/pages/public/HomePage'
import LegalPage, { LEGAL_SLUGS } from '@/pages/public/LegalPage'
import SeoContentPage from '@/pages/public/SeoContentPage'
import { SEO_PAGES } from '@/pages/public/seo/content'
import type { SeoPageContent } from '@/pages/public/seo/types'

export const SITE_URL = 'https://nexusrh.openlabconsulting.com'

export interface PrerenderPage {
  /** Chemin public (canonique). */
  path: string
  /** Fichier écrit dans dist/ (nginx le sert pour ce chemin). */
  file: string
  title: string
  description: string
  changefreq: 'weekly' | 'monthly' | 'yearly'
  priority: string
  /** Langue du document (attribut lang, og:locale). Défaut : fr. */
  lang?: 'fr' | 'en'
  /** og:type — `article` pour les guides. Défaut : website. */
  ogType?: 'website' | 'article'
  /** Versions linguistiques équivalentes (hreflang), page courante comprise. */
  alternates?: { hreflang: string; path: string }[]
  /** Date de dernière modification du contenu (sitemap). Défaut : date du build. */
  lastmod?: string
  /** Chunk Vite du composant de la page, préchargé (modulepreload). */
  chunk?: string
  /** Données structurées schema.org (JSON-LD). */
  jsonLd?: Record<string, unknown>
}

const EMAIL = 'waopron@openlabconsulting.com'
const PHONE_CI = '+225 07 09 32 05 94'
const ORG_URL = 'https://www.openlabconsulting.com'
const ORG_ID = `${ORG_URL}/#organization`
const WEBSITE_ID = `${SITE_URL}/#website`
const APP_ID = `${SITE_URL}/#software`

/** Pays couverts par un pack législatif (apps/api/src/services/legislation-packs.ts). */
const AREA_SERVED: { code: string; name: string }[] = [
  { code: 'CI', name: "Côte d'Ivoire" }, { code: 'SN', name: 'Sénégal' }, { code: 'BF', name: 'Burkina Faso' },
  { code: 'BJ', name: 'Bénin' }, { code: 'TG', name: 'Togo' }, { code: 'ML', name: 'Mali' },
  { code: 'NE', name: 'Niger' }, { code: 'GW', name: 'Guinée-Bissau' }, { code: 'GH', name: 'Ghana' },
  { code: 'NG', name: 'Nigeria' }, { code: 'CM', name: 'Cameroun' }, { code: 'GA', name: 'Gabon' },
  { code: 'CG', name: 'Congo' }, { code: 'TD', name: 'Tchad' }, { code: 'CF', name: 'Centrafrique' },
  { code: 'GQ', name: 'Guinée équatoriale' },
]

const ADDRESS = {
  '@type': 'PostalAddress',
  streetAddress: 'Cocody, Rivièra Faya Lauriers 8',
  addressLocality: 'Abidjan',
  addressCountry: 'CI',
}

const ORGANIZATION = {
  '@type': 'Organization',
  '@id': ORG_ID,
  name: 'OpenLab Consulting',
  url: ORG_URL,
  logo: `${SITE_URL}/openlab.png`,
  email: EMAIL,
  telephone: PHONE_CI,
  address: ADDRESS,
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'sales',
    email: EMAIL,
    telephone: PHONE_CI,
    areaServed: AREA_SERVED.map((c) => c.code),
    availableLanguage: ['French', 'English'],
  },
}

/** Coupe proprement une description à ~158 caractères (limite d'affichage Google). */
function clip(text: string, max = 158): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

function homeJsonLd(description: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ORGANIZATION,
      {
        // Établissement physique (Abidjan) : adresse, téléphone et horaires
        // affichés dans la section contact de la vitrine.
        '@type': 'ProfessionalService',
        '@id': `${ORG_URL}/#abidjan`,
        name: 'OpenLab Consulting',
        url: ORG_URL,
        image: `${SITE_URL}/openlab.png`,
        telephone: PHONE_CI,
        email: EMAIL,
        address: ADDRESS,
        parentOrganization: { '@id': ORG_ID },
        areaServed: { '@type': 'Country', name: "Côte d'Ivoire" },
        openingHoursSpecification: {
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          opens: '07:30',
          closes: '18:00',
        },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': APP_ID,
        name: 'NexusRH CI',
        url: `${SITE_URL}/`,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Logiciel SIRH et paie',
        operatingSystem: 'Web',
        inLanguage: ['fr', 'en'],
        description,
        image: `${SITE_URL}/og-image.png`,
        publisher: { '@id': ORG_ID },
        provider: { '@id': ORG_ID },
        areaServed: AREA_SERVED.map((c) => ({ '@type': 'Country', name: c.name })),
        featureList: [
          'Paie conforme CNPS 2024 (double plafond) et ITS 2024 avec RICF',
          'Déclarations CNPS et DISA',
          'Congés en jours ouvrables, jours fériés ivoiriens',
          'Paiement des salaires par Mobile Money (Wave, Orange, MTN) et virement',
          'Recrutement, formation FDFP, carrières et entretiens',
          'Multi-filiales et packs législatifs UEMOA / CEMAC',
        ],
      },
      {
        '@type': 'WebSite',
        '@id': WEBSITE_ID,
        name: 'NexusRH CI',
        url: `${SITE_URL}/`,
        inLanguage: 'fr',
        publisher: { '@id': ORG_ID },
      },
    ],
  }
}

/** JSON-LD d'une page de contenu : page (ou article) + fil d'Ariane + FAQ visible. */
export function contentJsonLd(p: SeoPageContent): Record<string, unknown> {
  const url = `${SITE_URL}${p.path}`
  const page = p.kind === 'guide'
    ? {
        '@type': 'Article',
        '@id': `${url}#article`,
        headline: p.h1,
        description: p.description,
        inLanguage: p.lang,
        url,
        mainEntityOfPage: url,
        image: `${SITE_URL}/og-image.png`,
        datePublished: p.published ?? p.updated,
        dateModified: p.updated,
        author: { '@id': ORG_ID },
        publisher: { '@id': ORG_ID },
        about: { '@id': APP_ID },
        isPartOf: { '@id': WEBSITE_ID },
      }
    : {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        name: p.h1,
        description: p.description,
        inLanguage: p.lang,
        url,
        dateModified: p.updated,
        about: { '@id': APP_ID },
        publisher: { '@id': ORG_ID },
        isPartOf: { '@id': WEBSITE_ID },
      }
  const graph: Record<string, unknown>[] = [
    { '@type': 'Organization', '@id': ORG_ID, name: 'OpenLab Consulting', url: ORG_URL, logo: `${SITE_URL}/openlab.png` },
    { '@type': 'SoftwareApplication', '@id': APP_ID, name: 'NexusRH CI', url: `${SITE_URL}/`, applicationCategory: 'BusinessApplication', operatingSystem: 'Web', publisher: { '@id': ORG_ID }, provider: { '@id': ORG_ID } },
    page,
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: p.lang === 'en' ? 'Home' : 'Accueil', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: p.crumb, item: url },
      ],
    },
  ]
  if (p.faq?.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: p.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    })
  }
  return { '@context': 'https://schema.org', '@graph': graph }
}

function contentPage(p: SeoPageContent): PrerenderPage {
  const alternates = p.alternate
    ? [
        { hreflang: p.lang, path: p.path },
        { hreflang: p.lang === 'fr' ? 'en' : 'fr', path: p.alternate },
        { hreflang: 'x-default', path: p.lang === 'fr' ? p.path : p.alternate },
      ]
    : undefined
  return {
    path: p.path,
    file: `${p.path.slice(1)}.html`,
    title: p.title,
    description: p.description,
    changefreq: 'monthly',
    priority: p.kind === 'guide' ? '0.7' : '0.8',
    lang: p.lang,
    ogType: p.kind === 'guide' ? 'article' : 'website',
    alternates,
    lastmod: p.updated,
    chunk: 'SeoContentPage',
    jsonLd: contentJsonLd(p),
  }
}

/** Pages publiques indexables (accueil, pages de contenu, pages légales). */
export function getPages(): PrerenderPage[] {
  void i18n.changeLanguage('fr')
  const tl = i18n.getFixedT('fr', 'legal')
  const homeDescription =
    "SIRH et logiciel de paie conçus pour la Côte d'Ivoire : CNPS, ITS 2024, DISA, congés, " +
    'salaires par Mobile Money. Édité à Abidjan par OpenLab Consulting.'

  const keys: Record<string, string> = {
    'mentions-legales': 'notice', confidentialite: 'privacy', conditions: 'terms', cookies: 'cookies',
  }
  return [
    {
      path: '/',
      file: 'home.html',
      title: "SIRH Côte d'Ivoire : paie CNPS, ITS 2024 et congés | NexusRH CI",
      description: homeDescription,
      changefreq: 'weekly',
      priority: '1.0',
      chunk: 'HomePage',
      jsonLd: homeJsonLd(homeDescription),
    },
    ...SEO_PAGES.map(contentPage),
    ...LEGAL_SLUGS.map((slug): PrerenderPage => ({
      path: `/legal/${slug}`,
      file: `legal/${slug}.html`,
      title: `${tl(`docs.${keys[slug]}.title`)} | NexusRH CI`,
      description: clip(tl(`docs.${keys[slug]}.lead`)),
      changefreq: 'yearly',
      priority: '0.3',
    })),
  ]
}

/** Rendu HTML (contenu de #root) d'une page publique. */
export function renderPage(path: string): string {
  // Node 22 expose navigator.language (souvent en-US) : sans cela la vitrine
  // serait pré-générée en anglais. Ressources embarquées → changement synchrone.
  void i18n.changeLanguage('fr')
  return renderToString(
    <StaticRouter location={path}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/legal/:doc" element={<LegalPage />} />
        {SEO_PAGES.map((p) => <Route key={p.path} path={p.path} element={<SeoContentPage />} />)}
      </Routes>
    </StaticRouter>,
  )
}
