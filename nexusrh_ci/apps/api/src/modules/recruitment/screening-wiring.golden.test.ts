/**
 * Golden — le moteur de pré-tri est RÉELLEMENT branché.
 *
 * Régression corrigée le 30/08/2026 : `evaluateScreening` — moteur de règles
 * dures, pur, couvert par deux fichiers de tests — n'apparaissait dans AUCUN
 * code de production. Il n'était importé que pour `sanitizeCriteria`. Les
 * critères saisis par le recruteur étaient donc enregistrés puis jamais relus,
 * et `applications.screening_verdict` n'était écrite nulle part.
 *
 * Même mode de défaillance que le contrôle de signature des CV (audit S-01) :
 * du code juste, testé, et hors du chemin d'exécution. Ce test verrouille le
 * branchement lui-même, pas le comportement du moteur — lequel a ses propres
 * tests unitaires.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  evaluateScreening, combineVerdicts,
} from '../../services/recruitment-screening.service.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTES = readFileSync(join(HERE, 'recruitment.routes.ts'), 'utf8')

describe('Branchement du moteur de pré-tri', () => {
  it('le module de routes importe et APPELLE le moteur', () => {
    expect(ROUTES, 'evaluateScreening importé').toMatch(/evaluateScreening/)
    expect(ROUTES, 'combineVerdicts importé').toMatch(/combineVerdicts/)
    // Un appel, pas seulement un import : le nom doit apparaître suivi d'une parenthèse.
    expect(ROUTES).toMatch(/evaluateScreening\s*\(/)
    expect(ROUTES).toMatch(/combineVerdicts\s*\(/)
  })

  it('le verdict machine est persisté', () => {
    expect(ROUTES).toMatch(/screening_verdict\s*=\s*\$/)
    expect(ROUTES).toMatch(/screening_failed_rules\s*=\s*\$/)
  })

  it('l’extraction structurée de l’IA est persistée', () => {
    // Sans ces colonnes, `screening/preview` n'aurait aucune donnée à évaluer
    // et déclarerait tout le monde conforme : le réglage des critères par le
    // recruteur serait un leurre.
    for (const col of [
      'ai_years_experience', 'ai_skills', 'ai_diploma', 'ai_location', 'ai_languages',
    ]) {
      expect(ROUTES, `colonne ${col} persistée`).toMatch(new RegExp(`${col}\\s*=\\s*\\$`))
    }
  })

  it('les critères de l’offre sont lus avant la boucle d’analyse', () => {
    expect(ROUTES).toMatch(/screening_criteria/)
    expect(ROUTES).toMatch(/sanitizeCriteria\(job\.screening_criteria/)
  })

  it('le moteur reste pur et exploitable tel quel', () => {
    const v = evaluateScreening(
      { minExperienceYears: 5, knockoutEnabled: true },
      { yearsExperience: 2 },
      90,
    )
    expect(v.decision).toBe('auto_reject')
    expect(v.failedRules.length).toBeGreaterThan(0)

    // Et le verdict combiné reste une PROPOSITION : `flagged`, jamais un rejet.
    const combined = combineVerdicts({ failedRules: [] }, v)
    expect(combined.verdict).toBe('flagged')
  })
})
