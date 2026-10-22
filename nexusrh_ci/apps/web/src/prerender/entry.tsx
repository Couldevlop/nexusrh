/**
 * Pré-génération (SSG) des pages publiques indexables.
 *
 * Construit par `vite build --ssr` puis exécuté par scripts/prerender.mjs : le
 * HTML produit est servi tel quel par nginx aux robots ET aux visiteurs (le
 * bundle client reprend ensuite la main normalement). Seules ces pages sont
 * indexables — tout le reste de l'application garde le gabarit `noindex`.
 *
 * Aucune donnée de tenant ici : uniquement la vitrine et les pages légales,
 * déjà 100 % statiques côté client.
 */
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { Route, Routes } from 'react-router-dom'
import i18n from '@/i18n'
import HomePage from '@/pages/public/HomePage'
import LegalPage, { LEGAL_SLUGS } from '@/pages/public/LegalPage'

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
  /** Données structurées schema.org (JSON-LD), page d'accueil uniquement. */
  jsonLd?: Record<string, unknown>
}

const EMAIL = 'waopron@openlabconsulting.com'
const PHONE_CI = '+225 07 09 32 05 94'

/** Coupe proprement une description à ~158 caractères (limite d'affichage Google). */
function clip(text: string, max = 158): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

function homeJsonLd(description: string): Record<string, unknown> {
  const orgId = 'https://www.openlabconsulting.com/#organization'
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': orgId,
        name: 'OpenLab Consulting',
        url: 'https://www.openlabconsulting.com',
        logo: `${SITE_URL}/openlab.png`,
        email: EMAIL,
        telephone: PHONE_CI,
        address: {
          '@type': 'PostalAddress',
          streetAddress: 'Cocody, Rivièra Faya Lauriers 8',
          addressLocality: 'Abidjan',
          addressCountry: 'CI',
        },
        contactPoint: {
          '@type': 'ContactPoint',
          contactType: 'sales',
          email: EMAIL,
          telephone: PHONE_CI,
          areaServed: ['CI', 'SN', 'BF', 'ML', 'TG', 'BJ', 'NE', 'CM', 'GA'],
          availableLanguage: ['French', 'English'],
        },
      },
      {
        '@type': 'SoftwareApplication',
        name: 'NexusRH CI',
        url: `${SITE_URL}/`,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Logiciel SIRH et paie',
        operatingSystem: 'Web',
        inLanguage: ['fr', 'en'],
        description,
        image: `${SITE_URL}/og-image.png`,
        publisher: { '@id': orgId },
        featureList: [
          'Paie conforme CNPS 2024 (double plafond) et ITS/DGI',
          'Déclarations CNPS et DISA',
          'Congés en jours ouvrables, jours fériés ivoiriens',
          'Paiement des salaires par Mobile Money (Wave, Orange, MTN) et virement',
          'Recrutement, formation FDFP, carrières et entretiens',
          'Multi-filiales et packs législatifs UEMOA / CEMAC',
        ],
      },
      {
        '@type': 'WebSite',
        name: 'NexusRH CI',
        url: `${SITE_URL}/`,
        inLanguage: 'fr',
        publisher: { '@id': orgId },
      },
    ],
  }
}

/** Pages publiques indexables (accueil + pages légales), métadonnées en français. */
export function getPages(): PrerenderPage[] {
  void i18n.changeLanguage('fr')
  const tl = i18n.getFixedT('fr', 'legal')
  const homeDescription =
    "SIRH SaaS conçu pour la Côte d'Ivoire : paie conforme CNPS et ITS, DISA, congés, " +
    'paiement Mobile Money, recrutement. Par OpenLab Consulting, Abidjan.'

  const keys: Record<string, string> = {
    'mentions-legales': 'notice', confidentialite: 'privacy', conditions: 'terms', cookies: 'cookies',
  }
  return [
    {
      path: '/',
      file: 'home.html',
      title: "Logiciel de paie et SIRH en Côte d'Ivoire | NexusRH CI",
      description: homeDescription,
      changefreq: 'weekly',
      priority: '1.0',
      jsonLd: homeJsonLd(homeDescription),
    },
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

/** Rendu HTML (contenu de #root) d'une page publique, en français. */
export function renderPage(path: string): string {
  // Node 22 expose navigator.language (souvent en-US) : sans cela la vitrine
  // serait pré-générée en anglais. Ressources embarquées → changement synchrone.
  void i18n.changeLanguage('fr')
  return renderToString(
    <StaticRouter location={path}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/legal/:doc" element={<LegalPage />} />
      </Routes>
    </StaticRouter>,
  )
}
