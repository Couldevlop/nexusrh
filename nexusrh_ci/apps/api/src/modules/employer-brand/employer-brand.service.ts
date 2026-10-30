/**
 * Marque employeur — logique PURE (période, médianes, taux, normalisation des
 * catégories). Aucune dépendance Fastify/DB → testable unitairement.
 *
 * Lot 1 : on valorise UNIQUEMENT les données déjà saisies dans NexusRH
 * (candidatures, offres, embauches, sorties). Aucune collecte nouvelle, et
 * uniquement des agrégats — jamais une ligne nominative.
 */
import { DEPARTURE_TYPES } from '../offboarding/offboarding.service.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** Fenêtre d'analyse maximale (évite les requêtes déraisonnables). */
export const MAX_PERIOD_DAYS = 366 * 5

/** Sources de candidature connues (applications.source). */
export const APPLICATION_SOURCES = ['careers_page', 'internal', 'sourced_ai', 'manual', 'other'] as const
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number]

/** Étapes du pipeline, dans l'ordre du kanban recrutement. */
export const PIPELINE_STAGES = ['new', 'screening', 'interview', 'test', 'offer', 'hired', 'rejected'] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

export const DEPARTURE_KEYS = DEPARTURE_TYPES
export type DepartureKey = (typeof DEPARTURE_KEYS)[number]

export interface Period { from: string; to: string }

function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * Période d'analyse. Défaut : les 12 derniers mois jusqu'à aujourd'hui.
 * Lève une Error (message affichable) si les bornes sont invalides.
 */
export function resolvePeriod(from: string | undefined, to: string | undefined, today: Date = new Date()): Period {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const end = to && to !== '' ? to : iso(today)
  let start: string
  if (from && from !== '') {
    start = from
  } else {
    const d = new Date(`${end}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) throw new Error('Date de fin invalide (AAAA-MM-JJ)')
    d.setUTCFullYear(d.getUTCFullYear() - 1)
    d.setUTCDate(d.getUTCDate() + 1)
    start = iso(d)
  }
  if (!isValidIsoDate(start)) throw new Error('Date de début invalide (AAAA-MM-JJ)')
  if (!isValidIsoDate(end)) throw new Error('Date de fin invalide (AAAA-MM-JJ)')
  const span = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
  if (span < 0) throw new Error('La date de début doit précéder la date de fin')
  if (span > MAX_PERIOD_DAYS) throw new Error('Période trop longue (5 ans maximum)')
  return { from: start, to: end }
}

/** Médiane (null si vide), arrondie à 0,1. */
export function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  const m = v.length % 2 === 0 ? ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2 : (v[mid] ?? 0)
  return Math.round(m * 10) / 10
}

/** Moyenne (null si vide), arrondie à 0,1. */
export function average(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n))
  if (v.length === 0) return null
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10
}

/** Taux en pourcentage (0–100, 1 décimale) ; null si dénominateur nul. */
export function percent(num: number, den: number): number | null {
  if (!den || den <= 0) return null
  return Math.round((num / den) * 1000) / 10
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** Source brute → catégorie canonique (NULL/'' = saisie manuelle historique). */
export function normalizeSource(raw: string | null | undefined): ApplicationSource {
  if (raw === null || raw === undefined || raw.trim() === '') return 'manual'
  return (APPLICATION_SOURCES as readonly string[]).includes(raw) ? (raw as ApplicationSource) : 'other'
}

/** Lignes { source, n } → toutes les sources, dans l'ordre canonique (0 inclus). */
export function bySource(rows: Array<{ source: string | null; n: unknown }>): Array<{ source: ApplicationSource; count: number }> {
  const acc = new Map<ApplicationSource, number>(APPLICATION_SOURCES.map((s) => [s, 0]))
  for (const r of rows) {
    const k = normalizeSource(r.source)
    acc.set(k, (acc.get(k) ?? 0) + toInt(r.n))
  }
  return APPLICATION_SOURCES.map((s) => ({ source: s, count: acc.get(s) ?? 0 }))
}

/** Lignes { stage, n } → toutes les étapes du pipeline, dans l'ordre (0 inclus). */
export function byStage(rows: Array<{ stage: string | null; n: unknown }>): Array<{ stage: PipelineStage; count: number }> {
  const acc = new Map<PipelineStage, number>(PIPELINE_STAGES.map((s) => [s, 0]))
  for (const r of rows) {
    const k = (PIPELINE_STAGES as readonly string[]).includes(r.stage ?? '') ? (r.stage as PipelineStage) : 'new'
    acc.set(k, (acc.get(k) ?? 0) + toInt(r.n))
  }
  return PIPELINE_STAGES.map((s) => ({ stage: s, count: acc.get(s) ?? 0 }))
}

/** Lignes { departure_type, n } → types de départ canoniques (inconnu → autre). */
export function byDepartureType(rows: Array<{ departure_type: string | null; n: unknown }>): Array<{ type: DepartureKey; count: number }> {
  const acc = new Map<DepartureKey, number>(DEPARTURE_KEYS.map((s) => [s, 0]))
  for (const r of rows) {
    const k = (DEPARTURE_KEYS as readonly string[]).includes(r.departure_type ?? '') ? (r.departure_type as DepartureKey) : 'autre'
    acc.set(k, (acc.get(k) ?? 0) + toInt(r.n))
  }
  return DEPARTURE_KEYS.map((s) => ({ type: s, count: acc.get(s) ?? 0 }))
}

export interface RetentionCounts {
  hires: unknown
  eligible_3m: unknown
  retained_3m: unknown
  eligible_12m: unknown
  retained_12m: unknown
  departures: unknown
  early_departures: unknown
}

export interface RetentionSummary {
  hires: number
  retention3m: { eligible: number; retained: number; rate: number | null }
  retention12m: { eligible: number; retained: number; rate: number | null }
  departures: number
  earlyDepartures: number
  earlyDepartureRate: number | null
}

/** Compteurs SQL → indicateurs de rétention des nouvelles recrues. */
export function summarizeRetention(row: Partial<RetentionCounts> | undefined): RetentionSummary {
  const r = row ?? {}
  const e3 = toInt(r.eligible_3m), k3 = toInt(r.retained_3m)
  const e12 = toInt(r.eligible_12m), k12 = toInt(r.retained_12m)
  const departures = toInt(r.departures), early = toInt(r.early_departures)
  return {
    hires: toInt(r.hires),
    retention3m: { eligible: e3, retained: k3, rate: percent(k3, e3) },
    retention12m: { eligible: e12, retained: k12, rate: percent(k12, e12) },
    departures,
    earlyDepartures: early,
    earlyDepartureRate: percent(early, departures),
  }
}
