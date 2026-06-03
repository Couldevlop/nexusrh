/**
 * Golden — Contrat UI ↔ API : chaque bouton/appel du frontend cible un endpoint
 * backend RÉEL.
 *
 * Risque couvert (CLAUDE.md : « chaque bouton UI doit fonctionner sans 404 ») :
 * un bouton câblé sur un endpoint inexistant (mauvais chemin/méthode) → 404 →
 * fonctionnalité cassée. Ce test recoupe STATIQUEMENT, sans serveur :
 *   - tous les appels `api.{get,post,put,patch,delete}('…')` du code web ;
 *   - toutes les routes `(fastify|app).{method}('…')` du backend (avec préfixes).
 * Il échoue si un appel frontend résoluble n'a aucune route backend correspondante.
 *
 * Limites assumées (NON comptées comme erreurs, juste loggées) : appels dont le
 * chemin est une variable (`api.get(url)`) ou un template à ternaire imbriqué
 * (quotes dans `${…}`) — non résolubles statiquement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = dirname(fileURLToPath(import.meta.url))          // apps/api/src
const WEB_SRC = join(API_SRC, '..', '..', 'web', 'src')
const MODULES = join(API_SRC, 'modules')

// Préfixe de montage par fichier de routes (source de vérité : app.ts).
const PREFIX: Record<string, string> = {
  'auth/auth.routes.ts': '/auth',
  'auth/auth-mfa.routes.ts': '/auth',
  'platform/platform.routes.ts': '/platform',
  'platform/legal-watch.routes.ts': '/platform/legal-watch',
  'employees/employees.routes.ts': '/employees',
  'absences/absences.routes.ts': '/absences',
  'payroll/payroll.routes.ts': '/payroll',
  'payroll/payroll-workflow.routes.ts': '/payroll-workflow',
  'cnps/cnps.routes.ts': '/cnps',
  'mobile-money/mobile-money.routes.ts': '/mobile-money',
  'recruitment/recruitment.routes.ts': '/recruitment',
  'training/training.routes.ts': '/training',
  'expenses/expenses.routes.ts': '/expenses',
  'reporting/reporting.routes.ts': '/reporting',
  'careers/careers.routes.ts': '/careers',
  'settings/settings.routes.ts': '/settings',
  'contracts/contracts.routes.ts': '/contracts',
  'ai/ai.routes.ts': '/ai',
  'referentiels/referentiels.routes.ts': '/referentiels',
  'agency/agency.routes.ts': '/agency',
  'platform/brand.routes.ts': '/platform/brand',
  'integrations/integrations.routes.ts': '/integrations',
}

function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const fp = join(dir, e)
    if (statSync(fp).isDirectory()) out.push(...walk(fp, exts))
    else if (exts.test(e)) out.push(fp)
  }
  return out
}

const segs = (p: string): string[] => p.replace(/\/+$/, '').split('/').filter(Boolean)

// Une route backend (segments, où :param = joker).
interface Route { method: string; seg: string[] }

function backendRoutes(): Route[] {
  const routes: Route[] = []
  for (const [file, prefix] of Object.entries(PREFIX)) {
    let txt: string
    try { txt = readFileSync(join(MODULES, file), 'utf8') } catch { continue }
    const re = /\b(?:fastify|app)\.(get|post|put|patch|delete)\b[^(]*\(\s*[`'"]([^`'"]+)[`'"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(txt))) {
      const method = m[1]!.toUpperCase()
      const path = m[2] === '/' ? '' : m[2]!
      routes.push({ method, seg: segs(prefix + path) })
    }
  }
  return routes
}

// Résout un chemin d'appel frontend en segments, ou null si non résoluble.
function resolveFrontPath(raw: string): string[] | null {
  if (!raw.startsWith('/')) return null
  let p = raw.replace(/\$\{[^}]*\}/g, ':p') // ${x} équilibré → joker
  if (p.includes('${') || p.includes('`')) return null // ternaire/template tronqué
  p = p.replace(/\?.*$/, '')                 // query string
  return segs(p)
}

function matches(call: { method: string; seg: string[] }, routes: Route[]): boolean {
  return routes.some(r =>
    r.method === call.method &&
    r.seg.length === call.seg.length &&
    r.seg.every((rs, i) => rs.startsWith(':') || call.seg[i] === ':p' || rs === call.seg[i]),
  )
}

describe('Golden Contrat UI↔API — chaque appel frontend cible un endpoint réel', () => {
  const routes = backendRoutes()

  it('le backend expose un nombre plausible de routes (extraction OK)', () => {
    expect(routes.length).toBeGreaterThan(150)
  })

  it('aucun appel api.* du frontend ne pointe vers un endpoint inexistant', () => {
    const missing: string[] = []
    let resolved = 0, unresolved = 0
    const callRe = /\bapi\.(get|post|put|patch|delete)\(\s*([`'"])([^`'"]*)\2/g

    for (const fp of walk(WEB_SRC, /\.(ts|tsx)$/)) {
      const txt = readFileSync(fp, 'utf8')
      let m: RegExpExecArray | null
      while ((m = callRe.exec(txt))) {
        const method = m[1]!.toUpperCase()
        const raw = m[3]!
        const seg = resolveFrontPath(raw)
        if (!seg) { unresolved++; continue }
        resolved++
        if (!matches({ method, seg }, routes)) {
          missing.push(`${method} ${raw}  @ ${fp.slice(WEB_SRC.length + 1).replace(/\\/g, '/')}`)
        }
      }
    }

    // Diagnostic lisible en cas d'échec.
    const report = `Appels résolus: ${resolved}, non résolus (dynamiques): ${unresolved}, sans endpoint: ${missing.length}\n` +
      missing.map(s => '  ✗ ' + s).join('\n')
    expect(missing, report).toEqual([])
  })
})
