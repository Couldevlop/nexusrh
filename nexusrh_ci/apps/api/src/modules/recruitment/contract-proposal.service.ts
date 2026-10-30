/**
 * Proposition de contrat (recrutement) — accès aux données.
 *
 * Le contrat généré au recrutement est une PROPOSITION : elle porte les
 * mentions légales, le logo et la couleur de l'employeur, la RH l'édite avant
 * envoi, et le contrat finalement signé (PDF déposé, catégorie
 * `signed_contract`) peut en différer. Chaque enregistrement = nouvelle
 * version (`contract_proposals`, historique conservé).
 *
 * La génération est une OPTION du tenant (`contract_generation_enabled`,
 * admin) — lecture fail-closed : toute erreur vaut « désactivée ».
 *
 * SÉCURITÉ : le schéma vient TOUJOURS du JWT (appelant) ; aucune requête
 * réseau n'est faite pour le logo (pas de SSRF) : seuls les logos stockés en
 * base (platform.brand_assets) ou fournis en data URL PNG/JPEG sont utilisés.
 */
import { pool } from '../../db/pool.js'
import type { HrDocumentBranding, HrDocumentLegalInfo } from './hr-document-pdf.js'

/** Catégorie employee_documents d'une proposition versée au dossier. */
export const CONTRACT_PROPOSAL_CATEGORY = 'contract_proposal'
/** Taille maximale du texte (markdown) d'une proposition éditée. */
export const PROPOSAL_MARKDOWN_MAX = 100_000
/** Marque visible sur chaque proposition rendue. */
export const PROPOSAL_DRAFT_MARK = 'PROPOSITION — document non signé'

export const CONTRACT_GENERATION_DISABLED = {
  error: 'La génération de proposition de contrat n\'est pas activée pour votre entreprise. '
    + 'L\'administrateur peut l\'activer dans Paramètres → Général.',
  featureDisabled: true,
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024
const BRAND_ASSET_RE = /\/public\/brand\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const DATA_URL_RE = /^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=\s]+)$/i

/** Option tenant — fail-closed (erreur, tenant absent → false). */
export async function isContractGenerationEnabled(schema: string): Promise<boolean> {
  try {
    const r = await pool.query<{ enabled: boolean | null }>(
      `SELECT COALESCE(contract_generation_enabled, false) AS enabled
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
      [schema],
    )
    return r?.rows?.[0]?.enabled === true
  } catch {
    return false
  }
}

/** Logo du tenant en octets PNG/JPEG, ou null (SVG, URL externe, illisible). */
async function resolveLogo(logoUrl: string | null): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!logoUrl) return null
  try {
    const data = DATA_URL_RE.exec(logoUrl)
    if (data) {
      const bytes = Buffer.from(data[2]!.replace(/\s+/g, ''), 'base64')
      if (!bytes.byteLength || bytes.byteLength > LOGO_MAX_BYTES) return null
      return { bytes: new Uint8Array(bytes), mime: data[1]!.toLowerCase() }
    }
    const asset = BRAND_ASSET_RE.exec(logoUrl)
    if (!asset) return null
    const r = await pool.query<{ bytes: Buffer; mime: string }>(
      `SELECT bytes, mime FROM platform.brand_assets WHERE id = $1 LIMIT 1`, [asset[1]],
    )
    const row = r?.rows?.[0]
    if (!row || !/png|jpe?g/i.test(row.mime) || row.bytes.byteLength > LOGO_MAX_BYTES) return null
    return { bytes: new Uint8Array(row.bytes), mime: row.mime }
  } catch {
    return null
  }
}

export interface ContractEmployer {
  legal: HrDocumentLegalInfo
  branding: HrDocumentBranding
  /** Filiale effectivement retenue (null = tenant). */
  legalEntityId: string | null
}

/**
 * Employeur de la proposition : filiale de l'offre si renseignée et active,
 * sinon le tenant. Habillage : logo + couleur principale du tenant.
 */
export async function loadContractEmployer(schema: string, legalEntityId: string | null): Promise<ContractEmployer> {
  const tRes = await pool.query<{
    name: string; city: string | null; cnps_number: string | null; rccm: string | null
    dgi_number: string | null; primary_color: string | null; logo_url: string | null
  }>(
    `SELECT name, city, cnps_number, rccm, dgi_number, primary_color, logo_url
       FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
    [schema],
  )
  const tenant = tRes?.rows?.[0]
  let legal: HrDocumentLegalInfo = {
    name: tenant?.name ?? 'L\'Employeur',
    rccm: tenant?.rccm ?? null,
    cnpsNumber: tenant?.cnps_number ?? null,
    dgiNumber: tenant?.dgi_number ?? null,
    city: tenant?.city ?? null,
  }
  let entityId: string | null = null
  if (legalEntityId) {
    const leRes = await pool.query<{
      id: string; name: string; legal_form: string | null; rccm: string | null; cnps_number: string | null
      dgi_number: string | null; address: string | null; city: string | null; collective_agreement: string | null
    }>(
      `SELECT id, name, legal_form, rccm, cnps_number, dgi_number, address, city, collective_agreement
         FROM "${schema}".legal_entities WHERE id = $1 AND is_active IS DISTINCT FROM false LIMIT 1`,
      [legalEntityId],
    ).catch(() => ({ rows: [] as never[] }))
    const le = leRes?.rows?.[0]
    if (le) {
      entityId = le.id
      legal = {
        name: le.name, legalForm: le.legal_form, rccm: le.rccm, cnpsNumber: le.cnps_number,
        dgiNumber: le.dgi_number, address: le.address, city: le.city, collectiveAgreement: le.collective_agreement,
      }
    }
  }
  const logo = await resolveLogo(tenant?.logo_url ?? null)
  return {
    legal,
    legalEntityId: entityId,
    branding: { logo, primaryColor: tenant?.primary_color ?? null, legal, draftMark: PROPOSAL_DRAFT_MARK },
  }
}

export interface SaveProposalInput {
  applicationId: string
  legalEntityId: string | null
  contractType: string
  /** null = conserver les conditions de l'offre déjà mémorisées. */
  offerDetails: Record<string, unknown> | null
  markdown: string
  pdf: Buffer
  fileName: string
  createdBy: string | null
}

export interface SavedProposal { id: string; version: number; created_at: string }

/**
 * Enregistre une NOUVELLE version courante (la précédente est archivée) et
 * garde `applications.contract_pdf` aligné sur la version courante : c'est ce
 * PDF que l'embauche verse au dossier salarié (catégorie contract_proposal).
 */
export async function saveContractProposal(schema: string, input: SaveProposalInput): Promise<SavedProposal> {
  const offer = input.offerDetails ?? {}
  const r = await pool.query<SavedProposal>(
    `WITH prev AS (
       UPDATE "${schema}".contract_proposals SET is_current = false
        WHERE application_id = $1 AND is_current = true
       RETURNING id
     ),
     ins AS (
       INSERT INTO "${schema}".contract_proposals
         (application_id, legal_entity_id, contract_type, offer_details, markdown, version, is_current, pdf, created_by)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, (
                 SELECT offer_details FROM "${schema}".contract_proposals
                  WHERE application_id = $1 ORDER BY version DESC LIMIT 1), '{}'::jsonb),
               $5,
               (SELECT COALESCE(MAX(version), 0) + 1 FROM "${schema}".contract_proposals WHERE application_id = $1),
               true, $6, $7)
       RETURNING id, version, created_at
     )
     SELECT id, version, created_at FROM ins`,
    [input.applicationId, input.legalEntityId, input.contractType,
      input.offerDetails ? JSON.stringify(offer) : null, input.markdown, input.pdf, input.createdBy],
  )
  const saved = r.rows[0]
  if (!saved) throw new Error('Proposition non enregistrée')
  await pool.query(
    `UPDATE "${schema}".applications
        SET offer_details = COALESCE($2::jsonb, offer_details),
            contract_pdf = $3, contract_pdf_name = $4, contract_pdf_at = now()
      WHERE id = $1`,
    [input.applicationId, input.offerDetails ? JSON.stringify(offer) : null, input.pdf, input.fileName],
  )
  return saved
}

export interface ProposalVersionRow {
  id: string; version: number; is_current: boolean; created_at: string
  created_by: string | null; contract_type: string; size_bytes: number
  legal_entity_id: string | null; markdown: string | null
}

/** Versions d'une proposition (récentes d'abord) ; markdown de la version courante seulement. */
export async function listProposalVersions(schema: string, applicationId: string): Promise<ProposalVersionRow[]> {
  const r = await pool.query<ProposalVersionRow>(
    `SELECT id, version, is_current, created_at, created_by, contract_type, legal_entity_id,
            octet_length(pdf)::int AS size_bytes,
            CASE WHEN is_current THEN markdown END AS markdown
       FROM "${schema}".contract_proposals
      WHERE application_id = $1
      ORDER BY version DESC`,
    [applicationId],
  )
  return r?.rows ?? []
}

/** PDF d'une version (courante si `version` absent). */
export async function getProposalPdf(
  schema: string, applicationId: string, version?: number,
): Promise<{ pdf: Buffer; version: number } | null> {
  const r = await pool.query<{ pdf: Buffer; version: number }>(
    version === undefined
      ? `SELECT pdf, version FROM "${schema}".contract_proposals
          WHERE application_id = $1 AND is_current = true ORDER BY version DESC LIMIT 1`
      : `SELECT pdf, version FROM "${schema}".contract_proposals
          WHERE application_id = $1 AND version = $2 LIMIT 1`,
    version === undefined ? [applicationId] : [applicationId, version],
  )
  return r?.rows?.[0] ?? null
}

/** Rattache les propositions de la candidature à la fiche créée à l'embauche. */
export async function linkProposalsToEmployee(schema: string, applicationId: string, employeeId: string): Promise<void> {
  await pool.query(
    `UPDATE "${schema}".contract_proposals SET employee_id = $2
      WHERE application_id = $1 AND employee_id IS NULL`,
    [applicationId, employeeId],
  )
}

/** Nom de fichier ASCII sûr pour une proposition. */
export function proposalFileName(contractType: string, lastName: string | null, version?: number): string {
  const base = `proposition_${contractType}_${(lastName || 'contrat').normalize('NFD').replace(/[^a-zA-Z0-9]/g, '')}`
  return `${base}${version ? `_v${version}` : ''}.pdf`
}
