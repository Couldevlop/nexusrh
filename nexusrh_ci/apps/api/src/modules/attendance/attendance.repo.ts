/**
 * Badgeuse / Pointage — helpers d'accès données (repository).
 *
 * Couche DAO pure : aucune logique métier ici (le calcul de jour vit dans
 * `attendance.compute.ts`, l'escalade dans `attendance.escalation.ts`). Ce
 * fichier ne fait qu'exécuter des requêtes SQL paramétrées et mapper les
 * lignes vers les types métier de `attendance.types.ts`.
 *
 * SÉCURITÉ (transverse à tout le module)
 *  - Isolation tenant : CHAQUE requête est scopée `"${schema}"`. Le schema
 *    provient TOUJOURS du token JWT validé (`request.user.schemaName`), jamais
 *    du corps de la requête — c'est la responsabilité de l'appelant (route/job)
 *    de ne jamais passer un schema non validé à ces fonctions.
 *  - Zéro concaténation de valeur dans le SQL : toutes les valeurs (y compris
 *    `employeeMatchBy` fourni par l'admin dans `field_mapping`) transitent par
 *    des paramètres `$n`. La seule exception est le nom de COLONNE utilisé par
 *    `insertPunches` pour rapprocher un pointage d'un employé : il ne provient
 *    JAMAIS de `matchBy` interpolé directement, mais d'une résolution via
 *    `EMPLOYEE_MATCH_COLUMNS`, un allowlist figé de 3 entrées littérales.
 *  - `pool.query` ne SELECT jamais `auth_secret_enc` (secret des badgeuses) —
 *    ce fichier ne touche pas `attendance_devices`, réservé à un autre module.
 *
 * Convention d'erreurs de ce fichier (chaque fonction est `async` + try/catch,
 * cf. règle globale du dépôt) :
 *  - Fonctions de LECTURE (loadConfig, resolveEmployeeSchedule,
 *    loadDaysForEmployee, loadConsumedDates, countActiveWarnings) : une erreur
 *    DB est avalée et remplacée par une valeur neutre (null / [] / 0). C'est
 *    un choix délibéré : une lecture qui échoue ne doit jamais produire une
 *    escalade disciplinaire par erreur — l'absence de donnée est le repli le
 *    plus sûr pour l'employé.
 *  - Fonctions d'ÉCRITURE (upsertDay, insertWarning, insertSanctionDraft) :
 *    l'erreur est capturée puis re-levée (enrichie de contexte) — une écriture
 *    perdue silencieusement serait pire qu'une exception remontée à l'appelant
 *    (job / route), qui décide de la stratégie de retry/alerte.
 *  - `insertPunches` est un cas particulier : ingestion d'un LOT depuis une
 *    badgeuse externe non fiable. Chaque pointage est traité indépendamment
 *    (try/catch par itération) pour qu'un pointage invalide n'annule jamais
 *    les autres ; la fonction elle-même ne lève jamais.
 */
import type { Pool } from 'pg'
import type {
  AttendanceConfig,
  ComputedDay,
  DayStatus,
  EffectiveSchedule,
  FieldMapping,
  GeneratedWarning,
  NormalizedPunch,
} from './attendance.types.js'

// ── employeeMatchBy → colonne réelle (allowlist figé, OWASP A03) ───────────
//
// `employees` (schema-migrations.ts / provisioning.ts) n'a PAS de colonne
// `matricule` ni `badge_id`. La colonne fonctionnellement équivalente à
// « matricule » est `employee_number` (cf. `csv_export.matricule_source`
// dont le défaut est déjà `'employee_number'`). `badge_id` n'existe dans
// aucune table employés à ce jour : la valeur `null` documente cette absence
// et fait que `insertPunches` ignore silencieusement la résolution plutôt que
// d'interroger une colonne inexistante (qui lèverait une erreur SQL).
const EMPLOYEE_MATCH_COLUMNS: Readonly<Record<FieldMapping['employeeMatchBy'], string | null>> = Object.freeze({
  matricule: 'employee_number',
  email: 'email',
  badge_id: null,
})

/**
 * Résout `matchBy` vers un nom de colonne SQL littéral via l'allowlist figé.
 * Ne renvoie JAMAIS une valeur qui n'est pas l'une des constantes déclarées
 * ci-dessus — `matchBy` n'est jamais interpolé tel quel dans une requête (le
 * paramètre est typé `string` plutôt que l'union stricte pour rester
 * défensif face à une valeur non validée en amont, ex. `field_mapping` d'une
 * badgeuse mal configurée).
 */
function resolveMatchColumn(matchBy: string): string | null {
  if (matchBy === 'matricule' || matchBy === 'email' || matchBy === 'badge_id') {
    return EMPLOYEE_MATCH_COLUMNS[matchBy]
  }
  return null
}

/** Tronque une valeur `time`/`date` Postgres ('HH:MM:SS' ou Date) → 'HH:MM'. */
function toHHMM(t: string): string {
  return t.length >= 5 ? t.slice(0, 5) : t
}

/** Normalise une valeur `date` Postgres (Date ou string) → 'YYYY-MM-DD'. */
function toDateStr(v: string | Date): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

// ── loadConfig ───────────────────────────────────────────────────────────

interface AttendanceConfigRow {
  late_minutes_tier1: number
  occurrences_tier1: number
  late_minutes_tier2: number
  occurrences_tier2: number
  unjustified_absence_occurrences: number
  warnings_before_sanction: number
  window_mode: string
}

/**
 * Charge le singleton `attendance_config` du tenant (le plus récent si
 * plusieurs lignes existent — table conçue comme singleton mais on se protège
 * défensivement). Renvoie `null` si aucune ligne (l'appelant applique les
 * défauts) ou en cas d'erreur DB.
 */
export async function loadConfig(pool: Pool, schema: string): Promise<AttendanceConfig | null> {
  try {
    const res = await pool.query<AttendanceConfigRow>(
      `SELECT late_minutes_tier1, occurrences_tier1, late_minutes_tier2, occurrences_tier2,
              unjustified_absence_occurrences, warnings_before_sanction, window_mode
         FROM "${schema}".attendance_config
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    const row = res.rows[0]
    if (!row) return null
    return {
      lateMinutesTier1: row.late_minutes_tier1,
      occurrencesTier1: row.occurrences_tier1,
      lateMinutesTier2: row.late_minutes_tier2,
      occurrencesTier2: row.occurrences_tier2,
      unjustifiedAbsenceOccurrences: row.unjustified_absence_occurrences,
      warningsBeforeSanction: row.warnings_before_sanction,
      windowMode: row.window_mode as AttendanceConfig['windowMode'],
    }
  } catch {
    return null
  }
}

// ── resolveEmployeeSchedule ──────────────────────────────────────────────

export interface RawScheduleScopes {
  employee: EffectiveSchedule | null
  department: EffectiveSchedule | null
  tenant: EffectiveSchedule | null
}

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

/**
 * Charge les lignes actives de `attendance_schedules` pour les 3 portées
 * (employé / département / tenant) et les mappe vers `EffectiveSchedule`
 * pour alimenter `resolveSchedule` (attendance.schedule.ts, Task 5), qui
 * applique la cascade employé > département > tenant. `departmentId` peut
 * être `null` (employé sans département) — la portée département ne matchera
 * simplement aucune ligne dans ce cas.
 */
export async function resolveEmployeeSchedule(
  pool: Pool,
  schema: string,
  employeeId: string,
  departmentId: string | null,
): Promise<RawScheduleScopes> {
  const result: RawScheduleScopes = { employee: null, department: null, tenant: null }
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
      if (row.scope === 'employee' && !result.employee) result.employee = mapScheduleRow(row)
      else if (row.scope === 'department' && !result.department) result.department = mapScheduleRow(row)
      else if (row.scope === 'tenant' && !result.tenant) result.tenant = mapScheduleRow(row)
    }
    return result
  } catch {
    return result
  }
}

// ── insertPunches ─────────────────────────────────────────────────────────

export interface InsertPunchesResult {
  total: number
  matched: number
  inserted: number
}

/**
 * Insère un lot de pointages normalisés pour une badgeuse (`deviceId`), en
 * tentant de rapprocher chaque pointage d'un employé via `matchBy` (colonne
 * résolue par allowlist — voir `resolveMatchColumn`). Idempotent grâce à
 * `ON CONFLICT (device_id, dedup_key) DO NOTHING` (contrainte UNIQUE de
 * `attendance_punches`, cf. schema-migrations.ts).
 *
 * Ne lève jamais : chaque pointage est traité indépendamment (try/catch par
 * itération) — un pointage individuellement invalide (colonne de
 * rapprochement absente, valeur malformée…) ne doit jamais faire perdre les
 * autres pointages du même lot de synchronisation.
 */
export async function insertPunches(
  pool: Pool,
  schema: string,
  deviceId: string,
  punches: NormalizedPunch[],
  matchBy: FieldMapping['employeeMatchBy'],
): Promise<InsertPunchesResult> {
  const result: InsertPunchesResult = { total: punches.length, matched: 0, inserted: 0 }
  const matchColumn = resolveMatchColumn(matchBy)

  for (const punch of punches) {
    try {
      let employeeId: string | null = null
      if (matchColumn) {
        const match = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE ${matchColumn} = $1 LIMIT 1`,
          [punch.rawEmployeeRef],
        )
        employeeId = match.rows[0]?.id ?? null
      }
      if (employeeId) result.matched += 1

      const insert = await pool.query(
        `INSERT INTO "${schema}".attendance_punches
           (employee_id, raw_employee_ref, device_id, punched_at, direction, source, raw, dedup_key)
         VALUES ($1, $2, $3, $4, $5, 'device', $6, $7)
         ON CONFLICT (device_id, dedup_key) DO NOTHING`,
        [
          employeeId,
          punch.rawEmployeeRef,
          deviceId,
          punch.punchedAt,
          punch.direction,
          JSON.stringify(punch.raw ?? null),
          punch.dedupKey,
        ],
      )
      if ((insert.rowCount ?? 0) > 0) result.inserted += 1
    } catch {
      // Best-effort : pointage ignoré, le lot continue (badgeuse externe non fiable).
    }
  }

  return result
}

// ── upsertDay ────────────────────────────────────────────────────────────

export interface UpsertDayInput extends ComputedDay {
  employeeId: string
  /** Heure de début attendue au moment du calcul (traçabilité), optionnelle. */
  expectedStart?: string | null
}

/**
 * Insère ou recalcule (idempotent) le jour agrégé d'un employé, via
 * `ON CONFLICT (employee_id, work_date) DO UPDATE` (contrainte UNIQUE de
 * `attendance_days`). Permet de relancer le calcul d'un jour déjà traité
 * sans dupliquer de ligne.
 */
export async function upsertDay(pool: Pool, schema: string, day: UpsertDayInput): Promise<void> {
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
      [
        day.employeeId,
        day.workDate,
        day.firstIn,
        day.lastOut,
        day.expectedStart ?? null,
        day.lateMinutes,
        day.status,
        day.justifiedBy,
      ],
    )
  } catch (e) {
    throw new Error(`upsertDay a échoué (employee=${day.employeeId}, date=${day.workDate}) : ${(e as Error).message}`)
  }
}

// ── loadDaysForEmployee ──────────────────────────────────────────────────

interface DayRow {
  work_date: string | Date
  first_in: Date | null
  last_out: Date | null
  late_minutes: number
  status: DayStatus
  justified_by: string | null
}

/** Charge les jours calculés d'un employé sur une plage `[from, to]` incluse. */
export async function loadDaysForEmployee(
  pool: Pool,
  schema: string,
  employeeId: string,
  from: string,
  to: string,
): Promise<ComputedDay[]> {
  try {
    const res = await pool.query<DayRow>(
      `SELECT work_date, first_in, last_out, late_minutes, status, justified_by
         FROM "${schema}".attendance_days
        WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3
        ORDER BY work_date ASC`,
      [employeeId, from, to],
    )
    return res.rows.map((row) => ({
      workDate: toDateStr(row.work_date),
      firstIn: row.first_in,
      lastOut: row.last_out,
      lateMinutes: row.late_minutes,
      status: row.status,
      justifiedBy: row.justified_by,
    }))
  } catch {
    return []
  }
}

// ── loadConsumedDates ────────────────────────────────────────────────────

interface WarningTierRow {
  tier: string
  occurrence_dates: Array<string | Date> | null
}

/**
 * Agrège les `occurrence_dates` déjà consommées par palier, à partir de
 * `attendance_warnings.tier`.
 *
 * Bucketisation (documentée, alignée sur `attendance.escalation.ts`) : le
 * moteur d'escalade utilise deux buckets de dates consommées, `tier1` et
 * `tier2`, qui correspondent EXACTEMENT à la colonne `tier` stockée sur
 * l'avertissement :
 *  - `tier1` ← avertissements `tier = 'avertissement'` (couvre à la fois les
 *    retards de palier 1 ET les absences injustifiées : dans
 *    `evaluateEscalation`, les deux alimentent `newlyConsumed.tier1`) ;
 *  - `tier2` ← avertissements `tier = 'demande_explication'` (palier 2).
 * On peut donc dériver directement le bucket depuis `tier`, sans avoir besoin
 * de parser `trigger_reason`.
 */
export async function loadConsumedDates(
  pool: Pool,
  schema: string,
  employeeId: string,
): Promise<{ tier1: string[]; tier2: string[] }> {
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
  } catch {
    return { tier1: [], tier2: [] }
  }
}

// ── countActiveWarnings ──────────────────────────────────────────────────

/** Compte les avertissements en cours (non clos) d'un employé. */
export async function countActiveWarnings(pool: Pool, schema: string, employeeId: string): Promise<number> {
  try {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM "${schema}".attendance_warnings
        WHERE employee_id = $1 AND status IN ('active', 'contested')`,
      [employeeId],
    )
    return Number(res.rows[0]?.count ?? 0)
  } catch {
    return 0
  }
}

// ── insertWarning ────────────────────────────────────────────────────────

export interface InsertWarningInput extends GeneratedWarning {
  thresholdSnapshot?: unknown
  disciplinaryActionId?: string | null
}

/** Insère un avertissement (statut initial `active`). Renvoie l'id créé. */
export async function insertWarning(pool: Pool, schema: string, w: InsertWarningInput): Promise<string> {
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".attendance_warnings
         (employee_id, tier, trigger_reason, occurrence_dates, threshold_snapshot, disciplinary_action_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING id`,
      [
        w.employeeId,
        w.tier,
        w.triggerReason,
        w.occurrenceDates,
        w.thresholdSnapshot != null ? JSON.stringify(w.thresholdSnapshot) : null,
        w.disciplinaryActionId ?? null,
      ],
    )
    const id = res.rows[0]?.id
    if (!id) throw new Error('INSERT sans ligne retournée')
    return id
  } catch (e) {
    throw new Error(`insertWarning a échoué (employee=${w.employeeId}) : ${(e as Error).message}`)
  }
}

// ── insertSanctionDraft ──────────────────────────────────────────────────

export interface SanctionDraftInput {
  employeeId: string
  reason: string
  description?: string | null
  /** Auteur de la sanction (utilisateur RH) ; `null` si acteur système. */
  issuedBy?: string | null
}

/**
 * Insère un brouillon de sanction dans `disciplinary_actions` (table
 * inchangée — colonnes existantes uniquement) : `type='avertissement'`,
 * `status='draft'`, `action_date=CURRENT_DATE`. Renvoie l'id créé ; le
 * caller (module escalade) le reporte ensuite sur
 * `attendance_warnings.disciplinary_action_id`.
 */
export async function insertSanctionDraft(pool: Pool, schema: string, draft: SanctionDraftInput): Promise<string> {
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".disciplinary_actions
         (employee_id, type, reason, description, action_date, status, issued_by)
       VALUES ($1, 'avertissement', $2, $3, CURRENT_DATE, 'draft', $4)
       RETURNING id`,
      [draft.employeeId, draft.reason, draft.description ?? null, draft.issuedBy ?? null],
    )
    const id = res.rows[0]?.id
    if (!id) throw new Error('INSERT sans ligne retournée')
    return id
  } catch (e) {
    throw new Error(`insertSanctionDraft a échoué (employee=${draft.employeeId}) : ${(e as Error).message}`)
  }
}
