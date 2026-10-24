/**
 * Contexte tenant d'un dossier employé, lu en une requête :
 *   - pack législatif applicable — mêmes règles que la paie
 *     (resolvePayrollContext) : filiale de rattachement, sinon pays du tenant ;
 *   - surcharge tenant des règles de rupture (convention collective) ;
 *   - définitions des champs personnalisés du dossier.
 *
 * Sert les contrôles hors moteur de paie (SMIG à la saisie du salaire, solde de
 * tout compte, champs personnalisés) pour qu'ils suivent le paramétrage du
 * tenant et le pays de l'employé au lieu de valeurs ivoiriennes en dur.
 */
import { resolvePayrollContext, type ResolvedPayrollContext } from './payroll-context-resolver.js'
import { parseFieldDefinitions, type CustomFieldDefinition } from './employee-custom-fields.service.js'

interface Queryable {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export interface EmployeeTenantContext {
  legislation: ResolvedPayrollContext
  /** Surcharge tenant des règles de rupture (jsonb brut, validé à l'usage). */
  tenantTerminationRules: unknown
  customFields: CustomFieldDefinition[]
}

export async function loadEmployeeTenantContext(
  db: Queryable,
  schema: string,
  legalEntityId: string | null | undefined,
): Promise<EmployeeTenantContext> {
  const t = await db.query<{
    id: string; at_rate: string | null; has_subsidiaries: boolean | null
    default_country_code: string | null; termination_rules: unknown; employee_custom_fields: unknown
  }>(
    `SELECT id, at_rate, has_subsidiaries, default_country_code, termination_rules, employee_custom_fields
     FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
  )
  const tenant = t?.rows?.[0]

  let legalEntity: { id: string; atRate: number | null; legislationPackCode: string | null; countryCode: string | null } | null = null
  if (legalEntityId) {
    // Table absente sur un tenant mono-filiale non migré : repli tenant.
    try {
      const le = await db.query<{
        id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null
      }>(
        `SELECT id, at_rate, legislation_pack_code, country_code
         FROM "${schema}".legal_entities WHERE id = $1 LIMIT 1`, [legalEntityId],
      )
      const row = le?.rows?.[0]
      if (row) legalEntity = {
        id: row.id,
        atRate: row.at_rate ? parseFloat(row.at_rate) : null,
        legislationPackCode: row.legislation_pack_code,
        countryCode: row.country_code,
      }
    } catch { /* repli tenant */ }
  }

  const legislation = resolvePayrollContext({
    tenant: {
      id: tenant?.id ?? '',
      hasSubsidiaries: tenant?.has_subsidiaries ?? false,
      atRate: parseFloat(tenant?.at_rate ?? '0.020'),
      defaultCountryCode: tenant?.default_country_code ?? null,
    },
    employee: { id: '', legalEntityId: legalEntityId ?? null },
    legalEntity,
  })
  return {
    legislation,
    tenantTerminationRules: tenant?.termination_rules ?? null,
    customFields: parseFieldDefinitions(tenant?.employee_custom_fields),
  }
}
