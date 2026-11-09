/**
 * Grille de classification professionnelle — ce qu'elle refuse de deviner.
 *
 * Une catégorie professionnelle porte un minimum conventionnel : un chiffre
 * signé dans une convention collective, pas une valeur légale. Ce banc fige les
 * deux propriétés qui comptent : l'application n'en invente jamais une, et la
 * grille d'un pays ne ressort pas dans un autre.
 */
import { describe, it, expect } from 'vitest'
import {
  parseProfessionalCategories, categoriesForCountry,
  professionalCategoriesSchema, PROFESSIONAL_CATEGORIES_MAX,
} from './professional-categories.service.js'

const CADRE = { key: 'cadre', label: 'Cadre', minimum: 450_000, countryCode: null }

describe('Aucune grille par défaut', () => {
  it('rien de paramétré rend une liste VIDE, pas une grille inventée', () => {
    // Le point central : inventer « 5e catégorie = 120 000 » ferait dire à
    // l'application un montant que personne n'a signé. L'écran retombe sur la
    // saisie libre, exactement comme avant ce référentiel.
    expect(parseProfessionalCategories(null)).toEqual([])
    expect(parseProfessionalCategories(undefined)).toEqual([])
  })

  it('un contenu illisible rend une liste vide, pas une erreur ni une devinette', () => {
    expect(parseProfessionalCategories('pas du json')).toEqual([])
    expect(parseProfessionalCategories([{ key: 'X MAJUSCULE', label: 'a' }])).toEqual([])
    expect(parseProfessionalCategories([{ label: 'sans clé' }])).toEqual([])
  })

  it('une grille valide ressort telle quelle', () => {
    expect(parseProfessionalCategories([CADRE])).toEqual([CADRE])
  })

  it('le minimum et le pays sont facultatifs et valent NULL par défaut', () => {
    // Le cas d'un tenant qui veut la liste d'intitulés sans s'engager sur des
    // montants : la grille doit rester utilisable.
    expect(parseProfessionalCategories([{ key: 'maitrise', label: 'Agent de maîtrise' }]))
      .toEqual([{ key: 'maitrise', label: 'Agent de maîtrise', minimum: null, countryCode: null }])
  })
})

describe('Validation d’une grille saisie', () => {
  const invalide = (v: unknown) => professionalCategoriesSchema.safeParse(v).success === false

  it('refuse une grille vide : effacer se fait par `reset`, pas par une liste nulle', () => {
    expect(invalide([])).toBe(true)
  })

  it('refuse deux fois la même clé', () => {
    expect(invalide([CADRE, { ...CADRE, label: 'Cadre supérieur' }])).toBe(true)
  })

  it('refuse un minimum à zéro ou négatif : « non renseigné » s’écrit NULL', () => {
    expect(invalide([{ ...CADRE, minimum: 0 }])).toBe(true)
    expect(invalide([{ ...CADRE, minimum: -1 }])).toBe(true)
  })

  it('refuse un minimum à centimes : toutes les valeurs monétaires sont entières', () => {
    expect(invalide([{ ...CADRE, minimum: 450_000.5 }])).toBe(true)
  })

  it('refuse un montant hors d’échelle, qui est une faute de frappe', () => {
    expect(invalide([{ ...CADRE, minimum: 1_000_000_000 }])).toBe(true)
  })

  it('refuse un code pays qui n’est pas un ISO-3', () => {
    expect(invalide([{ ...CADRE, countryCode: 'ci' }])).toBe(true)
    expect(invalide([{ ...CADRE, countryCode: 'CIV' }])).toBe(false)
  })

  it('refuse au-delà du plafond d’entrées', () => {
    const trop = Array.from({ length: PROFESSIONAL_CATEGORIES_MAX + 1 },
      (_, i) => ({ key: `c${i}`, label: `C${i}`, minimum: null, countryCode: null }))
    expect(invalide(trop)).toBe(true)
  })
})

describe('Portée par pays', () => {
  const grille = [
    { key: 'ci_5e', label: '5e catégorie', minimum: 120_000, countryCode: 'CIV' },
    { key: 'ben_b', label: 'Catégorie B', minimum: 80_000, countryCode: 'BEN' },
    { key: 'cadre', label: 'Cadre', minimum: 450_000, countryCode: null },
  ]

  it('la grille d’un pays ne ressort PAS dans un autre', () => {
    // Même défaut que le SMIG d'un autre pays affiché au simulateur : un
    // minimum conventionnel ivoirien proposé pour une embauche béninoise est un
    // repère faux sur un écran qui sert à décider d'un salaire.
    const ben = categoriesForCountry(grille, 'BEN').map((c) => c.key)
    expect(ben).toEqual(['ben_b', 'cadre'])
    expect(ben).not.toContain('ci_5e')
  })

  it('une catégorie sans pays vaut partout — le cas du tenant mono-pays', () => {
    expect(categoriesForCountry(grille, 'CIV').map((c) => c.key)).toEqual(['ci_5e', 'cadre'])
    expect(categoriesForCountry(grille, 'SEN').map((c) => c.key)).toEqual(['cadre'])
  })

  it('sans pays demandé, seules les catégories universelles sortent', () => {
    // Ne rien demander ne doit pas tout ouvrir : une grille rattachée à un pays
    // n'est applicable qu'à ce pays, même quand l'appelant ne précise rien.
    expect(categoriesForCountry(grille, null).map((c) => c.key)).toEqual(['cadre'])
    expect(categoriesForCountry(grille, '').map((c) => c.key)).toEqual(['cadre'])
  })

  it('le code pays demandé est comparé sans tenir compte de la casse', () => {
    expect(categoriesForCountry(grille, 'civ').map((c) => c.key)).toEqual(['ci_5e', 'cadre'])
  })
})
