import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'

/**
 * Garde-fou : le texte de ce module part dans un email lu par le dirigeant de
 * la plateforme, en français. Un mot privé de son accent (« periode » au lieu
 * de « période », « donnees » au lieu de « données »…) n'est pas une simple
 * coquille visuelle : il décrédibilise un rapport censé être fiable, lu par un
 * humain qui n'a aucun moyen de savoir si le chiffre qui l'accompagne est,
 * lui, correct.
 *
 * On ne scanne que le contenu des chaînes de caractères (littéraux '...',
 * "..." et `...`) des fichiers source de src/report/, hors fichiers de test :
 * les commentaires et les identifiants (schemaName, schema_name, noms de
 * variables/fonctions) ne sont pas du texte affiché et ne doivent pas
 * déclencher ce test.
 */

const DIR = dirname(fileURLToPath(import.meta.url))

// Liste minimale de mots français courants susceptibles d'apparaître dans ce
// module sans leur accent. À enrichir si un nouveau mot fautif est trouvé.
const MOTS_SANS_ACCENT = [
  'donnees', 'periode', 'periodes', 'employes', 'echeance', 'reussies',
  'activite', 'creation', 'derniere', 'apres', 'acces',
]

// Littéraux de chaîne : '...' | "..." | `...` (les gabarits multi-lignes de
// render-html.ts sont donc couverts en entier).
const LITERAL_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g

function ligneDe(texte: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (texte[i] === '\n') n++
  return n
}

/**
 * Fichiers scannés : tout src/report/ (hors tests) ET l'orchestrateur
 * src/jobs/platform-report.ts — c'est lui qui compose le SUJET du mail, le
 * texte le plus lu du rapport, qui échappait donc entièrement à ce garde-fou.
 * Chemins absolus, pour pouvoir sortir du répertoire courant.
 */
function fichiersSource(): string[] {
  const duModule = readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((f) => join(DIR, f))
  return [...duModule, join(DIR, '..', 'jobs', 'platform-report.ts')]
}

describe('accents du texte affiché (rapport statistique)', () => {
  it('ne contient aucun mot français courant privé de son accent dans une chaîne affichée', () => {
    const fautes: string[] = []

    for (const chemin of fichiersSource()) {
      const fichier = basename(chemin)
      const contenu = readFileSync(chemin, 'utf8')

      LITERAL_RE.lastIndex = 0
      let literalMatch: RegExpExecArray | null
      while ((literalMatch = LITERAL_RE.exec(contenu))) {
        const literal = literalMatch[0]
        const debutLiteral = literalMatch.index

        for (const mot of MOTS_SANS_ACCENT) {
          const motRe = new RegExp(`\\b${mot}\\b`, 'gi')
          let mm: RegExpExecArray | null
          while ((mm = motRe.exec(literal))) {
            const ligne = ligneDe(contenu, debutLiteral + mm.index)
            fautes.push(
              `${fichier}:${ligne} — mot « ${mm[0]} » privé de son accent dans une chaîne affichée `
              + `(forme attendue accentuée de « ${mot} »). Ce texte part tel quel dans le rapport `
              + `statistique envoyé par email au dirigeant de la plateforme : un mot français sans `
              + `accent y sera lu par un humain.`,
            )
          }
        }

        // « schema » suivi d'un espace ou d'une apostrophe = probable « schéma »
        // oublié. schema_name et schemaName (identifiants légitimes) ne sont
        // jamais suivis d'un espace ou d'une apostrophe, donc ne matchent pas.
        const schemaRe = /\bschema[ ']/gi
        let sm: RegExpExecArray | null
        while ((sm = schemaRe.exec(literal))) {
          const ligne = ligneDe(contenu, debutLiteral + sm.index)
          fautes.push(
            `${fichier}:${ligne} — mot « schema » privé de son accent dans une chaîne affichée `
            + `(forme attendue « schéma »). Ce texte part tel quel dans le rapport statistique `
            + `envoyé par email au dirigeant de la plateforme : un mot français sans accent y sera lu par un humain.`,
          )
        }
      }
    }

    expect(fautes, `\n${fautes.join('\n')}`).toEqual([])
  })
})
