import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { config } from '../../config.js'
import { provisionTenantSchema, seedPayrollRulesCI, seedAbsenceTypesCI } from '../../db/provisioning.js'
import { sendPasswordResetEmail } from '../../services/email.js'
import { maintenanceCache } from '../../cache.js'
import { createTenantWithSchema, TenantSlugConflictError } from '../../services/tenant-provisioning.service.js'
import { listLegislationPacks } from '../../services/legislation-packs.js'
import { invalidateSourcingConfigCache as invalidateConfigCache } from '../../services/sourcing-config.service.js'
import { z } from 'zod'

// ─── Schémas Zod (OWASP A03 Injection + A05 Misconfiguration) ───────────────
// Validation systématique des bodies. Le error handler global mappe ZodError
// vers 400 avec issues exploitables côté client.

const createTenantBodySchema = z.object({
  name: z.string().min(1, 'Nom requis').max(200),
  slug: z.string().min(2).max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug : lettres minuscules, chiffres, tirets uniquement'),
  planType: z.enum(['trial', 'starter', 'business', 'enterprise', 'public_sector']).optional(),
  sector: z.string().max(50).optional(),
  city: z.string().max(100).optional(),
  cnpsNumber: z.string().max(50).optional(),
  dgiNumber: z.string().max(50).optional(),
  rccm: z.string().max(100).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur hex requise').optional(),
  secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  logoUrl: z.string().url().or(z.literal('')).optional(),
  adminEmail: z.string().email('Email admin invalide'),
  adminFirstName: z.string().min(1).max(100).optional().default('Admin'),
  adminLastName: z.string().min(1).max(100).optional().default('Tenant'),
  adminPhone: z.string().max(30).optional(),
  seedDemoData: z.boolean().optional(),
  hasSubsidiaries: z.boolean().optional(),
  payrollMode: z.enum(['single_country', 'multi_country']).optional(),
  defaultCountryCode: z.string().length(3).optional(),
})

const pool = new Pool({ connectionString: config.database.url })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// OWASP A09 — audit log non bloquant pour les actions super_admin sensibles
// (création tenant, modifications, suspensions, suppressions). Ces événements
// ont un impact catastrophique : trace OBLIGATOIRE en cas d'incident/forensics.
function auditLogPlatform(
  userId: string, action: string, entity: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO platform.audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, entity, entityId, JSON.stringify(changes), ip],
  ).catch(() => { /* table audit_log absente : non bloquant */ })
}

const platformRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /platform/legislation-packs ───────────────────────────────────────
  // Liste les packs législatifs disponibles (CIV-2024 active, autres stub).
  fastify.get('/legislation-packs', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Liste des packs législatifs (multi-pays)' },
    handler: async (_request, reply) => {
      return reply.send({ data: listLegislationPacks() })
    },
  })

  // ── GET /platform/tenants ─────────────────────────────────────────────────
  fastify.get('/tenants', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Liste tous les tenants' },
    handler: async (request, reply) => {
      const { page = '1', limit = '20', status } = request.query as Record<string, string>
      const offset = (parseInt(page) - 1) * parseInt(limit)
      const VALID_STATUSES = ['active', 'suspended', 'trial']
      const safeStatus = status && VALID_STATUSES.includes(status) ? status : null
      const params: unknown[] = [parseInt(limit), offset]
      const whereClause = safeStatus ? `WHERE t.status = $3` : ''
      if (safeStatus) params.push(safeStatus)
      const rows = await pool.query(
        `SELECT * FROM platform.tenants t ${whereClause}
         ORDER BY t.created_at DESC
         LIMIT $1 OFFSET $2`,
        params
      ).catch(async () => {
        return pool.query(
          `SELECT * FROM platform.tenants ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
          [parseInt(limit), offset]
        )
      })
      const total = await pool.query(`SELECT count(*) FROM platform.tenants`)
      return reply.send({
        data: rows.rows,
        total: parseInt(total.rows[0]?.count ?? '0'),
        page: parseInt(page),
        limit: parseInt(limit),
      })
    },
  })

  // ── GET /platform/tenants/:id ─────────────────────────────────────────────
  fastify.get('/tenants/:id', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Détail d\'un tenant' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const res = await pool.query(
        `SELECT * FROM platform.tenants WHERE id = $1 LIMIT 1`, [id]
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Tenant introuvable' })
      return reply.send({ data: res.rows[0] })
    },
  })

  // ── POST /platform/tenants ────────────────────────────────────────────────
  // OWASP A07 — rate-limit anti-spam : création tenant = action très coûteuse
  // (provision schéma + seeds + envoi email) ET catastrophique en cas d'abus
  // (super_admin compromis pourrait créer des milliers de tenants fantômes).
  fastify.post('/tenants', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Créer un nouveau tenant CI' },
    handler: async (request, reply) => {
      // OWASP A03 (Injection) + A05 : validation Zod systématique
      const parsed = createTenantBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      // Pipeline de provisionnement centralisé (service partagé avec le module
      // cabinet). Comportement identique à l'ancien handler inline.
      let created
      try {
        created = await createTenantWithSchema(pool, body, { logger: fastify.log })
      } catch (err) {
        if (err instanceof TenantSlugConflictError) {
          return reply.status(409).send({ error: err.message })
        }
        throw err
      }

      // OWASP A09 : trace de la création de tenant (action super_admin
      // catastrophique : ajout d'une organisation entière au système).
      auditLogPlatform(request.user.sub, 'tenant.created', 'tenant', created.id, {
        slug: created.slug, name: body.name, planType: created.planType,
        adminEmail: body.adminEmail,
        hasSubsidiaries: body.hasSubsidiaries ?? false,
        seedDemoData: body.seedDemoData ?? false,
      }, request.ip ?? null)

      return reply.status(201).send({
        data: { id: created.id, slug: created.slug, schemaName: created.schemaName, name: body.name, planType: created.planType },
        adminEmail:   body.adminEmail,
        // tempPassword volontairement retourné comme filet de sécurité si l'email
        // échoue (cf. CLAUDE.md). NE PAS dupliquer dans message ci-dessous —
        // le message ne doit pas véhiculer le secret en clair vers les logs HTTP.
        tempPassword: created.tempPassword,
        message: `Tenant "${body.name}" créé avec succès. Mot de passe transmis par email.`,
      })
    },
  })

  // ── PATCH /platform/tenants/:id ───────────────────────────────────────────
  fastify.patch('/tenants/:id', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Modifier un tenant' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      // OWASP A03 : UUID validation stricte avant UPDATE
      if (!UUID_RE.test(id)) {
        return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      }
      const body = request.body as Record<string, unknown>
      const allowed = ['name','plan_type','status','primary_color','secondary_color',
                       'logo_url','max_users','max_employees','trial_ends_at','city','sector',
                       'has_subsidiaries','payroll_mode','default_country_code',
                       // OWASP A07 — surcharge MFA durcissante par tenant (super_admin)
                       'mfa_required']
      const sets: string[] = []
      const vals: unknown[] = []
      const modifiedFields: string[] = []
      let idx = 1
      for (const [k, v] of Object.entries(body)) {
        if (allowed.includes(k)) {
          // mfa_required est un booléen strict (durcissement de politique)
          const val = k === 'mfa_required'
            ? (v === true || v === 'true' || v === 1 || v === '1')
            : v
          sets.push(`${k} = $${idx++}`)
          vals.push(val)
          modifiedFields.push(k)
        }
      }
      if (sets.length === 0) return reply.status(400).send({ error: 'Aucun champ valide' })

      // OWASP A04 (Insecure Design) : activer le multi-pays IMPOSE que le schéma
      // tenant porte déjà les colonnes/contraintes du workflow multi-filiales.
      // On (re)provisionne AVANT de basculer le flag — sinon un ancien tenant se
      // retrouverait avec has_subsidiaries=true mais des routes en erreur 500.
      // provisionTenantSchema est entièrement idempotent (CREATE/ALTER IF NOT EXISTS).
      if (body.has_subsidiaries === true) {
        const sres = await pool.query<{ schema_name: string | null }>(
          `SELECT schema_name FROM platform.tenants WHERE id = $1 LIMIT 1`, [id],
        )
        const schemaName = sres.rows[0]?.schema_name
        if (!schemaName) {
          return reply.status(409).send({
            error: 'Tenant mal provisionné (schema_name absent) — multi-pays non activable. Réparez via reset-admin.',
          })
        }
        try {
          await provisionTenantSchema(schemaName)
        } catch (err) {
          request.log.error({ err, tenantId: id, schemaName }, 'Échec provisionnement multi-pays — flag non basculé')
          return reply.status(500).send({
            error: 'Échec de la préparation du schéma multi-pays. Le tenant n\'a pas été modifié.',
          })
        }
        // OWASP A09 : trace l'événement structurel sensible (active le workflow paie).
        auditLogPlatform(request.user.sub, 'tenant.subsidiaries_enabled', 'tenant', id,
          { schemaName }, request.ip ?? null)
      }

      sets.push(`updated_at = now()`)
      vals.push(id)
      await pool.query(
        `UPDATE platform.tenants SET ${sets.join(', ')} WHERE id = $${idx}`,
        vals
      )

      // OWASP A09 : trace les modifications de tenant (changement de plan,
      // suspension, changement statut → impacts contractuels et conformité)
      auditLogPlatform(request.user.sub, 'tenant.updated', 'tenant', id, {
        modifiedFields,
        // Inclut les nouvelles valeurs pour status/plan_type qui sont les plus
        // sensibles (impact: bascule active↔suspended, downgrade de plan)
        newStatus:   typeof body.status === 'string' ? body.status : undefined,
        newPlanType: typeof body.plan_type === 'string' ? body.plan_type : undefined,
      }, request.ip ?? null)
      const res = await pool.query(`SELECT * FROM platform.tenants WHERE id = $1`, [id])
      return reply.send({ data: res.rows[0] })
    },
  })

  // ── POST /platform/tenants/:id/suspend ────────────────────────────────────
  fastify.post('/tenants/:id/suspend', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Suspendre un tenant' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      await pool.query(
        `UPDATE platform.tenants SET status = 'suspended', updated_at = now() WHERE id = $1`, [id]
      )
      return reply.send({ message: 'Tenant suspendu' })
    },
  })

  // ── POST /platform/tenants/:id/reactivate ────────────────────────────────
  fastify.post('/tenants/:id/reactivate', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Réactiver un tenant' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      await pool.query(
        `UPDATE platform.tenants SET status = 'active', updated_at = now() WHERE id = $1`, [id]
      )
      return reply.send({ message: 'Tenant réactivé' })
    },
  })

  // ── POST /platform/tenants/:id/reset-admin ───────────────────────────────
  // Body optionnel : { adminEmail, firstName, lastName } pour mode auto-réparation
  // (re-provisionne le schéma si manquant + crée l'admin si manquant).
  fastify.post('/tenants/:id/reset-admin', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Réinitialiser le mot de passe admin d\'un tenant (+ auto-repair si body fourni)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { adminEmail?: string; firstName?: string; lastName?: string }
      const repairMode = Boolean(body.adminEmail && body.firstName && body.lastName)

      try {
        const res = await pool.query<{
          schema_name: string; name: string; slug: string; at_rate: string | null
          primary_color: string | null; city: string | null
        }>(
          `SELECT schema_name, name, slug, at_rate, primary_color, city FROM platform.tenants WHERE id = $1 LIMIT 1`, [id]
        )
        const tenant = res.rows[0]
        if (!tenant) return reply.status(404).send({ error: 'Tenant introuvable' })

        // Calculer schema_name effectif (auto-réparer si vide)
        let schemaName = tenant.schema_name
        if (!schemaName) {
          if (!repairMode) {
            request.log.error({ tenantId: id }, 'reset-admin: schema_name vide')
            return reply.status(409).send({
              error: 'Tenant mal provisionné : schema_name absent. Utilisez le mode réparation (fournir adminEmail/firstName/lastName).',
            })
          }
          schemaName = `tenant_${tenant.slug.replace(/[^a-z0-9_]/g, '_')}`
          await pool.query(`UPDATE platform.tenants SET schema_name = $1, updated_at = now() WHERE id = $2`, [schemaName, id])
          request.log.warn({ tenantId: id, schemaName }, 'reset-admin: schema_name réparé')
        }

        // Vérifier présence du schéma en base
        const schemaCheck = await pool.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists`,
          [schemaName],
        )
        if (!schemaCheck.rows[0]?.exists) {
          if (!repairMode) {
            request.log.error({ tenantId: id, schemaName }, 'reset-admin: schéma absent en base')
            return reply.status(409).send({
              error: `Schéma "${schemaName}" introuvable. Utilisez le mode réparation (fournir adminEmail/firstName/lastName) pour le provisionner.`,
            })
          }
          request.log.warn({ schemaName }, 'reset-admin: provisionnement du schéma manquant')
          await provisionTenantSchema(schemaName)
          const atRate = tenant.at_rate ? parseFloat(tenant.at_rate) : 0.02
          await seedPayrollRulesCI(schemaName, atRate)
          await seedAbsenceTypesCI(schemaName)
        }

        // Chercher admin existant
        const adminRes = await pool.query<{ id: string; email: string }>(
          `SELECT id, email FROM "${schemaName}".users WHERE role = 'admin' LIMIT 1`
        )
        let admin = adminRes.rows[0]

        // Créer admin si absent (mode repair) — sinon 409
        if (!admin) {
          if (!repairMode) {
            return reply.status(409).send({
              error: 'Aucun utilisateur admin dans ce tenant. Utilisez le mode réparation pour en créer un.',
            })
          }
          const tempPassword = `CI_${randomBytes(6).toString('base64url').toUpperCase()}!`
          const passwordHash = await bcrypt.hash(tempPassword, 12)
          const inserted = await pool.query<{ id: string; email: string }>(
            `INSERT INTO "${schemaName}".users (email, password_hash, first_name, last_name, role, is_active)
             VALUES ($1, $2, $3, $4, 'admin', true)
             RETURNING id, email`,
            [body.adminEmail!.toLowerCase(), passwordHash, body.firstName!, body.lastName!],
          )
          admin = inserted.rows[0]!
          request.log.warn({ tenantId: id, email: admin.email }, 'reset-admin: admin créé via mode réparation')

          sendPasswordResetEmail({
            to: admin.email, firstName: body.firstName!, tempPassword,
            loginUrl: `${config.appUrl}/login`,
            tenantName: tenant.name,
            primaryColor: tenant.primary_color ?? '#E85D04',
            tenantCity: tenant.city,
          }).catch(err => request.log.warn({ err }, 'reset-admin: envoi email échoué (non bloquant)'))

          return reply.send({ adminEmail: admin.email, tempPassword, tenantName: tenant.name, repaired: true })
        }

        // Cas nominal : reset password d'un admin existant
        const tempPassword = `CI_${randomBytes(6).toString('base64url').toUpperCase()}!`
        const passwordHash = await bcrypt.hash(tempPassword, 12)
        await pool.query(
          `UPDATE "${schemaName}".users SET password_hash = $1, is_active = true, updated_at = now() WHERE id = $2`,
          [passwordHash, admin.id]
        )

        sendPasswordResetEmail({
          to:           admin.email,
          firstName:    admin.email.split('@')[0] ?? 'Admin',
          tempPassword,
          loginUrl:     `${config.appUrl}/login`,
          tenantName:   tenant.name,
          primaryColor: tenant.primary_color ?? '#E85D04',
          tenantCity:   tenant.city,
        }).catch(err => request.log.warn({ err }, 'reset-admin: envoi email échoué (non bloquant)'))

        return reply.send({ adminEmail: admin.email, tempPassword, tenantName: tenant.name })
      } catch (err) {
        request.log.error({ err, tenantId: id, repairMode }, 'reset-admin: erreur interne')
        return reply.status(500).send({
          error: 'Erreur interne lors de la réinitialisation. Consultez les logs API.',
        })
      }
    },
  })

  // ── GET /platform/tenants/:id/admin-status ────────────────────────────────
  fastify.get('/tenants/:id/admin-status', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Diagnostic admin d\'un tenant' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const tenantRes = await pool.query<{ schema_name: string; name: string }>(
        `SELECT schema_name, name FROM platform.tenants WHERE id = $1 LIMIT 1`, [id]
      )
      const tenant = tenantRes.rows[0]
      if (!tenant) return reply.status(404).send({ error: 'Tenant introuvable' })

      try {
        const adminRes = await pool.query(
          `SELECT id, email, is_active, mfa_enabled,
                  (password_hash IS NOT NULL AND password_hash != '') AS has_hash
           FROM "${tenant.schema_name}".users WHERE role = 'admin' LIMIT 1`
        )
        return reply.send({
          schemaExists: true,
          tenantName: tenant.name,
          adminUser: adminRes.rows[0] ?? null,
        })
      } catch {
        return reply.send({ schemaExists: false, tenantName: tenant.name, adminUser: null })
      }
    },
  })

  // ── GET /platform/settings ───────────────────────────────────────────────
  fastify.get('/settings', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Paramètres plateforme' },
    handler: async (_request, reply) => {
      // Retourner les settings stockés + infos de la plateforme
      const res = await pool.query(
        `SELECT * FROM platform.platform_settings ORDER BY created_at ASC LIMIT 1`
      ).catch(async () => {
        // Table n'existe pas encore, la créer
        await pool.query(`
          CREATE TABLE IF NOT EXISTS platform.platform_settings (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            app_name        varchar(100) DEFAULT 'NexusRH CI',
            app_url         varchar(255) DEFAULT 'http://localhost:3001',
            support_email   varchar(255) DEFAULT 'support@nexusrh-ci.com',
            support_phone   varchar(30)  DEFAULT '+225 07 09 32 05 94',
            logo_url        text,
            favicon_url     text,
            primary_color   varchar(7)   DEFAULT '#E85D04',
            maintenance_mode boolean      DEFAULT false,
            allow_new_tenants boolean     DEFAULT true,
            max_tenants     int          DEFAULT 9999,
            smtp_host       varchar(255),
            smtp_port       int,
            smtp_user       varchar(255),
            default_trial_days int       DEFAULT 30,
            ai_model        varchar(100) DEFAULT 'claude-sonnet-4-20250514',
            ai_enabled      boolean      DEFAULT true,
            legal_name      varchar(255) DEFAULT 'OpenLab Consulting',
            legal_address   text         DEFAULT 'Cocody, Rivièra Faya Lauriers 8, Abidjan',
            mfa_required_super_admin  boolean NOT NULL DEFAULT false,
            mfa_required_tenant_users boolean NOT NULL DEFAULT false,
            password_max_age_days     int     NOT NULL DEFAULT 30,
            password_history_count    int     NOT NULL DEFAULT 5,
            breach_check_enabled      boolean NOT NULL DEFAULT true,
            lockout_enabled           boolean NOT NULL DEFAULT true,
            lockout_max_attempts      int     NOT NULL DEFAULT 5,
            lockout_window_minutes    int     NOT NULL DEFAULT 15,
            lockout_duration_minutes  int     NOT NULL DEFAULT 15,
            created_at      timestamptz  NOT NULL DEFAULT now(),
            updated_at      timestamptz  NOT NULL DEFAULT now()
          )
        `)
        await pool.query(`INSERT INTO platform.platform_settings DEFAULT VALUES ON CONFLICT DO NOTHING`)
        return pool.query(`SELECT * FROM platform.platform_settings ORDER BY created_at ASC LIMIT 1`)
      })

      const settings = res.rows[0] ?? {}
      return reply.send({
        data: {
          ...settings,
          aiConfigured: !!config.ai.apiKey,
          smtpConfigured: !!config.smtp.user,
          version: '1.0.0',
          environment: config.env,
        }
      })
    },
  })

  // ── PATCH /platform/settings ──────────────────────────────────────────────
  fastify.patch('/settings', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Mettre à jour les paramètres plateforme' },
    handler: async (request, reply) => {
      const body = request.body as Record<string, unknown>
      const allowed = [
        'app_name','support_email','support_phone','logo_url','favicon_url',
        'primary_color','maintenance_mode','allow_new_tenants','max_tenants',
        'default_trial_days','ai_enabled','legal_name','legal_address',
        // ── Politique de sécurité paramétrable (OWASP A07) ──
        'mfa_required_super_admin','mfa_required_tenant_users',
        'password_max_age_days','password_history_count','breach_check_enabled',
        'lockout_enabled','lockout_max_attempts','lockout_window_minutes','lockout_duration_minutes',
      ]
      // OWASP A03 — coercition de type avant écriture (les toggles/nombres
      // arrivent parfois en string depuis le frontend). Les booleans/ints sont
      // normalisés ; les bornes des durées/historique sont contraintes.
      const BOOL_FIELDS = new Set([
        'maintenance_mode','allow_new_tenants','ai_enabled',
        'mfa_required_super_admin','mfa_required_tenant_users','breach_check_enabled',
        'lockout_enabled',
      ])
      const INT_FIELDS = new Set(['max_tenants','default_trial_days','password_max_age_days','password_history_count',
        'lockout_max_attempts','lockout_window_minutes','lockout_duration_minutes'])
      const sets: string[] = []
      const vals: unknown[] = []
      let idx = 1
      for (const [k, rawV] of Object.entries(body)) {
        if (!allowed.includes(k)) continue
        let v: unknown = rawV
        if (BOOL_FIELDS.has(k)) {
          v = rawV === true || rawV === 'true' || rawV === 1 || rawV === '1'
        } else if (INT_FIELDS.has(k)) {
          const n = typeof rawV === 'number' ? rawV : parseInt(String(rawV), 10)
          if (!Number.isFinite(n) || n < 0) continue
          // bornes raisonnables : durée de vie ≤ 3650 j, historique ≤ 50
          if (k === 'password_max_age_days') v = Math.min(n, 3650)
          else if (k === 'password_history_count') v = Math.min(n, 50)
          else v = n
        }
        sets.push(`${k} = $${idx++}`); vals.push(v)
      }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ valide' })
      sets.push(`updated_at = now()`)

      // Singleton : garantir l'unique ligne sans en créer de doublon (index unique
      // sur `singleton`). Repli sur DEFAULT VALUES si l'index n'existe pas encore.
      await pool.query(
        `INSERT INTO platform.platform_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`
      ).catch(() => pool.query(
        `INSERT INTO platform.platform_settings DEFAULT VALUES ON CONFLICT DO NOTHING`
      ).catch(() => null))

      await pool.query(
        `UPDATE platform.platform_settings SET ${sets.join(', ')} WHERE id = (SELECT id FROM platform.platform_settings ORDER BY created_at ASC LIMIT 1)`,
        vals
      )
      if ('maintenance_mode' in body) maintenanceCache.invalidate()
      return reply.send({ success: true })
    },
  })

  // ── GET /platform/logs ────────────────────────────────────────────────────
  fastify.get('/logs', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Logs d\'activité plateforme' },
    handler: async (request, reply) => {
      const { limit = '50', tenant_id } = request.query as Record<string, string>
      let sql = `SELECT al.*, t.name AS tenant_name
                 FROM platform.audit_log al
                 LEFT JOIN platform.tenants t ON t.id = al.tenant_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (tenant_id) { sql += ` AND al.tenant_id = $${idx++}`; params.push(tenant_id) }
      sql += ` ORDER BY al.created_at DESC LIMIT $${idx}`
      params.push(parseInt(limit))

      const res = await pool.query(sql, params).catch(() => ({ rows: [] }))
      return reply.send({ data: res.rows })
    },
  })

  // ── GET /platform/legal-constants — Store de Lois ────────────────────────
  fastify.get('/legal-constants', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Constantes légales par pays (Store de Lois)' },
    handler: async (_request, reply) => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS platform.legal_constants (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          country     varchar(5) NOT NULL DEFAULT 'CI',
          version     varchar(20) NOT NULL DEFAULT '2024',
          effective   date NOT NULL DEFAULT CURRENT_DATE,
          constants   jsonb NOT NULL DEFAULT '{}',
          is_active   boolean NOT NULL DEFAULT true,
          notes       text,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now(),
          UNIQUE (country, version)
        )
      `).catch(() => null)

      // Seed CI 2024 si absent
      await pool.query(`
        INSERT INTO platform.legal_constants (country, version, effective, constants, notes)
        VALUES ('CI', '2024', '2024-01-01', $1, 'Constantes légales CI 2024 — CNPS + ITS/DGI + Code du Travail')
        ON CONFLICT (country, version) DO NOTHING
      `, [JSON.stringify({
          SMIG_MENSUEL: 75000,
          SMIG_HORAIRE: 433,
          PLAFOND_CNPS_AT_PF_MENSUEL: 70000,
          PLAFOND_CNPS_RETRAITE_MENSUEL: 1647315,
          TAUX_CNPS_RETRAITE_SAL: 0.063,
          TAUX_CNPS_RETRAITE_PAT: 0.077,
          TAUX_CNPS_PF_PAT: 0.050,
          TAUX_CNPS_MATERNITE_PAT: 0.0075,
          TAUX_CNPS_AT_COMMERCE: 0.020,
          TAUX_CNPS_AT_BTP: 0.030,
          TAUX_CNPS_AT_INDUSTRIE: 0.040,
          TAUX_CNPS_AT_EXTRACTION: 0.050,
          ABATTEMENT_ITS: 0.15,
          CONGES_JOURS_PAR_MOIS: 2.5,
          CONTRIBUTION_FDFP: 0.004,
          TRANCHES_ITS: [
            { max: 75000, taux: 0.000 },
            { max: 240000, taux: 0.015 },
            { max: 800000, taux: 0.050 },
            { max: 2000000, taux: 0.100 },
            { max: null, taux: 0.150 },
          ],
          CREDIT_IMPOT_MARIE: 5500,
          CREDIT_IMPOT_1ENFANT: 3000,
          CREDIT_IMPOT_2ENFANTS: 6000,
          CREDIT_IMPOT_3ENFANTS_PLUS: 9000,
        })]).catch(() => null)

      const res = await pool.query(
        `SELECT * FROM platform.legal_constants ORDER BY country, version DESC`
      ).catch(() => ({ rows: [] }))
      return reply.send({ data: res.rows })
    },
  })

  // PATCH /platform/legal-constants/:country/:version — mise à jour SMIG et constants
  fastify.patch('/legal-constants/:country/:version', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Mettre à jour les constantes légales (Store de Lois)' },
    handler: async (request, reply) => {
      const { country, version } = request.params as { country: string; version: string }
      // OWASP A03 — `constants` DOIT être un objet ; sans garde, un corps invalide
      // (constants absent) faisait planter `constants['SMIG_MENSUEL']` → 500.
      const body = (request.body ?? {}) as { constants?: unknown; notes?: string; effective?: string }
      if (typeof body.constants !== 'object' || body.constants === null || Array.isArray(body.constants)) {
        return reply.status(400).send({ error: 'Corps invalide : « constants » (objet) requis' })
      }
      const constants = body.constants as Record<string, unknown>
      const { notes, effective } = body

      await pool.query(`
        CREATE TABLE IF NOT EXISTS platform.legal_constants (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          country varchar(5) NOT NULL DEFAULT 'CI', version varchar(20) NOT NULL DEFAULT '2024',
          effective date NOT NULL DEFAULT CURRENT_DATE, constants jsonb NOT NULL DEFAULT '{}',
          is_active boolean NOT NULL DEFAULT true, notes text,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (country, version)
        )
      `).catch(() => null)

      await pool.query(
        `INSERT INTO platform.legal_constants (country, version, effective, constants, notes)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (country, version) DO UPDATE SET
           constants = EXCLUDED.constants, notes = EXCLUDED.notes,
           effective = EXCLUDED.effective, updated_at = now()`,
        [country, version, effective ?? new Date().toISOString().split('T')[0], JSON.stringify(constants), notes ?? null]
      )

      // Propager le nouveau SMIG à tous les tenants actifs (audit log)
      if (constants['SMIG_MENSUEL']) {
        await pool.query(
          `INSERT INTO platform.audit_log (action, entity, changes)
           VALUES ('LEGAL_UPDATE', 'legal_constants', $1)`,
          [JSON.stringify({ country, version, smig: constants['SMIG_MENSUEL'], updatedAt: new Date() })]
        ).catch(() => null)
      }

      return reply.send({ success: true, message: `Constantes ${country} ${version} mises à jour` })
    },
  })

  // GET /platform/country-configs — Multi-législatif : configurations par pays
  // Lecture ouverte aux super_admin + admins/RH tenant (catalogue pays non sensible).
  fastify.get('/country-configs', {
    preHandler: [fastify.authorize('super_admin', 'admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['platform'], summary: 'Configurations multi-pays (UEMOA/OHADA)' },
    handler: async (_request, reply) => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS platform.country_configs (
          id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          country_code varchar(5) NOT NULL UNIQUE,
          country_name varchar(100) NOT NULL,
          currency     varchar(5) NOT NULL DEFAULT 'XOF',
          timezone     varchar(50) NOT NULL DEFAULT 'Africa/Abidjan',
          payroll_engine varchar(30) NOT NULL DEFAULT 'ci_2024',
          is_active    boolean NOT NULL DEFAULT false,
          config       jsonb NOT NULL DEFAULT '{}',
          created_at   timestamptz NOT NULL DEFAULT now()
        )
      `).catch(() => null)

      // Tous les packs législatifs supportés par la plateforme (UEMOA + CEMAC + NGA).
      // is_active=true pour visibilité commerciale ; le statut technique du moteur
      // de paie reste géré dans legislation-packs.ts (status: active/stub).
      // DO UPDATE permet d'activer rétroactivement les pays seedés à false.
      await pool.query(`
        INSERT INTO platform.country_configs
          (country_code, country_name, currency, timezone, payroll_engine, is_active, config)
        VALUES
          ('CI','Côte d''Ivoire','XOF','Africa/Abidjan','ci_2024',true,'{"smig":75000,"cnpsRetraite":0.063,"itsAbattement":0.15,"zone":"UEMOA"}'),
          ('SN','Sénégal','XOF','Africa/Dakar','sn_2024',true,'{"smig":69120,"ipresRetraite":0.056,"cfceTaux":0.08,"zone":"UEMOA"}'),
          ('BJ','Bénin','XOF','Africa/Porto-Novo','bj_2024',true,'{"smig":52000,"cnssRetraite":0.036,"zone":"UEMOA"}'),
          ('TG','Togo','XOF','Africa/Lome','tg_2024',true,'{"smig":35000,"cnavsRetraite":0.04,"zone":"UEMOA"}'),
          ('BF','Burkina Faso','XOF','Africa/Ouagadougou','bf_2024',true,'{"smig":34664,"cnssRetraite":0.055,"zone":"UEMOA"}'),
          ('ML','Mali','XOF','Africa/Bamako','ml_2024',true,'{"smig":40000,"inpsRetraite":0.037,"zone":"UEMOA"}'),
          ('NE','Niger','XOF','Africa/Niamey','ne_2024',true,'{"smig":30047,"cnssRetraite":0.052,"zone":"UEMOA"}'),
          ('CM','Cameroun','XAF','Africa/Douala','cm_2024',true,'{"smig":36270,"cnpsRetraite":0.042,"zone":"CEMAC"}'),
          ('TD','Tchad','XAF','Africa/Ndjamena','td_2024',true,'{"smig":60000,"cnpsRetraite":0.035,"zone":"CEMAC"}'),
          ('NG','Nigeria','NGN','Africa/Lagos','ng_2024',true,'{"smig":70000,"pensionEmployee":0.08,"zone":"ECOWAS"}'),
          ('GH','Ghana','GHS','Africa/Accra','gh_2024',true,'{"smig":480,"ssnitEmployee":0.055,"zone":"ECOWAS"}')
        ON CONFLICT (country_code) DO UPDATE SET
          is_active = EXCLUDED.is_active,
          currency = EXCLUDED.currency,
          timezone = EXCLUDED.timezone,
          payroll_engine = EXCLUDED.payroll_engine,
          config = EXCLUDED.config
      `).catch(() => null)

      const res = await pool.query(`SELECT * FROM platform.country_configs ORDER BY is_active DESC, country_name`).catch(() => ({ rows: [] }))
      return reply.send({ data: res.rows })
    },
  })

  // ── GET /platform/dashboard ───────────────────────────────────────────────
  fastify.get('/dashboard', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'KPIs plateforme' },
    handler: async (_request, reply) => {
      const stats = await pool.query(`
        SELECT
          count(*) FILTER (WHERE status = 'active') AS active_count,
          count(*) FILTER (WHERE status = 'trial')  AS trial_count,
          count(*) FILTER (WHERE status = 'suspended') AS suspended_count,
          count(*) AS total_count
        FROM platform.tenants
      `)
      const row = stats.rows[0]
      return reply.send({
        data: {
          activeCount:    parseInt(row?.active_count ?? '0'),
          trialCount:     parseInt(row?.trial_count ?? '0'),
          suspendedCount: parseInt(row?.suspended_count ?? '0'),
          totalCount:     parseInt(row?.total_count ?? '0'),
        },
      })
    },
  })

  // ── Sourcing IA : configuration paramétrable (super_admin only) ────────────
  // OWASP A01 : authorize('super_admin') sur tous les endpoints.
  // Invalidation du cache après chaque mutation pour propager immédiatement.

  // ─── GET /platform/sourcing/models ─── liste des modèles IA
  fastify.get('/sourcing/models', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (_req, reply) => {
      const res = await pool.query(`
        SELECT id, provider, model_id, display_name, max_tokens,
               input_cost_per_1m_eur::float AS input_cost_per_1m_eur,
               output_cost_per_1m_eur::float AS output_cost_per_1m_eur,
               is_active, sort_order
          FROM platform.ai_models
         ORDER BY sort_order, provider, model_id
      `).catch(() => ({ rows: [] }))
      return reply.send({ data: res.rows })
    },
  })

  fastify.post('/sourcing/models', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (request, reply) => {
      const body = request.body as {
        provider?: string; model_id?: string; display_name?: string
        max_tokens?: number; input_cost_per_1m_eur?: number
        output_cost_per_1m_eur?: number; is_active?: boolean; sort_order?: number
      }
      if (!body.provider || !body.model_id || !body.display_name) {
        return reply.status(400).send({ error: 'provider, model_id et display_name obligatoires' })
      }
      try {
        const res = await pool.query(`
          INSERT INTO platform.ai_models
            (provider, model_id, display_name, max_tokens,
             input_cost_per_1m_eur, output_cost_per_1m_eur, is_active, sort_order)
          VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true),COALESCE($8,0))
          RETURNING *
        `, [
          body.provider, body.model_id, body.display_name,
          body.max_tokens ?? 4000,
          body.input_cost_per_1m_eur ?? 0,
          body.output_cost_per_1m_eur ?? 0,
          body.is_active, body.sort_order,
        ])
        invalidateConfigCache()
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error({ err }, 'sourcing.models.create failed')
        return reply.status(500).send({ error: 'Erreur création modèle' })
      }
    },
  })

  fastify.patch('/sourcing/models/:id', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const allowed = ['provider','model_id','display_name','max_tokens',
        'input_cost_per_1m_eur','output_cost_per_1m_eur','is_active','sort_order']
      const sets: string[] = []
      const vals: unknown[] = []
      for (const k of allowed) {
        if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]) }
      }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ à mettre à jour' })
      sets.push(`updated_at = now()`)
      vals.push(id)
      try {
        const res = await pool.query(
          `UPDATE platform.ai_models SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
          vals,
        )
        invalidateConfigCache()
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error({ err }, 'sourcing.models.update failed')
        return reply.status(500).send({ error: 'Erreur mise à jour' })
      }
    },
  })

  fastify.delete('/sourcing/models/:id', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      try {
        // OWASP A09 : snapshot AVANT suppression pour traçabilité
        const snap = await pool.query<{ provider: string; model_id: string; display_name: string }>(
          `SELECT provider, model_id, display_name FROM platform.ai_models WHERE id = $1`,
          [id],
        )
        await pool.query(`DELETE FROM platform.ai_models WHERE id = $1`, [id])
        invalidateConfigCache()
        auditLogPlatform(request.user.sub, 'sourcing.model_deleted', 'ai_model', id, {
          provider: snap.rows[0]?.provider ?? null,
          modelId:  snap.rows[0]?.model_id ?? null,
          displayName: snap.rows[0]?.display_name ?? null,
        }, request.ip ?? null)
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error({ err }, 'sourcing.models.delete failed')
        return reply.status(500).send({ error: 'Erreur suppression' })
      }
    },
  })

  // ─── GET /platform/sourcing/platforms ─── plateformes de sourcing
  fastify.get('/sourcing/platforms', {
    preHandler: [fastify.authorize('super_admin', 'admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const { country_code } = request.query as { country_code?: string }
      const where: string[] = []
      const params: unknown[] = []
      if (country_code) {
        where.push(`(country_code = $${params.length + 1} OR is_panafrican = true)`)
        params.push(country_code)
      }
      const sql = `SELECT id, code, name, country_code, url, est_pool, is_active, is_panafrican, sort_order
                     FROM platform.sourcing_platforms
                    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                    ORDER BY sort_order, name`
      const res = await pool.query(sql, params).catch(() => ({ rows: [] }))
      return reply.send({ data: res.rows })
    },
  })

  fastify.post('/sourcing/platforms', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (request, reply) => {
      const body = request.body as {
        code?: string; name?: string; country_code?: string | null
        url?: string | null; est_pool?: number | null
        is_active?: boolean; is_panafrican?: boolean; sort_order?: number
      }
      if (!body.code || !body.name) {
        return reply.status(400).send({ error: 'code et name obligatoires' })
      }
      try {
        const res = await pool.query(`
          INSERT INTO platform.sourcing_platforms
            (code, name, country_code, url, est_pool, is_active, is_panafrican, sort_order)
          VALUES ($1,$2,$3,$4,$5,COALESCE($6,true),COALESCE($7,false),COALESCE($8,0))
          RETURNING *
        `, [
          body.code, body.name, body.country_code ?? null, body.url ?? null,
          body.est_pool ?? null, body.is_active, body.is_panafrican, body.sort_order,
        ])
        invalidateConfigCache()
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error({ err }, 'sourcing.platforms.create failed')
        return reply.status(500).send({ error: 'Erreur création plateforme' })
      }
    },
  })

  fastify.patch('/sourcing/platforms/:id', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const allowed = ['code','name','country_code','url','est_pool','is_active','is_panafrican','sort_order']
      const sets: string[] = []
      const vals: unknown[] = []
      for (const k of allowed) {
        if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]) }
      }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ à mettre à jour' })
      sets.push(`updated_at = now()`)
      vals.push(id)
      try {
        const res = await pool.query(
          `UPDATE platform.sourcing_platforms SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
          vals,
        )
        invalidateConfigCache()
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error({ err }, 'sourcing.platforms.update failed')
        return reply.status(500).send({ error: 'Erreur mise à jour' })
      }
    },
  })

  fastify.delete('/sourcing/platforms/:id', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      try {
        const snap = await pool.query<{ name: string; country_code: string; url: string | null }>(
          `SELECT name, country_code, url FROM platform.sourcing_platforms WHERE id = $1`,
          [id],
        )
        await pool.query(`DELETE FROM platform.sourcing_platforms WHERE id = $1`, [id])
        invalidateConfigCache()
        auditLogPlatform(request.user.sub, 'sourcing.platform_deleted', 'sourcing_platform', id, {
          name: snap.rows[0]?.name ?? null,
          countryCode: snap.rows[0]?.country_code ?? null,
          url: snap.rows[0]?.url ?? null,
        }, request.ip ?? null)
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error({ err }, 'sourcing.platforms.delete failed')
        return reply.status(500).send({ error: 'Erreur suppression' })
      }
    },
  })

  // ─── GET/PATCH /platform/sourcing/settings ─── singleton clé/valeur ────────
  fastify.get('/sourcing/settings', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (_req, reply) => {
      const res = await pool.query(
        `SELECT key, value, description, updated_at FROM platform.sourcing_settings`,
      ).catch(() => ({ rows: [] }))
      // Retour sous forme d'objet aplati : { max_profiles_min: 1, ... }
      const obj: Record<string, unknown> = {}
      for (const r of res.rows) {
        obj[r.key] = (r.value && typeof r.value === 'object' && 'value' in r.value)
          ? (r.value as { value: unknown }).value
          : r.value
      }
      return reply.send({ data: obj })
    },
  })

  fastify.patch('/sourcing/settings', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (request, reply) => {
      const body = request.body as Record<string, unknown>
      const allowed = [
        'max_profiles_min', 'max_profiles_max', 'max_profiles_default',
        'max_cost_eur_per_request', 'claude_system_prompt', 'mistral_system_prompt',
        'richness_weights',
      ]
      try {
        for (const key of Object.keys(body)) {
          if (!allowed.includes(key)) continue
          const value = body[key]
          // Sérialiser proprement : nombres/strings → JSON value, objets → JSONB
          const jsonValue = JSON.stringify({ value })
          await pool.query(
            `INSERT INTO platform.sourcing_settings (key, value, updated_at, updated_by)
             VALUES ($1, $2::jsonb, now(), $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                                              updated_at = now(),
                                              updated_by = EXCLUDED.updated_by`,
            [key, key === 'richness_weights' ? JSON.stringify(value) : jsonValue,
             request.user.sub],
          )
        }
        invalidateConfigCache()
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error({ err }, 'sourcing.settings.update failed')
        return reply.status(500).send({ error: 'Erreur mise à jour settings' })
      }
    },
  })
}

export default platformRoutes
