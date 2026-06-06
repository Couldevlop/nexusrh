/**
 * Pré-tri recrutement (moteur de règles dures) — complément de couverture pour
 * les branches non exercées par recruitment-screening.service.test.ts :
 *   - langues obligatoires présentes / absentes (langs.length > 0)
 *   - normalisation d'accents (norm via skillPresent)
 *   - sanitizeCriteria : intInRange retournant null (NaN / hors bornes)
 *   - isDiplomaLevel sur des valeurs non-string
 *
 * Module pur : aucune I/O, aucun mock nécessaire.
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateScreening,
  sanitizeCriteria,
  parseDiploma,
  isDiplomaLevel,
  type ScreeningCriteria,
  type CandidateExtracted,
} from './recruitment-screening.service.js'

describe('recruitment-screening — langues obligatoires', () => {
  it('langue obligatoire absente alors que des langues sont détectées → auto-rejet', () => {
    const crit: ScreeningCriteria = { requiredLanguages: ['Anglais', 'Espagnol'] }
    const ext: CandidateExtracted = { languages: ['Français', 'Anglais'] }
    const v = evaluateScreening(crit, ext, 80)
    expect(v.decision).toBe('auto_reject')
    expect(v.autoRejectReason).toContain('Espagnol')
    expect(v.failedRules.some(r => r.includes('Langue'))).toBe(true)
  })

  it('toutes les langues obligatoires présentes → passedRules + review', () => {
    const crit: ScreeningCriteria = { requiredLanguages: ['Anglais', 'Français'] }
    const ext: CandidateExtracted = { languages: ['Français', 'Anglais', 'Dioula'] }
    const v = evaluateScreening(crit, ext, 80)
    expect(v.decision).toBe('review')
    expect(v.passedRules.some(r => r.includes('Langues obligatoires présentes'))).toBe(true)
  })

  it('aucune langue détectée → pas de knockout (revue humaine, prudence A04)', () => {
    const crit: ScreeningCriteria = { requiredLanguages: ['Anglais'] }
    const v = evaluateScreening(crit, { languages: [] }, 80)
    expect(v.decision).toBe('review')
    expect(v.knockoutFailed).toBe(false)
  })

  it('langues fournies avec entrées non-string filtrées puis évaluées', () => {
    // languages contient un non-string : filtré, mais la liste reste non vide
    const crit: ScreeningCriteria = { requiredLanguages: ['Anglais'] }
    const ext = { languages: ['Anglais', 123 as unknown as string] } as CandidateExtracted
    const v = evaluateScreening(crit, ext, 80)
    expect(v.decision).toBe('review')
  })

  it('requiredLanguages avec entrée vide après trim → ignorée (présence OK)', () => {
    const crit: ScreeningCriteria = { requiredLanguages: ['  ', 'Anglais'] }
    const ext: CandidateExtracted = { languages: ['Anglais'] }
    const v = evaluateScreening(crit, ext, 80)
    expect(v.decision).toBe('review')
  })
})

describe('recruitment-screening — normalisation d\'accents (norm)', () => {
  it('compétence requise accentuée matche un skill candidat sans accent', () => {
    const crit: ScreeningCriteria = { requiredSkills: ['Comptabilité'] }
    const ext: CandidateExtracted = { skills: ['comptabilite generale'] }
    const v = evaluateScreening(crit, ext, 80)
    expect(v.decision).toBe('review')
    expect(v.passedRules.join(' ')).toContain('compétences obligatoires')
  })

  it('localisation accentuée normalisée correctement (conforme)', () => {
    const crit: ScreeningCriteria = { allowedLocations: ['Bouaké'] }
    const v = evaluateScreening(crit, { location: 'BOUAKE' }, 80)
    expect(v.decision).toBe('review')
  })
})

describe('recruitment-screening — sanitizeCriteria bornes (intInRange null)', () => {
  it('valeur non numérique → null', () => {
    const c = sanitizeCriteria({ minExperienceYears: 'abc' })
    expect(c.minExperienceYears).toBeNull()
  })

  it('valeur sous la borne min → null', () => {
    const c = sanitizeCriteria({ minExperienceYears: -5 })
    expect(c.minExperienceYears).toBeNull()
  })

  it('autoRejectBelowScore au-dessus de 100 → null', () => {
    const c = sanitizeCriteria({ autoRejectBelowScore: 150 })
    expect(c.autoRejectBelowScore).toBeNull()
  })

  it('maxExpectedSalary au-delà du plafond → null', () => {
    const c = sanitizeCriteria({ maxExpectedSalary: 99_000_000 })
    expect(c.maxExpectedSalary).toBeNull()
  })

  it('entrée non-objet → critères vides normalisés', () => {
    const c = sanitizeCriteria(null)
    expect(c.requiredSkills).toEqual([])
    expect(c.knockoutEnabled).toBe(true)
  })

  it('valeurs valides conservées et arrondies', () => {
    const c = sanitizeCriteria({
      minExperienceYears: 3.7,
      autoRejectBelowScore: 60,
      maxExpectedSalary: 1_000_000,
      requiredLanguages: ['Anglais', '', 'Français'],
    })
    expect(c.minExperienceYears).toBe(4)
    expect(c.autoRejectBelowScore).toBe(60)
    expect(c.maxExpectedSalary).toBe(1_000_000)
    expect(c.requiredLanguages).toEqual(['Anglais', 'Français'])
  })
})

describe('recruitment-screening — isDiplomaLevel / parseDiploma compléments', () => {
  it('isDiplomaLevel : false pour non-string et valeur inconnue', () => {
    expect(isDiplomaLevel(5)).toBe(false)
    expect(isDiplomaLevel('bac+7')).toBe(false)
    expect(isDiplomaLevel('bac+5')).toBe(true)
  })

  it('parseDiploma : libellé vide après normalisation → null', () => {
    expect(parseDiploma('   ')).toBeNull()
  })
})
