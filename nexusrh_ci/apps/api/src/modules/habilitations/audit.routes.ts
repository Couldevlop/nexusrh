/**
 * Habilitations RH — lecture de la piste d'audit (prefix /habilitations).
 *
 * À quoi elle répond : « qu'a fait cette personne, et qu'a-t-elle essayé de
 * faire sans y arriver ». La question se pose par rôle, par groupe, par
 * sous-groupe, par matricule, par utilisateur, par période — et, depuis
 * l'amendement du 04/11/2026, par CAUSE de refus (`result`), parce qu'un
 * contrôle d'habilitation se juge autant sur les accès refusés que sur les
 * accès servis.
 *
 * Les lignes sont enrichies à la lecture (jointures vers `users`,
 * `hab_assignments`/`hab_subgroups` et `employees`) : rien n'est dupliqué dans
 * `audit_log`, dont les lignes restent immuables et minimales.
 *
 * SÉCURITÉ : OWASP A01 (`authorize('admin')` — la piste d'habilitation est
 * lisible par l'admin du tenant, pas par les habilités qu'elle trace), A03
 * (tout filtre est un paramètre lié ; les UUID et le `result` sont validés
 * avant la moindre requête), A09 (l'export CSV neutralise les formules et
 * porte un BOM UTF-8 pour Excel FR).
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { badRequest, badRequestFromZod } from '../../utils/http-errors.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { assertValidSchemaName } from '../../utils/schema-name.js'
import { encodeField } from '../sage/sage.service.js'
import { HAB_DENIED_RESULTS, HAB_RESULTS } from './hab-trace.js'

/** Taille de page fixe : une piste d'audit se lit page à page, pas en bloc. */
const PAGE_SIZE = 100
const MAX_PAGE = 500
/** Plafond de l'export : au-delà, le filtrage par période est indispensable. */
const CSV_LIMIT = 5000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** `denied` = les trois causes de refus d'un coup (filtre « Accès refusés »). */
const RESULT_VALUES = [...HAB_RESULTS, 'denied'] as const

const querySchema = z.object({
  role: z.string().trim().min(2).max(30).optional(),
  subgroupId: z.string().optional(),
  groupId: z.string().optional(),
  userId: z.string().optional(),
  matricule: z.string().trim().min(1).max(40).optional(),
  result: z.enum(RESULT_VALUES).optional(),
  action: z.string().trim().min(2).max(100).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().optional(),
  format: z.enum(['json', 'csv']).optional(),
}).strict()

const CSV_HEADERS = [
  'Date', 'Utilisateur', 'Email', 'Rôle', 'Sous-groupe', 'Matricule',
  'Action', 'Objet', 'Identifiant', 'Résultat', 'Route', 'IP',
]

interface AuditRow {
  created_at: string
  email: string | null
  first_name: string | null
  last_name: string | null
  role: string | null
  subgroup_name: string | null
  employee_number: string | null
  action: string
  entity: string
  entity_id: string | null
  changes: Record<string, unknown> | null
  ip_address: string | null
}

const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/audit', {
    preHandler: [fastify.authorize('admin'), ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Piste d\'audit des actions RH (filtrable)' },
    handler: async (request, reply) => {
      const parsed = querySchema.safeParse(request.query)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const q = parsed.data

      for (const [label, value] of [['subgroupId', q.subgroupId], ['groupId', q.groupId], ['userId', q.userId]] as const) {
        if (value !== undefined && !UUID_RE.test(value)) return badRequest(reply, `Identifiant invalide : ${label}`)
      }
      for (const [label, value] of [['from', q.from], ['to', q.to]] as const) {
        if (value !== undefined && !DATE_RE.test(value)) return badRequest(reply, `Date invalide : ${label}`)
      }
      const page = q.page ?? 1
      if (page < 1 || page > MAX_PAGE) return badRequest(reply, 'Page hors bornes')

      const schema = request.user.schemaName
      // Défense en profondeur : le nom de schéma vient du jeton (déjà validé
      // par plugins/auth) et il est interpolé comme identifiant SQL ici.
      assertValidSchemaName(schema)
      const where: string[] = ["l.action LIKE 'hr.%'"]
      const params: unknown[] = []
      const bind = (value: unknown): string => {
        params.push(value)
        return `$${params.length}`
      }

      if (q.role) where.push(`u.role = ${bind(q.role)}`)
      if (q.subgroupId) where.push(`a.subgroup_id = ${bind(q.subgroupId)}::uuid`)
      if (q.groupId) where.push(`sg.group_id = ${bind(q.groupId)}::uuid`)
      if (q.userId) where.push(`l.user_id = ${bind(q.userId)}::uuid`)
      if (q.matricule) where.push(`e.employee_number = ${bind(q.matricule)}`)
      if (q.action) where.push(`l.action = ${bind(q.action)}`)
      if (q.result === 'denied') {
        where.push(`l.changes->>'result' = ANY(${bind([...HAB_DENIED_RESULTS])})`)
      } else if (q.result) {
        where.push(`l.changes->>'result' = ${bind(q.result)}`)
      }
      if (q.from) where.push(`l.created_at >= ${bind(q.from)}::date`)
      // Borne haute inclusive : `to=2026-11-04` comprend toute la journée.
      if (q.to) where.push(`l.created_at < (${bind(q.to)}::date + interval '1 day')`)

      const csv = q.format === 'csv'
      const limit = csv ? CSV_LIMIT : PAGE_SIZE
      const offset = csv ? 0 : (page - 1) * PAGE_SIZE

      const sql = `
        SELECT l.id::text AS id, l.created_at, l.user_id::text AS user_id, l.action,
               l.entity, l.entity_id::text AS entity_id, l.changes, l.ip_address,
               u.email, u.first_name, u.last_name, u.role,
               a.subgroup_id::text AS subgroup_id, sg.name AS subgroup_name,
               sg.group_id::text AS group_id, e.employee_number
          FROM "${schema}".audit_log l
          LEFT JOIN "${schema}".users u ON u.id = l.user_id
          LEFT JOIN "${schema}".hab_assignments a ON a.user_id = l.user_id AND a.revoked_at IS NULL
          LEFT JOIN "${schema}".hab_subgroups sg ON sg.id = a.subgroup_id
          LEFT JOIN "${schema}".employees e ON e.id = u.employee_id
         WHERE ${where.join(' AND ')}
         ORDER BY l.created_at DESC
         LIMIT ${bind(limit)} OFFSET ${bind(offset)}`

      const res = await pool.query<AuditRow>(sql, params)

      if (!csv) {
        return reply.send({ data: res.rows, page, pageSize: PAGE_SIZE })
      }

      const enc = (v: unknown) => encodeField(v, ';')
      const lines = [CSV_HEADERS.map(enc).join(';')]
      for (const r of res.rows) {
        const changes = r.changes ?? {}
        lines.push([
          r.created_at,
          [r.first_name, r.last_name].filter(Boolean).join(' '),
          r.email, r.role, r.subgroup_name, r.employee_number,
          r.action, r.entity, r.entity_id,
          changes['result'] ?? '', changes['route'] ?? '', r.ip_address,
        ].map(enc).join(';'))
      }
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', 'attachment; filename="piste-audit-habilitations.csv"')
      return reply.send('﻿' + lines.join('\r\n'))
    },
  })
}

export default auditRoutes
