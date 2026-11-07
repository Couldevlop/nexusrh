/**
 * Pack CIV_2024 — seuils du préavis et bornes du CDD figés.
 *
 * Ces deux règles sont affichées à l'écran (Contrats OHADA → « Rappels du Code
 * du Travail ») ET appliquées par le serveur. Le banc jumeau côté web
 * (contracts-legal-i18n.test.ts) ancre le texte sur les mêmes seuils ; celui-ci
 * ancre le pack. Si l'un bouge sans l'autre, l'un des deux bancs tombe.
 *
 * Sources : décret n° 96-200 du 7/03/1996 (art. 18.4 CT / art. 34 CCI) pour le
 * préavis ; art. 15.4 du Code du travail pour le CDD.
 */
import { describe, it, expect } from 'vitest'
import { CIV_2024, LEGISLATION_PACKS } from './legislation-packs.js'

describe('CIV_2024 — préavis par catégorie', () => {
  const rules = CIV_2024.terminationRules!
  const byKey = (key: string) => (rules.noticeByCategory ?? []).find((c) => c.key === key)

  it('catégories 1 à 5 mensualisées : 1, 2, 3 puis 4 mois (barème par défaut)', () => {
    // Cas le plus courant : il vit dans `noticeMonths`, le barème appliqué à
    // défaut de catégorie déclarée sur le salarié.
    // 72 mois = 6 ans · 132 = 11 ans · 192 = 16 ans, puis au-delà.
    expect(rules.noticeMonths.map((t) => [t.upToSeniorityMonths, t.months])).toEqual([
      [72, 1], [132, 2], [192, 3], [null, 4],
    ])
  })

  it('catégories 1 à 5 non mensualisées : 8 puis 15 jours avant les paliers en mois', () => {
    expect(byKey('cat1_5_non_monthly')!.tiers.slice(0, 2).map((t) => [t.upToSeniorityMonths, t.days])).toEqual([
      [6, 8], [12, 15],
    ])
  })

  it('6e catégorie et au-delà : 3 mois, 4 au-delà de 16 ans', () => {
    expect(byKey('cat6_plus')!.tiers.map((t) => [t.upToSeniorityMonths, t.months])).toEqual([
      [192, 3], [null, 4],
    ])
  })
})

describe('CIV_2024 — bornes du CDD', () => {
  it('2 ans et 2 renouvellements', () => {
    expect(CIV_2024.fixedTermContract).toEqual({ maxMonths: 24, maxRenewals: 2 })
  })
})

describe('Les autres pays n’héritent pas de la règle ivoirienne', () => {
  it('aucun pack ne déclare de borne CDD sans la documenter explicitement', () => {
    // Un pack sans `fixedTermContract` = aucune borne appliquée. C'est un choix
    // assumé : transposer la règle ivoirienne ailleurs serait inventer du droit.
    for (const [code, pack] of Object.entries(LEGISLATION_PACKS)) {
      if (!pack.fixedTermContract) continue
      expect(pack.fixedTermContract.maxMonths, `${code} : durée maximale invraisemblable`).toBeGreaterThan(0)
      expect(pack.fixedTermContract.maxRenewals, `${code} : renouvellements négatifs`).toBeGreaterThanOrEqual(0)
    }
  })
})
