/**
 * Golden — aucun secret en clair dans un fichier versionné.
 *
 * POURQUOI CE TEST EXISTE. `k8s/setup-cluster.sh` a porté, du 07/06/2026 au
 * 26/11/2026, la clé de signature des jetons de PRODUCTION, la clé de
 * chiffrement AES-256 des NNI/IBAN, le mot de passe PostgreSQL et un mot de
 * passe d'application Gmail — en clair, dans un dépôt PUBLIC. La clé de
 * signature permettait à elle seule de forger un jeton `super_admin` sur
 * n'importe quel tenant sans se connecter : MFA, expiration des mots de passe,
 * verrouillage après 5 échecs et grille d'habilitations se situent tous APRÈS
 * la vérification de signature.
 *
 * Six mois sans que rien ne le voie, parce que le job CI nommé « SAST &
 * Secrets » ne lançait aucun détecteur de secrets. La CI en a désormais un
 * (gitleaks, bloquant) ; ce test est la seconde barrière, celle qui tourne
 * aussi en local avant la poussée et qui échoue avec un message qui dit quoi
 * faire.
 *
 * CE QUE LE TEST CHERCHE : une affectation shell ou YAML dont la valeur est un
 * LITTÉRAL à forte entropie sur un nom de variable sensible. Pas une
 * substitution (`"$X"`, `"${X:-}"`, `$(…)`), pas un marqueur de remplacement
 * (`CHANGE_ME`), pas une valeur de test. Un secret se reconnaît à ce qu'il est
 * écrit, pas à ce qu'il est nommé.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

/** Racine du dépôt git (deux niveaux au-dessus de apps/api). */
const REPO = join(import.meta.dirname, '..', '..', '..')

/** Noms qui désignent un secret. Volontairement large : un faux positif se
 *  corrige en une ligne, un secret publié ne se rattrape pas. */
const NOM_SENSIBLE =
  /(SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|TOKEN|CREDENTIAL|PRIVATE)/i

/** Extensions où un secret serait directement exécuté/appliqué. */
const FICHIERS = /\.(sh|bash|ps1|yaml|yml|env|cfg|conf|ini)$/i

/** Valeurs qui ne sont pas des secrets : placeholders, exemples, gabarits. */
const NON_SECRET =
  /^(|-|x+|y+|true|false|null|none|changeme|change_me|CHANGE_ME|REPLACE_ME|TODO|xxx+|\.\.\.|example|placeholder|dummy|test|localhost|minioadmin|postgres|redis|nexusrh|admin)$/i

/**
 * Marqueur de gabarit. `k8s/base/04-secrets.template.yaml` porte des valeurs
 * comme `CHANGEME_JWT_SECRET_32` : longues, mêlant plusieurs classes de
 * caractères, donc indiscernables d'un mot de passe humain par la seule
 * entropie. Ce sont pourtant des trous à remplir, pas des secrets — et les
 * confondre rendrait ce test inutilisable, donc désactivé, donc inutile.
 */
const GABARIT = /(change|replace|todo|your|here|example|placeholder|dummy|remplacer|a_definir)/i

/** Un nom tout en MAJUSCULES_SOULIGNÉES est un trou à remplir, jamais une
 *  valeur réelle : aucun générateur de secret ne produit cette forme. */
const FORME_GABARIT = /^[A-Z0-9_]+$/

/**
 * Entropie de Shannon par caractère. Un secret aléatoire (hex, base64) dépasse
 * largement 3 bits/caractère ; une phrase, un chemin ou un nom de service
 * restent en dessous. Le seuil est posé sur l'entropie ET la longueur : une
 * chaîne courte, même aléatoire, n'est pas un secret utile.
 */
function entropie(s: string): number {
  const freq = new Map<string, number>()
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/**
 * Vrai si la valeur ressemble à un secret réel. Un mot de passe choisi par un
 * humain (« Abidjan@2025@@!… ») a une entropie plus basse qu'une clé hex, mais
 * reste long et mêle quatre classes de caractères : les deux critères sont
 * donc alternatifs, jamais cumulatifs.
 */
function ressembleAUnSecret(valeur: string): boolean {
  const v = valeur.trim()
  if (v.length < 16) return false
  if (NON_SECRET.test(v)) return false
  if (FORME_GABARIT.test(v)) return false
  if (GABARIT.test(v)) return false
  // Une substitution n'est pas un littéral.
  if (/[$`]/.test(v)) return false
  // Un chemin, une URL sans identifiants, un courriel seul : pas un secret.
  if (/^(https?:\/\/[^:@\s]*|\/[\w./-]*|[\w.+-]+@[\w.-]+\.\w+)$/.test(v)) return false
  // Clé/empreinte hexadécimale ou base64 longue.
  if (/^[0-9a-f]{32,}$/i.test(v)) return true
  if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(v) && entropie(v) >= 4) return true
  // Mot de passe composé par un humain : long et au moins trois classes.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(v)).length
  if (v.length >= 20 && classes >= 3) return true
  return false
}

interface Constat { fichier: string; ligne: number; variable: string }

/**
 * Signatures de fichiers binaires courants, en hexadécimal et en base64. Un
 * PNG d'un pixel écrit en dur dans un test a exactement la forme d'une clé :
 * c'est le faux positif le plus fréquent, et le confondre avec un secret
 * condamnerait ce contrôle à être désactivé.
 */
const SIGNATURES = [
  '89504e470d0a1a0a',  // PNG
  'ffd8ff',            // JPEG
  '25504446',          // %PDF
  '504b0304',          // ZIP / OOXML
  '1f8b',              // gzip
  'ivborw0kggo',       // PNG en base64
  'jvberi0',           // PDF en base64
  'ukljr',             // WAV en base64
]

/** Suites de caractères qui trahissent un alphabet, pas une clé. */
const SUITES = ['abcdefghij', '0123456789', 'qwerty', 'azerty']

/**
 * Vrai si ce littéral est, par sa FORME seule, une clé ou un jeton. Ce contrôle
 * ne connaît aucune valeur : il ne peut donc rien révéler, et il attrape aussi
 * les secrets qui n'ont jamais été publiés.
 */
function litteralDeFormeSecrete(v: string): boolean {
  const bas = v.toLowerCase()
  if (SIGNATURES.some(s => bas.startsWith(s))) return false
  if (SUITES.some(s => bas.includes(s))) return false
  // Un chemin, une URL, une liste de mots : pas une clé.
  if (/^[a-z0-9/_.-]+$/.test(v) && v.includes('/')) return false
  // Hexadécimal : une clé réelle consomme les 16 symboles.
  if (/^[0-9a-f]{32,}$/i.test(v)) return new Set(bas).size >= 12
  // Base64 : exiger les deux casses et un chiffre, et une entropie élevée.
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(v)) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter(r => r.test(v)).length
    return classes === 3 && entropie(v) >= 4.5
  }
  return false
}

/** Littéraux entre guillemets, dans n'importe quel fichier texte versionné. */
function litterauxSuspects(): string[] {
  const trouves: string[] = []
  for (const rel of fichiersATracer()) {
    let src: string
    try { src = readFileSync(join(REPO, rel), 'utf8') } catch { continue }
    src.split('\n').forEach((ligne, i) => {
      for (const m of ligne.matchAll(/['"`]([A-Za-z0-9+/=]{32,})['"`]/g)) {
        const v = m[1] ?? ''
        if (litteralDeFormeSecrete(v)) trouves.push(`  ${rel}:${i + 1}  ${v.length} caractères`)
      }
    })
  }
  return trouves
}


function fichiersVersionnes(): string[] {
  const sortie = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  })
  return sortie.split('\0').filter(f => FICHIERS.test(f))
}

/**
 * Tous les fichiers versionnés susceptibles de porter du texte, pas seulement
 * les scripts : une valeur publiée recopiée dans un `.ts` est aussi grave que
 * dans un `.sh`. Les binaires sont écartés.
 */
function fichiersATracer(): string[] {
  const sortie = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  return sortie.split('\0').filter(f =>
    f.length > 0
    && !/\.(png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|pptx?|zip|gz|woff2?|ttf|eot|mp4|lock)$/i.test(f))
}

function constats(): Constat[] {
  const trouves: Constat[] = []
  for (const rel of fichiersVersionnes()) {
    let src: string
    try { src = readFileSync(join(REPO, rel), 'utf8') } catch { continue }
    const lignes = src.split('\n')
    lignes.forEach((ligne, i) => {
      if (/^\s*#/.test(ligne)) return                       // commentaire shell
      // `VAR="valeur"`, `VAR='valeur'`, `VAR: "valeur"` (YAML)
      const m = ligne.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*["']([^"']*)["']\s*(?:#.*)?$/)
      if (!m) return
      const [, variable = '', valeur = ''] = m
      if (!NOM_SENSIBLE.test(variable)) return
      if (!ressembleAUnSecret(valeur)) return
      trouves.push({ fichier: rel, ligne: i + 1, variable })
    })
  }
  return trouves
}

describe('Golden — aucun secret en clair dans un fichier versionné', () => {
  it('le test sait lire les fichiers du dépôt (sinon il passerait pour rien)', () => {
    // Un `git ls-files` muet rendrait ce test vert sans rien avoir regardé :
    // c'est le mode de panne le plus dangereux pour un contrôle de sécurité.
    expect(fichiersVersionnes().length).toBeGreaterThan(20)
  })

  it('reconnaît un secret et laisse passer une substitution', () => {
    // MÊME FORME que ce qui était publié — valeurs TIRÉES AU HASARD ICI. La
    // première version de ce test recopiait les littéraux RÉELS : un test
    // écrit pour empêcher la publication d'un secret le republiait. Le cas
    // « valeur déjà publiée » ci-dessus interdit désormais la rechute.
    expect(ressembleAUnSecret(randomBytes(32).toString('hex'))).toBe(true)
    expect(ressembleAUnSecret('Yamoussoukro!2031#Faux?Jamais@Utilise/9182*__zz')).toBe(true)
    expect(ressembleAUnSecret(randomBytes(24).toString('hex'))).toBe(true)
    // Et ce qui ne doit JAMAIS déclencher.
    expect(ressembleAUnSecret('${JWT_SECRET:-}')).toBe(false)
    expect(ressembleAUnSecret('$(openssl rand -hex 32)')).toBe(false)
    expect(ressembleAUnSecret('CHANGE_ME')).toBe(false)
    expect(ressembleAUnSecret('nexusrh-ci-postgres-postgresql')).toBe(false)
    expect(ressembleAUnSecret('coulwao@gmail.com')).toBe(false)
    expect(ressembleAUnSecret('https://nexusrh.openlabconsulting.com')).toBe(false)
    // Gabarits de `k8s/base/04-secrets.template.yaml` : longs et mêlant
    // plusieurs classes, donc pris pour des mots de passe humains par la seule
    // entropie. Les signaler aurait condamné ce test à être désactivé.
    expect(ressembleAUnSecret('CHANGEME_JWT_SECRET_32')).toBe(false)
    expect(ressembleAUnSecret('sk-ant-api03-CHANGE-ME')).toBe(false)
    expect(ressembleAUnSecret('REMPLACER_PAR_LA_VRAIE')).toBe(false)
  })

  it('aucun fichier versionné ne porte de littéral ayant la forme d’une clé', () => {
    // CE CAS EXISTE PARCE QUE LA PREMIÈRE VERSION DE CE FICHIER A ÉCHOUÉ DESSUS.
    // Le contrôle ci-dessus ne regarde que les fichiers exécutables ou appliqués
    // (.sh, .yaml, .env) et n'examine qu'une affectation à un NOM sensible. Un
    // secret recopié dans un `.ts` — par exemple dans la chaîne d'un test, ce
    // qui est exactement ce qui s'est produit ici avec la clé de chiffrement de
    // production — passait donc entre les mailles. Celui-ci ne regarde que la
    // forme, dans tous les fichiers texte, et ne connaît aucune valeur : il
    // n'expose donc rien et attrape aussi les secrets jamais publiés.
    const trouves = litterauxSuspects()
    expect(
      trouves,
      'Littéral(aux) de la forme d’une clé dans un fichier VERSIONNÉ :\n'
      + trouves.join('\n')
      + '\n\nLe dépôt est public. Si c’est un secret : le faire TOURNER d’abord,\n'
      + 'une valeur poussée étant publiée donc brûlée, puis le lire depuis\n'
      + 'l’environnement. Si c’est une donnée de test, la produire à l’exécution\n'
      + '(`randomBytes(32).toString("hex")`) plutôt que de l’écrire en dur.\n',
    ).toEqual([])
  })

  it('aucun fichier versionné ne porte de secret en clair', () => {
    const trouves = constats()
    expect(
      trouves.map(c => `  ${c.fichier}:${c.ligne}  ${c.variable}`),
      'Secret(s) en clair dans un fichier VERSIONNÉ — le dépôt est public :\n'
      + trouves.map(c => `  ${c.fichier}:${c.ligne}  ${c.variable}`).join('\n')
      + '\n\nÀ faire, dans cet ordre :\n'
      + '  1. FAIRE TOURNER le secret dans le cluster — une valeur poussée est publiée,\n'
      + '     donc brûlée ; retirer la ligne ne la rattrape pas.\n'
      + '  2. Remplacer la valeur par une résolution environnement → cluster → aléatoire\n'
      + '     (voir les fonctions `resoudre` / `demander` de k8s/setup-cluster.sh).\n'
      + '  3. Ne JAMAIS neutraliser ce test pour faire passer une poussée.\n',
    ).toEqual([])
  })
})
