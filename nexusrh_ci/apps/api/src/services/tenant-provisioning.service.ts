import type { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { config } from '../config.js'
import { provisionTenantSchema, seedPayrollRulesCI, seedAbsenceTypesCI } from '../db/provisioning.js'
import { sendWelcomeTenantEmail, type TenantSmtp } from './email.js'
import { seedDemoTenant } from '../db/seed-demo.js'

/**
 * Service de provisionnement d'un tenant — pipeline UNIQUE réutilisé par :
 *   - POST /platform/tenants (super_admin)
 *   - POST /agency/client-tenants (cabinet, self-onboard)
 *
 * Clean Architecture : la logique métier (INSERT tenant + provision schéma +
 * seeds rubriques/absences CI + création admin + email + démo) vit ici, pas
 * dupliquée dans deux handlers. Comportement byte-identique à l'ancien handler.
 */

export const PLAN_DEFAULTS: Record<string, { maxUsers: number; maxEmployees: number }> = {
  trial:         { maxUsers: 10,   maxEmployees: 20   },
  starter:       { maxUsers: 30,   maxEmployees: 30   },
  business:      { maxUsers: 100,  maxEmployees: 150  },
  enterprise:    { maxUsers: 9999, maxEmployees: 9999 },
  public_sector: { maxUsers: 200,  maxEmployees: 500  },
}

export const AT_RATE_BY_SECTOR: Record<string, number> = {
  commerce:    0.020,
  services:    0.020,
  finance:     0.020,
  education:   0.020,
  public:      0.020,
  btp:         0.030,
  sante:       0.030,
  industrie:   0.040,
  agriculture: 0.040,
  extraction:  0.050,
}

export interface CreateTenantInput {
  name: string
  slug: string
  planType?: 'trial' | 'starter' | 'business' | 'enterprise' | 'public_sector'
  sector?: string
  city?: string
  cnpsNumber?: string
  dgiNumber?: string
  rccm?: string
  primaryColor?: string
  secondaryColor?: string
  logoUrl?: string
  adminEmail: string
  adminFirstName: string
  adminLastName: string
  seedDemoData?: boolean
  hasSubsidiaries?: boolean
  payrollMode?: 'single_country' | 'multi_country'
  defaultCountryCode?: string
  /**
   * Modules à activer/désactiver dès la création (carte { moduleKey: boolean }
   * aux clés bornées à MODULE_KEYS, validée en amont par le handler). Absent →
   * enabled_modules NULL → fallback MODULE_DEFAULTS à la lecture (inchangé).
   */
  modules?: Record<string, boolean>
}

export interface CreateTenantOptions {
  /**
   * Expéditeur email fourni par un cabinet (From/Reply-To). Absent → expéditeur
   * OpenLab par défaut (config.smtp.from). Utilisé uniquement pour les tenants
   * créés PAR un cabinet.
   */
  sender?: { email: string; name?: string | null } | null
  /**
   * SMTP propre au créateur (cabinet) pour router l'email de bienvenue via SON
   * serveur (From aligné au domaine → délivrabilité). Absent → repli sur le SMTP
   * plateforme. À la création super_admin, ne rien passer (repli légitime).
   */
  smtp?: TenantSmtp | null
  /** Logo (URL absolue) à afficher dans l'email de bienvenue. */
  logoUrl?: string | null
  /** URL de login (défaut : {appUrl}/login). */
  loginUrl?: string
  /** Logger non bloquant pour les étapes best-effort (démo, email). */
  logger?: { warn: (obj: unknown, msg?: string) => void }
}

export interface CreateTenantResult {
  id: string
  slug: string
  schemaName: string
  name: string
  planType: string
  adminEmail: string
  tempPassword: string
}

/** Levée quand le slug est déjà pris → le caller renvoie 409. */
export class TenantSlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`Le slug "${slug}" est déjà utilisé`)
    this.name = 'TenantSlugConflictError'
  }
}

export async function createTenantWithSchema(
  pool: Pool,
  input: CreateTenantInput,
  opts: CreateTenantOptions = {},
): Promise<CreateTenantResult> {
  const slug = input.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const schemaName = `tenant_${slug}`
  const planType = input.planType ?? 'trial'
  const plan = PLAN_DEFAULTS[planType] ?? { maxUsers: 10, maxEmployees: 20 }
  const atRate = AT_RATE_BY_SECTOR[input.sector ?? 'services'] ?? 0.020

  // Vérifier unicité slug
  const existing = await pool.query(
    `SELECT id FROM platform.tenants WHERE slug = $1 LIMIT 1`, [slug],
  )
  if (existing.rows[0]) throw new TenantSlugConflictError(slug)

  const hasSubsidiaries = input.hasSubsidiaries === true
  const payrollMode = hasSubsidiaries ? 'multi_country' : 'single_country'
  const defaultCountryCode = (input.defaultCountryCode ?? 'CIV').toUpperCase().slice(0, 3)

  // 1. Créer le tenant dans platform
  // Modules sélectionnés à la création (surcharges jsonb). Absent → NULL →
  // COALESCE en base ('{}') → fallback MODULE_DEFAULTS à la lecture (inchangé).
  const enabledModulesJson =
    input.modules && Object.keys(input.modules).length > 0
      ? JSON.stringify(input.modules)
      : null

  const tenantRes = await pool.query<{ id: string }>(
    `INSERT INTO platform.tenants
       (name, slug, schema_name, plan_type, status, sector, city,
        cnps_number, dgi_number, rccm, at_rate,
        max_users, max_employees, primary_color, secondary_color, logo_url,
        trial_ends_at,
        has_subsidiaries, payroll_mode, default_country_code, enabled_modules)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             COALESCE($21::jsonb, '{}'::jsonb))
     RETURNING id`,
    [
      input.name, slug, schemaName, planType,
      planType === 'trial' ? 'trial' : 'active',
      input.sector ?? null, input.city ?? 'Abidjan',
      input.cnpsNumber ?? null, input.dgiNumber ?? null, input.rccm ?? null,
      atRate.toString(),
      plan.maxUsers, plan.maxEmployees,
      input.primaryColor ?? '#E85D04', input.secondaryColor ?? '#F48C06',
      input.logoUrl ?? null,
      planType === 'trial' ? new Date(Date.now() + 30 * 24 * 3600 * 1000) : null,
      hasSubsidiaries, payrollMode, defaultCountryCode, enabledModulesJson,
    ],
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
    [input.adminEmail, passwordHash, input.adminFirstName, input.adminLastName],
  )

  // 5. Données de démonstration (optionnel, non bloquant)
  if (input.seedDemoData === true) {
    seedDemoTenant(pool, schemaName, atRate).catch(err =>
      opts.logger?.warn({ err }, 'Seed démo non terminé'),
    )
  }

  // 6. Email de bienvenue (non bloquant). Expéditeur cabinet si fourni, sinon
  // OpenLab par défaut.
  const from = opts.sender?.email
    ? `${opts.sender.name ? `${opts.sender.name} ` : ''}<${opts.sender.email}>`
    : null
  sendWelcomeTenantEmail({
    to:           input.adminEmail,
    firstName:    input.adminFirstName,
    lastName:     input.adminLastName,
    tenantName:   input.name,
    tenantCity:   input.city ?? 'Abidjan',
    primaryColor: input.primaryColor ?? '#E85D04',
    loginUrl:     `${opts.loginUrl ?? `${config.appUrl}/login`}`,
    tempPassword,
    plan:         planType,
    logoUrl:      opts.logoUrl ?? input.logoUrl ?? null,
    from,
    replyTo:      opts.sender?.email ?? null,
    // SMTP du cabinet créateur si fourni (sinon repli plateforme dans email.ts).
    smtp:         opts.smtp ?? null,
  }).catch(err => opts.logger?.warn({ err }, 'Email bienvenue non envoyé'))

  return { id: tenantId, slug, schemaName, name: input.name, planType, adminEmail: input.adminEmail, tempPassword }
}
