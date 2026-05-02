/**
 * Webhooks service — livraison d'événements avec signature HMAC-SHA256 et retry.
 * Les endpoints sont stockés dans platform.webhook_endpoints.
 * Les livraisons dans platform.webhook_deliveries.
 */
import crypto from 'crypto'
import { Pool } from 'pg'
import { config } from '../../config'
import { logger } from '../../utils/logger'

const pool = new Pool({ connectionString: config.database.url, max: 3 })

export type WebhookEvent =
  | 'employee.created' | 'employee.updated' | 'employee.archived'
  | 'payslip.generated' | 'payslip.published'
  | 'absence.created' | 'absence.approved' | 'absence.rejected'
  | 'expense.submitted' | 'expense.approved' | 'expense.rejected'
  | 'contract.signed' | 'contract.created'
  | 'tenant.created' | 'tenant.suspended' | 'tenant.activated'
  | 'recruitment.application.received'
  | 'training.enrollment.confirmed'

export interface WebhookPayload {
  id: string
  event: WebhookEvent
  tenantId: string | null
  timestamp: string
  data: Record<string, unknown>
}

export interface WebhookEndpoint {
  id: string
  tenantId: string | null
  url: string
  secret: string
  events: string[]
  isActive: boolean
  description: string | null
}

/**
 * Génère la signature HMAC-SHA256 du payload.
 * Header envoyé : X-NexusRH-Signature: sha256=<hex>
 */
function signPayload(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Envoie un event à tous les endpoints abonnés (pour un tenant donné).
 * Fire-and-forget — ne bloque jamais la réponse API.
 */
export async function dispatchWebhookEvent(
  event: WebhookEvent,
  tenantId: string | null,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const { rows: endpoints } = await pool.query<{
      id: string; url: string; secret: string; events: string[]
    }>(
      `SELECT id, url, secret, events FROM platform.webhook_endpoints
       WHERE is_active = true
         AND ($1::uuid IS NULL OR tenant_id = $1)
         AND (events @> ARRAY[$2] OR events @> ARRAY['*'])`,
      [tenantId, event],
    )

    if (endpoints.length === 0) return

    const payload: WebhookPayload = {
      id: crypto.randomUUID(),
      event,
      tenantId,
      timestamp: new Date().toISOString(),
      data,
    }
    const body = JSON.stringify(payload)

    await Promise.allSettled(
      endpoints.map((ep) => deliverWebhook(ep.id, ep.url, ep.secret, payload.id, event, body)),
    )
  } catch (err) {
    logger.error({ err, event, tenantId }, 'dispatchWebhookEvent error')
  }
}

async function deliverWebhook(
  endpointId: string,
  url: string,
  secret: string,
  eventId: string,
  event: WebhookEvent,
  body: string,
): Promise<void> {
  const signature = signPayload(secret, body)
  const maxAttempts = 3
  const delays = [0, 5000, 30000] // 0s, 5s, 30s

  let deliveryId: string | null = null

  // Créer l'enregistrement de livraison
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO platform.webhook_deliveries
         (endpoint_id, event_type, payload, status, attempt_count)
       VALUES ($1, $2, $3::jsonb, 'pending', 0) RETURNING id`,
      [endpointId, event, body],
    )
    deliveryId = rows[0]?.id ?? null
  } catch (err) {
    logger.error({ err }, 'Impossible de créer webhook_delivery')
    return
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (delays[attempt]! > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]))
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-NexusRH-Signature': signature,
          'X-NexusRH-Event': event,
          'X-NexusRH-Delivery': eventId,
          'User-Agent': 'NexusRH-Webhook/1.0',
        },
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))

      const responseText = await res.text().catch(() => '')

      if (res.ok) {
        if (deliveryId) {
          await pool.query(
            `UPDATE platform.webhook_deliveries
             SET status='delivered', http_status=$1, response_body=$2,
                 attempt_count=$3, delivered_at=NOW()
             WHERE id=$4`,
            [res.status, responseText.slice(0, 1000), attempt + 1, deliveryId],
          )
        }
        return
      }

      logger.warn({ url, status: res.status, attempt }, 'Webhook delivery failed (non-2xx)')

      if (attempt === maxAttempts - 1 && deliveryId) {
        await pool.query(
          `UPDATE platform.webhook_deliveries
           SET status='failed', http_status=$1, response_body=$2, attempt_count=$3
           WHERE id=$4`,
          [res.status, responseText.slice(0, 1000), attempt + 1, deliveryId],
        )
      }
    } catch (err) {
      logger.warn({ err, url, attempt }, 'Webhook delivery error')
      if (attempt === maxAttempts - 1 && deliveryId) {
        const msg = err instanceof Error ? err.message : String(err)
        await pool.query(
          `UPDATE platform.webhook_deliveries
           SET status='failed', response_body=$1, attempt_count=$2
           WHERE id=$3`,
          [msg.slice(0, 1000), attempt + 1, deliveryId],
        )
      }
    }
  }
}

/**
 * Vérifie la signature d'un webhook entrant (ex: YouSign callback).
 */
export function verifyIncomingWebhook(secret: string, body: string, signature: string): boolean {
  const expected = signPayload(secret, body)
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}
