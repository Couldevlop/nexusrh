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
import { encrypt, decryptIfPresent } from '@nexusrhci/shared/crypto'
import { resolveSafeOutbound } from '@nexusrhci/shared/ssrf-guard'
import {
  SSO_PROVIDERS, TENANT_ROLES, SIEM_TRANSPORTS, SIEM_FORMATS, EVENT_CATEGORIES,
  isValidTenantRole, categorizeAction, shouldForward, formatEvent, type SecurityEvent, type SiemFormat,
} from './security.service.js'
import { auditTenant } from '../../utils/audit-log.js'
import { badRequest } from '../../utils/http-errors.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { config } from '../../config.js'
import { exportAudit, purgeAudit, verifyChain } from '../../services/audit-integrity.service.js'

/** Codes PostgreSQL « table/colonne/fonction absente » : tenant non migré. */
function isMissingSchemaObject(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === '42P01' || code === '42703' || code === '42883'
}

/** Date ISO courte, sans surprise d'interprétation côté SQL. */
function isIsoDate(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
}

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

function audit(schema: string, userId: string | undefined, action: string, changes: Record<string, unknown>, ip: string | null): void {
  auditTenant(schema, { userId: userId ?? null, action: action, entity: 'security', entityId: null, changes: changes, ip: ip })
}

interface SiemCfg { enabled: boolean; transport: string; endpoint: string | null; format: string; secret_enc: string | null; categories: string[] }

/** Envoie un lot d'événements au collecteur SIEM (signé HMAC, SSRF-safe). */
async function sendToSiem(cfg: SiemCfg, events: SecurityEvent[]): Promise<{ status: number }> {
  const safe = await resolveSafeOutbound(cfg.endpoint ?? '')
  const format = cfg.format as SiemFormat
  const body = format === 'cef'
    ? events.map((e) => formatEvent(e, 'cef')).join('\n')
    : JSON.stringify(events.map((e) => JSON.parse(formatEvent(e, 'json'))))
  const secret = decryptIfPresent(cfg.secret_enc) ?? ''
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    // Connexion épinglée sur l'IP validée par la garde (anti DNS-rebinding).
    const res = await fetch(safe.url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': format === 'cef' ? 'text/plain' : 'application/json',
        'User-Agent': 'NexusRH-SIEM/1',
        'X-NexusRH-Signature': `sha256=${signature}`,
      },
      body,
      signal: ctrl.signal,
      redirect: 'error',
      dispatcher: safe.dispatcher,
    })
    return { status: res.status }
  } finally { clearTimeout(timer); await safe.dispatcher.close().catch(() => undefined) }
}

const securityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

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
      let safe: Awaited<ReturnType<typeof resolveSafeOutbound>> | null = null
      try {
        safe = await resolveSafeOutbound(wellKnown)
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8000)
        // Connexion épinglée sur l'IP validée (anti DNS-rebinding).
        const res = await fetch(safe.url.toString(), { method: 'GET', headers: { 'User-Agent': 'NexusRH-SSO/1' }, signal: ctrl.signal, redirect: 'error', dispatcher: safe.dispatcher }).finally(() => clearTimeout(timer))
        const ok = res.status >= 200 && res.status < 300
        return reply.send({ data: { ok, status: res.status, issuer } })
      } catch (e) {
        return reply.send({ data: { ok: false, status: null, error: (e as Error).message } })
      } finally {
        if (safe) await safe.dispatcher.close().catch(() => undefined)
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

  // ── Piste d'audit opposable ───────────────────────────────────────────────
  // Trois gestes, et le même but : pouvoir SOUTENIR devant un tiers que le
  // journal n'a pas été retouché. Le contrôle recalcule la chaîne, l'export
  // produit une pièce vérifiable hors ligne, la purge applique la rétention
  // sans effacer en silence.

  fastify.get('/audit/verify', {
    preHandler: [fastify.authorize(...ADMIN)],
    schema: { tags: ['security'], summary: "Contrôler l'intégrité de la piste d'audit" },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const verdict = await verifyChain(schema, rawPool)
        // Le contrôle est lui-même journalisé : qui a vérifié, et quand.
        audit(schema, request.user.sub, 'audit.verified',
          { intact: verdict.intact, checked: verdict.checked }, request.ip ?? null)
        return reply.send({ data: verdict })
      } catch (err) {
        // Tenant provisionné avant le chaînage : la piste existe, mais aucune
        // entrée n'est chaînée. Ce n'est pas une panne, et surtout pas une
        // altération : le dire tel quel.
        if (isMissingSchemaObject(err)) {
          return reply.send({ data: { checked: 0, intact: true, brokenAt: null, lastHash: null, purgeMarkers: 0, chained: false } })
        }
        throw err
      }
    },
  })

  fastify.get('/audit/export', {
    preHandler: [fastify.authorize(...ADMIN)],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { tags: ['security'], summary: "Exporter la piste d'audit (CSV + manifeste scellé)" },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const q = request.query as { from?: string; to?: string; format?: string }
      const from = isIsoDate(q.from) ? q.from! : null
      const to   = isIsoDate(q.to)   ? q.to!   : null
      if ((q.from && !from) || (q.to && !to)) {
        return badRequest(reply, 'Dates attendues au format ISO (AAAA-MM-JJ)')
      }
      try {
        const result = await exportAudit(schema, rawPool, {
          from, to, signingKey: config.audit.signingKey,
          // BOM : Excel, qui est l'outil du destinataire, lit l'UTF-8 sans lui
          // comme du latin-1 et abîme les accents. Il est demandé au service
          // pour que l'empreinte et le sceau portent sur le fichier livré, et
          // non sur un contenu amputé de ces trois octets.
          bom: q.format === 'csv',
        })
        // L'export d'une piste d'audit est lui-même un acte à tracer : il sort
        // des données nominatives de l'application.
        audit(schema, request.user.sub, 'audit.exported',
          { entries: result.manifest.entries, from, to, sealed: result.manifest.sealed,
            sha256: result.manifest.sha256 },
          request.ip ?? null)

        if (q.format === 'csv') {
          const name = `audit-${schema}-${new Date().toISOString().slice(0, 10)}.csv`
          return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${name}"`)
            // Le manifeste voyage en en-têtes quand seul le CSV est téléchargé :
            // le destinataire reçoit le fichier ET de quoi le vérifier.
            .header('X-Audit-Sha256', result.manifest.sha256)
            .header('X-Audit-Seal', result.manifest.seal ?? 'none')
            .header('X-Audit-Entries', String(result.manifest.entries))
            .header('X-Audit-Chain-Intact', String(result.manifest.chain.intact))
            // `result.csv` part TEL QUEL : le BOM y est déjà, et c'est sur cette
            // chaîne exacte que l'empreinte et le sceau ont été calculés.
            .send(result.csv)
        }
        return reply.send({ data: result })
      } catch (err) {
        if (isMissingSchemaObject(err)) {
          return reply.status(503).send({ error: "Piste d'audit non initialisée sur ce tenant" })
        }
        throw err
      }
    },
  })

  fastify.post('/audit/purge', {
    preHandler: [fastify.authorize(...ADMIN)],
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } },
    schema: { tags: ['security'], summary: "Appliquer la rétention de la piste d'audit" },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // La durée vient des réglages PLATEFORME, pas du corps de la requête :
      // un administrateur de tenant ne doit pas pouvoir raccourcir la
      // conservation à la demande pour faire disparaître une période.
      let keepDays = 0
      try {
        const r = await rawPool.query<{ audit_retention_days: number | null }>(
          `SELECT audit_retention_days FROM platform.platform_settings ORDER BY created_at ASC LIMIT 1`,
        )
        keepDays = Number(r.rows[0]?.audit_retention_days ?? 0)
      } catch { /* colonne absente : conservation sans limite */ }
      if (!Number.isFinite(keepDays) || keepDays <= 0) {
        return badRequest(reply, "Aucune durée de conservation n'est définie : la piste est conservée sans limite")
      }
      try {
        const res = await purgeAudit(schema, rawPool, keepDays)
        return reply.send({ data: { ...res, keepDays } })
      } catch (err) {
        if (isMissingSchemaObject(err)) {
          return reply.status(503).send({ error: "Piste d'audit non initialisée sur ce tenant" })
        }
        throw err
      }
    },
  })
}

export default securityRoutes
