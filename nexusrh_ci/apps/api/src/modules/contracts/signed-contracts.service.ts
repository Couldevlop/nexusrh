/**
 * Contrat de travail signé dans l'espace employé — règles PURES + accès options.
 *
 * - Options tenant (platform.tenants, réglées par l'admin dans Paramètres) :
 *     employee_contract_access : l'employé consulte son contrat signé ;
 *     manager_contract_upload  : le manager dépose le contrat signé d'un membre
 *                                de son périmètre (manager-scope.service).
 *   Lecture fail-closed : erreur DB / colonne absente → options désactivées.
 * - Validation du fichier (OWASP A03/A08) : PDF uniquement, taille bornée,
 *   signature binaire « %PDF- » vérifiée (le MIME déclaré ne suffit pas).
 * - Fusion des sources affichées à l'employé : dépôts RH/manager
 *   (employee_documents) + demandes de signature électronique terminées
 *   (module signature) dont il est signataire.
 */
import type { Pool } from 'pg'

export const SIGNED_CONTRACT_CATEGORY = 'signed_contract'

/** Taille max d'un contrat signé (PDF scanné multi-pages) — 10 Mo, = limite multipart globale. */
export const SIGNED_CONTRACT_MAX_BYTES = 10 * 1024 * 1024

/** Types de demande de signature électronique rattachés au contrat de travail. */
export const SIGNATURE_CONTRACT_TYPES = ['contract', 'amendment'] as const

export interface SignedContractOptions {
  employeeContractAccess: boolean
  managerContractUpload: boolean
}

export const OPTIONS_DISABLED: SignedContractOptions = {
  employeeContractAccess: false,
  managerContractUpload: false,
}

export async function loadSignedContractOptions(pool: Pool, schemaName: string): Promise<SignedContractOptions> {
  try {
    const r = await pool.query<{ employee_contract_access: boolean | null; manager_contract_upload: boolean | null }>(
      `SELECT COALESCE(employee_contract_access, false) AS employee_contract_access,
              COALESCE(manager_contract_upload, false) AS manager_contract_upload
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
      [schemaName],
    )
    const row = r?.rows?.[0]
    if (!row) return { ...OPTIONS_DISABLED }
    return {
      employeeContractAccess: row.employee_contract_access === true,
      managerContractUpload: row.manager_contract_upload === true,
    }
  } catch {
    return { ...OPTIONS_DISABLED }
  }
}

export type PdfCheck =
  | { ok: true }
  | { ok: false; reason: 'mime' | 'extension' | 'empty' | 'too_large' | 'signature' }

/** Validation d'un contrat signé uploadé : MIME + extension + taille + octets magiques. */
export function checkSignedContractPdf(buf: Buffer, mimetype: string, filename: string): PdfCheck {
  if ((mimetype || '').toLowerCase() !== 'application/pdf') return { ok: false, reason: 'mime' }
  if (!/\.pdf$/i.test(filename || '')) return { ok: false, reason: 'extension' }
  if (buf.length === 0) return { ok: false, reason: 'empty' }
  if (buf.length > SIGNED_CONTRACT_MAX_BYTES) return { ok: false, reason: 'too_large' }
  // « %PDF- » : un exécutable ou un HTML renommé en .pdf est rejeté.
  if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, reason: 'signature' }
  return { ok: true }
}

export const PDF_CHECK_MESSAGES: Record<Exclude<PdfCheck, { ok: true }>['reason'], string> = {
  mime: 'Format non autorisé : seul le PDF est accepté pour un contrat signé.',
  extension: 'Le fichier doit porter l\'extension .pdf.',
  empty: 'Le fichier est vide.',
  too_large: 'Fichier trop volumineux (10 Mo maximum).',
  signature: 'Le contenu du fichier ne correspond pas à un PDF valide.',
}

/** Nom de fichier assaini (en-tête Content-Disposition, affichage). */
export function safePdfFileName(name: string | null | undefined): string {
  const base = String(name ?? '').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!base || base === '.pdf') return 'contrat-signe.pdf'
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`
}

export interface SignedDocumentRow {
  id: string
  contract_id: string | null
  title: string | null
  file_name: string
  size_bytes: number
  version: number
  is_current: boolean
  created_at: string
  contract_type: string | null
  contract_start_date: string | null
}

export interface SignatureRow {
  id: string
  title: string
  document_type: string
  document_id: string | null
  completed_at: string | null
}

export interface SignedContractItem {
  id: string
  source: 'upload' | 'signature'
  title: string | null
  contractId: string | null
  contractType: string | null
  contractStartDate: string | null
  fileName: string | null
  sizeBytes: number | null
  version: number | null
  isCurrent: boolean
  createdAt: string | null
  /** Date de signature électronique (module signature), si le document en est issu. */
  signedElectronicallyAt: string | null
  /** Identifiant du document téléchargeable (employee_documents.id) ou null. */
  fileDocumentId: string | null
}

/**
 * Fusionne les dépôts et les signatures électroniques terminées.
 * Une demande de signature dont `document_id` désigne un document déposé
 * (ou le contrat auquel il est rattaché) ANNOTE ce document au lieu d'être
 * listée à part ; sinon elle apparaît seule (sans fichier si aucun dépôt).
 */
export function mergeSignedContracts(docs: SignedDocumentRow[], sigs: SignatureRow[]): SignedContractItem[] {
  const items: SignedContractItem[] = docs.map((d) => ({
    id: d.id,
    source: 'upload',
    title: d.title,
    contractId: d.contract_id,
    contractType: d.contract_type,
    contractStartDate: d.contract_start_date,
    fileName: d.file_name,
    sizeBytes: d.size_bytes,
    version: d.version,
    isCurrent: d.is_current,
    createdAt: d.created_at,
    signedElectronicallyAt: null,
    fileDocumentId: d.id,
  }))
  const byId = new Map(items.map((i) => [i.id, i]))
  for (const s of sigs) {
    const direct = s.document_id ? byId.get(s.document_id) : undefined
    const viaContract = !direct && s.document_id
      ? items.find((i) => i.contractId === s.document_id && i.isCurrent)
      : undefined
    const target = direct ?? viaContract
    if (target) {
      target.signedElectronicallyAt = s.completed_at
      continue
    }
    items.push({
      id: s.id,
      source: 'signature',
      title: s.title,
      contractId: null,
      contractType: null,
      contractStartDate: null,
      fileName: null,
      sizeBytes: null,
      version: null,
      isCurrent: true,
      createdAt: s.completed_at,
      signedElectronicallyAt: s.completed_at,
      fileDocumentId: null,
    })
  }
  return items
}
