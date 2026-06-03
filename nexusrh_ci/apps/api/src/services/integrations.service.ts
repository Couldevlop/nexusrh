import type { Pool } from 'pg'
import { createHmac, createHash, randomBytes } from 'crypto'
import { assertSafeOutboundUrl } from './ssrf-guard.js'
import { ensureTenantSchema } from '../utils/schema-migrations.js'
import { isValidSchemaName } from '../utils/schema-name.js'

/**
 * Service Connectivité — logique des intégrations tenant (clean architecture :
 * la logique métier vit ici, les routes ne font qu'orchestrer).
 *
 * OWASP : HMAC signature des webhooks (intégrité), hash des clés API (jamais en
 * clair), SSRF guard sur tous les appels sortants, scopes sur les clés API.
 */

// Catalogue des événements webhook (extensible). Clés stables = contrat externe.
export const EVENT_CATALOG = [
  { key: 'employee.created',  label: 'Employé créé' },
  { key: 'employee.updated',  label: 'Employé modifié' },
  { key: 'absence.requested', label: 'Absence demandée' },
  { key: 'absence.approved',  label: 'Absence approuvée' },
  { key: 'absence.rejected',  label: 'Absence rejetée' },
  { key: 'payslip.generated', label: 'Bulletin généré' },
  { key: 'expense.submitted', label: 'Note de frais soumise' },
  { key: 'expense.approved',  label: 'Note de frais approuvée' },
  { key: 'recruitment.application.created', label: 'Candidature reçue' },
] as const
export const EVENT_KEYS = EVENT_CATALOG.map(e => e.key)

// Scopes des clés API entrantes (read/write par module). Whitelist (OWASP A03).
export const API_SCOPES = [
  'employees:read', 'payroll:read', 'absences:read', 'recruitment:read',
] as const
export type ApiScope = typeof API_SCOPES[number]

// ── Clés API ────────────────────────────────────────────────────────────────
export function hashApiKey(full: string): string {
  return createHash('sha256').update(full).digest('hex')
}

/** Génère une clé API : nxk_{slug}.{random}. Le slug (non secret) permet une
 *  résolution O(1) du tenant à la présentation. */
export function generateApiKey(slug: string): { full: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString('base64url')
  const full = `nxk_${slug}.${rand}`
  const prefix = `nxk_${slug}.${rand.slice(0, 6)}…`
  return { full, prefix, hash: hashApiKey(full) }
}

export interface ResolvedApiKey {
  schemaName: string
  tenantId: string
  keyId: string
  scopes: string[]
}

/** Résout une clé API entrante → contexte tenant + scopes, ou null. Met à jour
 *  last_used_at. Ne lève jamais. */
export async function resolveApiKey(pool: Pool, fullKey: string): Promise<ResolvedApiKey | null> {
  if (!fullKey || !fullKey.startsWith('nxk_') || !fullKey.includes('.')) return null
  const slug = fullKey.slice(4, fullKey.indexOf('.'))
  if (!/^[a-z0-9-]{2,63}$/.test(slug)) return null
  try {
    const t = await pool.query<{ id: string; schema_name: string; status: string }>(
      `SELECT id, schema_name, status FROM platform.tenants WHERE slug = $1 LIMIT 1`, [slug],
    )
    const tenant = t.rows[0]
    if (!tenant || (tenant.status !== 'active' && tenant.status !== 'trial')) return null
    if (!isValidSchemaName(tenant.schema_name)) return null
    await ensureTenantSchema(tenant.schema_name)
    const hash = hashApiKey(fullKey)
    const r = await pool.query<{ id: string; scopes: string[] }>(
      `SELECT id, scopes FROM "${tenant.schema_name}".integration_api_keys
        WHERE key_hash = $1 AND is_active = true
          AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, [hash],
    )
    const key = r.rows[0]
    if (!key) return null
    pool.query(`UPDATE "${tenant.schema_name}".integration_api_keys SET last_used_at = now() WHERE id = $1`, [key.id])
      .catch(() => undefined)
    return { schemaName: tenant.schema_name, tenantId: tenant.id, keyId: key.id, scopes: key.scopes ?? [] }
  } catch {
    return null
  }
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

interface WebhookRow {
  id: string; target_url: string; secret_enc: string; headers: Record<string, string> | null
}

/** Livre un webhook (SSRF guard + HMAC + retry borné), journalise la livraison.
 *  Best-effort : ne lève jamais (appelée en fire-and-forget). decryptSecret est
 *  injecté pour ne pas coupler le service au module crypto au chargement. */
export async function deliverWebhook(
  pool: Pool, schema: string, wh: WebhookRow, event: string,
  payload: unknown, decryptSecret: (enc: string) => string | null,
): Promise<void> {
  const body = JSON.stringify({ event, data: payload, sentAt: new Date().toISOString() })
  const secret = decryptSecret(wh.secret_enc) ?? ''
  const signature = signPayload(secret, body)
  const maxAttempts = 2
  let lastStatus: number | null = null
  let ok = false
  let excerpt = ''

  for (let attempt = 1; attempt <= maxAttempts && !ok; attempt++) {
    try {
      await assertSafeOutboundUrl(wh.target_url) // re-valide à chaque envoi (DNS rebinding)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(wh.target_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'NexusRH-Webhook/1',
          'X-NexusRH-Event': event,
          'X-NexusRH-Signature': `sha256=${signature}`,
          ...(wh.headers ?? {}),
        },
        body,
        signal: ctrl.signal,
        redirect: 'error', // pas de suivi de redirection (anti-SSRF)
      }).finally(() => clearTimeout(timer))
      lastStatus = res.status
      ok = res.status >= 200 && res.status < 300
      excerpt = (await res.text().catch(() => '')).slice(0, 300)
    } catch (e) {
      excerpt = (e as Error).message.slice(0, 300)
    }
  }

  pool.query(
    `INSERT INTO "${schema}".webhook_deliveries (webhook_id, event, status, ok, attempt, response_excerpt)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [wh.id, event, lastStatus, ok, maxAttempts, excerpt],
  ).catch(() => undefined)
  pool.query(
    `UPDATE "${schema}".integration_webhooks SET last_delivery_at = now(), last_status = $2 WHERE id = $1`,
    [wh.id, lastStatus],
  ).catch(() => undefined)
}

/** Émet un événement métier vers tous les webhooks abonnés du tenant.
 *  Fire-and-forget (non bloquant pour le flux RH). */
export function emitIntegrationEvent(
  pool: Pool, schema: string, event: string, payload: unknown,
  decryptSecret: (enc: string) => string | null,
): void {
  // Best-effort ABSOLU : l'émission ne doit JAMAIS casser le flux RH appelant
  // (try/catch synchrone + Promise.resolve si pool.query ne renvoie pas de
  // promesse, ex. en test). Les webhooks sont livrés en fire-and-forget.
  if (!isValidSchemaName(schema)) return
  try {
    Promise.resolve(
      pool.query<WebhookRow>(
        `SELECT id, target_url, secret_enc, headers FROM "${schema}".integration_webhooks
          WHERE is_active = true AND $1 = ANY(events)`, [event],
      ),
    ).then(r => {
      for (const wh of r?.rows ?? []) void deliverWebhook(pool, schema, wh, event, payload, decryptSecret)
    }).catch(() => undefined)
  } catch { /* jamais bloquant */ }
}

// ── Connecteurs REST génériques ───────────────────────────────────────────────
export interface ConnectorTestResult { ok: boolean; status: number | null; message: string }

/** Teste un connecteur : appel GET sur base_url (SSRF guard + auth), borné. */
export async function testConnector(
  baseUrl: string, authType: string, authSecret: string | null,
  authHeaderName: string | null, defaultHeaders: Record<string, string> | null,
): Promise<ConnectorTestResult> {
  try {
    await assertSafeOutboundUrl(baseUrl)
  } catch (e) {
    return { ok: false, status: null, message: (e as Error).message }
  }
  const headers: Record<string, string> = { 'User-Agent': 'NexusRH-Connector/1', ...(defaultHeaders ?? {}) }
  if (authType === 'bearer' && authSecret) headers['Authorization'] = `Bearer ${authSecret}`
  else if (authType === 'basic' && authSecret) headers['Authorization'] = `Basic ${Buffer.from(authSecret).toString('base64')}`
  else if (authType === 'api_key' && authSecret) headers[authHeaderName || 'X-API-Key'] = authSecret
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(baseUrl, { method: 'GET', headers, signal: ctrl.signal, redirect: 'error' })
      .finally(() => clearTimeout(timer))
    return { ok: res.status < 500, status: res.status, message: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: null, message: (e as Error).message.slice(0, 200) }
  }
}
