/**
 * Proposition de contrat (recrutement) — édition versionnée + PDF.
 * Monté sous /recruitment (plugin enfant de recruitment.routes.ts).
 *
 * La génération initiale reste POST /recruitment/applications/:id/contract
 * (rétro-compatible) ; elle crée la version 1, 2… de la proposition. Ici :
 *  - GET  /contract-proposal/settings                 option tenant (affichage UI)
 *  - GET  /applications/:id/contract-proposal         markdown courant + versions
 *  - PUT  /applications/:id/contract-proposal         { markdown } → nouvelle version
 *  - GET  /applications/:id/contract-proposal/pdf     PDF (courant ou ?version=N)
 *  - GET  /contract-proposals/employee/:employeeId    propositions versées au dossier
 *  - GET  /contract-proposals/documents/:docId/file   téléchargement (dossier salarié)
 *
 * SÉCURITÉ
 *  - A01 : RBAC admin/hr_manager/hr_officer (lecture dossier : + readonly) ;
 *    schéma tenant issu du JWT uniquement.
 *  - A03 : Zod strict, markdown plafonné, identifiants UUID validés.
 *  - A04 : option tenant `contract_generation_enabled` (fail-closed) → 403
 *    explicite sur la génération et l'édition.
 *  - A09 : audit_log à chaque enregistrement et téléchargement.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureRecruitmentSchemaMigrated } from '../../db/provisioning.js'
import { auditTenant } from '../../utils/audit-log.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { renderHrDocumentPdf } from './hr-document-pdf.js'
import { actorUuid } from './stage-history.js'
import {
  CONTRACT_GENERATION_DISABLED, CONTRACT_PROPOSAL_CATEGORY, PROPOSAL_MARKDOWN_MAX,
  getProposalPdf, isContractGenerationEnabled, listProposalVersions, loadContractEmployer,
  proposalFileName, saveContractProposal,
} from './contract-proposal.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WRITE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const DOSSIER_READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'readonly'] as const

const putBodySchema = z.object({
  markdown: z.string()
    .max(PROPOSAL_MARKDOWN_MAX, `Texte trop long (${PROPOSAL_MARKDOWN_MAX} caractères maximum)`)
    .refine((s) => s.trim().length > 0, 'Le texte de la proposition est vide'),
}).strict()

const pdfQuerySchema = z.object({
  version: z.coerce.number().int().positive().max(100_000).optional(),
  download: z.enum(['0', '1']).optional(),
}).strict()

const fileQuerySchema = z.object({ download: z.enum(['0', '1']).optional() }).strict()

function sendPdf(reply: FastifyReply, bytes: Buffer, fileName: string, download: boolean) {
  return reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fileName}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    .send(bytes)
}

const contractProposalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // Option tenant effective — sert à afficher/masquer l'action côté UI.
  fastify.get('/contract-proposal/settings', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    handler: async (request, reply) => {
      try {
        const enabled = await isContractGenerationEnabled(request.user.schemaName)
        return reply.send({ data: { enabled } })
      } catch (err) {
        request.log.error({ err }, 'contract-proposal settings failed')
        return reply.send({ data: { enabled: false } })
      }
    },
  })

  // Proposition courante (markdown) + historique des versions.
  fastify.get('/applications/:id/contract-proposal', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Identifiant de candidature invalide.' })
      try {
        await ensureRecruitmentSchemaMigrated(schema)
        const [enabled, rows] = await Promise.all([
          isContractGenerationEnabled(schema),
          listProposalVersions(schema, id),
        ])
        const cur = rows.find((r) => r.is_current) ?? null
        return reply.send({
          data: {
            enabled,
            current: cur ? {
              id: cur.id, version: cur.version, markdown: cur.markdown ?? '',
              contractType: cur.contract_type, legalEntityId: cur.legal_entity_id, createdAt: cur.created_at,
            } : null,
            versions: rows.map((r) => ({
              id: r.id, version: r.version, isCurrent: r.is_current, createdAt: r.created_at,
              createdBy: r.created_by, contractType: r.contract_type, sizeBytes: r.size_bytes,
            })),
          },
        })
      } catch (err) {
        request.log.error({ err, id }, 'contract-proposal read failed')
        return reply.status(500).send({ error: 'Impossible de charger la proposition de contrat. Réessayez.' })
      }
    },
  })

  // Enregistre le texte édité par la RH → nouvelle version + PDF re-rendu.
  fastify.put('/applications/:id/contract-proposal', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    bodyLimit: 512 * 1024,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Identifiant de candidature invalide.' })
      const parsed = putBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Données invalides' })
      }
      try {
        if (!(await isContractGenerationEnabled(schema))) {
          return reply.status(403).send(CONTRACT_GENERATION_DISABLED)
        }
        await ensureRecruitmentSchemaMigrated(schema)
        const src = await pool.query<{
          id: string; last_name: string | null; legal_entity_id: string | null
          contract_type: string | null; version: number | null
        }>(
          `SELECT a.id, a.last_name, cp.legal_entity_id, cp.contract_type, cp.version
             FROM "${schema}".applications a
             LEFT JOIN "${schema}".contract_proposals cp ON cp.application_id = a.id AND cp.is_current = true
            WHERE a.id = $1
            LIMIT 1`,
          [id],
        )
        const row = src.rows[0]
        if (!row) return reply.status(404).send({ error: 'Candidature introuvable' })
        if (row.version === null || !row.contract_type) {
          return reply.status(409).send({ error: 'Aucune proposition à modifier : générez d\'abord la proposition de contrat.' })
        }
        const employer = await loadContractEmployer(schema, row.legal_entity_id)
        const markdown = parsed.data.markdown.replace(/\r\n/g, '\n')
        const pdf = Buffer.from(await renderHrDocumentPdf(markdown, employer.branding))
        const saved = await saveContractProposal(schema, {
          applicationId: row.id, legalEntityId: employer.legalEntityId, contractType: row.contract_type,
          offerDetails: null, markdown, pdf, fileName: proposalFileName(row.contract_type, row.last_name),
          createdBy: actorUuid(request.user.sub),
        })
        auditTenant(schema, {
          userId: request.user.sub, action: 'recruitment.contract_proposal_edited', entity: 'application',
          entityId: row.id, changes: { version: saved.version, previousVersion: row.version, length: markdown.length },
          ip: request.ip ?? null,
        })
        return reply.send({ data: { id: saved.id, version: saved.version, createdAt: saved.created_at } })
      } catch (err) {
        request.log.error({ err, id }, 'contract-proposal save failed')
        return reply.status(500).send({ error: 'Impossible d\'enregistrer la proposition de contrat. Réessayez.' })
      }
    },
  })

  // PDF d'une version (courante par défaut).
  fastify.get('/applications/:id/contract-proposal/pdf', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Identifiant de candidature invalide.' })
      const q = pdfQuerySchema.safeParse(request.query ?? {})
      if (!q.success) return reply.status(400).send({ error: 'Version invalide.' })
      try {
        await ensureRecruitmentSchemaMigrated(schema)
        const found = await getProposalPdf(schema, id, q.data.version)
        if (!found) return reply.status(404).send({ error: 'Proposition introuvable.' })
        auditTenant(schema, {
          userId: request.user.sub, action: 'recruitment.contract_proposal_downloaded', entity: 'application',
          entityId: id, changes: { version: found.version }, ip: request.ip ?? null,
        })
        return sendPdf(reply, found.pdf, `proposition_contrat_v${found.version}.pdf`, q.data.download === '1')
      } catch (err) {
        request.log.error({ err, id }, 'contract-proposal pdf failed')
        return reply.status(500).send({ error: 'Impossible de télécharger la proposition. Réessayez.' })
      }
    },
  })

  // Propositions versées au dossier salarié à l'embauche (distinctes du contrat signé).
  fastify.get('/contract-proposals/employee/:employeeId', {
    preHandler: [fastify.authorize(...DOSSIER_READ_ROLES)],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      if (!UUID_RE.test(employeeId)) return reply.status(400).send({ error: 'Identifiant employé invalide.' })
      try {
        const r = await pool.query<{
          id: string; title: string | null; file_name: string; size_bytes: number
          version: number; is_current: boolean; created_at: string
        }>(
          `SELECT id, title, file_name, size_bytes, version, is_current, created_at
             FROM "${schema}".employee_documents
            WHERE employee_id = $1 AND category = $2
            ORDER BY is_current DESC, created_at DESC`,
          [employeeId, CONTRACT_PROPOSAL_CATEGORY],
        )
        return reply.send({
          data: (r?.rows ?? []).map((d) => ({
            id: d.id, title: d.title, fileName: d.file_name, sizeBytes: d.size_bytes,
            version: d.version, isCurrent: d.is_current, createdAt: d.created_at,
          })),
        })
      } catch (err) {
        request.log.error({ err, employeeId }, 'contract-proposal dossier list failed')
        return reply.status(500).send({ error: 'Impossible de charger les propositions de contrat. Réessayez.' })
      }
    },
  })

  fastify.get('/contract-proposals/documents/:docId/file', {
    preHandler: [fastify.authorize(...DOSSIER_READ_ROLES)],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { docId } = request.params as { docId: string }
      if (!UUID_RE.test(docId)) return reply.status(400).send({ error: 'Identifiant de document invalide.' })
      const q = fileQuerySchema.safeParse(request.query ?? {})
      if (!q.success) return reply.status(400).send({ error: 'Paramètre invalide.' })
      try {
        const r = await pool.query<{ id: string; employee_id: string; bytes: Buffer; file_name: string }>(
          `SELECT id, employee_id, bytes, file_name FROM "${schema}".employee_documents
            WHERE id = $1 AND category = $2 LIMIT 1`,
          [docId, CONTRACT_PROPOSAL_CATEGORY],
        )
        const row = r?.rows?.[0]
        if (!row) return reply.status(404).send({ error: 'Document introuvable.' })
        auditTenant(schema, {
          userId: request.user.sub, action: 'contract.proposal_document_downloaded', entity: 'employee_document',
          entityId: row.id, changes: { employeeId: row.employee_id }, ip: request.ip ?? null,
        })
        const safeName = row.file_name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'proposition.pdf'
        return sendPdf(reply, row.bytes, safeName, q.data.download === '1')
      } catch (err) {
        request.log.error({ err, docId }, 'contract-proposal dossier download failed')
        return reply.status(500).send({ error: 'Impossible de télécharger le document. Réessayez.' })
      }
    },
  })
}

export default contractProposalRoutes
