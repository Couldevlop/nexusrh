import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { encodeField } from '../sage/sage.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// CNP-002 — anti-injection CSV (OWASP A03) : neutralise +/-/=/@ et quote.
const csvCell = (v: unknown) => encodeField(v, ';')

// OWASP A03 — validation year query param (regex + plage)
function parseYearParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return new Date().getFullYear()
  if (!/^\d{4}$/.test(raw)) return null
  const y = parseInt(raw, 10)
  if (y < 2000 || y > new Date().getFullYear() + 1) return null
  return y
}

// OWASP A03 — schemas Zod pour les POST principaux
const generateDeclarationSchema = z.object({
  year:          z.number().int().min(2000).max(2100),
  quarter:       z.number().int().min(1).max(4),
  // Palier 3 multi-filiales : si tenant.has_subsidiaries=true, REQUIS pour
  // scoper la déclaration à une filiale (chaque numéro CNPS est distinct).
  legalEntityId: z.string().regex(UUID_RE, 'UUID requis').optional(),
}).strict()

const disaGenerateSchema = z.object({
  year:          z.number().int().min(2000).max(2100),
  legalEntityId: z.string().regex(UUID_RE, 'UUID requis').optional(),
}).strict()

const cessationEventSchema = z.object({
  employeeId: z.string().uuid(),
  exitDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Format YYYY-MM-DD requis'),
  reason:     z.enum(['resignation', 'dismissal', 'conventional', 'end_of_cdd', 'retirement', 'other']),
  comment:    z.string().max(1000).optional(),
}).strict()

const STATUS_WHITELIST = new Set(['draft', 'submitted', 'validated', 'rejected'])

// OWASP A09 — audit log non bloquant des déclarations (action financière
// critique : déclarations à la sécurité sociale ivoirienne, exports XML/PDF/CSV).
function auditLogCnps(
  schema: string, userId: string, action: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'cnps', $3, $4, $5)`,
    [userId, action, entityId, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

// OWASP A07 — rate-limit anti-DoS sur les exports lourds (PDF/XML/CSV générés
// à la volée, agrégations multi-mois). Cap : 10 req/min/IP.
const HEAVY_EXPORT_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } }

// OWASP A04 — cap anti-fraude sur les exports DISA agrégés annuels.
// Une PME ivoirienne classique a < 500 employés ; un export > 2000 lignes
// indique soit un tenant entreprise (à traiter par batch), soit un abus.
const DISA_MAX_EMPLOYEES = 2_000

const cnpsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /cnps/declarations — liste des déclarations CNPS
  fastify.get('/declarations', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['cnps'], summary: 'Liste des déclarations CNPS' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { year, status } = request.query as Record<string, string>

      // OWASP A03 : valider year + status whitelist
      let yearParsed: number | null = null
      if (year !== undefined) {
        yearParsed = parseYearParam(year)
        if (yearParsed === null) {
          return reply.status(400).send({ error: 'year invalide (format YYYY, 2000-courant+1)' })
        }
      }
      if (status !== undefined && !STATUS_WHITELIST.has(status)) {
        return reply.status(400).send({ error: 'status invalide (draft/submitted/validated/rejected)' })
      }

      let sql = `SELECT * FROM "${schema}".cnps_declarations WHERE quarter IS NOT NULL`
      const params: unknown[] = []
      let idx = 1

      if (yearParsed !== null) { sql += ` AND year = $${idx++}`; params.push(yearParsed) }
      if (status) { sql += ` AND status = $${idx++}`; params.push(status) }
      sql += ` ORDER BY year DESC NULLS LAST, quarter DESC NULLS LAST`

      const res = await rawPool.query(sql, params)
      return reply.send({ data: res.rows })
    },
  })

  // POST /cnps/declarations/generate — générer une déclaration trimestrielle
  fastify.post('/declarations/generate', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['cnps'], summary: 'Générer la déclaration trimestrielle CNPS' },
    handler: async (request, reply) => {
      const parsed = generateDeclarationSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Paramètres invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const { year, quarter, legalEntityId } = parsed.data
      const schema = request.user.schemaName

      // Multi-filiales : si tenant.has_subsidiaries=true, exiger legalEntityId
      // pour scoper la déclaration. Chaque filiale a son propre numéro CNPS
      // employeur et doit générer ses propres déclarations distinctes.
      const tenantRes = await rawPool.query<{ has_subsidiaries: boolean }>(
        `SELECT has_subsidiaries FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
      )
      const hasSubs = tenantRes.rows[0]?.has_subsidiaries === true
      if (hasSubs && !legalEntityId) {
        return reply.status(400).send({
          error: 'Ce tenant a plusieurs filiales — legalEntityId requis (chaque numéro CNPS génère sa propre déclaration)',
        })
      }
      if (legalEntityId) {
        const le = await rawPool.query(
          `SELECT id FROM "${schema}".legal_entities WHERE id = $1 AND is_active = true LIMIT 1`,
          [legalEntityId],
        ).catch(() => ({ rows: [] }))
        if (!le.rows[0]) return reply.status(404).send({ error: 'Filiale introuvable ou inactive' })
      }

      // Mois du trimestre
      const months: string[] = []
      for (let m = (quarter - 1) * 3 + 1; m <= quarter * 3; m++) {
        months.push(`${year}-${String(m).padStart(2, '0')}`)
      }

      // Vérifier si déclaration déjà existante (pour CE legalEntityId)
      const existing = await rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".cnps_declarations
         WHERE year = $1 AND quarter = $2 AND (legal_entity_id IS NOT DISTINCT FROM $3)
         LIMIT 1`,
        [year, quarter, legalEntityId ?? null],
      ).catch(async () => rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".cnps_declarations
         WHERE year = $1 AND quarter = $2 LIMIT 1`, [year, quarter],
      ))
      if (existing.rows[0]?.status === 'submitted') {
        return reply.status(422).send({ error: 'Déclaration déjà soumise pour ce trimestre / cette filiale' })
      }

      // Agréger les bulletins du trimestre scopés filiale si applicable
      const aggParams: unknown[] = [months]
      let aggFilter = ''
      if (legalEntityId) {
        aggParams.push(legalEntityId)
        aggFilter = ` AND ps.legal_entity_id = $${aggParams.length}`
      }
      const slipsRes = await rawPool.query<{
        employee_id: string; first_name: string; last_name: string
        cnps_number: string; nni: string
        total_cnps_sal: string; total_cnps_pat: string
        cnps_retraite_sal: string; cnps_retraite_pat: string
        cnps_pf_pat: string; cnps_at_pat: string
        gross_salary: string; net_payable: string
      }>(
        `SELECT e.id AS employee_id, e.first_name, e.last_name,
                COALESCE(e.cnps_number,'') AS cnps_number,
                COALESCE(e.nni,'') AS nni,
                SUM(COALESCE(ps.total_cnps_sal,0))::text AS total_cnps_sal,
                SUM(COALESCE(ps.total_cnps_pat,0))::text AS total_cnps_pat,
                SUM(COALESCE(ps.cnps_retraite_sal,0))::text AS cnps_retraite_sal,
                SUM(COALESCE(ps.cnps_retraite_pat,0))::text AS cnps_retraite_pat,
                SUM(COALESCE(ps.cnps_pf_pat,0))::text AS cnps_pf_pat,
                SUM(COALESCE(ps.cnps_at_pat,0))::text AS cnps_at_pat,
                SUM(COALESCE(ps.gross_salary,0))::text AS gross_salary,
                SUM(COALESCE(ps.net_payable,0))::text AS net_payable
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         WHERE ps.month = ANY($1::text[])${aggFilter}
         GROUP BY e.id, e.first_name, e.last_name, e.cnps_number, e.nni`,
        aggParams,
      )

      const employees = slipsRes.rows
      let totalSalarial = 0
      let totalPatronal = 0
      let totalMasseSalariale = 0

      for (const emp of employees) {
        totalSalarial       += parseInt(emp.total_cnps_sal ?? '0')
        totalPatronal       += parseInt(emp.total_cnps_pat ?? '0')
        totalMasseSalariale += parseInt(emp.gross_salary ?? '0')
      }
      const totalCotisations = totalSalarial + totalPatronal

      // Insérer ou mettre à jour la déclaration trimestrielle (scopée filiale)
      let declarationId: string
      if (existing.rows[0]) {
        await rawPool.query(
          `UPDATE "${schema}".cnps_declarations
           SET total_cotisations_salariales = $1, total_cotisations_patronales = $2,
               total_cotisations = $3, masse_salariale = $4,
               employees_count = $5, data = $6,
               months = $7, status = 'draft', updated_at = now()
           WHERE id = $8`,
          [
            totalSalarial, totalPatronal, totalCotisations, totalMasseSalariale,
            employees.length, JSON.stringify(employees), JSON.stringify(months),
            existing.rows[0].id,
          ]
        )
        declarationId = existing.rows[0].id
      } else {
        const insRes = await rawPool.query<{ id: string }>(
          `INSERT INTO "${schema}".cnps_declarations
             (year, quarter, months,
              total_cotisations_salariales, total_cotisations_patronales,
              total_cotisations, masse_salariale, employees_count, data, status,
              legal_entity_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)
           RETURNING id`,
          [
            year, quarter, JSON.stringify(months),
            totalSalarial, totalPatronal,
            totalCotisations, totalMasseSalariale,
            employees.length, JSON.stringify(employees),
            legalEntityId ?? null,
          ]
        ).catch(async () => rawPool.query<{ id: string }>(
          `INSERT INTO "${schema}".cnps_declarations
             (year, quarter, months,
              total_cotisations_salariales, total_cotisations_patronales,
              total_cotisations, masse_salariale, employees_count, data, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft')
           RETURNING id`,
          [
            year, quarter, JSON.stringify(months),
            totalSalarial, totalPatronal,
            totalCotisations, totalMasseSalariale,
            employees.length, JSON.stringify(employees),
          ],
        ))
        declarationId = insRes.rows[0]?.id ?? ''
      }

      // OWASP A09 — traçabilité de la génération d'une déclaration sociale
      // (action préparatoire à un dépôt légal CNPS, doit être auditable).
      auditLogCnps(
        schema, request.user.sub, 'cnps.declaration_generated', declarationId,
        { year, quarter, legalEntityId: legalEntityId ?? null,
          employeesCount: employees.length, totalCotisations, totalMasseSalariale },
        request.ip ?? null,
      )

      return reply.send({
        data: {
          id: declarationId,
          year, quarter, months,
          employeesCount: employees.length,
          totalSalarial, totalPatronal, totalCotisations,
          totalMasseSalariale,
          currency: 'XOF',
        },
        employees,
      })
    },
  })

  // POST /cnps/declarations/:id/submit — marquer comme soumise
  fastify.post('/declarations/:id/submit', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['cnps'], summary: 'Soumettre la déclaration CNPS' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const schema = request.user.schemaName

      const res = await rawPool.query(
        `UPDATE "${schema}".cnps_declarations
         SET status = 'submitted', submitted_at = now(), submitted_by = $1, updated_at = now()
         WHERE id = $2 AND status = 'draft' RETURNING *`,
        [request.user.sub, id]
      )
      if (!res.rows[0]) {
        return reply.status(404).send({ error: 'Déclaration introuvable ou non soumise (status ≠ draft)' })
      }

      // OWASP A09 : action critique (soumission à la sécurité sociale CI)
      auditLogCnps(schema, request.user.sub, 'cnps.declaration_submitted', id, {
        year: res.rows[0].year, quarter: res.rows[0].quarter,
        masseSalariale: res.rows[0].masse_salariale ?? null,
        totalCotisations: res.rows[0].total_cotisations ?? null,
      }, request.ip ?? null)

      return reply.send({ data: res.rows[0], message: 'Déclaration CNPS soumise' })
    },
  })

  // GET /cnps/declarations/:id/export — exporter en CSV (format e-CNPS)
  fastify.get('/declarations/:id/export', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: HEAVY_EXPORT_RATE_LIMIT,
    schema: { tags: ['cnps'], summary: 'Exporter la déclaration CNPS (CSV e-CNPS)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const schema = request.user.schemaName

      const res = await rawPool.query<{
        year: number; quarter: number; data: unknown
        total_cotisations: string; employees_count: number
      }>(
        `SELECT year, quarter, data,
                COALESCE(total_cotisations, 0)::text AS total_cotisations,
                COALESCE(employees_count, 0) AS employees_count
         FROM "${schema}".cnps_declarations WHERE id = $1 LIMIT 1`,
        [id]
      )
      const decl = res.rows[0]
      if (!decl) return reply.status(404).send({ error: 'Déclaration introuvable' })

      const employees = decl.data as Array<{
        employee_id: string; first_name: string; last_name: string
        cnps_number: string; nni: string
        gross_salary: string; total_cnps_sal: string; total_cnps_pat: string
      }>

      // Format CSV e-CNPS CI
      const lines: string[] = [
        'NNI;NOM;PRENOM;N_CNPS;SALAIRE_BRUT;COTIS_SAL;COTIS_PAT;TOTAL',
      ]
      for (const emp of employees) {
        lines.push([
          csvCell(emp.nni ?? ''),
          csvCell(emp.last_name.toUpperCase()),
          csvCell(emp.first_name),
          csvCell(emp.cnps_number ?? ''),
          csvCell(emp.gross_salary ?? '0'),
          csvCell(emp.total_cnps_sal ?? '0'),
          csvCell(emp.total_cnps_pat ?? '0'),
          csvCell(String(parseInt(emp.total_cnps_sal ?? '0') + parseInt(emp.total_cnps_pat ?? '0'))),
        ].join(';'))
      }

      const csv = lines.join('\r\n')
      const filename = `CNPS_${decl.year}_T${decl.quarter}.csv`

      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      return reply.send('\uFEFF' + csv) // BOM UTF-8 pour Excel
    },
  })

  // GET /cnps/disa — liste des déclarations DISA annuelles
  fastify.get('/disa', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['cnps'], summary: 'Liste des déclarations DISA annuelles' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT * FROM "${schema}".disa_records ORDER BY year DESC`
      )
      return reply.send({ data: res.rows })
    },
  })

  // POST /cnps/disa/generate — générer la déclaration DISA annuelle
  fastify.post('/disa/generate', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['cnps'], summary: 'Générer la déclaration DISA annuelle (loi 99-477)' },
    handler: async (request, reply) => {
      const parsed = disaGenerateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Paramètres invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const { year, legalEntityId } = parsed.data
      const schema = request.user.schemaName

      // Multi-filiales : si has_subsidiaries=true, legalEntityId obligatoire
      // (chaque filiale a son numéro CNPS distinct et sa DISA propre).
      const tenantRes = await rawPool.query<{ has_subsidiaries: boolean }>(
        `SELECT has_subsidiaries FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
      )
      if (tenantRes.rows[0]?.has_subsidiaries === true && !legalEntityId) {
        return reply.status(400).send({
          error: 'Ce tenant a plusieurs filiales — legalEntityId requis (DISA distincte par numéro CNPS)',
        })
      }
      if (legalEntityId) {
        const le = await rawPool.query(
          `SELECT id FROM "${schema}".legal_entities WHERE id = $1 AND is_active = true LIMIT 1`,
          [legalEntityId],
        ).catch(() => ({ rows: [] }))
        if (!le.rows[0]) return reply.status(404).send({ error: 'Filiale introuvable ou inactive' })
      }

      // Récupérer tous les bulletins de l'année (scope filiale si applicable)
      const months = Array.from({ length: 12 }, (_, i) =>
        `${year}-${String(i + 1).padStart(2, '0')}`
      )

      const aggParams: unknown[] = [months]
      let aggFilter = ''
      if (legalEntityId) {
        aggParams.push(legalEntityId)
        aggFilter = ` AND ps.legal_entity_id = $${aggParams.length}`
      }

      const empsRes = await rawPool.query<{
        employee_id: string; first_name: string; last_name: string
        cnps_number: string; nni: string; job_title: string
        total_sal: string; total_cnps_sal: string; total_its: string
      }>(
        `SELECT e.id AS employee_id, e.first_name, e.last_name,
                e.cnps_number, e.nni, e.job_title,
                SUM(ps.gross_salary)::text AS total_sal,
                SUM(ps.total_cnps_sal)::text AS total_cnps_sal,
                SUM(ps.its)::text AS total_its
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         WHERE ps.month = ANY($1::text[])${aggFilter}
         GROUP BY e.id, e.first_name, e.last_name, e.cnps_number, e.nni, e.job_title`,
        aggParams,
      )

      const employees = empsRes.rows

      // OWASP A04 — cap anti-fraude : refuser les exports DISA gigantesques.
      if (employees.length > DISA_MAX_EMPLOYEES) {
        return reply.status(413).send({
          error: `Trop d'employés pour un export DISA en un lot (${employees.length}). Maximum ${DISA_MAX_EMPLOYEES} par génération.`,
        })
      }

      let masseSalariale = 0
      let totalCnps = 0
      let totalIts = 0

      for (const emp of employees) {
        masseSalariale += parseInt(emp.total_sal ?? '0')
        totalCnps      += parseInt(emp.total_cnps_sal ?? '0')
        totalIts       += parseInt(emp.total_its ?? '0')
      }

      // Insérer/mettre à jour un enregistrement DISA agrégé par année
      // (et par filiale en multi-filiales). Le UNIQUE existant porte sur
      // (year), donc on tente avec legal_entity_id puis fallback si la
      // contrainte n'autorise pas la dimension supplémentaire.
      await rawPool.query(
        `INSERT INTO "${schema}".disa_records
           (year, employees_count, masse_salariale, total_cnps, total_its, data, status, legal_entity_id)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
         ON CONFLICT (year) DO UPDATE SET
           employees_count = EXCLUDED.employees_count,
           masse_salariale  = EXCLUDED.masse_salariale,
           total_cnps       = EXCLUDED.total_cnps,
           total_its        = EXCLUDED.total_its,
           data             = EXCLUDED.data,
           status           = 'draft',
           legal_entity_id  = EXCLUDED.legal_entity_id,
           updated_at       = now()`,
        [year, employees.length, masseSalariale, totalCnps, totalIts, JSON.stringify(employees), legalEntityId ?? null]
      ).catch(async () => rawPool.query(
        `INSERT INTO "${schema}".disa_records
           (year, employees_count, masse_salariale, total_cnps, total_its, data, status)
         VALUES ($1,$2,$3,$4,$5,$6,'draft')
         ON CONFLICT (year) DO UPDATE SET
           employees_count = EXCLUDED.employees_count,
           masse_salariale  = EXCLUDED.masse_salariale,
           total_cnps       = EXCLUDED.total_cnps,
           total_its        = EXCLUDED.total_its,
           data             = EXCLUDED.data,
           status           = 'draft',
           updated_at       = now()`,
        [year, employees.length, masseSalariale, totalCnps, totalIts, JSON.stringify(employees)],
      ))

      // OWASP A09 — traçabilité génération DISA annuelle (loi 99-477)
      auditLogCnps(
        schema, request.user.sub, 'cnps.disa_generated', null,
        { year, legalEntityId: legalEntityId ?? null,
          employeesCount: employees.length, masseSalariale, totalCnps, totalIts },
        request.ip ?? null,
      )

      return reply.send({
        data: {
          year,
          employeesCount: employees.length,
          masseSalariale, totalCnps, totalIts,
          currency: 'XOF',
        },
        employees,
      })
    },
  })

  // GET /cnps/declarations/:id/neva — export XML format NEVA (homologation CNPS CI)
  fastify.get('/declarations/:id/neva', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    config: HEAVY_EXPORT_RATE_LIMIT,
    schema: { tags: ['cnps'], summary: 'Export NEVA/XML CNPS (homologation)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const schema = request.user.schemaName

      const decl = await rawPool.query<{
        year: number; quarter: number; data: unknown
        total_cotisations_salariales: string; total_cotisations_patronales: string
        total_cotisations: string; masse_salariale: string; employees_count: number
      }>(
        `SELECT year, quarter, data, total_cotisations_salariales, total_cotisations_patronales,
                total_cotisations, masse_salariale, employees_count
         FROM "${schema}".cnps_declarations WHERE id = $1 LIMIT 1`, [id]
      )
      if (!decl.rows[0]) return reply.status(404).send({ error: 'Déclaration introuvable' })
      const d = decl.rows[0]

      const tenantRes = await rawPool.query<{ name: string; cnps_number: string; slug: string }>(
        `SELECT name, cnps_number, slug FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]

      const employees = d.data as Array<{
        nni: string; last_name: string; first_name: string; cnps_number: string
        gross_salary: string; total_cnps_sal: string; total_cnps_pat: string
      }>

      const esc = (v: string) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const dateDec = new Date().toISOString().split('T')[0]

      const salaries = employees.map(e => `    <SALARIE>
      <NNI>${esc(e.nni)}</NNI>
      <NOM>${esc(e.last_name.toUpperCase())}</NOM>
      <PRENOM>${esc(e.first_name)}</PRENOM>
      <N_CNPS>${esc(e.cnps_number)}</N_CNPS>
      <SALAIRE_BRUT>${e.gross_salary ?? 0}</SALAIRE_BRUT>
      <COTIS_SALARIALE>${e.total_cnps_sal ?? 0}</COTIS_SALARIALE>
      <COTIS_PATRONALE>${e.total_cnps_pat ?? 0}</COTIS_PATRONALE>
      <TOTAL_COTIS>${parseInt(e.total_cnps_sal ?? '0') + parseInt(e.total_cnps_pat ?? '0')}</TOTAL_COTIS>
    </SALARIE>`).join('\n')

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DECLARATION_CNPS xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <ENTETE>
    <VERSION>1.0</VERSION>
    <TYPE_DECLARATION>TRIMESTRIELLE</TYPE_DECLARATION>
    <ANNEE>${d.year}</ANNEE>
    <TRIMESTRE>${d.quarter}</TRIMESTRE>
    <DATE_GENERATION>${dateDec}</DATE_GENERATION>
    <EMPLOYEUR>
      <RAISON_SOCIALE>${esc(tenant?.name ?? '')}</RAISON_SOCIALE>
      <N_CNPS_EMPLOYEUR>${esc(tenant?.cnps_number ?? '')}</N_CNPS_EMPLOYEUR>
    </EMPLOYEUR>
    <RECAPITULATIF>
      <NB_SALARIES>${d.employees_count}</NB_SALARIES>
      <MASSE_SALARIALE>${d.masse_salariale ?? 0}</MASSE_SALARIALE>
      <TOTAL_COTIS_SALARIALES>${d.total_cotisations_salariales ?? 0}</TOTAL_COTIS_SALARIALES>
      <TOTAL_COTIS_PATRONALES>${d.total_cotisations_patronales ?? 0}</TOTAL_COTIS_PATRONALES>
      <TOTAL_COTISATIONS>${d.total_cotisations ?? 0}</TOTAL_COTISATIONS>
    </RECAPITULATIF>
  </ENTETE>
  <SALARIES>
${salaries}
  </SALARIES>
</DECLARATION_CNPS>`

      // OWASP A09 — l'export NEVA = artefact transmis à la CNPS (preuve légale),
      // doit être traçable (qui l'a téléchargé, à quelle date, pour quel trimestre).
      auditLogCnps(
        schema, request.user.sub, 'cnps.declaration_neva_exported', id,
        { year: d.year, quarter: d.quarter, employeesCount: d.employees_count, format: 'xml/neva' },
        request.ip ?? null,
      )

      reply.header('Content-Type', 'application/xml; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="NEVA_CNPS_${d.year}_T${d.quarter}.xml"`)
      return reply.send(xml)
    },
  })

  // POST /cnps/events/cessation — signal CNPS cessation d'emploi (temps réel)
  fastify.post('/events/cessation', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['cnps'], summary: 'Signal CNPS — Cessation emploi (temps réel)' },
    handler: async (request, reply) => {
      const parsed = cessationEventSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Paramètres cessation invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const { employeeId, exitDate, reason } = parsed.data
      const schema = request.user.schemaName

      const empRes = await rawPool.query<{
        id: string; first_name: string; last_name: string; cnps_number: string; nni: string
        hire_date: string; base_salary: string
      }>(
        `SELECT id, first_name, last_name, cnps_number, nni, hire_date, base_salary
         FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId]
      )
      const emp = empRes.rows[0]
      if (!emp) return reply.status(404).send({ error: 'Employé introuvable' })

      // Calculer indemnités légales CI
      const hireDate = new Date(emp.hire_date)
      const exit     = new Date(exitDate)
      const ancienneteMois = Math.max(0, (exit.getFullYear() - hireDate.getFullYear()) * 12 + (exit.getMonth() - hireDate.getMonth()))
      const ancienneteAns  = ancienneteMois / 12

      // Préavis CI (Code du Travail art. 16.2)
      const preavisJours = ancienneteAns < 1 ? 30 : ancienneteAns <= 5 ? 60 : 90

      // Indemnité de licenciement (1/3 mois/an 1-5 ans, 2/3 mois/an > 5 ans)
      const baseSalary = parseInt(emp.base_salary ?? '0')
      let indemnite = 0
      if (ancienneteAns >= 1) {
        const ans1a5  = Math.min(ancienneteAns, 5)
        const ansSup5 = Math.max(0, ancienneteAns - 5)
        indemnite = Math.floor((baseSalary / 3) * ans1a5 + (baseSalary * 2 / 3) * (ansSup5 / 12) * 12)
      }

      // Enregistrer l'événement RH
      await rawPool.query(
        `INSERT INTO "${schema}".hr_events (employee_id, type, title, description, date, metadata, created_by)
         VALUES ($1,'cessation','Cessation d''emploi',$2,$3,$4,$5)`,
        [
          employeeId,
          `Cessation d'emploi : ${reason}`,
          exitDate,
          JSON.stringify({ reason, preavisJours, indemniteLicenciement: indemnite, ancienneteMois }),
          request.user.sub,
        ]
      )

      // Désactiver l'employé
      await rawPool.query(
        `UPDATE "${schema}".employees SET is_active = false, exit_date = $1, exit_reason = $2 WHERE id = $3`,
        [exitDate, reason, employeeId]
      )

      return reply.send({
        employee: { id: emp.id, name: `${emp.first_name} ${emp.last_name}`, cnps: emp.cnps_number, nni: emp.nni },
        cessation: { exitDate, reason, ancienneteMois: Math.floor(ancienneteMois), ancienneteAns: ancienneteAns.toFixed(1) },
        droitsLegaux: {
          preavisJours,
          indemniteLicenciement: indemnite,
          currency: 'XOF',
          reference: 'Art. 16 Code du Travail CI',
        },
        cnpsSignal: { status: 'recorded', message: 'Signal cessation enregistré — à déclarer avant le 15 du mois M+1 sur e-CNPS' },
      })
    },
  })

  // GET /cnps/summary — récapitulatif annuel CNPS
  fastify.get('/summary', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['cnps'], summary: 'Récapitulatif annuel CNPS' },
    handler: async (request, reply) => {
      const { year: yearRaw } = request.query as Record<string, string>
      // OWASP A03 — validation stricte (regex + plage) au lieu de parseInt brut
      const yearNum = parseYearParam(yearRaw)
      if (yearNum === null) return reply.status(400).send({ error: 'year hors plage' })
      const year = String(yearNum)
      const schema = request.user.schemaName

      const res = await rawPool.query<{
        month: string
        gross: string; cnps_sal: string; cnps_pat: string; its: string; net: string
      }>(
        `SELECT ps.month,
                SUM(ps.gross_salary)::text AS gross,
                SUM(ps.total_cnps_sal)::text AS cnps_sal,
                SUM(ps.total_cnps_pat)::text AS cnps_pat,
                SUM(ps.its)::text AS its,
                SUM(ps.net_payable)::text AS net
         FROM "${schema}".pay_slips ps
         WHERE ps.month LIKE $1
         GROUP BY ps.month
         ORDER BY ps.month`,
        [`${year}-%`]
      )

      const rows = res.rows
      const totals = rows.reduce(
        (acc, r) => ({
          gross:   acc.gross   + parseInt(r.gross ?? '0'),
          cnpsSal: acc.cnpsSal + parseInt(r.cnps_sal ?? '0'),
          cnpsPat: acc.cnpsPat + parseInt(r.cnps_pat ?? '0'),
          its:     acc.its     + parseInt(r.its ?? '0'),
          net:     acc.net     + parseInt(r.net ?? '0'),
        }),
        { gross: 0, cnpsSal: 0, cnpsPat: 0, its: 0, net: 0 }
      )

      return reply.send({ data: rows, totals, year: parseInt(year), currency: 'XOF' })
    },
  })

  // GET /cnps/validate/:year/:quarter — validateur pré-DSN (bloque envoi si données critiques manquantes)
  fastify.get('/validate/:year/:quarter', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['cnps'], summary: 'Validateur pré-DSN : contrôle intégrité avant soumission CNPS' },
    handler: async (request, reply) => {
      const { year, quarter } = request.params as { year: string; quarter: string }
      const schema = request.user.schemaName

      // OWASP A03 — validation stricte (regex + plage)
      const yr  = parseYearParam(year)
      const qtr = parseInt(quarter)
      if (yr === null || !qtr || qtr < 1 || qtr > 4) {
        return reply.status(400).send({ error: 'year et quarter (1-4) requis' })
      }

      const months: string[] = []
      for (let m = (qtr - 1) * 3 + 1; m <= qtr * 3; m++) {
        months.push(`${yr}-${String(m).padStart(2, '0')}`)
      }

      const errors:   Array<{ code: string; severity: 'blocking' | 'warning'; message: string; employeeId?: string; employeeName?: string }> = []
      const warnings: Array<{ code: string; message: string }> = []

      // 1. Vérifier numéro CNPS employeur
      const tenantRes = await rawPool.query<{ cnps_number: string; name: string }>(
        `SELECT name, cnps_number FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]
      if (!tenant?.cnps_number) {
        errors.push({ code: 'CNPS_EMPLOYER_MISSING', severity: 'blocking', message: 'Numéro CNPS employeur manquant — à renseigner dans Paramètres → Entreprise' })
      }

      // 2. Vérifier bulletins du trimestre existent
      const slipCountRes = await rawPool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM "${schema}".pay_slips WHERE month = ANY($1::text[])`, [months]
      )
      const slipCount = parseInt(slipCountRes.rows[0]?.cnt ?? '0')
      if (slipCount === 0) {
        errors.push({ code: 'NO_PAYSLIPS', severity: 'blocking', message: `Aucun bulletin de paie trouvé pour ${yr} T${qtr} — clôturez d'abord la paie` })
      }

      // 3. Employés sans numéro CNPS avec bulletins ce trimestre
      const noCnpsRes = await rawPool.query<{ id: string; first_name: string; last_name: string }>(
        `SELECT DISTINCT e.id, e.first_name, e.last_name
         FROM "${schema}".employees e
         JOIN "${schema}".pay_slips ps ON ps.employee_id = e.id
         WHERE ps.month = ANY($1::text[])
           AND (e.cnps_number IS NULL OR e.cnps_number = '')
           AND e.is_active = true`, [months]
      )
      for (const emp of noCnpsRes.rows) {
        errors.push({
          code: 'EMPLOYEE_NO_CNPS',
          severity: 'blocking',
          message: `Numéro CNPS manquant`,
          employeeId: emp.id,
          employeeName: `${emp.first_name} ${emp.last_name}`,
        })
      }

      // 4. Employés sans NNI (matricule salarié)
      const noNniRes = await rawPool.query<{ id: string; first_name: string; last_name: string }>(
        `SELECT DISTINCT e.id, e.first_name, e.last_name
         FROM "${schema}".employees e
         JOIN "${schema}".pay_slips ps ON ps.employee_id = e.id
         WHERE ps.month = ANY($1::text[])
           AND (e.nni IS NULL OR e.nni = '')
           AND e.is_active = true`, [months]
      )
      for (const emp of noNniRes.rows) {
        errors.push({
          code: 'EMPLOYEE_NO_NNI',
          severity: 'blocking',
          message: `NNI (matricule national) manquant`,
          employeeId: emp.id,
          employeeName: `${emp.first_name} ${emp.last_name}`,
        })
      }

      // 5. Salaires inférieurs au SMIG
      const belowSmigRes = await rawPool.query<{ id: string; first_name: string; last_name: string; net: string }>(
        `SELECT DISTINCT e.id, e.first_name, e.last_name, ps.net_payable::text AS net
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         WHERE ps.month = ANY($1::text[])
           AND ps.net_payable < 75000`, [months]
      )
      for (const emp of belowSmigRes.rows) {
        warnings.push({ code: 'BELOW_SMIG', message: `${emp.first_name} ${emp.last_name} — net ${parseInt(emp.net ?? '0').toLocaleString('fr-FR')} FCFA < SMIG 75 000 FCFA` })
      }

      // 6. Vérifier délai de dépôt (avant le 15 du mois M+1)
      const lastMonthOfQtr = months[months.length - 1]!
      const [qtrYear, qtrMonth] = lastMonthOfQtr.split('-').map(Number) as [number, number]
      let deadlineMonth = qtrMonth + 1
      let deadlineYear  = qtrYear
      if (deadlineMonth > 12) { deadlineMonth = 1; deadlineYear++ }
      const deadline = new Date(deadlineYear, deadlineMonth - 1, 15)
      const today    = new Date()
      if (today > deadline) {
        warnings.push({ code: 'DEADLINE_PASSED', message: `Date limite dépassée — dépôt attendu avant le 15/${String(deadlineMonth).padStart(2,'0')}/${deadlineYear}` })
      } else {
        const daysLeft = Math.ceil((deadline.getTime() - today.getTime()) / 86400000)
        if (daysLeft <= 5) {
          warnings.push({ code: 'DEADLINE_SOON', message: `Délai de dépôt dans ${daysLeft} jour(s) — le 15/${String(deadlineMonth).padStart(2,'0')}/${deadlineYear}` })
        }
      }

      const isValid   = errors.filter(e => e.severity === 'blocking').length === 0
      const totalEmps = slipCount

      return reply.send({
        valid: isValid,
        year: yr, quarter: qtr, months,
        employerCnps: tenant?.cnps_number ?? null,
        totalPayslips: totalEmps,
        errors,
        warnings,
        summary: {
          blocking: errors.filter(e => e.severity === 'blocking').length,
          warnings: warnings.length,
          message: isValid
            ? `✓ Déclaration prête — ${totalEmps} bulletins, 0 blocage`
            : `✗ ${errors.filter(e => e.severity === 'blocking').length} problème(s) bloquant(s) à corriger avant soumission`,
        },
      })
    },
  })
  // GET /cnps/rns/fields — liste les champs AcroForm du template RNS (debug)
  fastify.get('/rns/fields', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['cnps'], summary: 'Lister les champs AcroForm du template RNS' },
    handler: async (_request, reply) => {
      const { listRnsFields } = await import('../../services/rns-pdf.js')
      const fields = await listRnsFields()
      return reply.send({
        hasAcroForm: fields.length > 0,
        fields,
        message: fields.length > 0
          ? `${fields.length} champ(s) remplissable(s) détecté(s)`
          : 'PDF plat — superposition texte aux coordonnées fixes',
      })
    },
  })

  // GET /cnps/rns/:year/pdf — PDF Relevé Nominatif des Salaires (formulaire CNPS EN-GDAV-06 v03)
  fastify.get('/rns/:year/pdf', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: HEAVY_EXPORT_RATE_LIMIT,
    schema: { tags: ['cnps'], summary: 'Générer le RNS en PDF (formulaire officiel CNPS EN-GDAV-06 v03)' },
    handler: async (request, reply) => {
      const { year } = request.params as { year: string }
      const { employeeId } = request.query as { employeeId?: string }
      const schema = request.user.schemaName
      // OWASP A03 — validation stricte year + UUID employeeId si fourni
      const yr = parseYearParam(year)
      if (yr === null) return reply.status(400).send({ error: 'year hors plage' })
      if (employeeId && !UUID_RE.test(employeeId)) return reply.status(400).send({ error: 'employeeId invalide (UUID requis)' })

      const tenantRes = await rawPool.query<{
        name: string; cnps_number: string; city: string
        cnps_affiliation_date: string; address: string
      }>(
        `SELECT name,
                COALESCE(cnps_number,'') AS cnps_number,
                COALESCE(city,'Abidjan') AS city,
                TO_CHAR(created_at, 'DD/MM/YYYY') AS cnps_affiliation_date,
                COALESCE(city,'Abidjan') || ', Côte d''Ivoire' AS address
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]
      if (!tenant) return reply.status(404).send({ error: 'Tenant introuvable' })

      const months = Array.from({ length: 12 }, (_, i) => `${yr}-${String(i + 1).padStart(2, '0')}`)
      const params: unknown[] = [months]
      let empSql = `
        SELECT e.id, e.first_name, e.last_name,
               COALESCE(e.cnps_number,'') AS cnps_number,
               COALESCE(e.hire_date::text,'') AS hire_date,
               e.exit_date::text AS exit_date,
               COALESCE(SUM(ps.gross_salary)::int, 0) AS annual_salary,
               COALESCE(COUNT(ps.id)::int, 0) AS months_worked
        FROM "${schema}".employees e
        LEFT JOIN "${schema}".pay_slips ps
               ON ps.employee_id = e.id AND ps.month = ANY($1::text[])
        WHERE e.is_active = true AND e.deleted_at IS NULL`
      if (employeeId) { params.push(employeeId); empSql += ` AND e.id = $${params.length}` }
      empSql += ` GROUP BY e.id ORDER BY e.last_name, e.first_name`

      const empsRes = await rawPool.query<{
        first_name: string; last_name: string; cnps_number: string
        hire_date: string; exit_date: string | null
        annual_salary: number; months_worked: number
      }>(empSql, params)

      if (!empsRes.rows.length) return reply.status(404).send({ error: 'Aucun employé trouvé' })

      const { generateRnsPdf } = await import('../../services/rns-pdf.js')

      let pdfBuffer: Buffer
      try {
        pdfBuffer = await generateRnsPdf(
          {
            name:            tenant.name,
            address:         tenant.address,
            cnpsNumber:      tenant.cnps_number,
            affiliationDate: tenant.cnps_affiliation_date,
            city:            tenant.city,
          },
          empsRes.rows.map(e => ({
            lastName:     e.last_name,
            firstName:    e.first_name,
            cnpsNumber:   e.cnps_number,
            hireDate:     e.hire_date,
            exitDate:     e.exit_date,
            annualSalary: e.annual_salary,
            monthsWorked: e.months_worked,
            year:         yr,
          })),
        )
      } catch (err) {
        // OWASP A10 — masquer les détails internes (template manquant, font fail)
        fastify.log.error({ err: (err as Error).message }, '[cnps] RNS PDF generation failed')
        return reply.status(500).send({ error: 'Échec de la génération du RNS PDF' })
      }

      // OWASP A09 — traçabilité téléchargement RNS (relevé nominatif officiel CNPS)
      auditLogCnps(
        schema, request.user.sub, 'cnps.rns_pdf_exported', null,
        { year: yr, employeeId: employeeId ?? null, employeesCount: empsRes.rows.length, format: 'pdf' },
        request.ip ?? null,
      )

      const suffix = employeeId ? `_${empsRes.rows[0]?.last_name}` : '_TOUS'
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `attachment; filename="RNS_${yr}${suffix}.pdf"`)
      return reply.send(pdfBuffer)
    },
  })

  // GET /cnps/rns/:year/export — Relevé Nominatif des Salaires (format officiel CNPS CI)
  fastify.get('/rns/:year/export', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: HEAVY_EXPORT_RATE_LIMIT,
    schema: { tags: ['cnps'], summary: 'Export RNS — Relevé Nominatif des Salaires (CNPS officiel)' },
    handler: async (request, reply) => {
      const { year } = request.params as { year: string }
      const schema = request.user.schemaName
      // OWASP A03 — validation stricte year
      const yr = parseYearParam(year)
      if (yr === null) return reply.status(400).send({ error: 'year hors plage' })

      const tenantRes = await rawPool.query<{ name: string; cnps_number: string; rccm: string; dgi_number: string }>(
        `SELECT name, cnps_number, rccm, dgi_number FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]

      const months = Array.from({ length: 12 }, (_, i) => `${yr}-${String(i + 1).padStart(2, '0')}`)

      const empsRes = await rawPool.query<{
        employee_id: string; first_name: string; last_name: string
        cnps_number: string; nni: string; job_title: string
        mois_travailles: string; salaire_brut_annuel: string
        cotis_sal_annuelle: string; cotis_pat_annuelle: string; its_annuel: string
      }>(
        `SELECT e.id AS employee_id, e.first_name, e.last_name,
                COALESCE(e.cnps_number,'') AS cnps_number,
                COALESCE(e.nni,'') AS nni,
                COALESCE(e.job_title,'') AS job_title,
                COUNT(ps.id)::text AS mois_travailles,
                SUM(ps.gross_salary)::text AS salaire_brut_annuel,
                SUM(ps.total_cnps_sal)::text AS cotis_sal_annuelle,
                SUM(ps.total_cnps_pat)::text AS cotis_pat_annuelle,
                SUM(ps.its)::text AS its_annuel
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         WHERE ps.month = ANY($1::text[])
         GROUP BY e.id, e.first_name, e.last_name, e.cnps_number, e.nni, e.job_title
         ORDER BY e.last_name, e.first_name`,
        [months]
      )

      const employees = empsRes.rows
      if (employees.length === 0) {
        return reply.status(404).send({ error: `Aucun bulletin pour l'année ${yr}` })
      }

      let totalBrut = 0; let totalCotisSal = 0; let totalCotisPat = 0; let totalIts = 0
      for (const emp of employees) {
        totalBrut     += parseInt(emp.salaire_brut_annuel ?? '0')
        totalCotisSal += parseInt(emp.cotis_sal_annuelle ?? '0')
        totalCotisPat += parseInt(emp.cotis_pat_annuelle ?? '0')
        totalIts      += parseInt(emp.its_annuel ?? '0')
      }

      const headerLines = [
        `RELEVÉ NOMINATIF DES SALAIRES — EXERCICE ${yr}`,
        `Employeur : ${tenant?.name ?? ''}`,
        `N° CNPS Employeur : ${tenant?.cnps_number ?? ''}`,
        `N° DGI : ${tenant?.dgi_number ?? ''}`,
        `RCCM : ${tenant?.rccm ?? ''}`,
        `Date de génération : ${new Date().toLocaleDateString('fr-CI')}`,
        `Nombre de salariés : ${employees.length}`,
        '',
        'NNI;NOM;PRENOM;N_CNPS;POSTE;MOIS_TRAVAILLES;SALAIRE_BRUT_ANNUEL;COTIS_SAL_ANNUELLE;COTIS_PAT_ANNUELLE;ITS_ANNUEL;TOTAL_PRELEVEMENTS_SAL',
      ]

      const dataLines = employees.map(e => {
        const totalPrelevements = parseInt(e.cotis_sal_annuelle ?? '0') + parseInt(e.its_annuel ?? '0')
        return [
          csvCell(e.nni),
          csvCell(e.last_name.toUpperCase()),
          csvCell(e.first_name),
          csvCell(e.cnps_number),
          csvCell(e.job_title),
          csvCell(e.mois_travailles),
          csvCell(e.salaire_brut_annuel),
          csvCell(e.cotis_sal_annuelle),
          csvCell(e.cotis_pat_annuelle),
          csvCell(e.its_annuel),
          csvCell(String(totalPrelevements)),
        ].join(';')
      })

      const footerLines = [
        '',
        `TOTAL GÉNÉRAL;${employees.length} salariés;;;;${totalBrut};${totalCotisSal};${totalCotisPat};${totalIts};${totalCotisSal + totalIts}`,
      ]

      const csv = [...headerLines, ...dataLines, ...footerLines].join('\r\n')

      // OWASP A09 — traçabilité téléchargement RNS CSV
      auditLogCnps(
        schema, request.user.sub, 'cnps.rns_csv_exported', null,
        { year: yr, employeesCount: employees.length, totalBrut, format: 'csv' },
        request.ip ?? null,
      )

      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="RNS_CNPS_${yr}.csv"`)
      return reply.send('﻿' + csv)
    },
  })

  // GET /cnps/disa/:year/export — export CSV DISA (Déclaration Individuelle Salaires Annuels)
  fastify.get('/disa/:year/export', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    config: HEAVY_EXPORT_RATE_LIMIT,
    schema: { tags: ['cnps'], summary: 'Export DISA CSV — format dépôt DGI/CNPS (loi 99-477)' },
    handler: async (request, reply) => {
      const { year } = request.params as { year: string }
      const schema = request.user.schemaName
      // OWASP A03 — validation stricte year
      const yr = parseYearParam(year)
      if (yr === null) return reply.status(400).send({ error: 'year hors plage' })

      const tenantRes = await rawPool.query<{ name: string; cnps_number: string; dgi_number: string }>(
        `SELECT name, cnps_number, dgi_number FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]

      const disaRes = await rawPool.query<{
        data: unknown; year: number; employees_count: number
        masse_salariale: string; total_cnps: string; total_its: string
      }>(
        `SELECT * FROM "${schema}".disa_records WHERE year = $1 LIMIT 1`, [yr]
      )
      if (!disaRes.rows[0]) {
        return reply.status(404).send({ error: `DISA ${yr} non générée — exécutez d'abord POST /cnps/disa/generate` })
      }

      const disa = disaRes.rows[0]
      const employees = disa.data as Array<{
        employee_id: string; first_name: string; last_name: string
        nni: string; cnps_number: string; job_title: string
        total_sal: string; total_cnps_sal: string; total_its: string
      }>

      const headerLines = [
        `DÉCLARATION INDIVIDUELLE DES SALAIRES ANNUELS (DISA) — EXERCICE ${yr}`,
        `Base légale : Loi 99-477 du 2 août 1999`,
        `Employeur : ${tenant?.name ?? ''}`,
        `N° CNPS Employeur : ${tenant?.cnps_number ?? ''}`,
        `N° DGI : ${tenant?.dgi_number ?? ''}`,
        `Nombre de salariés déclarés : ${disa.employees_count}`,
        `Masse salariale annuelle : ${parseInt(disa.masse_salariale ?? '0').toLocaleString('fr-FR')} FCFA`,
        `Date de génération : ${new Date().toLocaleDateString('fr-CI')}`,
        '',
        'NNI;NOM;PRENOM;N_CNPS;POSTE;SALAIRE_BRUT_ANNUEL;COTIS_CNPS_SAL;ITS_ANNUEL;TOTAL_PRELEVEMENTS',
      ]

      const dataLines = employees.map(e => {
        const totalPrelevements = parseInt(e.total_cnps_sal ?? '0') + parseInt(e.total_its ?? '0')
        return [
          csvCell(e.nni ?? ''),
          csvCell(e.last_name.toUpperCase()),
          csvCell(e.first_name),
          csvCell(e.cnps_number ?? ''),
          csvCell(e.job_title ?? ''),
          csvCell(e.total_sal ?? '0'),
          csvCell(e.total_cnps_sal ?? '0'),
          csvCell(e.total_its ?? '0'),
          csvCell(String(totalPrelevements)),
        ].join(';')
      })

      const total = employees.reduce(
        (acc, e) => ({
          sal:  acc.sal  + parseInt(e.total_sal ?? '0'),
          cnps: acc.cnps + parseInt(e.total_cnps_sal ?? '0'),
          its:  acc.its  + parseInt(e.total_its ?? '0'),
        }),
        { sal: 0, cnps: 0, its: 0 }
      )

      const footerLines = [
        '',
        `TOTAL GÉNÉRAL;${employees.length} salariés;;;;${total.sal};${total.cnps};${total.its};${total.cnps + total.its}`,
      ]

      const csv = [...headerLines, ...dataLines, ...footerLines].join('\r\n')

      // OWASP A09 — traçabilité téléchargement DISA (artefact transmis au DGI/CNPS)
      auditLogCnps(
        schema, request.user.sub, 'cnps.disa_csv_exported', null,
        { year: yr, employeesCount: employees.length, format: 'csv' },
        request.ip ?? null,
      )

      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="DISA_${yr}.csv"`)
      return reply.send('﻿' + csv)
    },
  })

  // GET /cnps/audit-conformite — audit conformité sociale 360° (CNPS/DGI/ITS/SMIG)
  fastify.get('/audit-conformite', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    // OWASP A07 — endpoint exécutant 7+ queries lourdes (agrégations multi-tables) :
    // même cap que les exports pour éviter la saturation DB.
    config: HEAVY_EXPORT_RATE_LIMIT,
    schema: { tags: ['cnps'], summary: 'Audit conformité sociale 360° — CNPS/DGI/SMIG/Plafonds/Déclarations' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const q      = request.query as Record<string, string>
      const now    = new Date()

      const year           = parseInt(q.year   ?? String(now.getFullYear()))
      const checkEmployeur = q.checkEmployeur !== 'false'
      const checkCnps      = q.checkCnps      !== 'false'
      const checkSmig      = q.checkSmig      !== 'false'
      const checkDecl      = q.checkDecl      !== 'false'
      const checkMobile    = q.checkMobile    !== 'false'
      const checkPlafonds  = q.checkPlafonds  !== 'false'

      const SMIG             = 75_000
      const PLAFOND_RETRAITE = 1_647_315
      const PLAFOND_AT_PF    = 70_000

      const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)

      // ── Données tenant ───────────────────────────────────────────────────
      const tenantRes = await rawPool.query<{
        name: string; cnps_number: string; dgi_number: string; rccm: string; at_rate: string
      }>(
        `SELECT name,
                COALESCE(cnps_number,'') AS cnps_number,
                COALESCE(dgi_number,'')  AS dgi_number,
                COALESCE(rccm,'')        AS rccm,
                COALESCE(at_rate,'0.020') AS at_rate
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]

      const anomalies: Array<{
        code: string; severity: 'bloquant' | 'avertissement'; categorie: string
        message: string; employeeId?: string; employeeName?: string
      }> = []

      // ── 1. Employeur ─────────────────────────────────────────────────────
      if (checkEmployeur) {
        if (!tenant?.cnps_number) anomalies.push({ code: 'EMP_CNPS_MISSING', severity: 'bloquant',      categorie: 'Employeur', message: 'N° CNPS employeur manquant — déclaration e-CNPS impossible' })
        if (!tenant?.dgi_number)  anomalies.push({ code: 'EMP_DGI_MISSING',  severity: 'avertissement', categorie: 'Employeur', message: 'N° DGI/ITS manquant — télédéclaration ITS impossible' })
        if (!tenant?.rccm)        anomalies.push({ code: 'EMP_RCCM_MISSING', severity: 'avertissement', categorie: 'Employeur', message: 'RCCM manquant — mention obligatoire sur contrats OHADA' })
      }

      // ── 2. Employés (requête unique avec dernier bulletin de l'année) ────
      const empsRes = await rawPool.query<{
        id: string; first_name: string; last_name: string; job_title: string
        nni: string; cnps_number: string; hire_date: string; exit_date: string | null
        mobile_money_provider: string | null; mobile_money_phone: string | null
        contract_type: string; department_name: string
        net_payable: string | null; gross_salary: string | null; mois_ref: string | null
      }>(
        `SELECT e.id, e.first_name, e.last_name,
                COALESCE(e.job_title,'') AS job_title,
                COALESCE(e.nni,'') AS nni,
                COALESCE(e.cnps_number,'') AS cnps_number,
                e.hire_date::text, e.exit_date::text,
                e.mobile_money_provider, e.mobile_money_phone,
                COALESCE(e.contract_type,'cdi') AS contract_type,
                COALESCE(d.name,'') AS department_name,
                ps.net_payable::text, ps.gross_salary::text, ps.month AS mois_ref
         FROM "${schema}".employees e
         LEFT JOIN "${schema}".departments d ON d.id = e.department_id
         LEFT JOIN LATERAL (
           SELECT net_payable, gross_salary, month
           FROM "${schema}".pay_slips
           WHERE employee_id = e.id AND month = ANY($1::text[])
           ORDER BY month DESC LIMIT 1
         ) ps ON true
         WHERE e.is_active = true AND e.deleted_at IS NULL
         ORDER BY e.last_name, e.first_name`,
        [months]
      )
      const emps = empsRes.rows

      // ── 3. Anomalies salariés ─────────────────────────────────────────────
      if (checkCnps) {
        for (const e of emps) {
          if (!e.nni)         anomalies.push({ code: 'EMP_NO_NNI',  severity: 'bloquant', categorie: 'Immatriculation', message: 'NNI manquant',       employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}` })
          if (!e.cnps_number) anomalies.push({ code: 'EMP_NO_CNPS', severity: 'bloquant', categorie: 'Immatriculation', message: 'N° CNPS manquant',   employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}` })
        }
      }
      if (checkSmig) {
        for (const e of emps) {
          const net = parseInt(e.net_payable ?? '0')
          if (e.mois_ref && net > 0 && net < SMIG) {
            anomalies.push({ code: 'BELOW_SMIG', severity: 'bloquant', categorie: 'SMIG', message: `Net ${net.toLocaleString('fr-FR')} FCFA < SMIG (réf. ${e.mois_ref})`, employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}` })
          }
        }
      }
      if (checkMobile) {
        for (const e of emps) {
          if (!e.mobile_money_phone) anomalies.push({ code: 'NO_MOBILE', severity: 'avertissement', categorie: 'Paiement', message: 'Mobile Money non renseigné', employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}` })
        }
      }

      // ── 4. Déclarations trimestrielles ────────────────────────────────────
      const declRes = await rawPool.query<{
        quarter: number; status: string; total_cotisations: string; employees_count: number
      }>(
        `SELECT quarter, status,
                COALESCE(total_cotisations, 0)::text AS total_cotisations,
                COALESCE(employees_count, 0) AS employees_count
         FROM "${schema}".cnps_declarations WHERE year = $1 ORDER BY quarter`, [year]
      )
      const declMap = new Map(declRes.rows.map(d => [d.quarter, d]))

      if (checkDecl) {
        const currentYear = now.getFullYear()
        const currentQtr  = Math.ceil((now.getMonth() + 1) / 3)
        for (let qt = 1; qt <= 4; qt++) {
          let dm = qt * 3 + 1; let dy = year
          if (dm > 12) { dm = 1; dy++ }
          if (now > new Date(dy, dm - 1, 15) || year < currentYear || (year === currentYear && qt < currentQtr)) {
            const d = declMap.get(qt)
            if (!d)                    anomalies.push({ code: 'DECL_MISSING',       severity: 'bloquant', categorie: 'Déclarations', message: `T${qt}/${year} — déclaration manquante (pénalités possibles)` })
            else if (d.status === 'draft') anomalies.push({ code: 'DECL_DRAFT',     severity: 'bloquant', categorie: 'Déclarations', message: `T${qt}/${year} — en brouillon, non soumise sur e-CNPS` })
          }
        }
      }

      // ── 5. Stats cotisations de l'année ───────────────────────────────────
      const cotisRes = await rawPool.query<{
        masse: string; cnps_sal: string; cnps_pat: string
        its: string; net: string; nb: string
        nb_plaf_retraite: string; nb_plaf_atpf: string
      }>(
        `SELECT SUM(gross_salary)::text AS masse,
                SUM(total_cnps_sal)::text AS cnps_sal,
                SUM(total_cnps_pat)::text AS cnps_pat,
                SUM(its)::text AS its,
                SUM(net_payable)::text AS net,
                COUNT(*)::text AS nb,
                COUNT(*) FILTER (WHERE gross_salary > $1)::text AS nb_plaf_retraite,
                COUNT(*) FILTER (WHERE gross_salary > $2)::text AS nb_plaf_atpf
         FROM "${schema}".pay_slips WHERE month = ANY($3::text[])`,
        [PLAFOND_RETRAITE, PLAFOND_AT_PF, months]
      )
      const cotis = cotisRes.rows[0]

      // ── 6. Mensuel ────────────────────────────────────────────────────────
      const monthlyRes = await rawPool.query<{
        month: string; nb: string; masse: string; cnps_sal: string; cnps_pat: string; its: string; net: string
      }>(
        `SELECT month, COUNT(*)::text AS nb,
                SUM(gross_salary)::text AS masse,
                SUM(total_cnps_sal)::text AS cnps_sal,
                SUM(total_cnps_pat)::text AS cnps_pat,
                SUM(its)::text AS its,
                SUM(net_payable)::text AS net
         FROM "${schema}".pay_slips WHERE month = ANY($1::text[])
         GROUP BY month ORDER BY month`, [months]
      )

      // ── 7. Mobile Money répartition ───────────────────────────────────────
      const mobileRes = await rawPool.query<{ provider: string; cnt: string }>(
        `SELECT COALESCE(mobile_money_provider,'aucun') AS provider, COUNT(*)::text AS cnt
         FROM "${schema}".employees WHERE is_active = true AND deleted_at IS NULL
         GROUP BY mobile_money_provider ORDER BY COUNT(*) DESC`
      )

      // ── Calcul KPIs ───────────────────────────────────────────────────────
      const total       = emps.length
      const nbSansNni   = emps.filter(e => !e.nni).length
      const nbSansCnps  = emps.filter(e => !e.cnps_number).length
      const nbSousSmig  = emps.filter(e => { const n = parseInt(e.net_payable ?? '0'); return !!e.mois_ref && n > 0 && n < SMIG }).length
      const nbSansMob   = emps.filter(e => !e.mobile_money_phone).length

      const bloquants      = anomalies.filter(a => a.severity === 'bloquant').length
      const avertissements = anomalies.filter(a => a.severity === 'avertissement').length
      const score          = Math.max(0, 100 - bloquants * 15 - avertissements * 5)

      return reply.send({
        year, scoreConformite: score,
        statut: bloquants === 0 ? (avertissements === 0 ? 'conforme' : 'avertissements') : 'non_conforme',
        auditParams: { checkEmployeur, checkCnps, checkSmig, checkDecl, checkMobile, checkPlafonds },
        resume: {
          bloquants, avertissements, totalEmployes: total,
          nbSansNni, nbSansCnps, nbSousSmig, nbSansMobile: nbSansMob,
        },
        kpis: {
          tauxImmatriculation: total > 0 ? Math.round(((total - Math.max(nbSansNni, nbSansCnps)) / total) * 100) : 100,
          tauxSmig:            total > 0 ? Math.round(((total - nbSousSmig) / total) * 100) : 100,
          tauxMobile:          total > 0 ? Math.round(((total - nbSansMob) / total) * 100) : 100,
          declarationsSoumises: declRes.rows.filter(d => d.status === 'submitted').length,
          masseSalariale: parseInt(cotis?.masse ?? '0'),
          totalCnpsSal:   parseInt(cotis?.cnps_sal ?? '0'),
          totalCnpsPat:   parseInt(cotis?.cnps_pat ?? '0'),
          totalIts:       parseInt(cotis?.its ?? '0'),
          totalNet:       parseInt(cotis?.net ?? '0'),
          nbBulletins:    parseInt(cotis?.nb ?? '0'),
        },
        employeur: { cnpsOk: !!tenant?.cnps_number, dgiOk: !!tenant?.dgi_number, rccmOk: !!tenant?.rccm },
        employees: emps.map(e => ({
          id: e.id,
          nom: e.last_name, prenom: e.first_name,
          poste: e.job_title, departement: e.department_name,
          contractType: e.contract_type,
          nniOk: !!e.nni,   cnpsOk: !!e.cnps_number,
          smigOk: !e.mois_ref || parseInt(e.net_payable ?? '0') >= SMIG,
          mobileOk: !!e.mobile_money_phone,
          mobileProvider: e.mobile_money_provider ?? null,
          netPayable: e.net_payable ? parseInt(e.net_payable) : null,
          moisRef: e.mois_ref ?? null,
        })),
        declarations: [1, 2, 3, 4].map(qt => ({
          trimestre: qt, mois: [`${year}-${String((qt-1)*3+1).padStart(2,'0')}`, `${year}-${String((qt-1)*3+2).padStart(2,'0')}`, `${year}-${String(qt*3).padStart(2,'0')}`],
          status: declMap.get(qt)?.status ?? 'missing',
          totalCotisations: declMap.get(qt) ? parseInt(declMap.get(qt)!.total_cotisations) : 0,
          employeesCount: declMap.get(qt)?.employees_count ?? 0,
        })),
        mensuel: monthlyRes.rows.map(r => ({
          mois: r.month, nb: parseInt(r.nb),
          masse: parseInt(r.masse ?? '0'), cnpsSal: parseInt(r.cnps_sal ?? '0'),
          cnpsPat: parseInt(r.cnps_pat ?? '0'), its: parseInt(r.its ?? '0'), net: parseInt(r.net ?? '0'),
        })),
        mobileMoney: mobileRes.rows.map(r => ({ provider: r.provider, count: parseInt(r.cnt) })),
        plafonds: {
          plafondRetraite: PLAFOND_RETRAITE, plafondAtPf: PLAFOND_AT_PF,
          nbAuDessusRetraite: parseInt(cotis?.nb_plaf_retraite ?? '0'),
          nbAuDessusAtPf:     parseInt(cotis?.nb_plaf_atpf ?? '0'),
        },
        smigReference: SMIG, currency: 'XOF',
        anomalies,
        recommandations: bloquants > 0 ? [
          'Immatriculer les salariés sans NNI/CNPS — obligation légale sous peine de sanctions',
          `Régulariser les salaires inférieurs au SMIG (${SMIG.toLocaleString('fr-FR')} FCFA)`,
          'Soumettre les déclarations CNPS en retard sur e-CNPS (art. L.23 Code CNPS CI)',
        ] : avertissements > 0 ? [
          'Renseigner le N° DGI et le RCCM dans les paramètres entreprise',
          'Compléter les numéros Mobile Money pour fluidifier le paiement des salaires',
        ] : ['Dossier social conforme — aucune action requise'],
        generatedAt: new Date().toISOString(),
      })
    },
  })
}

export default cnpsRoutes
