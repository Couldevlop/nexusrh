/**
 * Signature électronique — logique PURE (workflow & dérivation de statut).
 *
 * Une demande de signature (signature_request) porte un document et une liste
 * ordonnée de signataires. Le statut de la demande se DÉDUIT de l'état des
 * signataires (et de l'échéance) ; ce service centralise ces règles sans
 * dépendance Fastify/DB → testable.
 *
 * Conforme à l'exigence DAO « signature électronique » : piste d'audit par
 * signataire (qui, quand, IP) gérée côté routes (OWASP A09).
 */

export const REQUEST_STATUSES = ['draft', 'pending', 'signed', 'declined', 'cancelled', 'expired'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const SIGNATORY_STATUSES = ['pending', 'signed', 'declined'] as const
export type SignatoryStatus = (typeof SIGNATORY_STATUSES)[number]

// Types de documents signables (bornés — OWASP A03).
export const DOCUMENT_TYPES = ['contract', 'amendment', 'certificate', 'disciplinary', 'offer', 'policy', 'other'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export function isValidRequestStatus(s: unknown): s is RequestStatus {
  return typeof s === 'string' && (REQUEST_STATUSES as readonly string[]).includes(s)
}
export function isValidDocumentType(s: unknown): s is DocumentType {
  return typeof s === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(s)
}

export interface Signatory {
  status: SignatoryStatus
  orderIndex: number
}

/** Une demande à l'état brouillon peut-elle être envoyée ? (au moins un signataire). */
export function canSend(status: RequestStatus, signatoryCount: number): boolean {
  return status === 'draft' && signatoryCount >= 1
}

/** Statuts depuis lesquels l'annulation est possible. */
export function canCancel(status: RequestStatus): boolean {
  return status === 'draft' || status === 'pending'
}

/** Seule une demande brouillon est supprimable (sinon : annuler pour conserver la piste). */
export function canDelete(status: RequestStatus): boolean {
  return status === 'draft'
}

/**
 * Déduit le statut d'une demande ENVOYÉE à partir de ses signataires :
 *  - un refus → declined
 *  - tous signés → signed
 *  - échéance dépassée → expired
 *  - sinon → pending
 */
export function deriveStatus(signatories: Signatory[], opts: { expired?: boolean } = {}): RequestStatus {
  if (signatories.some((s) => s.status === 'declined')) return 'declined'
  if (signatories.length > 0 && signatories.every((s) => s.status === 'signed')) return 'signed'
  if (opts.expired) return 'expired'
  return 'pending'
}

/**
 * Ordre du prochain signataire à devoir agir. En mode séquentiel, c'est le plus
 * petit orderIndex parmi les signataires en attente ; en mode parallèle, tous
 * les « pending » peuvent signer (retourne null = pas de contrainte d'ordre).
 */
export function nextSignatoryOrder(signatories: Signatory[], sequential: boolean): number | null {
  if (!sequential) return null
  const pending = signatories.filter((s) => s.status === 'pending').map((s) => s.orderIndex)
  return pending.length ? Math.min(...pending) : null
}

/** Un signataire donné peut-il signer maintenant ? (demande active, à son tour). */
export function canSignatorySign(
  requestStatus: RequestStatus,
  signatory: Signatory | undefined,
  allSignatories: Signatory[],
  sequential: boolean,
): boolean {
  if (requestStatus !== 'pending') return false
  if (!signatory || signatory.status !== 'pending') return false
  const next = nextSignatoryOrder(allSignatories, sequential)
  return next === null || signatory.orderIndex === next
}

/** Avancement d'une demande (pour la barre de progression / KPIs). */
export function progress(signatories: Signatory[]): { signed: number; declined: number; total: number; pct: number } {
  const total = signatories.length
  const signed = signatories.filter((s) => s.status === 'signed').length
  const declined = signatories.filter((s) => s.status === 'declined').length
  const pct = total === 0 ? 0 : Math.round((signed / total) * 100)
  return { signed, declined, total, pct }
}
