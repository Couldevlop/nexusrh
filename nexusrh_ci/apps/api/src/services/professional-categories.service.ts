/**
 * Catégories professionnelles — grille de classification du tenant.
 *
 * Une catégorie professionnelle (« 5e catégorie », « Agent de maîtrise »,
 * « Cadre »…) n'est pas une donnée légale : elle vient de la CONVENTION
 * COLLECTIVE du client, avec son minimum conventionnel. Deux entreprises du
 * même pays n'ont pas la même grille, et le même intitulé n'y vaut pas le même
 * montant. Il n'y a donc PAS de liste par défaut : en inventer une ferait dire
 * à l'application un chiffre que personne n'a signé.
 *
 * Absente ou illisible → liste vide, et les écrans qui s'en servent retombent
 * sur la saisie libre, comme avant ce référentiel. Aucune régression possible
 * pour un tenant qui ne paramètre rien.
 *
 * `countryCode` existe pour les groupes multi-pays : une grille signée en Côte
 * d'Ivoire ne s'applique pas à une filiale béninoise. NULL = la catégorie vaut
 * partout (le cas d'un tenant mono-pays, qui laisse la colonne vide).
 */
import { z } from 'zod'

export interface ProfessionalCategory {
  key: string
  label: string
  /** Minimum conventionnel mensuel, en entier de devise. NULL = non renseigné. */
  minimum: number | null
  /** Pays auquel la catégorie est réservée. NULL = toutes les filiales. */
  countryCode: string | null
}

export const PROFESSIONAL_CATEGORY_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/
export const PROFESSIONAL_CATEGORIES_MAX = 60
/** Même ordre de grandeur que les plafonds de cotisation : au-delà, c'est une faute de frappe. */
export const PROFESSIONAL_CATEGORY_MINIMUM_MAX = 100_000_000

const categorySchema = z.object({
  key: z.string().regex(
    PROFESSIONAL_CATEGORY_KEY_RE,
    'Clé invalide : minuscules, chiffres et _ (40 max), commençant par une lettre',
  ),
  label: z.string().trim().min(1, 'Libellé requis').max(100),
  // Entier : toutes les valeurs monétaires du produit sont des entiers de devise,
  // sans centime. Un minimum à 0 n'a pas de sens — c'est « non renseigné ».
  minimum: z.number().int('Montant entier attendu (pas de centime)')
    .positive('Le minimum doit être supérieur à zéro')
    .max(PROFESSIONAL_CATEGORY_MINIMUM_MAX, 'Montant hors d\'échelle')
    .nullable().default(null),
  countryCode: z.string().regex(/^[A-Z]{3}$/, 'Code pays ISO-3 requis').nullable().default(null),
}).strict()

/** Validation d'une grille saisie par l'admin (OWASP A03) : clés uniques, 1 à 60 entrées. */
export const professionalCategoriesSchema = z.array(categorySchema)
  .min(1, 'Au moins une catégorie est requise')
  .max(PROFESSIONAL_CATEGORIES_MAX, `${PROFESSIONAL_CATEGORIES_MAX} catégories maximum`)
  .superRefine((list, ctx) => {
    const seen = new Set<string>()
    list.forEach((c, i) => {
      if (seen.has(c.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `Clé en double : ${c.key}` })
      }
      seen.add(c.key)
    })
  })

/**
 * Grille effective à partir de la valeur brute (jsonb).
 *
 * Rien de paramétré, ou contenu qui ne valide plus (schéma changé, écriture
 * manuelle en base) → liste VIDE, jamais une grille devinée. L'écran revient à
 * la saisie libre : moins confortable, mais il ne prétend rien.
 */
export function parseProfessionalCategories(raw: unknown): ProfessionalCategory[] {
  if (raw === null || raw === undefined) return []
  const parsed = professionalCategoriesSchema.safeParse(raw)
  return parsed.success ? parsed.data : []
}

/**
 * Les catégories applicables à un pays donné.
 *
 * Une catégorie sans pays vaut partout ; une catégorie rattachée à un pays ne
 * sort que pour celui-là. Sans cela, la grille ivoirienne d'un groupe
 * remonterait son minimum conventionnel dans une simulation béninoise — le
 * même défaut que le SMIG d'un autre pays affiché sur l'écran.
 */
export function categoriesForCountry(
  list: readonly ProfessionalCategory[],
  countryCode: string | null | undefined,
): ProfessionalCategory[] {
  const pays = (countryCode ?? '').toUpperCase()
  return list.filter((c) => c.countryCode === null || (pays !== '' && c.countryCode === pays))
}
