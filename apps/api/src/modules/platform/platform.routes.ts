import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { z } from 'zod'
import { config } from '../../config'
import { createTenantSchema, hashPassword } from '../../db/provisioning'
import { generateSecureToken } from '../../utils/helpers'
import { uploadFile } from '../../services/storage.service'
import { sendWelcomeEmail } from '../../services/email.service'

// Default quotas by plan
const PLAN_DEFAULTS: Record<string, { maxUsers: number; maxEmployees: number }> = {
  trial:      { maxUsers: 10,   maxEmployees: 20   },
  starter:    { maxUsers: 50,   maxEmployees: 100  },
  pro:        { maxUsers: 200,  maxEmployees: 500  },
  enterprise: { maxUsers: 9999, maxEmployees: 9999 },
}

interface TenantRow {
  id: string
  slug: string
  name: string
  plan_type: string
  status: string
  schema_name: string
  max_users: number
  max_employees: number
  primary_color: string
  secondary_color: string
  logo_url: string | null
  favicon_url: string | null
  custom_domain: string | null
  trial_ends_at: string | null
  created_at: string
  updated_at: string
}

interface TenantUserRow {
  id: string
  email: string
  first_name: string
  last_name: string
  role: string
  is_active: boolean
  created_at: string
}

interface TenantStats {
  userCount: number
  employeeCount: number
}

const createTenantBody = z.object({
  // Step 1
  name: z.string().min(2).max(255),
  slug: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, 'Slug: lettres minuscules, chiffres et tirets uniquement'),
  planType: z.enum(['trial', 'starter', 'pro', 'enterprise']).default('trial'),
  status: z.enum(['active', 'trial']).optional(),
  maxUsers: z.number().int().positive().optional(),
  maxEmployees: z.number().int().positive().optional(),
  country: z.string().length(2).default('FR'),
  sector: z.string().optional(),
  // Step 2
  adminEmail: z.string().email(),
  adminFirstName: z.string().min(1).max(100),
  adminLastName: z.string().min(1).max(100),
  adminPhone: z.string().optional(),
  // Step 3
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#4F46E5'),
  secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#818CF8'),
  logoUrl: z.string().url().optional().nullable(),
})

const updateTenantBody = z.object({
  name: z.string().min(2).max(255).optional(),
  planType: z.enum(['trial', 'starter', 'pro', 'enterprise']).optional(),
  status: z.enum(['active', 'suspended', 'trial']).optional(),
  maxUsers: z.number().int().positive().optional(),
  maxEmployees: z.number().int().positive().optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  logoUrl: z.string().url().optional().nullable(),
  faviconUrl: z.string().url().optional().nullable(),
  customDomain: z.string().optional().nullable(),
  trialEndsAt: z.string().datetime().optional().nullable(),
})

const platformRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = new Pool({ connectionString: config.database.url })

  // ── GET /platform/dashboard ──────────────────────────────────────────────
  fastify.get('/dashboard', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'KPIs plateforme' },
    handler: async (_request, reply) => {
      try {
        const [tenantsRes, usersRes] = await Promise.all([
          pool.query<{ status: string; plan_type: string; schema_name: string }>(
            `SELECT status, plan_type, schema_name FROM platform.tenants`,
          ),
          pool.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM platform.platform_users WHERE is_active = true`,
          ),
        ])

        const tenants = tenantsRes.rows
        const activeCount = tenants.filter((t) => t.status === 'active').length
        const trialCount = tenants.filter((t) => t.status === 'trial').length
        const suspendedCount = tenants.filter((t) => t.status === 'suspended').length
        const platformUserCount = parseInt(usersRes.rows[0]?.count ?? '0', 10)

        // Count total employees across all tenants
        let totalEmployees = 0
        for (const tenant of tenants) {
          try {
            const empRes = await pool.query<{ count: string }>(
              `SELECT COUNT(*) AS count FROM "${tenant.schema_name}".employees WHERE status = 'active' AND deleted_at IS NULL`,
            )
            totalEmployees += parseInt(empRes.rows[0]?.count ?? '0', 10)
          } catch {
            // Schema may not have employees table yet
          }
        }

        // Estimate MRR
        const planPrices: Record<string, number> = {
          trial: 0,
          starter: 99,
          pro: 299,
          enterprise: 799,
        }
        const mrrEstimate = tenants
          .filter((t) => t.status === 'active')
          .reduce((acc, t) => acc + (planPrices[t.plan_type] ?? 0), 0)

        // Trials expiring in < 7 days
        const trialsExpiringSoon = await pool.query<TenantRow>(
          `SELECT id, name, slug, trial_ends_at FROM platform.tenants
           WHERE status = 'trial' AND trial_ends_at IS NOT NULL
             AND trial_ends_at <= NOW() + INTERVAL '7 days'`,
        )

        return reply.send({
          data: {
            kpis: {
              activeTenants: activeCount,
              trialTenants: trialCount,
              suspendedTenants: suspendedCount,
              totalEmployees,
              platformUsers: platformUserCount,
              mrrEstimate,
            },
            alerts: {
              trialsExpiringSoon: trialsExpiringSoon.rows,
              suspendedTenants: tenants.filter((t) => t.status === 'suspended'),
            },
          },
        })
      } catch (err) {
        fastify.log.error({ err }, 'platform dashboard error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors du chargement du tableau de bord' })
      }
    },
  })

  // ── GET /platform/tenants ────────────────────────────────────────────────
  fastify.get('/tenants', {
    preHandler: [fastify.authorize('super_admin')],
    schema: {
      tags: ['platform'],
      summary: 'Liste paginée des tenants',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          status: { type: 'string' },
          search: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const query = request.query as { page?: number; limit?: number; status?: string; search?: string }
        const page = Math.max(1, query.page ?? 1)
        const limit = Math.min(100, Math.max(1, query.limit ?? 20))
        const offset = (page - 1) * limit

        const conditions: string[] = []
        const params: unknown[] = []
        let paramIdx = 1

        if (query.status) {
          conditions.push(`status = $${paramIdx++}`)
          params.push(query.status)
        }
        if (query.search) {
          conditions.push(`(name ILIKE $${paramIdx} OR slug ILIKE $${paramIdx})`)
          params.push(`%${query.search}%`)
          paramIdx++
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
        const countRes = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM platform.tenants ${where}`,
          params,
        )
        const total = parseInt(countRes.rows[0]?.count ?? '0', 10)

        params.push(limit, offset)
        const tenantsRes = await pool.query<TenantRow>(
          `SELECT * FROM platform.tenants ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          params,
        )

        // Enrich with user + employee counts
        const enriched = await Promise.all(
          tenantsRes.rows.map(async (t) => {
            const stats = await getTenantStats(pool, t.schema_name)
            return { ...t, ...stats }
          }),
        )

        return reply.send({
          data: enriched,
          meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        })
      } catch (err) {
        fastify.log.error({ err }, 'list tenants error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors du chargement des tenants' })
      }
    },
  })

  // ── POST /platform/tenants ───────────────────────────────────────────────
  fastify.post('/tenants', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Créer un nouveau tenant' },
    handler: async (request, reply) => {
      try {
        const body = createTenantBody.parse(request.body)

        // Check slug uniqueness
        const existing = await pool.query<{ id: string }>(
          `SELECT id FROM platform.tenants WHERE slug = $1`,
          [body.slug],
        )
        if (existing.rows.length > 0) {
          return reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: `Un tenant avec le slug "${body.slug}" existe déjà`,
          })
        }

        // Generate temporary password for admin
        const tempPassword = `${body.adminFirstName}${Math.floor(1000 + Math.random() * 9000)}!`
        const adminPasswordHash = await hashPassword(tempPassword)

        // Compute trial end date (14 days from now for trial plan)
        const trialEndsAt =
          body.planType === 'trial'
            ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
            : null

        // a. Insert into platform.tenants
        const schemaName = `tenant_${body.slug.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`
        const planDefaults = PLAN_DEFAULTS[body.planType] ?? { maxUsers: 50, maxEmployees: 100 }
        const maxUsers = body.maxUsers ?? planDefaults.maxUsers
        const maxEmployees = body.maxEmployees ?? planDefaults.maxEmployees
        const tenantRes = await pool.query<TenantRow>(
          `INSERT INTO platform.tenants
            (slug, name, plan_type, status, schema_name, max_users, max_employees,
             primary_color, secondary_color, logo_url, trial_ends_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            body.slug,
            body.name,
            body.planType,
            body.status ?? (body.planType === 'trial' ? 'trial' : 'active'),
            schemaName,
            maxUsers,
            maxEmployees,
            body.primaryColor,
            body.secondaryColor,
            body.logoUrl ?? null,
            trialEndsAt,
          ],
        )

        const tenant = tenantRes.rows[0]
        if (!tenant) {
          throw new Error('Failed to insert tenant into platform.tenants')
        }

        // b. CREATE SCHEMA + tables + admin user (provisioning)
        const { adminUserId } = await createTenantSchema(
          body.slug,
          body.adminEmail,
          body.adminFirstName,
          body.adminLastName,
          adminPasswordHash,
          body.name,
        )

        // c. Generate invitation token
        const invitationToken = generateSecureToken(32)
        const invitationExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

        await pool
          .query(
            `INSERT INTO platform.tenant_invitations (tenant_id, email, role, token, expires_at)
             VALUES ($1, $2, 'admin', $3, $4)`,
            [tenant.id, body.adminEmail, invitationToken, invitationExpiry],
          )
          .catch(() => undefined)

        fastify.log.info({ tenantId: tenant.id, slug: body.slug, adminUserId }, 'Tenant created')

        // d. Send welcome email with temp password
        sendWelcomeEmail(
          body.adminEmail,
          body.adminFirstName,
          body.adminLastName,
          body.name,
          `${config.app.url}/login`,
          tempPassword,
        ).catch((emailErr) => {
          fastify.log.warn({ emailErr, to: body.adminEmail }, 'Welcome email failed — temp password returned in response')
        })

        return reply.status(201).send({
          data: {
            tenant,
            adminUserId,
            tempPassword, // Also returned for super_admin to copy in case email fails
            invitationToken,
          },
        })
      } catch (err) {
        fastify.log.error({ err }, 'create tenant error')
        if (err instanceof z.ZodError) {
          return reply.status(422).send({ statusCode: 422, error: 'Validation Error', message: err.message })
        }
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors de la création du tenant' })
      }
    },
  })

  // ── GET /platform/tenants/:id ────────────────────────────────────────────
  fastify.get('/tenants/:id', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Détail tenant' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const res = await pool.query<TenantRow>(
          `SELECT * FROM platform.tenants WHERE id = $1`,
          [id],
        )
        const tenant = res.rows[0]
        if (!tenant) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tenant introuvable' })
        }
        const stats = await getTenantStats(pool, tenant.schema_name)
        return reply.send({ data: { ...tenant, ...stats } })
      } catch (err) {
        fastify.log.error({ err }, 'get tenant error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors du chargement du tenant' })
      }
    },
  })

  // ── PUT /platform/tenants/:id ────────────────────────────────────────────
  fastify.put('/tenants/:id', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Modifier un tenant' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const body = updateTenantBody.parse(request.body)

        const setClauses: string[] = ['updated_at = NOW()']
        const params: unknown[] = []
        let paramIdx = 1

        const fieldMap: Record<string, string> = {
          name: 'name',
          planType: 'plan_type',
          status: 'status',
          maxUsers: 'max_users',
          maxEmployees: 'max_employees',
          primaryColor: 'primary_color',
          secondaryColor: 'secondary_color',
          logoUrl: 'logo_url',
          faviconUrl: 'favicon_url',
          customDomain: 'custom_domain',
          trialEndsAt: 'trial_ends_at',
        }

        for (const [key, col] of Object.entries(fieldMap)) {
          const val = (body as Record<string, unknown>)[key]
          if (val !== undefined) {
            setClauses.push(`${col} = $${paramIdx++}`)
            params.push(val)
          }
        }

        params.push(id)
        const res = await pool.query<TenantRow>(
          `UPDATE platform.tenants SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
          params,
        )
        const tenant = res.rows[0]
        if (!tenant) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tenant introuvable' })
        }
        return reply.send({ data: tenant })
      } catch (err) {
        fastify.log.error({ err }, 'update tenant error')
        if (err instanceof z.ZodError) {
          return reply.status(422).send({ statusCode: 422, error: 'Validation Error', message: err.message })
        }
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors de la mise à jour du tenant' })
      }
    },
  })

  // ── POST /platform/tenants/:id/suspend ───────────────────────────────────
  fastify.post('/tenants/:id/suspend', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Suspendre un tenant' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const res = await pool.query<TenantRow>(
          `UPDATE platform.tenants SET status = 'suspended', updated_at = NOW() WHERE id = $1 RETURNING *`,
          [id],
        )
        if (!res.rows[0]) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tenant introuvable' })
        }
        return reply.send({ data: res.rows[0], message: 'Tenant suspendu' })
      } catch (err) {
        fastify.log.error({ err }, 'suspend tenant error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors de la suspension' })
      }
    },
  })

  // ── POST /platform/tenants/:id/activate ──────────────────────────────────
  fastify.post('/tenants/:id/activate', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Réactiver un tenant' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const res = await pool.query<TenantRow>(
          `UPDATE platform.tenants SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING *`,
          [id],
        )
        if (!res.rows[0]) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tenant introuvable' })
        }
        return reply.send({ data: res.rows[0], message: 'Tenant réactivé' })
      } catch (err) {
        fastify.log.error({ err }, 'activate tenant error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors de la réactivation' })
      }
    },
  })

  // ── DELETE /platform/tenants/:id ─────────────────────────────────────────
  fastify.delete('/tenants/:id', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Supprimer un tenant définitivement' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const res = await pool.query<TenantRow>(
          `SELECT schema_name, name FROM platform.tenants WHERE id = $1`,
          [id],
        )
        const tenant = res.rows[0]
        if (!tenant) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tenant introuvable' })
        }
        const safe = tenant.schema_name.replace(/[^a-z0-9_]/gi, '')
        await pool.query(`DROP SCHEMA IF EXISTS "${safe}" CASCADE`)
        await pool.query(`DELETE FROM platform.tenant_invitations WHERE tenant_id = $1`, [id])
        await pool.query(`DELETE FROM platform.tenants WHERE id = $1`, [id])
        fastify.log.info({ tenantId: id, schema: safe }, 'Tenant supprimé')
        return reply.status(204).send()
      } catch (err) {
        fastify.log.error({ err }, 'delete tenant error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors de la suppression du tenant' })
      }
    },
  })

  // ── GET /platform/tenants/:id/users ──────────────────────────────────────
  fastify.get('/tenants/:id/users', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Utilisateurs d\'un tenant' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const tenantRes = await pool.query<TenantRow>(
          `SELECT schema_name FROM platform.tenants WHERE id = $1`,
          [id],
        )
        const tenant = tenantRes.rows[0]
        if (!tenant) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tenant introuvable' })
        }

        const usersRes = await pool.query<TenantUserRow>(
          `SELECT id, email, first_name, last_name, role, is_active, created_at
           FROM "${tenant.schema_name}".users
           ORDER BY created_at ASC`,
        )
        return reply.send({ data: usersRes.rows })
      } catch (err) {
        fastify.log.error({ err }, 'get tenant users error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors du chargement des utilisateurs' })
      }
    },
  })

  // ── GET /platform/logs ───────────────────────────────────────────────────
  fastify.get('/logs', {
    preHandler: [fastify.authorize('super_admin')],
    schema: {
      tags: ['platform'],
      summary: 'Logs d\'activité cross-tenant',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const query = request.query as { page?: number; limit?: number }
        const page = Math.max(1, query.page ?? 1)
        const limit = Math.min(100, query.limit ?? 50)
        const offset = (page - 1) * limit

        // Aggregate logs from all tenant schemas
        const tenantsRes = await pool.query<{ schema_name: string; name: string }>(
          `SELECT schema_name, name FROM platform.tenants ORDER BY created_at DESC LIMIT 20`,
        )

        const allLogs: Array<Record<string, unknown>> = []

        for (const tenant of tenantsRes.rows) {
          try {
            const logsRes = await pool.query<Record<string, unknown>>(
              `SELECT id, user_id, action, entity_type, entity_id, ip_address, created_at,
                      '${tenant.name}' AS tenant_name, '${tenant.schema_name}' AS schema_name
               FROM "${tenant.schema_name}".audit_log
               ORDER BY created_at DESC
               LIMIT $1`,
              [Math.ceil(limit / tenantsRes.rows.length) + 5],
            )
            allLogs.push(...logsRes.rows)
          } catch {
            continue
          }
        }

        // Sort combined logs by created_at desc
        allLogs.sort((a, b) => {
          const dateA = new Date((a['created_at'] as string) ?? 0).getTime()
          const dateB = new Date((b['created_at'] as string) ?? 0).getTime()
          return dateB - dateA
        })

        const paginated = allLogs.slice(offset, offset + limit)

        return reply.send({
          data: paginated,
          meta: { total: allLogs.length, page, limit },
        })
      } catch (err) {
        fastify.log.error({ err }, 'platform logs error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors du chargement des logs' })
      }
    },
  })

  // ── POST /platform/tenants/:id/logo ─────────────────────────────────────
  fastify.post('/tenants/:id/logo', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Uploader le logo d\'un tenant' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const data = await request.file()
        if (!data) {
          return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Aucun fichier reçu' })
        }
        if (!data.mimetype.startsWith('image/')) {
          return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Seules les images sont acceptées' })
        }
        const buffer = await data.toBuffer()

        let logoUrl: string
        try {
          // Try S3/MinIO first
          const result = await uploadFile(buffer, data.filename, 'tenant-logos', data.mimetype)
          logoUrl = result.url
        } catch (storageErr) {
          // Fallback: store as base64 data URI (works without MinIO)
          fastify.log.warn({ storageErr }, 'Storage unavailable — storing logo as base64 data URI')
          logoUrl = `data:${data.mimetype};base64,${buffer.toString('base64')}`
        }

        await pool.query(
          `UPDATE platform.tenants SET logo_url = $1, updated_at = NOW() WHERE id = $2`,
          [logoUrl, id],
        )
        return reply.send({ data: { logoUrl } })
      } catch (err) {
        fastify.log.error({ err }, 'upload tenant logo error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors de l\'upload du logo' })
      }
    },
  })

  // ── POST /platform/tenants/:id/reset-admin ───────────────────────────────
  fastify.post('/tenants/:id/reset-admin', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Réinitialiser le mot de passe admin du tenant' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const tenantRes = await pool.query<TenantRow>(
          `SELECT schema_name FROM platform.tenants WHERE id = $1`,
          [id],
        )
        const tenant = tenantRes.rows[0]
        if (!tenant) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tenant introuvable' })
        }

        // Find the admin user
        const adminRes = await pool.query<{ id: string; email: string; first_name: string }>(
          `SELECT id, email, first_name FROM "${tenant.schema_name}".users WHERE role = 'admin' LIMIT 1`,
        )
        const admin = adminRes.rows[0]
        if (!admin) {
          return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Aucun admin trouvé pour ce tenant' })
        }

        // Generate new temp password
        const newTempPassword = `${admin.first_name}${Math.floor(1000 + Math.random() * 9000)}!`
        const newHash = await hashPassword(newTempPassword)

        await pool.query(
          `UPDATE "${tenant.schema_name}".users SET password_hash = $1, is_active = true, updated_at = NOW() WHERE id = $2`,
          [newHash, admin.id],
        )

        fastify.log.info({ tenantId: id, adminEmail: admin.email }, 'Admin password reset')

        return reply.send({
          data: {
            adminEmail: admin.email,
            tempPassword: newTempPassword,
          },
          message: 'Mot de passe administrateur réinitialisé',
        })
      } catch (err) {
        fastify.log.error({ err }, 'reset admin error')
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Erreur lors de la réinitialisation' })
      }
    },
  })

  // ── GET /platform/tenants/:id/admin-status ───────────────────────────────
  fastify.get('/tenants/:id/admin-status', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Diagnostic état admin du tenant' },
    handler: async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const tenantRes = await pool.query<TenantRow>(
          `SELECT id, slug, name, schema_name, status FROM platform.tenants WHERE id = $1`,
          [id],
        )
        const tenant = tenantRes.rows[0]
        if (!tenant) {
          return reply.status(404).send({ error: 'Tenant introuvable' })
        }

        // Check if schema exists
        const schemaCheck = await pool.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists`,
          [tenant.schema_name],
        )
        const schemaExists = schemaCheck.rows[0]?.exists ?? false

        if (!schemaExists) {
          return reply.send({
            data: {
              tenantStatus: tenant.status,
              schemaExists: false,
              adminUser: null,
              issue: 'Schema non provisionné — relancer la création ou reprovisionner',
            },
          })
        }

        // Check admin user in tenant schema
        const adminRes = await pool.query<{
          id: string; email: string; first_name: string; last_name: string
          is_active: boolean; password_hash: string | null; role: string
        }>(
          `SELECT id, email, first_name, last_name, is_active, password_hash, role
           FROM "${tenant.schema_name}".users WHERE role = 'admin' LIMIT 1`,
        )
        const admin = adminRes.rows[0] ?? null

        return reply.send({
          data: {
            tenantStatus: tenant.status,
            schemaExists: true,
            adminUser: admin ? {
              id: admin.id,
              email: admin.email,
              name: `${admin.first_name} ${admin.last_name}`,
              isActive: admin.is_active,
              hasPasswordHash: !!admin.password_hash,
              role: admin.role,
            } : null,
            issue: !admin
              ? 'Aucun admin trouvé — utilisez reset-admin pour en créer un'
              : !admin.is_active
              ? 'Admin inactif — utilisez reset-admin pour réactiver'
              : !admin.password_hash
              ? 'Mot de passe manquant — utilisez reset-admin pour en définir un'
              : null,
          },
        })
      } catch (err) {
        fastify.log.error({ err }, 'admin-status error')
        return reply.status(500).send({ error: 'Erreur diagnostic' })
      }
    },
  })

  // ── GET /platform/backups — liste les backups ────────────────────────────
  fastify.get('/backups', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Historique des backups' },
    handler: async (_request, reply) => {
      try {
        const { rows } = await pool.query(
          `SELECT id, status, file_key, file_size, duration_ms, error, created_at, completed_at
           FROM platform.backup_jobs ORDER BY created_at DESC LIMIT 50`
        )
        return reply.send({ data: rows })
      } catch {
        return reply.send({ data: [] })
      }
    },
  })

  // ── POST /platform/backups/trigger — déclencher un backup immédiat ───────
  fastify.post('/backups/trigger', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Déclencher un backup immédiat' },
    handler: async (_request, reply) => {
      try {
        const { Queue } = await import('bullmq')
        const { createClient } = await import('redis')
        const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
        const IORedis = (await import('ioredis')).default
        const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null })
        const backupQueue = new Queue('backup', { connection: redis })
        const job = await backupQueue.add('manual-backup', { triggeredBy: 'super_admin' })
        await redis.quit()
        return reply.status(202).send({
          message: 'Backup déclenché',
          data: { jobId: job.id },
        })
      } catch (err) {
        fastify.log.error({ err }, 'Erreur déclenchement backup')
        return reply.status(500).send({ error: 'Impossible de déclencher le backup' })
      }
    },
  })

  // ── GET /platform/onboarding-status — first-login check ─────────────────
  fastify.get('/onboarding-status', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Statut onboarding super_admin' },
    handler: async (request, reply) => {
      try {
        const { rows: userRows } = await pool.query<{ onboarding_completed: boolean }>(
          `SELECT onboarding_completed FROM platform.platform_users WHERE id=$1`,
          [request.user.sub],
        )
        const onboardingCompleted = userRows[0]?.onboarding_completed ?? false

        const { rows: tenantRows } = await pool.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM platform.tenants`
        )
        const tenantCount = parseInt(tenantRows[0]?.count ?? '0', 10)

        return reply.send({
          data: {
            onboardingCompleted,
            tenantCount,
            needsOnboarding: !onboardingCompleted || tenantCount === 0,
          },
        })
      } catch {
        return reply.send({ data: { onboardingCompleted: false, tenantCount: 0, needsOnboarding: true } })
      }
    },
  })

  // ── POST /platform/onboarding/complete — marquer l'onboarding terminé ───
  fastify.post('/onboarding/complete', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Marquer onboarding terminé' },
    handler: async (request, reply) => {
      try {
        await pool.query(
          `UPDATE platform.platform_users SET onboarding_completed=true WHERE id=$1`,
          [request.user.sub],
        )
        return reply.send({ message: 'Onboarding marqué terminé' })
      } catch (err) {
        fastify.log.error({ err }, 'onboarding/complete error')
        return reply.status(500).send({ error: 'Erreur mise à jour onboarding' })
      }
    },
  })

  // ── POST /platform/smtp/test — tester la configuration email ─────────────
  fastify.post('/smtp/test', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Tester la configuration SMTP' },
    handler: async (request, reply) => {
      const { email } = request.body as { email?: string }
      const targetEmail = email ?? request.user.email
      try {
        const { testSmtpConnection } = await import('../../services/email.service')
        await testSmtpConnection(targetEmail)
        return reply.send({ success: true, message: `Email de test envoyé à ${targetEmail}` })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.send({ success: false, message: msg })
      }
    },
  })

  // ── GET /platform/settings ───────────────────────────────────────────────
  fastify.get('/settings', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Paramètres globaux plateforme' },
    handler: async (_request, reply) => {
      return reply.send({
        data: {
          appName: config.app.name,
          appUrl: config.app.url,
          features: {
            aiAssistant: process.env['FEATURE_AI_ASSISTANT'] === 'true',
            predictiveAnalytics: process.env['FEATURE_PREDICTIVE_ANALYTICS'] === 'true',
            electronicSignature: process.env['FEATURE_ELECTRONIC_SIGNATURE'] === 'true',
            multiCountry: process.env['FEATURE_MULTI_COUNTRY'] === 'true',
            kioskMode: process.env['FEATURE_KIOSK_MODE'] === 'true',
          },
        },
      })
    },
  })
}

async function getTenantStats(pool: Pool, schemaName: string): Promise<TenantStats> {
  try {
    const [usersRes, empsRes] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "${schemaName}".users WHERE is_active = true`,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "${schemaName}".employees WHERE status = 'active' AND deleted_at IS NULL`,
      ),
    ])
    return {
      userCount: parseInt(usersRes.rows[0]?.count ?? '0', 10),
      employeeCount: parseInt(empsRes.rows[0]?.count ?? '0', 10),
    }
  } catch {
    return { userCount: 0, employeeCount: 0 }
  }
}

export default platformRoutes
