/**
 * Organigramme dynamique — routes Fastify (prefix /org-chart).
 *
 * Lecture seule : l'organigramme est dérivé en direct de `departments` et
 * `employees` (mise à jour automatique selon les mouvements de personnel, sans
 * table dédiée → aucune migration). Deux vues :
 *   - /org-chart/departments : organigramme par direction / service.
 *   - /org-chart/reporting    : hiérarchie « qui reporte à qui » (manager_id).
 * Exports : SVG (image) et PDF — exigence DAO « export PDF/image ».
 *
 * SÉCURITÉ
 *  - OWASP A01 : `fastify.authorize(...)` restreint aux rôles RH/encadrement
 *    (l'organigramme général est une donnée de niveau 1, mais on évite tout de
 *    même de l'exposer en self-service employé par défaut).
 *  - OWASP A02 : la requête SQL ne sélectionne QUE des champs non sensibles
 *    (nom, poste, service, photo) — jamais base_salary / nni / iban.
 *  - OWASP A03 : `schemaName` du token déjà validé par le plugin auth ;
 *    interpolation entre guillemets d'identifiant uniquement.
 *  - OWASP A09 : chaque export est journalisé dans audit_log (non bloquant).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  buildDepartmentTree,
  buildReportingTree,
  layoutForest,
  renderSvg,
  deptLines,
  empLines,
  type DeptRow,
  type EmpRow,
  type DeptNode,
  type EmpNode,
} from './org-chart.service.js'
import { renderOrgChartPdf } from './org-chart-pdf.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'] as const

const exportQuerySchema = z.object({
  type: z.enum(['departments', 'reporting']).default('departments'),
  rootEmployeeId: z.string().uuid().optional(),
})

const SELECT_DEPTS = (schema: string) =>
  `SELECT id, name, code, manager_id, parent_id FROM "${schema}".departments ORDER BY name`

// OWASP A02 — aucun champ sensible (base_salary, nni, iban…) n'est sélectionné.
const SELECT_EMPS = (schema: string) =>
  `SELECT id, first_name, last_name, job_title, department_id, manager_id, profile_photo_url
   FROM "${schema}".employees
   WHERE is_active = true AND deleted_at IS NULL`

function auditExport(
  schema: string,
  userId: string | undefined,
  format: string,
  type: string,
  ip: string | null,
): void {
  rawPool
    .query(
      `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
       VALUES ($1, 'orgchart.export', 'org_chart', NULL, $2, $3)`,
      [userId ?? null, JSON.stringify({ format, type }), ip],
    )
    .catch(() => { /* tenant sans audit_log : non bloquant */ })
}

async function fetchData(schema: string): Promise<{ depts: DeptRow[]; emps: EmpRow[] }> {
  const [d, e] = await Promise.all([
    rawPool.query<DeptRow>(SELECT_DEPTS(schema)),
    rawPool.query<EmpRow>(SELECT_EMPS(schema)),
  ])
  return { depts: d.rows, emps: e.rows }
}

function deptNameMap(depts: DeptRow[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const d of depts) m.set(d.id, d.name)
  return m
}

const orgChartRoutes: FastifyPluginAsync = async (fastify) => {
  // Migration lazy idempotente (cohérent avec les autres modules).
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /org-chart/departments — organigramme par direction / service.
  fastify.get('/departments', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['org-chart'], summary: 'Organigramme par direction/service' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { depts, emps } = await fetchData(schema)
      const tree = buildDepartmentTree(depts, emps)
      return reply.send({ data: tree })
    },
  })

  // GET /org-chart/reporting — hiérarchie managériale (qui reporte à qui).
  fastify.get('/reporting', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['org-chart'], summary: 'Organigramme hiérarchique (managers)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { rootEmployeeId } = request.query as { rootEmployeeId?: string }
      const { depts, emps } = await fetchData(schema)
      const tree = buildReportingTree(emps, rootEmployeeId ?? null, deptNameMap(depts))
      return reply.send({ data: tree })
    },
  })

  // GET /org-chart/export.svg
  fastify.get('/export.svg', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['org-chart'], summary: 'Export SVG de l\'organigramme' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const q = exportQuerySchema.parse(request.query)
      const { depts, emps } = await fetchData(schema)
      const svg = q.type === 'reporting'
        ? renderSvg(layoutForest<EmpNode>(buildReportingTree(emps, q.rootEmployeeId ?? null, deptNameMap(depts)), empLines), 'Organigramme hierarchique')
        : renderSvg(layoutForest<DeptNode>(buildDepartmentTree(depts, emps), deptLines), 'Organigramme par service')
      auditExport(schema, request.user.sub, 'svg', q.type, request.ip ?? null)
      reply.header('Content-Type', 'image/svg+xml; charset=utf-8')
      reply.header('Content-Disposition', 'attachment; filename="organigramme.svg"')
      return reply.send(svg)
    },
  })

  // GET /org-chart/export.pdf
  fastify.get('/export.pdf', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['org-chart'], summary: 'Export PDF de l\'organigramme' },
    handler: async (request, reply: FastifyReply) => {
      const schema = request.user.schemaName
      const q = exportQuerySchema.parse(request.query)
      const { depts, emps } = await fetchData(schema)
      const layout = q.type === 'reporting'
        ? layoutForest<EmpNode>(buildReportingTree(emps, q.rootEmployeeId ?? null, deptNameMap(depts)), empLines)
        : layoutForest<DeptNode>(buildDepartmentTree(depts, emps), deptLines)
      const title = q.type === 'reporting' ? 'Organigramme hierarchique' : 'Organigramme par service'
      const bytes = await renderOrgChartPdf(layout, title)
      auditExport(schema, request.user.sub, 'pdf', q.type, request.ip ?? null)
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', 'attachment; filename="organigramme.pdf"')
      return reply.send(Buffer.from(bytes))
    },
  })
}

export default orgChartRoutes
