/**
 * Étape de build : écrit dans dist/ les pages publiques pré-générées
 * (home.html, legal/*.html), robots.txt et sitemap.xml.
 * Prérequis : `vite build` (client → dist/) puis
 * `vite build --ssr src/prerender/entry.tsx --outDir dist-ssr`.
 * nginx.conf sert home.html sur `/` et legal/<doc>.html sur `/legal/<doc>`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildPageHtml, buildRobotsTxt, buildSitemap } from './seo-html.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

const { getPages, renderPage, SITE_URL } = await import(pathToFileURL(join(root, 'dist-ssr', 'entry.js')).href)

const template = readFileSync(join(dist, 'index.html'), 'utf8')
// Le composant de la vitrine est chargé à la demande (React.lazy) : on le
// précharge dans home.html pour que le bundle reprenne la main sans délai.
const homeChunk = readdirSync(join(dist, 'assets')).find((f) => /^HomePage-[\w-]+\.js$/.test(f))
if (!homeChunk) throw new Error('Chunk HomePage introuvable dans dist/assets')

const pages = getPages()
for (const page of pages) {
  const body = renderPage(page.path)
  if (!body.includes('<h1')) throw new Error(`Pré-rendu vide pour ${page.path}`)
  const html = buildPageHtml(template, page, body, {
    siteUrl: SITE_URL,
    preload: page.path === '/' ? [`/assets/${homeChunk}`] : [],
  })
  const out = join(dist, page.file)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, html)
  console.log(`prerender: ${page.path} → dist/${page.file}`)
}

writeFileSync(join(dist, 'robots.txt'), buildRobotsTxt(SITE_URL))
writeFileSync(join(dist, 'sitemap.xml'), buildSitemap(SITE_URL, pages, new Date().toISOString().slice(0, 10)))
console.log(`prerender: robots.txt + sitemap.xml (${pages.length} URL)`)
