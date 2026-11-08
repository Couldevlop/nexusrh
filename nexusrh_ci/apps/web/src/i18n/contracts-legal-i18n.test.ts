/**
 * Rappels légaux de l'écran Contrats OHADA — un conseil juridique faux est
 * plus nuisible qu'un écran vide.
 *
 * Constat du 07/11/2026 : le bloc affichait « Préavis CDI (< 1 an) : 1 mois ·
 * (1–5 ans) : 2 mois · (> 5 ans) : 3 mois ». Ce barème n'existe pas en droit
 * ivoirien. Le décret n° 96-200 du 7/03/1996 (art. 18.4 CT / art. 34 CCI) —
 * et le pack CIV_2024 dont le moteur de paie calcule le solde de tout compte —
 * donnent, pour les catégories 1 à 5 mensualisées : ≤ 6 ans 1 mois, ≤ 11 ans
 * 2 mois, ≤ 16 ans 3 mois, > 16 ans 4 mois ; cadres et maîtrise (6e catégorie
 * et au-delà) : 3 mois, 4 mois au-delà de 16 ans. Le SIRH calculait juste et
 * l'écran conseillait faux.
 *
 * Le bloc annonçait par ailleurs « SMIG 75 000 FCFA (revalorisation 2026) » :
 * ce montant est en vigueur depuis le 01/01/2023, aucune revalorisation 2026
 * n'a eu lieu.
 *
 * Le pendant côté API (legislation-packs CIV_2024) est figé par
 * cdd-notice-pack.golden.test.ts : les deux bouts sont ancrés sur les mêmes
 * seuils.
 */
import { describe, it, expect } from 'vitest'
import fr from './locales/fr/contracts.json'
import en from './locales/en/contracts.json'

/** Seuils d'ancienneté du préavis, en années (décret n° 96-200, art. 18.4). */
const NOTICE_TIERS = ['6', '11', '16'] as const

describe('Rappels du Code du travail — préavis', () => {
  for (const [lang, bundle] of [['fr', fr], ['en', en]] as const) {
    describe(lang, () => {
      const line = (bundle.legal as Record<string, string>).line4

      it('cite les trois seuils d’ancienneté et les quatre durées', () => {
        for (const tier of NOTICE_TIERS) {
          expect(line, `seuil ${tier} ans absent`).toContain(tier)
        }
        expect(line).toMatch(/4 (mois|months)/)
      })

      it('ne reprend pas l’ancien barème erroné (< 1 an / 1–5 ans / > 5 ans)', () => {
        expect(line).not.toMatch(/<\s*1\s*(an|year)/i)
        expect(line).not.toMatch(/1\s*[–-]\s*5\s*(ans|years)/i)
        expect(line).not.toMatch(/>\s*5\s*(ans|years)/i)
      })

      it('distingue les cadres et la maîtrise des catégories 1 à 5', () => {
        expect(line).toMatch(/cadres|executives/i)
      })
    })
  }
})

describe('Rappels du Code du travail — SMIG', () => {
  for (const [lang, bundle] of [['fr', fr], ['en', en]] as const) {
    it(`${lang} : le SMIG est daté de son entrée en vigueur réelle`, () => {
      const line = (bundle.legal as Record<string, string>).line5
      expect(line).toContain('2023')
      expect(line).not.toMatch(/revalorisation 2026|2026 revaluation/i)
    })
  }
})
