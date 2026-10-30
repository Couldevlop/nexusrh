/**
 * Contrat de travail SIGNÉ — dépôt RH/manager + consultation par l'employé.
 * Préfixe : /contracts/signed (module activable « contracts »).
 *
 * Options tenant (Paramètres → Général, admin) :
 *  - employee_contract_access : l'employé voit « Mon contrat » dans /mon-espace.
 *    Désactivée → 403 sur les routes /me (le dépôt RH reste possible).
 *  - manager_contract_upload : le manager peut déposer le contrat signé d'un
 *    membre de SON périmètre (direct|hierarchy, manager-scope.service).
 *
 * SÉCURITÉ
 *  - A01 : schéma tenant issu du JWT uniquement ; un employé ne lit QUE les
 *    documents dont employee_id = sa fiche (filtre SQL, jamais un paramètre
 *    client) ; un id inconnu ou appartenant à autrui → 404 (pas d'oracle).
 *  - A03/A08 : PDF uniquement, 10 Mo max, octets magiques « %PDF- », antivirus.
 *  - A09 : audit_log au dépôt ET à chaque téléchargement.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { config } from '../../config.js'
import { auditTenant } from '../../utils/audit-log.js'
import { actorEmployeeSql } from '../../utils/actor-employee.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { isInManagerScope, resolveManagerEmployeeId } from '../../services/manager-scope.service.js'
import { scanBuffer, scanRejectionMessage } from '../../services/antivirus.service.js'
import { sendSignedContractAvailableEmail } from '../../services/email.js'
import { loadTenantMailBySchema } from '../../services/tenant-mail.service.js'
import {
  SIGNED_CONTRACT_CATEGORY, SIGNED_CONTRACT_MAX_BYTES, SIGNATURE_CONTRACT_TYPES, PDF_CHECK_MESSAGES,
  checkSignedContractPdf, loadSignedContractOptions, mergeSignedContracts, safePdfFileName,
  type SignatureRow, type SignedDocumentRow,
} from './signed-contracts.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lecture des dépôts d'un employé (fiche RH). */
const HR_READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'readonly'] as const
/** Dépôt d'un contrat signé par la RH. */
const HR_UPLOAD_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
/** Tous les rôles d'un tenant (chacun est aussi salarié : espace /mon-espace). */
const SELF_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'dg', 'raf_site'] as const

const uploadQuerySchema = z.object({
  contractId: z.string().regex(UUID_RE, 'contractId invalide (UUID requis)').optional(),
  title: z.string().trim().max(200).optional(),
}).strict()

const FEATURE_DISABLED = {
  error: 'La consultation du contrat signé n\'est pas activée pour votre entreprise.',
  featureDisabled: true,
}

function audit(request: FastifyRequest, action: string, documentId: string | null, changes: Record<string, unknown>): void {
  auditTenant(request.user.schemaName, {
    userId: request.user.sub, action, entity: 'employee_document', entityId: documentId,
    changes, ip: request.ip ?? null,
  })
}

/** Fiche employé de l'utilisateur connecté (lien explicite, sinon email). */
async function selfEmployeeId(schema: string, user: { employeeId?: string | null; email?: string }): Promise<string | null> {
  if (user.employeeId) return user.employeeId
  if (!user.email) return null
  const r = await pool.query<{ id: string | null }>(actorEmployeeSql(schema), [user.email])
  return r?.rows?.[0]?.id ?? null
}

/**
 * Accès d'un MANAGER à la fiche `employeeId` pour le dépôt de contrat :
 * option tenant active ET employé dans son périmètre. null = autorisé,
 * sinon la réponse d'erreur à renvoyer.
 */
async function managerUploadDenied(schema: string, user: { employeeId?: string | null; email: string }, employeeId: string): Promise<{ status: number; error: string } | null> {
  const options = await loadSignedContractOptions(pool, schema)
  if (!options.managerContractUpload) {
    return { status: 403, error: 'Le dépôt du contrat signé par le manager n\'est pas activé pour votre entreprise.' }
  }
  const mgrId = await resolveManagerEmployeeId(pool, schema, user)
  if (!(await isInManagerScope(pool, schema, mgrId, employeeId))) {
    return { status: 403, error: 'Cet employé ne fait pas partie de votre équipe.' }
  }
  return null
}

function sendPdf(reply: FastifyReply, row: { mime: string; bytes: Buffer; file_name: string }, disposition: 'inline' | 'attachment') {
  const name = safePdfFileName(row.file_name)
  return reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `${disposition}; filename="${name}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    .header('Pragma', 'no-cache')
    .send(row.bytes)
}

const DOC_COLUMNS = `d.id, d.contract_id, d.title, d.file_name, d.size_bytes, d.version, d.is_current,
       d.created_at, d.uploaded_by_role, c.type AS contract_type, c.start_date AS contract_start_date`

async function loadEmployeeDocuments(schema: string, employeeId: string): Promise<SignedDocumentRow[]> {
  const r = await pool.query<SignedDocumentRow>(
    `SELECT ${DOC_COLUMNS}
       FROM "${schema}".employee_documents d
       LEFT JOIN "${schema}".contracts c ON c.id = d.contract_id
      WHERE d.employee_id = $1 AND d.category = $2
      ORDER BY d.is_current DESC, d.created_at DESC`,
    [employeeId, SIGNED_CONTRACT_CATEGORY],
  )
  return r?.rows ?? []
}

/** Demandes de signature électronique TERMINÉES dont l'employé est signataire. */
async function loadSignedRequests(schema: string, employeeId: string): Promise<SignatureRow[]> {
  try {
    const r = await pool.query<SignatureRow>(
      `SELECT DISTINCT r.id, r.title, r.document_type, r.document_id, r.completed_at
         FROM "${schema}".signature_requests r
         JOIN "${schema}".signature_signatories s ON s.request_id = r.id
        WHERE s.employee_id = $1 AND r.status = 'signed' AND r.document_type = ANY($2::text[])
        ORDER BY r.completed_at DESC NULLS LAST`,
      [employeeId, [...SIGNATURE_CONTRACT_TYPES]],
    )
    return r?.rows ?? []
  } catch {
    // Tenant sans module signature provisionné : la liste reste celle des dépôts.
    return []
  }
}

const signedContractsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // GET /contracts/signed/settings — options effectives (affichage du menu).
  fastify.get('/settings', {
    preHandler: [fastify.authorize(...SELF_ROLES)],
    schema: { tags: ['contracts'], summary: 'Options du contrat signé (tenant)' },
    handler: async (request, reply) => {
      try {
        const options = await loadSignedContractOptions(pool, request.user.schemaName)
        return reply.send({ data: options })
      } catch (err) {
        request.log.error({ err }, 'Échec lecture options contrat signé')
        return reply.status(500).send({ error: 'Impossible de lire les options du contrat signé.' })
      }
    },
  })

  // GET /contracts/signed/me — MES contrats signés (self-service).
  fastify.get('/me', {
    preHandler: [fastify.authorize(...SELF_ROLES)],
    schema: { tags: ['contracts'], summary: 'Mes contrats signés' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const options = await loadSignedContractOptions(pool, schema)
        if (!options.employeeContractAccess) return reply.status(403).send(FEATURE_DISABLED)
        const empId = await selfEmployeeId(schema, request.user)
        if (!empId) return reply.send({ data: [] })
        const [docs, sigs] = await Promise.all([
          loadEmployeeDocuments(schema, empId),
          loadSignedRequests(schema, empId),
        ])
        return reply.send({ data: mergeSignedContracts(docs, sigs) })
      } catch (err) {
        request.log.error({ err }, 'Échec liste contrats signés (self-service)')
        return reply.status(500).send({ error: 'Impossible de charger votre contrat. Réessayez.' })
      }
    },
  })

  // GET /contracts/signed/me/:docId/file — télécharger MON contrat signé.
  fastify.get('/me/:docId/file', {
    preHandler: [fastify.authorize(...SELF_ROLES)],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags: ['contracts'], summary: 'Télécharger mon contrat signé' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { docId } = request.params as { docId: string }
      if (!UUID_RE.test(docId)) return reply.status(400).send({ error: 'Identifiant de document invalide.' })
      const { download } = request.query as { download?: string }
      try {
        const options = await loadSignedContractOptions(pool, schema)
        if (!options.employeeContractAccess) return reply.status(403).send(FEATURE_DISABLED)
        const empId = await selfEmployeeId(schema, request.user)
        if (!empId) return reply.status(404).send({ error: 'Document introuvable.' })
        // OWASP A01 (IDOR) : la fiche de l'appelant est dans le WHERE — le
        // document d'un collègue renvoie 404, exactement comme un id inexistant.
        const r = await pool.query<{ id: string; mime: string; bytes: Buffer; file_name: string }>(
          `SELECT id, mime, bytes, file_name FROM "${schema}".employee_documents
            WHERE id = $1 AND employee_id = $2 AND category = $3 LIMIT 1`,
          [docId, empId, SIGNED_CONTRACT_CATEGORY],
        )
        const row = r?.rows?.[0]
        if (!row) return reply.status(404).send({ error: 'Document introuvable.' })
        audit(request, 'contract.signed_document_downloaded', row.id, { employeeId: empId, self: true })
        return sendPdf(reply, row, download === '1' ? 'attachment' : 'inline')
      } catch (err) {
        request.log.error({ err, docId }, 'Échec téléchargement contrat signé (self-service)')
        return reply.status(500).send({ error: 'Impossible de télécharger le document. Réessayez.' })
      }
    },
  })

  // GET /contracts/signed/employee/:employeeId — dépôts d'un employé (RH ; manager si option + périmètre).
  fastify.get('/employee/:employeeId', {
    preHandler: [fastify.authorize(...HR_READ_ROLES, 'manager')],
    schema: { tags: ['contracts'], summary: 'Contrats signés déposés pour un employé' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      if (!UUID_RE.test(employeeId)) return reply.status(400).send({ error: 'Identifiant employé invalide.' })
      try {
        if (request.user.role === 'manager') {
          const denied = await managerUploadDenied(schema, request.user, employeeId)
          if (denied) return reply.status(denied.status).send({ error: denied.error })
        }
        const [docs, sigs] = await Promise.all([
          loadEmployeeDocuments(schema, employeeId),
          loadSignedRequests(schema, employeeId),
        ])
        return reply.send({ data: mergeSignedContracts(docs, sigs) })
      } catch (err) {
        request.log.error({ err, employeeId }, 'Échec liste contrats signés (RH)')
        return reply.status(500).send({ error: 'Impossible de charger les contrats signés. Réessayez.' })
      }
    },
  })

  // GET /contracts/signed/documents/:docId/file — téléchargement côté RH.
  // Le manager n'y a PAS accès : il dépose, il ne relit pas le contrat (salaire,
  // clauses) d'un membre de son équipe — minimisation des données.
  fastify.get('/documents/:docId/file', {
    preHandler: [fastify.authorize(...HR_READ_ROLES)],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags: ['contracts'], summary: 'Télécharger un contrat signé (RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { docId } = request.params as { docId: string }
      if (!UUID_RE.test(docId)) return reply.status(400).send({ error: 'Identifiant de document invalide.' })
      const { download } = request.query as { download?: string }
      try {
        const r = await pool.query<{ id: string; employee_id: string; mime: string; bytes: Buffer; file_name: string }>(
          `SELECT id, employee_id, mime, bytes, file_name FROM "${schema}".employee_documents
            WHERE id = $1 AND category = $2 LIMIT 1`,
          [docId, SIGNED_CONTRACT_CATEGORY],
        )
        const row = r?.rows?.[0]
        if (!row) return reply.status(404).send({ error: 'Document introuvable.' })
        audit(request, 'contract.signed_document_downloaded', row.id, { employeeId: row.employee_id, self: false })
        return sendPdf(reply, row, download === '1' ? 'attachment' : 'inline')
      } catch (err) {
        request.log.error({ err, docId }, 'Échec téléchargement contrat signé (RH)')
        return reply.status(500).send({ error: 'Impossible de télécharger le document. Réessayez.' })
      }
    },
  })

  // POST /contracts/signed/employee/:employeeId?contractId=&title= — dépôt (multipart, champ « file »).
  fastify.post('/employee/:employeeId', {
    preHandler: [fastify.authorize(...HR_UPLOAD_ROLES, 'manager')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['contracts'], summary: 'Déposer le contrat signé d\'un employé (PDF)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      if (!UUID_RE.test(employeeId)) return reply.status(400).send({ error: 'Identifiant employé invalide.' })
      const q = uploadQuerySchema.safeParse(request.query ?? {})
      if (!q.success) return reply.status(400).send({ error: q.error.issues[0]?.message ?? 'Paramètres invalides.' })
      const contractId = q.data.contractId ?? null
      const title = q.data.title ? q.data.title : null

      try {
        if (request.user.role === 'manager') {
          const denied = await managerUploadDenied(schema, request.user, employeeId)
          if (denied) return reply.status(denied.status).send({ error: denied.error })
        }

        // ── Fichier : PDF, ≤ 10 Mo, octets magiques, antivirus ───────────────
        let file: Awaited<ReturnType<FastifyRequest['file']>>
        try {
          file = await request.file({ limits: { fileSize: SIGNED_CONTRACT_MAX_BYTES, files: 1 } })
        } catch {
          return reply.status(400).send({ error: 'Envoyez le contrat signé en multipart/form-data (champ « file »).' })
        }
        if (!file) return reply.status(400).send({ error: 'Aucun fichier reçu.' })
        let buf: Buffer
        try {
          buf = await file.toBuffer()
        } catch {
          return reply.status(413).send({ error: PDF_CHECK_MESSAGES.too_large })
        }
        if (file.file.truncated) return reply.status(413).send({ error: PDF_CHECK_MESSAGES.too_large })
        const check = checkSignedContractPdf(buf, file.mimetype, file.filename)
        if (!check.ok) {
          return reply.status(check.reason === 'too_large' ? 413 : 400).send({ error: PDF_CHECK_MESSAGES[check.reason] })
        }
        const av = await scanBuffer(buf)
        if (!av.clean) return reply.status(400).send({ error: scanRejectionMessage(av) })

        // ── Employé (même tenant, non archivé) + contrat rattaché ────────────
        const emp = await pool.query<{ id: string; first_name: string | null; email: string | null; user_id: string | null }>(
          `SELECT e.id, e.first_name, e.email,
                  COALESCE(e.user_id, (SELECT u.id FROM "${schema}".users u
                                        WHERE u.employee_id = e.id AND u.is_active = true LIMIT 1)) AS user_id
             FROM "${schema}".employees e
            WHERE e.id = $1 AND e.deleted_at IS NULL LIMIT 1`,
          [employeeId],
        )
        const employee = emp?.rows?.[0]
        if (!employee) return reply.status(404).send({ error: 'Employé introuvable.' })
        if (contractId) {
          const c = await pool.query<{ id: string }>(
            `SELECT id FROM "${schema}".contracts WHERE id = $1 AND employee_id = $2 LIMIT 1`,
            [contractId, employeeId],
          )
          if (!c?.rows?.[0]) return reply.status(400).send({ error: 'Ce contrat n\'appartient pas à cet employé.' })
        }

        // ── Nouvelle version (l'historique est conservé) ─────────────────────
        const fileName = safePdfFileName(file.filename)
        const ins = await pool.query<{ id: string; version: number; created_at: string }>(
          `INSERT INTO "${schema}".employee_documents
             (employee_id, contract_id, category, title, file_name, mime, size_bytes, bytes,
              version, is_current, uploaded_by, uploaded_by_role)
           VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, $7,
             (SELECT COALESCE(MAX(version), 0) + 1 FROM "${schema}".employee_documents
               WHERE employee_id = $1 AND category = $3 AND contract_id IS NOT DISTINCT FROM $2::uuid),
             true, $8, $9)
           RETURNING id, version, created_at`,
          [employeeId, contractId, SIGNED_CONTRACT_CATEGORY, title, fileName, buf.byteLength, buf,
            request.user.sub ?? null, request.user.role],
        )
        const doc = ins.rows[0]
        if (!doc) return reply.status(500).send({ error: 'Impossible d\'enregistrer le contrat signé. Réessayez.' })
        await pool.query(
          `UPDATE "${schema}".employee_documents SET is_current = false, replaced_by = $1
            WHERE employee_id = $2 AND category = $3 AND contract_id IS NOT DISTINCT FROM $4::uuid
              AND id <> $1 AND is_current = true`,
          [doc.id, employeeId, SIGNED_CONTRACT_CATEGORY, contractId],
        )
        if (contractId) {
          await pool.query(
            `UPDATE "${schema}".contracts SET signature_status = 'signed', updated_at = now() WHERE id = $1`,
            [contractId],
          )
        }

        audit(request, 'contract.signed_document_uploaded', doc.id, {
          employeeId, contractId, version: doc.version, sizeBytes: buf.byteLength, uploaderRole: request.user.role,
        })

        // ── Notification + email (seulement si l'employé peut le consulter) ──
        const options = await loadSignedContractOptions(pool, schema)
        let notified = false
        if (options.employeeContractAccess) {
          if (employee.user_id) {
            notified = true
            pool.query(
              `INSERT INTO "${schema}".notifications (user_id, type, title, message, data)
               VALUES ($1, $2, $3, $4, $5)`,
              [employee.user_id, 'contract_signed_available', 'Votre contrat signé est disponible',
                'Votre contrat de travail signé a été déposé dans votre espace (Mon contrat).',
                JSON.stringify({ documentId: doc.id, link: '/mon-espace/contrat' })],
            ).catch(() => { /* table absente / utilisateur supprimé : non bloquant */ })
          }
          if (employee.email) {
            const to = employee.email
            void (async () => {
              try {
                const mail = await loadTenantMailBySchema(schema)
                await sendSignedContractAvailableEmail({
                  to, firstName: employee.first_name, tenantName: mail.name,
                  primaryColor: mail.primaryColor, actionUrl: `${config.appUrl}/mon-espace/contrat`,
                  from: mail.from, replyTo: mail.from, smtp: mail.smtp,
                })
              } catch (err) {
                request.log.warn({ err }, 'Email « contrat signé disponible » non envoyé')
              }
            })()
          }
        }

        return reply.status(201).send({
          data: { id: doc.id, version: doc.version, createdAt: doc.created_at, contractId, fileName, notified },
        })
      } catch (err) {
        request.log.error({ err, employeeId }, 'Échec dépôt contrat signé')
        return reply.status(500).send({ error: 'Impossible d\'enregistrer le contrat signé. Réessayez.' })
      }
    },
  })
}

export default signedContractsRoutes
