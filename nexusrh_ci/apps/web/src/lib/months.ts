/**
 * Mois récents au format `YYYY-MM`, du plus récent au plus ancien.
 *
 * Calcul en entiers (année, mois) : on ne passe jamais par `Date.setMonth`,
 * qui déborde sur le mois suivant quand le jour courant n'existe pas dans le
 * mois cible (ex. le 29/10 moins 8 mois = « 29 février » → 1er mars, d'où
 * « mars » listé deux fois et février absent).
 */
export function recentMonths(count: number, now: Date = new Date()): string[] {
  const year = now.getFullYear()
  const month0 = now.getMonth() // 0..11
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const total = year * 12 + month0 - i
    const y = Math.floor(total / 12)
    const m = total - y * 12 + 1
    out.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return out
}
