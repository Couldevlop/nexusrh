/**
 * YouSign API v3 — Service de signature électronique.
 * Documentation : https://developers.yousign.com/
 *
 * Variables d'environnement requises :
 *   YOUSIGN_API_KEY=<your_api_key>
 *   YOUSIGN_BASE_URL=https://api.yousign.app/v3   (production)
 *              ou   https://api-sandbox.yousign.app/v3  (sandbox)
 *   YOUSIGN_WEBHOOK_SECRET=<votre_secret_webhook>
 */
import crypto from 'crypto'
import { logger } from '../utils/logger'

const YOUSIGN_BASE_URL = process.env['YOUSIGN_BASE_URL'] ?? 'https://api-sandbox.yousign.app/v3'
const YOUSIGN_API_KEY = process.env['YOUSIGN_API_KEY'] ?? ''
const YOUSIGN_WEBHOOK_SECRET = process.env['YOUSIGN_WEBHOOK_SECRET'] ?? ''

// ── Interfaces YouSign ────────────────────────────────────────────────────────

export interface SignatureRequestSigner {
  firstName: string
  lastName: string
  email: string
  phone?: string
  locale?: string // 'fr', 'en', etc.
}

export interface SignatureRequestResult {
  signatureRequestId: string
  signingLink: string | null
  status: string
  expiresAt: string
}

export interface SignatureStatusResult {
  status: 'approval_pending' | 'ongoing' | 'done' | 'canceled' | 'expired'
  signers: Array<{
    id: string
    email: string
    firstName: string
    lastName: string
    status: 'initiated' | 'notified' | 'verified' | 'signed' | 'declined' | 'error'
    signedAt: string | null
  }>
  documentUrl: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function youSignFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!YOUSIGN_API_KEY) {
    throw new Error('YOUSIGN_API_KEY non configurée — signature électronique désactivée')
  }

  const url = `${YOUSIGN_BASE_URL}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${YOUSIGN_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`YouSign API error ${response.status}: ${body.slice(0, 300)}`)
  }

  return response.json() as Promise<T>
}

// ── API Publique ──────────────────────────────────────────────────────────────

/**
 * Créer une demande de signature pour un document (PDF en base64 ou URL).
 */
export async function createSignatureRequest(params: {
  documentName: string
  documentBase64?: string
  documentUrl?: string
  signers: SignatureRequestSigner[]
  message?: string
  expiresInDays?: number
  webhookCallbackUrl?: string
}): Promise<SignatureRequestResult> {
  const { documentName, documentBase64, documentUrl, signers, message, expiresInDays = 30, webhookCallbackUrl } = params

  if (!documentBase64 && !documentUrl) {
    throw new Error('documentBase64 ou documentUrl requis')
  }

  try {
    // Étape 1 : Créer la demande de signature
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + expiresInDays)

    const signatureRequest = await youSignFetch<{ id: string; status: string; expires_at: string }>('/signature_requests', {
      method: 'POST',
      body: JSON.stringify({
        name: documentName,
        delivery_mode: 'email',
        timezone: 'Europe/Paris',
        expiration_date: expiresAt.toISOString().slice(0, 10),
        ...(message && { email_custom_note: message }),
        ...(webhookCallbackUrl && {
          webhook_subscriptions: [
            { sandbox_url: webhookCallbackUrl, production_url: webhookCallbackUrl, subscribed_events: ['signature_request.done', 'signature_request.declined', 'signer.done'] }
          ]
        }),
      }),
    })

    // Étape 2 : Upload le document
    let documentId: string
    if (documentBase64) {
      const docResult = await youSignFetch<{ id: string }>(`/signature_requests/${signatureRequest.id}/documents`, {
        method: 'POST',
        body: JSON.stringify({
          nature: 'signable_document',
          content: documentBase64,
          filename: documentName.endsWith('.pdf') ? documentName : `${documentName}.pdf`,
          parse_anchors: false,
        }),
      })
      documentId = docResult.id
    } else {
      // Télécharger depuis URL puis uploader
      const pdfResponse = await fetch(documentUrl!)
      const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer())
      const docResult = await youSignFetch<{ id: string }>(`/signature_requests/${signatureRequest.id}/documents`, {
        method: 'POST',
        body: JSON.stringify({
          nature: 'signable_document',
          content: pdfBuffer.toString('base64'),
          filename: documentName.endsWith('.pdf') ? documentName : `${documentName}.pdf`,
          parse_anchors: false,
        }),
      })
      documentId = docResult.id
    }

    // Étape 3 : Ajouter les signataires
    const signerIds: string[] = []
    for (const signer of signers) {
      const signerResult = await youSignFetch<{ id: string; signature_link?: string }>(`/signature_requests/${signatureRequest.id}/signers`, {
        method: 'POST',
        body: JSON.stringify({
          info: {
            first_name: signer.firstName,
            last_name: signer.lastName,
            email: signer.email,
            phone_number: signer.phone ?? undefined,
            locale: signer.locale ?? 'fr',
          },
          signature_level: 'electronic_signature',
          signature_authentication_mode: 'no_otp',
          fields: [{
            document_id: documentId,
            type: 'signature',
            page: 1,
            x: 77,
            y: 760,
            width: 164,
            height: 55,
          }],
        }),
      })
      signerIds.push(signerResult.id)
    }

    // Étape 4 : Activer la demande de signature
    await youSignFetch(`/signature_requests/${signatureRequest.id}/activate`, {
      method: 'POST',
      body: JSON.stringify({}),
    })

    // Récupérer le lien de signature du premier signataire
    let signingLink: string | null = null
    if (signerIds[0]) {
      try {
        const linkResult = await youSignFetch<{ signature_link?: string }>(
          `/signature_requests/${signatureRequest.id}/signers/${signerIds[0]}`,
        )
        signingLink = linkResult.signature_link ?? null
      } catch { /* ignore */ }
    }

    logger.info({ signatureRequestId: signatureRequest.id, signers: signers.length }, 'YouSign signature request created')

    return {
      signatureRequestId: signatureRequest.id,
      signingLink,
      status: 'ongoing',
      expiresAt: signatureRequest.expires_at,
    }
  } catch (err) {
    logger.error({ err }, 'YouSign createSignatureRequest error')
    throw err
  }
}

/**
 * Récupérer le statut d'une demande de signature.
 */
export async function getSignatureStatus(signatureRequestId: string): Promise<SignatureStatusResult> {
  try {
    const [requestData, signersData] = await Promise.all([
      youSignFetch<{ status: string; audit_trail_document?: { url: string } }>(
        `/signature_requests/${signatureRequestId}`
      ),
      youSignFetch<{ data: Array<{ id: string; info: { email: string; first_name: string; last_name: string }; status: string; signed_at: string | null }> }>(
        `/signature_requests/${signatureRequestId}/signers`
      ),
    ])

    return {
      status: requestData.status as SignatureStatusResult['status'],
      signers: (signersData.data ?? []).map((s) => ({
        id: s.id,
        email: s.info.email,
        firstName: s.info.first_name,
        lastName: s.info.last_name,
        status: s.status as SignatureStatusResult['signers'][0]['status'],
        signedAt: s.signed_at,
      })),
      documentUrl: requestData.audit_trail_document?.url ?? null,
    }
  } catch (err) {
    logger.error({ err, signatureRequestId }, 'YouSign getSignatureStatus error')
    throw err
  }
}

/**
 * Télécharger le document signé (PDF final).
 * Retourne le Buffer du PDF.
 */
export async function downloadSignedDocument(signatureRequestId: string): Promise<Buffer> {
  const requestData = await youSignFetch<{ documents: Array<{ id: string }> }>(
    `/signature_requests/${signatureRequestId}`
  )
  const documentId = requestData.documents?.[0]?.id
  if (!documentId) throw new Error('Aucun document trouvé')

  const response = await fetch(
    `${YOUSIGN_BASE_URL}/signature_requests/${signatureRequestId}/documents/${documentId}/download`,
    {
      headers: { Authorization: `Bearer ${YOUSIGN_API_KEY}` },
    }
  )
  if (!response.ok) throw new Error(`Erreur téléchargement document : HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Annuler une demande de signature.
 */
export async function cancelSignatureRequest(
  signatureRequestId: string,
  reason?: string,
): Promise<void> {
  await youSignFetch(`/signature_requests/${signatureRequestId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason ?? 'Document annulé par l\'administrateur' }),
  })
}

/**
 * Vérifier la signature HMAC d'un webhook YouSign entrant.
 */
export function verifyYouSignWebhook(body: string, signature: string): boolean {
  if (!YOUSIGN_WEBHOOK_SECRET) return true // pas de secret = skip validation
  const expected = crypto.createHmac('sha256', YOUSIGN_WEBHOOK_SECRET).update(body).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.replace('sha256=', ''), 'hex'))
  } catch {
    return false
  }
}

/**
 * Mode simulation — retourne une réponse mock quand YouSign n'est pas configuré.
 * Utile pour développement et démo.
 */
export function isYouSignConfigured(): boolean {
  return Boolean(YOUSIGN_API_KEY)
}

export function mockSignatureRequest(contractId: string): SignatureRequestResult {
  return {
    signatureRequestId: `mock_${contractId}_${Date.now()}`,
    signingLink: `${process.env['APP_URL'] ?? 'http://localhost:3000'}/signature-demo`,
    status: 'ongoing',
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  }
}
