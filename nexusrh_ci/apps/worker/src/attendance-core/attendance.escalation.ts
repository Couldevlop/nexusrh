// COPIE VERBATIM de apps/api/src/modules/attendance/attendance.escalation.ts — garder
// synchronisé (le worker ne peut pas importer le package api).
import type { AttendanceConfig, ComputedDay, EscalationResult, GeneratedWarning, WarningTier } from './attendance.types.js'

/** Semaine ouvrée CI par défaut (lundi→samedi) — utilisée quand `workdays` n'est pas fourni. */
const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5, 6]

export interface EvaluateEscalationInput {
  employeeId: string
  days: ComputedDay[]
  config: AttendanceConfig
  consumedByTier: { tier1: string[]; tier2: string[] }
  activeWarnings: number
  /**
   * Jours ouvrés effectifs de l'employé (1=lundi … 7=dimanche), au même format que
   * `EffectiveSchedule.workdays`. Optionnel pour compatibilité ascendante — défaut
   * `[1,2,3,4,5,6]` (CI Mon–Sat). Un tenant en activité 7j/7 (ex. SOTRA) doit passer
   * `[1,2,3,4,5,6,7]` pour éviter de traiter samedi+lundi comme consécutifs.
   */
  workdays?: number[]
}

export interface EvaluateEscalationOutput extends EscalationResult {
  newlyConsumed: { tier1: string[]; tier2: string[] }
}

/**
 * Renvoie le jour ISO 1=lundi … 7=dimanche pour une date 'YYYY-MM-DD'.
 * Même convention UTC que `attendance.compute.ts` (isoWeekday).
 */
function isoWeekday(dateStr: string): number {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay()
  return day === 0 ? 7 : day
}

/** Ajoute `n` jours calendaires à une date 'YYYY-MM-DD' (arithmétique UTC). */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Détermine si `next` est le prochain jour ouvré après `prev` (dates `YYYY-MM-DD`,
 * `prev < next`), selon le calendrier ouvré réel `workdays` (1=lundi…7=dimanche).
 * On avance jour calendaire par jour calendaire depuis `prev`, on saute les jours
 * dont le jour ISO n'est pas dans `workdays`, et le premier jour ouvré rencontré
 * doit être exactement `next` pour que la série soit consécutive.
 */
function isNextWorkday(prev: string, next: string, workdays: number[]): boolean {
  let cursor = prev
  // Borne défensive : une semaine ouvrée normale ne saute jamais plus de quelques
  // jours calendaires d'affilée ; 14 itérations couvrent tous les cas plausibles
  // (et empêchent toute boucle infinie si `workdays` est vide/mal configuré).
  for (let i = 0; i < 14; i++) {
    cursor = addDays(cursor, 1)
    if (workdays.includes(isoWeekday(cursor))) {
      return cursor === next
    }
  }
  return false
}

/**
 * Cherche, dans une liste de dates `YYYY-MM-DD` triées ascendant et uniques,
 * la première série de `n` dates consécutives en jours ouvrés (selon `workdays`).
 * Retourne les `n` dates du premier groupe qui satisfait, sinon `null`.
 */
function consecutiveRun(dates: string[], n: number, workdays: number[]): string[] | null {
  if (n <= 0) return null
  if (dates.length < n) return null
  let runStart = 0
  for (let i = 0; i < dates.length; i++) {
    if (i > 0 && !isNextWorkday(dates[i - 1]!, dates[i]!, workdays)) {
      runStart = i
    }
    if (i - runStart + 1 >= n) {
      return dates.slice(runStart, runStart + n)
    }
  }
  return null
}

/**
 * Cherche, dans une liste de dates `YYYY-MM-DD` triées ascendant et uniques,
 * le premier mois civil (`YYYY-MM`, chronologique) contenant au moins `n` dates.
 * Retourne les `n` premières dates de ce mois, sinon `null`.
 */
function sameMonthGroup(dates: string[], n: number): string[] | null {
  if (n <= 0) return null
  if (dates.length < n) return null
  const byMonth = new Map<string, string[]>()
  for (const d of dates) {
    const month = d.slice(0, 7)
    const list = byMonth.get(month)
    if (list) list.push(d)
    else byMonth.set(month, [d])
  }
  const months = [...byMonth.keys()].sort()
  for (const month of months) {
    const list = byMonth.get(month)!
    if (list.length >= n) return list.slice(0, n)
  }
  return null
}

interface TierMatch {
  dates: string[]
  triggerReason: string
}

/**
 * Évalue un palier de retard (1 ou 2) indépendamment des autres — un même jour
 * peut être une occurrence pour le palier 1 ET le palier 2 (seuils différents,
 * jeux de dates consommées distincts).
 */
function evaluateTier(
  days: ComputedDay[],
  thresholdMinutes: number,
  occurrences: number,
  consumedDates: string[],
  workdays: number[],
): TierMatch | null {
  const consumedSet = new Set(consumedDates)
  const qualifyingDates = days
    .filter((d) => d.status === 'late' && d.lateMinutes >= thresholdMinutes && !consumedSet.has(d.workDate))
    .map((d) => d.workDate)
    .sort()

  const consecutive = consecutiveRun(qualifyingDates, occurrences, workdays)
  if (consecutive) {
    return { dates: consecutive, triggerReason: `${thresholdMinutes}min_x${occurrences}_consecutive` }
  }
  const monthGroup = sameMonthGroup(qualifyingDates, occurrences)
  if (monthGroup) {
    return { dates: monthGroup, triggerReason: `${thresholdMinutes}min_x${occurrences}_month` }
  }
  return null
}

/**
 * Moteur d'escalade pur (aucun accès I/O). Calcule les avertissements et
 * brouillons de sanction résultant des retards/absences non encore
 * "consommés", pour un employé et une fenêtre de jours calculés donnée.
 *
 * Règle clé : les paliers 1 et 2 sont évalués indépendamment sur la totalité
 * des `days` fournis — un jour dont le retard dépasse le seuil du palier 2
 * dépasse forcément aussi celui du palier 1, il compte donc comme occurrence
 * pour LES DEUX paliers (avec des jeux de dates consommées séparés par palier,
 * jamais de double-consommation au sein d'un même palier).
 */
export function evaluateEscalation(input: EvaluateEscalationInput): EvaluateEscalationOutput {
  const { employeeId, days, config, consumedByTier, activeWarnings } = input
  const workdays = input.workdays ?? DEFAULT_WORKDAYS
  const warnings: GeneratedWarning[] = []
  const newlyConsumed = { tier1: [] as string[], tier2: [] as string[] }

  const tierDefs: Array<{ threshold: number; occurrences: number; consumed: string[]; tier: WarningTier; bucket: 'tier1' | 'tier2' }> = [
    { threshold: config.lateMinutesTier1, occurrences: config.occurrencesTier1, consumed: consumedByTier.tier1, tier: 'avertissement', bucket: 'tier1' },
    { threshold: config.lateMinutesTier2, occurrences: config.occurrencesTier2, consumed: consumedByTier.tier2, tier: 'demande_explication', bucket: 'tier2' },
  ]

  for (const def of tierDefs) {
    const match = evaluateTier(days, def.threshold, def.occurrences, def.consumed, workdays)
    if (match) {
      warnings.push({ employeeId, tier: def.tier, triggerReason: match.triggerReason, occurrenceDates: match.dates })
      newlyConsumed[def.bucket].push(...match.dates)
    }
  }

  // Absences injustifiées — on réutilise le jeu consommé du palier 1 pour la
  // déduplication (un jour ne peut jamais être à la fois 'late' et
  // 'absent_unjustified', pas de collision possible).
  const absenceConsumedSet = new Set(consumedByTier.tier1)
  const unconsumedAbsenceDates = days
    .filter((d) => d.status === 'absent_unjustified' && !absenceConsumedSet.has(d.workDate))
    .map((d) => d.workDate)
    .sort()

  unconsumedAbsenceDates.forEach((workDate, index) => {
    if (index + 1 >= config.unjustifiedAbsenceOccurrences) {
      warnings.push({ employeeId, tier: 'avertissement', triggerReason: 'unjustified_absence', occurrenceDates: [workDate] })
      newlyConsumed.tier1.push(workDate)
    }
  })

  const total = activeWarnings + warnings.length
  const sanctionDrafts: EscalationResult['sanctionDrafts'] = []
  if (total >= config.warningsBeforeSanction) {
    const allOccurrenceDates = warnings.flatMap((w) => w.occurrenceDates)
    sanctionDrafts.push({
      employeeId,
      reason: `Cumul de ${total} avertissements (retards/absences)`,
      description: `Occurrences : ${allOccurrenceDates.join(', ')}`,
    })
  }

  return { warnings, sanctionDrafts, newlyConsumed }
}
