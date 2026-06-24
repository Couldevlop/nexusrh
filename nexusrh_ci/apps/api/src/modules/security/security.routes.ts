/**
 * Sécurité & conformité — routes Fastify (prefix /security).
 *
 * Exigence DAO « SSO / Active Directory + SIEM » :
 *  - Configuration SSO/AD par tenant (OIDC / SAML / LDAP), test de découverte
 *    OpenID Connect.
 *  - Configuration et export SIEM des événements de sécurité (webhook signé
 *    HMAC), liste des événements récents.
 *
 * SÉCURITÉ : OWASP A01 (réservé admin du tenant), A02 (secrets chiffrés AES-256,
 * jamais renvoyés en clair), A03 (Zod + valeurs bornées), A09 (audit_log),
 * A10 (SSRF guard sur tous les appels sortants — test SSO et envoi SIEM).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { createHmac } from 'crypto'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { encrypt, decryptIfPresent } from '../../utils/crypto.js'
import { assertSafeOutboundUrl } from '../../services/ssrf-guard.js'
import {
  SSO_PROVIDERS, TENANT_ROLES, SIEM_TRANSPORTS, SIEM_FORMATS, EVENT_CATEGORIES,
  isValidTenantRole, categorizeAction, shouldForward, formatEvent, type SecurityEvent, type SiemFormat,
} from './security.service.js'

const ADMIN = ['admin'] as const
const tuple = (a: readonly string[]) => a as unknown as [string, ...string[]]

const ssoSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(tuple(SSO_PROVIDERS)),
  issuer: z.string().max(2000).optional().nullable(),
  clientId: z.string().max(400).optional().nullable(),
  clientSecret: z.string().max(2000).optional().nullable(),
  domains: z.array(z.string().max(255)).max(50).optional(),
  defaultRole: z.enum(tuple(TENANT_ROLES)),
  jitProvisioning: z.boolean().optional(),
  groupMappings: z.array(z.object({ group: z.string().min(1).max(200), role: z.enum(tuple(TENANT_ROLES)) })).max(100).optional(),
}).strict()

const siemSchema = z.object({
  enabled: z.boolean(),
  transport: z.enum(tuple(SIEM_TRANSPORTS)),
  endpoint: z.string().max(2000).optional().nullable(),
  format: z.enum(tuple(SIEM_FORMATS)),
  secret: z.string().max(2000).optional().nullable(),
  categories: z.array(z.enum(tuple(EVENT_CATEGORIES))).max(EVENT_CATEGORIES.length).optional(),
}).strict()

function badRequest(reply: FastifyReply, msg = 'Validation échouée') { return reply.status(400).send({ error: msg }) }
function audit(schema: string, userId: string | undefined, action: string, changes: Record<string, unknown>, ip: string | null): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'security', NULL, $3, $4)`,
    [userId ?? null, action, JSON.stringify(changes), ip],
  ).catch(() => { /* non bloquant */ })
}

interface SiemCfg { enabled: boolean; transport: string; endpoint: string | null; format: string; secret_enc: string | null; categories: string[] }

/** Envoie un lot d'événements au collecteur SIEM (signé HMAC, SSRF-safe). */
async function sendToSiem(cfg: SiemCfg, events: SecurityEvent[]): Promise<{ status: number }> {
  const url = await assertSafeOutboundUrl(cfg.endpoint ?? '')
  const format = cfg.format as SiemFormat
  const body = format === 'cef'
    ? events.map((e) => formatEvent(e, 'cef')).join('\n')
    : JSON.stringify(events.map((e) => JSON.parse(formatEvent(e, 'json'))))
  const secret = decryptIfPresent(cfg.secret_enc) ?? ''
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': format === 'cef' ? 'text/plain' : 'application/json',
        'User-Agent': 'NexusRH-SIEM/1',
        'X-NexusRH-Signature': `sha256=${signature}`,
      },
      body,
      signal: ctrl.signal,
      redirect: 'error',
    })
    return { status: res.status }
  } finally { clearTimeout(timer) }
}

const securityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // ── SSO / AD ────────────────────────────────────────────────────────────
  fastify.get('/sso-config', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: 'Configuration SSO / Active Directory' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const r = await rawPool.query(`SELECT * FROM "${schema}".sso_config WHERE id = 1`)
      const row = r.rows[0] as Record<string, unknown> | undefined
      if (!row) return reply.send({ data: { enabled: false, provider: 'oidc', issuer: null, clientId: null, domains: [], defaultRole: 'employee', jitProvisioning: false, groupMappings: [], secretSet: false } })
      // Réponse TOUJOURS en camelCase (cohérente avec le cas par défaut + le PUT) :
      // ne JAMAIS exposer les colonnes DB brutes (snake_case) qui cassaient le front.
      return reply.send({ data: {
        enabled: row.enabled ?? false,
        provider: row.provider ?? 'oidc',
        issuer: row.issuer ?? null,
        clientId: row.client_id ?? null,
        domains: row.domains ?? [],
        defaultRole: row.default_role ?? 'employee',
        jitProvisioning: row.jit_provisioning ?? false,
        groupMappings: row.group_mappings ?? [],
        secretSet: !!row.client_secret_enc,
      } })
    },
  })

  fastify.put('/sso-config', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: 'Mettre à jour la configuration SSO' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = ssoSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      if (!isValidTenantRole(b.defaultRole)) return badRequest(reply, 'Rôle par défaut invalide')
      const mappings = (b.groupMappings ?? []).filter((m) => isValidTenantRole(m.role))
      const domains = (b.domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)
      const secretEnc = b.clientSecret ? encrypt(b.clientSecret) : null
      await rawPool.query(
        `INSERT INTO "${schema}".sso_config (id, enabled, provider, issuer, client_id, client_secret_enc, domains, default_role, jit_provisioning, group_mappings, updated_at)
         VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (id) DO UPDATE SET
           enabled = excluded.enabled, provider = excluded.provider, issuer = excluded.issuer,
           client_id = excluded.client_id,
           client_secret_enc = COALESCE(excluded.client_secret_enc, "${schema}".sso_config.client_secret_enc),
           domains = excluded.domains, default_role = excluded.default_role,
           jit_provisioning = excluded.jit_provisioning, group_mappings = excluded.group_mappings, updated_at = now()`,
        [b.enabled, b.provider, b.issuer ?? null, b.clientId ?? null, secretEnc, domains, b.defaultRole, b.jitProvisioning ?? false, JSON.stringify(mappings)],
      )
      audit(schema, request.user.sub, 'security.sso_updated', { enabled: b.enabled, provider: b.provider, domains }, request.ip ?? null)
      return reply.send({ data: { ok: true } })
    },
  })

  // Test de découverte OIDC (.well-known) — validation réelle de l'Issuer.
  fastify.post('/sso-config/test', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: 'Tester la découverte OIDC' },
    handler: async (request, reply) => {
      const issuer = (request.body as { issuer?: string } | undefined)?.issuer
      if (!issuer || typeof issuer !== 'string') return badRequest(reply, 'issuer requis')
      const wellKnown = issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration'
      try {
        const url = await assertSafeOutboundUrl(wellKnown)
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8000)
        const res = await fetch(url.toString(), { method: 'GET', headers: { 'User-Agent': 'NexusRH-SSO/1' }, signal: ctrl.signal, redirect: 'error' }).finally(() => clearTimeout(timer))
        const ok = res.status >= 200 && res.status < 300
        return reply.send({ data: { ok, status: res.status, issuer } })
      } catch (e) {
        return reply.send({ data: { ok: false, status: null, error: (e as Error).message } })
      }
    },
  })

  // ── SIEM ──────────────────────────────────────────────────────────────────
  fastify.get('/siem-config', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: 'Configuration export SIEM' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const r = await rawPool.query(`SELECT * FROM "${schema}".siem_config WHERE id = 1`)
      const row = r.rows[0] as Record<string, unknown> | undefined
      if (!row) return reply.send({ data: { enabled: false, transport: 'webhook', format: 'json', categories: [...EVENT_CATEGORIES], secretSet: false } })
      const { secret_enc, ...rest } = row
      return reply.send({ data: { ...rest, secretSet: !!secret_enc } })
    },
  })

  fastify.put('/siem-config', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: 'Mettre à jour la configuration SIEM' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = siemSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const categories = b.categories ?? [...EVENT_CATEGORIES]
      const secretEnc = b.secret ? encrypt(b.secret) : null
      await rawPool.query(
        `INSERT INTO "${schema}".siem_config (id, enabled, transport, endpoint, format, secret_enc, categories, updated_at)
         VALUES (1,$1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (id) DO UPDATE SET
           enabled = excluded.enabled, transport = excluded.transport, endpoint = excluded.endpoint,
           format = excluded.format,
           secret_enc = COALESCE(excluded.secret_enc, "${schema}".siem_config.secret_enc),
           categories = excluded.categories, updated_at = now()`,
        [b.enabled, b.transport, b.endpoint ?? null, b.format, secretEnc, categories],
      )
      audit(schema, request.user.sub, 'security.siem_updated', { enabled: b.enabled, transport: b.transport, categories }, request.ip ?? null)
      return reply.send({ data: { ok: true } })
    },
  })

  // Envoi d'un événement de test au collecteur SIEM.
  fastify.post('/siem-config/test', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: 'Envoyer un événement SIEM de test' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const r = await rawPool.query(`SELECT * FROM "${schema}".siem_config WHERE id = 1`)
      const cfg = r.rows[0] as SiemCfg | undefined
      if (!cfg?.endpoint) return badRequest(reply, 'Collecteur SIEM non configuré')
      const sample: SecurityEvent = {
        id: 'test', action: 'security.siem_test', entity: 'security', userId: request.user.sub ?? null,
        ip: request.ip ?? null, at: new Date().toISOString(), tenant: schema,
      }
      try {
        const { status } = await sendToSiem(cfg, [sample])
        audit(schema, request.user.sub, 'security.siem_test', { status }, request.ip ?? null)
        return reply.send({ data: { ok: status >= 200 && status < 300, status } })
      } catch (e) {
        return reply.send({ data: { ok: false, status: null, error: (e as Error).message } })
      }
    },
  })

  // Export à la demande : transmet les événements récents au SIEM.
  fastify.post('/siem/forward', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: 'Transmettre les événements récents au SIEM' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const r = await rawPool.query(`SELECT * FROM "${schema}".siem_config WHERE id = 1`)
      const cfg = r.rows[0] as SiemCfg | undefined
      if (!cfg?.enabled || !cfg.endpoint) return badRequest(reply, 'Export SIEM désactivé ou collecteur absent')
      const rows = await rawPool.query<{ id: string; action: string; entity: string | null; user_id: string | null; ip_address: string | null; created_at: Date }>(
        `SELECT id, action, entity, user_id, ip_address, created_at FROM "${schema}".audit_log ORDER BY created_at DESC LIMIT 200`,
      )
      const events: SecurityEvent[] = rows.rows
        .filter((e) => shouldForward(cfg.categories, e.action))
        .map((e) => ({ id: e.id, action: e.action, entity: e.entity, userId: e.user_id, ip: e.ip_address, at: new Date(e.created_at).toISOString(), tenant: schema }))
      if (events.length === 0) return reply.send({ data: { forwarded: 0, status: null } })
      try {
        const { status } = await sendToSiem(cfg, events)
        audit(schema, request.user.sub, 'security.siem_forward', { forwarded: events.length, status }, request.ip ?? null)
        return reply.send({ data: { forwarded: events.length, status } })
      } catch (e) {
        return reply.status(502).send({ error: (e as Error).message, statusCode: 502 })
      }
    },
  })

  // ── Événements de sécurité (journal d'audit annoté) ───────────────────────
  fastify.get('/events', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: 'Événements de sécurité récents' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const cfgRes = await rawPool.query(`SELECT enabled, categories FROM "${schema}".siem_config WHERE id = 1`)
      const cfg = cfgRes.rows[0] as { enabled: boolean; categories: string[] } | undefined
      const rows = await rawPool.query<{ id: string; action: string; entity: string | null; user_id: string | null; ip_address: string | null; created_at: Date }>(
        `SELECT id, action, entity, user_id, ip_address, created_at FROM "${schema}".audit_log ORDER BY created_at DESC LIMIT 100`,
      )
      const data = rows.rows.map((e) => ({
        id: e.id, action: e.action, entity: e.entity, userId: e.user_id, ip: e.ip_address, at: e.created_at,
        category: categorizeAction(e.action),
        forwarded: !!cfg?.enabled && shouldForward(cfg.categories ?? [], e.action),
      }))
      return reply.send({ data })
    },
  })
}

export default securityRoutes
