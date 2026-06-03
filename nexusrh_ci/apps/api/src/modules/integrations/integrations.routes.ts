import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { Pool } from 'pg'
import { z } from 'zod'
import { config } from '../../config.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { encrypt, decryptIfPresent } from '../../utils/crypto.js'
import {
  EVENT_CATALOG, EVENT_KEYS, API_SCOPES, generateApiKey, resolveApiKey,
  emitIntegrationEvent, deliverWebhook, testConnector,
} from '../../services/integrations.service.js'
import { isSafeOutboundUrl } from '../../services/ssrf-guard.js'

const pool = new Pool({ connectionString: config.database.url })
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function auditLog(schema: string, userId: string, action: string, entityId: string | null, changes: Record<string, unknown>, ip: string | null): void {
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1,$2,'integration',$3,$4,$5)`,
    [userId, action, entityId, JSON.stringify(changes), ip],
  ).catch(() => undefined)
}

// ── Schémas Zod (OWASP A03) ───────────────────────────────────────────────────
const webhookBody = z.object({
  name: z.string().min(1).max(150),
  target_url: z.string().url().max(2000),
  events: z.array(z.enum(EVENT_KEYS as [string, ...string[]])).min(1),
  headers: z.record(z.string().max(200)).optional(),
  is_active: z.boolean().optional(),
}).strict()
const webhookPatch = webhookBody.partial()

const apiKeyBody = z.object({
  name: z.string().min(1).max(150),
  scopes: z.array(z.enum(API_SCOPES as unknown as [string, ...string[]])).min(1),
  expires_at: z.string().datetime().optional(),
}).strict()

const connectorBody = z.object({
  name: z.string().min(1).max(150),
  base_url: z.string().url().max(2000),
  auth_type: z.enum(['none', 'bearer', 'basic', 'api_key']).optional(),
  auth_secret: z.string().max(2000).optional(),
  auth_header_name: z.string().max(80).optional(),
  default_headers: z.record(z.string().max(500)).optional(),
  is_active: z.boolean().optional(),
}).strict()
const connectorPatch = connectorBody.partial()

const integrationsRoutes: FastifyPluginAsync = async (fastify) => {
  // ════════════════════════════════════════════════════════════════════════
  // API PUBLIQUE (clé API entrante) — /integrations/v1/*  (scope-gated)
  // Authentifiée par clé API (PAS JWT) : un outil externe « tire » les données.
  // ════════════════════════════════════════════════════════════════════════
  const apiKeyAuth = (...required: string[]) => async (request: FastifyRequest, reply: FastifyReply) => {
    const hdr = request.headers['authorization']
    const xkey = request.headers['x-api-key']
    const full = typeof hdr === 'string' && hdr.toLowerCase().startsWith('bearer ')
      ? hdr.slice(7).trim()
      : (typeof xkey === 'string' ? xkey.trim() : '')
    if (!full) return reply.status(401).send({ error: 'Clé API requise (Authorization: Bearer nxk_… ou X-API-Key)' })
    const ctx = await resolveApiKey(pool, full)
    if (!ctx) return reply.status(401).send({ error: 'Clé API invalide ou révoquée' })
    if (required.length && !required.every(s => ctx.scopes.includes(s))) {
      return reply.status(403).send({ error: `Scope insuffisant (requis : ${required.join(', ')})` })
    }
    ;(request as unknown as { apiCtx: typeof ctx }).apiCtx = ctx
  }
  const PUB_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } }

  fastify.get('/v1/me', {
    preHandler: [apiKeyAuth()], config: PUB_LIMIT,
    schema: { tags: ['integrations'], summary: 'Contexte de la clé API' },
    handler: async (request, reply) => {
      const c = (request as unknown as { apiCtx: { tenantId: string; scopes: string[] } }).apiCtx
      return reply.send({ data: { tenantId: c.tenantId, scopes: c.scopes } })
    },
  })

  fastify.get('/v1/employees', {
    preHandler: [apiKeyAuth('employees:read')], config: PUB_LIMIT,
    schema: { tags: ['integrations'], summary: 'Employés (clé API, scope employees:read)' },
    handler: async (request, reply) => {
      const { schemaName } = (request as unknown as { apiCtx: { schemaName: string } }).apiCtx
      const { limit = '50', offset = '0' } = request.query as Record<string, string>
      const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200)
      const off = Math.max(parseInt(offset) || 0, 0)
      const res = await pool.query(
        `SELECT id, first_name, last_name, email, employee_number, department_id,
                contract_type, hire_date, is_active
           FROM "${schemaName}".employees ORDER BY last_name LIMIT $1 OFFSET $2`, [lim, off])
      return reply.send({ data: res.rows })
    },
  })

  fastify.get('/v1/payslips', {
    preHandler: [apiKeyAuth('payroll:read')], config: PUB_LIMIT,
    schema: { tags: ['integrations'], summary: 'Bulletins (clé API, scope payroll:read)' },
    handler: async (request, reply) => {
      const { schemaName } = (request as unknown as { apiCtx: { schemaName: string } }).apiCtx
      const { month, limit = '100' } = request.query as Record<string, string>
      const lim = Math.min(Math.max(parseInt(limit) || 100, 1), 500)
      const where = month && /^\d{4}-\d{2}$/.test(month) ? 'WHERE month = $2' : ''
      const params: unknown[] = where ? [lim, month] : [lim]
      const res = await pool.query(
        `SELECT id, employee_id, month, gross_salary, net_payable, its, total_cnps_sal, status, currency
           FROM "${schemaName}".pay_slips ${where} ORDER BY month DESC LIMIT $1`, params)
      return reply.send({ data: res.rows })
    },
  })

  // ════════════════════════════════════════════════════════════════════════
  // ADMINISTRATION (admin du tenant uniquement) — /integrations/*
  // ════════════════════════════════════════════════════════════════════════
  fastify.get('/events', {
    preHandler: [fastify.authorize('admin')],
    handler: async (_req, reply) => reply.send({ data: EVENT_CATALOG }),
  })
  fastify.get('/scopes', {
    preHandler: [fastify.authorize('admin')],
    handler: async (_req, reply) => reply.send({ data: API_SCOPES }),
  })

  // ── Webhooks ────────────────────────────────────────────────────────────
  fastify.get('/webhooks', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const res = await pool.query(
        `SELECT id, name, target_url, events, headers, is_active, last_delivery_at, last_status, created_at
           FROM "${s}".integration_webhooks ORDER BY created_at DESC`)
      return reply.send({ data: res.rows })
    },
  })

  fastify.post('/webhooks', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const parsed = webhookBody.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation échouée', issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) })
      const b = parsed.data
      const safe = await isSafeOutboundUrl(b.target_url)
      if (!safe.ok) return reply.status(422).send({ error: `URL refusée (SSRF) : ${safe.reason}` })
      // Secret HMAC généré, montré UNE fois, stocké chiffré (AES-256).
      const secret = `whsec_${(await import('crypto')).randomBytes(24).toString('base64url')}`
      const res = await pool.query<{ id: string }>(
        `INSERT INTO "${s}".integration_webhooks (name, target_url, secret_enc, events, headers, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [b.name, b.target_url, encrypt(secret), b.events, JSON.stringify(b.headers ?? {}), b.is_active ?? true, request.user.sub])
      auditLog(s, request.user.sub, 'integration.webhook.created', res.rows[0]!.id, { name: b.name, events: b.events }, request.ip ?? null)
      return reply.status(201).send({ data: { id: res.rows[0]!.id }, secret, message: 'Conservez ce secret de signature : il ne sera plus affiché.' })
    },
  })

  fastify.patch('/webhooks/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = webhookPatch.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation échouée' })
      const b = parsed.data
      if (b.target_url) {
        const safe = await isSafeOutboundUrl(b.target_url)
        if (!safe.ok) return reply.status(422).send({ error: `URL refusée (SSRF) : ${safe.reason}` })
      }
      const sets: string[] = []; const vals: unknown[] = []; let i = 1
      if (b.name !== undefined) { sets.push(`name = $${i++}`); vals.push(b.name) }
      if (b.target_url !== undefined) { sets.push(`target_url = $${i++}`); vals.push(b.target_url) }
      if (b.events !== undefined) { sets.push(`events = $${i++}`); vals.push(b.events) }
      if (b.headers !== undefined) { sets.push(`headers = $${i++}`); vals.push(JSON.stringify(b.headers)) }
      if (b.is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(b.is_active) }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ' })
      sets.push(`updated_at = now()`); vals.push(id)
      const res = await pool.query(`UPDATE "${s}".integration_webhooks SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, vals)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Webhook introuvable' })
      auditLog(s, request.user.sub, 'integration.webhook.updated', id, { ...b }, request.ip ?? null)
      return reply.send({ data: { id, updated: true } })
    },
  })

  fastify.delete('/webhooks/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const res = await pool.query(`DELETE FROM "${s}".integration_webhooks WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Webhook introuvable' })
      auditLog(s, request.user.sub, 'integration.webhook.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id, deleted: true } })
    },
  })

  fastify.post('/webhooks/:id/test', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const r = await pool.query(`SELECT id, target_url, secret_enc, headers FROM "${s}".integration_webhooks WHERE id = $1 LIMIT 1`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Webhook introuvable' })
      // Envoi synchrone d'un événement de test pour retour immédiat à l'UI.
      await deliverWebhook(pool, s, r.rows[0], 'ping.test', { message: 'Test depuis NexusRH', at: new Date().toISOString() }, decryptIfPresent)
      const last = await pool.query(`SELECT status, ok, response_excerpt FROM "${s}".webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])
      return reply.send({ data: last.rows[0] ?? { ok: false } })
    },
  })

  fastify.get('/webhooks/:id/deliveries', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const res = await pool.query(
        `SELECT id, event, status, ok, attempt, response_excerpt, created_at
           FROM "${s}".webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50`, [id])
      return reply.send({ data: res.rows })
    },
  })

  // ── Clés API ──────────────────────────────────────────────────────────────
  fastify.get('/api-keys', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const res = await pool.query(
        `SELECT id, name, key_prefix, scopes, is_active, last_used_at, expires_at, created_at
           FROM "${s}".integration_api_keys ORDER BY created_at DESC`)
      return reply.send({ data: res.rows })
    },
  })

  fastify.post('/api-keys', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const parsed = apiKeyBody.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation échouée', issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) })
      const b = parsed.data
      const slug = request.user.schemaName.replace(/^tenant_/, '').replace(/_/g, '-')
      const { full, prefix, hash } = generateApiKey(slug)
      const res = await pool.query<{ id: string }>(
        `INSERT INTO "${s}".integration_api_keys (name, key_prefix, key_hash, scopes, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b.name, prefix, hash, b.scopes, b.expires_at ?? null, request.user.sub])
      auditLog(s, request.user.sub, 'integration.apikey.created', res.rows[0]!.id, { name: b.name, scopes: b.scopes }, request.ip ?? null)
      return reply.status(201).send({ data: { id: res.rows[0]!.id, prefix }, apiKey: full, message: 'Copiez cette clé : elle ne sera plus affichée.' })
    },
  })

  fastify.patch('/api-keys/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const b = z.object({ name: z.string().min(1).max(150).optional(), is_active: z.boolean().optional() }).strict().safeParse(request.body)
      if (!b.success) return reply.status(400).send({ error: 'Validation échouée' })
      const sets: string[] = []; const vals: unknown[] = []; let i = 1
      if (b.data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(b.data.name) }
      if (b.data.is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(b.data.is_active) }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ' })
      vals.push(id)
      const res = await pool.query(`UPDATE "${s}".integration_api_keys SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, vals)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Clé introuvable' })
      auditLog(s, request.user.sub, 'integration.apikey.updated', id, { ...b.data }, request.ip ?? null)
      return reply.send({ data: { id, updated: true } })
    },
  })

  fastify.delete('/api-keys/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const res = await pool.query(`DELETE FROM "${s}".integration_api_keys WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Clé introuvable' })
      auditLog(s, request.user.sub, 'integration.apikey.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id, deleted: true } })
    },
  })

  // ── Connecteurs REST génériques ────────────────────────────────────────────
  fastify.get('/connectors', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const res = await pool.query(
        `SELECT id, name, base_url, auth_type, auth_header_name, default_headers, is_active,
                last_test_at, last_test_status, created_at,
                (auth_secret_enc IS NOT NULL) AS has_secret
           FROM "${s}".integration_connectors ORDER BY created_at DESC`)
      return reply.send({ data: res.rows })
    },
  })

  fastify.post('/connectors', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const parsed = connectorBody.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation échouée', issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) })
      const b = parsed.data
      const safe = await isSafeOutboundUrl(b.base_url)
      if (!safe.ok) return reply.status(422).send({ error: `URL refusée (SSRF) : ${safe.reason}` })
      const res = await pool.query<{ id: string }>(
        `INSERT INTO "${s}".integration_connectors
           (name, base_url, auth_type, auth_secret_enc, auth_header_name, default_headers, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [b.name, b.base_url, b.auth_type ?? 'none', b.auth_secret ? encrypt(b.auth_secret) : null,
         b.auth_header_name ?? null, JSON.stringify(b.default_headers ?? {}), b.is_active ?? true, request.user.sub])
      auditLog(s, request.user.sub, 'integration.connector.created', res.rows[0]!.id, { name: b.name, auth_type: b.auth_type }, request.ip ?? null)
      return reply.status(201).send({ data: { id: res.rows[0]!.id } })
    },
  })

  fastify.patch('/connectors/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = connectorPatch.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation échouée' })
      const b = parsed.data
      if (b.base_url) {
        const safe = await isSafeOutboundUrl(b.base_url)
        if (!safe.ok) return reply.status(422).send({ error: `URL refusée (SSRF) : ${safe.reason}` })
      }
      const sets: string[] = []; const vals: unknown[] = []; let i = 1
      if (b.name !== undefined) { sets.push(`name = $${i++}`); vals.push(b.name) }
      if (b.base_url !== undefined) { sets.push(`base_url = $${i++}`); vals.push(b.base_url) }
      if (b.auth_type !== undefined) { sets.push(`auth_type = $${i++}`); vals.push(b.auth_type) }
      if (b.auth_secret !== undefined) { sets.push(`auth_secret_enc = $${i++}`); vals.push(b.auth_secret ? encrypt(b.auth_secret) : null) }
      if (b.auth_header_name !== undefined) { sets.push(`auth_header_name = $${i++}`); vals.push(b.auth_header_name) }
      if (b.default_headers !== undefined) { sets.push(`default_headers = $${i++}`); vals.push(JSON.stringify(b.default_headers)) }
      if (b.is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(b.is_active) }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ' })
      sets.push(`updated_at = now()`); vals.push(id)
      const res = await pool.query(`UPDATE "${s}".integration_connectors SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, vals)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Connecteur introuvable' })
      auditLog(s, request.user.sub, 'integration.connector.updated', id, { name: b.name }, request.ip ?? null)
      return reply.send({ data: { id, updated: true } })
    },
  })

  fastify.delete('/connectors/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const res = await pool.query(`DELETE FROM "${s}".integration_connectors WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Connecteur introuvable' })
      auditLog(s, request.user.sub, 'integration.connector.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id, deleted: true } })
    },
  })

  fastify.post('/connectors/:id/test', {
    preHandler: [fastify.authorize('admin')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const s = request.user.schemaName
      await ensureTenantSchema(s)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const r = await pool.query(`SELECT base_url, auth_type, auth_secret_enc, auth_header_name, default_headers FROM "${s}".integration_connectors WHERE id = $1 LIMIT 1`, [id])
      const c = r.rows[0]
      if (!c) return reply.status(404).send({ error: 'Connecteur introuvable' })
      const result = await testConnector(c.base_url, c.auth_type, decryptIfPresent(c.auth_secret_enc), c.auth_header_name, c.default_headers)
      await pool.query(`UPDATE "${s}".integration_connectors SET last_test_at = now(), last_test_status = $2 WHERE id = $1`, [id, result.status])
      return reply.send({ data: result })
    },
  })
}

// Réexport pour le câblage des événements métier (Phase 5).
export { emitIntegrationEvent }
export default integrationsRoutes
