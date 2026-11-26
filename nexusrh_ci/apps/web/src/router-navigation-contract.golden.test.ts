/**
 * Golden — Contrat routeur ↔ navigation : chaque `navigate()` et chaque
 * `<Link to>` littéral atteint une route réellement déclarée dans `App.tsx`.
 *
 * POURQUOI CE TEST EXISTE. Le 25/11/2026, le bandeau d'expiration et le rappel
 * par email envoyaient vers `/change-password` — une adresse qui n'existait
 * pas. Le 26/11, le tableau de bord manager envoyait vers `/expenses` quand la
 * route s'appelle `expenses-rh`. Dans les deux cas, la route attrape-tout
 * (`path="*"` → `Navigate to="/"`) a renvoyé l'utilisateur sur l'accueil : pas
 * de 404, pas d'erreur en console, pas de ligne dans les journaux. Le bouton
 * paraît simplement inerte, et personne ne le voit avant un utilisateur.
 *
 * Le golden `ui-api-contract` côté API couvre l'autre sens (chaque `api.*()` du
 * front atteint une route backend). Celui-ci couvre la navigation interne, qui
 * n'était vérifiée par rien.
 *
 * LIMITE ASSUMÉE : seules les cibles LITTÉRALES sont vérifiables. Une cible
 * construite (`to={`/employees/${id}`}`) ne l'est pas statiquement ; elle est
 * comptée et affichée, jamais comptée en échec. C'est pourquoi le test vérifie
 * aussi que le nombre de cibles résolues reste plausible : une extraction qui
 * tomberait à zéro rendrait ce contrôle vert sans rien avoir regardé.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const WEB_SRC = import.meta.dirname

/**
 * Chemins déclarés dans `App.tsx`.
 *
 * Convention du fichier, sur laquelle repose cette lecture : les routes de
 * groupe portent un chemin ABSOLU (`/platform`, `/agency`, `/mon-espace`, `/`)
 * et leurs enfants un chemin RELATIF. Un chemin relatif appartient donc au
 * dernier chemin absolu rencontré au-dessus de lui. L'assertion sur le nombre
 * de routes ci-dessous est ce qui signale un changement de cette convention.
 */
function routesDuRouteur(): Set<string> {
  const src = readFileSync(join(WEB_SRC, 'App.tsx'), 'utf8')
  const routes = new Set<string>()
  let parent = '/'
  for (const ligne of src.split('\n')) {
    const m = ligne.match(/path=["']([^"']+)["']/)
    if (!m) continue
    const p = m[1] ?? ''
    if (p.startsWith('/')) {
      parent = p
      routes.add(p)
    } else {
      routes.add(`${parent === '/' ? '' : parent}/${p}`)
    }
  }
  // Pages de contenu SEO : montées par `SEO_PATHS.map(...)`, donc absentes
  // sous forme littérale dans App.tsx.
  const seo = readFileSync(join(WEB_SRC, 'pages', 'public', 'seo', 'paths.ts'), 'utf8')
  for (const m of seo.matchAll(/['"](\/[a-z0-9/-]+)['"]/g)) routes.add(m[1] ?? '')
  return routes
}

function fichiersSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      if (e !== 'node_modules' && e !== 'dist') fichiersSources(p, out)
    } else if (/\.(ts|tsx)$/.test(e) && !/\.test\.(ts|tsx)$/.test(e)) {
      out.push(p)
    }
  }
  return out
}

interface Cible { chemin: string; fichier: string; ligne: number }

/** Cibles de navigation littérales : `navigate('/x')`, `to="/x"`, `to={'/x'}`. */
function ciblesDeNavigation(): Cible[] {
  const cibles: Cible[] = []
  for (const f of fichiersSources(WEB_SRC)) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:navigate\(|to=\{?)\s*['"](\/[A-Za-z0-9/_-]*)['"]/g)) {
      cibles.push({
        chemin: m[1] ?? '',
        fichier: f.slice(WEB_SRC.length + 1).replace(/\\/g, '/'),
        ligne: src.slice(0, m.index).split('\n').length,
      })
    }
  }
  return cibles
}

/** Une cible correspond si une route l'égale, ou la couvre via ses `:param`. */
function couverte(cible: string, routes: Set<string>): boolean {
  if (routes.has(cible)) return true
  const c = cible.split('/')
  for (const r of routes) {
    const segs = r.split('/')
    if (segs.length !== c.length) continue
    if (segs.every((s, i) => s.startsWith(':') || s === c[i])) return true
  }
  return false
}

describe('Golden Contrat routeur ↔ navigation', () => {
  const routes = routesDuRouteur()
  const cibles = ciblesDeNavigation()

  it('extrait un nombre plausible de routes et de cibles', () => {
    // Garde anti-test-muet : une extraction cassée doit échouer bruyamment,
    // pas se taire. C'est le mode de panne qui a laissé passer 9 fichiers de
    // routes dans le balayage d'autorisation côté API.
    expect(routes.size).toBeGreaterThan(60)
    expect(cibles.length).toBeGreaterThan(20)
  })

  it('aucune cible de navigation ne pointe vers une route inexistante', () => {
    const orphelines = cibles.filter(c => !couverte(c.chemin, routes))
    const lignes = orphelines.map(c => `  ${c.chemin}  ← ${c.fichier}:${c.ligne}`)
    expect(
      lignes,
      'Cible(s) de navigation sans route dans App.tsx :\n' + lignes.join('\n')
      + '\n\nL\'attrape-tout `path="*"` renverra l\'utilisateur sur `/` sans aucune\n'
      + 'erreur visible : le bouton paraîtra inerte. Corriger le chemin, ou\n'
      + 'déclarer la route manquante.\n',
    ).toEqual([])
  })

  it('la route attrape-tout existe toujours (sinon écran blanc)', () => {
    const src = readFileSync(join(WEB_SRC, 'App.tsx'), 'utf8')
    expect(src).toMatch(/path="\*"/)
  })
})
