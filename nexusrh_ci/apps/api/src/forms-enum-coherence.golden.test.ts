/**
 * GOLDEN — Cohérence des ÉNUMS formulaire (front ↔ back).
 *
 * Risque couvert : un <select>/constante du frontend propose une valeur que le
 * schéma Zod backend N'ACCEPTE PAS → la soumission d'un formulaire pourtant
 * valide échoue en 400 à chaque fois (bugs réels corrigés : catégorie de frais
 * « materiel », format formation « e-learning », legal_form « SASU », type
 * d'entretien « trial_end », type de rubrique « employee_contribution »…).
 *
 * Ce test lit l'énum RÉEL côté backend dans le source et vérifie que CHAQUE
 * valeur offerte par l'UI y figure. Si quelqu'un retire/renomme une valeur de
 * l'énum backend sans aligner le front (ou l'inverse), le test casse → la dérive
 * est détectée avant d'atteindre l'utilisateur.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = dirname(fileURLToPath(import.meta.url)) // apps/api/src
const MODULES = join(API_SRC, 'modules')

/** Extrait les chaînes entre quotes de la 1re liste capturée par `re`. */
function extractValues(file: string, re: RegExp): string[] {
  const txt = readFileSync(file, 'utf8')
  const m = re.exec(txt)
  if (!m) throw new Error(`Énum introuvable dans ${file} (regex ${re})`)
  return [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!)
}

/**
 * Pour chaque formulaire : les valeurs que l'UI propose réellement (le contrat),
 * + comment lire l'énum backend correspondant. Si l'UI ajoute une option, on
 * met à jour `frontValues` ici → le test vérifie alors que le backend l'accepte.
 */
const CONTRACTS: Array<{
  name: string
  backendFile: string
  backendEnum: RegExp
  frontValues: string[]
}> = [
  {
    name: 'Notes de frais — catégorie de ligne',
    backendFile: join(MODULES, 'expenses', 'expenses.routes.ts'),
    backendEnum: /EXPENSE_CATEGORIES\s*=\s*\[([^\]]+)\]/,
    frontValues: ['transport', 'repas', 'hebergement', 'materiel', 'communication', 'autre'],
  },
  {
    name: 'Formation — format',
    backendFile: join(MODULES, 'training', 'training.routes.ts'),
    backendEnum: /format:\s*z\.enum\(\[([^\]]+)\]\)/,
    frontValues: ['presentiel', 'e-learning', 'hybride'],
  },
  {
    name: 'Entité juridique — forme juridique',
    backendFile: join(MODULES, 'settings', 'settings.routes.ts'),
    backendEnum: /legal_form:\s*z\.enum\(\[([^\]]+)\]\)/,
    frontValues: ['SARL', 'SA', 'SAS', 'SASU', 'SNC', 'GIE', 'Association', 'ONG', 'Établissement public'],
  },
  {
    name: 'Rubrique de paie — type',
    backendFile: join(MODULES, 'settings', 'settings.routes.ts'),
    // L'énum de type de rubrique est celui qui contient 'earning'.
    backendEnum: /type:\s*z\.enum\(\[('earning'[^\]]+)\]\)/,
    frontValues: ['earning', 'deduction', 'employee_contribution', 'employer_contribution'],
  },
  {
    name: 'Entretien (carrière) — type',
    backendFile: join(MODULES, 'careers', 'careers.routes.ts'),
    backendEnum: /type:\s*z\.enum\(\[('annual'[^\]]+)\]\)/,
    frontValues: ['annual', 'trial_end', 'mid_year', 'exit'],
  },
]

describe('Golden — cohérence énums formulaire front ↔ back', () => {
  for (const c of CONTRACTS) {
    it(`${c.name} : toutes les valeurs de l'UI sont acceptées par le backend`, () => {
      const backendValues = extractValues(c.backendFile, c.backendEnum)
      const missing = c.frontValues.filter(v => !backendValues.includes(v))
      expect(
        missing,
        `Valeurs proposées par l'UI mais REFUSÉES par le Zod backend (soumission → 400) : ${missing.join(', ')}\nÉnum backend = [${backendValues.join(', ')}]`,
      ).toEqual([])
    })
  }
})
