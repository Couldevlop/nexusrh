import type { Pool } from 'pg'
import { isValidSchemaName } from '../utils/schema-name.js'

/**
 * Détermine les pays de sourcing AUTORISÉS pour un tenant (sécurité côté serveur,
 * OWASP A01 — ne jamais faire confiance au `countries` du client).
 *
 * Règle : un tenant MONO-PAYS (has_subsidiaries = false) ne peut sourcer QUE dans
 * son propre pays — quel que soit le payload (un admin mono-pays ne peut pas
 * forger une requête multi-pays). Un tenant MULTI-PAYS conserve sa sélection
 * (repli sur son pays par défaut si vide).
 */

// ISO 3166-1 alpha-3 → alpha-2 (codes utilisés par le sourcing). Aligné sur le
// front. Repli : 2 premières lettres si inconnu.
const ISO3_TO_ISO2: Record<string, string> = {
  CIV: 'CI', SEN: 'SN', BEN: 'BJ', TGO: 'TG', BFA: 'BF', MLI: 'ML',
  NER: 'NE', CMR: 'CM', TCD: 'TD', NGA: 'NG', GHA: 'GH', FRA: 'FR',
}

export function toIso2(countryCode: string | null | undefined): string {
  const raw = (countryCode ?? 'CIV').toUpperCase()
  return ISO3_TO_ISO2[raw] ?? raw.slice(0, 2)
}

export interface AllowedSourcingCountries {
  countries: string[]
  multiCountry: boolean
  tenantCountry: string
}

/**
 * Résout la liste effective des pays de sourcing pour le tenant courant.
 * `requested` = pays demandés par le client (ignorés si mono-pays).
 */
export async function resolveSourcingCountries(
  pool: Pool, schemaName: string, requested: string[] | undefined,
): Promise<AllowedSourcingCountries> {
  let multiCountry = false
  let tenantCountry = 'CI'
  if (isValidSchemaName(schemaName)) {
    try {
      const r = await pool.query<{ has_subsidiaries: boolean | null; payroll_mode: string | null; default_country_code: string | null }>(
        `SELECT has_subsidiaries, payroll_mode, default_country_code
           FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schemaName],
      )
      const t = r.rows[0]
      if (t) {
        multiCountry = t.has_subsidiaries === true || t.payroll_mode === 'multi_country'
        tenantCountry = toIso2(t.default_country_code)
      }
    } catch { /* défauts prudents : mono-pays CI */ }
  }

  if (!multiCountry) {
    // Mono-pays : on force le pays du tenant, on ignore tout `requested`.
    return { countries: [tenantCountry], multiCountry, tenantCountry }
  }
  // Multi-pays : sélection du client, nettoyée ; repli sur le pays du tenant.
  const cleaned = Array.isArray(requested)
    ? [...new Set(requested.map(c => String(c).toUpperCase()).filter(c => /^[A-Z]{2}$/.test(c)))]
    : []
  return {
    countries: cleaned.length ? cleaned : [tenantCountry],
    multiCountry, tenantCountry,
  }
}
