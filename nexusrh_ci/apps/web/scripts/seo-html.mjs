/**
 * Assemblage SEO des pages pré-générées — fonctions PURES (testées dans
 * src/prerender/seo-html.test.ts). L'écriture des fichiers est dans prerender.mjs.
 *
 * Le gabarit de départ est dist/index.html (celui de l'application, en
 * `noindex`) : chaque remplacement est vérifié, pour qu'une évolution du
 * gabarit fasse échouer le build au lieu de publier une page mal balisée.
 */

const escapeAttr = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// JSON-LD dans une balise <script> : `<` échappé pour qu'aucune valeur ne puisse
// fermer la balise (`</script>`).
const jsonLdScript = (data) =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`

function replaceOnce(html, pattern, replacement, label) {
  if (!pattern.test(html)) throw new Error(`Gabarit index.html inattendu : ${label} introuvable`)
  return html.replace(pattern, replacement)
}

/**
 * @param {string} template  dist/index.html
 * @param {{path:string,title:string,description:string,jsonLd?:object}} page
 * @param {string} bodyHtml  rendu React de la page (contenu de #root)
 * @param {{siteUrl:string, preload?:string[]}} opts
 */
export function buildPageHtml(template, page, bodyHtml, { siteUrl, preload = [] }) {
  const url = `${siteUrl}${page.path}`
  const title = escapeAttr(page.title)
  const description = escapeAttr(page.description)

  let html = template
  html = replaceOnce(html, /<meta name="robots"[^>]*>/,
    '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />', 'meta robots')
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`, '<title>')
  html = replaceOnce(html, /<meta name="description"[^>]*>/,
    `<meta name="description" content="${description}" />`, 'meta description')

  const head = [
    `<link rel="canonical" href="${escapeAttr(url)}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="NexusRH CI" />',
    '<meta property="og:locale" content="fr_CI" />',
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${escapeAttr(url)}" />`,
    `<meta property="og:image" content="${escapeAttr(`${siteUrl}/og-image.png`)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta property="og:image:alt" content="NexusRH CI — logiciel de paie et SIRH pour la Côte d\'Ivoire" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${escapeAttr(`${siteUrl}/og-image.png`)}" />`,
    ...preload.map((href) => `<link rel="modulepreload" crossorigin href="${escapeAttr(href)}" />`),
    ...(page.jsonLd ? [jsonLdScript(page.jsonLd)] : []),
  ].map((l) => `    ${l}`).join('\n')
  html = replaceOnce(html, /<\/head>/, `${head}\n  </head>`, '</head>')
  html = replaceOnce(html, /<div id="root"><\/div>/, `<div id="root">${bodyHtml}</div>`, '<div id="root">')
  return html
}

/** robots.txt : seules la vitrine, les pages légales et leurs ressources sont explorables. */
export function buildRobotsTxt(siteUrl) {
  return [
    '# NexusRH CI — seules les pages publiques sont explorables.',
    "# L'application (espaces RH, paie, offres des tenants…) reste hors index.",
    'User-agent: *',
    'Allow: /$',
    'Allow: /legal/',
    'Allow: /assets/',
    'Allow: /openlab.png',
    'Allow: /logo.svg',
    'Allow: /og-image.png',
    // Fichier de vérification Bing Webmaster Tools (propriété du site).
    'Allow: /BingSiteAuth.xml',
    'Disallow: /',
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n')
}

/** sitemap.xml des pages pré-générées. */
export function buildSitemap(siteUrl, pages, lastmod) {
  const urls = pages.map((p) => [
    '  <url>',
    `    <loc>${escapeAttr(`${siteUrl}${p.path}`)}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${p.changefreq}</changefreq>`,
    `    <priority>${p.priority}</priority>`,
    '  </url>',
  ].join('\n'))
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}
