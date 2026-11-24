/**
 * Garde-fous sur le corpus juridique lui-même.
 *
 * Ces invariants ne sont pas théoriques : chacun correspond à un défaut qui a
 * réellement atteint, ou failli atteindre, la production.
 */
import { describe, it, expect } from 'vitest'
import {
  ALL_ARTICLES, CODE_TRAVAIL_CI, CONVENTIONS_COLLECTIVES, TEXTES_ANNEXES_CI,
} from './code-travail-ci.js'

describe('corpus juridique CI — invariants de structure', () => {
  it('aucun article_id en double', () => {
    // `droit_ci.articles.article_id` est UNIQUE. Un doublon ne provoque pas une
    // erreur visible : l'entrée écrite en dernier ÉCRASE la précédente. Trois
    // textes annexes portaient ainsi les identifiants de vrais articles
    // (art-23-1, art-25-1, art-25-2) et auraient supprimé du Code les congés
    // payés et les jours d'ancienneté.
    const ids = ALL_ARTICLES.map(a => a.article_id)
    const doublons = ids.filter((v, i) => ids.indexOf(v) !== i)
    expect(doublons).toEqual([])
  })

  it('chaque article porte un livre, sinon le sommaire s’effondre', () => {
    // Le sommaire groupe par `livre` et retombe sur « Général » à défaut
    // (legal-articles.repository.ts). Sans livre, les 383 articles du Code se
    // retrouvaient dans un bucket unique, et la navigation disparaissait.
    const sansLivre = ALL_ARTICLES.filter(a => !a.livre)
    expect(sansLivre.map(a => a.article_numero)).toEqual([])
  })

  it('respecte les longueurs de colonnes de droit_ci.articles', () => {
    // Un dépassement ferait échouer l'upsert du seed en production, après que
    // des articles ont déjà été réécrits.
    const limites: Array<[keyof typeof ALL_ARTICLES[number], number]> = [
      ['article_id', 50], ['article_numero', 50], ['source', 60],
      ['livre', 200], ['titre', 300], ['chapitre', 300], ['section', 300],
    ]
    const trop: string[] = []
    for (const a of ALL_ARTICLES) {
      for (const [champ, max] of limites) {
        const v = a[champ]
        if (typeof v === 'string' && v.length > max) {
          trop.push(`${a.article_id}.${String(champ)} = ${v.length} > ${max}`)
        }
      }
    }
    expect(trop).toEqual([])
  })

  it('les trois sources restent distinctes et complètes', () => {
    expect(CODE_TRAVAIL_CI.every(a => a.source === 'code_travail_ci')).toBe(true)
    expect(TEXTES_ANNEXES_CI.every(a => a.source === 'textes_annexes_ci')).toBe(true)
    expect(ALL_ARTICLES).toHaveLength(
      CODE_TRAVAIL_CI.length + CONVENTIONS_COLLECTIVES.length + TEXTES_ANNEXES_CI.length)
  })

  it('aucun texte annexe ne squatte la numérotation du Code', () => {
    // Les textes annexes sont des synthèses de décrets, du CGI et de l'OHADA :
    // ils ne doivent jamais se présenter comme des articles du Code.
    const squatteurs = TEXTES_ANNEXES_CI.filter(a => /^art-\d/.test(a.article_id))
    expect(squatteurs.map(a => a.article_id)).toEqual([])
  })
})
