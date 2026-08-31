/**
 * Job worker : évaluation Badgeuse / Pointage (Task 17, module Badgeuse / Pointage).
 *
 * Consommateur de la file `attendance-evaluate` enfilée par
 * `apps/worker/src/jobs/attendance-poll.ts` (après une synchronisation de
 * badgeuse) ou par une future route manuelle. Reçoit
 * `{ schemaName, employeeId?, dateFrom, dateTo }` : pour chaque employé cible
 * et chaque jour de la plage, calcule le jour agrégé (`computeDay`) et le
 * persiste (`attendance_days`, idempotent), puis exécute le moteur
 * d'escalade (`evaluateEscalation`) sur l'historique de l'employé pour
 * générer avertissements et brouillons de sanction.
 *
 * RÉUTILISATION — ce module NE PEUT PAS importer depuis `apps/api` (même
 * raison que `attendance-poll.ts` : `@nexusrhci/worker` n'a aucune dépendance
 * vers `@nexusrhci/api`, `rootDir: "./src"` interdit toute importation hors
 * du package). Les services PURS et déjà testés (`computeDay`,
 * `resolveSchedule`, `evaluateEscalation`) sont donc COPIÉS VERBATIM dans
 * `../attendance-core/` (fichiers + tests, cf. en-têtes de ces fichiers) —
 * ce job ne réimplémente AUCUNE règle métier de calcul de retard/escalade,
 * il assemble uniquement les entrées (pointages, horaire effectif, jour
 * férié CI, congé approuvé, dates déjà consommées) et persiste les
 * résultats. Le calendrier des jours fériés vient de `@nexusrhci/shared/ci-holidays`,
 * partagé avec l'API — il n'en existe plus qu'une seule implémentation.
 *
 * CONTRAT CRITIQUE — `workdays` : `EffectiveSchedule.workdays` (résolu par
 * `resolveSchedule`, cascade employé > département > tenant) DOIT être
 * transmis à `evaluateEscalation({ ..., workdays })`. Omettre ce champ fait
 * silencieusement retomber le moteur sur le défaut `[1,2,3,4,5,6]`, ce qui
 * réintroduit un faux-positif pour un tenant actif 7j/7 (ex. SOTRA) : un
 * samedi suivi d'un lundi serait alors considéré comme non-consécutif à tort
 * (ou l'inverse) — cf. `attendance-core/attendance.escalation.ts` et ses
 * tests « workdays 7j/7 » / « workdays 6j/7 ».
 *
 * IDEMPOTENCE — `attendance_days` est upserté via `ON CONFLICT (employee_id,
 * work_date) DO UPDATE` (relancer le calcul d'un jour déjà traité ne
 * duplique jamais de ligne). Les avertissements ne sont jamais dupliqués non
 * plus : `consumedByTier` est rechargé DEPUIS `attendance_warnings` avant
 * chaque appel à `evaluateEscalation`, donc les dates déjà couvertes par un
 * avertissement existant sont exclues par le moteur lui-même — relancer ce
 * job sur la même plage ne (re)génère donc que les occurrences réellement
 * nouvelles.
 *
 * OWASP :
 *  - A01/A03 : payload validé (schemaName safe / employeeId uuid / dates
 *    ISO / plage bornée à 366 jours) AVANT toute requête DB
 *    (`parseAttendanceEvaluatePayload`).
 *  - Isolement des pannes : l'échec du traitement d'UN employé (erreur DB,
 *    horaire corrompu…) est capturé, journalisé, et NE DOIT JAMAIS
 *    interrompre le traitement des autres employés du lot — chaque employé
 *    est encapsulé dans son propre try/catch.
 *  - Notifications (RH + employé) : best-effort, jamais bloquant — un tenant
 *    sans table `notifications` ou un compte utilisateur supprimé ne doit
 *    jamais faire échouer la persistance de l'avertissement/sanction déjà
 *    actée en base.
 */
import type { Job } from 'bullmq'
import { Pool } from 'pg'
import { logger } from '../logger.js'
import { parseAttendanceEvaluatePayload, JobValidationError } from '../schemas.js'
import { joursFeriesCI } from '@nexusrhci/shared/ci-holidays'
import { computeDay } from '../attendance-core/attendance.compute.js'
import { resolveSchedule } from '../attendance-core/attendance.schedule.js'
import { evaluateEscalation } from '../attendance-core/attendance.escalation.js'
import type {
  AttendanceConfig,
  ComputedDay,
  EffectiveSchedule,
  GeneratedWarning,
  NormalizedPunch,
} from '../attendance-core/attendance.types.js'

// OWASP A04 — cap connexions PG (job séquentiel employé-par-employé/jour-par-jour ;
// 5 connexions suffisent et évitent de saturer le pool DB partagé).
const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })

// ── Défauts (miroir EXACT de attendance.routes.ts::DEFAULT_CONFIG — appliqués
// si le tenant n'a encore aucune ligne `attendance_config`/`attendance_schedules`) ─
const DEFAULT_ESCALATION_CONFIG: AttendanceConfig = {
  lateMinutesTier1: 30,
  occurrencesTier1: 3,
  lateMinutesTier2: 60,
  occurrencesTier2: 3,
  unjustifiedAbsenceOccurrences: 1,
  warningsBeforeSanction: 2,
  windowMode: 'consecutive_or_month',
}
const DEFAULT_SCHEDULE: EffectiveSchedule = {
  expectedStart: '08:00',
  toleranceMin: 10,
  expectedEnd: null,
  workdays: [1, 2, 3, 4, 5],
}

// ── Résolution de la config tenant (seuils d'escalade + horaire de repli) ──

interface AttendanceConfigRow {
  late_minutes_tier1: number
  occurrences_tier1: number
  late_minutes_tier2: number
  occurrences_tier2: number
  unjustified_absence_occurrences: number
  warnings_before_sanction: number
  window_mode: string
  default_expected_start: string
  default_tolerance_min: number
  default_workdays: number[]
}

interface TenantAttendanceConfig {
  escalation: AttendanceConfig
  fallbackSchedule: EffectiveSchedule
}

/** Tronque une valeur `time` Postgres ('HH:MM:SS') → 'HH:MM'. Défensif sur les valeurs courtes. */
function toHHMM(t: string): string {
  return t.length >= 5 ? t.slice(0, 5) : t
}

/**
 * Charge le singleton `attendance_config` du tenant. Renvoie les défauts
 * applicatifs si aucune ligne n'existe ou en cas d'erreur DB (repli sûr —
 * cf. convention de ce module : une lecture qui échoue ne doit jamais
 * produire une escalade par erreur).
 */
async function loadTenantConfig(schema: string): Promise<TenantAttendanceConfig> {
  try {
    const res = await pool.query<AttendanceConfigRow>(
      `SELECT late_minutes_tier1, occurrences_tier1, late_minutes_tier2, occurrences_tier2,
              unjustified_absence_occurrences, warnings_before_sanction, window_mode,
              default_expected_start, default_tolerance_min, default_workdays
         FROM "${schema}".attendance_config
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    const row = res.rows[0]
    if (!row) return { escalation: DEFAULT_ESCALATION_CONFIG, fallbackSchedule: DEFAULT_SCHEDULE }
    return {
      escalation: {
        lateMinutesTier1: row.late_minutes_tier1,
        occurrencesTier1: row.occurrences_tier1,
        lateMinutesTier2: row.late_minutes_tier2,
        occurrencesTier2: row.occurrences_tier2,
        unjustifiedAbsenceOccurrences: row.unjustified_absence_occurrences,
        warningsBeforeSanction: row.warnings_before_sanction,
        windowMode: 'consecutive_or_month',
      },
      fallbackSchedule: {
        expectedStart: row.default_expected_start ? toHHMM(row.default_expected_start) : DEFAULT_SCHEDULE.expectedStart,
        toleranceMin: row.default_tolerance_min ?? DEFAULT_SCHEDULE.toleranceMin,
        expectedEnd: null,
        workdays: Array.isArray(row.default_workdays) && row.default_workdays.length > 0
          ? row.default_workdays
          : DEFAULT_SCHEDULE.workdays,
      },
    }
  } catch (err) {
    logger.error({ schemaName: schema, err }, 'attendance-evaluate: échec lecture attendance_config — défauts appliqués')
    return { escalation: DEFAULT_ESCALATION_CONFIG, fallbackSchedule: DEFAULT_SCHEDULE }
  }
}

// ── Résolution de l'horaire effectif (cascade employé > département > tenant) ──

interface ScheduleRow {
  scope: string
  expected_start: string
  tolerance_min: number
  expected_end: string | null
  workdays: number[]
}

function mapScheduleRow(row: ScheduleRow): EffectiveSchedule {
  return {
    expectedStart: toHHMM(row.expected_start),
    toleranceMin: row.tolerance_min,
    expectedEnd: row.expected_end ? toHHMM(row.expected_end) : null,
    workdays: row.workdays,
  }
}

/** Charge les surcharges d'horaire actives (employé/département/tenant) pour la cascade `resolveSchedule`. */
async function resolveEmployeeSchedule(
  schema: string,
  employeeId: string,
  departmentId: string | null,
  fallbackSchedule: EffectiveSchedule,
): Promise<EffectiveSchedule> {
  let employeeScope: EffectiveSchedule | null = null
  let departmentScope: EffectiveSchedule | null = null
  let tenantScope: EffectiveSchedule | null = null
  try {
    const res = await pool.query<ScheduleRow>(
      `SELECT scope, expected_start, tolerance_min, expected_end, workdays
         FROM "${schema}".attendance_schedules
        WHERE is_active = true
          AND ((scope = 'employee' AND scope_id = $1)
            OR (scope = 'department' AND scope_id = $2)
            OR (scope = 'tenant'))
        ORDER BY updated_at DESC`,
      [employeeId, departmentId],
    )
    for (const row of res.rows) {
      if (row.scope === 'employee' && !employeeScope) employeeScope = mapScheduleRow(row)
      else if (row.scope === 'department' && !departmentScope) departmentScope = mapScheduleRow(row)
      else if (row.scope === 'tenant' && !tenantScope) tenantScope = mapScheduleRow(row)
    }
  } catch (err) {
    logger.error({ schemaName: schema, employeeId, err }, 'attendance-evaluate: échec lecture attendance_schedules — horaire de repli appliqué')
  }
  return resolveSchedule({ employee: employeeScope, department: departmentScope, tenant: tenantScope ?? fallbackSchedule })
}

/**
 * Résout le `department_id` d'un employé. Renvoie `undefined` si l'employé
 * n'existe pas dans CE schéma (isolation tenant) — l'appelant doit alors
 * ignorer cet employé plutôt que recalculer sur un `department_id` erroné.
 */
async function loadEmployeeDepartmentId(schema: string, employeeId: string): Promise<string | null | undefined> {
  try {
    const res = await pool.query<{ department_id: string | null }>(
      `SELECT department_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`,
      [employeeId],
    )
    if (!res.rows[0]) return undefined
    return res.rows[0].department_id
  } catch (err) {
    logger.error({ schemaName: schema, employeeId, err }, 'attendance-evaluate: échec lecture employees.department_id')
    return undefined
  }
}

// ── Pointages / congé approuvé (entrées de computeDay) ─────────────────────

interface PunchDayRow {
  raw_employee_ref: string | null
  punched_at: Date | string
  direction: string
  dedup_key: string
  raw: unknown
}

/** Charge les pointages BRUTS d'un employé pour un jour donné, normalisés vers `NormalizedPunch`. */
async function loadPunchesForDate(schema: string, employeeId: string, workDate: string): Promise<NormalizedPunch[]> {
  try {
    const res = await pool.query<PunchDayRow>(
      `SELECT raw_employee_ref, punched_at, direction, dedup_key, raw
         FROM "${schema}".attendance_punches
        WHERE employee_id = $1 AND punched_at::date = $2::date
        ORDER BY punched_at ASC`,
      [employeeId, workDate],
    )
    return res.rows.map((row) => ({
      rawEmployeeRef: row.raw_employee_ref ?? '',
      punchedAt: row.punched_at instanceof Date ? row.punched_at : new Date(row.punched_at),
      direction: row.direction === 'in' || row.direction === 'out' ? row.direction : 'unknown',
      dedupKey: row.dedup_key,
      raw: row.raw,
    }))
  } catch (err) {
    logger.error({ schemaName: schema, employeeId, workDate, err }, 'attendance-evaluate: échec lecture attendance_punches')
    return []
  }
}

/** Renvoie l'id de la première absence APPROUVÉE couvrant `workDate` pour cet employé, sinon `null`. */
async function loadApprovedLeaveId(schema: string, employeeId: string, workDate: string): Promise<string | null> {
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT id FROM "${schema}".absences
        WHERE employee_id = $1 AND status = 'approved' AND $2::date BETWEEN start_date AND end_date
        LIMIT 1`,
      [employeeId, workDate],
    )
    return res.rows[0]?.id ?? null
  } catch (err) {
    logger.error({ schemaName: schema, employeeId, workDate, err }, 'attendance-evaluate: échec lecture absences approuvées')
    return null
  }
}

/**
 * Insère ou recalcule (idempotent) le jour agrégé d'un employé, via
 * `ON CONFLICT (employee_id, work_date) DO UPDATE`. Lève en cas d'échec —
 * une écriture perdue silencieusement serait pire qu'une exception remontée
 * à l'appelant (le try/catch PAR EMPLOYÉ du handler principal l'absorbe).
 */
async function upsertDay(schema: string, employeeId: string, day: ComputedDay, expectedStart: string | null): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO "${schema}".attendance_days
         (employee_id, work_date, first_in, last_out, expected_start, late_minutes, status, justified_by, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (employee_id, work_date) DO UPDATE SET
         first_in = EXCLUDED.first_in,
         last_out = EXCLUDED.last_out,
         expected_start = EXCLUDED.expected_start,
         late_minutes = EXCLUDED.late_minutes,
         status = EXCLUDED.status,
         justified_by = EXCLUDED.justified_by,
         computed_at = now()`,
      [employeeId, day.workDate, day.firstIn, day.lastOut, expectedStart, day.lateMinutes, day.status, day.justifiedBy],
    )
  } catch (e) {
    throw new Error(`upsertDay a échoué (employee=${employeeId}, date=${day.workDate}) : ${(e as Error).message}`)
  }
}

/** Énumère les dates 'YYYY-MM-DD' de `from` à `to` inclus (UTC, pas de dérive de fuseau). */
function dateRangeInclusive(from: string, to: string): string[] {
  const dates: string[] = []
  const cur = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cur.getTime() <= end.getTime()) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return dates
}

// ── Résolution des employés cibles ──────────────────────────────────────────

/** Vérifie qu'un employé donné existe bien dans CE tenant (isolation). */
async function loadSingleTargetEmployee(schema: string, employeeId: string): Promise<string[]> {
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT id FROM "${schema}".employees WHERE id = $1 LIMIT 1`,
      [employeeId],
    )
    return res.rows[0] ? [res.rows[0].id] : []
  } catch (err) {
    logger.error({ schemaName: schema, employeeId, err }, 'attendance-evaluate: échec résolution employé cible')
    return []
  }
}

/** Employés actifs ayant au moins un pointage ou un jour déjà calculé dans la plage. */
async function loadActiveTargetEmployees(schema: string, dateFrom: string, dateTo: string): Promise<string[]> {
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT DISTINCT e.id
         FROM "${schema}".employees e
        WHERE e.is_active = true
          AND (
            EXISTS (
              SELECT 1 FROM "${schema}".attendance_punches p
               WHERE p.employee_id = e.id AND p.punched_at >= $1::date AND p.punched_at < ($2::date + interval '1 day')
            )
            OR EXISTS (
              SELECT 1 FROM "${schema}".attendance_days d
               WHERE d.employee_id = e.id AND d.work_date BETWEEN $1 AND $2
            )
          )`,
      [dateFrom, dateTo],
    )
    return res.rows.map((r) => r.id)
  } catch (err) {
    logger.error({ schemaName: schema, dateFrom, dateTo, err }, 'attendance-evaluate: échec résolution des employés cibles')
    return []
  }
}

// ── Escalade — dates déjà consommées / avertissements actifs / persistance ─

interface WarningTierRow {
  tier: string
  occurrence_dates: Array<string | Date> | null
}

/** Normalise une valeur `date` Postgres (Date ou string) → 'YYYY-MM-DD'. */
function toDateStr(v: string | Date): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

/**
 * Agrège les `occurrence_dates` déjà consommées par palier, depuis
 * `attendance_warnings.tier` (bucketisation identique à `attendance.repo.ts`
 * côté API : `tier = 'avertissement'` → tier1, `tier = 'demande_explication'`
 * → tier2). C'est CE mécanisme qui garantit l'idempotence : rejouer ce job
 * sur la même plage recharge les mêmes dates consommées, donc
 * `evaluateEscalation` ne régénère jamais les mêmes avertissements.
 */
async function loadConsumedDates(schema: string, employeeId: string): Promise<{ tier1: string[]; tier2: string[] }> {
  try {
    const res = await pool.query<WarningTierRow>(
      `SELECT tier, occurrence_dates FROM "${schema}".attendance_warnings WHERE employee_id = $1`,
      [employeeId],
    )
    const tier1: string[] = []
    const tier2: string[] = []
    for (const row of res.rows) {
      const dates = (row.occurrence_dates ?? []).map((d) => toDateStr(d))
      if (row.tier === 'avertissement') tier1.push(...dates)
      else if (row.tier === 'demande_explication') tier2.push(...dates)
    }
    return { tier1, tier2 }
  } catch (err) {
    logger.error({ schemaName: schema, employeeId, err }, 'attendance-evaluate: échec lecture des dates consommées')
    return { tier1: [], tier2: [] }
  }
}

/** Compte les avertissements en cours (non clos) d'un employé. */
async function countActiveWarnings(schema: string, employeeId: string): Promise<number> {
  try {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM "${schema}".attendance_warnings
        WHERE employee_id = $1 AND status IN ('active', 'contested')`,
      [employeeId],
    )
    return Number(res.rows[0]?.count ?? 0)
  } catch (err) {
    logger.error({ schemaName: schema, employeeId, err }, 'attendance-evaluate: échec comptage des avertissements actifs')
    return 0
  }
}

/** Insère un avertissement (statut initial `active`). Lève en cas d'échec (absorbé par le try/catch employé). */
async function insertWarning(
  schema: string,
  w: GeneratedWarning,
  thresholdSnapshot: AttendanceConfig,
): Promise<string> {
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".attendance_warnings
         (employee_id, tier, trigger_reason, occurrence_dates, threshold_snapshot, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id`,
      [w.employeeId, w.tier, w.triggerReason, w.occurrenceDates, JSON.stringify(thresholdSnapshot)],
    )
    const id = res.rows[0]?.id
    if (!id) throw new Error('INSERT sans ligne retournée')
    return id
  } catch (e) {
    throw new Error(`insertWarning a échoué (employee=${w.employeeId}) : ${(e as Error).message}`)
  }
}

interface SanctionDraftInput {
  employeeId: string
  reason: string
  description?: string | null
}

/**
 * Insère un brouillon de sanction dans `disciplinary_actions` (table
 * INCHANGÉE — colonnes existantes uniquement) : `type='avertissement'`,
 * `status='draft'`, `action_date=CURRENT_DATE`, `issued_by=NULL` (acteur
 * système — aucun utilisateur RH n'a agi). Renvoie l'id créé.
 */
async function insertSanctionDraft(schema: string, draft: SanctionDraftInput): Promise<string> {
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".disciplinary_actions
         (employee_id, type, reason, description, action_date, status, issued_by)
       VALUES ($1, 'avertissement', $2, $3, CURRENT_DATE, 'draft', NULL)
       RETURNING id`,
      [draft.employeeId, draft.reason, draft.description ?? null],
    )
    const id = res.rows[0]?.id
    if (!id) throw new Error('INSERT sans ligne retournée')
    return id
  } catch (e) {
    throw new Error(`insertSanctionDraft a échoué (employee=${draft.employeeId}) : ${(e as Error).message}`)
  }
}

/** Reporte l'id du brouillon de sanction sur les avertissements qui l'ont déclenché. */
async function linkWarningsToSanction(schema: string, warningIds: string[], sanctionId: string): Promise<void> {
  if (warningIds.length === 0) return
  try {
    await pool.query(
      `UPDATE "${schema}".attendance_warnings SET disciplinary_action_id = $1 WHERE id = ANY($2::uuid[])`,
      [sanctionId, warningIds],
    )
  } catch (err) {
    logger.error({ schemaName: schema, sanctionId, warningIds, err }, 'attendance-evaluate: échec liaison avertissements → sanction')
  }
}

// ── Notifications (calqué sur attendance.routes.ts::notifyUser + mobile-money.routes.ts::notifyAdminsMmFailure) ──
// Best-effort, JAMAIS bloquant : un tenant sans table `notifications`, sans
// utilisateur RH actif, ou un employé sans compte lié ne doit jamais faire
// échouer la persistance déjà actée (avertissement/sanction).

/** Résout le user_id du compte lié à un employé (null si aucun). */
async function userIdOfEmployee(schema: string, employeeId: string): Promise<string | null> {
  try {
    const r = await pool.query<{ user_id: string | null }>(
      `SELECT user_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
    )
    return r.rows[0]?.user_id ?? null
  } catch {
    return null
  }
}

function notifyUser(
  schema: string, userId: string | null, type: string,
  title: string, message: string, data: Record<string, unknown>,
): void {
  if (!userId) return
  pool.query(
    `INSERT INTO "${schema}".notifications (user_id, type, title, message, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, message, JSON.stringify(data)],
  ).catch(() => { /* tenant sans notifications / user supprimé : non bloquant */ })
}

/** Notifie tous les utilisateurs RH actifs (admin/hr_manager) du tenant. */
function notifyRhUsers(
  schema: string, type: string, title: string, message: string, data: Record<string, unknown>,
): void {
  pool.query(
    `INSERT INTO "${schema}".notifications (user_id, type, title, message, data)
     SELECT id, $1, $2, $3, $4 FROM "${schema}".users WHERE role IN ('admin', 'hr_manager') AND is_active = true`,
    [type, title, message, JSON.stringify(data)],
  ).catch(() => { /* tenant sans notifications : non bloquant */ })
}

const TIER_LABELS: Record<GeneratedWarning['tier'], string> = {
  avertissement: 'Avertissement',
  demande_explication: "Demande d'explication",
}

// ── Traitement d'un employé (calcul des jours + escalade) ──────────────────

interface EmployeeProcessResult {
  daysComputed: number
  warningsCreated: number
  sanctionsCreated: number
}

async function processEmployee(
  schema: string,
  employeeId: string,
  dates: string[],
  fallbackSchedule: EffectiveSchedule,
  escalationConfig: AttendanceConfig,
  isHolidayOn: (workDate: string) => boolean,
): Promise<EmployeeProcessResult> {
  const departmentId = await loadEmployeeDepartmentId(schema, employeeId)
  // Isolation tenant : employé introuvable dans CE schéma → rien à faire.
  if (departmentId === undefined) {
    return { daysComputed: 0, warningsCreated: 0, sanctionsCreated: 0 }
  }

  const schedule = await resolveEmployeeSchedule(schema, employeeId, departmentId, fallbackSchedule)

  const computedDays: ComputedDay[] = []
  for (const workDate of dates) {
    const [punches, approvedLeaveId] = await Promise.all([
      loadPunchesForDate(schema, employeeId, workDate),
      loadApprovedLeaveId(schema, employeeId, workDate),
    ])
    const computed = computeDay({
      workDate,
      punches,
      schedule,
      isHoliday: isHolidayOn(workDate),
      approvedLeaveId,
    })
    await upsertDay(schema, employeeId, computed, schedule.expectedStart)
    computedDays.push(computed)
  }

  // ── Escalade : dates déjà consommées + avertissements actifs rechargés
  // DEPUIS LA BASE avant chaque évaluation → garantit l'idempotence d'un
  // relancement de ce job sur la même plage (cf. en-tête du fichier).
  const [consumedByTier, activeWarnings] = await Promise.all([
    loadConsumedDates(schema, employeeId),
    countActiveWarnings(schema, employeeId),
  ])

  // CONTRAT CRITIQUE : `schedule.workdays` (résolu employé > département >
  // tenant) est TOUJOURS transmis — jamais omis, jamais [1..6] codé en dur ici.
  const escalation = evaluateEscalation({
    employeeId,
    days: computedDays,
    config: escalationConfig,
    consumedByTier,
    activeWarnings,
    workdays: schedule.workdays,
  })

  const insertedWarningIds: string[] = []
  let notifiedEmployeeUserId: string | null | undefined

  for (const warning of escalation.warnings) {
    const warningId = await insertWarning(schema, warning, escalationConfig)
    insertedWarningIds.push(warningId)

    if (notifiedEmployeeUserId === undefined) {
      notifiedEmployeeUserId = await userIdOfEmployee(schema, employeeId)
    }
    const label = TIER_LABELS[warning.tier]
    notifyUser(schema, notifiedEmployeeUserId, 'attendance_warning_new', `${label} de présence`,
      `Un ${label.toLowerCase()} a été généré pour votre présence (motif : ${warning.triggerReason}).`,
      { warningId, tier: warning.tier, occurrenceDates: warning.occurrenceDates })
    notifyRhUsers(schema, 'attendance_warning_new', `${label} de présence généré`,
      `Un ${label.toLowerCase()} a été généré automatiquement (motif : ${warning.triggerReason}).`,
      { employeeId, warningId, tier: warning.tier, occurrenceDates: warning.occurrenceDates })
  }

  let sanctionsCreated = 0
  for (const draft of escalation.sanctionDrafts) {
    const sanctionId = await insertSanctionDraft(schema, draft)
    sanctionsCreated += 1
    await linkWarningsToSanction(schema, insertedWarningIds, sanctionId)

    if (notifiedEmployeeUserId === undefined) {
      notifiedEmployeeUserId = await userIdOfEmployee(schema, employeeId)
    }
    notifyUser(schema, notifiedEmployeeUserId, 'attendance_sanction_draft', 'Brouillon de sanction disciplinaire',
      `Un brouillon de sanction a été créé suite à vos avertissements de présence : ${draft.reason}.`,
      { sanctionId, reason: draft.reason })
    notifyRhUsers(schema, 'attendance_sanction_draft', 'Brouillon de sanction créé',
      `Brouillon de sanction créé automatiquement — ${draft.reason}. À valider.`,
      { employeeId, sanctionId, reason: draft.reason })
  }

  return { daysComputed: computedDays.length, warningsCreated: escalation.warnings.length, sanctionsCreated }
}

// ── Handler principal ────────────────────────────────────────────────────

export async function processAttendanceEvaluateJob(job: Job<unknown, void>): Promise<void> {
  // OWASP A03 + A01 — payload validé AVANT toute requête DB (job Redis = entrée non fiable).
  let payload: { schemaName: string; employeeId?: string; dateFrom: string; dateTo: string }
  try {
    payload = parseAttendanceEvaluatePayload(job.data)
  } catch (err) {
    if (err instanceof JobValidationError) {
      logger.error({ jobId: job.id, err: err.message }, 'attendance-evaluate: payload invalide — job rejeté')
      return
    }
    throw err
  }
  const { schemaName, employeeId, dateFrom, dateTo } = payload

  const dates = dateRangeInclusive(dateFrom, dateTo)

  const targets = employeeId
    ? await loadSingleTargetEmployee(schemaName, employeeId)
    : await loadActiveTargetEmployees(schemaName, dateFrom, dateTo)

  if (targets.length === 0) {
    logger.info({ jobId: job.id, schemaName, employeeId, dateFrom, dateTo }, 'attendance-evaluate: aucun employé cible — rien à faire')
    return
  }

  const { escalation: escalationConfig, fallbackSchedule } = await loadTenantConfig(schemaName)

  // Cache des jours fériés CI par année (évite de recalculer Pâques à chaque
  // date de la plage — `joursFeriesCI` est pure et déterministe).
  const holidaysByYear = new Map<number, Set<string>>()
  const isHolidayOn = (workDate: string): boolean => {
    const year = Number(workDate.slice(0, 4))
    let set = holidaysByYear.get(year)
    if (!set) { set = joursFeriesCI(year); holidaysByYear.set(year, set) }
    return set.has(workDate)
  }

  let totalDaysComputed = 0
  let totalWarnings = 0
  let totalSanctions = 0
  let failedEmployees = 0

  // Isolement des pannes : chaque employé est traité indépendamment — une
  // erreur pour l'un ne doit JAMAIS interrompre le traitement des autres.
  for (const targetEmployeeId of targets) {
    try {
      const result = await processEmployee(
        schemaName, targetEmployeeId, dates, fallbackSchedule, escalationConfig, isHolidayOn,
      )
      totalDaysComputed += result.daysComputed
      totalWarnings += result.warningsCreated
      totalSanctions += result.sanctionsCreated
    } catch (err) {
      failedEmployees += 1
      logger.error(
        { jobId: job.id, schemaName, employeeId: targetEmployeeId, err },
        'attendance-evaluate: échec pour un employé — traitement des autres employés poursuivi',
      )
    }
  }

  logger.info(
    {
      jobId: job.id, schemaName, employeeId, dateFrom, dateTo,
      employeesTargeted: targets.length, failedEmployees,
      daysComputed: totalDaysComputed, warningsCreated: totalWarnings, sanctionsCreated: totalSanctions,
    },
    'attendance-evaluate: évaluation terminée',
  )
}
