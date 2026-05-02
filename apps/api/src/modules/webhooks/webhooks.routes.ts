/**
 * Webhooks routes — CRUD des endpoints + logs des livraisons.
 * Accessible : admin (ses propres webhooks) + super_admin (tous).
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import crypto from 'crypto'
import { Pool } from 'pg'
import { config } from '../../config'

const pool = new Pool({ connectionString: config.database.url })

const createEndpointBody = z.object({
  url: z.string().url('URL invalide'),
  events: z.array(z.string()).min(1, 'Au moins un événement requis'),
  description: z.string().max(500).optional(),
})

const updateEndpointBody = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).optional(),
  description: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
})

const webhooksRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /webhooks — liste les endpoints du tenant ──────────────────────────
  fastify.get('/', {
    preHandler: [fastify.authorize('admin', 'super_admin')],
    schema: {
      tags: ['webhooks'],
      summary: 'Liste les endpoints webhooks',
      querystring: {
        type: 'object',
        properties: {
          page:  { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
        },
      },
    },
    handler: async (request, reply) => {
      const { tenantId, role } = request.user
      try {
        const whereClause = role === 'super_admin'
          ? ''
          : `WHERE tenant_id = '${tenantId}'`

        const { rows } = await pool.query(`
          SELECT id, tenant_id, url, events, is_active, description, created_at, updated_at
          FROM platform.webhook_endpoints
          ${whereClause}
          ORDER BY created_at DESC
        `)
        return reply.send({ data: rows, total: rows.length })
      } catch (err) {
        fastify.log.error({ err }, 'GET /webhooks error')
        return reply.status(500).send({ error: 'Erreur lecture webhooks' })
      }
    },
  })

  // ── POST /webhooks — créer un endpoint ────────────────────────────────────
  fastify.post('/', {
    preHandler: [fastify.authorize('admin', 'super_admin')],
    schema: { tags: ['webhooks'], summary: 'Créer un endpoint webhook' },
    handler: async (request, reply) => {
      const { tenantId } = request.user
      const parsed = createEndpointBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(422).send({ error: 'Données invalides', details: parsed.error.flatten() })
      }
      const { url, events, description } = parsed.data
      const secret = crypto.randomBytes(32).toString('hex')

      try {
        const { rows } = await pool.query<{ id: string; secret: string }>(
          `INSERT INTO platform.webhook_endpoints (tenant_id, url, secret, events, description)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, secret`,
          [tenantId ?? null, url, secret, events, description ?? null],
        )
        return reply.status(201).send({
          data: { ...rows[0], url, events, isActive: true, description },
          message: 'Endpoint créé. Conservez ce secret — il ne sera plus affiché.',
        })
      } catch (err) {
        fastify.log.error({ err }, 'POST /webhooks error')
        return reply.status(500).send({ error: 'Erreur création webhook' })
      }
    },
  })

  // ── PATCH /webhooks/:id — modifier un endpoint ─────────────────────────────
  fastify.patch('/:id', {
    preHandler: [fastify.authorize('admin', 'super_admin')],
    schema: { tags: ['webhooks'], summary: 'Modifier un endpoint webhook' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { tenantId, role } = request.user
      const parsed = updateEndpointBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(422).send({ error: 'Données invalides', details: parsed.error.flatten() })
      }

      try {
        const ownerCheck = role === 'super_admin'
          ? await pool.query(`SELECT id FROM platform.webhook_endpoints WHERE id=$1`, [id])
          : await pool.query(`SELECT id FROM platform.webhook_endpoints WHERE id=$1 AND tenant_id=$2`, [id, tenantId])

        if (ownerCheck.rows.length === 0) {
          return reply.status(404).send({ error: 'Endpoint non trouvé' })
        }

        const { url, events, description, isActive } = parsed.data
        const updates: string[] = []
        const values: unknown[] = []
        let idx = 1

        if (url !== undefined)         { updates.push(`url=$${idx++}`);        values.push(url) }
        if (events !== undefined)      { updates.push(`events=$${idx++}`);     values.push(events) }
        if (description !== undefined) { updates.push(`description=$${idx++}`); values.push(description) }
        if (isActive !== undefined)    { updates.push(`is_active=$${idx++}`);  values.push(isActive) }

        if (updates.length === 0) return reply.send({ message: 'Aucune modification' })
        updates.push(`updated_at=NOW()`)
        values.push(id)

        const { rows } = await pool.query(
          `UPDATE platform.webhook_endpoints SET ${updates.join(', ')} WHERE id=$${idx} RETURNING *`,
          values,
        )
        return reply.send({ data: rows[0] })
      } catch (err) {
        fastify.log.error({ err }, 'PATCH /webhooks/:id error')
        return reply.status(500).send({ error: 'Erreur modification webhook' })
      }
    },
  })

  // ── DELETE /webhooks/:id — supprimer un endpoint ──────────────────────────
  fastify.delete('/:id', {
    preHandler: [fastify.authorize('admin', 'super_admin')],
    schema: { tags: ['webhooks'], summary: 'Supprimer un endpoint webhook' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { tenantId, role } = request.user
      try {
        const q = role === 'super_admin'
          ? await pool.query(`DELETE FROM platform.webhook_endpoints WHERE id=$1 RETURNING id`, [id])
          : await pool.query(`DELETE FROM platform.webhook_endpoints WHERE id=$1 AND tenant_id=$2 RETURNING id`, [id, tenantId])

        if (q.rows.length === 0) return reply.status(404).send({ error: 'Endpoint non trouvé' })
        return reply.send({ message: 'Endpoint supprimé' })
      } catch (err) {
        fastify.log.error({ err }, 'DELETE /webhooks/:id error')
        return reply.status(500).send({ error: 'Erreur suppression webhook' })
      }
    },
  })

  // ── POST /webhooks/:id/rotate-secret — regénérer le secret ────────────────
  fastify.post('/:id/rotate-secret', {
    preHandler: [fastify.authorize('admin', 'super_admin')],
    schema: { tags: ['webhooks'], summary: 'Regénérer le secret HMAC' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { tenantId, role } = request.user
      const newSecret = crypto.randomBytes(32).toString('hex')
      try {
        const q = role === 'super_admin'
          ? await pool.query(`UPDATE platform.webhook_endpoints SET secret=$1, updated_at=NOW() WHERE id=$2 RETURNING id`, [newSecret, id])
          : await pool.query(`UPDATE platform.webhook_endpoints SET secret=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3 RETURNING id`, [newSecret, id, tenantId])

        if (q.rows.length === 0) return reply.status(404).send({ error: 'Endpoint non trouvé' })
        return reply.send({
          data: { newSecret },
          message: 'Secret regénéré. Mettez à jour votre serveur récepteur immédiatement.',
        })
      } catch (err) {
        fastify.log.error({ err }, 'rotate-secret error')
        return reply.status(500).send({ error: 'Erreur rotation secret' })
      }
    },
  })

  // ── POST /webhooks/:id/test — envoyer un événement de test ───────────────
  fastify.post('/:id/test', {
    preHandler: [fastify.authorize('admin', 'super_admin')],
    schema: { tags: ['webhooks'], summary: 'Envoyer un événement de test' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        const { rows } = await pool.query<{ url: string; secret: string }>(
          `SELECT url, secret FROM platform.webhook_endpoints WHERE id=$1 AND is_active=true`,
          [id],
        )
        const ep = rows[0]
        if (!ep) return reply.status(404).send({ error: 'Endpoint non trouvé ou inactif' })

        const testPayload = JSON.stringify({
          id: crypto.randomUUID(),
          event: 'webhook.test',
          tenantId: request.user.tenantId,
          timestamp: new Date().toISOString(),
          data: { message: 'Test de connexion NexusRH Webhooks', version: '1.0' },
        })

        const signature = 'sha256=' + (await import('crypto')).default
          .createHmac('sha256', ep.secret).update(testPayload).digest('hex')

        const res = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-NexusRH-Signature': signature,
            'X-NexusRH-Event': 'webhook.test',
            'User-Agent': 'NexusRH-Webhook/1.0',
          },
          body: testPayload,
          signal: AbortSignal.timeout(10_000),
        })

        return reply.send({
          data: {
            httpStatus: res.status,
            success: res.ok,
            url: ep.url,
          },
          message: res.ok ? 'Test réussi' : `Test échoué (HTTP ${res.status})`,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erreur réseau'
        return reply.status(200).send({ data: { success: false, error: msg }, message: 'Test échoué' })
      }
    },
  })

  // ── GET /webhooks/:id/deliveries — logs des livraisons ───────────────────
  fastify.get('/:id/deliveries', {
    preHandler: [fastify.authorize('admin', 'super_admin')],
    schema: { tags: ['webhooks'], summary: 'Logs des livraisons' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        const { rows } = await pool.query(
          `SELECT id, event_type, status, http_status, attempt_count,
                  delivered_at, created_at, response_body
           FROM platform.webhook_deliveries
           WHERE endpoint_id=$1
           ORDER BY created_at DESC LIMIT 100`,
          [id],
        )
        return reply.send({ data: rows })
      } catch (err) {
        fastify.log.error({ err }, 'GET deliveries error')
        return reply.status(500).send({ error: 'Erreur lecture livraisons' })
      }
    },
  })

  // ── GET /webhooks/events — liste les événements disponibles ──────────────
  fastify.get('/events', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['webhooks'], summary: 'Événements disponibles' },
    handler: async (_, reply) => {
      return reply.send({
        data: [
          { event: 'employee.created',               description: 'Nouvel employé créé' },
          { event: 'employee.updated',               description: 'Employé mis à jour' },
          { event: 'employee.archived',              description: 'Employé archivé' },
          { event: 'payslip.generated',              description: 'Bulletin de paie généré' },
          { event: 'payslip.published',              description: 'Bulletin publié à l\'employé' },
          { event: 'absence.created',                description: 'Demande d\'absence créée' },
          { event: 'absence.approved',               description: 'Absence approuvée' },
          { event: 'absence.rejected',               description: 'Absence refusée' },
          { event: 'expense.submitted',              description: 'Note de frais soumise' },
          { event: 'expense.approved',               description: 'Note de frais approuvée' },
          { event: 'expense.rejected',               description: 'Note de frais refusée' },
          { event: 'contract.created',               description: 'Contrat créé' },
          { event: 'contract.signed',                description: 'Contrat signé électroniquement' },
          { event: 'tenant.created',                 description: 'Nouveau tenant créé (super_admin)' },
          { event: 'recruitment.application.received', description: 'Nouvelle candidature reçue' },
          { event: 'training.enrollment.confirmed',  description: 'Inscription formation confirmée' },
          { event: '*',                              description: 'Tous les événements' },
        ],
      })
    },
  })
}

export default webhooksRoutes
