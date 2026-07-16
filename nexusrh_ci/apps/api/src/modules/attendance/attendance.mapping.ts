import type { FieldMapping, NormalizedPunch, PunchDirection } from './attendance.types.js'

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * Lit une valeur dans un objet inconnu à partir d'un chemin pointé (ex. "data.records").
 * Marche uniquement sur des objets "plain" — jamais d'accès dynamique dangereux,
 * jamais d'exception : tout chemin invalide ou clé interdite renvoie `undefined`.
 */
export function getByPath(obj: unknown, path: string): unknown {
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

/**
 * Parse un horodatage brut de badgeuse selon le format configuré.
 * Retourne `null` (jamais d'exception) si la valeur ne peut pas être convertie en date valide.
 */
export function parseTimestamp(v: unknown, format: string): Date | null {
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
 * Transforme une réponse brute (JSON) de badgeuse en pointages normalisés,
 * en suivant les chemins configurés dans `mapping`. Frontière de parsing pour des
 * données EXTERNES NON FIABLES : un enregistrement malformé est simplement ignoré,
 * cette fonction ne lève JAMAIS d'exception.
 */
export function mapDeviceResponse(body: unknown, mapping: FieldMapping): NormalizedPunch[] {
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
