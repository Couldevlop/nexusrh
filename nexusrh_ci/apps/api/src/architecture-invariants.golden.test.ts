/**
 * Golden — invariants d'architecture.
 *
 * L'audit du 29/08/2026 a montré que la duplication de ce dépôt n'était pas
 * seulement de la dette : elle avait DÉBRANCHÉ un contrôle de sécurité. Le
 * service `cv-extraction` était mort parce que sa fonction utile avait été
 * recopiée dans un fichier de routes, et avec lui le contrôle anti-usurpation
 * `isMagicByteConsistent` — écrit, documenté, testé, jamais exécuté.
 *
 * Ces tests empêchent la RÉAPPARITION de ce motif. Ils échouent quand un
 * nouveau module recopie une primitive partagée au lieu de l'importer, ce qui
 * est exactement le moment où le rappel est utile : à la revue, pas six mois
 * plus tard.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, sep } from 'path'

const API_SRC = dirname(fileURLToPath(import.meta.url))
const MODULES = join(API_SRC, 'modules')

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const fp = join(dir, e)
    if (statSync(fp).isDirectory()) out.push(...walk(fp, match))
    else if (match.test(e)) out.push(fp)
  }
  return out
}

const routeFiles = walk(MODULES, /\.routes\.ts$/)
const rel = (f: string) => relative(MODULES, f).split(sep).join('/')
const sources = routeFiles.map(f => ({ file: rel(f), src: readFileSync(f, 'utf8') }))

describe('Invariants d’architecture — pas de recopie des primitives partagées', () => {
  it('l’écriture de la piste d’audit passe par utils/audit-log.ts', () => {
    // Exceptions assumées : ces écritures ont un jeu de colonnes RÉELLEMENT
    // différent de la forme standard, et les fusionner changerait la donnée
    // écrite. Chacune est justifiée ; la liste ne doit pas s'allonger sans
    // qu'une raison de ce niveau soit énoncée.
    //  - auth.routes.ts     : colonne supplémentaire `user_agent`
    //  - auth-mfa.routes.ts : aiguille vers platform.activity_log (autre table)
    //  - payroll.routes.ts  : journal de consultation avec `created_at` au lieu
    //                         d'`ip_address`
    //  - platform.routes.ts : trace système à 3 colonnes, sans utilisateur
    const ALLOWED = new Set([
      'auth/auth.routes.ts',
      'auth/auth-mfa.routes.ts',
      'payroll/payroll.routes.ts',
      'platform/platform.routes.ts',
    ])
    const offenders = sources
      .filter(s => !ALLOWED.has(s.file))
      .filter(s => /INSERT INTO\s+(?:"\$\{[^}]+\}"|platform)\.\s*(?:audit_log|activity_log)/.test(s.src))
      .map(s => s.file)
    expect(
      offenders,
      `Ces modules écrivent l'audit en direct au lieu d'appeler auditTenant()/auditPlatform() :\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('aucun module ne redéfinit badRequest()', () => {
    // offboarding conserve sa variante : sa réponse a une AUTRE forme
    // (`issues`/`field`), consommée telle quelle par le front.
    const ALLOWED = new Set(['offboarding/offboarding.routes.ts'])
    const offenders = sources
      .filter(s => !ALLOWED.has(s.file))
      .filter(s => /function\s+badRequest\s*\(/.test(s.src))
      .map(s => s.file)
    expect(
      offenders,
      `badRequest() est défini dans utils/http-errors.ts — à importer, pas à recopier :\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('le hook de migration paresseuse du schéma n’est pas recopié', () => {
    const offenders = sources
      .filter(s => /addHook\('preHandler',\s*async \(request\) => \{[\s\S]{0,120}?ensureTenantSchema\(/.test(s.src))
      .map(s => s.file)
    expect(
      offenders,
      `Utiliser ensureTenantSchemaHook (utils/tenant-schema-hook.ts) :\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('aucun service du dépôt n’est orphelin (le cas cv-extraction ne se reproduit pas)', () => {
    // Un service que PERSONNE n'importe est du code mort — et, quand il porte un
    // contrôle de sécurité, une protection qui ne s'exécute jamais tout en
    // affichant des tests verts.
    const services = walk(join(API_SRC, 'services'), /\.ts$/)
      .filter(f => !/\.test\.ts$/.test(f))
    const allSrc = [
      ...walk(join(API_SRC, 'modules'), /\.ts$/).filter(f => !/\.test\.ts$/.test(f)),
      ...services,
      ...walk(join(API_SRC, 'utils'), /\.ts$/).filter(f => !/\.test\.ts$/.test(f)),
      ...walk(join(API_SRC, 'scripts'), /\.ts$/).filter(f => !/\.test\.ts$/.test(f)),
      join(API_SRC, 'app.ts'),
    ].map(f => readFileSync(f, 'utf8')).join('\n')
    // Un fichier peut aussi être un POINT D'ENTRÉE déclaré dans package.json
    // (script npm lancé par tsx) : ce n'est pas du code mort.
    const pkg = readFileSync(join(API_SRC, '..', 'package.json'), 'utf8')

    const orphans = services.filter(f => {
      const base = f.split(sep).pop()!.replace(/\.ts$/, '')
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const importedAsJs = new RegExp(`['"\`][^'"\`]*${esc}\\.js['"\`]`).test(allSrc)
      const entrypoint   = new RegExp(`${esc}\\.ts`).test(pkg)
      return !importedAsJs && !entrypoint
    }).map(f => relative(API_SRC, f).split(sep).join('/'))

    expect(
      orphans,
      `Services jamais importés (code mort — vérifier qu'aucun contrôle de sécurité n'y dort) :\n${orphans.join('\n')}`,
    ).toEqual([])
  })

  it('aucune évaluation dynamique de code côté serveur', () => {
    const all = [
      ...walk(join(API_SRC, 'modules'), /\.ts$/),
      ...walk(join(API_SRC, 'services'), /\.ts$/),
      ...walk(join(API_SRC, 'utils'), /\.ts$/),
    ].filter(f => !/\.test\.ts$/.test(f))
    // Les commentaires sont retirés avant l'analyse : ce fichier — comme celui
    // de payroll-engine-ci.ts — MENTIONNE `new Function()` pour expliquer
    // pourquoi il n'en utilise pas.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const offenders = all
      .filter(f => /\bnew Function\s*\(|(?<![.\w])eval\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map(f => relative(API_SRC, f).split(sep).join('/'))
    expect(
      offenders,
      `new Function()/eval() interdits côté serveur (cf. evalArithmetic dans payroll-engine-ci.ts) :\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
