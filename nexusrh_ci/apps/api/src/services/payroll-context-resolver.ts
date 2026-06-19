/**
 * Résolution du contexte paie d'un employé — Clean Architecture.
 *
 * Responsabilité unique : à partir d'un tenant + un employé (et de la filiale
 * éventuellement rattachée), retourner les paramètres à injecter dans le moteur :
 *   - `atRate`               : taux AT CNPS à appliquer
 *   - `legislationPackCode`  : code du pack législatif (ex. CIV-2024)
 *   - `legalEntityId`        : UUID de la filiale source (null si mono-filiale)
 *
 * Cette fonction est PURE (pas de query DB) : on lui passe les rows déjà lues
 * (tenant + employee + legalEntity). Ainsi elle est trivialement testable et
 * isolée de Fastify / pg / autres I/O — conforme Clean Architecture.
 *
 * Règles métier (ordre de priorité) :
 *
 *   1. Tenant mono-filiale (has_subsidiaries=false) :
 *      → atRate = tenant.atRate
 *      → packCode = tenant.defaultCountryCode → mapping pays→pack actif
 *      → legalEntityId = null
 *
 *   2. Tenant multi-filiales + employé rattaché à une filiale :
 *      → atRate = legalEntity.atRate (fallback tenant.atRate si NULL)
 *      → packCode = legalEntity.legislationPackCode (fallback tenant)
 *      → legalEntityId = legalEntity.id
 *
 *   3. Tenant multi-filiales + employé NON rattaché (legacy / migration) :
 *      → fallback tenant + warning attendu côté caller (à logger en A09)
 *
 *   4. Pack rejeté si status='stub' (sécurité — fait par le moteur lui-même).
 *
 * OWASP :
 *   - A04 (Insecure Design) : refus explicite des packs stub (sécurité finance)
 *   - A09 (Audit) : caller doit logger toute résolution par fallback
 */
import {
  DEFAULT_LEGISLATION_PACK,
  LEGISLATION_PACKS,
  type LegislationPack,
} from './legislation-packs.js'

export interface TenantPayrollInfo {
  id:                   string
  hasSubsidiaries:      boolean
  atRate:               number             // taux global tenant
  defaultCountryCode?:  string | null      // 'CIV', 'SEN', etc. (pour mapping pack)
  defaultPackCode?:     string | null      // ex. 'CIV-2024' (préséance sur countryCode)
}

export interface EmployeePayrollInfo {
  id:               string
  legalEntityId?:   string | null
}

export interface LegalEntityPayrollInfo {
  id:                  string
  atRate?:             number | null
  legislationPackCode?: string | null
  countryCode?:        string | null      // ISO alpha-3 (ex. 'CIV')
}

export interface ResolvedPayrollContext {
  atRate:               number
  legislationPackCode:  string
  legislationPack:      LegislationPack
  legalEntityId:        string | null
  /** Raison de la résolution (utile pour audit log / debug) */
  source: 'tenant_global' | 'legal_entity' | 'tenant_fallback_legacy'
  warnings: string[]
}

// Mapping pays ISO alpha-3 → code pack par défaut, si ni `defaultPackCode` ni
// `legislationPackCode` filiale n'est défini. Permet une config minimale :
// l'admin choisit juste un pays, le pack actif correspondant est appliqué.
const COUNTRY_TO_PACK: Record<string, string> = {
  CIV: 'CIV-2024',
  BEN: 'BEN-2024',
  TGO: 'TGO-2024',
  BFA: 'BFA-2024',
  SEN: 'SEN-2024',
  MLI: 'MLI-2024',
  NER: 'NER-2024',
  TCD: 'TCD-2024',
  NGA: 'NGA-2024',
}

function packFromCode(code: string | null | undefined): { pack: LegislationPack; code: string } {
  if (code && LEGISLATION_PACKS[code]) {
    return { pack: LEGISLATION_PACKS[code], code }
  }
  return { pack: DEFAULT_LEGISLATION_PACK, code: DEFAULT_LEGISLATION_PACK.code }
}

function packFromCountry(country: string | null | undefined): string | null {
  if (!country) return null
  return COUNTRY_TO_PACK[country.toUpperCase()] ?? null
}

/**
 * Bornes anti-fraude GÉNÉRIQUES sur le taux AT (employeur), utilisées quand le
 * pack législatif du pays ne précise pas ses propres bornes. Les taux AT légitimes
 * varient fortement selon les pays (CI 2-5%, SEN/NGA ~1%, NER ~1,75%) : on retient
 * un intervalle large [0,5% ; 10%] pour ne pas rejeter un taux étranger valide,
 * tout en bloquant les valeurs aberrantes. Le pack CIV-2024 surcharge avec [2% ; 5%].
 */
const AT_RATE_MIN_GENERIC = 0.005
const AT_RATE_MAX_GENERIC = 0.10

function safeAtRate(
  value: number | null | undefined,
  fallback: number,
  bounds?: { min?: number; max?: number },
): { rate: number; usedFallback: boolean } {
  const min = bounds?.min ?? AT_RATE_MIN_GENERIC
  const max = bounds?.max ?? AT_RATE_MAX_GENERIC
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { rate: fallback, usedFallback: true }
  }
  if (value < min || value > max) {
    return { rate: fallback, usedFallback: true }
  }
  return { rate: value, usedFallback: false }
}

/**
 * Résolution principale (fonction pure).
 */
export function resolvePayrollContext(args: {
  tenant:      TenantPayrollInfo
  employee:    EmployeePayrollInfo
  legalEntity?: LegalEntityPayrollInfo | null
}): ResolvedPayrollContext {
  const { tenant, employee, legalEntity } = args
  const warnings: string[] = []

  // CAS 1 — Tenant mono-filiale
  if (!tenant.hasSubsidiaries) {
    const packCode = tenant.defaultPackCode ?? packFromCountry(tenant.defaultCountryCode) ?? DEFAULT_LEGISLATION_PACK.code
    const { pack, code } = packFromCode(packCode)
    const at = safeAtRate(tenant.atRate, pack.tauxAtDefaultPatronal ?? AT_RATE_MIN_GENERIC, { min: pack.tauxAtMin, max: pack.tauxAtMax })
    if (at.usedFallback) warnings.push(`at_rate tenant invalide ou absent — fallback ${at.rate}`)
    return {
      atRate:              at.rate,
      legislationPackCode: code,
      legislationPack:     pack,
      legalEntityId:       null,
      source:              'tenant_global',
      warnings,
    }
  }

  // CAS 2 — Tenant multi-filiale + employé rattaché à une filiale connue
  if (employee.legalEntityId && legalEntity && legalEntity.id === employee.legalEntityId) {
    const tenantFallbackPack = tenant.defaultPackCode ?? packFromCountry(tenant.defaultCountryCode) ?? DEFAULT_LEGISLATION_PACK.code
    const packCode = legalEntity.legislationPackCode
                  ?? packFromCountry(legalEntity.countryCode)
                  ?? tenantFallbackPack
    const { pack, code } = packFromCode(packCode)
    const at = safeAtRate(legalEntity.atRate, tenant.atRate, { min: pack.tauxAtMin, max: pack.tauxAtMax })
    if (at.usedFallback) warnings.push(`legal_entity.at_rate invalide ou absent — fallback tenant ${at.rate}`)
    return {
      atRate:              at.rate,
      legislationPackCode: code,
      legislationPack:     pack,
      legalEntityId:       legalEntity.id,
      source:              'legal_entity',
      warnings,
    }
  }

  // CAS 3 — Tenant multi-filiale + employé orphelin (legacy / migration partielle)
  warnings.push(
    employee.legalEntityId
      ? `legal_entity ${employee.legalEntityId} non chargée — fallback tenant (vérifier la migration)`
      : 'employé sans legal_entity_id sur un tenant multi-filiale — fallback tenant',
  )
  const fallbackPackCode = tenant.defaultPackCode ?? packFromCountry(tenant.defaultCountryCode) ?? DEFAULT_LEGISLATION_PACK.code
  const { pack, code } = packFromCode(fallbackPackCode)
  return {
    atRate:              tenant.atRate,
    legislationPackCode: code,
    legislationPack:     pack,
    legalEntityId:       null,
    source:              'tenant_fallback_legacy',
    warnings,
  }
}
