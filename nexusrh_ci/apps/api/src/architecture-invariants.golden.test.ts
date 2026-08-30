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

/**
 * Fonctions exportées dont AUCUN code de production ne se sert.
 *
 * C'est le mode de défaillance qui a produit les deux plus gros constats de
 * l'audit du 30/08/2026 : `isMagicByteConsistent` (contrôle anti-usurpation de
 * fichier) et `evaluateScreening` (moteur de pré-tri) étaient écrits,
 * documentés, couverts par des tests verts — et appelés par personne. La
 * couverture de code ne voyait rien : leurs tests unitaires passaient.
 *
 * L'invariant « aucun service orphelin » ne les attrapait pas : leurs FICHIERS
 * étaient bien importés, seule la fonction principale était morte.
 *
 * ── Pourquoi un cliquet plutôt qu'une règle stricte ─────────────────────────
 * Le dépôt compte aujourd'hui 24 exports dans ce cas, essentiellement des
 * prédicats de validation (`isValidType`, `severityOf`…) exportés pour tester
 * une logique pure que les routes valident autrement, via Zod. Les exiger tous
 * câblés bloquerait le dépôt sans rien sécuriser. On fige donc l'existant et on
 * refuse toute NOUVELLE occurrence : c'est le jour de son introduction que le
 * problème se corrige à moindre coût.
 */
const DEAD_EXPORTS_BASELINE = new Set<string>([
  // SEULE exception conservée, et pour une raison précise : `payroll_rules.formula`
  // est provisionnée en base (16 rubriques préconfigurées). Supprimer son unique
  // évaluateur laisserait ces données sans lecteur — exactement le motif « écrit,
  // jamais lu » que cet invariant combat. La fonction est par ailleurs le
  // remplaçant durci d'un `new Function()` (constat S-06 de l'audit du 30/08) :
  // la retirer déferait un correctif de sécurité livré en production.
  // À câbler le jour où le moteur de paie devient piloté par les règles.
  'services/payroll-engine-ci.ts::evalFormule',
])

/**
 * TOUS les fichiers TypeScript de l'API, séparés production / tests.
 *
 * Le scan doit être exhaustif : restreindre à une liste de dossiers produit des
 * faux positifs sur les symboles consommés par un point d'entrée
 * (`index.ts` → `buildApp`) ou par un script (`scripts/rns-calibrate.ts` →
 * `generateRnsCalibrationPdf`).
 */
function apiSources() {
  const files = walk(API_SRC, /\.ts$/)
  const read = (f: string) => ({ f: relative(API_SRC, f).split(sep).join('/'), src: readFileSync(f, 'utf8') })
  return {
    prod:  files.filter(f => !/\.test\.ts$/.test(f)).map(read),
    tests: files.filter(f =>  /\.test\.ts$/.test(f)).map(read),
  }
}

const wordRe = (n: string) => new RegExp(String.raw`\b` + n + String.raw`\b`)

/** Retire la DÉCLARATION du symbole pour ne compter que ses usages réels. */
function stripDeclaration(src: string, n: string): string {
  return src
    .replace(new RegExp(String.raw`export\s+(?:async\s+)?function\s+` + n + String.raw`\b`, 'g'), ' ')
    .replace(new RegExp(String.raw`export\s+const\s+` + n + String.raw`\s*[:=]`, 'g'), ' ')
}

/** Le symbole est-il utilisé quelque part dans le code de production ? */
function usedInProduction(
  name: string, file: string, prod: Array<{ f: string; src: string }>,
): boolean {
  const own = prod.find(p => p.f === file)
  if (own && wordRe(name).test(stripDeclaration(own.src, name))) return true
  return prod.some(p => p.f !== file && wordRe(name).test(p.src))
}

describe('Invariant — aucune fonction exportée hors du chemin d’exécution', () => {
  it('aucun NOUVEL export mort n’est introduit', () => {
    const { prod, tests } = apiSources()

    const DECL = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g
    const ARROW = /export\s+const\s+([A-Za-z0-9_]+)\s*[:=][^=\n]*=>/g
    const exported: Array<{ name: string; file: string }> = []
    for (const { f, src } of prod) {
      for (const re of [DECL, ARROW]) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) exported.push({ name: m[1] as string, file: f })
      }
    }

    const dead = exported
      .filter(e => !usedInProduction(e.name, e.file, prod))
      .map(e => `${e.file}::${e.name}`)

    const nouveaux = [...new Set(dead)].filter(d => !DEAD_EXPORTS_BASELINE.has(d))
    // Un export mort MAIS testé est le cas le plus trompeur : la couverture est
    // verte alors que rien ne s'exécute en production. On le signale comme tel.
    const annote = nouveaux.map(d => {
      const name = d.split('::')[1] as string
      const teste = tests.some(t => wordRe(name).test(t.src))
      return `  ${d}${teste ? '   ← testée, mais jamais exécutée en production' : ''}`
    })

    expect(
      nouveaux,
      'Ces fonctions sont exportées et aucun code de production ne les utilise :\n'
      + annote.join('\n')
      + '\n\nTrois issues, par ordre de préférence :\n'
      + '  1. la brancher — si elle porte un contrôle ou une règle métier, c’est ce qu’il faut faire ;\n'
      + '  2. la supprimer — si elle ne sert plus à rien ;\n'
      + '  3. l’ajouter à DEAD_EXPORTS_BASELINE avec un commentaire qui justifie pourquoi\n'
      + '     elle reste exportée sans être appelée.\n'
      + 'Ne choisissez la 3 que si les deux premières sont impossibles : c’est exactement ce\n'
      + 'motif qui avait débranché isMagicByteConsistent et evaluateScreening.',
    ).toEqual([])
  })

  it('la liste figée ne contient pas d’entrée périmée', () => {
    const { prod } = apiSources()
    const perimees = [...DEAD_EXPORTS_BASELINE].filter(entry => {
      const [file, name] = entry.split('::') as [string, string]
      if (!prod.some(p => p.f === file)) return true          // fichier disparu
      return usedInProduction(name, file, prod)               // désormais utilisée
    })

    expect(
      perimees,
      'Ces entrées de DEAD_EXPORTS_BASELINE ne sont plus mortes (câblées ou supprimées) :\n'
      + perimees.map(d => `  ${d}`).join('\n')
      + '\n\nRetirez-les de la liste : elle doit rétrécir, jamais rouiller.',
    ).toEqual([])
  })
})
