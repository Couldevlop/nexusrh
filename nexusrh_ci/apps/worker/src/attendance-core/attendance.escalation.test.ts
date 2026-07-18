// COPIE VERBATIM de apps/api/src/modules/attendance/attendance.escalation.test.ts — garder
// synchronisé (le worker ne peut pas importer le package api).
import { it, expect } from 'vitest'
import { evaluateEscalation } from './attendance.escalation.js'

const cfg = {
  lateMinutesTier1: 30, occurrencesTier1: 3, lateMinutesTier2: 60, occurrencesTier2: 3,
  unjustifiedAbsenceOccurrences: 1, warningsBeforeSanction: 2, windowMode: 'consecutive_or_month',
} as const
const late = (date: string, mins: number) => ({ workDate: date, firstIn: new Date(date + 'T09:00:00Z'), lastOut: null, lateMinutes: mins, status: 'late' as const, justifiedBy: null })
const none = { tier1: [], tier2: [] }

it('3 jours à 35min consécutifs → avertissement palier 1', () => {
  const r = evaluateEscalation({ employeeId: 'e1', days: [late('2026-07-06', 35), late('2026-07-07', 35), late('2026-07-08', 35)], config: cfg, consumedByTier: none, activeWarnings: 0 })
  expect(r.warnings).toHaveLength(1)
  expect(r.warnings[0]!.tier).toBe('avertissement')
})

it('3 jours à 1h → avertissement (palier1) ET demande_explication (palier2) — les deux paliers comptent', () => {
  const r = evaluateEscalation({ employeeId: 'e1', days: [late('2026-07-06', 65), late('2026-07-07', 65), late('2026-07-08', 65)], config: cfg, consumedByTier: none, activeWarnings: 0 })
  const tiers = r.warnings.map(w => w.tier).sort()
  expect(tiers).toEqual(['avertissement', 'demande_explication'])
})

it('2 avertissements atteints → brouillon de sanction', () => {
  const r = evaluateEscalation({ employeeId: 'e1', days: [late('2026-07-06', 65), late('2026-07-07', 65), late('2026-07-08', 65)], config: cfg, consumedByTier: none, activeWarnings: 0 })
  expect(r.sanctionDrafts).toHaveLength(1) // les 2 warnings générés atteignent le seuil
})

it('jours déjà consommés d’un palier ne re-déclenchent pas ce palier', () => {
  const consumed = { tier1: ['2026-07-06', '2026-07-07', '2026-07-08'], tier2: [] }
  const r = evaluateEscalation({ employeeId: 'e1', days: [late('2026-07-06', 35), late('2026-07-07', 35), late('2026-07-08', 35)], config: cfg, consumedByTier: consumed, activeWarnings: 0 })
  expect(r.warnings).toHaveLength(0)
})

it('absence injustifiée → avertissement (seuil 1)', () => {
  const r = evaluateEscalation({ employeeId: 'e1', days: [{ workDate: '2026-07-08', firstIn: null, lastOut: null, lateMinutes: 0, status: 'absent_unjustified', justifiedBy: null }], config: cfg, consumedByTier: none, activeWarnings: 0 })
  expect(r.warnings.some(w => w.triggerReason === 'unjustified_absence')).toBe(true)
})

// --- Cas limites additionnels (au-delà des 5 tests du brief) ---

it('samedi → lundi (dimanche sauté) reste une série de jours ouvrés consécutifs', () => {
  const r = evaluateEscalation({ employeeId: 'e1', days: [late('2026-07-04', 35), late('2026-07-06', 35), late('2026-07-07', 35)], config: cfg, consumedByTier: none, activeWarnings: 0 })
  expect(r.warnings).toHaveLength(1)
  expect(r.warnings[0]!.triggerReason).toBe('30min_x3_consecutive')
  expect(r.warnings[0]!.occurrenceDates).toEqual(['2026-07-04', '2026-07-06', '2026-07-07'])
})

it('3 occurrences non consécutives mais dans le même mois civil → déclenchement "month"', () => {
  const r = evaluateEscalation({ employeeId: 'e1', days: [late('2026-07-06', 35), late('2026-07-10', 35), late('2026-07-15', 35)], config: cfg, consumedByTier: none, activeWarnings: 0 })
  expect(r.warnings).toHaveLength(1)
  expect(r.warnings[0]!.triggerReason).toBe('30min_x3_month')
})

// --- workdays paramétrable (fenêtre consécutive selon le vrai calendrier ouvré) ---

it('workdays 7j/7 (ex. SOTRA) : samedi + lundi ne sont PAS des jours ouvrés consécutifs (dimanche est un jour travaillé)', () => {
  const r = evaluateEscalation({
    employeeId: 'e1',
    days: [late('2026-07-11', 35), late('2026-07-13', 35)], // samedi, lundi (dimanche 07-12 entre les deux)
    config: { ...cfg, occurrencesTier1: 2 },
    consumedByTier: none,
    activeWarnings: 0,
    workdays: [1, 2, 3, 4, 5, 6, 7],
  })
  const tier1Warning = r.warnings.find((w) => w.tier === 'avertissement')
  // Le déclenchement (s'il a lieu) ne doit JAMAIS être via la voie "consecutive" ici :
  // avec dimanche ouvré, samedi→lundi ne sont pas des jours ouvrés consécutifs.
  expect(tier1Warning?.triggerReason).not.toMatch(/_consecutive$/)
})

it('workdays 6j/7 (CI, défaut) : samedi + lundi SONT des jours ouvrés consécutifs (dimanche sauté)', () => {
  const r = evaluateEscalation({
    employeeId: 'e1',
    days: [late('2026-07-11', 35), late('2026-07-13', 35)], // samedi, lundi
    config: { ...cfg, occurrencesTier1: 2 },
    consumedByTier: none,
    activeWarnings: 0,
    workdays: [1, 2, 3, 4, 5, 6],
  })
  const tier1Warning = r.warnings.find((w) => w.tier === 'avertissement')
  expect(tier1Warning?.triggerReason).toBe('30min_x2_consecutive')
  expect(tier1Warning?.occurrenceDates).toEqual(['2026-07-11', '2026-07-13'])
})

it('dédoublonnage palier 2 : dates déjà consommées au palier 2 ne re-déclenchent pas ce palier, indépendamment du palier 1', () => {
  const consumed = { tier1: [] as string[], tier2: ['2026-07-06', '2026-07-07', '2026-07-08'] }
  const r = evaluateEscalation({ employeeId: 'e1', days: [late('2026-07-06', 65), late('2026-07-07', 65), late('2026-07-08', 65)], config: cfg, consumedByTier: consumed, activeWarnings: 0 })
  expect(r.warnings.map((w) => w.tier)).toEqual(['avertissement'])
  expect(r.newlyConsumed.tier2).toEqual([])
  expect(r.newlyConsumed.tier1).toEqual(['2026-07-06', '2026-07-07', '2026-07-08'])
})

it('occurrences <= 0 (mauvaise config) ne déclenche jamais un avertissement fantôme', () => {
  const r = evaluateEscalation({
    employeeId: 'e1',
    days: [late('2026-07-06', 35)],
    config: { ...cfg, occurrencesTier1: 0 },
    consumedByTier: none,
    activeWarnings: 0,
  })
  expect(r.warnings.some((w) => w.tier === 'avertissement')).toBe(false)
})
