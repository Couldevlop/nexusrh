import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { config } from '../../config.js'
import { provisionTenantSchema, seedPayrollRulesCI, seedAbsenceTypesCI } from '../../db/provisioning.js'
import { sendWelcomeTenantEmail, sendPasswordResetEmail } from '../../services/email.js'
import { maintenanceCache } from '../../cache.js'
import { seedDemoTenant } from '../../db/seed-demo.js'

const pool = new Pool({ connectionString: config.database.url })

const PLAN_DEFAULTS: Record<string, { maxUsers: number; maxEmployees: number }> = {
  trial:         { maxUsers: 10,   maxEmployees: 20   },
  starter:       { maxUsers: 30,   maxEmployees: 30   },
  business:      { maxUsers: 100,  maxEmployees: 150  },
  enterprise:    { maxUsers: 9999, maxEmployees: 9999 },
  public_sector: { maxUsers: 200,  maxEmployees: 500  },
}

const AT_RATE_BY_SECTOR: Record<string, number> = {
  commerce:   0.020,
  services:   0.020,
  finance:    0.020,
  education:  0.020,
  public:     0.020,
  btp:        0.030,
  sante:      0.030,
  industrie:  0.040,
  agriculture: 0.040,
  extraction: 0.050,
}

const platformRoutes: FastifyPluginAsync = async (fastify) => {
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
  fastify.post('/tenants', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Créer un nouveau tenant CI' },
    handler: async (request, reply) => {
      const body = request.body as {
        name: string; slug: string; planType?: string
        sector?: string; city?: string
        cnpsNumber?: string; dgiNumber?: string; rccm?: string
        primaryColor?: string; secondaryColor?: string; logoUrl?: string
        adminEmail: string; adminFirstName: string; adminLastName: string
        adminPhone?: string; seedDemoData?: boolean
        // Option multi-pays : opt-in explicite, défaut single_country
        hasSubsidiaries?: boolean
        payrollMode?: 'single_country' | 'multi_country'
        defaultCountryCode?: string
      }

      if (!body.name || !body.slug || !body.adminEmail) {
        return reply.status(400).send({ error: 'name, slug et adminEmail sont requis' })
      }

      const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const schemaName = `tenant_${slug}`
      const planType = body.planType ?? 'trial'
      const plan = PLAN_DEFAULTS[planType] ?? { maxUsers: 10, maxEmployees: 20 }
      const atRate = AT_RATE_BY_SECTOR[body.sector ?? 'services'] ?? 0.020

      // Vérifier unicité slug
      const existing = await pool.query(
        `SELECT id FROM platform.tenants WHERE slug = $1 LIMIT 1`, [slug]
      )
      if (existing.rows[0]) {
        return reply.status(409).send({ error: `Le slug "${slug}" est déjà utilisé` })
      }

      // Validation : si hasSubsidiaries=true, payrollMode doit suivre
      const hasSubsidiaries = body.hasSubsidiaries === true
      const payrollMode = hasSubsidiaries
        ? (body.payrollMode === 'multi_country' ? 'multi_country' : 'multi_country')
        : 'single_country'
      const defaultCountryCode = (body.defaultCountryCode ?? 'CIV').toUpperCase().slice(0, 3)

      // 1. Créer le tenant dans platform
      const tenantRes = await pool.query<{ id: string }>(
        `INSERT INTO platform.tenants
           (name, slug, schema_name, plan_type, status, sector, city,
            cnps_number, dgi_number, rccm, at_rate,
            max_users, max_employees, primary_color, secondary_color, logo_url,
            trial_ends_at,
            has_subsidiaries, payroll_mode, default_country_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING id`,
        [
          body.name, slug, schemaName, planType,
          planType === 'trial' ? 'trial' : 'active',
          body.sector ?? null, body.city ?? 'Abidjan',
          body.cnpsNumber ?? null, body.dgiNumber ?? null, body.rccm ?? null,
          atRate.toString(),
          plan.maxUsers, plan.maxEmployees,
          body.primaryColor ?? '#E85D04', body.secondaryColor ?? '#F48C06',
          body.logoUrl ?? null,
          planType === 'trial' ? new Date(Date.now() + 30 * 24 * 3600 * 1000) : null,
          hasSubsidiaries, payrollMode, defaultCountryCode,
        ]
      )
      const tenantId = tenantRes.rows[0]?.id
      if (!tenantId) throw new Error('Erreur création tenant')

      // 2. Provisionner le schéma
      await provisionTenantSchema(schemaName)

      // 3. Seed rubriques CI + types absences
      await seedPayrollRulesCI(schemaName, atRate)
      await seedAbsenceTypesCI(schemaName)

      // 4. Créer l'admin
      const tempPassword = `CI_${randomBytes(6).toString('base64url').toUpperCase()}!`
      const passwordHash = await bcrypt.hash(tempPassword, 12)

      await pool.query(
        `INSERT INTO "${schemaName}".users
           (email, password_hash, first_name, last_name, role, is_active)
         VALUES ($1, $2, $3, $4, 'admin', true)`,
        [body.adminEmail, passwordHash, body.adminFirstName, body.adminLastName]
      )

      // 5. Données de démonstration (optionnel, non bloquant)
      if (body.seedDemoData === true) {
        seedDemoTenant(pool, schemaName, atRate).catch(err =>
          fastify.log.warn({ err }, 'Seed démo non terminé')
        )
      }

      // 6. Email de bienvenue (non bloquant)
      sendWelcomeTenantEmail({
        to:           body.adminEmail,
        firstName:    body.adminFirstName,
        lastName:     body.adminLastName,
        tenantName:   body.name,
        tenantCity:   body.city ?? 'Abidjan',
        primaryColor: body.primaryColor ?? '#E85D04',
        loginUrl:     `${config.appUrl}/login`,
        tempPassword,
        plan:         planType,
      }).catch(err => fastify.log.warn({ err }, 'Email bienvenue non envoyé'))

      return reply.status(201).send({
        data: { id: tenantId, slug, schemaName, name: body.name, planType },
        adminEmail:   body.adminEmail,
        tempPassword,
        message: `Tenant "${body.name}" créé avec succès. Mot de passe temporaire : ${tempPassword}`,
      })
    },
  })

  // ── PATCH /platform/tenants/:id ───────────────────────────────────────────
  fastify.patch('/tenants/:id', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Modifier un tenant' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const allowed = ['name','plan_type','status','primary_color','secondary_color',
                       'logo_url','max_users','max_employees','trial_ends_at','city','sector',
                       'has_subsidiaries','payroll_mode','default_country_code']
      const sets: string[] = []
      const vals: unknown[] = []
      let idx = 1
      for (const [k, v] of Object.entries(body)) {
        if (allowed.includes(k)) {
          sets.push(`${k} = $${idx++}`)
          vals.push(v)
        }
      }
      if (sets.length === 0) return reply.status(400).send({ error: 'Aucun champ valide' })
      sets.push(`updated_at = now()`)
      vals.push(id)
      await pool.query(
        `UPDATE platform.tenants SET ${sets.join(', ')} WHERE id = $${idx}`,
        vals
      )
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
  fastify.post('/tenants/:id/reset-admin', {
    preHandler: [fastify.authorize('super_admin')],
    schema: { tags: ['platform'], summary: 'Réinitialiser le mot de passe admin d\'un tenant' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const res = await pool.query<{ schema_name: string }>(
        `SELECT schema_name FROM platform.tenants WHERE id = $1 LIMIT 1`, [id]
      )
      const tenant = res.rows[0]
      if (!tenant) return reply.status(404).send({ error: 'Tenant introuvable' })

      const adminRes = await pool.query<{ id: string; email: string }>(
        `SELECT id, email FROM "${tenant.schema_name}".users WHERE role = 'admin' LIMIT 1`
      )
      const admin = adminRes.rows[0]
      if (!admin) return reply.status(404).send({ error: 'Admin introuvable' })

      const tempPassword = `CI_${randomBytes(6).toString('base64url').toUpperCase()}!`
      const passwordHash = await bcrypt.hash(tempPassword, 12)
      await pool.query(
        `UPDATE "${tenant.schema_name}".users SET password_hash = $1, updated_at = now() WHERE id = $2`,
        [passwordHash, admin.id]
      )

      // Envoyer email de réinitialisation (non bloquant)
      const tenantName = (await pool.query<{ name: string }>(
        `SELECT name FROM platform.tenants WHERE id = $1 LIMIT 1`, [id]
      )).rows[0]?.name ?? ''

      sendPasswordResetEmail({
        to:           admin.email,
        firstName:    admin.email.split('@')[0] ?? 'Admin',
        tempPassword,
        loginUrl:     `${config.appUrl}/login`,
      }).catch(() => null)

      return reply.send({ adminEmail: admin.email, tempPassword, tenantName })
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
        `SELECT * FROM platform.platform_settings LIMIT 1`
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
            created_at      timestamptz  NOT NULL DEFAULT now(),
            updated_at      timestamptz  NOT NULL DEFAULT now()
          )
        `)
        await pool.query(`INSERT INTO platform.platform_settings DEFAULT VALUES ON CONFLICT DO NOTHING`)
        return pool.query(`SELECT * FROM platform.platform_settings LIMIT 1`)
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
      ]
      const sets: string[] = []
      const vals: unknown[] = []
      let idx = 1
      for (const [k, v] of Object.entries(body)) {
        if (allowed.includes(k)) { sets.push(`${k} = $${idx++}`); vals.push(v) }
      }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ valide' })
      sets.push(`updated_at = now()`)

      await pool.query(
        `INSERT INTO platform.platform_settings DEFAULT VALUES ON CONFLICT DO NOTHING`
      ).catch(() => null)

      await pool.query(
        `UPDATE platform.platform_settings SET ${sets.join(', ')} WHERE id = (SELECT id FROM platform.platform_settings LIMIT 1)`,
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
      const { constants, notes, effective } = request.body as {
        constants: Record<string, unknown>; notes?: string; effective?: string
      }

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
  fastify.get('/country-configs', {
    preHandler: [fastify.authorize('super_admin')],
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

      await pool.query(`
        INSERT INTO platform.country_configs
          (country_code, country_name, currency, timezone, payroll_engine, is_active, config)
        VALUES
          ('CI','Côte d''Ivoire','XOF','Africa/Abidjan','ci_2024',true,'{"smig":75000,"cnpsRetraite":0.063,"itsAbattement":0.15}'),
          ('SN','Sénégal','XOF','Africa/Dakar','sn_2024',false,'{"smig":69120,"ipresRetraite":0.056,"cfceTaux":0.08}'),
          ('BF','Burkina Faso','XOF','Africa/Ouagadougou','bf_2024',false,'{"smig":34664,"cnssRetraite":0.055}'),
          ('ML','Mali','XOF','Africa/Bamako','ml_2024',false,'{"smig":40000,"inpsRetraite":0.037}'),
          ('TG','Togo','XOF','Africa/Lome','tg_2024',false,'{"smig":35000,"cnavsRetraite":0.04}')
        ON CONFLICT (country_code) DO NOTHING
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
}

export default platformRoutes
