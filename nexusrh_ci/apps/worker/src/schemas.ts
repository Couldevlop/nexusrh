/**
 * OWASP A03/A04 — Validators stricts pour les payloads de jobs BullMQ.
 *
 * Les jobs Redis sont des entrées non-fiables (n'importe qui ayant accès à
 * Redis peut publier un job). Avant exécution, chaque handler DOIT parser
 * son `job.data` via ces validators pour rejeter les payloads malformés ou
 * malveillants (injection tenantId, schema rogue, montant aberrant, etc.).
 *
 * On évite la dépendance à zod pour garder le worker auto-suffisant et léger.
 */

const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/
const COUNTRY_CODE_RE = /^[A-Z]{3}$/
const SOURCE_CODE_RE  = /^[a-z][a-z0-9_-]{0,30}$/
const EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MAX_STRING_LEN  = 1_000
const MAX_HTML_LEN    = 200_000  // bulletins HTML peuvent atteindre 100k+
const MAX_URL_LEN     = 2_048

export class JobValidationError extends Error {
  constructor(public readonly queue: string, public readonly field: string, message: string) {
    super(`[${queue}] ${field}: ${message}`)
    this.name = 'JobValidationError'
  }
}

function assertString(queue: string, field: string, v: unknown, max = MAX_STRING_LEN): string {
  if (typeof v !== 'string') throw new JobValidationError(queue, field, 'attendu string')
  if (v.length === 0)        throw new JobValidationError(queue, field, 'vide')
  if (v.length > max)        throw new JobValidationError(queue, field, `trop long (max ${max})`)
  return v
}

function assertOptionalString(queue: string, field: string, v: unknown, max = MAX_STRING_LEN): string | undefined {
  if (v === undefined || v === null) return undefined
  return assertString(queue, field, v, max)
}

function assertUuid(queue: string, field: string, v: unknown): string {
  const s = assertString(queue, field, v, 36)
  if (!UUID_RE.test(s)) throw new JobValidationError(queue, field, 'UUID invalide')
  return s
}

function assertOptionalUuid(queue: string, field: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  return assertUuid(queue, field, v)
}

function assertSchemaName(queue: string, field: string, v: unknown): string {
  const s = assertString(queue, field, v, 63)
  if (!SCHEMA_NAME_RE.test(s)) throw new JobValidationError(queue, field, 'schemaName invalide')
  return s
}

function assertIntInRange(queue: string, field: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new JobValidationError(queue, field, 'entier attendu')
  }
  if (v < min || v > max) throw new JobValidationError(queue, field, `hors plage [${min}, ${max}]`)
  return v
}

function assertEnum<T extends string>(queue: string, field: string, v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new JobValidationError(queue, field, `attendu un parmi ${allowed.join('|')}`)
  }
  return v as T
}

function assertOptionalEnum<T extends string>(queue: string, field: string, v: unknown, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === null) return undefined
  return assertEnum(queue, field, v, allowed)
}

function assertObject(queue: string, field: string, v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new JobValidationError(queue, field, 'objet attendu')
  }
  return v as Record<string, unknown>
}

export interface PayrollPayload {
  tenantId:   string
  schemaName: string
  periodId:   string
}

export function parsePayrollPayload(data: unknown): PayrollPayload {
  const o = assertObject('payroll-ci', 'data', data)
  return {
    tenantId:   assertUuid('payroll-ci', 'tenantId', o['tenantId']),
    schemaName: assertSchemaName('payroll-ci', 'schemaName', o['schemaName']),
    periodId:   assertUuid('payroll-ci', 'periodId', o['periodId']),
  }
}

export interface CnpsPayload {
  tenantId:   string
  schemaName: string
  month:      number
  year:       number
}

export function parseCnpsPayload(data: unknown): CnpsPayload {
  const o = assertObject('cnps-declaration', 'data', data)
  return {
    tenantId:   assertUuid('cnps-declaration', 'tenantId', o['tenantId']),
    schemaName: assertSchemaName('cnps-declaration', 'schemaName', o['schemaName']),
    month:      assertIntInRange('cnps-declaration', 'month', o['month'], 1, 12),
    year:       assertIntInRange('cnps-declaration', 'year', o['year'], 2000, 2100),
  }
}

export interface AiScoringPayload {
  tenantId:    string
  schemaName:  string
  employeeId?: string
}

export function parseAiScoringPayload(data: unknown): AiScoringPayload {
  const o = assertObject('ai-scoring-ci', 'data', data)
  return {
    tenantId:   assertUuid('ai-scoring-ci', 'tenantId', o['tenantId']),
    schemaName: assertSchemaName('ai-scoring-ci', 'schemaName', o['schemaName']),
    employeeId: assertOptionalUuid('ai-scoring-ci', 'employeeId', o['employeeId']),
  }
}

export interface EmailPayload {
  to:       string
  subject:  string
  html?:    string
  text?:    string
}

export function parseEmailPayload(data: unknown): EmailPayload {
  const o = assertObject('email', 'data', data)
  const to = assertString('email', 'to', o['to'], 254)
  if (!EMAIL_RE.test(to)) throw new JobValidationError('email', 'to', 'format email invalide')
  const subject = assertString('email', 'subject', o['subject'], 300)
  const html    = assertOptionalString('email', 'html', o['html'], MAX_HTML_LEN)
  const text    = assertOptionalString('email', 'text', o['text'], MAX_HTML_LEN)
  if (!html && !text) throw new JobValidationError('email', 'body', 'html ou text requis')
  return { to, subject, html, text }
}

const LEGAL_WATCH_SOURCE_TYPES = ['scraper', 'manual', 'upload'] as const

export interface LegalWatchPayload {
  articleId:    string | null
  sourceUrl:    string
  source:       string
  countryCode:  string
  sourceType?:  typeof LEGAL_WATCH_SOURCE_TYPES[number]
}

export function parseLegalWatchPayload(data: unknown): LegalWatchPayload {
  const o = assertObject('legal-watch', 'data', data)
  const articleIdRaw = o['articleId']
  const articleId =
    articleIdRaw === null || articleIdRaw === undefined
      ? null
      : assertString('legal-watch', 'articleId', articleIdRaw, 100)
  const sourceUrl = assertString('legal-watch', 'sourceUrl', o['sourceUrl'], MAX_URL_LEN)
  // OWASP A10 (SSRF) — n'autoriser que http(s), refuser file://, gopher://, etc.
  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new JobValidationError('legal-watch', 'sourceUrl', 'protocole http(s) requis')
  }
  const source = assertString('legal-watch', 'source', o['source'], 50)
  if (!SOURCE_CODE_RE.test(source)) {
    throw new JobValidationError('legal-watch', 'source', 'format invalide (code source)')
  }
  const countryCode = assertString('legal-watch', 'countryCode', o['countryCode'], 3)
  if (!COUNTRY_CODE_RE.test(countryCode)) {
    throw new JobValidationError('legal-watch', 'countryCode', 'format ISO 3166-1 alpha-3 requis')
  }
  return {
    articleId,
    sourceUrl,
    source,
    countryCode,
    sourceType: assertOptionalEnum('legal-watch', 'sourceType', o['sourceType'], LEGAL_WATCH_SOURCE_TYPES),
  }
}
