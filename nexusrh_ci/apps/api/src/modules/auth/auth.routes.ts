import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { config } from '../../config.js'
import { blacklistTokenSafe } from '../../services/redis.js'

const pool = new Pool({ connectionString: config.database.url })

interface TenantCandidate {
  tenant: {
    id: string; schema_name: string; name: string; slug: string
    primary_color: string; secondary_color: string; logo_url: string | null
    city: string | null
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
  }>(`SELECT id, schema_name, name, slug, primary_color, secondary_color, logo_url, city
      FROM platform.tenants WHERE status IN ('active', 'trial')`)

  const candidates: TenantCandidate[] = []

  for (const tenant of tenantsRes.rows) {
    try {
      const userRes = await pool.query<{
        id: string; email: string; password_hash: string; role: string
        first_name: string; last_name: string; mfa_enabled: boolean; is_active: boolean
        last_login_at: string | null
      }>(
        `SELECT id, email, password_hash, role, first_name, last_name, mfa_enabled, is_active, last_login_at
         FROM "${tenant.schema_name}".users WHERE email = $1 LIMIT 1`,
        [email]
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
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string }

      if (!email || !password) {
        return reply.status(400).send({ error: 'Email et mot de passe requis' })
      }

      // 1. Vérifier si c'est un super_admin (platform)
      const platformRes = await pool.query<{
        id: string; email: string; password_hash: string; role: string
        first_name: string; last_name: string; mfa_enabled: boolean; is_active: boolean
      }>(
        `SELECT id, email, password_hash, role, first_name, last_name, mfa_enabled, is_active
         FROM platform.platform_users WHERE email = $1 LIMIT 1`,
        [email]
      )

      const platformUser = platformRes.rows[0]
      if (platformUser && platformUser.is_active) {
        const valid = await bcrypt.compare(password, platformUser.password_hash)
        if (valid) {
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
            [platformUser.id]
          )
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
      }

      // 2. Chercher dans les tenants
      const candidate = await findTenantAndUser(email, password, fastify.log)
      if (!candidate) {
        return reply.status(401).send({ error: 'Email ou mot de passe incorrect' })
      }

      const { tenant, user } = candidate

      // Trouver l'employeeId si lié
      let employeeId: string | null = null
      try {
        const empRes = await pool.query<{ id: string }>(
          `SELECT id FROM "${tenant.schema_name}".employees WHERE email = $1 LIMIT 1`,
          [email]
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

      // Mise à jour last_login_at (après évaluation du flag)
      await pool.query(
        `UPDATE "${tenant.schema_name}".users SET last_login_at = now() WHERE id = $1`,
        [user.id]
      )
      const redirectTo = user.role === 'employee' ? '/mon-espace' : '/dashboard'

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
        },
        redirectTo,
      })
    },
  })

  // POST /auth/refresh
  fastify.post('/refresh', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Renouveler le token' },
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
      // TTL = temps restant jusqu'à expiration du token (max 7j = 604800s)
      const exp = (user as unknown as { exp?: number }).exp
      const ttl = exp ? Math.max(exp - Math.floor(Date.now() / 1000), 0) : 604800
      await blacklistTokenSafe(jti, ttl)
      return reply.send({ message: 'Déconnecté avec succès' })
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
        }>(
          `SELECT id, name, slug, primary_color, secondary_color, logo_url, city
           FROM platform.tenants WHERE id = $1 LIMIT 1`,
          [user.tenantId]
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
    handler: async (request, reply) => {
      const { oldPassword, newPassword } = request.body as {
        oldPassword: string; newPassword: string
      }
      if (!oldPassword || !newPassword || newPassword.length < 8) {
        return reply.status(400).send({ error: 'Mot de passe invalide (min 8 caractères)' })
      }

      const user = request.user
      const table = user.schemaName === 'platform'
        ? 'platform.platform_users'
        : `"${user.schemaName}".users`

      const res = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM ${table} WHERE id = $1 LIMIT 1`,
        [user.sub]
      )
      const record = res.rows[0]
      if (!record) return reply.status(404).send({ error: 'Utilisateur introuvable' })

      const valid = await bcrypt.compare(oldPassword, record.password_hash)
      if (!valid) return reply.status(400).send({ error: 'Ancien mot de passe incorrect' })

      const newHash = await bcrypt.hash(newPassword, 12)
      await pool.query(
        `UPDATE ${table} SET password_hash = $1, updated_at = now() WHERE id = $2`,
        [newHash, user.sub]
      )

      return reply.send({ message: 'Mot de passe modifié avec succès' })
    },
  })
}

export default authRoutes
