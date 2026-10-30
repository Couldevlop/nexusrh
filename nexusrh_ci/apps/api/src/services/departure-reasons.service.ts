/**
 * Catégories de motifs de départ — liste paramétrable par tenant.
 *
 * Même modèle que les champs personnalisés du dossier employé : les
 * définitions vivent dans `platform.tenants.departure_reason_categories`
 * (jsonb `[{ key, label }]`), éditées par l'admin du tenant depuis les
 * paramètres. NULL ou liste illisible → liste par défaut ci-dessous.
 *
 * La CLÉ est stockée sur le dossier de sortie (`offboarding_cases.reason_category`)
 * et sert d'axe d'agrégation ; le LIBELLÉ n'est qu'un affichage. Retirer une
 * catégorie de la liste ne réécrit pas les dossiers déjà classés.
 */
import { z } from 'zod'

interface Queryable {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export interface DepartureReasonCategory {
  key: string
  label: string
}

export const DEFAULT_DEPARTURE_REASON_CATEGORIES: readonly DepartureReasonCategory[] = [
  { key: 'remuneration',       label: 'Rémunération' },
  { key: 'career_growth',      label: 'Évolution de carrière' },
  { key: 'management',         label: 'Management' },
  { key: 'working_conditions', label: 'Conditions de travail' },
  { key: 'relocation',         label: 'Mobilité géographique' },
  { key: 'personal',           label: 'Raisons personnelles' },
  { key: 'other',              label: 'Autre' },
]

export const DEPARTURE_REASON_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

const categorySchema = z.object({
  key:   z.string().regex(DEPARTURE_REASON_KEY_RE, 'Clé invalide : minuscules, chiffres et _ (40 max), commençant par une lettre'),
  label: z.string().trim().min(1, 'Libellé requis').max(100),
}).strict()

/** Validation d'une liste saisie par l'admin (OWASP A03) : clés uniques, 1 à 30 entrées. */
export const departureReasonCategoriesSchema = z.array(categorySchema)
  .min(1, 'Au moins une catégorie est requise')
  .max(30, '30 catégories maximum')
  .superRefine((list, ctx) => {
    const seen = new Set<string>()
    list.forEach((c, i) => {
      if (seen.has(c.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `Clé en double : ${c.key}` })
      seen.add(c.key)
    })
  })

/** Liste effective à partir de la valeur brute (jsonb) : défauts si absente ou invalide. */
export function parseDepartureReasonCategories(raw: unknown): DepartureReasonCategory[] {
  if (raw === null || raw === undefined) return DEFAULT_DEPARTURE_REASON_CATEGORIES.map((c) => ({ ...c }))
  const parsed = departureReasonCategoriesSchema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_DEPARTURE_REASON_CATEGORIES.map((c) => ({ ...c }))
}

/** Liste effective du tenant. Lecture en échec → défauts (jamais bloquant). */
export async function loadDepartureReasonCategories(db: Queryable, schema: string): Promise<DepartureReasonCategory[]> {
  try {
    const r = await db.query<{ departure_reason_categories: unknown }>(
      `SELECT departure_reason_categories FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
    )
    return parseDepartureReasonCategories(r?.rows?.[0]?.departure_reason_categories)
  } catch {
    return parseDepartureReasonCategories(null)
  }
}
