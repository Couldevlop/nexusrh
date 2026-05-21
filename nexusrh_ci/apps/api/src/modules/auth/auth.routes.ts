import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { config } from '../../config.js'
import { blacklistTokenSafe } from '../../services/redis.js'
import { buildMfaChallenge } from './auth-mfa.routes.js'
import { AUTH_COOKIE_NAME } from '../../plugins/auth.js'

// OWASP A02 — options du cookie httpOnly de session.
// httpOnly  : JS ne peut pas lire le cookie (anti-XSS exfiltration)
// secure    : envoyé uniquement en HTTPS (anti MITM, sauf en dev local)
// sameSite  : 'lax' = pas envoyé sur requêtes cross-site POST (anti-CSRF basique)
// path '/'  : disponible sur toutes les routes /api/*
// maxAge    : 7 jours par défaut (aligné JWT_EXPIRES_IN), ajustable
function authCookieOptions(): {
  httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string; maxAge: number
} {
  return {
    httpOnly: true,
    secure:   process.env['NODE_ENV'] === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   60 * 60 * 24 * 7,
  }
}

const pool = new Pool({ connectionString: config.database.url })

// OWASP A05 — sanity-check du nom de schema (defense in depth, le schema vient
// d'une jointure platform.tenants donc déjà sûr, mais regex empêche toute
// dérive future qui interpolerait un schema mal contrôlé).
const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/

// OWASP A02 — hash bcrypt "dummy" pré-calculé. Utilisé pour comparer même
// lorsque l'email est introuvable, afin de garder un temps de réponse
// constant (mitige timing attack qui révèlerait l'existence d'un email).
// Coût 12 rounds identique aux hashs réels.
const DUMMY_BCRYPT_HASH = '$2a$12$YmZvc2htYWxlc3BoZXJlb.uPnVfM7g8e4PYJVxLLDh89gGmJ8N3ge'

// OWASP A03 — schémas Zod stricts
const loginSchema = z.object({
  email:    z.string().email().max(254),
  password: z.string().min(1).max(256),
}).strict()

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
}).strict()

// OWASP A07 — rate-limits durcis sur les endpoints d'auth (cibles privilégiées
// du brute force et du credential stuffing).
const LOGIN_RATE_LIMIT           = { rateLimit: { max: 10, timeWindow: '5 minutes' } }
const CHANGE_PASSWORD_RATE_LIMIT = { rateLimit: { max: 5,  timeWindow: '5 minutes' } }
const REFRESH_RATE_LIMIT         = { rateLimit: { max: 60, timeWindow: '1 minute'  } }

// OWASP A09 — audit log non bloquant des actions d'auth (login OK/KO,
// logout, change password). Critique pour conformité (loi 2013-450 CI
// sur la cybercriminalité — exigence traçabilité 12 mois).
function auditLogAuth(
  schema: string, userId: string | null, action: string,
  changes: Record<string, unknown>, ip: string | null, userAgent: string | null,
): void {
  if (!SCHEMA_NAME_RE.test(schema)) return
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address, user_agent)
     VALUES ($1, $2, 'auth', NULL, $3, $4, $5)`,
    [userId, action, JSON.stringify(changes), ip, userAgent],
  ).catch(() => { /* tenant sans audit_log ou colonne user_agent absente : non bloquant */ })
}

interface TenantCandidate {
  tenant: {
    id: string; schema_name: string; name: string; slug: string
    primary_color: string; secondary_color: string; logo_url: string | null
    city: string | null
    has_subsidiaries: boolean
    payroll_mode: string
    default_country_code: string
  }
  user: {
    id: string; email: string; password_hash: string; role: string
    first_name: string; last_name: string; mfa_enabled: boolean
    is_active: boolean; last_login_at: string | null
  }
}

async function findTenantAndUser(
  email: string,
  password: string,
  log?: { warn: (msg: string) => void },
): Promise<TenantCandidate | null> {
  const tenantsRes = await pool.query<{
    id: string; schema_name: string; name: string; slug: string
    primary_color: string; secondary_color: string; logo_url: string | null
    city: string | null
    has_subsidiaries: boolean; payroll_mode: string; default_country_code: string
  }>(`SELECT id, schema_name, name, slug, primary_color, secondary_color, logo_url, city,
             has_subsidiaries, payroll_mode, default_country_code
      FROM platform.tenants WHERE status IN ('active', 'trial')`)

  const candidates: TenantCandidate[] = []

  for (const tenant of tenantsRes.rows) {
    if (!SCHEMA_NAME_RE.test(tenant.schema_name)) continue
    try {
      const userRes = await pool.query<{
        id: string; email: string; password_hash: string; role: string
        first_name: string; last_name: string; mfa_enabled: boolean; is_active: boolean
        last_login_at: string | null
      }>(
        `SELECT id, email, password_hash, role, first_name, last_name, mfa_enabled, is_active, last_login_at
         FROM "${tenant.schema_name}".users WHERE email = $1 LIMIT 1`,
        [email],
      )
      if (userRes.rows[0]) {
        candidates.push({ tenant, user: userRes.rows[0] })
      }
    } catch (err) {
      log?.warn(`[auth] schema ${tenant.schema_name} lookup failed: ${(err as Error).message}`)
    }
  }

  if (candidates.length === 0) {
    log?.warn(`[auth] no user found across ${tenantsRes.rows.length} tenants`)
    return null
  }

  for (const c of candidates) {
    if (!c.user.is_active) {
      log?.warn(`[auth] inactive user in ${c.tenant.schema_name}`)
      continue
    }
    const valid = await bcrypt.compare(password, c.user.password_hash)
    if (valid) return c
    log?.warn(`[auth] password mismatch in ${c.tenant.schema_name}`)
  }

  return null
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /auth/login
  fastify.post('/login', {
    schema: { tags: ['auth'], summary: 'Connexion unifiée (super_admin + tenant)' },
    config: LOGIN_RATE_LIMIT,
    handler: async (request, reply) => {
      // OWASP A03 — validation Zod stricte (rejette champs inconnus, email mal formé)
      const parsed = loginSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Email et mot de passe requis' })
      }
      const { email, password } = parsed.data
      const ip   = request.ip ?? null
      const ua   = request.headers['user-agent']?.slice(0, 500) ?? null

      try {
        // 1. Vérifier si c'est un super_admin (platform)
        const platformRes = await pool.query<{
          id: string; email: string; password_hash: string; role: string
          first_name: string; last_name: string; mfa_enabled: boolean; is_active: boolean
        }>(
          `SELECT id, email, password_hash, role, first_name, last_name, mfa_enabled, is_active
           FROM platform.platform_users WHERE email = $1 LIMIT 1`,
          [email],
        )

        const platformUser = platformRes.rows[0]
        if (platformUser && platformUser.is_active) {
          const valid = await bcrypt.compare(password, platformUser.password_hash)
          if (valid) {
            // MFA actif : émet un challenge 3min au lieu du JWT final.
            // Le client doit ensuite appeler POST /auth/mfa/login-verify avec
            // le code TOTP (ou backup) pour obtenir le vrai token.
            if (platformUser.mfa_enabled) {
              const challenge = buildMfaChallenge(fastify, {
                sub: platformUser.id, schemaName: 'platform', tenantId: null,
              })
              auditLogAuth('platform', platformUser.id, 'auth.login.mfa_required', { scope: 'platform' }, ip, ua)
              return reply.status(202).send({
                mfaRequired: true,
                challenge,
                message: 'Saisissez votre code TOTP pour finaliser la connexion',
              })
            }

            const token = fastify.jwt.sign({
              sub:        platformUser.id,
              tenantId:   null,
              schemaName: 'platform',
              role:       'super_admin',
              email:      platformUser.email,
              firstName:  platformUser.first_name,
              lastName:   platformUser.last_name,
              employeeId: null,
            })
            await pool.query(
              `UPDATE platform.platform_users SET updated_at = now() WHERE id = $1`,
              [platformUser.id],
            )
            auditLogAuth('platform', platformUser.id, 'auth.login.success', { scope: 'platform' }, ip, ua)
            // OWASP A02 — pose le JWT en cookie httpOnly (mode SPA). Le client
            // browser n'a plus à manipuler le token en JS. Les clients API
            // peuvent toujours utiliser le `token` renvoyé en JSON dans Authorization.
            reply.setCookie(AUTH_COOKIE_NAME, token, authCookieOptions())
            return reply.send({
              token,
              user: {
                sub:        platformUser.id,
                tenantId:   null,
                schemaName: 'platform',
                email:      platformUser.email,
                firstName:  platformUser.first_name,
                lastName:   platformUser.last_name,
                role:       'super_admin',
                employeeId: null,
              },
              tenantConfig: null,
              redirectTo: '/platform/dashboard',
            })
          }
        } else if (!platformUser) {
          // OWASP A02 — bcrypt dummy pour temps de réponse constant même
          // quand l'email est introuvable (timing attack mitigation).
          await bcrypt.compare(password, DUMMY_BCRYPT_HASH)
        }

        // 2. Chercher dans les tenants
        const candidate = await findTenantAndUser(email, password, fastify.log)
        if (!candidate) {
          // OWASP A09 — log de l'échec, sans révéler le motif au client
          auditLogAuth('platform', null, 'auth.login.failed', { email, reason: 'invalid_credentials' }, ip, ua)
          return reply.status(401).send({ error: 'Email ou mot de passe incorrect' })
        }

        const { tenant, user } = candidate

        // MFA actif sur ce user : émet un challenge 3min au lieu du JWT final.
        // Le client doit ensuite appeler POST /auth/mfa/login-verify avec le
        // code TOTP (ou backup) pour obtenir le vrai token. last_login_at
        // n'est PAS mis à jour ici (login non finalisé).
        if (user.mfa_enabled) {
          const challenge = buildMfaChallenge(fastify, {
            sub: user.id, schemaName: tenant.schema_name, tenantId: tenant.id,
          })
          auditLogAuth(
            tenant.schema_name, user.id, 'auth.login.mfa_required',
            { role: user.role }, ip, ua,
          )
          return reply.status(202).send({
            mfaRequired: true,
            challenge,
            message: 'Saisissez votre code TOTP pour finaliser la connexion',
          })
        }

        // Trouver l'employeeId si lié
        let employeeId: string | null = null
        try {
          const empRes = await pool.query<{ id: string }>(
            `SELECT id FROM "${tenant.schema_name}".employees WHERE email = $1 LIMIT 1`,
            [email],
          )
          employeeId = empRes.rows[0]?.id ?? null
        } catch {
          // pas d'employé lié
        }

        const token = fastify.jwt.sign({
          sub:        user.id,
          tenantId:   tenant.id,
          schemaName: tenant.schema_name,
          role:       user.role,
          email:      user.email,
          firstName:  user.first_name,
          lastName:   user.last_name,
          employeeId,
        })

        const mustChangePassword = !user.last_login_at

        await pool.query(
          `UPDATE "${tenant.schema_name}".users SET last_login_at = now() WHERE id = $1`,
          [user.id],
        )
        const redirectTo = user.role === 'employee' ? '/mon-espace' : '/dashboard'

        auditLogAuth(
          tenant.schema_name, user.id, 'auth.login.success',
          { role: user.role, mustChangePassword, hasEmployeeLink: !!employeeId },
          ip, ua,
        )

        // OWASP A02 — cookie httpOnly mode SPA (cf. helper authCookieOptions)
        reply.setCookie(AUTH_COOKIE_NAME, token, authCookieOptions())

        return reply.send({
          token,
          must_change_password: mustChangePassword,
          user: {
            sub:        user.id,
            tenantId:   tenant.id,
            schemaName: tenant.schema_name,
            email:      user.email,
            firstName:  user.first_name,
            lastName:   user.last_name,
            role:       user.role,
            employeeId,
          },
          tenantConfig: {
            id:             tenant.id,
            name:           tenant.name,
            slug:           tenant.slug,
            primaryColor:   tenant.primary_color,
            secondaryColor: tenant.secondary_color,
            logoUrl:        tenant.logo_url,
            city:           tenant.city,
            hasSubsidiaries:    tenant.has_subsidiaries,
            payrollMode:        tenant.payroll_mode,
            defaultCountryCode: tenant.default_country_code,
          },
          redirectTo,
        })
      } catch (err) {
        // OWASP A10 — ne pas leak les détails internes (DB down, etc.)
        fastify.log.error({ err: (err as Error).message }, '[auth] login error')
        return reply.status(503).send({ error: 'Service indisponible, réessayez dans un instant' })
      }
    },
  })

  // POST /auth/refresh
  fastify.post('/refresh', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Renouveler le token' },
    config: REFRESH_RATE_LIMIT,
    handler: async (request, reply) => {
      const user = request.user
      const newToken = fastify.jwt.sign({
        sub:        user.sub,
        tenantId:   user.tenantId,
        schemaName: user.schemaName,
        role:       user.role,
        email:      user.email,
        firstName:  user.firstName,
        lastName:   user.lastName,
        employeeId: user.employeeId,
      })
      return reply.send({ token: newToken })
    },
  })

  // POST /auth/logout
  fastify.post('/logout', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Déconnexion' },
    handler: async (request, reply) => {
      const user = request.user
      const jti = (user as unknown as { jti?: string }).jti ?? user.sub
      const exp = (user as unknown as { exp?: number }).exp
      const ttl = exp ? Math.max(exp - Math.floor(Date.now() / 1000), 0) : 604800
      await blacklistTokenSafe(jti, ttl)
      // OWASP A02 — révoque le cookie httpOnly (mode SPA browser)
      reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' })
      auditLogAuth(
        user.schemaName, user.sub, 'auth.logout',
        { jti },
        request.ip ?? null,
        request.headers['user-agent']?.slice(0, 500) ?? null,
      )
      return reply.send({ message: 'Déconnecté avec succès' })
    },
  })

  // ── GET /auth/csrf-token : émet un token CSRF (double-submit pattern) ─────
  // Le client SPA appelle cet endpoint au boot, stocke le token retourné en
  // mémoire (PAS dans un cookie pour pouvoir l'injecter en header), puis
  // l'envoie dans X-CSRF-Token sur chaque POST/PATCH/PUT/DELETE.
  // Le serveur valide que header.csrf === jwt.aud='csrf' && sub === user.sub.
  // Sans ce token, les mutations cookie-authentifiées sont refusées (anti-CSRF).
  fastify.get('/csrf-token', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Émettre un token CSRF (double-submit pattern)' },
    handler: async (request, reply) => {
      const csrfToken = fastify.jwt.sign(
        { sub: request.user.sub, aud: 'csrf' } as unknown as Parameters<typeof fastify.jwt.sign>[0],
        { expiresIn: '1h' },
      )
      return reply.send({ csrfToken })
    },
  })

  // GET /auth/me
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Profil utilisateur courant' },
    handler: async (request, reply) => {
      const user = request.user
      let tenantConfig = null

      if (user.tenantId) {
        const res = await pool.query<{
          id: string; name: string; slug: string
          primary_color: string; secondary_color: string
          logo_url: string | null; city: string | null
          has_subsidiaries: boolean; payroll_mode: string; default_country_code: string
        }>(
          `SELECT id, name, slug, primary_color, secondary_color, logo_url, city,
                  has_subsidiaries, payroll_mode, default_country_code
           FROM platform.tenants WHERE id = $1 LIMIT 1`,
          [user.tenantId],
        )
        const t = res.rows[0]
        if (t) {
          tenantConfig = {
            id:             t.id,
            name:           t.name,
            slug:           t.slug,
            primaryColor:   t.primary_color,
            secondaryColor: t.secondary_color,
            logoUrl:        t.logo_url,
            city:           t.city,
            hasSubsidiaries:    t.has_subsidiaries,
            payrollMode:        t.payroll_mode,
            defaultCountryCode: t.default_country_code,
          }
        }
      }

      return reply.send({
        user: {
          id:         user.sub,
          email:      user.email,
          firstName:  user.firstName,
          lastName:   user.lastName,
          role:       user.role,
          employeeId: user.employeeId,
        },
        tenantConfig,
      })
    },
  })

  // POST /auth/change-password
  fastify.post('/change-password', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Changer le mot de passe' },
    config: CHANGE_PASSWORD_RATE_LIMIT,
    handler: async (request, reply) => {
      // OWASP A03 — validation Zod stricte (min 8 chars)
      const parsed = changePasswordSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Mot de passe invalide (min 8 caractères)' })
      }
      const { oldPassword, newPassword } = parsed.data

      const user = request.user
      // OWASP A03 — schema validé contre regex avant interpolation dans le nom de table
      if (user.schemaName !== 'platform' && !SCHEMA_NAME_RE.test(user.schemaName)) {
        return reply.status(400).send({ error: 'Schema invalide' })
      }
      const table = user.schemaName === 'platform'
        ? 'platform.platform_users'
        : `"${user.schemaName}".users`

      const res = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM ${table} WHERE id = $1 LIMIT 1`,
        [user.sub],
      )
      const record = res.rows[0]
      if (!record) return reply.status(404).send({ error: 'Utilisateur introuvable' })

      const valid = await bcrypt.compare(oldPassword, record.password_hash)
      if (!valid) {
        auditLogAuth(
          user.schemaName, user.sub, 'auth.password.change_failed',
          { reason: 'wrong_old_password' },
          request.ip ?? null,
          request.headers['user-agent']?.slice(0, 500) ?? null,
        )
        return reply.status(400).send({ error: 'Ancien mot de passe incorrect' })
      }

      const newHash = await bcrypt.hash(newPassword, 12)
      await pool.query(
        `UPDATE ${table} SET password_hash = $1, updated_at = now() WHERE id = $2`,
        [newHash, user.sub],
      )

      auditLogAuth(
        user.schemaName, user.sub, 'auth.password.changed',
        {},
        request.ip ?? null,
        request.headers['user-agent']?.slice(0, 500) ?? null,
      )

      return reply.send({ message: 'Mot de passe modifié avec succès' })
    },
  })
}

export default authRoutes
