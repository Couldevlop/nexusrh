/**
 * Référencement : pré-rendu des pages publiques + balisage SEO.
 * Invariants : seules la vitrine et les pages légales sont indexables, en
 * français, avec un HTML complet ; l'application reste hors index.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error — module JS de build (scripts/), sans déclaration de types
import { buildPageHtml, buildRobotsTxt, buildSitemap } from '../../scripts/seo-html.mjs'
import { getPages, renderPage, SITE_URL } from './entry'

const TEMPLATE = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8')

describe('pré-rendu des pages publiques', () => {
  it('liste uniquement la vitrine et les 4 pages légales', () => {
    expect(getPages().map(p => p.path)).toEqual([
      '/', '/legal/mentions-legales', '/legal/confidentialite', '/legal/conditions', '/legal/cookies',
    ])
  })

  it('rend la vitrine EN FRANÇAIS même si l’environnement est en anglais', () => {
    const html = renderPage('/')
    expect(html).toContain('La paie ivoirienne, juste du premier coup')
    expect(html).not.toContain('Request a demo')
  })

  it('rend chaque page légale avec son titre (h1)', () => {
    for (const p of getPages().filter(x => x.path.startsWith('/legal/'))) {
      expect(renderPage(p.path)).toMatch(/<h1[^>]*>[^<]+<\/h1>/)
    }
  })

  it('titres ≤ 65 caractères et descriptions ≤ 160 (affichage Google)', () => {
    for (const p of getPages()) {
      expect(p.title.length).toBeLessThanOrEqual(65)
      expect(p.description.length).toBeLessThanOrEqual(160)
    }
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
  it('robots.txt : vitrine + pages légales explorables, reste de l’application fermé', () => {
    const txt: string = buildRobotsTxt(SITE_URL)
    expect(txt).toContain('Allow: /$')
    expect(txt).toContain('Allow: /legal/')
    expect(txt).toContain('Allow: /BingSiteAuth.xml')
    expect(txt).toContain('Disallow: /')
    expect(txt).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`)
  })

  it('sitemap.xml : une entrée par page publique, URL absolues', () => {
    const xml: string = buildSitemap(SITE_URL, getPages(), '2026-10-23')
    expect(xml.match(/<url>/g)).toHaveLength(5)
    expect(xml).toContain(`<loc>${SITE_URL}/legal/cookies</loc>`)
  })
})
