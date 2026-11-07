/**
 * Référencement : pré-rendu des pages publiques + balisage SEO.
 * Invariants : seules la vitrine, les pages de contenu et les pages légales
 * sont indexables, avec un HTML complet ; l'application reste hors index.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error — module JS de build (scripts/), sans déclaration de types
import { buildPageHtml, buildRobotsTxt, buildSitemap, NAMED_CRAWLERS, APP_DISALLOW } from '../../scripts/seo-html.mjs'
import { buildLlmsFullTxt, buildLlmsTxt, getPages, homeFaq, renderPage, SITE_URL } from './entry'
import { SEO_PATHS } from '@/pages/public/seo/paths'
import { SEO_PAGES } from '@/pages/public/seo/content'
import { HOME_DOMAINS } from '@/pages/public/home-content'
import frHome from '@/i18n/locales/fr/home.json'
import enHome from '@/i18n/locales/en/home.json'
import frLegal from '@/i18n/locales/fr/legal.json'
import enLegal from '@/i18n/locales/en/legal.json'
import { COUNTRY_FACTS, UEMOA } from '@/pages/public/seo/content-west-africa'
import { LEGISLATION_PACKS } from '../../../api/src/services/legislation-packs'

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
    expect(html).toContain('la paie juste du premier coup')
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

  it('titres de 50 à 60 caractères et descriptions de 120 à 160, tous uniques', () => {
    const pages = getPages()
    for (const p of pages) {
      expect.soft(p.title.length, p.title).toBeGreaterThanOrEqual(50)
      expect.soft(p.title.length, p.title).toBeLessThanOrEqual(60)
      expect.soft(p.description.length, `${p.path} : ${p.description}`).toBeGreaterThanOrEqual(120)
      expect.soft(p.description.length, `${p.path} : ${p.description}`).toBeLessThanOrEqual(160)
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

  it('robots.txt et llms*.txt sont servis tels quels par nginx, en UTF-8, sans repli SPA', () => {
    const start = NGINX.indexOf('location ~ ^/(robots|llms|llms-full)\\.txt$ {')
    expect(start, 'location robots/llms').toBeGreaterThan(-1)
    const block = NGINX.slice(start, NGINX.indexOf('}', start))
    expect(block).toContain('charset utf-8;')
    expect(block).toContain('try_files $uri =404;')
  })

  it('les nouvelles sections de la vitrine sont dans le HTML pré-rendu (lisibles sans JavaScript)', () => {
    const html = renderPage('/')
    for (const id of ['modules', 'deploiement', 'securite', 'confiance', 'faq', 'demo']) expect(html, id).toContain(`id="${id}"`)
    expect(html).toContain('Deux modes de déploiement : SaaS ou on-premise')
    expect(html).toContain('Installé sur vos serveurs ou dans le datacenter de votre choix')
    expect(html).toContain('Climat social')
    expect(html).toContain('Marque employeur')
    expect(html).toContain('Badgeuse et pointage')
    expect(html).toContain('href="/sirh-saas-ou-on-premise"')
    expect(html).toContain('href="/legal/confidentialite"')
    expect(html).toContain('loi n° 2013-450')
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
    expect(html).toContain('"@type":"FAQPage"')
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
    expect(xml).toContain(`<loc>${SITE_URL}/sirh-saas-ou-on-premise</loc>`)
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="en" href="${SITE_URL}/en/hris-saas-or-on-premise" />`)
    expect(xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)).toHaveLength(pages.length)
  })
})

type LdNode = Record<string, unknown> & { '@type'?: string }
/** Graphe JSON-LD tel que publié : on repasse par JSON pour vérifier ce qui sort réellement. */
function graphOf(ld: Record<string, unknown> | undefined): LdNode[] {
  const parsed = JSON.parse(JSON.stringify(ld)) as { '@context': string; '@graph': LdNode[] }
  expect(parsed['@context']).toBe('https://schema.org')
  return parsed['@graph']
}
function textOf(html: string, selector: string): string[] {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  return [...doc.querySelectorAll(selector)].map((n) => n.textContent ?? '')
}

describe('données structurées (JSON-LD)', () => {
  it('vitrine : Organization, ProfessionalService, SoftwareApplication, WebSite, FAQPage, sans avis ni prix', () => {
    const graph = graphOf(getPages()[0]!.jsonLd)
    expect(graph.map((n) => n['@type'])).toEqual(['Organization', 'ProfessionalService', 'SoftwareApplication', 'WebSite', 'FAQPage'])
    const app = graph.find((n) => n['@type'] === 'SoftwareApplication')!
    expect(app.applicationCategory).toBe('BusinessApplication')
    expect(app.operatingSystem).toBe('Web')
    expect(app).not.toHaveProperty('aggregateRating')
    expect(app).not.toHaveProperty('offers')
    expect(app).not.toHaveProperty('review')
    const org = graph.find((n) => n['@type'] === 'Organization')!
    expect(org.name).toBe('OpenLab Consulting')
    expect(JSON.stringify(org.address)).toContain('Cocody, Rivièra Faya Lauriers 8')
    // Zone servie : Côte d'Ivoire + pays de l'UEMOA, chacun doté d'un pack (rien d'inventé).
    expect(app.name).toBe('NexusRH')
    expect(app.areaServed).toEqual(UEMOA.map((k) => ({ '@type': 'Country', name: COUNTRY_FACTS[k].fr })))
    expect((app.areaServed as { name: string }[]).map((c) => c.name)).toEqual([
      "Côte d'Ivoire", 'Sénégal', 'Burkina Faso', 'Bénin', 'Togo', 'Mali', 'Niger', 'Guinée-Bissau',
    ])
    for (const k of UEMOA) expect(LEGISLATION_PACKS[COUNTRY_FACTS[k].pack]?.status, k).toBe('active')
  })

  it('téléphones : les trois numéros publiés, au format E.164, dans le JSON-LD et la page', () => {
    const graph = graphOf(getPages()[0]!.jsonLd)
    const org = graph.find((n) => n['@type'] === 'Organization')!
    expect(org.telephone).toEqual(['+2250709334238', '+2250749439203', '+33619245329'])
    // Un seul contactPoint « customer service » portant les trois numéros.
    const cps = org.contactPoint as { contactType: string; telephone: string[] }[]
    expect(cps).toHaveLength(1)
    expect(cps[0]!.contactType).toBe('customer service')
    expect(cps[0]!.telephone).toEqual(['+2250709334238', '+2250749439203', '+33619245329'])
    const html = renderPage('/')
    for (const tel of ['+2250709334238', '+2250749439203', '+33619245329']) expect(html, tel).toContain(`href="tel:${tel}"`)
    for (const shown of ['+225 07 09 33 42 38', '+225 07 49 43 92 03', '+33 6 19 24 53 29']) expect(html, shown).toContain(shown)
    expect(html).toContain('href="https://wa.me/2250749439203"')
  })

  it('aucun ancien numéro ne subsiste (page, JSON-LD, llms, contenus SEO, traductions)', () => {
    const sources = [
      renderPage('/'), JSON.stringify(getPages().map((p) => p.jsonLd)), buildLlmsTxt(), buildLlmsFullTxt(),
      ...getPages().map((p) => renderPage(p.path)),
      JSON.stringify(frHome), JSON.stringify(enHome), JSON.stringify(frLegal), JSON.stringify(enLegal),
    ]
    for (const s of sources) {
      expect(s).not.toMatch(/07 ?09 ?32 ?05 ?94|0709320594|\+33 ?0 ?6 ?19/)
    }
  })

  it('nom du produit : « NexusRH », jamais « NexusRH CI », sur la vitrine, llms.txt et le JSON-LD', () => {
    const sources = [
      renderPage('/'), JSON.stringify(getPages().map((p) => p.jsonLd)), buildLlmsTxt(), buildLlmsFullTxt(),
      ...getPages().map((p) => `${p.title} ${p.description} ${renderPage(p.path)}`),
      buildRobotsTxt(SITE_URL, getPages()),
    ]
    for (const s of sources) expect(s).not.toMatch(/NexusRH CI/)
    // Marque coupée par du balisage (ancien logo texte « NexusRH <span>CI</span> ») :
    // contrôle sur le HTML brut ET sur le texte visible (textContent, balises retirées).
    const brand = /NexusRH\s*(<[^>]+>\s*)*CI\b/
    const visible = (h: string): string =>
      (new DOMParser().parseFromString(h, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ')
    for (const p of getPages()) {
      const page = renderPage(p.path)
      expect(page, p.path).not.toMatch(brand)
      expect(visible(page), p.path).not.toMatch(/NexusRH ?CI\b/)
    }
    const html: string = buildPageHtml(TEMPLATE, getPages()[0]!, renderPage('/'), { siteUrl: SITE_URL })
    expect(html).not.toMatch(/NexusRH CI/)
    expect(html).not.toMatch(brand)
    expect(visible(html)).not.toMatch(/NexusRH ?CI\b/)
    // Le contrôle détecte bien une marque coupée par une balise.
    expect('NexusRH <span class="x">CI</span>').toMatch(brand)
    expect(visible('<b>NexusRH</b><span>CI</span>')).toMatch(/NexusRH ?CI\b/)
    expect(html).toContain('<meta property="og:site_name" content="NexusRH" />')
  })

  it('vitrine : featureList = un intitulé par module affiché', () => {
    const app = graphOf(getPages()[0]!.jsonLd).find((n) => n['@type'] === 'SoftwareApplication')!
    const count = HOME_DOMAINS.reduce((n, d) => n + d.modules.length, 0)
    expect(app.featureList).toHaveLength(count)
  })

  it('vitrine : la FAQPage est exactement la FAQ affichée à l’écran', () => {
    const faq = graphOf(getPages()[0]!.jsonLd).find((n) => n['@type'] === 'FAQPage')!
    const entities = faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[]
    const html = renderPage('/')
    const shownQ = textOf(html, '[data-faq] h3')
    const shownA = textOf(html, '[data-faq] p')
    expect(shownQ.length).toBeGreaterThanOrEqual(8)
    expect(shownQ.length).toBeLessThanOrEqual(10)
    expect(entities.map((e) => e.name)).toEqual(shownQ)
    expect(entities.map((e) => e.acceptedAnswer.text)).toEqual(shownA)
    expect(homeFaq().map((f) => f.q)).toEqual(shownQ)
  })

  it('pages de contenu : BreadcrumbList, et FAQPage seulement si la FAQ est visible', () => {
    const contentPaths = new Set<string>(SEO_PATHS)
    for (const p of getPages().filter((x) => contentPaths.has(x.path))) {
      const types = graphOf(p.jsonLd).map((n) => n['@type'])
      expect(types, p.path).toContain('BreadcrumbList')
      expect(types, p.path).toContain(p.ogType === 'article' ? 'Article' : 'WebPage')
      const seo = SEO_PAGES.find((x) => x.path === p.path)!
      expect(types.includes('FAQPage'), p.path).toBe(Boolean(seo.faq?.length))
    }
  })

  it('pages légales : WebPage + BreadcrumbList', () => {
    for (const p of getPages().filter((x) => x.path.startsWith('/legal/'))) {
      expect(graphOf(p.jsonLd).map((n) => n['@type']), p.path).toEqual(['Organization', 'WebPage', 'BreadcrumbList'])
    }
  })
})

describe('robots IA : robots.txt, llms.txt, llms-full.txt', () => {
  const robots: string = buildRobotsTxt(SITE_URL, getPages())
  const lines = robots.split('\n').filter((l) => l !== '' && !l.startsWith('#'))

  it('robots.txt nomme les robots IA et moteurs attendus, dans le même groupe que *', () => {
    const expected = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
      'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'Bingbot', 'Googlebot']
    for (const ua of expected) expect(lines, ua).toContain(`User-agent: ${ua}`)
    expect([...(NAMED_CRAWLERS as string[])].sort()).toEqual([...expected].sort())
    // Un seul groupe : toutes les lignes User-agent d'abord, `*` en dernier.
    const lastUa = lines.map((l) => l.startsWith('User-agent:')).lastIndexOf(true)
    expect(lines.slice(0, lastUa + 1).every((l) => l.startsWith('User-agent:'))).toBe(true)
    expect(lines[lastUa]).toBe('User-agent: *')
    expect(lines).toContain('Allow: /$')
    expect(lines).toContain('Allow: /llms.txt$')
    expect(lines).toContain('Allow: /llms-full.txt$')
  })

  it('robots.txt ferme les zones applicatives et pointe vers le sitemap', () => {
    for (const p of ['/dashboard', '/platform', '/api/', '/mon-espace']) {
      expect(APP_DISALLOW as string[]).toContain(p)
      expect(lines).toContain(`Disallow: ${p}`)
    }
    expect(lines).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`)
  })

  it('llms.txt : format llmstxt.org (titre, résumé, sections de liens) vers les pages clés', () => {
    const llms = buildLlmsTxt()
    expect(llms.length).toBeGreaterThan(500)
    const l = llms.split('\n')
    expect(l[0]).toBe('# NexusRH')
    expect(l[2]).toMatch(/^> .{50,}/)
    expect(llms).toMatch(/^## /m)
    for (const p of getPages()) expect(llms, p.path).toContain(`](${SITE_URL}${p.path})`)
    expect(llms).toContain(`](${SITE_URL}/llms-full.txt)`)
    expect(llms).toContain("selon le droit social de votre pays : Côte d'Ivoire et UEMOA, extensible aux autres pays de la CEDEAO et de la CEMAC")
  })

  it('llms-full.txt : reprend le texte publié (modules, déploiement, FAQ, pages de contenu)', () => {
    const full = buildLlmsFullTxt()
    expect(full.length).toBeGreaterThan(5000)
    const domains = frHome.domains as Record<string, { title: string; modules: Record<string, { title: string; text: string }> }>
    for (const d of HOME_DOMAINS) {
      expect(full).toContain(domains[d.key]!.title)
      for (const m of d.modules) expect(full, m.key).toContain(domains[d.key]!.modules[m.key]!.text)
    }
    expect(full).toContain(frHome.deploy.onprem.p1)
    for (const f of homeFaq()) { expect(full).toContain(f.q); expect(full).toContain(f.a) }
    for (const p of SEO_PAGES) expect(full, p.path).toContain(p.lead)
    // Règle d'or : ni certification, ni avis, ni chiffre de disponibilité.
    expect(full).not.toMatch(/ISO 27001|SOC ?2|certifié|aggregateRating|99[,.]9 ?%/i)
  })
})

describe('image de partage (og-image.png)', () => {
  it('1200 x 630, générée par scripts/generate-og-image.py, sans « CI » ni « ivoirienne »', () => {
    const png = readFileSync(join(__dirname, '..', '..', 'public', 'og-image.png'))
    // En-tête IHDR : largeur et hauteur aux octets 16 et 20.
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
    const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'generate-og-image.py'), 'utf8')
    expect(script).toContain("TITLE = 'NexusRH'")
    expect(script).toContain(`SUBTITLE = "SIRH et paie — Côte d'Ivoire et UEMOA"`)
    expect(script).toContain("BYLINE = 'par OpenLab Consulting'")
    expect(script).not.toMatch(/NexusRH CI|ivoirienne/)
    const html: string = buildPageHtml(TEMPLATE, getPages()[0]!, '<h1>X</h1>', { siteUrl: SITE_URL })
    expect(html).toContain(`og:image:alt" content="NexusRH — SIRH et paie, Côte d'Ivoire et UEMOA, par OpenLab Consulting"`)
  })
})
