/**
 * Formatage monétaire — la fonction réellement utilisée par l'interface.
 *
 * POURQUOI CE FICHIER EXISTE. `formatFCFA` est simulée dans une vingtaine de
 * suites par `` `${n} FCFA` ``, si bien que la VRAIE fonction n'était exercée
 * nulle part. Elle rendait en production « 145 500 F CFA » — symbole CLDR de
 * XOF en français — avec des U+202F (espace fine insécable) en séparateurs de
 * milliers et un U+00A0 devant le symbole, c'est-à-dire pas une seule espace
 * ordinaire. Trois écarts en découlaient, invisibles aux tests : le dépôt
 * spécifie « FCFA », la page vitrine retire déjà U+202F parce qu'il manque aux
 * polices PDF standard, et le repli NaN de la fonction rendait « 0 FCFA »,
 * contredisant sa propre sortie nominale.
 */
import { describe, it, expect } from 'vitest'
import { formatFCFA, formatMoney } from './api'

/** Tout caractère d'espacement non ordinaire (fine insécable, insécable…). */
const ESPACES_EXOTIQUES = /[\u202F\u00A0\u2007\u2009]/

describe('formatFCFA', () => {
  it('écrit « FCFA », jamais le symbole CLDR « F CFA »', () => {
    expect(formatFCFA(145500)).toBe('145 500 FCFA')
    expect(formatFCFA(75000)).toBe('75 000 FCFA')
  })

  it("n'insère que des espaces ordinaires", () => {
    for (const montant of [1, 999, 1000, 145500, 3375000, 12345678]) {
      expect(ESPACES_EXOTIQUES.test(formatFCFA(montant)), String(montant)).toBe(false)
    }
  })

  it('reste en francs entiers : aucune décimale, jamais de centime', () => {
    expect(formatFCFA(1234.56)).toBe('1 235 FCFA')
    expect(formatFCFA('250000')).toBe('250 000 FCFA')
  })

  it('rend le même symbole sur le repli que sur le cas nominal', () => {
    expect(formatFCFA('pas un nombre')).toBe('0 FCFA')
    expect(formatFCFA(NaN)).toBe('0 FCFA')
  })

  it('garde le signe des montants négatifs (retenues de bulletin)', () => {
    expect(formatFCFA(-9259)).toBe('-9 259 FCFA')
  })
})

describe('formatMoney — autres devises des packs législatifs', () => {
  it('pose le code ISO pour les devises hors zone UEMOA', () => {
    expect(formatMoney(145500, 'NGN')).toBe('145 500 NGN')
    expect(formatMoney(145500, 'GHS')).toBe('145 500 GHS')
  })

  it('traite XAF comme une devise à code, et XOF comme FCFA', () => {
    expect(formatMoney(1000, 'XAF')).toBe('1 000 XAF')
    expect(formatMoney(1000, 'XOF')).toBe('1 000 FCFA')
  })

  it('aligne le repli sur la devise demandée', () => {
    expect(formatMoney(NaN, 'NGN')).toBe('0 NGN')
  })
})
