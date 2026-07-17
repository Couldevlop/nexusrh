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
import { loadConfig } from './attendance.repo.js'
import type { AttendanceConfig } from './attendance.types.js'

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
): void {
  pool
    .query(
      `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
       VALUES ($1, $2, 'attendance_config', $3, $4, $5)`,
      [userId ?? null, action, id, JSON.stringify(changes), ip],
    )
    .catch(() => { /* tenant sans audit_log : non bloquant */ })
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
      } catch (e) {
        return reply.status(500).send({ error: `Échec de mise à jour de la configuration : ${(e as Error).message}` })
      }
    },
  })
}
