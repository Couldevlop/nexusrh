import type { Pool } from 'pg'
import { isValidSchemaName } from '../utils/schema-name.js'

/**
 * Service CABINET de recrutement — point de contrôle d'autorisation UNIQUE
 * (OWASP A01). Tout passage d'un cabinet vers un tenant client transite par
 * assertAgencyCanActOnTenant : (user ∈ cabinet) ∧ (cabinet actif) ∧
 * (tenant rattaché, non détaché) ∧ (tenant actif) ∧ (tenant CI) ∧ (schéma valide).
 */

// Côte d'Ivoire uniquement : un cabinet ne peut agir que sur des tenants CI.
// 'CIV' = code par défaut de platform.tenants.default_country_code (ISO alpha-3).
export const CI_COUNTRY_CODES = new Set(['CIV', 'CI'])

export interface AgencyTenantContext {
  tenantId: string
  schemaName: string
  name: string
  slug: string
  primaryColor: string | null
  secondaryColor: string | null
  logoUrl: string | null
  city: string | null
  hasSubsidiaries: boolean
  payrollMode: string
  defaultCountryCode: string
}

export type AgencyGuardReason =
  | 'not_member'
  | 'agency_suspended'
  | 'not_assigned'
  | 'tenant_suspended'
  | 'non_ci'
  | 'bad_schema'

export type AgencyGuardResult =
  | { ok: true; tenant: AgencyTenantContext }
  | { ok: false; reason: AgencyGuardReason }

/** Prédicat CI réutilisable (attach / onboard / activation). */
export function assertTenantIsCI(countryCode: string | null | undefined): boolean {
  return !!countryCode && CI_COUNTRY_CODES.has(String(countryCode).toUpperCase())
}

/**
 * Vérifie qu'un utilisateur de cabinet peut agir sur un tenant client donné.
 * Toutes les conditions sont évaluées côté SQL (une requête) puis en TS. Ne
 * lève jamais : renvoie un résultat discriminé exploité par la route (403).
 */
export async function assertAgencyCanActOnTenant(
  pool: Pool,
  agencyUserId: string,
  agencyId: string,
  tenantId: string,
): Promise<AgencyGuardResult> {
  const r = await pool.query<{
    agency_status: string
    tenant_id: string | null
    schema_name: string | null
    name: string | null
    slug: string | null
    primary_color: string | null
    secondary_color: string | null
    logo_url: string | null
    city: string | null
    tenant_status: string | null
    default_country_code: string | null
    has_subsidiaries: boolean | null
    payroll_mode: string | null
    link_id: string | null
  }>(
    `SELECT a.status AS agency_status,
            t.id AS tenant_id, t.schema_name, t.name, t.slug,
            t.primary_color, t.secondary_color, t.logo_url, t.city,
            t.status AS tenant_status, t.default_country_code,
            t.has_subsidiaries, t.payroll_mode,
            lnk.id AS link_id
       FROM platform.agency_users au
       JOIN platform.agencies a ON a.id = au.agency_id
       LEFT JOIN platform.agency_tenants lnk
              ON lnk.agency_id = a.id AND lnk.tenant_id = $3 AND lnk.detached_at IS NULL
       LEFT JOIN platform.tenants t ON t.id = $3
      WHERE au.id = $1 AND au.agency_id = $2 AND au.is_active = true
      LIMIT 1`,
    [agencyUserId, agencyId, tenantId],
  )

  const row = r.rows[0]
  if (!row) return { ok: false, reason: 'not_member' }
  if (row.agency_status !== 'active') return { ok: false, reason: 'agency_suspended' }
  if (!row.link_id || !row.tenant_id) return { ok: false, reason: 'not_assigned' }
  if (row.tenant_status !== 'active' && row.tenant_status !== 'trial') {
    return { ok: false, reason: 'tenant_suspended' }
  }
  if (!assertTenantIsCI(row.default_country_code)) return { ok: false, reason: 'non_ci' }
  if (!isValidSchemaName(row.schema_name)) return { ok: false, reason: 'bad_schema' }

  return {
    ok: true,
    tenant: {
      tenantId: row.tenant_id,
      schemaName: row.schema_name as string,
      name: row.name ?? '',
      slug: row.slug ?? '',
      primaryColor: row.primary_color,
      secondaryColor: row.secondary_color,
      logoUrl: row.logo_url,
      city: row.city,
      hasSubsidiaries: row.has_subsidiaries ?? false,
      payrollMode: row.payroll_mode ?? 'single_country',
      defaultCountryCode: row.default_country_code ?? 'CIV',
    },
  }
}
