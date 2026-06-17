/**
 * Signature électronique — routes Fastify (prefix /signature).
 *
 * Exigence DAO : signature électronique de documents RH (contrats, avenants,
 * attestations…) avec workflow de signataires et piste d'audit.
 *
 * SÉCURITÉ : OWASP A01 (RBAC : gestion réservée RH, signature self-service par
 * le signataire concerné uniquement), A03 (Zod safeParse + statuts/types bornés),
 * A09 (audit_log à chaque signature/refus avec horodatage + IP).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  DOCUMENT_TYPES, canSend, canCancel, canDelete, deriveStatus, canSignatorySign,
  type Signatory, type RequestStatus,
} from './signature.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'] as const
const WRITE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const MANAGE_ROLES = ['admin', 'hr_manager'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const signatorySchema = z.object({
  name: z.string().min(1).max(150),
  email: z.string().email().max(180).optional().nullable(),
  employeeId: z.string().regex(UUID_RE).optional().nullable(),
})
const createSchema = z.object({
  title: z.string().min(1).max(200),
  documentType: z.enum(DOCUMENT_TYPES as unknown as [string, ...string[]]).optional(),
  documentId: z.string().regex(UUID_RE).optional().nullable(),
  documentUrl: z.string().max(2000).optional().nullable(),
  message: z.string().max(2000).optional().nullable(),
  sequential: z.boolean().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
  signatories: z.array(signatorySchema).min(1).max(20),
})
const signSchema = z.object({ signatureText: z.string().min(1).max(200) })
const declineSchema = z.object({ reason: z.string().max(500).optional().nullable() })

function badRequest(reply: FastifyReply, msg = 'Validation échouée') { return reply.status(400).send({ error: msg }) }

function audit(schema: string, userId: string | undefined, action: string, id: string | null, changes: Record<string, unknown>, ip: string | null): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'signature', $3, $4, $5)`,
    [userId ?? null, action, id, JSON.stringify(changes), ip],
  ).catch(() => { /* non bloquant */ })
}

interface SignatoryRow { id: string; status: string; order_index: number; employee_id: string | null }
const toSig = (r: SignatoryRow): Signatory => ({ status: r.status as Signatory['status'], orderIndex: r.order_index })

/** Recalcule et persiste le statut d'une demande à partir de ses signataires. */
async function recomputeStatus(schema: string, requestId: string, expiresAt: string | null): Promise<RequestStatus> {
  const sigs = await rawPool.query<SignatoryRow>(
    `SELECT id, status, order_index, employee_id FROM "${schema}".signature_signatories WHERE request_id = $1`, [requestId],
  )
  const expired = !!expiresAt && new Date(expiresAt).getTime() < Date.now()
  const status = deriveStatus(sigs.rows.map(toSig), { expired })
  const completed = status === 'signed'
  await rawPool.query(
    `UPDATE "${schema}".signature_requests SET status = $1, completed_at = ${completed ? 'now()' : 'completed_at'}, updated_at = now() WHERE id = $2`,
    [status, requestId],
  )
  return status
}

const signatureRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /signature/requests — liste (gestion RH)
  fastify.get('/requests', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['signature'], summary: 'Demandes de signature' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT r.*,
                COUNT(s.id)::int AS signatory_count,
                COUNT(s.id) FILTER (WHERE s.status = 'signed')::int AS signed_count
         FROM "${schema}".signature_requests r
         LEFT JOIN "${schema}".signature_signatories s ON s.request_id = r.id
         GROUP BY r.id ORDER BY r.created_at DESC`,
      )
      return reply.send({ data: res.rows })
    },
  })

  // POST /signature/requests — créer un brouillon avec ses signataires
  fastify.post('/requests', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['signature'], summary: 'Créer une demande de signature' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const reqRes = await rawPool.query(
        `INSERT INTO "${schema}".signature_requests (title, document_type, document_id, document_url, message, sequential, expires_at, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING *`,
        [b.title, b.documentType ?? 'other', b.documentId ?? null, b.documentUrl ?? null, b.message ?? null, b.sequential ?? false, b.expiresAt ?? null, request.user.sub ?? null],
      )
      const reqRow = reqRes.rows[0] as { id: string }
      for (let i = 0; i < b.signatories.length; i++) {
        const s = b.signatories[i]!
        await rawPool.query(
          `INSERT INTO "${schema}".signature_signatories (request_id, employee_id, name, email, order_index, status)
           VALUES ($1,$2,$3,$4,$5,'pending')`,
          [reqRow.id, s.employeeId ?? null, s.name, s.email ?? null, i],
        )
      }
      audit(schema, request.user.sub, 'signature.created', reqRow.id, { title: b.title, signatories: b.signatories.length }, request.ip ?? null)
      return reply.status(201).send({ data: reqRow })
    },
  })

  // GET /signature/requests/:id — détail + signataires
  fastify.get('/requests/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['signature'], summary: 'Détail d\'une demande' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'id invalide')
      const r = await rawPool.query(`SELECT * FROM "${schema}".signature_requests WHERE id = $1`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Demande introuvable' })
      const sigs = await rawPool.query(`SELECT * FROM "${schema}".signature_signatories WHERE request_id = $1 ORDER BY order_index`, [id])
      return reply.send({ data: { ...r.rows[0], signatories: sigs.rows } })
    },
  })

  // POST /signature/requests/:id/send — brouillon → en cours
  fastify.post('/requests/:id/send', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['signature'], summary: 'Envoyer pour signature' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'id invalide')
      const r = await rawPool.query(`SELECT status FROM "${schema}".signature_requests WHERE id = $1`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Demande introuvable' })
      const cnt = await rawPool.query(`SELECT COUNT(*)::int AS n FROM "${schema}".signature_signatories WHERE request_id = $1`, [id])
      if (!canSend(r.rows[0].status as RequestStatus, cnt.rows[0].n)) return badRequest(reply, 'Demande non envoyable (statut ou signataires)')
      await rawPool.query(`UPDATE "${schema}".signature_requests SET status = 'pending', updated_at = now() WHERE id = $1`, [id])
      audit(schema, request.user.sub, 'signature.sent', id, {}, request.ip ?? null)
      return reply.send({ data: { id, status: 'pending' } })
    },
  })

  // POST /signature/requests/:id/cancel — annulation (conserve la piste)
  fastify.post('/requests/:id/cancel', {
    preHandler: [fastify.authorize(...MANAGE_ROLES)],
    schema: { tags: ['signature'], summary: 'Annuler une demande' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'id invalide')
      const r = await rawPool.query(`SELECT status FROM "${schema}".signature_requests WHERE id = $1`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Demande introuvable' })
      if (!canCancel(r.rows[0].status as RequestStatus)) return badRequest(reply, 'Annulation impossible à ce stade')
      await rawPool.query(`UPDATE "${schema}".signature_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id])
      audit(schema, request.user.sub, 'signature.cancelled', id, {}, request.ip ?? null)
      return reply.send({ data: { id, status: 'cancelled' } })
    },
  })

  // DELETE /signature/requests/:id — uniquement un brouillon
  fastify.delete('/requests/:id', {
    preHandler: [fastify.authorize(...MANAGE_ROLES)],
    schema: { tags: ['signature'], summary: 'Supprimer un brouillon' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'id invalide')
      const r = await rawPool.query(`SELECT status FROM "${schema}".signature_requests WHERE id = $1`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Demande introuvable' })
      if (!canDelete(r.rows[0].status as RequestStatus)) return badRequest(reply, 'Seul un brouillon est supprimable (sinon : annuler)')
      await rawPool.query(`DELETE FROM "${schema}".signature_signatories WHERE request_id = $1`, [id])
      await rawPool.query(`DELETE FROM "${schema}".signature_requests WHERE id = $1`, [id])
      audit(schema, request.user.sub, 'signature.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })

  // GET /signature/my-requests — self-service : documents que JE dois signer
  fastify.get('/my-requests', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['signature'], summary: 'Mes documents à signer' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const empId = request.user.employeeId ?? null
      if (!empId) return reply.send({ data: [] })
      const res = await rawPool.query(
        `SELECT r.id, r.title, r.document_type, r.status, r.expires_at, r.created_at,
                s.id AS signatory_id, s.status AS my_status, s.order_index
         FROM "${schema}".signature_requests r
         JOIN "${schema}".signature_signatories s ON s.request_id = r.id
         WHERE s.employee_id = $1 AND r.status IN ('pending','signed','declined')
         ORDER BY r.created_at DESC`,
        [empId],
      )
      return reply.send({ data: res.rows })
    },
  })

  // POST /signature/requests/:id/sign — le signataire courant signe
  fastify.post('/requests/:id/sign', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['signature'], summary: 'Signer un document' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'id invalide')
      const parsed = signSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const empId = request.user.employeeId ?? null
      if (!empId) return reply.status(403).send({ error: 'Aucun profil salarié rattaché', statusCode: 403 })

      const r = await rawPool.query(`SELECT status, sequential, expires_at FROM "${schema}".signature_requests WHERE id = $1`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Demande introuvable' })
      const sigs = await rawPool.query<SignatoryRow>(`SELECT id, status, order_index, employee_id FROM "${schema}".signature_signatories WHERE request_id = $1`, [id])
      const mine = sigs.rows.find((s) => s.employee_id === empId)
      if (!mine) return reply.status(403).send({ error: 'Vous n\'êtes pas signataire de ce document', statusCode: 403 })
      if (!canSignatorySign(r.rows[0].status as RequestStatus, toSig(mine), sigs.rows.map(toSig), !!r.rows[0].sequential)) {
        return badRequest(reply, 'Signature impossible (statut, tour de signature ou déjà signé)')
      }
      await rawPool.query(
        `UPDATE "${schema}".signature_signatories SET status = 'signed', signed_at = now(), signature_text = $1, ip_address = $2 WHERE id = $3`,
        [parsed.data.signatureText, request.ip ?? null, mine.id],
      )
      const status = await recomputeStatus(schema, id, r.rows[0].expires_at)
      audit(schema, request.user.sub, 'signature.signed', id, { signatoryId: mine.id }, request.ip ?? null)
      return reply.send({ data: { id, status } })
    },
  })

  // POST /signature/requests/:id/decline — le signataire courant refuse
  fastify.post('/requests/:id/decline', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['signature'], summary: 'Refuser de signer' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'id invalide')
      const parsed = declineSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const empId = request.user.employeeId ?? null
      if (!empId) return reply.status(403).send({ error: 'Aucun profil salarié rattaché', statusCode: 403 })

      const r = await rawPool.query(`SELECT status, expires_at FROM "${schema}".signature_requests WHERE id = $1`, [id])
      if (!r.rows[0]) return reply.status(404).send({ error: 'Demande introuvable' })
      if (r.rows[0].status !== 'pending') return badRequest(reply, 'Demande non active')
      const sigs = await rawPool.query<SignatoryRow>(`SELECT id, status, order_index, employee_id FROM "${schema}".signature_signatories WHERE request_id = $1`, [id])
      const mine = sigs.rows.find((s) => s.employee_id === empId)
      if (!mine || mine.status !== 'pending') return reply.status(403).send({ error: 'Vous ne pouvez pas refuser ce document', statusCode: 403 })
      await rawPool.query(
        `UPDATE "${schema}".signature_signatories SET status = 'declined', decline_reason = $1, ip_address = $2 WHERE id = $3`,
        [parsed.data.reason ?? null, request.ip ?? null, mine.id],
      )
      const status = await recomputeStatus(schema, id, r.rows[0].expires_at)
      audit(schema, request.user.sub, 'signature.declined', id, { signatoryId: mine.id }, request.ip ?? null)
      return reply.send({ data: { id, status } })
    },
  })
}

export default signatureRoutes
