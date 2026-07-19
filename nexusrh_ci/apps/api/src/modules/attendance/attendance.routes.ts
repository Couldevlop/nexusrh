/**
 * Badgeuse / Pointage — routes Fastify (prefix /attendance).
 *
 * Ce fichier ne couvre pour l'instant que la configuration du moteur
 * d'escalade (singleton `attendance_config`). Les routes badgeuses/plannings/
 * imports seront ajoutées dans des tâches ultérieures — le squelette du
 * plugin (hook `ensureTenantSchema`, `audit`) est déjà en place pour elles.
 *
 * SÉCURITÉ
 *  - OWASP A01 : configuration réservée à `admin` (paramétrage tenant).
 *  - OWASP A03 : validation Zod stricte (`.strict()`, rejette tout champ
 *    inconnu — pas d'assignation de masse) + bornes numériques sanes. Une
 *    config malformée ne doit jamais pouvoir désactiver silencieusement
 *    l'escalade (ex. `occurrences=0` déclencherait à chaque occurrence,
 *    `warningsBeforeSanction` négatif court-circuiterait le moteur).
 *  - OWASP A09 : chaque modification de config journalisée (audit_log),
 *    best-effort (un tenant sans `audit_log` ne doit jamais faire échouer
 *    la requête).
 *  - Isolation tenant : `schemaName` provient TOUJOURS du token JWT validé
 *    (`request.user.schemaName`), jamais du corps de la requête.
 *  - Module gate : la vérification `enabled_modules['attendance']` est faite
 *    globalement par le hook de `app.ts` (403 `moduleDisabled`) — ce plugin
 *    n'a pas à la reproduire.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { encrypt, decryptIfPresent } from '../../utils/crypto.js'
import { isSafeOutboundUrl } from '../../services/ssrf-guard.js'
import { fetchDevicePunches } from './attendance.fetch.js'
import { enqueuePoll } from './attendance.queue.js'
import { loadConfig, resolveEmployeeSchedule, upsertDay } from './attendance.repo.js'
import { computeDay } from './attendance.compute.js'
import { resolveSchedule } from './attendance.schedule.js'
import { joursFeriesCI } from '../../utils/ci-holidays.js'
import type { AttendanceConfig, EffectiveSchedule, FieldMapping, NormalizedPunch } from './attendance.types.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Défauts (identiques aux défauts DB — appliqués si aucune ligne n'existe) ─
const DEFAULT_CONFIG: AttendanceConfig & {
  defaultExpectedStart: string
  defaultToleranceMin: number
  defaultWorkdays: number[]
} = {
  lateMinutesTier1: 30,
  occurrencesTier1: 3,
  lateMinutesTier2: 60,
  occurrencesTier2: 3,
  unjustifiedAbsenceOccurrences: 1,
  warningsBeforeSanction: 2,
  windowMode: 'consecutive_or_month',
  defaultExpectedStart: '08:00',
  defaultToleranceMin: 10,
  defaultWorkdays: [1, 2, 3, 4, 5],
}

// ── Validation Zod ──────────────────────────────────────────────────────────
// Bornes sanes : chaque seuil qui alimente le moteur d'escalade
// (attendance.escalation.ts) doit rester strictement significatif — un
// `occurrences` à 0 déclencherait une escalade à la moindre occurrence, un
// délai négatif n'a pas de sens métier.
const HHMM = /^\d{2}:\d{2}$/

const configSchema = z.object({
  lateMinutesTier1: z.number().int().min(0).max(1440),
  occurrencesTier1: z.number().int().min(1).max(1000),
  lateMinutesTier2: z.number().int().min(0).max(1440),
  occurrencesTier2: z.number().int().min(1).max(1000),
  unjustifiedAbsenceOccurrences: z.number().int().min(1).max(1000),
  warningsBeforeSanction: z.number().int().min(1).max(1000),
  windowMode: z.literal('consecutive_or_month'),
  defaultExpectedStart: z.string().regex(HHMM, 'Format attendu HH:MM'),
  defaultToleranceMin: z.number().int().min(0).max(1440),
  defaultWorkdays: z
    .array(z.number().int().min(1).max(7))
    .min(1, 'Au moins un jour ouvré')
    .max(7),
}).strict()

// ── Audit (calqué sur discipline.routes.ts) ─────────────────────────────────
function audit(
  schema: string,
  userId: string | undefined,
  action: string,
  id: string | null,
  changes: Record<string, unknown>,
  ip: string | null,
  entity = 'attendance_config',
): void {
  pool
    .query(
      `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, action, entity, id, JSON.stringify(changes), ip],
    )
    .catch(() => { /* tenant sans audit_log : non bloquant */ })
}

// ── Notifications (calqué sur absences.routes.ts) ──────────────────────────
// `notifyUser` insère une notification pour UN destinataire (non bloquant :
// `.catch(()=>{})`, un tenant sans table `notifications` ou un `user_id`
// supprimé ne doit jamais faire échouer la requête). `userIdOfEmployee`
// résout le compte utilisateur lié à un employé (notifier l'EMPLOYÉ concerné
// par une décision RH) — miroir exact de `absences.routes.ts`.
function notifyUser(
  schema: string, userId: string | null | undefined, type: string,
  title: string, message: string, data: Record<string, unknown> = {},
): void {
  if (!userId) return
  pool.query(
    `INSERT INTO "${schema}".notifications (user_id, type, title, message, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, message, JSON.stringify(data)],
  ).catch(() => { /* tenant sans notifications / user supprimé : non bloquant */ })
}

/** Résout le user_id du compte lié à un employé (null si aucun). Calqué sur absences.routes.ts. */
async function userIdOfEmployee(schema: string, employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null
  try {
    const r = await pool.query<{ user_id: string | null }>(
      `SELECT user_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
    )
    return r?.rows?.[0]?.user_id ?? null
  } catch { return null }
}

// ── Validation Zod — badgeuses (attendance_devices) ─────────────────────────
// Calqué sur `integrations.routes.ts` (connectorBody) : même forme
// (base_url/auth_type/auth_secret/auth_header_name/default_headers), avec en
// plus `field_mapping` (extraction des pointages) et `poll_interval_min`.
const fieldMappingSchema = z.object({
  recordsPath: z.string().max(200).optional(),
  employeePath: z.string().max(200).optional(),
  employeeMatchBy: z.enum(['matricule', 'email', 'badge_id']).optional(),
  timestampPath: z.string().max(200).optional(),
  timestampFormat: z.string().max(50).optional(),
  directionPath: z.string().max(200).optional(),
  directionInValue: z.string().max(50).optional(),
  directionOutValue: z.string().max(50).optional(),
}).strict()

const deviceBody = z.object({
  name: z.string().min(1).max(150),
  base_url: z.string().url().max(2000),
  auth_type: z.enum(['none', 'bearer', 'basic', 'api_key']).optional(),
  auth_secret: z.string().max(2000).optional(),
  auth_header_name: z.string().max(80).optional(),
  default_headers: z.record(z.string().max(500)).optional(),
  field_mapping: fieldMappingSchema.optional(),
  poll_interval_min: z.number().int().min(1).max(1440).optional(),
  is_active: z.boolean().optional(),
}).strict()
const devicePatch = deviceBody.partial()

// ── Validation Zod — horaires de référence (attendance_schedules) ──────────
//
// CRITIQUE (fail-closed pour le moteur d'escalade) : `computeDay`
// (attendance.compute.ts, `thresholdInstant`) est DÉFENSIF par construction —
// un `expected_start` malformé qui échapperait à la validation d'écriture ne
// lève jamais côté calcul, il renvoie silencieusement `NaN` → `lateMinutes = 0`
// → statut `present`. Autrement dit une config horaire corrompue en base fait
// FAIL-OPEN le calcul de retard (un employé réellement en retard serait compté
// présent). Cette route est donc la SEULE frontière qui peut fermer ce trou :
// la validation ci-dessous doit rester stricte sur le format ET les bornes
// réelles de l'heure (HH:MM, 00-23:00-59) — pas seulement la forme `\d{2}:\d{2}`
// utilisée par `thresholdInstant`, qui laisserait passer '25:99'.
const HHMM_STRICT_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const scheduleScopeId = z.string().regex(UUID_RE, 'scope_id invalide (uuid attendu)').nullable().optional()
const scheduleTime = z.string().regex(HHMM_STRICT_RE, 'Format attendu HH:MM (heures 00-23, minutes 00-59)')
const scheduleWorkdays = z
  .array(z.number().int().min(1).max(7))
  .min(1, 'Au moins un jour ouvré')
  .max(7, 'Au plus 7 jours (1 par jour de la semaine)')
  .refine((arr) => new Set(arr).size === arr.length, { message: 'Jours dupliqués interdits dans workdays' })

/** Cohérence scope ↔ scope_id : requis pour department/employee, interdit pour tenant. */
function scopeConsistent(b: { scope: string; scope_id?: string | null }): boolean {
  if (b.scope === 'tenant') return b.scope_id === undefined || b.scope_id === null
  return b.scope_id !== undefined && b.scope_id !== null
}
const SCOPE_CONSISTENCY_MESSAGE =
  "scope_id est requis pour les portées 'department'/'employee' et doit être absent pour la portée 'tenant'"

const scheduleBody = z.object({
  scope: z.enum(['tenant', 'department', 'employee'], {
    errorMap: () => ({ message: "scope doit être 'tenant', 'department' ou 'employee'" }),
  }),
  scope_id: scheduleScopeId,
  expected_start: scheduleTime,
  expected_end: scheduleTime.nullable().optional(),
  tolerance_min: z.number().int().min(0).max(1440).optional(),
  workdays: scheduleWorkdays.optional(),
  is_active: z.boolean().optional(),
}).strict()
const scheduleCreate = scheduleBody.refine(scopeConsistent, {
  message: SCOPE_CONSISTENCY_MESSAGE,
  path: ['scope_id'],
})
const schedulePatch = z.object({
  scope: z.enum(['tenant', 'department', 'employee']).optional(),
  scope_id: scheduleScopeId,
  expected_start: scheduleTime.optional(),
  expected_end: scheduleTime.nullable().optional(),
  tolerance_min: z.number().int().min(0).max(1440).optional(),
  workdays: scheduleWorkdays.optional(),
  is_active: z.boolean().optional(),
}).strict()

interface AttendanceDeviceRow {
  base_url: string
  auth_type: string
  auth_secret_enc: string | null
  auth_header_name: string | null
  default_headers: Record<string, string> | null
  field_mapping: FieldMapping | null
  sync_cursor: string | null
}

interface AttendanceConfigExtraRow {
  default_expected_start: string
  default_tolerance_min: number
  default_workdays: number[]
}

/**
 * Charge les colonnes "défaut planning" (default_expected_start,
 * default_tolerance_min, default_workdays) qui ne sont pas couvertes par
 * `loadConfig` (Task 9, dédié aux seuils d'escalade). Renvoie `null` si
 * aucune ligne ou en cas d'erreur DB (repli : défauts appliqués par
 * l'appelant).
 */
async function loadConfigExtras(schema: string): Promise<AttendanceConfigExtraRow | null> {
  try {
    const res = await pool.query<AttendanceConfigExtraRow>(
      `SELECT default_expected_start, default_tolerance_min, default_workdays
         FROM "${schema}".attendance_config
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    return res.rows[0] ?? null
  } catch {
    return null
  }
}

// ── Helpers — pointages/jours/recompute (Task 13) ───────────────────────────

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
  } catch {
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
  } catch {
    return null
  }
}

/**
 * Résout le `department_id` d'un employé (pour la cascade d'horaires). Renvoie
 * `undefined` si l'employé n'existe pas dans CE tenant (isolation : un id qui
 * n'appartient pas au schéma courant n'aura simplement aucune ligne) — le
 * caller doit alors ignorer cet employé plutôt que de recalculer sur un
 * `department_id` nul par erreur.
 */
async function loadEmployeeDepartmentId(schema: string, employeeId: string): Promise<string | null | undefined> {
  try {
    const res = await pool.query<{ department_id: string | null }>(
      `SELECT department_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`,
      [employeeId],
    )
    if (!res.rows[0]) return undefined
    return res.rows[0].department_id
  } catch {
    return undefined
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

/** Plage récente par défaut ('YYYY-MM-DD' UTC) — utilisée par `/me` et `/dashboard` quand `from`/`to` sont absents. */
function recentRange(daysBack = 30): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - daysBack)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

/**
 * Résout l'id employé du compte APPELANT à partir du token (email) — JAMAIS
 * d'un paramètre de requête/corps. Même requête que le filtre manager de
 * `/punches`/`/days` (Task 13) : `SELECT id FROM employees WHERE email = $1`.
 * Renvoie `null` si aucun dossier employé n'est associé au compte.
 */
async function resolveSelfEmployeeId(schema: string, email: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email],
  )
  return r.rows[0]?.id ?? null
}

// ── Validation Zod — correction manuelle (POST /punches) ───────────────────
const manualPunchBody = z.object({
  employeeId: z.string().regex(UUID_RE, 'employeeId invalide (uuid attendu)'),
  direction: z.enum(['in', 'out', 'unknown'], {
    errorMap: () => ({ message: "direction doit être 'in', 'out' ou 'unknown'" }),
  }),
  punchedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'punchedAt doit être une date/heure ISO valide'),
  reason: z.string().max(500).optional(),
}).strict()

// ── Validation Zod — recalcul (POST /recompute) ─────────────────────────────
const recomputeBody = z.object({
  employeeIds: z.array(z.string().regex(UUID_RE, 'employeeIds doit contenir des UUID')).min(1).max(200),
  from: z.string().regex(DATE_RE, 'Format attendu YYYY-MM-DD'),
  to: z.string().regex(DATE_RE, 'Format attendu YYYY-MM-DD'),
}).strict().refine((d) => d.from <= d.to, {
  message: 'from doit être antérieur ou égal à to',
  path: ['to'],
})

// ── Validation Zod — avertissements (attendance_warnings, Task 14) ─────────
// `active` est le statut initial posé par le moteur d'escalade (hors périmètre
// de cette tâche) — PATCH RH ne peut faire transitionner QUE vers un statut
// de traitement (`explained`/`contested`/`closed`), jamais revenir à `active`
// ni accepter une valeur arbitraire (`.strict()` + `z.enum` fermé).
const WARNING_STATUSES = ['active', 'explained', 'contested', 'closed'] as const

const warningPatchBody = z.object({
  status: z.enum(['explained', 'contested', 'closed'], {
    errorMap: () => ({ message: "status doit être 'explained', 'contested' ou 'closed'" }),
  }),
}).strict()

const warningRespondBody = z.object({
  response: z.string()
    .min(1, 'La réponse ne peut pas être vide')
    .max(2000, 'Réponse trop longue (2000 caractères maximum)'),
}).strict()

export async function attendanceRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /attendance/config — configuration du moteur d'escalade (singleton).
  fastify.get('/config', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['attendance'], summary: 'Configuration Badgeuse / Pointage' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const base = await loadConfig(pool, schema)
      const extras = await loadConfigExtras(schema)
      const data = {
        lateMinutesTier1: base?.lateMinutesTier1 ?? DEFAULT_CONFIG.lateMinutesTier1,
        occurrencesTier1: base?.occurrencesTier1 ?? DEFAULT_CONFIG.occurrencesTier1,
        lateMinutesTier2: base?.lateMinutesTier2 ?? DEFAULT_CONFIG.lateMinutesTier2,
        occurrencesTier2: base?.occurrencesTier2 ?? DEFAULT_CONFIG.occurrencesTier2,
        unjustifiedAbsenceOccurrences:
          base?.unjustifiedAbsenceOccurrences ?? DEFAULT_CONFIG.unjustifiedAbsenceOccurrences,
        warningsBeforeSanction: base?.warningsBeforeSanction ?? DEFAULT_CONFIG.warningsBeforeSanction,
        windowMode: base?.windowMode ?? DEFAULT_CONFIG.windowMode,
        defaultExpectedStart: extras?.default_expected_start
          ? extras.default_expected_start.slice(0, 5)
          : DEFAULT_CONFIG.defaultExpectedStart,
        defaultToleranceMin: extras?.default_tolerance_min ?? DEFAULT_CONFIG.defaultToleranceMin,
        defaultWorkdays: extras?.default_workdays ?? DEFAULT_CONFIG.defaultWorkdays,
      }
      return reply.send({ data })
    },
  })

  // PUT /attendance/config — UPSERT du singleton (admin only, audité).
  fastify.put('/config', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['attendance'], summary: 'Mettre à jour la configuration Badgeuse / Pointage' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = configSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      try {
        const existing = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".attendance_config ORDER BY updated_at DESC LIMIT 1`,
        )
        let row: Record<string, unknown> | undefined
        if (existing.rows[0]) {
          const res = await pool.query(
            `UPDATE "${schema}".attendance_config SET
               late_minutes_tier1 = $1, occurrences_tier1 = $2,
               late_minutes_tier2 = $3, occurrences_tier2 = $4,
               unjustified_absence_occurrences = $5, warnings_before_sanction = $6,
               window_mode = $7, default_expected_start = $8, default_tolerance_min = $9,
               default_workdays = $10, updated_at = now()
             WHERE id = $11
             RETURNING *`,
            [
              body.lateMinutesTier1, body.occurrencesTier1,
              body.lateMinutesTier2, body.occurrencesTier2,
              body.unjustifiedAbsenceOccurrences, body.warningsBeforeSanction,
              body.windowMode, body.defaultExpectedStart, body.defaultToleranceMin,
              body.defaultWorkdays, existing.rows[0].id,
            ],
          )
          row = res.rows[0]
        } else {
          const res = await pool.query(
            `INSERT INTO "${schema}".attendance_config
               (late_minutes_tier1, occurrences_tier1, late_minutes_tier2, occurrences_tier2,
                unjustified_absence_occurrences, warnings_before_sanction, window_mode,
                default_expected_start, default_tolerance_min, default_workdays)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING *`,
            [
              body.lateMinutesTier1, body.occurrencesTier1,
              body.lateMinutesTier2, body.occurrencesTier2,
              body.unjustifiedAbsenceOccurrences, body.warningsBeforeSanction,
              body.windowMode, body.defaultExpectedStart, body.defaultToleranceMin,
              body.defaultWorkdays,
            ],
          )
          row = res.rows[0]
        }

        audit(schema, request.user.sub, 'attendance_config.updated', (row?.id as string) ?? null,
          body as Record<string, unknown>, request.ip ?? null)

        return reply.send({ data: row ?? body })
      } catch {
        return reply.status(500).send({ error: 'Échec de mise à jour de la configuration' })
      }
    },
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Badgeuses (attendance_devices) — CRUD + test de connexion + sync manuel
  //
  // SÉCURITÉ (transverse, crux du module) :
  //  - `base_url` passe TOUJOURS par la garde anti-SSRF (`isSafeOutboundUrl`,
  //    résolution DNS incluse) AVANT tout INSERT/UPDATE et avant tout appel
  //    réseau (`/test`) — jamais de court-circuit sur l'objet retourné.
  //  - Le secret d'authentification est chiffré (AES-256-GCM) en base
  //    (`auth_secret_enc`) et n'est JAMAIS renvoyé : GET/list n'exposent
  //    qu'un booléen `has_secret` ; `/test` déchiffre en mémoire pour l'appel
  //    sortant mais ne le renvoie jamais dans sa réponse.
  //  - `/sync` n'effectue AUCUN appel HTTP sortant synchrone : elle enfile un
  //    job BullMQ (`attendance-poll`) consommé par le worker (tâche ultérieure).
  // ═══════════════════════════════════════════════════════════════════════

  fastify.get('/devices', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['attendance'], summary: 'Lister les badgeuses configurées' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await pool.query(
        `SELECT id, name, base_url, auth_type, auth_header_name, default_headers, field_mapping,
                poll_enabled, poll_interval_min, last_sync_at, last_sync_status, is_active, created_at,
                (auth_secret_enc IS NOT NULL) AS has_secret
           FROM "${schema}".attendance_devices ORDER BY created_at DESC`,
      )
      return reply.send({ data: res.rows })
    },
  })

  fastify.post('/devices', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['attendance'], summary: 'Créer une badgeuse' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = deviceBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data

      const safe = await isSafeOutboundUrl(b.base_url)
      if (!safe.ok) return reply.status(422).send({ error: `URL refusée (SSRF) : ${safe.reason}` })

      try {
        const res = await pool.query<{ id: string }>(
          `INSERT INTO "${schema}".attendance_devices
             (name, base_url, auth_type, auth_secret_enc, auth_header_name, default_headers,
              field_mapping, poll_interval_min, is_active, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            b.name, b.base_url, b.auth_type ?? 'none', b.auth_secret ? encrypt(b.auth_secret) : null,
            b.auth_header_name ?? null, JSON.stringify(b.default_headers ?? {}),
            JSON.stringify(b.field_mapping ?? {}), b.poll_interval_min ?? 15, b.is_active ?? true,
            request.user.sub,
          ],
        )
        const id = res.rows[0]!.id
        audit(schema, request.user.sub, 'attendance.device.created', id,
          { name: b.name, base_url: b.base_url, auth_type: b.auth_type ?? 'none' }, request.ip ?? null,
          'attendance_device')
        return reply.status(201).send({ data: { id } })
      } catch {
        return reply.status(500).send({ error: 'Échec de création de la badgeuse' })
      }
    },
  })

  fastify.patch('/devices/:id', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['attendance'], summary: 'Modifier une badgeuse' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })

      const parsed = devicePatch.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data

      if (b.base_url !== undefined) {
        const safe = await isSafeOutboundUrl(b.base_url)
        if (!safe.ok) return reply.status(422).send({ error: `URL refusée (SSRF) : ${safe.reason}` })
      }

      const sets: string[] = []
      const vals: unknown[] = []
      let i = 1
      if (b.name !== undefined) { sets.push(`name = $${i++}`); vals.push(b.name) }
      if (b.base_url !== undefined) { sets.push(`base_url = $${i++}`); vals.push(b.base_url) }
      if (b.auth_type !== undefined) { sets.push(`auth_type = $${i++}`); vals.push(b.auth_type) }
      if (b.auth_secret !== undefined) {
        sets.push(`auth_secret_enc = $${i++}`)
        vals.push(b.auth_secret ? encrypt(b.auth_secret) : null)
      }
      if (b.auth_header_name !== undefined) { sets.push(`auth_header_name = $${i++}`); vals.push(b.auth_header_name) }
      if (b.default_headers !== undefined) { sets.push(`default_headers = $${i++}`); vals.push(JSON.stringify(b.default_headers)) }
      if (b.field_mapping !== undefined) { sets.push(`field_mapping = $${i++}`); vals.push(JSON.stringify(b.field_mapping)) }
      if (b.poll_interval_min !== undefined) { sets.push(`poll_interval_min = $${i++}`); vals.push(b.poll_interval_min) }
      if (b.is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(b.is_active) }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ' })
      sets.push('updated_at = now()')
      vals.push(id)

      try {
        const res = await pool.query(
          `UPDATE "${schema}".attendance_devices SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`,
          vals,
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Badgeuse introuvable' })
        // Trace d'audit COMPLÈTE des champs modifiés fournis — jamais la valeur du
        // secret (`auth_secret`) lui-même, seulement un booléen `secretChanged`.
        // OWASP A09 : `default_headers` peut contenir des API keys → logger seulement les clés,
        // jamais les valeurs (cf. ligne 392 : `default_headers_keys` au lieu de `default_headers`).
        const changes: Record<string, unknown> = {}
        if (b.name !== undefined) changes.name = b.name
        if (b.base_url !== undefined) changes.base_url = b.base_url
        if (b.auth_type !== undefined) changes.auth_type = b.auth_type
        if (b.auth_secret !== undefined) changes.secretChanged = true
        if (b.auth_header_name !== undefined) changes.auth_header_name = b.auth_header_name
        if (b.default_headers !== undefined) changes.default_headers_keys = Object.keys(b.default_headers)
        if (b.poll_interval_min !== undefined) changes.poll_interval_min = b.poll_interval_min
        if (b.is_active !== undefined) changes.is_active = b.is_active
        if (b.field_mapping !== undefined) changes.field_mapping = b.field_mapping
        audit(schema, request.user.sub, 'attendance.device.updated', id,
          changes, request.ip ?? null, 'attendance_device')
        return reply.send({ data: { id, updated: true } })
      } catch {
        return reply.status(500).send({ error: 'Échec de mise à jour de la badgeuse' })
      }
    },
  })

  fastify.delete('/devices/:id', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['attendance'], summary: 'Supprimer une badgeuse' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      try {
        const res = await pool.query(`DELETE FROM "${schema}".attendance_devices WHERE id = $1 RETURNING id`, [id])
        if (!res.rows[0]) return reply.status(404).send({ error: 'Badgeuse introuvable' })
        audit(schema, request.user.sub, 'attendance.device.deleted', id, {}, request.ip ?? null, 'attendance_device')
        return reply.send({ data: { id, deleted: true } })
      } catch {
        return reply.status(500).send({ error: 'Échec de suppression de la badgeuse' })
      }
    },
  })

  // Test de connexion : appelle réellement la badgeuse (frontière système externe
  // non fiable) mais ne renvoie qu'un résumé BORNÉ — jamais le secret déchiffré,
  // jamais la charge utile brute complète (peut contenir des données sensibles).
  fastify.post('/devices/:id/test', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['attendance'], summary: 'Tester la connexion à une badgeuse' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })

      const r = await pool.query<AttendanceDeviceRow>(
        `SELECT base_url, auth_type, auth_secret_enc, auth_header_name, default_headers, field_mapping, sync_cursor
           FROM "${schema}".attendance_devices WHERE id = $1 LIMIT 1`,
        [id],
      )
      const d = r.rows[0]
      if (!d) return reply.status(404).send({ error: 'Badgeuse introuvable' })

      // Défense en profondeur : la garde SSRF est déjà appliquée à l'intérieur de
      // `fetchDevicePunches` (Task 8), mais on la répète ici EXPLICITEMENT au niveau
      // de la route — miroir du gate POST/PATCH — pour ne jamais dépendre uniquement
      // du comportement interne d'un appelé et retourner un 422 homogène.
      const safe = await isSafeOutboundUrl(d.base_url)
      if (!safe.ok) return reply.code(422).send({ error: 'URL non autorisée (SSRF)', reason: safe.reason })

      const result = await fetchDevicePunches({
        baseUrl: d.base_url,
        authType: d.auth_type,
        authSecret: decryptIfPresent(d.auth_secret_enc),
        authHeaderName: d.auth_header_name,
        defaultHeaders: d.default_headers ?? {},
        fieldMapping: (d.field_mapping ?? {}) as FieldMapping,
        syncCursor: d.sync_cursor,
      })

      // Échantillon BORNÉ, débarrassé du champ `raw` (payload d'origine potentiellement
      // sensible) — seuls des champs déjà normalisés et sans risque sont renvoyés.
      const sample = result.punches.slice(0, 5).map((p) => ({
        rawEmployeeRef: p.rawEmployeeRef,
        punchedAt: p.punchedAt.toISOString(),
        direction: p.direction,
      }))

      audit(schema, request.user.sub, 'attendance.device.tested', id,
        { ok: result.ok, count: result.punches.length }, request.ip ?? null, 'attendance_device')

      return reply.send({
        data: { ok: result.ok, count: result.punches.length, sample, ...(result.error ? { error: result.error } : {}) },
      })
    },
  })

  // Sync manuel : n'effectue JAMAIS d'appel HTTP sortant dans le cycle de la
  // requête — enfile un job `attendance-poll` (BullMQ) traité par le worker.
  fastify.post('/devices/:id/sync', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['attendance'], summary: 'Déclencher une synchronisation manuelle' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })

      const r = await pool.query<{ id: string }>(
        `SELECT id FROM "${schema}".attendance_devices WHERE id = $1 LIMIT 1`, [id],
      )
      if (!r.rows[0]) return reply.status(404).send({ error: 'Badgeuse introuvable' })

      try {
        await enqueuePoll(schema, id)
      } catch {
        return reply.status(500).send({ error: 'Échec de mise en file de la synchronisation' })
      }

      audit(schema, request.user.sub, 'attendance.device.sync_requested', id, {}, request.ip ?? null, 'attendance_device')
      return reply.send({ data: { enqueued: true } })
    },
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Horaires de référence (attendance_schedules) — CRUD des surcharges
  // consommées par `resolveEmployeeSchedule` (attendance.repo.ts) puis
  // `resolveSchedule` (cascade employé > département > tenant).
  //
  // SÉCURITÉ (transverse, cf. bloc de commentaires au-dessus de `scheduleBody`) :
  //  - Admin-only ; isolation tenant via `request.user.schemaName` (jamais le
  //    corps de la requête) ; toutes les valeurs sont paramétrées ($n).
  //  - Validation Zod STRICTE (`.strict()` + regex horaire bornée + cohérence
  //    scope/scope_id via `.refine()`) : c'est un contrôle de sécurité/
  //    correction à part entière, la frontière d'écriture qui empêche une
  //    config corrompue de faire fail-open le calcul de retard en aval.
  //  - Unicité LOGIQUE (un seul horaire ACTIF par (scope, scope_id)) : pas de
  //    contrainte DB dédiée, vérifiée en base via SELECT dans le même
  //    handler que l'INSERT ; violation → 409 (choix documenté : on rejette
  //    plutôt que d'upsert-désactiver silencieusement l'ancien horaire, pour
  //    forcer un geste explicite de l'admin — cohérence avec les autres 409
  //    du dépôt).
  // ═══════════════════════════════════════════════════════════════════════

  fastify.get('/schedules', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['attendance'], summary: 'Lister les horaires de référence actifs (toutes portées)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(
          `SELECT id, scope, scope_id, expected_start, tolerance_min, expected_end, workdays,
                  is_active, created_at, updated_at
             FROM "${schema}".attendance_schedules
            WHERE is_active = true
            ORDER BY scope, created_at DESC`,
        )
        return reply.send({ data: res.rows })
      } catch {
        return reply.status(500).send({ error: 'Échec de récupération des horaires' })
      }
    },
  })

  fastify.post('/schedules', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['attendance'], summary: 'Créer un horaire de référence (surcharge de portée)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = scheduleCreate.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data
      const scopeId = b.scope_id ?? null

      try {
        // Unicité logique : un seul horaire ACTIF par (scope, scope_id). `IS NOT
        // DISTINCT FROM` traite NULL = NULL (portée tenant) comme une égalité.
        const dup = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".attendance_schedules
            WHERE is_active = true AND scope = $1 AND scope_id IS NOT DISTINCT FROM $2
            LIMIT 1`,
          [b.scope, scopeId],
        )
        if (dup.rows[0]) {
          return reply.status(409).send({
            error: 'Un horaire actif existe déjà pour cette portée (scope + scope_id). Désactivez-le ou modifiez-le avant d’en créer un nouveau.',
          })
        }

        const res = await pool.query<{ id: string }>(
          `INSERT INTO "${schema}".attendance_schedules
             (scope, scope_id, expected_start, tolerance_min, expected_end, workdays, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            b.scope, scopeId, b.expected_start, b.tolerance_min ?? 10,
            b.expected_end ?? null, b.workdays ?? [1, 2, 3, 4, 5], b.is_active ?? true,
          ],
        )
        const id = res.rows[0]!.id
        audit(schema, request.user.sub, 'attendance.schedule.created', id,
          { scope: b.scope, scope_id: scopeId, expected_start: b.expected_start, tolerance_min: b.tolerance_min ?? 10 },
          request.ip ?? null, 'attendance_schedule')
        return reply.status(201).send({ data: { id } })
      } catch {
        return reply.status(500).send({ error: "Échec de création de l'horaire" })
      }
    },
  })

  fastify.patch('/schedules/:id', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['attendance'], summary: 'Modifier un horaire de référence' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })

      const parsed = schedulePatch.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data

      try {
        // Cohérence scope/scope_id + unicité logique : ce n'est significatif
        // que si scope, scope_id OU is_active change dans ce PATCH (les trois
        // champs qui déterminent l'identité "un seul horaire ACTIF par
        // (scope, scope_id)"). On recharge l'état actuel pour valider l'état
        // RÉSULTANT (fusion patch + existant), jamais seulement le delta
        // fourni — sinon un PATCH partiel pourrait faire passer la ligne dans
        // un état incohérent (ex. scope='tenant' avec un scope_id hérité de
        // l'ancien scope='employee') OU, plus grave, contourner l'unicité
        // vérifiée au POST : réactiver un horaire désactivé (is_active
        // false→true) ou re-scoper un horaire déjà actif peut faire
        // coexister DEUX horaires actifs sur le même (scope, scope_id) —
        // `resolveEmployeeSchedule` choisirait alors silencieusement le plus
        // récemment modifié (dérive silencieuse de l'horaire qui alimente le
        // moteur d'escalade). D'où la ré-application, ICI, du même contrôle
        // que POST (SELECT + `IS NOT DISTINCT FROM`), en excluant la ligne
        // elle-même (`id <> $n`), à chaque fois que l'état résultant serait
        // actif.
        let nextScope: string | undefined = b.scope
        let nextScopeId: string | null | undefined = b.scope_id
        let nextIsActive: boolean | undefined = b.is_active

        if (b.scope !== undefined || b.scope_id !== undefined || b.is_active !== undefined) {
          const current = await pool.query<{ scope: string; scope_id: string | null; is_active: boolean }>(
            `SELECT scope, scope_id, is_active FROM "${schema}".attendance_schedules WHERE id = $1 LIMIT 1`,
            [id],
          )
          const row = current.rows[0]
          if (!row) return reply.status(404).send({ error: 'Horaire introuvable' })
          nextScope = b.scope ?? row.scope
          nextScopeId = b.scope_id !== undefined ? b.scope_id : row.scope_id
          nextIsActive = b.is_active !== undefined ? b.is_active : row.is_active

          if (!scopeConsistent({ scope: nextScope, scope_id: nextScopeId })) {
            return reply.status(400).send({ error: SCOPE_CONSISTENCY_MESSAGE })
          }

          if (nextIsActive) {
            const dup = await pool.query<{ id: string }>(
              `SELECT id FROM "${schema}".attendance_schedules
                WHERE is_active = true AND scope = $1 AND scope_id IS NOT DISTINCT FROM $2 AND id <> $3
                LIMIT 1`,
              [nextScope, nextScopeId ?? null, id],
            )
            if (dup.rows[0]) {
              return reply.status(409).send({
                error: 'Un horaire actif existe déjà pour cette portée (scope + scope_id). Désactivez-le ou modifiez-le avant de (ré)activer ou déplacer celui-ci.',
              })
            }
          }
        }

        const sets: string[] = []
        const vals: unknown[] = []
        let i = 1
        if (b.scope !== undefined) { sets.push(`scope = $${i++}`); vals.push(b.scope) }
        if (b.scope_id !== undefined) { sets.push(`scope_id = $${i++}`); vals.push(b.scope_id) }
        if (b.expected_start !== undefined) { sets.push(`expected_start = $${i++}`); vals.push(b.expected_start) }
        if (b.expected_end !== undefined) { sets.push(`expected_end = $${i++}`); vals.push(b.expected_end) }
        if (b.tolerance_min !== undefined) { sets.push(`tolerance_min = $${i++}`); vals.push(b.tolerance_min) }
        if (b.workdays !== undefined) { sets.push(`workdays = $${i++}`); vals.push(b.workdays) }
        if (b.is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(b.is_active) }
        if (!sets.length) return reply.status(400).send({ error: 'Aucun champ' })
        sets.push('updated_at = now()')
        vals.push(id)

        const res = await pool.query(
          `UPDATE "${schema}".attendance_schedules SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`,
          vals,
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Horaire introuvable' })
        audit(schema, request.user.sub, 'attendance.schedule.updated', id,
          b as Record<string, unknown>, request.ip ?? null, 'attendance_schedule')
        return reply.send({ data: { id, updated: true } })
      } catch {
        return reply.status(500).send({ error: "Échec de mise à jour de l'horaire" })
      }
    },
  })

  fastify.delete('/schedules/:id', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['attendance'], summary: 'Supprimer un horaire de référence' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      try {
        const res = await pool.query(
          `DELETE FROM "${schema}".attendance_schedules WHERE id = $1 RETURNING id`, [id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Horaire introuvable' })
        audit(schema, request.user.sub, 'attendance.schedule.deleted', id, {}, request.ip ?? null, 'attendance_schedule')
        return reply.send({ data: { id, deleted: true } })
      } catch {
        return reply.status(500).send({ error: "Échec de suppression de l'horaire" })
      }
    },
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Pointages / jours calculés / recalcul (Task 13)
  //
  // SÉCURITÉ (transverse) :
  //  - RBAC-équipe : les rôles RH (admin/hr_manager/hr_officer) voient tout le
  //    tenant ; `manager` est filtré en SQL (`e.manager_id = $n`, JAMAIS côté
  //    UI) sur SON équipe directe ; `employee`/`readonly` reçoivent 403 —
  //    l'espace self-service (`/attendance/me`) est une tâche ultérieure.
  //  - Un `manager` sans dossier employé associé (email non retrouvé) reçoit
  //    une liste VIDE, jamais l'ensemble du tenant (fail-closed, même
  //    stratégie que `absences.routes.ts`).
  //  - Correction manuelle (`POST /punches`) : `source='manual'`, `device_id`
  //    toujours NULL, toutes les valeurs paramétrées, employé vérifié dans LE
  //    tenant courant avant insertion (jamais un id d'un autre schéma).
  //  - Recalcul (`POST /recompute`) : intègre les services PURS déjà testés
  //    (`resolveEmployeeSchedule` + `resolveSchedule`, `computeDay`) — cette
  //    route ne réimplémente AUCUNE règle métier, elle assemble les entrées
  //    (pointages du jour, horaire effectif, jour férié CI, congé approuvé)
  //    et persiste via `upsertDay` (`ON CONFLICT … DO UPDATE`, idempotent :
  //    deux appels identiques produisent la même ligne `attendance_days`).
  //    Un employé sans aucun pointage ne fait jamais lever d'exception —
  //    `computeDay` renvoie `absent_justified`/`absent_unjustified`/`off`.
  // ═══════════════════════════════════════════════════════════════════════

  // GET /attendance/punches — RH : tout le tenant ; manager : son équipe directe.
  fastify.get('/punches', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager')],
    schema: { tags: ['attendance'], summary: 'Lister les pointages (RH : tous ; manager : son équipe)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId, from, to } = request.query as Record<string, string | undefined>

      if (employeeId && !UUID_RE.test(employeeId)) return reply.status(400).send({ error: 'employeeId invalide' })
      if (from && !DATE_RE.test(from)) return reply.status(400).send({ error: 'from invalide (YYYY-MM-DD attendu)' })
      if (to && !DATE_RE.test(to)) return reply.status(400).send({ error: 'to invalide (YYYY-MM-DD attendu)' })

      let sql = `SELECT p.id, p.employee_id, p.raw_employee_ref, p.device_id, p.punched_at,
                        p.direction, p.source, p.created_at
                   FROM "${schema}".attendance_punches p
                   LEFT JOIN "${schema}".employees e ON e.id = p.employee_id
                  WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (employeeId) { sql += ` AND p.employee_id = $${idx++}`; params.push(employeeId) }
      if (from) { sql += ` AND p.punched_at >= $${idx++}::date`; params.push(from) }
      if (to) { sql += ` AND p.punched_at < ($${idx++}::date + interval '1 day')`; params.push(to) }

      // RBAC-équipe : manager strictement limité à `e.manager_id = son propre id employé`.
      if (request.user.role === 'manager') {
        const emp = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email],
        )
        if (!emp.rows[0]) return reply.send({ data: [] }) // fail-closed
        sql += ` AND e.manager_id = $${idx++}`; params.push(emp.rows[0].id)
      }

      sql += ` ORDER BY p.punched_at DESC LIMIT 500`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch {
        return reply.status(500).send({ error: 'Échec de récupération des pointages' })
      }
    },
  })

  // POST /attendance/punches — correction manuelle (admin/hr_manager/hr_officer).
  fastify.post('/punches', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: { tags: ['attendance'], summary: 'Créer un pointage (correction manuelle)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = manualPunchBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data

      try {
        // Isolation tenant : on ne saisit un pointage QUE pour un employé du
        // schéma courant — un id valide mais appartenant à un autre tenant ne
        // matchera simplement aucune ligne ici.
        const emp = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [b.employeeId],
        )
        if (!emp.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })

        const punchedAt = new Date(b.punchedAt)
        const dedupKey = `manual|${b.employeeId}|${punchedAt.toISOString()}`

        const res = await pool.query<{ id: string }>(
          `INSERT INTO "${schema}".attendance_punches
             (employee_id, raw_employee_ref, device_id, punched_at, direction, source, raw, dedup_key)
           VALUES ($1, NULL, NULL, $2, $3, 'manual', $4, $5)
           RETURNING id`,
          [
            b.employeeId,
            punchedAt,
            b.direction,
            JSON.stringify({ enteredBy: request.user.sub, reason: b.reason ?? null }),
            dedupKey,
          ],
        )
        const id = res.rows[0]?.id ?? null

        audit(schema, request.user.sub, 'attendance.punch.manual_created', id, {
          employeeId: b.employeeId, direction: b.direction, punchedAt: punchedAt.toISOString(),
        }, request.ip ?? null, 'attendance_punch')

        return reply.status(201).send({
          data: { id, employeeId: b.employeeId, direction: b.direction, punchedAt: punchedAt.toISOString(), source: 'manual' },
        })
      } catch {
        return reply.status(500).send({ error: 'Échec de création du pointage' })
      }
    },
  })

  // GET /attendance/days — même RBAC-équipe que /punches.
  fastify.get('/days', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager')],
    schema: { tags: ['attendance'], summary: 'Lister les jours calculés (RH : tous ; manager : son équipe)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId, from, to } = request.query as Record<string, string | undefined>

      if (employeeId && !UUID_RE.test(employeeId)) return reply.status(400).send({ error: 'employeeId invalide' })
      if (from && !DATE_RE.test(from)) return reply.status(400).send({ error: 'from invalide (YYYY-MM-DD attendu)' })
      if (to && !DATE_RE.test(to)) return reply.status(400).send({ error: 'to invalide (YYYY-MM-DD attendu)' })

      let sql = `SELECT d.id, d.employee_id, d.work_date, d.first_in, d.last_out, d.expected_start,
                        d.late_minutes, d.status, d.justified_by, d.computed_at
                   FROM "${schema}".attendance_days d
                   JOIN "${schema}".employees e ON e.id = d.employee_id
                  WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (employeeId) { sql += ` AND d.employee_id = $${idx++}`; params.push(employeeId) }
      if (from) { sql += ` AND d.work_date >= $${idx++}`; params.push(from) }
      if (to) { sql += ` AND d.work_date <= $${idx++}`; params.push(to) }

      if (request.user.role === 'manager') {
        const emp = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email],
        )
        if (!emp.rows[0]) return reply.send({ data: [] }) // fail-closed
        sql += ` AND e.manager_id = $${idx++}`; params.push(emp.rows[0].id)
      }

      sql += ` ORDER BY d.work_date DESC LIMIT 500`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch {
        return reply.status(500).send({ error: 'Échec de récupération des jours' })
      }
    },
  })

  // POST /attendance/recompute — RH. Idempotent (ON CONFLICT DO UPDATE via upsertDay).
  fastify.post('/recompute', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: { tags: ['attendance'], summary: 'Recalculer les jours de présence (employé(s) + plage de dates)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = recomputeBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data
      const dates = dateRangeInclusive(b.from, b.to)
      if (dates.length > 366) {
        return reply.status(400).send({ error: 'Plage de dates trop large (maximum 366 jours)' })
      }

      // Repli tenant : si aucune ligne `attendance_schedules` de portée
      // 'tenant' n'existe, on utilise les défauts de `attendance_config`
      // (ou les défauts applicatifs si le tenant n'a pas encore de config).
      const extras = await loadConfigExtras(schema)
      const fallbackTenant: EffectiveSchedule = {
        expectedStart: extras?.default_expected_start
          ? extras.default_expected_start.slice(0, 5)
          : DEFAULT_CONFIG.defaultExpectedStart,
        toleranceMin: extras?.default_tolerance_min ?? DEFAULT_CONFIG.defaultToleranceMin,
        expectedEnd: null,
        workdays: extras?.default_workdays ?? DEFAULT_CONFIG.defaultWorkdays,
      }

      // Cache des jours fériés CI par année (évite de recalculer Pâques à
      // chaque date de la plage — `joursFeriesCI` est pure et déterministe).
      const holidaysByYear = new Map<number, Set<string>>()
      const isHolidayOn = (workDate: string): boolean => {
        const year = Number(workDate.slice(0, 4))
        let set = holidaysByYear.get(year)
        if (!set) { set = joursFeriesCI(year); holidaysByYear.set(year, set) }
        return set.has(workDate)
      }

      let recomputed = 0
      try {
        for (const employeeId of b.employeeIds) {
          const departmentId = await loadEmployeeDepartmentId(schema, employeeId)
          // Isolation tenant : employé introuvable dans CE schéma → ignoré (jamais d'erreur).
          if (departmentId === undefined) continue

          const rawScopes = await resolveEmployeeSchedule(pool, schema, employeeId, departmentId)
          const schedule = resolveSchedule({
            employee: rawScopes.employee,
            department: rawScopes.department,
            tenant: rawScopes.tenant ?? fallbackTenant,
          })

          for (const workDate of dates) {
            const punches = await loadPunchesForDate(schema, employeeId, workDate)
            const approvedLeaveId = await loadApprovedLeaveId(schema, employeeId, workDate)
            const computed = computeDay({
              workDate,
              punches,
              schedule,
              isHoliday: isHolidayOn(workDate),
              approvedLeaveId,
            })
            await upsertDay(pool, schema, { ...computed, employeeId, expectedStart: schedule.expectedStart })
            recomputed += 1
          }
        }
      } catch {
        return reply.status(500).send({ error: 'Échec du recalcul' })
      }

      audit(schema, request.user.sub, 'attendance.recompute', null, {
        employeeIds: b.employeeIds, from: b.from, to: b.to, recomputed,
      }, request.ip ?? null, 'attendance_days')

      return reply.send({ data: { recomputed } })
    },
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Task 14 — Avertissements RH + self-service employé + dashboard
  //
  // SÉCURITÉ (transverse, crux de cette tâche) :
  //  - `/warnings` (RH) suit EXACTEMENT le RBAC-équipe de `/punches`/`/days` :
  //    admin/hr_manager/hr_officer voient tout le tenant, `manager` est filtré
  //    SQL (`e.manager_id = son propre id employé`), employee/readonly → 403
  //    (ils utilisent `/me/warnings`).
  //  - `/me`, `/me/warnings` : l'id employé de l'appelant est TOUJOURS résolu
  //    depuis le token (`resolveSelfEmployeeId`, email du JWT) — jamais d'un
  //    paramètre de requête. Un `employeeId` glissé en querystring est
  //    silencieusement ignoré (la route ne le lit même pas). Aucun dossier
  //    employé associé → 404 (fail-closed, jamais les données d'un tiers).
  //  - `POST /me/warnings/:id/respond` (IDOR, OWASP A01) : l'avertissement
  //    DOIT appartenir à l'employé appelant. Introuvable OU appartenant à un
  //    autre employé → LE MÊME 404 générique (jamais 403, jamais de message
  //    qui distinguerait les deux cas) — ne révèle jamais l'existence d'un
  //    avertissement d'un tiers. Aucun UPDATE n'est exécuté avant cette
  //    vérification.
  //  - `PATCH /warnings/:id` réservé RH (admin/hr_manager/hr_officer) —
  //    manager et employee → 403.
  //  - Notifications bidirectionnelles (best-effort, non bloquantes) : RH
  //    change le statut → notifie l'EMPLOYÉ concerné (`userIdOfEmployee` +
  //    `notifyUser`) ; l'employé répond → notifie les comptes RH du tenant
  //    (`role IN ('admin','hr_manager','hr_officer')`, calqué sur
  //    `notifyAdminsMmFailure` de mobile-money.routes.ts).
  //  - Erreurs DB : message générique en français (jamais `(e as Error).message`
  //    interpolé dans la réponse client) — anticipe le nettoyage transverse
  //    des messages d'erreur bruts.
  // ═══════════════════════════════════════════════════════════════════════

  // GET /attendance/warnings — RH : tout le tenant ; manager : son équipe directe.
  fastify.get('/warnings', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager')],
    schema: { tags: ['attendance'], summary: 'Lister les avertissements (RH : tous ; manager : son équipe)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId, status } = request.query as Record<string, string | undefined>

      if (employeeId && !UUID_RE.test(employeeId)) return reply.status(400).send({ error: 'employeeId invalide' })
      if (status && !WARNING_STATUSES.includes(status as typeof WARNING_STATUSES[number])) {
        return reply.status(400).send({ error: `status doit être l'un de : ${WARNING_STATUSES.join(', ')}` })
      }

      let sql = `SELECT w.id, w.employee_id, w.tier, w.trigger_reason, w.occurrence_dates, w.status,
                        w.employee_response, w.responded_at, w.disciplinary_action_id, w.created_at
                   FROM "${schema}".attendance_warnings w
                   LEFT JOIN "${schema}".employees e ON e.id = w.employee_id
                  WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (employeeId) { sql += ` AND w.employee_id = $${idx++}`; params.push(employeeId) }
      if (status) { sql += ` AND w.status = $${idx++}`; params.push(status) }

      // RBAC-équipe : manager strictement limité à `e.manager_id = son propre id employé`.
      if (request.user.role === 'manager') {
        const emp = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email],
        )
        if (!emp.rows[0]) return reply.send({ data: [] }) // fail-closed
        sql += ` AND e.manager_id = $${idx++}`; params.push(emp.rows[0].id)
      }

      sql += ' ORDER BY w.created_at DESC LIMIT 500'
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch {
        return reply.status(500).send({ error: 'Échec de récupération des avertissements' })
      }
    },
  })

  // PATCH /attendance/warnings/:id — RH uniquement. Notifie l'employé concerné.
  fastify.patch('/warnings/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: { tags: ['attendance'], summary: "Changer le statut d'un avertissement (RH)" },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })

      const parsed = warningPatchBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data

      try {
        const res = await pool.query<{ id: string; employee_id: string }>(
          `UPDATE "${schema}".attendance_warnings SET status = $1 WHERE id = $2 RETURNING id, employee_id`,
          [b.status, id],
        )
        const row = res.rows[0]
        if (!row) return reply.status(404).send({ error: 'Avertissement introuvable' })

        audit(schema, request.user.sub, 'attendance.warning.status_updated', id,
          { status: b.status }, request.ip ?? null, 'attendance_warning')

        // Notifie l'employé concerné (non bloquant : `userIdOfEmployee`/`notifyUser`
        // renvoient/no-opent silencieusement si le lien compte est absent).
        const uid = await userIdOfEmployee(schema, row.employee_id)
        notifyUser(schema, uid, 'attendance_warning_status', 'Mise à jour de votre avertissement',
          `Le statut de votre avertissement de présence a été mis à jour : ${b.status}.`,
          { warningId: id, status: b.status })

        return reply.send({ data: { id, status: b.status, updated: true } })
      } catch {
        return reply.status(500).send({ error: "Échec de mise à jour de l'avertissement" })
      }
    },
  })

  // GET /attendance/me — mes pointages + jours calculés (self-service, plage récente).
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['attendance'], summary: 'Mes pointages et jours calculés (self-service)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const employeeId = await resolveSelfEmployeeId(schema, request.user.email)
      if (!employeeId) {
        return reply.status(404).send({ error: 'Aucun dossier employé associé à ce compte.' })
      }

      // Note : `employeeId` n'est JAMAIS lu depuis `request.query` — seuls
      // `from`/`to` (plage de dates) le sont, l'identité vient exclusivement du token.
      const { from, to } = request.query as Record<string, string | undefined>
      if (from && !DATE_RE.test(from)) return reply.status(400).send({ error: 'from invalide (YYYY-MM-DD attendu)' })
      if (to && !DATE_RE.test(to)) return reply.status(400).send({ error: 'to invalide (YYYY-MM-DD attendu)' })
      const range = recentRange()
      const effFrom = from ?? range.from
      const effTo = to ?? range.to

      try {
        const punches = await pool.query(
          `SELECT id, employee_id, raw_employee_ref, device_id, punched_at, direction, source, created_at
             FROM "${schema}".attendance_punches
            WHERE employee_id = $1 AND punched_at >= $2::date AND punched_at < ($3::date + interval '1 day')
            ORDER BY punched_at DESC LIMIT 500`,
          [employeeId, effFrom, effTo],
        )
        const days = await pool.query(
          `SELECT id, employee_id, work_date, first_in, last_out, expected_start, late_minutes, status, justified_by, computed_at
             FROM "${schema}".attendance_days
            WHERE employee_id = $1 AND work_date >= $2 AND work_date <= $3
            ORDER BY work_date DESC LIMIT 500`,
          [employeeId, effFrom, effTo],
        )
        return reply.send({ data: { punches: punches.rows, days: days.rows, from: effFrom, to: effTo } })
      } catch {
        return reply.status(500).send({ error: 'Échec de récupération de vos données de présence' })
      }
    },
  })

  // GET /attendance/me/warnings — mes avertissements uniquement (self-service).
  fastify.get('/me/warnings', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['attendance'], summary: 'Mes avertissements de présence (self-service)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const employeeId = await resolveSelfEmployeeId(schema, request.user.email)
      if (!employeeId) {
        return reply.status(404).send({ error: 'Aucun dossier employé associé à ce compte.' })
      }

      const { status } = request.query as Record<string, string | undefined>
      if (status && !WARNING_STATUSES.includes(status as typeof WARNING_STATUSES[number])) {
        return reply.status(400).send({ error: `status doit être l'un de : ${WARNING_STATUSES.join(', ')}` })
      }

      let sql = `SELECT id, employee_id, tier, trigger_reason, occurrence_dates, status,
                        employee_response, responded_at, disciplinary_action_id, created_at
                   FROM "${schema}".attendance_warnings
                  WHERE employee_id = $1`
      const params: unknown[] = [employeeId]
      if (status) { sql += ' AND status = $2'; params.push(status) }
      sql += ' ORDER BY created_at DESC LIMIT 500'

      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch {
        return reply.status(500).send({ error: 'Échec de récupération de vos avertissements' })
      }
    },
  })

  // POST /attendance/me/warnings/:id/respond — l'employé répond à SA demande
  // d'explication. IDOR (A01) : l'avertissement doit lui appartenir → sinon 404
  // générique (identique au cas "introuvable"), aucun UPDATE exécuté avant.
  fastify.post('/me/warnings/:id/respond', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['attendance'], summary: 'Répondre à mon avertissement (self-service)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })

      const parsed = warningRespondBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const b = parsed.data

      const employeeId = await resolveSelfEmployeeId(schema, request.user.email)
      // Aucun dossier employé associé : même 404 générique que "introuvable"
      // (jamais de distinction qui laisserait deviner qu'un compte est valide).
      if (!employeeId) return reply.status(404).send({ error: 'Avertissement introuvable' })

      try {
        const cur = await pool.query<{ id: string; employee_id: string; tier: string }>(
          `SELECT id, employee_id, tier FROM "${schema}".attendance_warnings WHERE id = $1 LIMIT 1`, [id],
        )
        const warning = cur.rows[0]
        // OWASP A01 (IDOR) — introuvable OU appartenant à un autre employé :
        // STRICTEMENT le même 404, jamais 403 (ne révèle pas l'existence).
        if (!warning || warning.employee_id !== employeeId) {
          return reply.status(404).send({ error: 'Avertissement introuvable' })
        }

        const res = await pool.query<{ id: string; employee_response: string; responded_at: string }>(
          `UPDATE "${schema}".attendance_warnings
              SET employee_response = $1, responded_at = now()
            WHERE id = $2
          RETURNING id, employee_response, responded_at`,
          [b.response, id],
        )

        audit(schema, request.user.sub, 'attendance.warning.responded', id,
          { employeeId }, request.ip ?? null, 'attendance_warning')

        // Notifie les comptes RH du tenant (non bloquant — un échec de notification
        // ne doit jamais faire échouer la réponse déjà enregistrée). Calqué sur
        // `notifyAdminsMmFailure` (mobile-money.routes.ts).
        try {
          const rh = await pool.query<{ id: string }>(
            `SELECT id FROM "${schema}".users WHERE role IN ('admin','hr_manager','hr_officer') AND is_active = true`,
          )
          for (const u of rh.rows) {
            notifyUser(schema, u.id, 'attendance_warning_response', 'Réponse à un avertissement',
              "Un employé a répondu à un avertissement de présence — à consulter.",
              { warningId: id, employeeId })
          }
        } catch { /* non bloquant : la réponse de l'employé est déjà enregistrée */ }

        return reply.send({ data: res.rows[0] })
      } catch {
        return reply.status(500).send({ error: 'Échec de l’enregistrement de votre réponse' })
      }
    },
  })

  // GET /attendance/dashboard — KPIs agrégés (RH : tout le tenant ; manager : son équipe).
  fastify.get('/dashboard', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager')],
    schema: { tags: ['attendance'], summary: 'Indicateurs Badgeuse / Pointage (agrégés)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { from, to } = request.query as Record<string, string | undefined>
      if (from && !DATE_RE.test(from)) return reply.status(400).send({ error: 'from invalide (YYYY-MM-DD attendu)' })
      if (to && !DATE_RE.test(to)) return reply.status(400).send({ error: 'to invalide (YYYY-MM-DD attendu)' })
      const range = recentRange()
      const effFrom = from ?? range.from
      const effTo = to ?? range.to

      const params: unknown[] = [effFrom, effTo]
      let mgrFilter = ''

      // RBAC-équipe : manager strictement limité à `e.manager_id = son propre id employé`.
      if (request.user.role === 'manager') {
        const emp = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email],
        )
        if (!emp.rows[0]) {
          // fail-closed : jamais les KPIs de tout le tenant sans dossier employé.
          return reply.send({
            data: { lateDays: 0, absentDays: 0, activeWarnings: 0, pendingExplanations: 0, sanctionDrafts: 0, from: effFrom, to: effTo },
          })
        }
        params.push(emp.rows[0].id)
        mgrFilter = ' AND e.manager_id = $3'
      }

      const sql = `SELECT
          (SELECT COUNT(*)::int FROM "${schema}".attendance_days d JOIN "${schema}".employees e ON e.id = d.employee_id
            WHERE d.status = 'late' AND d.work_date BETWEEN $1 AND $2${mgrFilter}) AS late_days,
          (SELECT COUNT(*)::int FROM "${schema}".attendance_days d JOIN "${schema}".employees e ON e.id = d.employee_id
            WHERE d.status IN ('absent_unjustified','absent_justified') AND d.work_date BETWEEN $1 AND $2${mgrFilter}) AS absent_days,
          (SELECT COUNT(*)::int FROM "${schema}".attendance_warnings w JOIN "${schema}".employees e ON e.id = w.employee_id
            WHERE w.status = 'active' AND w.created_at::date BETWEEN $1 AND $2${mgrFilter}) AS active_warnings,
          (SELECT COUNT(*)::int FROM "${schema}".attendance_warnings w JOIN "${schema}".employees e ON e.id = w.employee_id
            WHERE w.tier = 'demande_explication' AND w.status = 'active' AND w.created_at::date BETWEEN $1 AND $2${mgrFilter}) AS pending_explanations,
          (SELECT COUNT(*)::int FROM "${schema}".disciplinary_actions s JOIN "${schema}".employees e ON e.id = s.employee_id
            WHERE s.status = 'draft' AND s.created_at::date BETWEEN $1 AND $2${mgrFilter}) AS sanction_drafts`

      try {
        const res = await pool.query<{
          late_days: number; absent_days: number; active_warnings: number
          pending_explanations: number; sanction_drafts: number
        }>(sql, params)
        const row = res.rows[0]
        return reply.send({
          data: {
            lateDays: row?.late_days ?? 0,
            absentDays: row?.absent_days ?? 0,
            activeWarnings: row?.active_warnings ?? 0,
            pendingExplanations: row?.pending_explanations ?? 0,
            sanctionDrafts: row?.sanction_drafts ?? 0,
            from: effFrom, to: effTo,
          },
        })
      } catch {
        return reply.status(500).send({ error: 'Échec de récupération des indicateurs' })
      }
    },
  })
}
