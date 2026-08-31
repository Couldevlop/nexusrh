/**
 * Golden — aucun export du paquet partagé n'est orphelin.
 *
 * `apps/api` et `apps/worker` ont chacun leur invariant « aucune fonction
 * exportée hors du chemin d'exécution », mais chacun ne balaie que son propre
 * dossier. En déplaçant `ssrf-guard`, `crypto`, `http-body-limit` et
 * `ci-holidays` ici le 31/08/2026, ces quatre modules seraient sortis du champ
 * des deux invariants — un angle mort pile sur les primitives de sécurité.
 *
 * Ce test ferme l'angle mort. Il est le SEUL endroit où la question a un sens :
 * un export du paquet partagé n'est mort que si AUCUN consommateur ne s'en
 * sert. Il regarde donc, volontairement, en dehors du paquet.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, sep } from 'path'

const SHARED_SRC = dirname(fileURLToPath(import.meta.url))
const REPO       = join(SHARED_SRC, '..', '..', '..')
const CONSUMERS  = [join(REPO, 'apps', 'api', 'src'), join(REPO, 'apps', 'worker', 'src')]

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const fp = join(dir, e)
    if (statSync(fp).isDirectory()) out.push(...walk(fp, match))
    else if (match.test(e)) out.push(fp)
  }
  return out
}

/** Code de production des deux apps (les tests ne comptent pas comme usage). */
function consumerSources(): string {
  return CONSUMERS
    .filter(existsSync)
    .flatMap(dir => walk(dir, /\.ts$/))
    .filter(f => !/\.test\.ts$/.test(f))
    .map(f => readFileSync(f, 'utf8'))
    .join('\n')
}

const wordRe = (n: string) => new RegExp(String.raw`\b` + n + String.raw`\b`)

function stripDeclaration(src: string, n: string): string {
  return src
    .replace(new RegExp(String.raw`export\s+(?:async\s+)?function\s+` + n + String.raw`\b`, 'g'), ' ')
    .replace(new RegExp(String.raw`export\s+const\s+` + n + String.raw`\s*[:=]`, 'g'), ' ')
    .replace(new RegExp(String.raw`export\s+class\s+` + n + String.raw`\b`, 'g'), ' ')
}

describe('Invariant — le paquet partagé n’expose rien que personne n’appelle', () => {
  it('chaque export est utilisé par l’API, par le worker, ou en interne', () => {
    const modules = walk(SHARED_SRC, /\.ts$/).filter(f => !/\.test\.ts$/.test(f))
    const consumers = consumerSources()
    const ownSrc = new Map(modules.map(f => [f, readFileSync(f, 'utf8')]))
    const allShared = [...ownSrc.values()].join('\n')

    const DECL  = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g
    const ARROW = /export\s+const\s+([A-Za-z0-9_]+)\s*[:=][^=\n]*=>/g
    const CLASS = /export\s+class\s+([A-Za-z0-9_]+)/g

    const dead: string[] = []
    for (const [file, src] of ownSrc) {
      const rel = relative(SHARED_SRC, file).split(sep).join('/')
      for (const re of [DECL, ARROW, CLASS]) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) {
          const name = m[1] as string
          const usedByConsumer = wordRe(name).test(consumers)
          // Usage interne au paquet : un helper appelé par un autre module
          // partagé est bien vivant, même si aucune app ne l'importe.
          const usedInternally = wordRe(name).test(stripDeclaration(allShared, name))
          if (!usedByConsumer && !usedInternally) dead.push(`${rel}::${name}`)
        }
      }
    }

    expect(
      [...new Set(dead)],
      'Ces exports du paquet partagé ne servent NI à l’API, NI au worker :\n'
      + [...new Set(dead)].map(d => `  ${d}`).join('\n')
      + '\n\nLes supprimer. Un paquet partagé est le pire endroit où laisser du code mort :\n'
      + 'il a l’air utilisé parce qu’il est « partagé », et personne ne va vérifier.',
    ).toEqual([])
  })
})
