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
import { COUNTRY_FACTS, UEMOA } from '@/pages/public/seo/content-west-africa'
import type { SeoBlock, SeoPageContent } from '@/pages/public/seo/types'
import {
  DEPLOY_POINTS, DEPLOY_ROWS, HOME_ANCHORS, HOME_DOMAINS, HOME_FAQ, PHONES, PUBLISHER,
} from '@/pages/public/home-content'

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

const EMAIL = PUBLISHER.demoEmail
/** Téléphones au format E.164 (CI, CI, France), tels qu'affichés sur la vitrine. */
const TELEPHONES = PHONES.map((p) => p.e164)
const ORG_URL = PUBLISHER.url
const ORG_ID = `${ORG_URL}/#organization`
const WEBSITE_ID = `${SITE_URL}/#website`
const APP_ID = `${SITE_URL}/#software`

/**
 * Zone servie : Côte d'Ivoire (pays de référence) et pays de l'UEMOA, chacun
 * couvert par un pack législatif (content-west-africa.ts, vérifié contre les
 * packs de l'API par seo-content.test.ts). Extension CEDEAO / CEMAC annoncée
 * dans le texte, pas dans areaServed : rien n'y figure qui ne soit livré.
 */
const AREA_SERVED = UEMOA.map((k) => ({ '@type': 'Country', name: COUNTRY_FACTS[k].fr }))

/** Horaires du support (CLAUDE.md § Contacts) — affichés dans la section Confiance. */
const SUPPORT_HOURS = {
  '@type': 'OpeningHoursSpecification',
  dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  opens: '07:30',
  closes: '18:00',
}

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
  email: PUBLISHER.infoEmail,
  telephone: TELEPHONES,
  address: ADDRESS,
  // Un seul point de contact, comme sur la page : les trois numéros publiés, dans l'ordre.
  contactPoint: [
    {
      '@type': 'ContactPoint',
      contactType: 'customer service',
      telephone: TELEPHONES,
      email: PUBLISHER.supportEmail,
      hoursAvailable: SUPPORT_HOURS,
      areaServed: AREA_SERVED,
      availableLanguage: ['French', 'English'],
    },
  ],
}

/** Textes FR de la vitrine (la page d'accueil est pré-générée en français). */
function homeT(): (key: string) => string {
  void i18n.changeLanguage('fr')
  const t = i18n.getFixedT('fr', 'home')
  return (key: string) => t(key)
}

/** FAQ visible de la vitrine, telle qu'affichée (même source que HomePage). */
export function homeFaq(): { q: string; a: string }[] {
  const t = homeT()
  return HOME_FAQ.map((k) => ({ q: t(`faq.items.${k}.q`), a: t(`faq.items.${k}.a`) }))
}

/** Liste des fonctionnalités publiées : un intitulé par module affiché. */
export function homeFeatureList(): string[] {
  const t = homeT()
  return HOME_DOMAINS.flatMap((d) =>
    d.modules.map((m) => `${t(`domains.${d.key}.title`)} — ${t(`domains.${d.key}.modules.${m.key}.title`)}`))
}

export function homeJsonLd(description: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ORGANIZATION,
      {
        // Établissement physique (Abidjan) : adresse, téléphone et horaires
        // affichés dans les sections Confiance et Contact de la vitrine.
        '@type': 'ProfessionalService',
        '@id': `${ORG_URL}/#abidjan`,
        name: 'OpenLab Consulting',
        url: ORG_URL,
        image: `${SITE_URL}/openlab.png`,
        telephone: TELEPHONES,
        email: EMAIL,
        address: ADDRESS,
        parentOrganization: { '@id': ORG_ID },
        areaServed: AREA_SERVED,
        openingHoursSpecification: SUPPORT_HOURS,
      },
      {
        // Sans aggregateRating ni review : aucun avis publié. L'offre ne porte
        // que la DEVISE de facturation et la disponibilité — pour qu'un moteur
        // génératif sache que le produit se vend en FCFA (XOF), sans qu'aucun
        // montant soit avancé : les tarifs ne sont pas publics.
        '@type': 'SoftwareApplication',
        '@id': APP_ID,
        name: 'NexusRH',
        url: `${SITE_URL}/`,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Logiciel SIRH et paie',
        operatingSystem: 'Web',
        inLanguage: ['fr', 'en'],
        description,
        image: `${SITE_URL}/og-image.png`,
        publisher: { '@id': ORG_ID },
        provider: { '@id': ORG_ID },
        areaServed: AREA_SERVED,
        featureList: homeFeatureList(),
        offers: {
          '@type': 'Offer',
          priceCurrency: 'XOF',
          availability: 'https://schema.org/InStock',
          seller: { '@id': ORG_ID },
          url: `${SITE_URL}/`,
        },
      },
      {
        '@type': 'WebSite',
        '@id': WEBSITE_ID,
        name: 'NexusRH',
        url: `${SITE_URL}/`,
        inLanguage: 'fr',
        publisher: { '@id': ORG_ID },
      },
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/#faq`,
        mainEntity: homeFaq().map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
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
    { '@type': 'SoftwareApplication', '@id': APP_ID, name: 'NexusRH', url: `${SITE_URL}/`, applicationCategory: 'BusinessApplication', operatingSystem: 'Web', publisher: { '@id': ORG_ID }, provider: { '@id': ORG_ID } },
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

export const HOME_TITLE = "SIRH et logiciel de paie Côte d'Ivoire et UEMOA | NexusRH"
export const HOME_DESCRIPTION =
  "Paie et RH selon le droit social de votre pays : Côte d'Ivoire et UEMOA, extensible CEDEAO et CEMAC. " +
  'Mobile Money, badgeuse, SaaS ou on-premise.'

/** Pages publiques indexables (accueil, pages de contenu, pages légales). */
export function getPages(): PrerenderPage[] {
  void i18n.changeLanguage('fr')
  const tl = i18n.getFixedT('fr', 'legal')

  const keys: Record<string, string> = {
    'mentions-legales': 'notice', confidentialite: 'privacy', conditions: 'terms', cookies: 'cookies',
  }
  return [
    {
      path: '/',
      file: 'home.html',
      title: HOME_TITLE,
      description: HOME_DESCRIPTION,
      changefreq: 'weekly',
      priority: '1.0',
      chunk: 'HomePage',
      jsonLd: homeJsonLd(HOME_DESCRIPTION),
    },
    ...SEO_PAGES.map(contentPage),
    ...LEGAL_SLUGS.map((slug): PrerenderPage => ({
      path: `/legal/${slug}`,
      file: `legal/${slug}.html`,
      title: tl(`docs.${keys[slug]}.seoTitle`),
      description: tl(`docs.${keys[slug]}.seoDescription`),
      changefreq: 'yearly',
      priority: '0.3',
      jsonLd: legalJsonLd(slug, tl(`docs.${keys[slug]}.title`), tl(`docs.${keys[slug]}.seoDescription`)),
    })),
  ]
}

/** JSON-LD d'une page légale : page + fil d'Ariane. */
function legalJsonLd(slug: string, name: string, description: string): Record<string, unknown> {
  const url = `${SITE_URL}/legal/${slug}`
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': ORG_ID, name: 'OpenLab Consulting', url: ORG_URL, logo: `${SITE_URL}/openlab.png` },
      { '@type': 'WebPage', '@id': `${url}#webpage`, name, description, inLanguage: 'fr', url, publisher: { '@id': ORG_ID }, isPartOf: { '@id': WEBSITE_ID } },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Accueil', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name, item: url },
        ],
      },
    ],
  }
}

// ── llms.txt / llms-full.txt (llmstxt.org) ─────────────────────────────────
// Produits depuis les MÊMES sources que les pages : i18n de la vitrine,
// home-content.ts et le contenu des pages SEO. Aucun texte propre à ces
// fichiers, hormis les intitulés de section : impossible qu'ils divergent.

const mdLink = (title: string, path: string) => `[${title}](${SITE_URL}${path})`

/** /llms.txt — titre, résumé d'une phrase, sections de liens vers les pages clés. */
export function buildLlmsTxt(): string {
  const t = homeT()
  const pages = getPages()
  const line = (p: PrerenderPage) => `- ${mdLink(p.title, p.path)}: ${p.description}`
  const landing = pages.filter((p) => SEO_PAGES.some((s) => s.path === p.path && s.kind === 'landing'))
  const guides = pages.filter((p) => SEO_PAGES.some((s) => s.path === p.path && s.kind === 'guide'))
  const legal = pages.filter((p) => p.path.startsWith('/legal/'))
  return [
    '# NexusRH',
    '',
    `> ${HOME_DESCRIPTION}`,
    '',
    `${t('hero.lead')} ${t('hero.reference')}`,
    '',
    '## Accueil',
    '',
    `- ${mdLink(HOME_TITLE, '/')}: ${HOME_DESCRIPTION}`,
    `- ${mdLink(t('modules.title'), `/#${HOME_ANCHORS.modules}`)}: ${t('modules.lead')}`,
    `- ${mdLink(t('deploy.title'), `/#${HOME_ANCHORS.deploy}`)}: ${t('deploy.lead')}`,
    `- ${mdLink(t('security.title'), `/#${HOME_ANCHORS.security}`)}: ${t('security.lead')}`,
    `- ${mdLink(t('trust.title'), `/#${HOME_ANCHORS.trust}`)}: ${t('trust.lead')}`,
    `- ${mdLink(t('faq.title'), `/#${HOME_ANCHORS.faq}`)}: ${HOME_FAQ.length} questions.`,
    '',
    '## Solutions',
    '',
    ...landing.map(line),
    '',
    '## Guides',
    '',
    ...guides.map(line),
    '',
    '## Optional',
    '',
    `- ${mdLink('Description complète (markdown)', '/llms-full.txt')}: ${t('modules.lead')}`,
    ...legal.map(line),
    '',
  ].join('\n')
}

function blockToMd(b: SeoBlock): string[] {
  switch (b.type) {
    case 'p': return [b.text, '']
    case 'ul': return [...b.items.map((i) => `- ${i}`), '']
    case 'table': return [
      `${b.caption} :`, '',
      `| ${b.head.join(' | ')} |`,
      `| ${b.head.map(() => '---').join(' | ')} |`,
      ...b.rows.map((r) => `| ${r.join(' | ')} |`),
      '',
      ...(b.note ? [b.note, ''] : []),
    ]
    case 'links': return [...b.items.map((l) => `- ${mdLink(l.label, l.to)}`), '']
  }
}

/** /llms-full.txt — description factuelle complète, en markdown, du contenu publié. */
export function buildLlmsFullTxt(): string {
  const t = homeT()
  const out: string[] = [
    '# NexusRH',
    '',
    `> ${HOME_DESCRIPTION}`,
    '',
    `Source : ${SITE_URL}/ — ${t('hero.editor')}.`,
    '',
    `## ${t('hero.title')}`,
    '',
    t('hero.lead'),
    '',
    t('hero.reference'),
    '',
    `## ${t('modules.title')}`,
    '',
    t('modules.lead'),
    '',
  ]
  for (const d of HOME_DOMAINS) {
    out.push(`### ${t(`domains.${d.key}.title`)}`, '')
    for (const m of d.modules) {
      out.push(`- **${t(`domains.${d.key}.modules.${m.key}.title`)}** : ${t(`domains.${d.key}.modules.${m.key}.text`)}`)
    }
    out.push('')
  }
  out.push(`## ${t('deploy.title')}`, '', t('deploy.lead'), '')
  for (const mode of ['saas', 'onprem'] as const) {
    out.push(`### ${t(`deploy.${mode}.title`)}`, '')
    for (const p of DEPLOY_POINTS[mode]) out.push(`- ${t(`deploy.${mode}.${p}`)}`)
    out.push('')
  }
  out.push(
    `| ${t('deploy.table.criterion')} | ${t('deploy.table.saas')} | ${t('deploy.table.onprem')} |`,
    '| --- | --- | --- |',
    ...DEPLOY_ROWS.map((r) => `| ${t(`deploy.rows.${r}.label`)} | ${t(`deploy.rows.${r}.saas`)} | ${t(`deploy.rows.${r}.onprem`)} |`),
    '',
    `## ${t('compliance.title')}`, '', t('compliance.lead'), '',
    ...(['cnps', 'its', 'labour', 'declarations', 'ohada', 'currency'] as const)
      .map((k) => `- **${t(`compliance.${k}.title`)}** : ${t(`compliance.${k}.text`)}`),
    '',
    `## ${t('security.title')}`, '', t('security.lead'), '',
    ...(['isolation', 'rbac', 'mfa', 'crypto', 'audit', 'hosting', 'sso', 'signature'] as const)
      .map((k) => `- **${t(`security.${k}.title`)}** : ${t(`security.${k}.text`)}`),
    '',
    `## ${t('trust.title')}`, '',
    `- **${t('trust.publisher.title')}** : ${t('trust.publisher.name')} — ${t('trust.publisher.text')}`,
    `- **${t('trust.labels.address')}** : ${t('contact.address')}`,
    `- **${t('trust.labels.phones')}** : ${PHONES.map((p) => p.display).join(' · ')}`,
    `- **${t('trust.labels.emails')}** : ${PUBLISHER.infoEmail} · ${PUBLISHER.supportEmail} · ${PUBLISHER.demoEmail}`,
    `- **${t('trust.labels.whatsapp')}** : ${PUBLISHER.whatsappDisplay} (${PUBLISHER.whatsapp})`,
    `- **${t('trust.labels.hours')}** : ${t('trust.supportHours')}`,
    `- **${t('trust.data.title')}** : ${t('trust.data.text')}`,
    `- **${t('trust.compliance.title')}** : ${t('trust.compliance.text')}`,
    '',
    `## ${t('faq.title')}`, '',
  )
  for (const f of homeFaq()) out.push(`### ${f.q}`, '', f.a, '')
  for (const p of SEO_PAGES) {
    out.push(`## ${p.h1}`, '', `Source : ${SITE_URL}${p.path}`, '', p.lead, '')
    for (const sct of p.sections) {
      out.push(`### ${sct.h2}`, '')
      for (const b of sct.blocks) out.push(...blockToMd(b))
    }
    if (p.faq?.length) for (const f of p.faq) out.push(`**${f.q}** ${f.a}`, '')
  }
  return out.join('\n')
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
