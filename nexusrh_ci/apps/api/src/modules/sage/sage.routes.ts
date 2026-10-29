/**
 * Interface SAGE — routes Fastify (prefix /sage).
 *
 * Exigence DAO (option B) : exporter les données amont-paie vers SAGE (employés,
 * éléments variables, résultats de paie) dans un fichier délimité paramétrable,
 * EN COMPLÉMENT du moteur de paie natif (jamais imposé).
 *
 * SÉCURITÉ : OWASP A01 (réservé admin/hr_manager), A03 (Zod + valeurs bornées),
 * A09 (audit_log des exports), neutralisation des injections CSV (service).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import {
  SEPARATOR_KEYS, buildSageCsv, exportFilename, isMultiEntityTenant, resolveSeparator, sageColumnsFor,
} from './sage.service.js'
import { auditTenant } from '../../utils/audit-log.js'
import { badRequest } from '../../utils/http-errors.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'

const CONFIG_ROLES = ['admin', 'hr_manager'] as const
const PERIOD_RE = /^\d{4}-\d{2}$/

const configSchema = z.object({
  enabled: z.boolean(),
  separator: z.enum(SEPARATOR_KEYS as [string, ...string[]]),
  includeHeader: z.boolean(),
  matriculeSource: z.enum(['employee_number', 'id']),
}).strict()

function audit(schema: string, userId: string | undefined, action: string, changes: Record<string, unknown>, ip: string | null): void {
  auditTenant(schema, { userId: userId ?? null, action: action, entity: 'sage', entityId: null, changes: changes, ip: ip })
}

interface SageCfg { enabled: boolean; separator: string; include_header: boolean; matricule_source: string }
async function loadConfig(schema: string): Promise<SageCfg> {
  const r = await rawPool.query(`SELECT * FROM "${schema}".sage_config WHERE id = 1`)
  const row = r.rows[0] as SageCfg | undefined
  return row ?? { enabled: false, separator: 'semicolon', include_header: true, matricule_source: 'employee_number' }
}

const PAYMENT_MODE = `CASE WHEN e.mobile_money_provider IS NOT NULL THEN e.mobile_money_provider WHEN e.iban IS NOT NULL THEN 'virement' ELSE 'especes' END`
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Colonnes filiale lues sur legal_entities (jointure « le » des 3 exports).
const ENTITY_FIELDS = `le.name AS entity_name, le.cnps_number AS entity_employer_number`

interface SageEntity { id: string; name: string; cnps_number: string | null }
interface EntityScope { multiEntity: boolean; entities: SageEntity[] }

/**
 * Filiales du tenant + décision « multi-filiales » (colonnes Societe /
 * NumeroEmployeur et sélecteur web). Échec de lecture → mono-entité : on
 * retombe sur le format historique plutôt que de bloquer l'export.
 */
async function loadEntityScope(schema: string): Promise<EntityScope> {
  try {
    const r = await rawPool.query(
      `SELECT le.id, le.name, le.cnps_number,
              COALESCE((SELECT t.has_subsidiaries FROM platform.tenants t WHERE t.schema_name = $1 LIMIT 1), false) AS has_subsidiaries
         FROM "${schema}".legal_entities le
        ORDER BY le.name`,
      [schema],
    )
    const rows = (r?.rows ?? []) as Array<SageEntity & { has_subsidiaries: boolean | null }>
    const hasSubsidiaries = rows[0]?.has_subsidiaries === true
    return {
      multiEntity: isMultiEntityTenant(hasSubsidiaries, rows.length),
      entities: rows.map((x) => ({ id: x.id, name: x.name, cnps_number: x.cnps_number ?? null })),
    }
  } catch {
    return { multiEntity: false, entities: [] }
  }
}

type FilterResult = { ok: true; legalEntityId: string | null } | { ok: false }
/** Filtre optionnel ?legalEntityId= (UUID validé, OWASP A03). */
function parseEntityFilter(query: unknown): FilterResult {
  const raw = (query as { legalEntityId?: unknown } | undefined)?.legalEntityId
  if (raw === undefined || raw === '') return { ok: true, legalEntityId: null }
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return { ok: false }
  return { ok: true, legalEntityId: raw }
}
const INVALID_ENTITY = 'legalEntityId invalide (UUID de filiale attendu)'

const sageRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // GET /sage/config
  fastify.get('/config', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Configuration de l\'interface SAGE' },
    handler: async (request, reply) => {
      const cfg = await loadConfig(request.user.schemaName)
      return reply.send({ data: cfg })
    },
  })

  // GET /sage/legal-entities — filiales proposées au filtre (vide si mono-entité).
  fastify.get('/legal-entities', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Filiales disponibles pour les exports SAGE' },
    handler: async (request, reply) => {
      const scope = await loadEntityScope(request.user.schemaName)
      return reply.send({ data: { multiEntity: scope.multiEntity, entities: scope.multiEntity ? scope.entities : [] } })
    },
  })

  // PUT /sage/config
  fastify.put('/config', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Mettre à jour la configuration SAGE' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = configSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      await rawPool.query(
        `INSERT INTO "${schema}".sage_config (id, enabled, separator, include_header, matricule_source, updated_at)
         VALUES (1,$1,$2,$3,$4, now())
         ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, separator = excluded.separator,
           include_header = excluded.include_header, matricule_source = excluded.matricule_source, updated_at = now()`,
        [b.enabled, b.separator, b.includeHeader, b.matriculeSource],
      )
      audit(schema, request.user.sub, 'sage.config_updated', { enabled: b.enabled, separator: b.separator }, request.ip ?? null)
      return reply.send({ data: { ok: true } })
    },
  })

  // Réponse fichier CSV téléchargeable.
  function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send('\uFEFF' + csv) // BOM : Excel/SAGE FR détecte l'UTF-8
  }

  // GET /sage/export/employees.csv[?legalEntityId=uuid]
  fastify.get('/export/employees.csv', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Exporter les employés (format SAGE)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const filter = parseEntityFilter(request.query)
      if (!filter.ok) return badRequest(reply, INVALID_ENTITY)
      const cfg = await loadConfig(schema)
      const matricule = cfg.matricule_source === 'id' ? 'e.id::text' : `COALESCE(e.employee_number, e.id::text)`
      const params: unknown[] = []
      let where = `WHERE e.is_active = true`
      if (filter.legalEntityId) { params.push(filter.legalEntityId); where += ` AND e.legal_entity_id = $${params.length}::uuid` }
      const res = await rawPool.query(
        `SELECT ${matricule} AS matricule, e.last_name, e.first_name, e.birth_date, e.gender, e.hire_date,
                e.job_title, e.professional_category, e.contract_type, e.base_salary, e.currency,
                e.cnps_number, e.nni, e.marital_status, e.children_count,
                ${PAYMENT_MODE} AS payment_mode, e.bank_name, e.iban, ${ENTITY_FIELDS}
         FROM "${schema}".employees e
         LEFT JOIN "${schema}".legal_entities le ON le.id = e.legal_entity_id
         ${where} ORDER BY e.last_name, e.first_name`,
        params,
      )
      const scope = await loadEntityScope(schema)
      const csv = buildSageCsv(sageColumnsFor('employees', scope.multiEntity), res.rows, { separator: resolveSeparator(cfg.separator), includeHeader: cfg.include_header })
      audit(schema, request.user.sub, 'sage.export_employees', { count: res.rowCount, legalEntityId: filter.legalEntityId }, request.ip ?? null)
      return sendCsv(reply, exportFilename('employees'), csv)
    },
  })

  // GET /sage/export/variable-elements.csv?period=YYYY-MM[&legalEntityId=uuid]
  fastify.get('/export/variable-elements.csv', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Exporter les éléments variables d\'une période' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const period = (request.query as { period?: string }).period
      if (!period || !PERIOD_RE.test(period)) return badRequest(reply, 'period (YYYY-MM) requis')
      const filter = parseEntityFilter(request.query)
      if (!filter.ok) return badRequest(reply, INVALID_ENTITY)
      const cfg = await loadConfig(schema)
      const matricule = cfg.matricule_source === 'id' ? 'e.id::text' : `COALESCE(e.employee_number, e.id::text)`
      // Filiale de la période (paie multi-filiales), à défaut celle du salarié.
      const entityExpr = `COALESCE(pp.legal_entity_id, e.legal_entity_id)`
      const params: unknown[] = [period]
      let where = `WHERE pp.month = $1`
      if (filter.legalEntityId) { params.push(filter.legalEntityId); where += ` AND ${entityExpr} = $${params.length}::uuid` }
      const res = await rawPool.query(
        `SELECT ${matricule} AS matricule, pp.month, ve.rule_code, ve.label, ve.amount, ${ENTITY_FIELDS}
         FROM "${schema}".variable_elements ve
         JOIN "${schema}".pay_periods pp ON pp.id = ve.period_id
         JOIN "${schema}".employees e ON e.id = ve.employee_id
         LEFT JOIN "${schema}".legal_entities le ON le.id = ${entityExpr}
         ${where} ORDER BY matricule, ve.rule_code`,
        params,
      )
      const scope = await loadEntityScope(schema)
      const csv = buildSageCsv(sageColumnsFor('variable_elements', scope.multiEntity), res.rows, { separator: resolveSeparator(cfg.separator), includeHeader: cfg.include_header })
      audit(schema, request.user.sub, 'sage.export_variable_elements', { period, count: res.rowCount, legalEntityId: filter.legalEntityId }, request.ip ?? null)
      return sendCsv(reply, exportFilename('variable_elements', period), csv)
    },
  })

  // GET /sage/export/payroll.csv?period=YYYY-MM[&legalEntityId=uuid]
  fastify.get('/export/payroll.csv', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Exporter les résultats de paie d\'une période' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const period = (request.query as { period?: string }).period
      if (!period || !PERIOD_RE.test(period)) return badRequest(reply, 'period (YYYY-MM) requis')
      const filter = parseEntityFilter(request.query)
      if (!filter.ok) return badRequest(reply, INVALID_ENTITY)
      const cfg = await loadConfig(schema)
      const matricule = cfg.matricule_source === 'id' ? 'e.id::text' : `COALESCE(e.employee_number, e.id::text)`
      // Filiale portée par le bulletin (figée à la paie), à défaut celle du salarié.
      const entityExpr = `COALESCE(ps.legal_entity_id, e.legal_entity_id)`
      const params: unknown[] = [period]
      let where = `WHERE ps.month = $1`
      if (filter.legalEntityId) { params.push(filter.legalEntityId); where += ` AND ${entityExpr} = $${params.length}::uuid` }
      const res = await rawPool.query(
        `SELECT ${matricule} AS matricule, ps.month, ps.base_salary, ps.gross_salary, ps.total_cnps_sal,
                ps.its, ps.total_deductions, ps.net_payable, ps.employer_cost, ${ENTITY_FIELDS}
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         LEFT JOIN "${schema}".legal_entities le ON le.id = ${entityExpr}
         ${where} ORDER BY matricule`,
        params,
      )
      const scope = await loadEntityScope(schema)
      const csv = buildSageCsv(sageColumnsFor('payroll', scope.multiEntity), res.rows, { separator: resolveSeparator(cfg.separator), includeHeader: cfg.include_header })
      audit(schema, request.user.sub, 'sage.export_payroll', { period, count: res.rowCount, legalEntityId: filter.legalEntityId }, request.ip ?? null)
      return sendCsv(reply, exportFilename('payroll', period), csv)
    },
  })
}

export default sageRoutes