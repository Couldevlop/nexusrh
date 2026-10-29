/**
 * Libellés pays d'un bulletin de paie (caisse sociale, impôt sur salaires, pays).
 *
 * Les lignes d'un bulletin portent déjà les libellés du pack qui les a calculées
 * (« CNSS Retraite salarié », « IUTS — … »). Les écrans et documents qui
 * résument le bulletin (bandeau KPI, en-têtes de colonnes, PDF) doivent suivre
 * le même pack au lieu d'afficher « CNPS » / « ITS » en dur.
 *
 * Résolution du pack = celle du moteur de paie (resolvePayrollContext) :
 * filiale du bulletin (pay_slips.legal_entity_id → legal_entities.legislation_pack_code,
 * sinon pays de la filiale), sinon pack du pays par défaut du tenant, sinon CIV-2024.
 */
import { resolvePayrollContext } from './payroll-context-resolver.js'
import { COUNTRY_LABELS, type LegislationPack } from './legislation-packs.js'

interface Queryable {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export interface PayslipCountryLabels {
  /** Code du pack législatif appliqué (ex. BFA-2024). */
  packCode: string
  /** Pays ISO alpha-3 du pack (ex. BFA). */
  countryCode: string
  /** Nom du pays en français (ex. « Burkina Faso »). */
  countryName: string
  /** Libellé complet de la caisse sociale (ex. « IPRES + CSS »). */
  caisse: string
  /** Libellé court de la caisse (ex. « IPRES »). */
  caisseShort: string
  /** Libellé complet de l'impôt sur salaires (ex. « IUTS — Impôt Unique… »). */
  impot: string
  /** Abréviation de l'impôt : partie avant « — » (ex. « IUTS »). */
  impotShort: string
}

/** Version courte de la caisse : premier mot (« IPRES + CSS » → « IPRES », « CNPS Tchad » → « CNPS »). */
export function shortCaisseLabel(label: string | null | undefined): string {
  const first = (label ?? '').trim().split(/[\s+/]+/)[0]
  return first || 'CNPS'
}

/** Abréviation de l'impôt : partie avant le tiret cadratin (« IUTS — … » → « IUTS »). */
export function shortImpotLabel(label: string | null | undefined): string {
  const head = (label ?? '').split(/\s[—–-]\s|—/)[0]?.trim()
  return head || 'ITS'
}

export function payslipLabelsFromPack(pack: LegislationPack): PayslipCountryLabels {
  return {
    packCode: pack.code,
    countryCode: pack.countryCode,
    countryName: COUNTRY_LABELS[pack.countryCode] ?? pack.name,
    caisse: pack.labelCaisseSociale,
    caisseShort: shortCaisseLabel(pack.labelCaisseSociale),
    impot: pack.labelImpotSalaire,
    impotShort: shortImpotLabel(pack.labelImpotSalaire),
  }
}

interface TenantRow {
  id: string; at_rate: string | null; has_subsidiaries: boolean | null; default_country_code: string | null
}
interface LegalEntityRow {
  id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null
}

/**
 * Charge le tenant et les filiales demandées une fois, puis renvoie une
 * fonction (synchrone) qui donne les libellés pour la filiale d'un bulletin.
 * Tables/colonnes absentes (tenant non migré) : repli silencieux sur le tenant.
 */
export async function createPayslipLabelResolver(
  db: Queryable,
  schema: string,
  legalEntityIds: ReadonlyArray<string | null | undefined>,
): Promise<(legalEntityId: string | null | undefined) => PayslipCountryLabels> {
  let tenant: TenantRow | undefined
  try {
    const t = await db.query<TenantRow>(
      `SELECT id, at_rate, has_subsidiaries, default_country_code
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
    )
    tenant = t?.rows?.[0]
  } catch { tenant = undefined }

  const ids = [...new Set(legalEntityIds.filter((x): x is string => typeof x === 'string' && x.length > 0))]
  const entities = new Map<string, LegalEntityRow>()
  if (ids.length > 0) {
    try {
      const le = await db.query<LegalEntityRow>(
        `SELECT id, at_rate, legislation_pack_code, country_code
           FROM "${schema}".legal_entities WHERE id = ANY($1::uuid[])`, [ids],
      )
      for (const r of le?.rows ?? []) entities.set(r.id, r)
    } catch { /* table absente : repli tenant */ }
  }

  const cache = new Map<string, PayslipCountryLabels>()
  return (legalEntityId) => {
    const key = legalEntityId ?? ''
    const hit = cache.get(key)
    if (hit) return hit
    const le = legalEntityId ? entities.get(legalEntityId) : undefined
    const resolved = resolvePayrollContext({
      tenant: {
        id: tenant?.id ?? '',
        // Un bulletin rattaché à une filiale a été calculé avec le pack de la filiale.
        hasSubsidiaries: (tenant?.has_subsidiaries ?? false) || !!le,
        atRate: parseFloat(tenant?.at_rate ?? '0.020'),
        defaultCountryCode: tenant?.default_country_code ?? null,
      },
      employee: { id: '', legalEntityId: le?.id ?? null },
      legalEntity: le ? {
        id: le.id,
        atRate: le.at_rate ? parseFloat(le.at_rate) : null,
        legislationPackCode: le.legislation_pack_code,
        countryCode: le.country_code,
      } : null,
    })
    const labels = payslipLabelsFromPack(resolved.legislationPack)
    cache.set(key, labels)
    return labels
  }
}

/** Libellés pays d'un bulletin donné (filiale lue sur pay_slips.legal_entity_id). */
export async function loadPayslipCountryLabels(
  db: Queryable,
  schema: string,
  slipId: string,
): Promise<PayslipCountryLabels> {
  let legalEntityId: string | null = null
  try {
    const r = await db.query<{ legal_entity_id: string | null }>(
      `SELECT legal_entity_id FROM "${schema}".pay_slips WHERE id = $1 LIMIT 1`, [slipId],
    )
    legalEntityId = r?.rows?.[0]?.legal_entity_id ?? null
  } catch { legalEntityId = null }
  const resolve = await createPayslipLabelResolver(db, schema, [legalEntityId])
  return resolve(legalEntityId)
}
