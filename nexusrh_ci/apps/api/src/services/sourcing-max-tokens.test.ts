/**
 * Budget de tokens de sortie du sourcing IA.
 *
 * Régression couverte (prod, 26/07/2026) : le plafond était figé à 4000 tokens
 * quel que soit le nombre de profils demandés. Mesures réelles sur mistral :
 *   - 1 plateforme /  3 profils → 1527 tokens → JSON complet, 3 profils rendus
 *   - 8 plateformes / 20 profils → EXACTEMENT 4000 tokens → JSON coupé en plein
 *     milieu, parse en échec, `data: null`, écran vide SANS message d'erreur.
 * Le plafond doit donc suivre la demande, tout en restant borné.
 */
import { describe, it, expect, vi } from 'vitest'

// Le module instancie un Pool à l'import : on le neutralise (aucun test ici ne
// touche la DB — sourcingMaxTokens est une fonction pure).
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: vi.fn(), end: vi.fn() })) }))
vi.mock('../config.js', () => ({ config: { database: { url: 'postgresql://test' } } }))

import { sourcingMaxTokens, defaultRichnessWeights, type SourcingSettings } from './sourcing-config.service.js'

// Le paramétrage par défaut n'est PAS exporté : ce serait un export vivant
// uniquement pour les tests. On passe donc par le chemin public — appeler
// `sourcingMaxTokens` sans paramétrage — et on assume ici les deux bornes
// calibrées sur les mesures de prod du 26/07/2026, qui sont précisément ce que
// ce fichier a pour mission de figer.
const BASE    = 1200      // enveloppe fixe (prompt + structure JSON)
const CEILING = 16_000    // plafond de garde : au-delà, la requête coûte trop

describe('sourcingMaxTokens', () => {
  it('couvre largement le besoin mesuré à 3 profils (1527 tokens)', () => {
    expect(sourcingMaxTokens(3)).toBeGreaterThan(1527)
  })

  it('dépasse l’ancien plafond fixe de 4000 dès que la demande le justifie', () => {
    // C'est tout l'objet du correctif : 20 profils ne tiennent pas dans 4000.
    expect(sourcingMaxTokens(20)).toBeGreaterThan(4000)
  })

  it('reste au-dessus du besoin extrapolé (~400 tokens par profil)', () => {
    for (const n of [5, 10, 20]) {
      expect(sourcingMaxTokens(n), `${n} profils`).toBeGreaterThanOrEqual(400 * n)
    }
  })

  it('croît avec le nombre de profils demandés', () => {
    let previous = 0
    for (const n of [1, 3, 5, 8, 12, 20]) {
      const v = sourcingMaxTokens(n)
      expect(v).toBeGreaterThanOrEqual(previous)
      previous = v
    }
  })

  it('reste borné par le plafond de garde — pas de requête au coût non maîtrisé', () => {
    expect(sourcingMaxTokens(10_000)).toBe(CEILING)
    expect(sourcingMaxTokens(Number.MAX_SAFE_INTEGER)).toBe(CEILING)
  })

  it('ne descend jamais sous l’enveloppe fixe, même sur une demande absurde', () => {
    for (const n of [0, -5, Number.NaN]) {
      expect(sourcingMaxTokens(n), String(n)).toBeGreaterThanOrEqual(BASE)
    }
  })

  it('retombe sur les défauts si le paramétrage plateforme est indisponible', () => {
    expect(sourcingMaxTokens(8, null)).toBe(sourcingMaxTokens(8))
    expect(sourcingMaxTokens(8, undefined)).toBe(sourcingMaxTokens(8))
  })

  it('honore un paramétrage super_admin plus généreux', () => {
    const custom: SourcingSettings = {
      maxProfilesMin: 1, maxProfilesMax: 20, maxProfilesDefault: 8,
      maxCostEurPerRequest: 0, claudeSystemPrompt: '', mistralSystemPrompt: '',
      richnessWeights: defaultRichnessWeights(),
      tokensBase: 2000, tokensPerProfile: 800, tokensCeiling: 32_000,
    }
    expect(sourcingMaxTokens(10, custom)).toBe(10_000)
    expect(sourcingMaxTokens(100, custom)).toBe(32_000)
  })
})
