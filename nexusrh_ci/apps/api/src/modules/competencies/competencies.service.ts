/**
 * Référentiel postes & compétences (taxonomie de Bloom) — logique PURE.
 *
 * Niveaux de maîtrise selon Bloom (1→6), validation, et outil comparatif de
 * deux fiches de poste (écart de niveau requis par compétence). Aucune
 * dépendance (Fastify/DB) → testable.
 */

// Taxonomie de Bloom — 6 niveaux croissants de maîtrise cognitive.
export const BLOOM_MIN = 1
export const BLOOM_MAX = 6
export const BLOOM_LEVELS = [1, 2, 3, 4, 5, 6] as const
export type BloomLevel = (typeof BLOOM_LEVELS)[number]

// Clés i18n des niveaux (libellés rendus côté frontend) :
// 1 remember · 2 understand · 3 apply · 4 analyze · 5 evaluate · 6 create
export const BLOOM_KEYS: Record<number, string> = {
  1: 'remember', 2: 'understand', 3: 'apply', 4: 'analyze', 5: 'evaluate', 6: 'create',
}

export function isValidBloom(n: unknown): n is BloomLevel {
  return typeof n === 'number' && Number.isInteger(n) && n >= BLOOM_MIN && n <= BLOOM_MAX
}

/** Borne une valeur dans [1,6] (sécurise les entrées avant écriture). */
export function clampBloom(n: number): BloomLevel {
  return Math.min(BLOOM_MAX, Math.max(BLOOM_MIN, Math.round(n))) as BloomLevel
}

export interface RequirementItem {
  competencyId: string
  label: string
  requiredLevel: number
}

export interface CompareRow {
  competencyId: string
  label: string
  levelA: number | null
  levelB: number | null
  /** levelB - levelA (positif = B exige davantage). null si l'une des fiches ne requiert pas la compétence. */
  diff: number | null
}

/**
 * Compare les exigences de DEUX fiches de poste. Renvoie l'union des
 * compétences avec le niveau requis de chaque fiche (null si non requis) et
 * l'écart. Pur, trié par libellé.
 */
export function compareRequirements(a: RequirementItem[], b: RequirementItem[]): CompareRow[] {
  const byId = new Map<string, { label: string; levelA: number | null; levelB: number | null }>()
  for (const it of a) {
    byId.set(it.competencyId, { label: it.label, levelA: it.requiredLevel, levelB: null })
  }
  for (const it of b) {
    const cur = byId.get(it.competencyId)
    if (cur) cur.levelB = it.requiredLevel
    else byId.set(it.competencyId, { label: it.label, levelA: null, levelB: it.requiredLevel })
  }
  const rows: CompareRow[] = []
  for (const [competencyId, v] of byId) {
    rows.push({
      competencyId,
      label: v.label,
      levelA: v.levelA,
      levelB: v.levelB,
      diff: v.levelA != null && v.levelB != null ? v.levelB - v.levelA : null,
    })
  }
  rows.sort((x, y) => x.label.localeCompare(y.label))
  return rows
}
