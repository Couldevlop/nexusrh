import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { config } from '../../config.js'
import { pool } from '../../db/pool.js'
import { AUTH_COOKIE_NAME } from '../../plugins/auth.js'
import { blacklistTokenSafe } from '../../services/redis.js'
import { assertAgencyCanActOnTenant, assertTenantIsCI } from '../../services/agency.service.js'
import { createTenantWithSchema, TenantSlugConflictError } from '../../services/tenant-provisioning.service.js'
import { sendWelcomeAgencyEmail } from '../../services/email.js'
import {
  getOfflineMessagePolicy,
  resolveOfflineMessage,
  invalidateOfflineStatusCache,
} from '../../services/offline-status.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// OWASP A09 — audit non bloquant des actions cabinet (plateforme).
function auditLogPlatform(
  userId: string | null, action: string, entity: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO platform.audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, entity, entityId, JSON.stringify(changes), ip],
  ).catch(() => { /* table absente : non bloquant */ })
}

function genTempPassword(): string {
  return `CI_${randomBytes(6).toString('base64url').toUpperCase()}!`
}

// ─── Schémas Zod (OWASP A03) ────────────────────────────────────────────────
const createAgencyBody = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  city: z.string().max(100).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(30).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  logoUrl: z.string().url().or(z.literal('')).optional(),
  senderEmail: z.string().email().optional(),
  senderName: z.string().max(150).optional(),
  ownerEmail: z.string().email(),
  ownerFirstName: z.string().min(1).max(100).optional().default('Admin'),
  ownerLastName: z.string().min(1).max(100).optional().default('Cabinet'),
}).strict()

const patchAgencyBody = z.object({
  name: z.string().min(1).max(255).optional(),
  city: z.string().max(100).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(30).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  logoUrl: z.string().url().or(z.literal('')).optional(),
  senderEmail: z.string().email().or(z.literal('')).optional(),
  senderName: z.string().max(150).optional(),
}).strict()

const activateBody = z.object({ tenantId: z.string().regex(UUID_RE, 'tenantId invalide') }).strict()

const createMemberBody = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(100).optional().default('Membre'),
  lastName: z.string().min(1).max(100).optional().default('Cabinet'),
  role: z.enum(['agency_owner', 'agency_member']).optional().default('agency_member'),
}).strict()

const patchMemberBody = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  role: z.enum(['agency_owner', 'agency_member']).optional(),
  isActive: z.boolean().optional(),
}).strict()

const createClientTenantBody = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  planType: z.enum(['trial', 'starter', 'business', 'enterprise', 'public_sector']).optional(),
  sector: z.string().max(50).optional(),
  city: z.string().max(100).optional(),
  cnpsNumber: z.string().max(50).optional(),
  dgiNumber: z.string().max(50).optional(),
  rccm: z.string().max(100).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  logoUrl: z.string().url().or(z.literal('')).optional(),
  adminEmail: z.string().email(),
  adminFirstName: z.string().min(1).max(100).optional().default('Admin'),
  adminLastName: z.string().min(1).max(100).optional().default('Tenant'),
  seedDemoData: z.boolean().optional(),
}).strict()

function tenantConfigFromGuard(t: {
  tenantId: string; name: string; slug: string; primaryColor: string | null
  secondaryColor: string | null; logoUrl: string | null; city: string | null
  hasSubsidiaries: boolean; payrollMode: string; defaultCountryCode: string
}) {
  return {
    id: t.tenantId, name: t.name, slug: t.slug,
    primaryColor: t.primaryColor, secondaryColor: t.secondaryColor,
    logoUrl: t.logoUrl, city: t.city,
    hasSubsidiaries: t.hasSubsidiaries, payrollMode: t.payrollMode,
    defaultCountryCode: t.defaultCountryCode,
  }
}

const agencyRoutes: FastifyPluginAsync = async (fastify) => {
  // ════════════════════════════════════════════════════════════════════════
  // SESSIONS — bascule cabinet → tenant client (re-scoping de token)
  // ════════════════════════════════════════════════════════════════════════

  // POST /agency/sessions/activate — chokepoint A01. Émet un JWT scopé
  // (role='admin' délégué) sur le tenant client, TTL court (30 min).
  fastify.post('/sessions/activate', {
    preHandler: [fastify.authorize('agency_owner', 'agency_member')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['agency'], summary: 'Activer une session sur un tenant client' },
    handler: async (request, reply) => {
      // Token restreint (MFA/mdp) ne peut pas basculer.
      const u = request.user as { mfaPending?: boolean; pwdResetRequired?: boolean; agencyId?: string }
      if (u.mfaPending || u.pwdResetRequired) {
        return reply.status(403).send({ error: 'Action non autorisée pour ce token restreint' })
      }
      const parsed = activateBody.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'tenantId requis (UUID)' })
      const agencyId = u.agencyId
      if (!agencyId) return reply.status(403).send({ error: 'Contexte cabinet manquant' })

      const guard = await assertAgencyCanActOnTenant(pool, request.user.sub, agencyId, parsed.data.tenantId)
      if (!guard.ok) {
        auditLogPlatform(request.user.sub, 'agency.activate.denied', 'tenant', parsed.data.tenantId,
          { reason: guard.reason, agencyId }, request.ip ?? null)
        // 403 générique : ne pas révéler le motif exact (énumération de tenants).
        return reply.status(403).send({ error: 'Accès au tenant refusé' })
      }

      const token = fastify.jwt.sign({
        sub:          request.user.sub,
        tenantId:     guard.tenant.tenantId,
        schemaName:   guard.tenant.schemaName,
        role:         'admin',
        email:        request.user.email,
        firstName:    request.user.firstName,
        lastName:     request.user.lastName,
        employeeId:   null,
        actorType:    'agency',
        agencyId,
        agencyUserId: request.user.sub,
        onBehalfOf:   guard.tenant.tenantId,
      }, { expiresIn: '30m' })

      auditLogPlatform(request.user.sub, 'agency.session.activated', 'tenant', guard.tenant.tenantId,
        { agencyId, agencyUserId: request.user.sub }, request.ip ?? null)

      reply.setCookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true, secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'lax', path: '/', maxAge: 60 * 30,
      })
      return reply.send({
        token, scoped: true, expiresInSec: 1800,
        tenantConfig: tenantConfigFromGuard(guard.tenant),
      })
    },
  })

  // POST /agency/sessions/deactivate — revient au contexte cabinet.
  fastify.post('/sessions/deactivate', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['agency'], summary: 'Quitter la session tenant (retour cabinet)' },
    handler: async (request, reply) => {
      const u = request.user as { actorType?: string; agencyId?: string }
      if (u.actorType !== 'agency' || !u.agencyId) {
        return reply.status(403).send({ error: 'Non applicable hors contexte cabinet' })
      }
      const token = fastify.jwt.sign({
        sub: request.user.sub, tenantId: null, schemaName: 'platform',
        role: request.user.role, email: request.user.email,
        firstName: request.user.firstName, lastName: request.user.lastName,
        employeeId: null, actorType: 'agency', agencyId: u.agencyId,
      })
      reply.setCookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true, secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 7,
      })
      return reply.send({ token, scoped: false })
    },
  })

  // ════════════════════════════════════════════════════════════════════════
  // OWNER/MEMBER — vue cabinet
  // ════════════════════════════════════════════════════════════════════════

  // GET /agency/me — infos du cabinet courant.
  fastify.get('/me', {
    preHandler: [fastify.authorize('agency_owner', 'agency_member')],
    schema: { tags: ['agency'], summary: 'Mon cabinet' },
    handler: async (request, reply) => {
      const agencyId = (request.user as { agencyId?: string }).agencyId
      if (!agencyId) return reply.status(403).send({ error: 'Contexte cabinet manquant' })
      const res = await pool.query(
        `SELECT id, slug, name, status, country_code, city, contact_email, contact_phone,
                primary_color, logo_url, sender_email, sender_name, created_at
           FROM platform.agencies WHERE id = $1 LIMIT 1`, [agencyId])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Cabinet introuvable' })
      return reply.send({ data: res.rows[0] })
    },
  })

  // GET /agency/my-tenants — tenants CI rattachés actifs (alimente le switcher).
  fastify.get('/my-tenants', {
    preHandler: [fastify.authorize('agency_owner', 'agency_member')],
    schema: { tags: ['agency'], summary: 'Mes entreprises clientes' },
    handler: async (request, reply) => {
      const agencyId = (request.user as { agencyId?: string }).agencyId
      if (!agencyId) return reply.status(403).send({ error: 'Contexte cabinet manquant' })
      const res = await pool.query(
        `SELECT t.id, t.name, t.slug, t.city, t.primary_color, t.logo_url, t.status,
                t.default_country_code, t.plan_type
           FROM platform.agency_tenants lnk
           JOIN platform.tenants t ON t.id = lnk.tenant_id
          WHERE lnk.agency_id = $1 AND lnk.detached_at IS NULL
            AND t.status IN ('active','trial')
            AND upper(t.default_country_code) IN ('CIV','CI')
          ORDER BY t.name ASC`, [agencyId])
      return reply.send({ data: res.rows })
    },
  })

  // GET /agency/members — liste des membres du cabinet courant (owner).
  fastify.get('/members', {
    preHandler: [fastify.authorize('agency_owner')],
    schema: { tags: ['agency'], summary: 'Membres du cabinet' },
    handler: async (request, reply) => {
      const agencyId = (request.user as { agencyId?: string }).agencyId
      if (!agencyId) return reply.status(403).send({ error: 'Contexte cabinet manquant' })
      const res = await pool.query(
        `SELECT id, email, first_name, last_name, role, is_active, last_login_at, created_at
           FROM platform.agency_users WHERE agency_id = $1 ORDER BY created_at ASC`, [agencyId])
      return reply.send({ data: res.rows })
    },
  })

  // POST /agency/members — créer un membre/recruteur (owner uniquement).
  fastify.post('/members', {
    preHandler: [fastify.authorize('agency_owner')],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: { tags: ['agency'], summary: 'Créer un membre du cabinet' },
    handler: async (request, reply) => {
      const agencyId = (request.user as { agencyId?: string }).agencyId
      if (!agencyId) return reply.status(403).send({ error: 'Contexte cabinet manquant' })
      const parsed = createMemberBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation échouée',
          issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) })
      }
      const body = parsed.data
      const tempPassword = genTempPassword()
      const passwordHash = await bcrypt.hash(tempPassword, 12)
      try {
        const res = await pool.query<{ id: string }>(
          `INSERT INTO platform.agency_users (agency_id, email, password_hash, first_name, last_name, role, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
          [agencyId, body.email, passwordHash, body.firstName, body.lastName, body.role])
        auditLogPlatform(request.user.sub, 'agency.member.created', 'agency_user', res.rows[0]?.id ?? null,
          { agencyId, email: body.email, role: body.role }, request.ip ?? null)
        return reply.status(201).send({ data: { id: res.rows[0]?.id, email: body.email, role: body.role }, tempPassword })
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.status(409).send({ error: 'Cet email est déjà utilisé' })
        }
        throw err
      }
    },
  })

  // PATCH /agency/members/:id — modifier un membre (owner, même cabinet).
  fastify.patch('/members/:id', {
    preHandler: [fastify.authorize('agency_owner')],
    schema: { tags: ['agency'], summary: 'Modifier un membre du cabinet' },
    handler: async (request, reply) => {
      const agencyId = (request.user as { agencyId?: string }).agencyId
      if (!agencyId) return reply.status(403).send({ error: 'Contexte cabinet manquant' })
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = patchMemberBody.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation échouée' })
      // OWASP A01 — la cible DOIT appartenir au cabinet du token.
      const target = await pool.query<{ id: string }>(
        `SELECT id FROM platform.agency_users WHERE id = $1 AND agency_id = $2 LIMIT 1`, [id, agencyId])
      if (!target.rows[0]) return reply.status(404).send({ error: 'Membre introuvable' })

      const sets: string[] = []
      const vals: unknown[] = []
      let i = 1
      const b = parsed.data
      if (b.firstName !== undefined) { sets.push(`first_name = $${i++}`); vals.push(b.firstName) }
      if (b.lastName !== undefined) { sets.push(`last_name = $${i++}`); vals.push(b.lastName) }
      if (b.role !== undefined) { sets.push(`role = $${i++}`); vals.push(b.role) }
      if (b.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(b.isActive) }
      if (sets.length === 0) return reply.status(400).send({ error: 'Aucun champ à modifier' })
      sets.push(`updated_at = now()`)
      vals.push(id, agencyId)
      await pool.query(
        `UPDATE platform.agency_users SET ${sets.join(', ')} WHERE id = $${i++} AND agency_id = $${i}`, vals)
      auditLogPlatform(request.user.sub, 'agency.member.updated', 'agency_user', id, { agencyId, ...b }, request.ip ?? null)
      return reply.send({ data: { id, updated: true } })
    },
  })

  // POST /agency/client-tenants — le cabinet onboarde une entreprise cliente CI.
  fastify.post('/client-tenants', {
    preHandler: [fastify.authorize('agency_owner')],
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { tags: ['agency'], summary: 'Créer une entreprise cliente (CI)' },
    handler: async (request, reply) => {
      const agencyId = (request.user as { agencyId?: string }).agencyId
      if (!agencyId) return reply.status(403).send({ error: 'Contexte cabinet manquant' })
      const parsed = createClientTenantBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation échouée',
          issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) })
      }
      const body = parsed.data
      // Garde-fou CI strict : un cabinet ne crée que des tenants CI.
      const requestedCountry = 'CIV'
      if (!assertTenantIsCI(requestedCountry)) {
        return reply.status(422).send({ error: 'Un cabinet ne peut créer que des entreprises en Côte d\'Ivoire' })
      }

      // Expéditeur email fourni par le cabinet (From/Reply-To).
      const ag = await pool.query<{ sender_email: string | null; sender_name: string | null; logo_url: string | null }>(
        `SELECT sender_email, sender_name, logo_url FROM platform.agencies WHERE id = $1 LIMIT 1`, [agencyId])
      const sender = ag.rows[0]?.sender_email
        ? { email: ag.rows[0].sender_email, name: ag.rows[0].sender_name }
        : null

      let created
      try {
        created = await createTenantWithSchema(pool, { ...body, defaultCountryCode: 'CIV' }, {
          sender, logoUrl: body.logoUrl || null, logger: fastify.log,
        })
      } catch (err) {
        if (err instanceof TenantSlugConflictError) return reply.status(409).send({ error: err.message })
        throw err
      }

      // Rattachement automatique au cabinet créateur.
      await pool.query(
        `INSERT INTO platform.agency_tenants (agency_id, tenant_id, assigned_by)
         VALUES ($1, $2, $3) ON CONFLICT (agency_id, tenant_id) DO NOTHING`,
        [agencyId, created.id, request.user.sub])
      auditLogPlatform(request.user.sub, 'agency.client_tenant.created', 'tenant', created.id,
        { agencyId, slug: created.slug, adminEmail: body.adminEmail }, request.ip ?? null)

      return reply.status(201).send({
        data: { id: created.id, slug: created.slug, schemaName: created.schemaName, name: created.name },
        adminEmail: created.adminEmail, tempPassword: created.tempPassword,
        message: `Entreprise "${created.name}" créée et rattachée à votre cabinet.`,
      })
    },
  })

  // ════════════════════════════════════════════════════════════════════════
  // SUPER_ADMIN — pilotage des cabinets
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/agencies', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['agency'], summary: 'Liste des cabinets (super_admin)' },
    handler: async (request, reply) => {
      const { page = '1', limit = '20' } = request.query as Record<string, string>
      const offset = (parseInt(page) - 1) * parseInt(limit)
      const rows = await pool.query(
        `SELECT a.*,
                (SELECT count(*) FROM platform.agency_users au WHERE au.agency_id = a.id) AS users_count,
                (SELECT count(*) FROM platform.agency_tenants lnk WHERE lnk.agency_id = a.id AND lnk.detached_at IS NULL) AS tenants_count
           FROM platform.agencies a ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
        [parseInt(limit), offset])
      const total = await pool.query(`SELECT count(*) FROM platform.agencies`)
      return reply.send({ data: rows.rows, total: parseInt(total.rows[0]?.count ?? '0'),
        page: parseInt(page), limit: parseInt(limit) })
    },
  })

  fastify.post('/agencies', {
    preHandler: [fastify.authorize('super_admin')],
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { tags: ['agency'], summary: 'Créer un cabinet (super_admin)' },
    handler: async (request, reply) => {
      const parsed = createAgencyBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation échouée',
          issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) })
      }
      const body = parsed.data
      const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const exists = await pool.query(`SELECT id FROM platform.agencies WHERE slug = $1 LIMIT 1`, [slug])
      if (exists.rows[0]) return reply.status(409).send({ error: `Le slug "${slug}" est déjà utilisé` })

      const agencyRes = await pool.query<{ id: string }>(
        `INSERT INTO platform.agencies
           (slug, name, status, country_code, city, contact_email, contact_phone,
            primary_color, logo_url, sender_email, sender_name, created_by)
         VALUES ($1,$2,'active','CIV',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [slug, body.name, body.city ?? 'Abidjan', body.contactEmail ?? null, body.contactPhone ?? null,
         body.primaryColor ?? '#1D4ED8', body.logoUrl || null, body.senderEmail ?? null, body.senderName ?? null,
         request.user.sub])
      const agencyId = agencyRes.rows[0]?.id
      if (!agencyId) throw new Error('Erreur création cabinet')

      // 1er owner
      const tempPassword = genTempPassword()
      const passwordHash = await bcrypt.hash(tempPassword, 12)
      try {
        await pool.query(
          `INSERT INTO platform.agency_users (agency_id, email, password_hash, first_name, last_name, role, is_active)
           VALUES ($1,$2,$3,$4,$5,'agency_owner',true)`,
          [agencyId, body.ownerEmail, passwordHash, body.ownerFirstName, body.ownerLastName])
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.status(409).send({ error: 'Cet email owner est déjà utilisé' })
        }
        throw err
      }

      sendWelcomeAgencyEmail({
        to: body.ownerEmail, firstName: body.ownerFirstName, lastName: body.ownerLastName,
        agencyName: body.name, primaryColor: body.primaryColor ?? '#1D4ED8',
        loginUrl: `${config.appUrl}/login`, tempPassword, logoUrl: body.logoUrl || null,
      }).catch(err => fastify.log.warn({ err }, 'Email cabinet non envoyé'))

      auditLogPlatform(request.user.sub, 'agency.created', 'agency', agencyId,
        { slug, name: body.name, ownerEmail: body.ownerEmail }, request.ip ?? null)

      return reply.status(201).send({
        data: { id: agencyId, slug, name: body.name },
        ownerEmail: body.ownerEmail, tempPassword,
        message: `Cabinet "${body.name}" créé. Mot de passe owner transmis par email.`,
      })
    },
  })

  fastify.get('/agencies/:id', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['agency'], summary: 'Détail cabinet + clients (super_admin)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const a = await pool.query(`SELECT * FROM platform.agencies WHERE id = $1 LIMIT 1`, [id])
      if (!a.rows[0]) return reply.status(404).send({ error: 'Cabinet introuvable' })
      const users = await pool.query(
        `SELECT id, email, first_name, last_name, role, is_active, last_login_at
           FROM platform.agency_users WHERE agency_id = $1 ORDER BY created_at ASC`, [id])
      const tenants = await pool.query(
        `SELECT t.id, t.name, t.slug, t.city, t.status, t.default_country_code
           FROM platform.agency_tenants lnk JOIN platform.tenants t ON t.id = lnk.tenant_id
          WHERE lnk.agency_id = $1 AND lnk.detached_at IS NULL ORDER BY t.name ASC`, [id])
      return reply.send({ data: { ...a.rows[0], users: users.rows, tenants: tenants.rows } })
    },
  })

  fastify.patch('/agencies/:id', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['agency'], summary: 'Modifier un cabinet (super_admin)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = patchAgencyBody.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation échouée' })
      const b = parsed.data
      const map: Record<string, string> = {
        name: 'name', city: 'city', contactEmail: 'contact_email', contactPhone: 'contact_phone',
        primaryColor: 'primary_color', logoUrl: 'logo_url', senderEmail: 'sender_email', senderName: 'sender_name',
      }
      const sets: string[] = []
      const vals: unknown[] = []
      let i = 1
      for (const [k, col] of Object.entries(map)) {
        const v = (b as Record<string, unknown>)[k]
        if (v !== undefined) { sets.push(`${col} = $${i++}`); vals.push(v === '' ? null : v) }
      }
      if (sets.length === 0) return reply.status(400).send({ error: 'Aucun champ à modifier' })
      sets.push(`updated_at = now()`)
      vals.push(id)
      const res = await pool.query(`UPDATE platform.agencies SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, vals)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Cabinet introuvable' })
      auditLogPlatform(request.user.sub, 'agency.updated', 'agency', id, { ...b }, request.ip ?? null)
      return reply.send({ data: { id, updated: true } })
    },
  })

  // Suspension : status + révocation immédiate des tokens des membres (blacklist par sub).
  // Mise hors ligne avec message configurable (variable système surchageable) ;
  // option `includeClients` = mettre aussi hors ligne les tenants clients du cabinet.
  fastify.post('/agencies/:id/suspend', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['agency'], summary: 'Mettre un cabinet hors ligne (super_admin, avec message)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      // OWASP A03 — body optionnel validé strictement.
      const parsed = z.object({
        message: z.string().max(2000).optional(),
        includeClients: z.boolean().optional(),
      }).safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Corps de requête invalide (message ≤ 2000 caractères)' })
      }
      const policy = await getOfflineMessagePolicy(pool)
      const message = resolveOfflineMessage(parsed.data.message, policy)
      if (message === null) {
        return reply.status(400).send({
          error: 'Un message hors-ligne est obligatoire (politique plateforme). Renseignez-le ou définissez le message par défaut dans les paramètres.',
        })
      }
      const res = await pool.query(
        `UPDATE platform.agencies SET status='suspended', offline_message=$2, updated_at=now() WHERE id=$1 RETURNING id`,
        [id, message || null]
      ).catch(() =>
        // Repli pré-migration (colonne offline_message absente)
        pool.query(`UPDATE platform.agencies SET status='suspended', updated_at=now() WHERE id=$1 RETURNING id`, [id])
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Cabinet introuvable' })

      // « Un cabinet et ses clients hors usage » : cascade optionnelle sur les
      // tenants clients rattachés (non détachés). Même message hors-ligne.
      let clientsSuspended = 0
      if (parsed.data.includeClients === true) {
        const cascade = await pool.query(
          `UPDATE platform.tenants t
           SET status = 'suspended', offline_message = $2, updated_at = now()
           FROM platform.agency_tenants at
           WHERE at.tenant_id = t.id AND at.agency_id = $1 AND at.detached_at IS NULL
           RETURNING t.id`,
          [id, message || null]
        ).catch(() => ({ rows: [] as { id: string }[] }))
        clientsSuspended = cascade.rows.length
      }

      // Révoque immédiatement les sessions actives (contexte + scopées) des membres.
      const members = await pool.query<{ id: string }>(`SELECT id FROM platform.agency_users WHERE agency_id = $1`, [id])
      const ttl = 60 * 60 * 24 * 7
      await Promise.all(members.rows.map(m => blacklistTokenSafe(m.id, ttl)))
      invalidateOfflineStatusCache()
      auditLogPlatform(request.user.sub, 'agency.suspended', 'agency', id,
        { membersRevoked: members.rows.length, offlineMessage: message, clientsSuspended }, request.ip ?? null)
      return reply.send({ data: { id, status: 'suspended', offlineMessage: message, clientsSuspended } })
    },
  })

  fastify.post('/agencies/:id/reactivate', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['agency'], summary: 'Réactiver un cabinet (super_admin)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = z.object({ includeClients: z.boolean().optional() }).safeParse(request.body ?? {})
      if (!parsed.success) return reply.status(400).send({ error: 'Corps de requête invalide' })
      const res = await pool.query(
        `UPDATE platform.agencies SET status='active', offline_message=NULL, updated_at=now() WHERE id=$1 RETURNING id`, [id]
      ).catch(() =>
        pool.query(`UPDATE platform.agencies SET status='active', updated_at=now() WHERE id=$1 RETURNING id`, [id])
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Cabinet introuvable' })

      // Cascade optionnelle : réactiver aussi les tenants clients rattachés.
      let clientsReactivated = 0
      if (parsed.data.includeClients === true) {
        const cascade = await pool.query(
          `UPDATE platform.tenants t
           SET status = 'active', offline_message = NULL, updated_at = now()
           FROM platform.agency_tenants at
           WHERE at.tenant_id = t.id AND at.agency_id = $1 AND at.detached_at IS NULL
             AND t.status = 'suspended'
           RETURNING t.id`,
          [id]
        ).catch(() => ({ rows: [] as { id: string }[] }))
        clientsReactivated = cascade.rows.length
      }
      invalidateOfflineStatusCache()
      auditLogPlatform(request.user.sub, 'agency.reactivated', 'agency', id,
        { clientsReactivated }, request.ip ?? null)
      return reply.send({ data: { id, status: 'active', clientsReactivated } })
    },
  })

  // Rattachement d'un tenant CI existant à un cabinet (super_admin).
  fastify.post('/agencies/:id/tenants', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['agency'], summary: 'Rattacher un tenant CI à un cabinet' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = z.object({ tenantId: z.string().regex(UUID_RE) }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'tenantId requis (UUID)' })
      const agencyExists = await pool.query(`SELECT id FROM platform.agencies WHERE id = $1 LIMIT 1`, [id])
      if (!agencyExists.rows[0]) return reply.status(404).send({ error: 'Cabinet introuvable' })
      const t = await pool.query<{ default_country_code: string }>(
        `SELECT default_country_code FROM platform.tenants WHERE id = $1 LIMIT 1`, [parsed.data.tenantId])
      if (!t.rows[0]) return reply.status(404).send({ error: 'Tenant introuvable' })
      // Garde-fou CI strict.
      if (!assertTenantIsCI(t.rows[0].default_country_code)) {
        return reply.status(422).send({ error: 'Seules les entreprises en Côte d\'Ivoire peuvent être rattachées' })
      }
      await pool.query(
        `INSERT INTO platform.agency_tenants (agency_id, tenant_id, assigned_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (agency_id, tenant_id) DO UPDATE SET detached_at = NULL, assigned_by = $3, assigned_at = now()`,
        [id, parsed.data.tenantId, request.user.sub])
      auditLogPlatform(request.user.sub, 'agency.tenant.attached', 'tenant', parsed.data.tenantId,
        { agencyId: id }, request.ip ?? null)
      return reply.status(201).send({ data: { agencyId: id, tenantId: parsed.data.tenantId, attached: true } })
    },
  })

  // Détachement (soft) d'un tenant d'un cabinet (super_admin).
  fastify.delete('/agencies/:id/tenants/:tenantId', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['agency'], summary: 'Détacher un tenant d\'un cabinet' },
    handler: async (request, reply) => {
      const { id, tenantId } = request.params as { id: string; tenantId: string }
      if (!UUID_RE.test(id) || !UUID_RE.test(tenantId)) return reply.status(400).send({ error: 'id invalide' })
      const res = await pool.query(
        `UPDATE platform.agency_tenants SET detached_at = now()
          WHERE agency_id = $1 AND tenant_id = $2 AND detached_at IS NULL RETURNING id`,
        [id, tenantId])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Rattachement introuvable' })
      auditLogPlatform(request.user.sub, 'agency.tenant.detached', 'tenant', tenantId, { agencyId: id }, request.ip ?? null)
      return reply.send({ data: { agencyId: id, tenantId, detached: true } })
    },
  })
}

export default agencyRoutes
