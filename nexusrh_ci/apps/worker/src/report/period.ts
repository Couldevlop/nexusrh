/**
 * Bornes des périodes de rapport.
 *
 * Tout est calculé en UTC : le serveur tourne en Africa/Abidjan, qui EST UTC
 * (pas de décalage, pas d'heure d'été). Passer par les composantes locales
 * exposerait le calcul au fuseau du conteneur, qui n'est pas garanti.
 *
 * Convention : `start` est inclus, `end` est EXCLU. Toutes les requêtes de
 * collecte utilisent donc `>= start AND < end`, ce qui évite le grand classique
 * du dernier jour compté deux fois.
 */
export type PeriodType = 'weekly' | 'monthly'

export interface Period {
  type: PeriodType
  start: Date
  end: Date
  label: string
}

const MOIS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function jour(d: Date): string {
  return `${d.getUTCDate()} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/**
 * Les 7 jours écoulés : du dimanche précédent (inclus) à ce dimanche (exclu).
 *
 * Cale sur la frontière de semaine (dimanche) pour l'idempotence sur reprise :
 * si un envoi échoue et que la reprise automatique franchit minuit, les bornes
 * ne glissent pas, et la contrainte d'unicité sur (period_type, period_start)
 * empêche les doublons.
 */
export function weeklyPeriod(now: Date): Period {
  const midnight = utcMidnight(now)
  const dayOfWeek = midnight.getUTCDay() // 0 = dimanche, 6 = samedi

  // Retrouver le dimanche 00:00 UTC le plus récent (pourrait être aujourd'hui)
  const end = new Date(midnight)
  end.setUTCDate(end.getUTCDate() - dayOfWeek)

  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 7)

  const dernierJour = new Date(end)
  dernierJour.setUTCDate(dernierJour.getUTCDate() - 1)

  return { type: 'weekly', start, end, label: `${jour(start)} — ${jour(dernierJour)}` }
}

/** Le mois calendaire précédent. */
export function monthlyPeriod(now: Date): Period {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return {
    type: 'monthly',
    start,
    end,
    label: `${MOIS[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
  }
}
