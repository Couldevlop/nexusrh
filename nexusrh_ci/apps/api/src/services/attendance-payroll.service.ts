/**
 * Lien badgeuse → paie : retenues pour absences injustifiées et retards
 * relevés par le pointage (`attendance_days`).
 *
 * 100 % paramétrable par tenant (`attendance_config.payroll_link`, jsonb) et
 * DÉSACTIVÉ par défaut. Sans badgeuse, sans module pointage, sans
 * paramétrage ou sans donnée pointée, la paie se calcule exactement comme
 * avant : toute lecture qui échoue renvoie « aucune retenue », jamais une
 * erreur (une paie bloquée ou une retenue injustifiée serait pire).
 *
 * Droit CI : seule la rémunération du temps NON TRAVAILLÉ est retenue, au
 * prorata. Une amende forfaitaire pour retard est une sanction pécuniaire,
 * interdite par le Code du travail : ce service n'en calcule jamais.
 */
import { z } from 'zod'
import { pool as rawPool } from '../db/pool.js'
import { getModulesForSchema } from './tenant-modules.service.js'
import type { AttendancePayrollDeductions } from './payroll-engine-ci.js'

export const attendancePayrollSettingsSchema = z.object({
  /** Interrupteur général du lien badgeuse → paie */
  enabled: z.boolean(),
  /** Retenir les journées d'absence injustifiée */
  deductUnjustifiedAbsences: z.boolean(),
  /** Diviseur du taux journalier : jours ouvrables du mois ou 30 jours */
  absenceDivisor: z.enum(['working_days', 'calendar_30']),
  /** Retenir les minutes de retard */
  deductLateness: z.boolean(),
  /** Un retard inférieur à ce seuil (minutes) n'est pas retenu */
  latenessMinPerOccurrenceMin: z.number().int().min(0).max(240),
  /** Franchise mensuelle (minutes cumulées non retenues) */
  latenessMonthlyAllowanceMin: z.number().int().min(0).max(6000),
  /** Arrondi des minutes retenues : exact ou au quart d'heure inférieur */
  latenessRounding: z.enum(['exact', 'quarter_hour_down']),
  /** Heures mensuelles de référence pour le taux horaire (40 h × 52 / 12) */
  monthlyHours: z.number().min(1).max(300),
  /** Suspendre les primes de présence en cas d'absence injustifiée */
  suspendAttendanceBonusOnUnjustified: z.boolean(),
  /** Plafond des retenues pointage, en % du salaire de base */
  maxPercentOfBase: z.number().min(0).max(100),
}).strict()

export type AttendancePayrollSettings = z.infer<typeof attendancePayrollSettingsSchema>

export const DEFAULT_ATTENDANCE_PAYROLL_SETTINGS: Readonly<AttendancePayrollSettings> = Object.freeze({
  enabled: false,
  deductUnjustifiedAbsences: true,
  absenceDivisor: 'working_days',
  deductLateness: false,
  latenessMinPerOccurrenceMin: 0,
  latenessMonthlyAllowanceMin: 0,
  latenessRounding: 'exact',
  monthlyHours: 173.33,
  suspendAttendanceBonusOnUnjustified: false,
  maxPercentOfBase: 100,
})

/** jsonb stocké (partiel, ancien, corrompu) → paramétrage complet. Ne lève jamais. */
export function parseAttendancePayrollSettings(raw: unknown): AttendancePayrollSettings {
  const out: AttendancePayrollSettings = { ...DEFAULT_ATTENDANCE_PAYROLL_SETTINGS }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const shape = attendancePayrollSettingsSchema.shape
  for (const key of Object.keys(shape) as (keyof AttendancePayrollSettings)[]) {
    const v = shape[key].safeParse((raw as Record<string, unknown>)[key])
    if (v.success) (out as Record<string, unknown>)[key] = v.data
  }
  return out
}

export interface AttendanceMonthData {
  /** Jours `absent_unjustified` non couverts par une absence approuvée */
  unjustifiedDays: number
  /** Minutes de retard de chaque jour `late` */
  lateMinutesByDay: number[]
}

export interface AttendancePayrollSummary {
  unjustifiedDays: number
  lateOccurrences: number
  lateMinutesRaw: number
  lateMinutesDeducted: number
  absenceAmount: number
  latenessAmount: number
  capped: boolean
}

export interface AttendancePayrollResult {
  deductions: AttendancePayrollDeductions
  summary: AttendancePayrollSummary
}

/** Calcul pur des retenues. `null` = aucune retenue à appliquer. */
export function computeAttendanceDeductions(
  settings: AttendancePayrollSettings,
  data: AttendanceMonthData,
  baseSalary: number,
  workingDaysMonth: number,
): AttendancePayrollResult | null {
  if (!settings.enabled || !(baseSalary > 0)) return null

  const absenceDays = settings.deductUnjustifiedAbsences
    ? Math.min(Math.max(0, Math.floor(data.unjustifiedDays)), workingDaysMonth)
    : 0
  const divisor = settings.absenceDivisor === 'calendar_30' ? 30 : workingDaysMonth
  let absenceAmount = divisor > 0 ? Math.floor((baseSalary / divisor) * absenceDays) : 0

  const lates = data.lateMinutesByDay.filter((m) => Number.isFinite(m) && m > 0)
  const lateMinutesRaw = lates.reduce((s, m) => s + m, 0)
  let lateMinutesDeducted = 0
  if (settings.deductLateness) {
    const counted = lates
      .filter((m) => m >= settings.latenessMinPerOccurrenceMin)
      .reduce((s, m) => s + m, 0)
    lateMinutesDeducted = Math.max(0, counted - settings.latenessMonthlyAllowanceMin)
    if (settings.latenessRounding === 'quarter_hour_down') {
      lateMinutesDeducted = Math.floor(lateMinutesDeducted / 15) * 15
    }
  }
  let latenessAmount = Math.floor((baseSalary / (settings.monthlyHours * 60)) * lateMinutesDeducted)

  const cap = Math.floor(baseSalary * settings.maxPercentOfBase / 100)
  let capped = false
  if (absenceAmount > cap) { absenceAmount = cap; capped = true }
  if (absenceAmount + latenessAmount > cap) { latenessAmount = cap - absenceAmount; capped = true }

  const suspend = settings.suspendAttendanceBonusOnUnjustified && absenceDays > 0
  if (absenceAmount <= 0 && latenessAmount <= 0 && !suspend) return null

  return {
    deductions: {
      absenceDays,
      absenceAmount,
      lateMinutes: lateMinutesDeducted,
      latenessAmount,
      suspendAttendanceBonus: suspend,
    },
    summary: {
      unjustifiedDays: absenceDays,
      lateOccurrences: lates.length,
      lateMinutesRaw,
      lateMinutesDeducted,
      absenceAmount,
      latenessAmount,
      capped,
    },
  }
}

/** Paramétrage du tenant ; défauts (désactivé) sur toute erreur. */
export async function loadAttendancePayrollSettings(schema: string): Promise<AttendancePayrollSettings> {
  try {
    const res = await rawPool.query<{ payroll_link: unknown }>(
      `SELECT payroll_link FROM "${schema}".attendance_config ORDER BY updated_at DESC LIMIT 1`,
    )
    return parseAttendancePayrollSettings(res?.rows?.[0]?.payroll_link)
  } catch {
    return { ...DEFAULT_ATTENDANCE_PAYROLL_SETTINGS }
  }
}

/**
 * Paramétrage EFFECTIF pour un calcul de paie : actif seulement si le tenant
 * l'a activé ET que le module pointage est ouvert (un module désactivé ne doit
 * pas continuer à retenir sur des pointages anciens).
 */
export async function loadEffectiveAttendancePayrollSettings(schema: string): Promise<AttendancePayrollSettings | null> {
  const settings = await loadAttendancePayrollSettings(schema)
  if (!settings.enabled) return null
  try {
    const modules = await getModulesForSchema(rawPool, schema)
    return modules.attendance ? settings : null
  } catch {
    return null
  }
}

/** Pointages du mois d'un employé ; aucune donnée sur toute erreur. */
export async function loadAttendanceMonth(
  schema: string, employeeId: string, month: string,
  range?: { start: string; end: string },
): Promise<AttendanceMonthData> {
  const empty: AttendanceMonthData = { unjustifiedDays: 0, lateMinutesByDay: [] }
  if (!/^\d{4}-\d{2}$/.test(month)) return empty
  const [year, monthNum] = month.split('-').map(Number) as [number, number]
  // Entrée / sortie en cours de mois : seuls les jours sous contrat comptent
  const monthStart = range?.start ?? `${month}-01`
  const monthEnd = range?.end ?? `${month}-${String(new Date(year, monthNum, 0).getDate()).padStart(2, '0')}`
  try {
    // Un jour pointé « absent » puis couvert par une absence approuvée après
    // coup (pointage non recalculé) n'est jamais retenu.
    const res = await rawPool.query<{ status: string; late_minutes: number }>(
      `SELECT d.status, d.late_minutes
       FROM "${schema}".attendance_days d
       WHERE d.employee_id = $1
         AND d.work_date BETWEEN $2 AND $3
         AND d.status IN ('absent_unjustified', 'late')
         AND d.justified_by IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM "${schema}".absences a
           WHERE a.employee_id = d.employee_id AND a.status = 'approved'
             AND d.work_date BETWEEN a.start_date AND a.end_date)`,
      [employeeId, monthStart, monthEnd],
    )
    let unjustifiedDays = 0
    const lateMinutesByDay: number[] = []
    for (const r of res?.rows ?? []) {
      if (r.status === 'absent_unjustified') unjustifiedDays++
      else lateMinutesByDay.push(Number(r.late_minutes) || 0)
    }
    return { unjustifiedDays, lateMinutesByDay }
  } catch {
    return empty
  }
}

/**
 * Retenues pointage d'un employé pour un mois. `settings` = résultat de
 * `loadEffectiveAttendancePayrollSettings` (chargé une fois par lot) ; null
 * → aucune requête, aucune retenue.
 */
export async function resolveAttendanceForPayroll(
  settings: AttendancePayrollSettings | null,
  schema: string,
  employeeId: string,
  month: string,
  baseSalary: number,
  workingDaysMonth: number,
  range?: { start: string; end: string },
): Promise<AttendancePayrollResult | null> {
  if (!settings) return null
  const data = await loadAttendanceMonth(schema, employeeId, month, range)
  return computeAttendanceDeductions(settings, data, baseSalary, workingDaysMonth)
}