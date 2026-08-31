/**
 * Golden — invariants d'architecture du worker.
 *
 * Le worker vit à côté de l'API sans partager son code : `utils/ssrf-guard.ts`,
 * `utils/crypto.ts`, `utils/http-body-limit.ts` et `utils/ci-holidays.ts` sont
 * des COPIES de leurs équivalents API, assumées comme telles (paquets
 * distincts, pas de build partagé). C'est précisément la configuration qui a
 * produit le constat central de l'audit du 29/08/2026 : une primitive de
 * sécurité recopiée finit par diverger, et personne ne le voit — les tests des
 * deux côtés restent verts.
 *
 * Les invariants de l'API (`apps/api/src/architecture-invariants.golden.test.ts`)
 * ne balaient que `apps/api`. Ce fichier fait le même travail ici, sur les deux
 * points qui portent réellement un risque côté worker : les appels sortants et
 * les exports morts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, sep } from 'path'

const WORKER_SRC = dirname(fileURLToPath(import.meta.url))

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const fp = join(dir, e)
    if (statSync(fp).isDirectory()) out.push(...walk(fp, match))
    else if (match.test(e)) out.push(fp)
  }
  return out
}

function workerSources() {
  const files = walk(WORKER_SRC, /\.ts$/)
  const read = (f: string) => ({ f: relative(WORKER_SRC, f).split(sep).join('/'), src: readFileSync(f, 'utf8') })
  return {
    prod:  files.filter(f => !/\.test\.ts$/.test(f)).map(read),
    tests: files.filter(f =>  /\.test\.ts$/.test(f)).map(read),
  }
}

describe('Invariants d’architecture — appels sortants du worker', () => {
  /**
   * Le worker traite des payloads de job qui portent des URLs venues de la base
   * (source de veille réglementaire, adresse d'une badgeuse). Un `fetch()` posé
   * dessus sans garde est un SSRF : le worker tourne DANS le cluster, il joint
   * les adresses privées et le service de métadonnées que personne d'autre ne
   * joint. C'est le trou qui a été trouvé le 31/08/2026 dans `legal-watch`,
   * alors que la garde était déjà dans le dossier d'à côté.
   */
  it('tout fetch sortant passe par la garde SSRF', () => {
    const offenders: string[] = []
    for (const { f, src } of workerSources().prod) {
      if (f === 'utils/ssrf-guard.ts') continue
      const calls = [...src.matchAll(/(?<![.\w])fetch\s*\(\s*([^,)\n]*)/g)]
      if (calls.length === 0) continue
      if (!/from '\.{1,2}\/(?:\.\.\/)*utils\/ssrf-guard\.js'/.test(src)) {
        offenders.push(`${f} : appelle fetch() sans importer la garde SSRF`)
        continue
      }
      for (const c of calls) {
        const arg = (c[1] ?? '').trim()
        // Seule forme acceptée : l'URL RÉSOLUE par la garde. Passer l'URL brute
        // laisserait le DNS être rejoué après la validation (rebinding).
        if (!/^safe\.value\.url\b/.test(arg)) {
          offenders.push(`${f} : fetch(${arg}…) — attendu fetch(safe.value.url.toString(), …)`)
        }
      }
    }
    expect(
      offenders,
      'Appels sortants non gardés (OWASP A10) :\n' + offenders.map(o => `  ${o}`).join('\n')
      + '\n\nMotif à suivre (cf. jobs/attendance-poll.ts et jobs/legal-watch.ts) :\n'
      + "  const safe = await resolveSafeOutboundResult(url)\n"
      + "  if (safe.ok !== true) …\n"
      + "  await fetch(safe.value.url.toString(), { redirect: 'manual', dispatcher: safe.value.dispatcher, … })",
    ).toEqual([])
  })

  it('les appels sortants ne suivent pas les redirections', () => {
    // Une source légitime qui redirige vers `http://10.0.0.5/` contournerait la
    // validation : elle porte sur l'URL de départ, pas sur la destination.
    const offenders = workerSources().prod
      .filter(({ f }) => f !== 'utils/ssrf-guard.ts')
      .filter(({ src }) => /(?<![.\w])fetch\s*\(/.test(src))
      .filter(({ src }) => !/redirect:\s*'manual'/.test(src))
      .map(({ f }) => f)
    expect(
      offenders,
      "Ces appels sortants suivent les redirections — ajouter `redirect: 'manual'` :\n"
      + offenders.map(o => `  ${o}`).join('\n'),
    ).toEqual([])
  })
})

/**
 * Exports morts — même invariant que côté API, même motif de défaillance.
 *
 * La liste est VIDE et doit le rester : le worker est petit (une trentaine de
 * fichiers), rien n'y justifie d'exporter une fonction que personne n'appelle.
 */
const DEAD_EXPORTS_BASELINE = new Set<string>([])

const wordRe = (n: string) => new RegExp(String.raw`\b` + n + String.raw`\b`)

function stripDeclaration(src: string, n: string): string {
  return src
    .replace(new RegExp(String.raw`export\s+(?:async\s+)?function\s+` + n + String.raw`\b`, 'g'), ' ')
    .replace(new RegExp(String.raw`export\s+const\s+` + n + String.raw`\s*[:=]`, 'g'), ' ')
}

function usedInProduction(name: string, file: string, prod: Array<{ f: string; src: string }>): boolean {
  const own = prod.find(p => p.f === file)
  if (own && wordRe(name).test(stripDeclaration(own.src, name))) return true
  return prod.some(p => p.f !== file && wordRe(name).test(p.src))
}

describe('Invariant — aucune fonction exportée hors du chemin d’exécution (worker)', () => {
  it('aucun export mort', () => {
    const { prod, tests } = workerSources()

    const DECL  = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g
    const ARROW = /export\s+const\s+([A-Za-z0-9_]+)\s*[:=][^=\n]*=>/g
    const exported: Array<{ name: string; file: string }> = []
    for (const { f, src } of prod) {
      for (const re of [DECL, ARROW]) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) exported.push({ name: m[1] as string, file: f })
      }
    }

    const dead = [...new Set(
      exported.filter(e => !usedInProduction(e.name, e.file, prod)).map(e => `${e.file}::${e.name}`),
    )].filter(d => !DEAD_EXPORTS_BASELINE.has(d))

    const annote = dead.map(d => {
      const name = d.split('::')[1] as string
      const teste = tests.some(t => wordRe(name).test(t.src))
      return `  ${d}${teste ? '   ← testée, mais jamais exécutée en production' : ''}`
    })

    expect(
      dead,
      'Ces fonctions sont exportées et aucun code de production du worker ne les utilise :\n'
      + annote.join('\n')
      + '\n\nLa brancher si elle porte une règle ou un contrôle, la supprimer sinon.',
    ).toEqual([])
  })
})
