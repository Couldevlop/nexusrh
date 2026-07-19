/**
 * Job worker : poll des badgeuses tenant (Task 16, module Badgeuse / Pointage).
 *
 * Reçoit `{ schemaName, deviceId }` (enfilé par
 * `apps/api/src/modules/attendance/attendance.queue.ts`, route manuelle
 * `POST /attendance/devices/:id/sync`, ou un futur scheduler périodique).
 * Charge la config de connexion de la badgeuse, récupère les pointages
 * récents via un appel HTTP sortant sécurisé, les insère (dédupliqués),
 * avance le curseur de synchronisation, puis enfile un job
 * `attendance-evaluate` pour recalculer les jours affectés.
 *
 * RÉUTILISATION — ce module NE PEUT PAS importer depuis `apps/api` :
 * `@nexusrhci/worker` (ce package) n'a AUCUNE dépendance vers `@nexusrhci/api`
 * dans son `package.json`, son `tsconfig.json` a `rootDir: "./src"` (toute
 * importation hors du package casserait le build), et aucun job existant du
 * worker (legal-watch.ts, cnps.ts, payroll.ts…) n'importe depuis l'API — ils
 * sont tous auto-suffisants. La logique de `attendance.fetch.ts` /
 * `attendance.mapping.ts` / `ssrf-guard.ts` / `utils/crypto.ts` (apps/api)
 * est donc RÉIMPLÉMENTÉE ICI À L'IDENTIQUE plutôt qu'importée, avec les
 * MÊMES garanties de sécurité :
 *  - garde SSRF (`../utils/ssrf-guard.js`, copie de `services/ssrf-guard.ts`)
 *    exécutée AVANT tout `fetch`, résultat `.ok` vérifié explicitement ;
 *  - secret déchiffré AES-256-GCM (`../utils/crypto.js`, copie de
 *    `utils/crypto.ts`) juste avant l'appel HTTP, jamais loggé ;
 *  - timeout borné (`AbortSignal.timeout(15000)`), `redirect: 'manual'` ;
 *  - auth par `auth_type` (bearer/basic/api_key/none) ;
 *  - mapping des champs bruts → pointages normalisés via `field_mapping`
 *    (mêmes chemins pointés, même résolution anti-prototype-pollution) ;
 *  - rapprochement employé via un ALLOWLIST FIGÉ de 3 colonnes (jamais
 *    `employeeMatchBy` interpolé tel quel dans le SQL), identique à
 *    `attendance.repo.ts::EMPLOYEE_MATCH_COLUMNS`.
 *
 * CONTRAT DE CURSEUR (impératif) : après une synchronisation réussie,
 * `sync_cursor` est réglé sur le `punchedAt.toISOString()` du pointage LE
 * PLUS RÉCENT du lot tiré. C'est EXACTEMENT le format que
 * `filterBySyncCursor` (ci-dessous, miroir de `attendance.fetch.ts`) attend
 * pour ne garder que les pointages plus récents au prochain poll — toute
 * autre valeur dégraderait silencieusement le filtrage vers « aucun
 * filtrage ». En cas d'échec, le curseur n'est JAMAIS avancé.
 *
 * OWASP :
 *  - A01/A03 : payload validé (schemaName/deviceId) AVANT toute requête DB.
 *  - A02 : secret déchiffré au dernier moment, jamais loggé/exposé.
 *  - A10 : garde SSRF obligatoire avant tout appel sortant.
 *  - Isolement des pannes : une badgeuse injoignable ne doit JAMAIS faire
 *    planter le worker ni affecter les autres badgeuses/tenants — toute
 *    erreur est capturée, journalisée, et la fonction retourne normalement.
 */
import type { Job } from 'bullmq'
import { Pool } from 'pg'
import { Queue } from 'bullmq'
import { createClient } from '../redis.js'
import { logger } from '../logger.js'
import { parseAttendancePollPayload, JobValidationError } from '../schemas.js'
import { resolveSafeOutboundResult } from '../utils/ssrf-guard.js'
import { readJsonCapped, BodyTooLargeError } from '../utils/http-body-limit.js'
import { decryptIfPresent } from '../utils/crypto.js'

// OWASP A04 — cap connexions PG (chaque poll fait quelques requêtes courtes ;
// 5 connexions suffisent et évitent de saturer le pool DB partagé).
const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })

const FETCH_TIMEOUT_MS = 15_000
/** OWASP A10 — cap mémoire de la réponse badgeuse (lecture bornée en flux). */
const MAX_BODY_BYTES = 5_000_000

// ── Types (miroir de attendance.types.ts — non partagés entre packages) ────

type PunchDirection = 'in' | 'out' | 'unknown'

interface NormalizedPunch {
  rawEmployeeRef: string
  punchedAt: Date
  direction: PunchDirection
  dedupKey: string
  raw: unknown
}

interface FieldMapping {
  recordsPath?: string
  employeePath: string
  employeeMatchBy: 'matricule' | 'email' | 'badge_id'
  timestampPath: string
  timestampFormat: 'iso8601' | 'epoch_s' | 'epoch_ms' | string
  directionPath?: string
  directionInValue?: string
  directionOutValue?: string
}

// ── Mapping badgeuse → pointages normalisés (miroir attendance.mapping.ts) ─

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function getByPath(obj: unknown, path: string): unknown {
  if (typeof path !== 'string' || path.length === 0) return undefined
  const segments = path.split('.')
  let current: unknown = obj
  for (const segment of segments) {
    if (segment.length === 0 || FORBIDDEN_KEYS.has(segment)) return undefined
    if (current === null || typeof current !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function parseTimestamp(v: unknown, format: string): Date | null {
  try {
    if (v === null || v === undefined) return null
    let date: Date
    if (format === 'iso8601') {
      date = new Date(v as string | number)
    } else if (format === 'epoch_s') {
      const n = Number(v)
      if (Number.isNaN(n)) return null
      date = new Date(n * 1000)
    } else if (format === 'epoch_ms') {
      const n = Number(v)
      if (Number.isNaN(n)) return null
      date = new Date(n)
    } else {
      date = new Date(v as string | number)
    }
    if (Number.isNaN(date.getTime())) return null
    return date
  } catch {
    return null
  }
}

function resolveDirection(record: unknown, mapping: FieldMapping): PunchDirection {
  if (!mapping.directionPath) return 'unknown'
  const raw = getByPath(record, mapping.directionPath)
  if (raw === undefined || raw === null) return 'unknown'
  const value = String(raw)
  if (mapping.directionInValue !== undefined && value === mapping.directionInValue) return 'in'
  if (mapping.directionOutValue !== undefined && value === mapping.directionOutValue) return 'out'
  return 'unknown'
}

/**
 * Transforme une réponse brute (JSON) de badgeuse en pointages normalisés.
 * Frontière de parsing pour des données EXTERNES NON FIABLES : un
 * enregistrement malformé est simplement ignoré, cette fonction ne lève
 * JAMAIS d'exception.
 */
function mapDeviceResponse(body: unknown, mapping: FieldMapping): NormalizedPunch[] {
  try {
    const records = mapping.recordsPath ? getByPath(body, mapping.recordsPath) : body
    if (!Array.isArray(records)) return []

    const punches: NormalizedPunch[] = []
    for (const record of records) {
      try {
        if (record === null || typeof record !== 'object') continue

        const rawEmployeeRefValue = getByPath(record, mapping.employeePath)
        if (rawEmployeeRefValue === undefined || rawEmployeeRefValue === null) continue
        const rawEmployeeRef = String(rawEmployeeRefValue)

        const rawTimestamp = getByPath(record, mapping.timestampPath)
        const punchedAt = parseTimestamp(rawTimestamp, mapping.timestampFormat)
        if (punchedAt === null) continue

        const direction = resolveDirection(record, mapping)
        const dedupKey = `${rawEmployeeRef}|${punchedAt.toISOString()}`

        punches.push({ rawEmployeeRef, punchedAt, direction, dedupKey, raw: record })
      } catch {
        continue
      }
    }
    return punches
  } catch {
    return []
  }
}

/**
 * Ne garde que les pointages STRICTEMENT postérieurs au curseur (comparaison
 * epoch ms). Sans curseur (première synchronisation), tout est gardé.
 */
function filterBySyncCursor(punches: NormalizedPunch[], syncCursor: string | null): NormalizedPunch[] {
  if (!syncCursor) return punches
  const cursorTime = new Date(syncCursor).getTime()
  if (Number.isNaN(cursorTime)) return punches
  return punches.filter(p => p.punchedAt.getTime() > cursorTime)
}

// ── Appel HTTP sortant sécurisé (miroir attendance.fetch.ts) ───────────────

interface DeviceConnectionConfig {
  baseUrl: string
  authType: string
  authSecret: string | null
  authHeaderName: string | null
  defaultHeaders: Record<string, string>
  fieldMapping: FieldMapping
  syncCursor: string | null
}

interface FetchDevicePunchesResult {
  punches: NormalizedPunch[]
  ok: boolean
  error?: string
}

/** `authSecret` arrive DÉJÀ déchiffré — jamais loggé, jamais dans un message d'erreur. */
function buildHeaders(device: DeviceConnectionConfig): Record<string, string> {
  const headers: Record<string, string> = { ...device.defaultHeaders }
  switch (device.authType) {
    case 'bearer':
      if (device.authSecret) headers['Authorization'] = `Bearer ${device.authSecret}`
      break
    case 'basic':
      if (device.authSecret) headers['Authorization'] = `Basic ${device.authSecret}`
      break
    case 'api_key':
      if (device.authSecret && device.authHeaderName) headers[device.authHeaderName] = device.authSecret
      break
    case 'none':
    default:
      break
  }
  return headers
}

/**
 * Appelle une badgeuse tenant (URL configurée par l'admin) pour récupérer
 * les pointages depuis le dernier curseur. Aucune exception ne se propage
 * hors de cette fonction (frontière avec un système externe non fiable) :
 * tout échec devient `{ ok: false, error }`.
 */
async function fetchDevicePunches(device: DeviceConnectionConfig): Promise<FetchDevicePunchesResult> {
  // Dispatcher épinglé sur l'IP validée (anti DNS-rebinding) ; fermé en `finally`.
  let dispatcher: { close(): Promise<void> } | null = null
  try {
    const safe = await resolveSafeOutboundResult(device.baseUrl)
    if (safe.ok !== true) {
      return { punches: [], ok: false, error: safe.reason }
    }
    dispatcher = safe.value.dispatcher

    const headers = buildHeaders(device)

    let response: Response
    try {
      response = await fetch(safe.value.url.toString(), {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
        dispatcher: safe.value.dispatcher,
      })
    } catch (e) {
      return { punches: [], ok: false, error: `Appel badgeuse échoué : ${(e as Error).message}` }
    }

    if (!response.ok) {
      return { punches: [], ok: false, error: `HTTP ${response.status}` }
    }

    // OWASP A10 — lecture BORNÉE (miroir de attendance.fetch.ts) : octets
    // comptés en flux, flux annulé au-delà du cap. Une badgeuse qui streamerait
    // plusieurs Go ne peut plus épuiser la mémoire du worker partagé.
    let body: unknown
    try {
      body = await readJsonCapped(response, MAX_BODY_BYTES)
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        return { punches: [], ok: false, error: 'Réponse badgeuse trop volumineuse — abandon' }
      }
      return { punches: [], ok: false, error: `Réponse badgeuse illisible (JSON) : ${(e as Error).message}` }
    }

    const allPunches = mapDeviceResponse(body, device.fieldMapping)
    const punches = filterBySyncCursor(allPunches, device.syncCursor)

    return { punches, ok: true }
  } catch (e) {
    return { punches: [], ok: false, error: `Erreur inattendue : ${(e as Error).message}` }
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => undefined)
  }
}

// ── Rapprochement employé (allowlist figé — OWASP A03) ─────────────────────

const EMPLOYEE_MATCH_COLUMNS: Readonly<Record<FieldMapping['employeeMatchBy'], string>> = Object.freeze({
  matricule: 'employee_number',
  email: 'email',
  badge_id: 'badge_id',
})

function resolveMatchColumn(matchBy: string): string | null {
  if (matchBy === 'matricule' || matchBy === 'email' || matchBy === 'badge_id') {
    return EMPLOYEE_MATCH_COLUMNS[matchBy]
  }
  return null
}

interface InsertPunchesResult {
  total: number
  matched: number
  inserted: number
}

/**
 * Insère un lot de pointages normalisés, en tentant de rapprocher chaque
 * pointage d'un employé via `matchBy` (colonne résolue par allowlist).
 * Idempotent via `ON CONFLICT (device_id, dedup_key) DO NOTHING`. Ne lève
 * jamais : chaque pointage est traité indépendamment (badgeuse externe non
 * fiable) — un pointage invalide n'annule jamais les autres.
 */
async function insertPunches(
  schemaName: string,
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
          `SELECT id FROM "${schemaName}".employees WHERE ${matchColumn} = $1 LIMIT 1`,
          [punch.rawEmployeeRef],
        )
        employeeId = match.rows[0]?.id ?? null
      }
      if (employeeId) result.matched += 1

      const insert = await pool.query(
        `INSERT INTO "${schemaName}".attendance_punches
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
    } catch (err) {
      // Best-effort : pointage ignoré, le lot continue.
      logger.error({ schemaName, deviceId, err }, 'attendance-poll: pointage ignoré (échec insertion individuel)')
    }
  }

  return result
}

// ── Mise à jour du statut de synchronisation ────────────────────────────────

/**
 * Met à jour `last_sync_at`/`last_sync_status`, et — uniquement si `cursor`
 * est fourni — avance `sync_cursor`. N'avance JAMAIS le curseur en cas
 * d'échec (appelant omet `cursor`). Ne lève jamais (best-effort ; une
 * défaillance de cette mise à jour est journalisée mais ne doit pas
 * remonter — le job a déjà fait le travail utile).
 */
async function updateSyncStatus(
  schemaName: string,
  deviceId: string,
  status: 'ok' | 'error',
  cursor?: string,
): Promise<void> {
  try {
    if (cursor !== undefined) {
      await pool.query(
        `UPDATE "${schemaName}".attendance_devices
            SET sync_cursor = $2, last_sync_at = now(), last_sync_status = $3
          WHERE id = $1`,
        [deviceId, cursor, status],
      )
    } else {
      await pool.query(
        `UPDATE "${schemaName}".attendance_devices
            SET last_sync_at = now(), last_sync_status = $2
          WHERE id = $1`,
        [deviceId, status],
      )
    }
  } catch (err) {
    logger.error({ schemaName, deviceId, status, err }, 'attendance-poll: échec mise à jour du statut de synchronisation')
  }
}

// ── Producteur attendance-evaluate ──────────────────────────────────────────

export interface AttendanceEvaluatePayload {
  schemaName: string
  employeeId?: string
  dateFrom: string
  dateTo: string
}

// `Queue` construite PARESSEUSEMENT (au premier enfilage) — même raison que
// `attendance.queue.ts` côté API : un simple `import` de ce module ne doit
// ouvrir aucune connexion Redis, pour que les tests puissent `vi.mock('bullmq')`
// sans effet de bord à la collecte.
let evaluateQueue: Queue<AttendanceEvaluatePayload> | undefined

function getEvaluateQueue(): Queue<AttendanceEvaluatePayload> {
  if (!evaluateQueue) {
    evaluateQueue = new Queue<AttendanceEvaluatePayload>('attendance-evaluate', { connection: createClient() })
  }
  return evaluateQueue
}

/**
 * Enfile un job `attendance-evaluate` couvrant la plage de dates affectée
 * par ce poll. Best-effort : une défaillance Redis est journalisée mais ne
 * fait pas échouer le poll (les pointages sont déjà en base — un futur
 * recalcul manuel ou un prochain poll rattrapera l'évaluation).
 */
async function enqueueEvaluate(payload: AttendanceEvaluatePayload): Promise<void> {
  try {
    await getEvaluateQueue().add('evaluate', payload, {
      removeOnComplete: true,
      removeOnFail: 1000,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
    })
  } catch (err) {
    logger.error({ payload, err }, 'attendance-poll: échec enfilage attendance-evaluate (non bloquant)')
  }
}

// ── Handler principal ────────────────────────────────────────────────────

interface AttendanceDeviceRow {
  id: string
  base_url: string
  auth_type: string
  auth_secret_enc: string | null
  auth_header_name: string | null
  default_headers: Record<string, string> | null
  field_mapping: FieldMapping | null
  sync_cursor: string | null
  poll_enabled: boolean
  is_active: boolean
}

export async function processAttendancePollJob(job: Job<unknown, void>): Promise<void> {
  // OWASP A03 + A01 — schemaName (identifiant SQL sûr) et deviceId (UUID)
  // validés AVANT toute requête DB. Un job Redis est une entrée non fiable.
  let payload: { schemaName: string; deviceId: string }
  try {
    payload = parseAttendancePollPayload(job.data)
  } catch (err) {
    if (err instanceof JobValidationError) {
      logger.error({ jobId: job.id, err: err.message }, 'attendance-poll: payload invalide — job rejeté')
      return
    }
    throw err
  }
  const { schemaName, deviceId } = payload

  // 1. Charger la badgeuse. Toute erreur DB ici est traitée comme
  //    « badgeuse indisponible pour ce cycle » — on n'écrit rien (on ne
  //    connaît même pas l'existence de la ligne) et on ne fait jamais
  //    planter le worker.
  let device: AttendanceDeviceRow | undefined
  try {
    const res = await pool.query<AttendanceDeviceRow>(
      `SELECT id, base_url, auth_type, auth_secret_enc, auth_header_name, default_headers,
              field_mapping, sync_cursor, poll_enabled, is_active
         FROM "${schemaName}".attendance_devices WHERE id = $1 LIMIT 1`,
      [deviceId],
    )
    device = res.rows[0]
  } catch (err) {
    logger.error({ jobId: job.id, schemaName, deviceId, err }, 'attendance-poll: échec lecture badgeuse — job abandonné sans effet')
    return
  }

  if (!device || !device.is_active || !device.poll_enabled) {
    logger.info({ jobId: job.id, schemaName, deviceId }, 'attendance-poll: badgeuse absente/inactive/poll désactivé — skip')
    return
  }

  const fieldMapping = (device.field_mapping ?? {}) as FieldMapping

  // 2. Récupérer les pointages (garde SSRF + timeout + auth — voir fetchDevicePunches).
  const result = await fetchDevicePunches({
    baseUrl: device.base_url,
    authType: device.auth_type,
    authSecret: decryptIfPresent(device.auth_secret_enc),
    authHeaderName: device.auth_header_name,
    defaultHeaders: device.default_headers ?? {},
    fieldMapping,
    syncCursor: device.sync_cursor,
  })

  if (!result.ok) {
    // Badgeuse injoignable / réponse invalide : statut 'error', curseur
    // INCHANGÉ (updateSyncStatus sans `cursor`), le worker continue.
    logger.error({ jobId: job.id, schemaName, deviceId, error: result.error }, 'attendance-poll: échec récupération des pointages')
    await updateSyncStatus(schemaName, deviceId, 'error')
    return
  }

  if (result.punches.length === 0) {
    // Synchronisation réussie mais rien de nouveau — statut 'ok', curseur inchangé.
    logger.info({ jobId: job.id, schemaName, deviceId }, 'attendance-poll: aucun nouveau pointage')
    await updateSyncStatus(schemaName, deviceId, 'ok')
    return
  }

  // 3. Insérer les pointages (dédupliqués, best-effort par pointage).
  const insertResult = await insertPunches(schemaName, deviceId, result.punches, fieldMapping.employeeMatchBy)
  const unmatched = insertResult.total - insertResult.matched
  if (unmatched > 0) {
    // Observabilité : pointages sans employé résolu (matricule/email/badge_id
    // inconnu côté RH) — n'empêche pas le succès global du poll.
    logger.warn(
      { jobId: job.id, schemaName, deviceId, unmatched, total: insertResult.total },
      'attendance-poll: pointages sans employé résolu',
    )
  }

  // 4. CONTRAT DE CURSEUR : sync_cursor = punchedAt.toISOString() du pointage
  //    le plus RÉCENT du lot tiré (jamais celui du plus ancien, ni "now()").
  let maxPunchedAt = result.punches[0]!.punchedAt
  let minPunchedAt = result.punches[0]!.punchedAt
  for (const p of result.punches) {
    if (p.punchedAt.getTime() > maxPunchedAt.getTime()) maxPunchedAt = p.punchedAt
    if (p.punchedAt.getTime() < minPunchedAt.getTime()) minPunchedAt = p.punchedAt
  }
  const newCursor = maxPunchedAt.toISOString()

  await updateSyncStatus(schemaName, deviceId, 'ok', newCursor)

  logger.info(
    {
      jobId: job.id, schemaName, deviceId,
      total: insertResult.total, matched: insertResult.matched, inserted: insertResult.inserted,
      unmatched, cursor: newCursor,
    },
    'attendance-poll: synchronisation terminée',
  )

  // 5. Enfiler attendance-evaluate pour la plage de dates affectée par ce lot.
  await enqueueEvaluate({
    schemaName,
    dateFrom: minPunchedAt.toISOString().slice(0, 10),
    dateTo: maxPunchedAt.toISOString().slice(0, 10),
  })
}
