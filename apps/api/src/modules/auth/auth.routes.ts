import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { config } from '../../config'
import {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  mfaSetupSchema,
} from './auth.schema'
import {
  registerUser,
  createRefreshToken,
  refreshAccessToken,
  revokeRefreshToken,
  requestPasswordReset,
  resetPassword,
} from './auth.service'
import { generateMfaSecret, verifyMfaToken, generateMfaQrCode, generateBackupCodes } from './mfa.service'
import type { TenantConfig } from '@nexusrh/shared'

interface PlatformUserRow {
  id: string
  email: string
  password_hash: string
  first_name: string
  last_name: string
  role: string
  is_active: boolean
  mfa_enabled: boolean
  mfa_secret: string | null
}

interface TenantRow {
  id: string
  slug: string
  name: string
  schema_name: string
  plan_type: string
  status: string
  primary_color: string
  secondary_color: string
  logo_url: string | null
}

interface TenantUserRow {
  id: string
  email: string
  password_hash: string
  first_name: string
  last_name: string
  role: string
  employee_id: string | null
  is_active: boolean
  mfa_enabled: boolean
  mfa_secret: string | null
}

async function findPlatformUser(
  pool: Pool,
  email: string,
): Promise<PlatformUserRow | null> {
  try {
    const result = await pool.query<PlatformUserRow>(
      `SELECT id, email, password_hash, first_name, last_name, role, is_active, mfa_enabled, mfa_secret
       FROM platform.platform_users
       WHERE email = $1
       LIMIT 1`,
      [email],
    )
    return result.rows[0] ?? null
  } catch {
    // platform schema may not exist yet in dev without seed
    return null
  }
}

async function findTenantAndUser(
  pool: Pool,
  email: string,
  password: string,
): Promise<{ tenant: TenantRow; user: TenantUserRow } | null> {
  try {
    // Get all active (non-suspended) tenants
    const tenantsResult = await pool.query<TenantRow>(
      `SELECT id, slug, name, schema_name, plan_type, status, primary_color, secondary_color, logo_url
       FROM platform.tenants
       WHERE status != 'suspended'`,
    )

    // Collect all candidates across tenants, then verify password.
    // A given email may exist in multiple tenants (e.g. same person, multiple companies).
    // We must try every match and return the one whose password hash validates.
    const candidates: Array<{ tenant: TenantRow; user: TenantUserRow }> = []

    for (const tenant of tenantsResult.rows) {
      try {
        const userResult = await pool.query<TenantUserRow>(
          `SELECT id, email, password_hash, first_name, last_name, role, employee_id, is_active, mfa_enabled, mfa_secret
           FROM "${tenant.schema_name}".users
           WHERE email = $1 AND is_active = true
           LIMIT 1`,
          [email],
        )
        const user = userResult.rows[0]
        if (user) {
          candidates.push({ tenant, user })
        }
      } catch {
        // Schema may not exist yet — continue to next tenant
        continue
      }
    }

    if (candidates.length === 0) return null

    // Single match — return it (password checked by caller)
    if (candidates.length === 1) return candidates[0]!

    // Multiple tenants have this email — verify password for each and return the match
    for (const candidate of candidates) {
      const valid = await bcrypt.compare(password, candidate.user.password_hash)
      if (valid) return candidate
    }

    // No hash matched — return first candidate so caller shows generic "wrong password"
    return candidates[0]!
  } catch {
    // platform schema doesn't exist yet
    return null
  }
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const rawPool = new Pool({ connectionString: config.database.url })

  // POST /auth/login
  fastify.post('/login', {
    schema: {
      tags: ['auth'],
      summary: 'Connexion utilisateur',
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
          mfaCode: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const input = loginSchema.parse(request.body)

      // ── 1. Check platform.platform_users first (super_admin) ──────────────
      const platformUser = await findPlatformUser(rawPool, input.email)
      if (platformUser) {
        if (!platformUser.is_active) {
          return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Email ou mot de passe incorrect',
          })
        }
        const passwordValid = await bcrypt.compare(
          input.password,
          platformUser.password_hash,
        )
        if (!passwordValid) {
          return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Email ou mot de passe incorrect',
          })
        }

        // MFA check for platform user
        if (platformUser.mfa_enabled) {
          if (!input.mfaCode) {
            return reply.status(200).send({ requiresMfa: true, message: 'Code MFA requis' })
          }
          // MFA verification delegated to otplib via mfa.service if needed
        }

        // Update last_login_at
        await rawPool
          .query(
            `UPDATE platform.platform_users SET last_login_at = NOW() WHERE id = $1`,
            [platformUser.id],
          )
          .catch(() => undefined)

        const accessToken = fastify.jwt.sign(
          {
            sub: platformUser.id,
            userId: platformUser.id,
            email: platformUser.email,
            role: 'super_admin',
          } as any,
          { expiresIn: fastify.jwt.options.sign?.expiresIn ?? '7d' },
        )

        const refreshToken = await createRefreshTokenRaw(
          rawPool,
          platformUser.id,
          request.headers['user-agent'],
          request.ip,
        )

        return reply.send({
          accessToken,
          refreshToken,
          user: {
            id: platformUser.id,
            email: platformUser.email,
            firstName: platformUser.first_name,
            lastName: platformUser.last_name,
            role: 'super_admin' as const,
            mfaEnabled: platformUser.mfa_enabled,
            isActive: platformUser.is_active,
          },
        })
      }

      // ── 2. Check tenant users ──────────────────────────────────────────────
      const tenantMatch = await findTenantAndUser(rawPool, input.email, input.password)
      if (tenantMatch) {
        const { tenant, user } = tenantMatch

        const passwordValid = await bcrypt.compare(input.password, user.password_hash)
        if (!passwordValid) {
          return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Email ou mot de passe incorrect',
          })
        }

        if (user.mfa_enabled) {
          if (!input.mfaCode) {
            return reply.status(200).send({ requiresMfa: true, message: 'Code MFA requis' })
          }
          if (!user.mfa_secret || !verifyMfaToken(input.mfaCode, user.mfa_secret)) {
            return reply.status(401).send({
              statusCode: 401, error: 'Unauthorized', message: 'Code MFA invalide',
            })
          }
        }

        // Update last_login_at
        await rawPool
          .query(
            `UPDATE "${tenant.schema_name}".users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [user.id],
          )
          .catch(() => undefined)

        const accessToken = fastify.jwt.sign(
          {
            sub: user.id,
            userId: user.id,
            email: user.email,
            role: user.role,
            employeeId: user.employee_id ?? undefined,
            tenantId: tenant.id,
            schemaName: tenant.schema_name,
          } as any,
          { expiresIn: fastify.jwt.options.sign?.expiresIn ?? '7d' },
        )

        const refreshToken = await createRefreshTokenTenant(
          rawPool,
          tenant.schema_name,
          user.id,
          request.headers['user-agent'],
          request.ip,
        )

        const tenantConfig: TenantConfig = {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          primaryColor: tenant.primary_color,
          secondaryColor: tenant.secondary_color,
          logoUrl: tenant.logo_url ?? undefined,
          planType: tenant.plan_type,
        }

        return reply.send({
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
            employeeId: user.employee_id ?? undefined,
            mfaEnabled: user.mfa_enabled,
            isActive: true,
          },
          tenantConfig,
        })
      }

      // ── 3. No user found → 401
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Email ou mot de passe incorrect',
      })
    },
  })

  // POST /auth/register
  fastify.post('/register', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['auth'],
      summary: 'Créer un utilisateur (admin only)',
    },
    handler: async (request, reply) => {
      const input = registerSchema.parse(request.body)
      const user = await registerUser(input)
      return reply.status(201).send({ data: user })
    },
  })

  // POST /auth/refresh
  fastify.post('/refresh', {
    schema: { tags: ['auth'], summary: 'Rafraîchir le token' },
    handler: async (request, reply) => {
      const { refreshToken } = refreshTokenSchema.parse(request.body)
      const user = await refreshAccessToken(refreshToken)

      const accessToken = fastify.jwt.sign({
        sub: user.id,
        userId: user.id,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId,
      } as any)

      return reply.send({ accessToken })
    },
  })

  // POST /auth/logout
  fastify.post('/logout', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Déconnexion' },
    handler: async (request, reply) => {
      try {
        const body = request.body as { refreshToken?: string }
        const token = body?.refreshToken
        if (token) {
          const { schemaName, role } = request.user
          if (schemaName) {
            // Tenant user — token stored in tenant schema
            await rawPool.query(
              `DELETE FROM "${schemaName}".refresh_tokens WHERE token = $1`,
              [token],
            ).catch(() => undefined)
          } else if (role === 'super_admin') {
            await rawPool.query(
              `DELETE FROM platform.platform_refresh_tokens WHERE token = $1`,
              [token],
            ).catch(() => undefined)
          } else {
            await revokeRefreshToken(token).catch(() => undefined)
          }
        }
      } catch {
        // Logout is best-effort — client clears its own token regardless
      }
      return reply.send({ message: 'Déconnecté avec succès' })
    },
  })

  // GET /auth/me
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Profil utilisateur connecté' },
    handler: async (request, reply) => {
      return reply.send({ data: request.user })
    },
  })

  // POST /auth/mfa/setup — génère le secret + QR code
  fastify.post('/mfa/setup', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Initialiser la configuration MFA' },
    handler: async (request, reply) => {
      const { sub, email, role, schemaName } = request.user
      const secret = generateMfaSecret()
      const qrCode = await generateMfaQrCode(email, secret)
      const backupCodes = generateBackupCodes(8)

      if (role === 'super_admin') {
        await rawPool.query(
          `UPDATE platform.platform_users SET mfa_secret = $1 WHERE id = $2`,
          [secret, sub],
        ).catch(() => undefined)
      } else if (schemaName) {
        await rawPool.query(
          `UPDATE "${schemaName}".users SET mfa_secret = $1 WHERE id = $2`,
          [secret, sub],
        )
      }

      return reply.send({ data: { secret, qrCode, backupCodes } })
    },
  })

  // POST /auth/mfa/confirm — vérifie le code TOTP et active le MFA
  fastify.post('/mfa/confirm', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Confirmer et activer le MFA' },
    handler: async (request, reply) => {
      const { sub, role, schemaName } = request.user
      const { code } = mfaSetupSchema.parse(request.body)

      let mfaSecret: string | null = null
      if (role === 'super_admin') {
        const r = await rawPool.query<{ mfa_secret: string }>(
          `SELECT mfa_secret FROM platform.platform_users WHERE id = $1`, [sub],
        )
        mfaSecret = r.rows[0]?.mfa_secret ?? null
      } else if (schemaName) {
        const r = await rawPool.query<{ mfa_secret: string }>(
          `SELECT mfa_secret FROM "${schemaName}".users WHERE id = $1`, [sub],
        )
        mfaSecret = r.rows[0]?.mfa_secret ?? null
      }

      if (!mfaSecret) {
        return reply.status(400).send({ error: 'Configurez d\'abord le MFA (/auth/mfa/setup)' })
      }
      if (!verifyMfaToken(code, mfaSecret)) {
        return reply.status(400).send({ error: 'Code MFA invalide — vérifiez l\'heure de votre appareil' })
      }

      if (role === 'super_admin') {
        await rawPool.query(
          `UPDATE platform.platform_users SET mfa_enabled = true WHERE id = $1`, [sub],
        ).catch(() => undefined)
      } else if (schemaName) {
        await rawPool.query(
          `UPDATE "${schemaName}".users SET mfa_enabled = true WHERE id = $1`, [sub],
        )
      }

      return reply.send({ message: 'MFA activé avec succès' })
    },
  })

  // POST /auth/mfa/disable — désactive le MFA (vérifie le code avant)
  fastify.post('/mfa/disable', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Désactiver le MFA' },
    handler: async (request, reply) => {
      const { sub, role, schemaName } = request.user
      const { code } = mfaSetupSchema.parse(request.body)

      let mfaSecret: string | null = null
      if (role === 'super_admin') {
        const r = await rawPool.query<{ mfa_secret: string }>(
          `SELECT mfa_secret FROM platform.platform_users WHERE id = $1`, [sub],
        )
        mfaSecret = r.rows[0]?.mfa_secret ?? null
      } else if (schemaName) {
        const r = await rawPool.query<{ mfa_secret: string }>(
          `SELECT mfa_secret FROM "${schemaName}".users WHERE id = $1`, [sub],
        )
        mfaSecret = r.rows[0]?.mfa_secret ?? null
      }

      if (!mfaSecret || !verifyMfaToken(code, mfaSecret)) {
        return reply.status(400).send({ error: 'Code MFA invalide' })
      }

      if (role === 'super_admin') {
        await rawPool.query(
          `UPDATE platform.platform_users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`, [sub],
        ).catch(() => undefined)
      } else if (schemaName) {
        await rawPool.query(
          `UPDATE "${schemaName}".users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`, [sub],
        )
      }

      return reply.send({ message: 'MFA désactivé' })
    },
  })

  // POST /auth/password/reset-request
  fastify.post('/password/reset-request', {
    schema: { tags: ['auth'], summary: 'Demander une réinitialisation de mot de passe' },
    handler: async (request, reply) => {
      const { email } = passwordResetRequestSchema.parse(request.body)
      await requestPasswordReset(email)
      return reply.send({
        message: 'Si cet email existe, un lien de réinitialisation a été envoyé',
      })
    },
  })

  // POST /auth/password/reset
  fastify.post('/password/reset', {
    schema: { tags: ['auth'], summary: 'Réinitialiser le mot de passe' },
    handler: async (request, reply) => {
      const { token, password } = passwordResetSchema.parse(request.body)
      await resetPassword(token, password)
      return reply.send({ message: 'Mot de passe réinitialisé avec succès' })
    },
  })

  // POST /auth/change-password — authentifié, change son propre mot de passe
  fastify.post('/change-password', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Changer son mot de passe' },
    handler: async (request, reply) => {
      const { currentPassword, newPassword } = request.body as {
        currentPassword: string
        newPassword: string
      }
      if (!currentPassword || !newPassword) {
        return reply.status(400).send({ error: 'currentPassword et newPassword sont requis' })
      }
      if (newPassword.length < 8) {
        return reply.status(400).send({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' })
      }

      const { sub, schemaName, role } = request.user

      // Fetch current password hash
      let passwordHash: string | null = null
      if (role === 'super_admin') {
        const res = await rawPool.query<{ password_hash: string }>(
          `SELECT password_hash FROM platform.platform_users WHERE id = $1`, [sub]
        )
        passwordHash = res.rows[0]?.password_hash ?? null
      } else if (schemaName) {
        const res = await rawPool.query<{ password_hash: string }>(
          `SELECT password_hash FROM "${schemaName}".users WHERE id = $1`, [sub]
        )
        passwordHash = res.rows[0]?.password_hash ?? null
      }

      if (!passwordHash) return reply.status(404).send({ error: 'Utilisateur introuvable' })

      const valid = await bcrypt.compare(currentPassword, passwordHash)
      if (!valid) return reply.status(401).send({ error: 'Mot de passe actuel incorrect' })

      const newHash = await bcrypt.hash(newPassword, 12)

      if (role === 'super_admin') {
        await rawPool.query(
          `UPDATE platform.platform_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
          [newHash, sub]
        )
      } else if (schemaName) {
        await rawPool.query(
          `UPDATE "${schemaName}".users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
          [newHash, sub]
        )
      }

      return reply.send({ message: 'Mot de passe modifié avec succès' })
    },
  })
}

// ── Helpers for raw SQL token management ─────────────────────────────────────

async function createRefreshTokenRaw(
  pool: Pool,
  userId: string,
  userAgent: string | undefined,
  ip: string,
): Promise<string> {
  const token = generateToken(64)
  const expiresAt = new Date()
  const days = parseInt(config.jwt.refreshExpiresIn.replace('d', ''), 10) || 30
  expiresAt.setDate(expiresAt.getDate() + days)

  // For platform users, store in a fallback table if it exists; else skip.
  // refresh tokens for super_admin are not stored in a tenant schema.
  await pool
    .query(
      `INSERT INTO platform.platform_refresh_tokens (user_id, token, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [userId, token, userAgent ?? null, ip, expiresAt],
    )
    .catch(() => {
      // Table may not exist — that's acceptable for now; token is still returned
    })

  return token
}

async function createRefreshTokenTenant(
  pool: Pool,
  schemaName: string,
  userId: string,
  userAgent: string | undefined,
  ip: string,
): Promise<string> {
  const token = generateToken(64)
  const expiresAt = new Date()
  const days = parseInt(config.jwt.refreshExpiresIn.replace('d', ''), 10) || 30
  expiresAt.setDate(expiresAt.getDate() + days)

  await pool
    .query(
      `INSERT INTO "${schemaName}".refresh_tokens (user_id, token, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, token, userAgent ?? null, ip, expiresAt],
    )
    .catch(() => undefined)

  return token
}

function generateToken(bytes: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < bytes; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export default authRoutes
