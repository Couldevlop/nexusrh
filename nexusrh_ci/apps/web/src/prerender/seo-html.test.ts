/**
 * Référencement : pré-rendu des pages publiques + balisage SEO.
 * Invariants : seules la vitrine, les pages de contenu et les pages légales
 * sont indexables, avec un HTML complet ; l'application reste hors index.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error — module JS de build (scripts/), sans déclaration de types
import { buildPageHtml, buildRobotsTxt, buildSitemap } from '../../scripts/seo-html.mjs'
import { getPages, renderPage, SITE_URL } from './entry'
import { SEO_PATHS } from '@/pages/public/seo/paths'

const TEMPLATE = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8')
const NGINX = readFileSync(join(__dirname, '..', '..', 'nginx.conf'), 'utf8')

describe('pré-rendu des pages publiques', () => {
  it('liste la vitrine, les pages de contenu puis les 4 pages légales', () => {
    expect(getPages().map(p => p.path)).toEqual([
      '/', ...SEO_PATHS,
      '/legal/mentions-legales', '/legal/confidentialite', '/legal/conditions', '/legal/cookies',
    ])
  })

  it('rend la vitrine EN FRANÇAIS même si l’environnement est en anglais', () => {
    const html = renderPage('/')
    expect(html).toContain('La paie ivoirienne, juste du premier coup')
    expect(html).not.toContain('Request a demo')
  })

  it('la vitrine relie les pages de contenu (maillage interne)', () => {
    const html = renderPage('/')
    for (const p of ['/logiciel-paie-cote-divoire', '/sirh-afrique-ouest', '/guides/calcul-its-2024-cote-divoire']) {
      expect(html).toContain(`href="${p}"`)
    }
  })

  it('rend chaque page avec UN SEUL titre h1', () => {
    for (const p of getPages()) {
      expect(renderPage(p.path).match(/<h1[\s>]/g), p.path).toHaveLength(1)
    }
  })

  it('titres ≤ 65 caractères et descriptions ≤ 160, tous uniques', () => {
    const pages = getPages()
    for (const p of pages) {
      expect(p.title.length, p.title).toBeLessThanOrEqual(65)
      expect(p.description.length, p.path).toBeLessThanOrEqual(160)
      if (!p.path.startsWith('/legal/')) expect(p.description.length, p.path).toBeGreaterThanOrEqual(90)
    }
    expect(new Set(pages.map(p => p.title)).size).toBe(pages.length)
    expect(new Set(pages.map(p => p.description)).size).toBe(pages.length)
  })

  it('chaque page de contenu a sa règle nginx (sinon elle tomberait sur le gabarit noindex)', () => {
    const m = NGINX.match(/location ~ \^\/\((.+)\)\$ \{/)
    expect(m).not.toBeNull()
    const re = new RegExp(`^/(${m![1]})$`)
    for (const p of SEO_PATHS) expect(re.test(p), p).toBe(true)
    // …et aucune route de l'application n'y correspond.
    for (const p of ['/login', '/dashboard', '/payroll', '/mon-espace', '/careers/sotra']) expect(re.test(p), p).toBe(false)
  })
})

describe('buildPageHtml', () => {
  const home = getPages()[0]!

  it('rend la page indexable, canonique, partageable et injecte le contenu', () => {
    const html: string = buildPageHtml(TEMPLATE, home, '<h1>X</h1>', { siteUrl: SITE_URL, preload: ['/assets/HomePage-a.js'] })
    expect(html).toContain('<meta name="robots" content="index, follow')
    expect(html).not.toMatch(/noindex/)
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/" />`)
    expect(html).toContain('property="og:image"')
    expect(html).toContain('<link rel="modulepreload" crossorigin href="/assets/HomePage-a.js" />')
    expect(html).toContain('<div id="root"><h1>X</h1></div>')
    expect(html).toContain('"@type":"SoftwareApplication"')
    expect(html).toContain('"@type":"ProfessionalService"')
    expect(html).toContain('Cocody, Rivièra Faya Lauriers 8')
  })

  it('page anglaise : lang, og:locale et hreflang réciproques', () => {
    const en = getPages().find(p => p.path === '/en/hris-payroll-west-africa')!
    const fr = getPages().find(p => p.path === '/sirh-afrique-ouest')!
    const htmlEn: string = buildPageHtml(TEMPLATE, en, '<h1>X</h1>', { siteUrl: SITE_URL })
    expect(htmlEn).toContain('<html lang="en">')
    expect(htmlEn).toContain('content="en_GB"')
    expect(htmlEn).toContain(`hreflang="fr" href="${SITE_URL}/sirh-afrique-ouest"`)
    const htmlFr: string = buildPageHtml(TEMPLATE, fr, '<h1>X</h1>', { siteUrl: SITE_URL })
    expect(htmlFr).toContain('<html lang="fr">')
    expect(htmlFr).toContain(`hreflang="en" href="${SITE_URL}/en/hris-payroll-west-africa"`)
    expect(htmlFr).toContain(`hreflang="x-default" href="${SITE_URL}/sirh-afrique-ouest"`)
  })

  it('guides : og:type article et schema Article', () => {
    const g = getPages().find(p => p.path === '/guides/calcul-its-2024-cote-divoire')!
    const html: string = buildPageHtml(TEMPLATE, g, '<h1>X</h1>', { siteUrl: SITE_URL })
    expect(html).toContain('<meta property="og:type" content="article" />')
    expect(html).toContain('"@type":"Article"')
    expect(html).toContain('"@type":"BreadcrumbList"')
  })

  it('échappe les valeurs : aucune injection de balise via les métadonnées ou le JSON-LD', () => {
    const evil = { ...home, title: 'a"><script>x</script>', jsonLd: { n: '</script><script>alert(1)</script>' } }
    const html: string = buildPageHtml(TEMPLATE, evil, '', { siteUrl: SITE_URL })
    expect(html).not.toContain('<script>x</script>')
    expect(html).not.toContain('</script><script>alert(1)')
  })

  it('échoue bruyamment si le gabarit ne contient plus le point d’ancrage attendu', () => {
    expect(() => buildPageHtml('<html></html>', home, '', { siteUrl: SITE_URL })).toThrow(/Gabarit/)
  })
})

describe('robots.txt et sitemap.xml', () => {
  it('robots.txt : pages publiques explorables, reste de l’application fermé', () => {
    const txt: string = buildRobotsTxt(SITE_URL, getPages())
    expect(txt).toContain('Allow: /$')
    expect(txt).toContain('Allow: /legal/')
    for (const p of SEO_PATHS) expect(txt).toContain(`Allow: ${p}$`)
    expect(txt).toContain('Allow: /BingSiteAuth.xml')
    expect(txt).toContain('Allow: /sitemap.xml$')
    expect(txt).toContain('Disallow: /')
    expect(txt).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`)
  })

  it('sitemap.xml : une entrée par page publique, URL absolues, hreflang', () => {
    const pages = getPages()
    const xml: string = buildSitemap(SITE_URL, pages, '2026-10-23')
    expect(xml.match(/<url>/g)).toHaveLength(pages.length)
    expect(xml).toContain(`<loc>${SITE_URL}/legal/cookies</loc>`)
    expect(xml).toContain(`<loc>${SITE_URL}/guides/cotisations-cnps-2024</loc>`)
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="en" href="${SITE_URL}/en/hris-payroll-west-africa" />`)
  })
})
