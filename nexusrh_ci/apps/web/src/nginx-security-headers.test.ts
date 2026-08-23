import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import path from 'path'

// ── Règle nginx : les directives `add_header` d'un `location` REMPLACENT celles
// héritées du bloc `server` (elles ne s'y ajoutent pas). Un `location` qui pose
// ne serait-ce qu'un `add_header Cache-Control` perd donc TOUS les en-têtes de
// sécurité du serveur, dont la CSP. En prod, le document HTML de la SPA est
// servi par `location = /index.html` : sans CSP émise, l'ingress mutualisé
// retombe sur sa CSP globale (`frame-src` limité à challenges.cloudflare.com)
// et le navigateur bloque l'<iframe src="blob:…"> de l'aperçu du bulletin.
const WEB_DIR = path.resolve(__dirname, '..')
const CONF = path.join(WEB_DIR, 'nginx.conf')

/** Résout les `include` pointant vers un fichier versionné du dossier web. */
function readConf(): string {
  const raw = readFileSync(CONF, 'utf8')
  return raw.replace(/^[ \t]*include\s+(\S+);[ \t]*$/gm, (line, target: string) => {
    const local = path.join(WEB_DIR, path.basename(target))
    return existsSync(local) ? readFileSync(local, 'utf8') : line
  })
}

/** Découpe les blocs `location …{ … }` (accolades appariées). */
function locations(conf: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  const re = /location\s+([^{]+?)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(conf))) {
    let depth = 1
    let i = re.lastIndex
    while (i < conf.length && depth > 0) {
      if (conf[i] === '{') depth++
      else if (conf[i] === '}') depth--
      i++
    }
    out.push({ name: m[1]!.trim(), body: conf.slice(re.lastIndex, i - 1) })
  }
  return out
}

const headerNames = (block: string): string[] =>
  [...block.matchAll(/^[ \t]*add_header\s+([A-Za-z-]+)/gm)].map(m => m[1]!.toLowerCase())

/** En-têtes réellement émis par un location (règle de remplacement nginx). */
function effectiveHeaders(conf: string, name: string): string[] {
  const loc = locations(conf).find(l => l.name === name)
  if (!loc) throw new Error(`location "${name}" introuvable dans nginx.conf`)
  const own = headerNames(loc.body)
  if (own.length) return own
  // Aucun add_header propre → héritage du niveau server.
  const serverLevel = locations(conf).reduce((acc, l) => acc.replace(l.body, ''), conf)
  return headerNames(serverLevel)
}

const SECURITY_HEADERS = [
  'content-security-policy', 'x-content-type-options', 'x-frame-options',
  'referrer-policy', 'strict-transport-security',
]

describe('nginx.conf — en-têtes de sécurité et aperçu du bulletin', () => {
  const conf = readConf()

  it('sert la CSP sur le document HTML de la SPA (location = /index.html)', () => {
    expect(effectiveHeaders(conf, '= /index.html')).toEqual(expect.arrayContaining(SECURITY_HEADERS))
  })

  it('sert les en-têtes de sécurité sur les assets Vite', () => {
    const assets = locations(conf).find(l => l.name.includes('js|css'))
    expect(assets, 'location assets introuvable').toBeTruthy()
    expect(headerNames(assets!.body)).toEqual(expect.arrayContaining(SECURITY_HEADERS))
  })

  it('autorise blob: dans frame-src (aperçu PDF du constructeur de bulletin)', () => {
    const csp = conf.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/i)?.[1] ?? ''
    expect(csp).toMatch(/frame-src[^;]*blob:/)
  })

  it('le Dockerfile copie tout fichier inclus par nginx.conf', () => {
    const dockerfile = readFileSync(path.join(WEB_DIR, 'Dockerfile'), 'utf8')
    const includes = [...readFileSync(CONF, 'utf8').matchAll(/^[ \t]*include\s+(\S+);/gm)]
      .map(m => path.basename(m[1]!))
      .filter(f => existsSync(path.join(WEB_DIR, f)))
    for (const f of includes) expect(dockerfile).toContain(f)
  })
})
