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
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  SEPARATOR_KEYS, SAGE_COLUMNS, buildSageCsv, exportFilename, resolveSeparator,
} from './sage.service.js'

const CONFIG_ROLES = ['admin', 'hr_manager'] as const
const PERIOD_RE = /^\d{4}-\d{2}$/

const configSchema = z.object({
  enabled: z.boolean(),
  separator: z.enum(SEPARATOR_KEYS as [string, ...string[]]),
  includeHeader: z.boolean(),
  matriculeSource: z.enum(['employee_number', 'id']),
}).strict()

function badRequest(reply: FastifyReply, msg = 'Validation échouée') { return reply.status(400).send({ error: msg }) }
function audit(schema: string, userId: string | undefined, action: string, changes: Record<string, unknown>, ip: string | null): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'sage', NULL, $3, $4)`,
    [userId ?? null, action, JSON.stringify(changes), ip],
  ).catch(() => { /* non bloquant */ })
}

interface SageCfg { enabled: boolean; separator: string; include_header: boolean; matricule_source: string }
async function loadConfig(schema: string): Promise<SageCfg> {
  const r = await rawPool.query(`SELECT * FROM "${schema}".sage_config WHERE id = 1`)
  const row = r.rows[0] as SageCfg | undefined
  return row ?? { enabled: false, separator: 'semicolon', include_header: true, matricule_source: 'employee_number' }
}

const PAYMENT_MODE = `CASE WHEN e.mobile_money_provider IS NOT NULL THEN e.mobile_money_provider WHEN e.iban IS NOT NULL THEN 'virement' ELSE 'especes' END`

const sageRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /sage/config
  fastify.get('/config', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Configuration de l\'interface SAGE' },
    handler: async (request, reply) => {
      const cfg = await loadConfig(request.user.schemaName)
      return reply.send({ data: cfg })
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
      .send('﻿' + csv) // BOM : Excel/SAGE FR détecte l'UTF-8
  }

  // GET /sage/export/employees.csv
  fastify.get('/export/employees.csv', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Exporter les employés (format SAGE)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const cfg = await loadConfig(schema)
      const matricule = cfg.matricule_source === 'id' ? 'e.id::text' : `COALESCE(e.employee_number, e.id::text)`
      const res = await rawPool.query(
        `SELECT ${matricule} AS matricule, e.last_name, e.first_name, e.birth_date, e.gender, e.hire_date,
                e.job_title, e.professional_category, e.contract_type, e.base_salary, e.currency,
                e.cnps_number, e.nni, e.marital_status, e.children_count,
                ${PAYMENT_MODE} AS payment_mode, e.bank_name, e.iban
         FROM "${schema}".employees e WHERE e.is_active = true ORDER BY e.last_name, e.first_name`,
      )
      const csv = buildSageCsv(SAGE_COLUMNS.employees, res.rows, { separator: resolveSeparator(cfg.separator), includeHeader: cfg.include_header })
      audit(schema, request.user.sub, 'sage.export_employees', { count: res.rowCount }, request.ip ?? null)
      return sendCsv(reply, exportFilename('employees'), csv)
    },
  })

  // GET /sage/export/variable-elements.csv?period=YYYY-MM
  fastify.get('/export/variable-elements.csv', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Exporter les éléments variables d\'une période' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const period = (request.query as { period?: string }).period
      if (!period || !PERIOD_RE.test(period)) return badRequest(reply, 'period (YYYY-MM) requis')
      const cfg = await loadConfig(schema)
      const matricule = cfg.matricule_source === 'id' ? 'e.id::text' : `COALESCE(e.employee_number, e.id::text)`
      const res = await rawPool.query(
        `SELECT ${matricule} AS matricule, pp.month, ve.rule_code, ve.label, ve.amount
         FROM "${schema}".variable_elements ve
         JOIN "${schema}".pay_periods pp ON pp.id = ve.period_id
         JOIN "${schema}".employees e ON e.id = ve.employee_id
         WHERE pp.month = $1 ORDER BY matricule, ve.rule_code`,
        [period],
      )
      const csv = buildSageCsv(SAGE_COLUMNS.variable_elements, res.rows, { separator: resolveSeparator(cfg.separator), includeHeader: cfg.include_header })
      audit(schema, request.user.sub, 'sage.export_variable_elements', { period, count: res.rowCount }, request.ip ?? null)
      return sendCsv(reply, exportFilename('variable_elements', period), csv)
    },
  })

  // GET /sage/export/payroll.csv?period=YYYY-MM
  fastify.get('/export/payroll.csv', {
    preHandler: [fastify.authorize(...CONFIG_ROLES)],
    schema: { tags: ['sage'], summary: 'Exporter les résultats de paie d\'une période' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const period = (request.query as { period?: string }).period
      if (!period || !PERIOD_RE.test(period)) return badRequest(reply, 'period (YYYY-MM) requis')
      const cfg = await loadConfig(schema)
      const matricule = cfg.matricule_source === 'id' ? 'e.id::text' : `COALESCE(e.employee_number, e.id::text)`
      const res = await rawPool.query(
        `SELECT ${matricule} AS matricule, ps.month, ps.base_salary, ps.gross_salary, ps.total_cnps_sal,
                ps.its, ps.total_deductions, ps.net_payable, ps.employer_cost
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         WHERE ps.month = $1 ORDER BY matricule`,
        [period],
      )
      const csv = buildSageCsv(SAGE_COLUMNS.payroll, res.rows, { separator: resolveSeparator(cfg.separator), includeHeader: cfg.include_header })
      audit(schema, request.user.sub, 'sage.export_payroll', { period, count: res.rowCount }, request.ip ?? null)
      return sendCsv(reply, exportFilename('payroll', period), csv)
    },
  })
}

export default sageRoutes
