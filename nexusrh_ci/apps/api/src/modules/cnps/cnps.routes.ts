import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { encodeField } from '../sage/sage.service.js'
import { auditTenant } from '../../utils/audit-log.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { loadEmployeeTenantContext } from '../../services/employee-tenant-context.service.js'
import {
  categoryLevel, completedSeniorityMonths, effectiveTerminationRules, resolveNotice, severanceAmount,
} from '../../services/termination-rules.service.js'
import { resolvePayrollContext } from '../../services/payroll-context-resolver.js'
import { currencyLabel, type LegislationPack } from '../../services/legislation-packs.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// ── Périmètre CNPS Côte d'Ivoire ─────────────────────────────────────────────
// Les déclarations sociales (pré-DSN, e-CNPS, DISA, RNS) ne couvrent QUE la
// CNPS ivoirienne. En multi-filiales, une filiale d'un autre pays (BFA, BEN…)
// relève de sa propre caisse (CNSS) et ne doit jamais être déclarée ici.
interface CnpsEntityRow {
  id: string
  name?: string | null
  cnps_number?: string | null
  dgi_number?: string | null
  rccm?: string | null
  city?: string | null
  address?: string | null
  country_code?: string | null
  legislation_pack_code?: string | null
  at_rate?: string | null
}

/** Pack législatif explicite (CIV-*) prioritaire, sinon pays (défaut CIV). */
function isCivEntity(le: Pick<CnpsEntityRow, 'country_code' | 'legislation_pack_code'>): boolean {
  const pack = le.legislation_pack_code?.trim()
  if (pack) return pack.toUpperCase().startsWith('CIV-')
  return (le.country_code?.trim() || 'CIV').toUpperCase() === 'CIV'
}

/** Même règle qu'isCivEntity, en SQL, pour l'alias d'une ligne legal_entities. */
function civEntitySql(alias: 'le' | 'pse'): string {
  return `(CASE WHEN NULLIF(TRIM(${alias}.legislation_pack_code), '') IS NOT NULL
                THEN UPPER(${alias}.legislation_pack_code) LIKE 'CIV-%'
                ELSE UPPER(COALESCE(NULLIF(TRIM(${alias}.country_code), ''), 'CIV')) = 'CIV' END)`
}

/** Bulletin rattaché à aucune filiale (tenant mono-entité CI) ou à une filiale CI. */
const CIV_PAYSLIP_SQL = `(ps.legal_entity_id IS NULL OR EXISTS (
  SELECT 1 FROM "__SCHEMA__".legal_entities pse
   WHERE pse.id = ps.legal_entity_id AND ${civEntitySql('pse')}))`
function civPayslipFilter(schema: string): string {
  return CIV_PAYSLIP_SQL.replace('__SCHEMA__', schema)
}

function nonCivError(name: string | null | undefined): string {
  return `La filiale « ${name ?? ''} » ne relève pas de la CNPS Côte d'Ivoire — déclaration non prise en charge pour ce pays`
}

/**
 * Périmètre filiale d'un artefact CNPS déjà produit (liste/export DISA, NEVA) :
 *  - multi-filiales : filiale obligatoire (un n° CNPS employeur = un artefact) ;
 *  - filiale inconnue → 404 ; filiale hors CI → 400 (même règle qu'isCivEntity).
 * Pas de filtre is_active : un artefact historique d'une filiale fermée reste lisible.
 */
async function loadCnpsEntityScope(
  schema: string, legalEntityId: string | null, hasSubs: boolean, reason: string,
): Promise<{ entity: CnpsEntityRow | null } | { status: 400 | 404; error: string }> {
  if (hasSubs && !legalEntityId) {
    return { status: 400, error: `Ce tenant a plusieurs filiales — legalEntityId requis (${reason})` }
  }
  if (!legalEntityId) return { entity: null }
  const le = await rawPool.query<CnpsEntityRow>(
    `SELECT ${ENTITY_COLUMNS} FROM "${schema}".legal_entities WHERE id = $1 LIMIT 1`, [legalEntityId],
  ).catch(() => ({ rows: [] as CnpsEntityRow[] }))
  const entity = le.rows[0]
  if (!entity) return { status: 404, error: 'Filiale introuvable' }
  if (!isCivEntity(entity)) return { status: 400, error: nonCivError(entity.name) }
  return { entity }
}

// Séparateur de milliers = espace simple (pas l'espace fine de toLocaleString).
const fmtAmount = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

const ENTITY_COLUMNS = `id, name, cnps_number, dgi_number, rccm, city, address,
                        country_code, legislation_pack_code, at_rate::text AS at_rate`
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
  // CNP-001 — période : trimestrielle (quarter) OU MENSUELLE (month, e-CNPS légal
  // = dépôt avant le 15 du mois M+1). Exactement l'un des deux.
  quarter:       z.number().int().min(1).max(4).optional(),
  month:         z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format AAAA-MM attendu').optional(),
  // Palier 3 multi-filiales : si tenant.has_subsidiaries=true, REQUIS pour
  // scoper la déclaration à une filiale (chaque numéro CNPS est distinct).
  legalEntityId: z.string().regex(UUID_RE, 'UUID requis').optional(),
}).strict().refine((d) => (d.quarter != null) !== (d.month != null), {
  message: 'Fournir soit "quarter" (trimestriel) soit "month" (mensuel), pas les deux ni aucun',
  path: ['month'],
})

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
  auditTenant(schema, { userId: userId, action: action, entity: 'cnps', entityId: entityId, changes: changes, ip: ip })
}

// OWASP A07 — rate-limit anti-DoS sur les exports lourds (PDF/XML/CSV générés
// à la volée, agrégations multi-mois). Cap : 10 req/min/IP.
const HEAVY_EXPORT_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } }

// OWASP A04 — cap anti-fraude sur les exports DISA agrégés annuels.
// Une PME ivoirienne classique a < 500 employés ; un export > 2000 lignes
// indique soit un tenant entreprise (à traiter par batch), soit un abus.
const DISA_MAX_EMPLOYEES = 2_000

const cnpsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // GET /cnps/declarations — liste des déclarations CNPS
  fastify.get('/declarations', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['cnps'], summary: 'Liste des déclarations CNPS' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { year, status, legalEntityId } = request.query as Record<string, string | undefined>

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
      if (legalEntityId !== undefined && legalEntityId !== '' && !UUID_RE.test(legalEntityId)) {
        return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })
      }

      let sql = `SELECT * FROM "${schema}".cnps_declarations WHERE quarter IS NOT NULL`
      const params: unknown[] = []
      let idx = 1

      if (yearParsed !== null) { sql += ` AND year = $${idx++}`; params.push(yearParsed) }
      if (status) { sql += ` AND status = $${idx++}`; params.push(status) }
      // Multi-filiales : n'afficher que les déclarations de la filiale choisie
      // (chaque n° CNPS employeur a ses propres déclarations).
      if (legalEntityId) { sql += ` AND legal_entity_id = $${idx++}`; params.push(legalEntityId) }
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
      const { year, month, legalEntityId } = parsed.data
      const isMonthly = month != null
      // En mensuel, le trimestre est dérivé du mois (pour la cohérence d'affichage).
      const quarter = isMonthly ? Math.ceil(parseInt(month!.slice(5, 7), 10) / 3) : parsed.data.quarter!
      const periodType = isMonthly ? 'monthly' : 'quarterly'
      const periodMonth = isMonthly ? month! : null
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
        const le = await rawPool.query<CnpsEntityRow>(
          `SELECT ${ENTITY_COLUMNS} FROM "${schema}".legal_entities WHERE id = $1 AND is_active = true LIMIT 1`,
          [legalEntityId],
        ).catch(() => ({ rows: [] as CnpsEntityRow[] }))
        const entity = le.rows[0]
        if (!entity) return reply.status(404).send({ error: 'Filiale introuvable ou inactive' })
        if (!isCivEntity(entity)) return reply.status(400).send({ error: nonCivError(entity.name) })
      }

      // Mois couverts : le mois seul (mensuel) ou les 3 mois du trimestre
      const months: string[] = []
      if (isMonthly) {
        months.push(month!)
      } else {
        for (let m = (quarter - 1) * 3 + 1; m <= quarter * 3; m++) {
          months.push(`${year}-${String(m).padStart(2, '0')}`)
        }
      }

      // Vérifier si déclaration déjà existante (même période + CE legalEntityId)
      const existing = await rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".cnps_declarations
         WHERE year = $1 AND quarter = $2 AND (period_month IS NOT DISTINCT FROM $3)
           AND (legal_entity_id IS NOT DISTINCT FROM $4)
         LIMIT 1`,
        [year, quarter, periodMonth, legalEntityId ?? null],
      ).catch(async () => rawPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM "${schema}".cnps_declarations
         WHERE year = $1 AND quarter = $2 AND (period_month IS NOT DISTINCT FROM $3) LIMIT 1`,
        [year, quarter, periodMonth],
      ))
      if (existing.rows[0]?.status === 'submitted') {
        return reply.status(422).send({ error: `Déclaration déjà soumise pour cette période (${isMonthly ? month : 'T' + quarter}) / cette filiale` })
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
               months = $7, period_type = $8, period_month = $9, status = 'draft', updated_at = now()
           WHERE id = $10`,
          [
            totalSalarial, totalPatronal, totalCotisations, totalMasseSalariale,
            employees.length, JSON.stringify(employees), JSON.stringify(months),
            periodType, periodMonth, existing.rows[0].id,
          ]
        )
        declarationId = existing.rows[0].id
      } else {
        const insRes = await rawPool.query<{ id: string }>(
          `INSERT INTO "${schema}".cnps_declarations
             (year, quarter, period_type, period_month, months,
              total_cotisations_salariales, total_cotisations_patronales,
              total_cotisations, masse_salariale, employees_count, data, status,
              legal_entity_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12)
           RETURNING id`,
          [
            year, quarter, periodType, periodMonth, JSON.stringify(months),
            totalSalarial, totalPatronal,
            totalCotisations, totalMasseSalariale,
            employees.length, JSON.stringify(employees),
            legalEntityId ?? null,
          ]
        ).catch(async () => rawPool.query<{ id: string }>(
          `INSERT INTO "${schema}".cnps_declarations
             (year, quarter, period_type, period_month, months,
              total_cotisations_salariales, total_cotisations_patronales,
              total_cotisations, masse_salariale, employees_count, data, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft')
           RETURNING id`,
          [
            year, quarter, periodType, periodMonth, JSON.stringify(months),
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
        year: number; quarter: number; period_month: string | null; data: unknown
        total_cotisations: string; employees_count: number
      }>(
        `SELECT year, quarter, period_month, data,
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
      const filename = decl.period_month
        ? `CNPS_${String(decl.period_month).replace('-', '_')}.csv`   // mensuel : CNPS_2025_05.csv
        : `CNPS_${decl.year}_T${decl.quarter}.csv`                     // trimestriel

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
      const { legalEntityId } = request.query as { legalEntityId?: string }
      if (legalEntityId && !UUID_RE.test(legalEntityId)) {
        return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })
      }
      try {
        // Multi-filiales : une DISA par filiale (n° CNPS distinct) → filiale requise.
        const tenantRes = await rawPool.query<{ has_subsidiaries: boolean | null }>(
          `SELECT has_subsidiaries FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
        )
        const scope = await loadCnpsEntityScope(
          schema, legalEntityId ?? null, tenantRes.rows[0]?.has_subsidiaries === true, 'DISA distincte par numéro CNPS',
        )
        if ('error' in scope) return reply.status(scope.status).send({ error: scope.error })
        const res = scope.entity
          ? await rawPool.query(
              `SELECT * FROM "${schema}".disa_records WHERE legal_entity_id = $1 ORDER BY year DESC`, [scope.entity.id],
            )
          : await rawPool.query(`SELECT * FROM "${schema}".disa_records ORDER BY year DESC`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error({ err: (err as Error).message }, '[cnps] DISA list failed')
        return reply.status(500).send({ error: 'Erreur lors de la lecture des DISA' })
      }
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
        const le = await rawPool.query<CnpsEntityRow>(
          `SELECT ${ENTITY_COLUMNS} FROM "${schema}".legal_entities WHERE id = $1 AND is_active = true LIMIT 1`,
          [legalEntityId],
        ).catch(() => ({ rows: [] as CnpsEntityRow[] }))
        const entity = le.rows[0]
        if (!entity) return reply.status(404).send({ error: 'Filiale introuvable ou inactive' })
        if (!isCivEntity(entity)) return reply.status(400).send({ error: nonCivError(entity.name) })
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

      // Insérer/mettre à jour un enregistrement DISA agrégé par (année, filiale).
      // Clé d'unicité = index unique (year, legal_entity_id) NULLS NOT DISTINCT
      // (NULL = tenant mono-entité) : la DISA d'une filiale n'écrase plus celle
      // d'une autre filiale de la même année.
      try {
        await rawPool.query(
          `INSERT INTO "${schema}".disa_records
             (year, employees_count, masse_salariale, total_cnps, total_its, data, status, legal_entity_id)
           VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
           ON CONFLICT (year, legal_entity_id) DO UPDATE SET
             employees_count = EXCLUDED.employees_count,
             masse_salariale  = EXCLUDED.masse_salariale,
             total_cnps       = EXCLUDED.total_cnps,
             total_its        = EXCLUDED.total_its,
             data             = EXCLUDED.data,
             status           = 'draft',
             updated_at       = now()`,
          [year, employees.length, masseSalariale, totalCnps, totalIts, JSON.stringify(employees), legalEntityId ?? null]
        )
      } catch (err) {
        // Schéma pas encore migré (ancienne contrainte UNIQUE(year)). Le repli
        // ON CONFLICT (year) n'est sûr que pour un tenant mono-entité : en
        // multi-filiales il écraserait la DISA d'une autre filiale → refus.
        if (legalEntityId) {
          fastify.log.error({ err: (err as Error).message }, '[cnps] DISA upsert per legal entity failed')
          return reply.status(500).send({ error: 'Enregistrement de la DISA impossible (schéma non migré) — réessayez dans un instant' })
        }
        try {
          await rawPool.query(
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
          )
        } catch (fallbackErr) {
          fastify.log.error({ err: (fallbackErr as Error).message }, '[cnps] DISA upsert failed')
          return reply.status(500).send({ error: 'Enregistrement de la DISA impossible' })
        }
      }

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
          legalEntityId: legalEntityId ?? null,
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
      const { legalEntityId } = request.query as { legalEntityId?: string }
      if (legalEntityId && !UUID_RE.test(legalEntityId)) {
        return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })
      }
      const schema = request.user.schemaName

      let d: {
        year: number; quarter: number; data: unknown; legal_entity_id?: string | null
        total_cotisations_salariales: string; total_cotisations_patronales: string
        total_cotisations: string; masse_salariale: string; employees_count: number
      }
      // Identité employeur de l'en-tête NEVA : filiale (multi-filiales) sinon tenant.
      let employer: { name: string; cnpsNumber: string }
      let entity: CnpsEntityRow | null = null
      try {
        const decl = await rawPool.query<typeof d>(
          `SELECT year, quarter, data, total_cotisations_salariales, total_cotisations_patronales,
                  total_cotisations, masse_salariale, employees_count, legal_entity_id
           FROM "${schema}".cnps_declarations WHERE id = $1 LIMIT 1`, [id]
        )
        if (!decl.rows[0]) return reply.status(404).send({ error: 'Déclaration introuvable' })
        d = decl.rows[0]

        const tenantRes = await rawPool.query<{
          name: string; cnps_number: string; slug: string; has_subsidiaries?: boolean | null
        }>(
          `SELECT name, cnps_number, slug, has_subsidiaries FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
        )
        const tenant = tenantRes.rows[0]

        // Multi-filiales : chaque n° CNPS employeur a son propre fichier NEVA.
        const scope = await loadCnpsEntityScope(
          schema, legalEntityId ?? null, tenant?.has_subsidiaries === true, 'chaque numéro CNPS a sa propre déclaration NEVA',
        )
        if ('error' in scope) return reply.status(scope.status).send({ error: scope.error })
        entity = scope.entity
        // La déclaration doit avoir été générée pour CETTE filiale (ses bulletins
        // seuls) : sinon l'en-tête porterait un n° CNPS étranger aux salariés listés.
        if (entity && (d.legal_entity_id ?? null) !== entity.id) {
          return reply.status(409).send({
            error: `Cette déclaration n'a pas été générée pour la filiale « ${entity.name ?? ''} » — générez la déclaration de cette filiale`,
          })
        }
        employer = entity
          ? { name: entity.name ?? tenant?.name ?? '', cnpsNumber: entity.cnps_number ?? '' }
          : { name: tenant?.name ?? '', cnpsNumber: tenant?.cnps_number ?? '' }
      } catch (err) {
        fastify.log.error({ err: (err as Error).message }, '[cnps] NEVA export failed')
        return reply.status(500).send({ error: "Échec de l'export NEVA" })
      }

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
      <RAISON_SOCIALE>${esc(employer.name)}</RAISON_SOCIALE>
      <N_CNPS_EMPLOYEUR>${esc(employer.cnpsNumber)}</N_CNPS_EMPLOYEUR>
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
        { year: d.year, quarter: d.quarter, legalEntityId: entity?.id ?? null, employeesCount: d.employees_count, format: 'xml/neva' },
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
        hire_date: string; base_salary: string; legal_entity_id: string | null
        professional_category: string | null
      }>(
        `SELECT id, first_name, last_name, cnps_number, nni, hire_date, base_salary,
                legal_entity_id, professional_category
         FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId]
      )
      const emp = empRes.rows[0]
      if (!emp) return reply.status(404).send({ error: 'Employé introuvable' })

      // Mois complets, jour de sortie inclus (même règle que le solde de tout compte).
      const ancienneteMois = emp.hire_date ? completedSeniorityMonths(emp.hire_date, exitDate) : 0
      const ancienneteAns  = ancienneteMois / 12

      // Droits légaux : mêmes règles que le solde de tout compte (convention
      // du tenant > pack du pays de l'employé), selon ancienneté et catégorie.
      const ctx = await loadEmployeeTenantContext(rawPool, schema, emp.legal_entity_id)
      const pack = ctx.legislation.legislationPack
      const { rules } = effectiveTerminationRules(ctx.tenantTerminationRules, pack)
      const notice = resolveNotice(rules, {
        seniorityMonths: ancienneteMois,
        categoryLevel: categoryLevel(emp.professional_category),
        payBasis: 'monthly',
      })
      const preavisMois  = notice ? Math.round(notice.months * 100) / 100 : null
      const preavisJours = notice ? Math.round(notice.months * 30) : null

      // Indemnité (licenciement / départ à la retraite) sur le salaire de base :
      // estimation — le solde de tout compte retient la moyenne des 12 derniers mois.
      const baseSalary = parseInt(emp.base_salary ?? '0')
      let indemnite = 0
      if (rules && (reason === 'dismissal' || reason === 'retirement')
        && ancienneteMois >= (rules.severanceMinSeniorityMonths ?? 12)) {
        indemnite = severanceAmount(ancienneteMois, baseSalary, rules)
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
          preavisMois,
          preavisCategorie: notice?.category?.label ?? null,
          indemniteLicenciement: indemnite,
          currency: pack.currency,
          reference: pack.code === 'CIV-2024'
            ? 'Code du travail CI art. 18.4 et 18.16 ; décrets 96-200 et 2017-210'
            : `Pack législatif ${pack.code}`,
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
      const { year: yearRaw, legalEntityId } = request.query as Record<string, string | undefined>
      // OWASP A03 — validation stricte (regex + plage) au lieu de parseInt brut
      const yearNum = parseYearParam(yearRaw)
      if (yearNum === null) return reply.status(400).send({ error: 'year hors plage' })
      if (legalEntityId !== undefined && legalEntityId !== '' && !UUID_RE.test(legalEntityId)) {
        return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })
      }
      const year = String(yearNum)
      const schema = request.user.schemaName

      // Périmètre CNPS CI : seuls les bulletins sans filiale (tenant mono-entité)
      // ou d'une filiale ivoirienne entrent dans les tuiles — les CNSS
      // étrangères (Burkina, Bénin…) en sont exclues. Filtrable par filiale.
      const params: unknown[] = [`${year}-%`]
      let entityFilter = ''
      if (legalEntityId) {
        params.push(legalEntityId)
        entityFilter = ` AND ps.legal_entity_id = $${params.length}`
      }
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
           AND ${civPayslipFilter(schema)}${entityFilter}
         GROUP BY ps.month
         ORDER BY ps.month`,
        params,
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
      const { month, legalEntityId } = request.query as { month?: string; legalEntityId?: string }
      const schema = request.user.schemaName

      // OWASP A03 — validation stricte (regex + plage)
      const yr  = parseYearParam(year)
      const qtrParam = parseInt(quarter)
      if (yr === null || !qtrParam || qtrParam < 1 || qtrParam > 4) {
        return reply.status(400).send({ error: 'year et quarter (1-4) requis' })
      }
      // Périodicité mensuelle (e-CNPS) : ?month=YYYY-MM prioritaire sur le trimestre.
      const monthParam = month !== undefined && month !== '' ? month : null
      if (monthParam !== null && (!MONTH_RE.test(monthParam) || monthParam.slice(0, 4) !== String(yr))) {
        return reply.status(400).send({ error: `month invalide (format AAAA-MM, année ${yr} attendue)` })
      }
      const entityParam = legalEntityId !== undefined && legalEntityId !== '' ? legalEntityId : null
      if (entityParam !== null && !UUID_RE.test(entityParam)) {
        return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })
      }
      const isMonthly = monthParam !== null
      const qtr = isMonthly ? Math.ceil(parseInt(monthParam.slice(5, 7), 10) / 3) : qtrParam
      const periodLabel = isMonthly ? monthParam : `${yr} T${qtr}`

      const months: string[] = []
      if (isMonthly) {
        months.push(monthParam)
      } else {
        for (let m = (qtr - 1) * 3 + 1; m <= qtr * 3; m++) {
          months.push(`${yr}-${String(m).padStart(2, '0')}`)
        }
      }

      const errors:   Array<{ code: string; severity: 'blocking' | 'warning'; message: string; employeeId?: string; employeeName?: string }> = []
      const warnings: Array<{ code: string; message: string }> = []

      // 1. Tenant + périmètre filiale
      const tenantRes = await rawPool.query<{
        cnps_number: string | null; name: string
        has_subsidiaries?: boolean | null; default_country_code?: string | null; at_rate?: string | null
      }>(
        `SELECT name, cnps_number, has_subsidiaries, default_country_code, at_rate::text AS at_rate
         FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenant = tenantRes.rows[0]
      const hasSubs = tenant?.has_subsidiaries === true
      // Comme pour la génération : chaque filiale a son propre n° CNPS employeur.
      if (hasSubs && !entityParam) {
        return reply.status(400).send({
          error: 'Ce tenant a plusieurs filiales — choisissez la filiale à valider (chaque numéro CNPS a sa propre déclaration)',
        })
      }
      let entity: CnpsEntityRow | null = null
      if (entityParam) {
        const le = await rawPool.query<CnpsEntityRow>(
          `SELECT ${ENTITY_COLUMNS} FROM "${schema}".legal_entities WHERE id = $1 AND is_active = true LIMIT 1`,
          [entityParam],
        ).catch(() => ({ rows: [] as CnpsEntityRow[] }))
        entity = le.rows[0] ?? null
        if (!entity) return reply.status(404).send({ error: 'Filiale introuvable ou inactive' })
        if (!isCivEntity(entity)) return reply.status(400).send({ error: nonCivError(entity.name) })
      }

      // SMIG du pack applicable (filiale, sinon pays du tenant) — pas de 75 000 en dur.
      const pack = resolvePayrollContext({
        tenant: {
          id: '', hasSubsidiaries: hasSubs,
          atRate: parseFloat(tenant?.at_rate ?? '0.020'),
          defaultCountryCode: tenant?.default_country_code ?? null,
        },
        employee: { id: '', legalEntityId: entity?.id ?? null },
        legalEntity: entity ? {
          id: entity.id,
          atRate: entity.at_rate ? parseFloat(entity.at_rate) : null,
          legislationPackCode: entity.legislation_pack_code ?? null,
          countryCode: entity.country_code ?? null,
        } : null,
      }).legislationPack

      // 2. Numéro CNPS employeur : celui de la filiale en multi-filiales
      const employerCnps = entity ? (entity.cnps_number?.trim() || null) : (tenant?.cnps_number?.trim() || null)
      if (!employerCnps) {
        errors.push(entity
          ? { code: 'CNPS_EMPLOYER_MISSING', severity: 'blocking', message: `Numéro CNPS employeur de la filiale « ${entity.name ?? ''} » manquant — à renseigner dans Paramètres → Entités juridiques` }
          : { code: 'CNPS_EMPLOYER_MISSING', severity: 'blocking', message: 'Numéro CNPS employeur manquant — à renseigner dans Paramètres → Entreprise' })
      }

      // Filtre bulletins : filiale choisie, sinon périmètre CI (tenant mono-entité)
      const slipParams: unknown[] = [months]
      let slipFilter: string
      if (entity) {
        slipParams.push(entity.id)
        slipFilter = ` AND ps.legal_entity_id = $2`
      } else {
        slipFilter = ` AND ${civPayslipFilter(schema)}`
      }

      // 3. Vérifier bulletins de la période existent
      const slipCountRes = await rawPool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM "${schema}".pay_slips ps WHERE ps.month = ANY($1::text[])${slipFilter}`, slipParams
      )
      const slipCount = parseInt(slipCountRes.rows[0]?.cnt ?? '0')
      if (slipCount === 0) {
        errors.push({ code: 'NO_PAYSLIPS', severity: 'blocking', message: `Aucun bulletin de paie trouvé pour ${periodLabel}${entity ? ` (filiale « ${entity.name ?? ''} »)` : ''} — clôturez d'abord la paie` })
      }

      // 4. Employés sans numéro CNPS avec bulletins sur la période
      const noCnpsRes = await rawPool.query<{ id: string; first_name: string; last_name: string }>(
        `SELECT DISTINCT e.id, e.first_name, e.last_name
         FROM "${schema}".employees e
         JOIN "${schema}".pay_slips ps ON ps.employee_id = e.id
         WHERE ps.month = ANY($1::text[])${slipFilter}
           AND (e.cnps_number IS NULL OR e.cnps_number = '')
           AND e.is_active = true`, slipParams
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

      // 5. Employés sans NNI (matricule salarié)
      const noNniRes = await rawPool.query<{ id: string; first_name: string; last_name: string }>(
        `SELECT DISTINCT e.id, e.first_name, e.last_name
         FROM "${schema}".employees e
         JOIN "${schema}".pay_slips ps ON ps.employee_id = e.id
         WHERE ps.month = ANY($1::text[])${slipFilter}
           AND (e.nni IS NULL OR e.nni = '')
           AND e.is_active = true`, slipParams
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

      // 6. Salaire de base inférieur au SMIG du pack. Le SMIG est un minimum
      // de salaire de base à temps plein : on ramène le base d'un temps partiel
      // à 40 h/semaine (durée légale) avant comparaison — jamais le net, qui
      // dépend des retenues et des absences.
      const smig = pack.smigMensuel
      const smigLabel = `${fmtAmount(smig)} ${currencyLabel(pack.currency)}`
      const smigParams: unknown[] = [...slipParams, smig]
      const belowSmigRes = await rawPool.query<{
        id: string; first_name: string; last_name: string; month: string
        base: string; full_time_base: string; weekly_hours: string | null
      }>(
        `SELECT e.id, e.first_name, e.last_name, ps.month,
                ps.base_salary::text AS base,
                ROUND(ps.base_salary * 40.0 / LEAST(GREATEST(COALESCE(e.weekly_hours, 40), 1), 40))::text AS full_time_base,
                e.weekly_hours::text AS weekly_hours
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         WHERE ps.month = ANY($1::text[])${slipFilter}
           AND COALESCE(ps.base_salary, 0) > 0
           AND ps.base_salary * 40.0 / LEAST(GREATEST(COALESCE(e.weekly_hours, 40), 1), 40) < $${smigParams.length}
         ORDER BY e.last_name, e.first_name, ps.month`, smigParams
      )
      for (const emp of belowSmigRes.rows) {
        const base = parseInt(emp.base ?? '0')
        const fullTime = parseInt(emp.full_time_base ?? emp.base ?? '0')
        const partTime = fullTime !== base
        warnings.push({
          code: 'BELOW_SMIG',
          message: `${emp.first_name} ${emp.last_name} (${emp.month}) — salaire de base ${fmtAmount(base)} ${currencyLabel(pack.currency)}`
            + (partTime ? ` (soit ${fmtAmount(fullTime)} à temps plein)` : '')
            + ` < SMIG ${smigLabel} (pack ${pack.code})`,
        })
      }

      // 7. Vérifier délai de dépôt (avant le 15 du mois M+1)
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
        periodType: isMonthly ? 'monthly' : 'quarterly',
        month: monthParam,
        legalEntityId: entity?.id ?? null,
        legalEntityName: entity?.name ?? null,
        employerCnps,
        smigReference: smig,
        legislationPackCode: pack.code,
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
      const { employeeId, legalEntityId } = request.query as { employeeId?: string; legalEntityId?: string }
      const schema = request.user.schemaName
      // OWASP A03 — validation stricte year + UUID employeeId si fourni
      const yr = parseYearParam(year)
      if (yr === null) return reply.status(400).send({ error: 'year hors plage' })
      if (employeeId && !UUID_RE.test(employeeId)) return reply.status(400).send({ error: 'employeeId invalide (UUID requis)' })
      if (legalEntityId && !UUID_RE.test(legalEntityId)) return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })

      // Filiale optionnelle : RNS d'un seul n° CNPS employeur (filiale CI uniquement)
      let entity: CnpsEntityRow | null = null
      if (legalEntityId) {
        const le = await rawPool.query<CnpsEntityRow>(
          `SELECT ${ENTITY_COLUMNS} FROM "${schema}".legal_entities WHERE id = $1 LIMIT 1`, [legalEntityId],
        ).catch(() => ({ rows: [] as CnpsEntityRow[] }))
        entity = le.rows[0] ?? null
        if (!entity) return reply.status(404).send({ error: 'Filiale introuvable' })
        if (!isCivEntity(entity)) return reply.status(400).send({ error: nonCivError(entity.name) })
      }

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
      // Bulletins retenus : ceux de la filiale demandée, sinon ceux du périmètre
      // CI (sans filiale ou filiale ivoirienne) — jamais une paie CNSS étrangère.
      let slipScope: string
      if (entity) {
        params.push(entity.id)
        slipScope = `ps.legal_entity_id = $${params.length}`
      } else {
        slipScope = civPayslipFilter(schema)
      }
      let empSql = `
        SELECT e.id, e.first_name, e.last_name,
               COALESCE(e.cnps_number,'') AS cnps_number,
               COALESCE(e.hire_date::text,'') AS hire_date,
               e.exit_date::text AS exit_date,
               COALESCE(SUM(ps.gross_salary)::int, 0) AS annual_salary,
               COALESCE(COUNT(ps.id)::int, 0) AS months_worked
        FROM "${schema}".employees e
        LEFT JOIN "${schema}".legal_entities le ON le.id = e.legal_entity_id
        LEFT JOIN "${schema}".pay_slips ps
               ON ps.employee_id = e.id AND ps.month = ANY($1::text[])
              AND ${slipScope}
        WHERE ((e.is_active = true AND e.deleted_at IS NULL
                AND COALESCE(e.base_salary, 0) > 0) -- fiche « à compléter » (salaire 0) : hors paie, hors RNS
               OR ps.id IS NOT NULL) -- sortis dans l'année inclus
          -- Le RNS est un document CNPS Côte d'Ivoire : il ne concerne QUE les
          -- salariés relevant de la réglementation ivoirienne. La maison mère est
          -- en CI mais peut avoir des filiales à l'étranger : on inclut donc les
          -- employés du tenant mono-pays (legal_entity_id NULL) ou rattachés à une
          -- entité juridique ivoirienne (pack CIV-* ou pays CIV), et on exclut les
          -- filiales étrangères (et leurs bulletins, cf. slipScope).
          AND ${entity ? `e.legal_entity_id = $${params.length}` : `(e.legal_entity_id IS NULL OR ${civEntitySql('le')})`}`
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
          // Filiale demandée : son identité et SON n° CNPS employeur.
          entity ? {
            name:            entity.name ?? tenant.name,
            address:         entity.address?.trim() || `${entity.city?.trim() || tenant.city}, Côte d'Ivoire`,
            cnpsNumber:      entity.cnps_number ?? '',
            affiliationDate: tenant.cnps_affiliation_date,
            city:            entity.city?.trim() || tenant.city,
          } : {
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
        { year: yr, employeeId: employeeId ?? null, legalEntityId: entity?.id ?? null, employeesCount: empsRes.rows.length, format: 'pdf' },
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
      const { legalEntityId } = request.query as { legalEntityId?: string }
      const schema = request.user.schemaName
      // OWASP A03 — validation stricte year
      const yr = parseYearParam(year)
      if (yr === null) return reply.status(400).send({ error: 'year hors plage' })
      if (legalEntityId && !UUID_RE.test(legalEntityId)) return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })

      // Filiale optionnelle (CI uniquement) : en-tête + bulletins de cette filiale
      let entity: CnpsEntityRow | null = null
      if (legalEntityId) {
        const le = await rawPool.query<CnpsEntityRow>(
          `SELECT ${ENTITY_COLUMNS} FROM "${schema}".legal_entities WHERE id = $1 LIMIT 1`, [legalEntityId],
        ).catch(() => ({ rows: [] as CnpsEntityRow[] }))
        entity = le.rows[0] ?? null
        if (!entity) return reply.status(404).send({ error: 'Filiale introuvable' })
        if (!isCivEntity(entity)) return reply.status(400).send({ error: nonCivError(entity.name) })
      }

      const tenantRes = await rawPool.query<{ name: string; cnps_number: string; rccm: string; dgi_number: string }>(
        `SELECT name, cnps_number, rccm, dgi_number FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
      )
      const tenantRow = tenantRes.rows[0]
      const tenant = entity ? {
        name: entity.name ?? tenantRow?.name ?? '',
        cnps_number: entity.cnps_number ?? '',
        rccm: entity.rccm ?? '',
        dgi_number: entity.dgi_number ?? '',
      } : tenantRow

      const months = Array.from({ length: 12 }, (_, i) => `${yr}-${String(i + 1).padStart(2, '0')}`)
      const rnsParams: unknown[] = [months]
      let rnsScope: string
      if (entity) {
        rnsParams.push(entity.id)
        rnsScope = `ps.legal_entity_id = $2`
      } else {
        // Périmètre CNPS CI : bulletins sans filiale ou d'une filiale ivoirienne.
        rnsScope = civPayslipFilter(schema)
      }

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
           AND ${rnsScope}
         GROUP BY e.id, e.first_name, e.last_name, e.cnps_number, e.nni, e.job_title
         ORDER BY e.last_name, e.first_name`,
        rnsParams,
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
      const { legalEntityId } = request.query as { legalEntityId?: string }
      if (legalEntityId && !UUID_RE.test(legalEntityId)) {
        return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })
      }

      let tenant: { name: string; cnps_number: string; dgi_number: string } | undefined
      let entity: CnpsEntityRow | null = null
      let disa: {
        data: unknown; year: number; employees_count: number
        masse_salariale: string; total_cnps: string; total_its: string
      }
      try {
        const tenantRes = await rawPool.query<{
          name: string; cnps_number: string; dgi_number: string; has_subsidiaries?: boolean | null
        }>(
          `SELECT name, cnps_number, dgi_number, has_subsidiaries FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
        )
        const tenantRow = tenantRes.rows[0]

        // Multi-filiales : la DISA est propre à chaque n° CNPS employeur.
        const scope = await loadCnpsEntityScope(
          schema, legalEntityId ?? null, tenantRow?.has_subsidiaries === true, 'DISA distincte par numéro CNPS',
        )
        if ('error' in scope) return reply.status(scope.status).send({ error: scope.error })
        entity = scope.entity
        tenant = entity
          ? { name: entity.name ?? tenantRow?.name ?? '', cnps_number: entity.cnps_number ?? '', dgi_number: entity.dgi_number ?? '' }
          : tenantRow

        // Filiale : SA ligne DISA. Mono-entité : la ligne de l'année (celle sans
        // filiale en priorité) — comportement inchangé.
        const disaRes = entity
          ? await rawPool.query<typeof disa>(
              `SELECT * FROM "${schema}".disa_records WHERE year = $1 AND legal_entity_id = $2 LIMIT 1`, [yr, entity.id],
            )
          : await rawPool.query<typeof disa>(
              `SELECT * FROM "${schema}".disa_records WHERE year = $1
                ORDER BY (legal_entity_id IS NULL) DESC LIMIT 1`, [yr],
            )
        if (!disaRes.rows[0]) {
          return reply.status(404).send({
            error: `DISA ${yr} non générée${entity ? ` pour la filiale « ${entity.name ?? ''} »` : ''} — exécutez d'abord POST /cnps/disa/generate`,
          })
        }
        disa = disaRes.rows[0]
      } catch (err) {
        fastify.log.error({ err: (err as Error).message }, '[cnps] DISA export failed')
        return reply.status(500).send({ error: "Échec de l'export DISA" })
      }
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
        { year: yr, legalEntityId: entity?.id ?? null, employeesCount: employees.length, format: 'csv' },
        request.ip ?? null,
      )

      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="DISA_${yr}.csv"`)
      return reply.send('﻿' + csv)
    },
  })

  // GET /cnps/audit-conformite — audit conformité sociale 360° (CNPS/DGI/ITS/SMIG)
  //
  // Multi-filiales : `?legalEntityId` restreint l'audit à une filiale (employés,
  // bulletins, déclarations, identité employeur). Sans filtre, l'audit couvre le
  // tenant avec une ventilation par filiale (`filiales`). Le SMIG est celui du
  // pack de chaque salarié (filiale, sinon pays du tenant) appliqué au salaire de
  // base ramené au temps plein (même règle que le validateur pré-DSN) ; les
  // contrôles propres à la CNPS (immatriculation, n° employeur, déclarations,
  // plafonds) ne visent que le périmètre ivoirien.
  fastify.get('/audit-conformite', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    // OWASP A07 — endpoint exécutant 7+ queries lourdes (agrégations multi-tables) :
    // même cap que les exports pour éviter la saturation DB.
    config: HEAVY_EXPORT_RATE_LIMIT,
    schema: { tags: ['cnps'], summary: 'Audit conformité sociale 360° — CNPS/DGI/SMIG/Plafonds/Déclarations' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const q      = request.query as Record<string, string | undefined>
      const now    = new Date()

      const year = parseInt(q.year ?? String(now.getFullYear()), 10)
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return reply.status(400).send({ error: 'year invalide (format YYYY)' })
      }
      const legalEntityId = q.legalEntityId ? q.legalEntityId : null
      if (legalEntityId !== null && !UUID_RE.test(legalEntityId)) {
        return reply.status(400).send({ error: 'legalEntityId invalide (UUID requis)' })
      }
      const checkEmployeur = q.checkEmployeur !== 'false'
      const checkCnps      = q.checkCnps      !== 'false'
      const checkSmig      = q.checkSmig      !== 'false'
      const checkDecl      = q.checkDecl      !== 'false'
      const checkMobile    = q.checkMobile    !== 'false'
      const checkPlafonds  = q.checkPlafonds  !== 'false'

      const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)

      try {
        // ── Données tenant ───────────────────────────────────────────────────
        const tenantRes = await rawPool.query<{
          name: string; cnps_number: string; dgi_number: string; rccm: string; at_rate: string
          has_subsidiaries?: boolean | null; default_country_code?: string | null
        }>(
          `SELECT name,
                  COALESCE(cnps_number,'') AS cnps_number,
                  COALESCE(dgi_number,'')  AS dgi_number,
                  COALESCE(rccm,'')        AS rccm,
                  COALESCE(at_rate,'0.020') AS at_rate,
                  has_subsidiaries, default_country_code
           FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]
        )
        const tenant = tenantRes.rows[0]
        const hasSubs = tenant?.has_subsidiaries === true

        // ── Filiales (multi-filiales ou filtre explicite) ─────────────────────
        type AuditEntityRow = CnpsEntityRow & { is_active?: boolean | null }
        let entities: AuditEntityRow[] = []
        if (hasSubs || legalEntityId) {
          const leRes = await rawPool.query<AuditEntityRow>(
            `SELECT ${ENTITY_COLUMNS}, is_active FROM "${schema}".legal_entities ORDER BY name`,
          ).catch(() => ({ rows: [] as AuditEntityRow[] }))
          entities = leRes.rows
        }
        const entityById = new Map(entities.map((le) => [le.id, le]))
        const entity = legalEntityId ? entityById.get(legalEntityId) ?? null : null
        if (legalEntityId && !entity) return reply.status(404).send({ error: 'Filiale introuvable' })
        // Ventilation par filiale : vue tenant d'un multi-filiales.
        const breakdown = hasSubs && !entity && entities.length > 0

        // Pack législatif d'un salarié / d'une filiale : mêmes règles que la paie.
        const tenantInfo = {
          id: '', hasSubsidiaries: hasSubs,
          atRate: parseFloat(tenant?.at_rate ?? '0.020'),
          defaultCountryCode: tenant?.default_country_code ?? null,
        }
        const packCache = new Map<string, LegislationPack>()
        const packFor = (leId: string | null): LegislationPack => {
          const key = leId ?? ''
          const cached = packCache.get(key)
          if (cached) return cached
          const le = leId ? entityById.get(leId) ?? null : null
          const pack = resolvePayrollContext({
            tenant: tenantInfo,
            employee: { id: '', legalEntityId: leId },
            legalEntity: le ? {
              id: le.id,
              atRate: le.at_rate ? parseFloat(le.at_rate) : null,
              legislationPackCode: le.legislation_pack_code ?? null,
              countryCode: le.country_code ?? null,
            } : null,
          }).legislationPack
          packCache.set(key, pack)
          return pack
        }
        // Périmètre CNPS CI : filiale ivoirienne, sinon pays du tenant (mono-entité).
        const isCivFor = (leId: string | null): boolean => {
          const le = leId ? entityById.get(leId) : undefined
          return le ? isCivEntity(le) : packFor(null).code.toUpperCase().startsWith('CIV-')
        }
        const scopePack = packFor(entity?.id ?? null)
        const scopeCiv  = isCivFor(entity?.id ?? null)
        const entityName = (leId: string | null): string | null => (leId ? entityById.get(leId)?.name ?? null : null)

        // Filtres SQL du périmètre : filiale choisie, sinon (multi-filiales) le
        // périmètre CNPS CI pour les agrégats de cotisations.
        const entityParam = entity ? [entity.id] : []

        // ── 2. Employés (requête unique avec dernier bulletin de l'année) ────
        const empsRes = await rawPool.query<{
          id: string; first_name: string; last_name: string; job_title: string
          nni: string; cnps_number: string; hire_date: string; exit_date: string | null
          mobile_money_provider: string | null; mobile_money_phone: string | null
          contract_type: string; department_name: string
          legal_entity_id?: string | null; weekly_hours?: string | null
          net_payable: string | null; gross_salary: string | null; base_salary?: string | null
          mois_ref: string | null
        }>(
          `SELECT e.id, e.first_name, e.last_name,
                  COALESCE(e.job_title,'') AS job_title,
                  COALESCE(e.nni,'') AS nni,
                  COALESCE(e.cnps_number,'') AS cnps_number,
                  e.hire_date::text, e.exit_date::text,
                  e.mobile_money_provider, e.mobile_money_phone,
                  COALESCE(e.contract_type,'cdi') AS contract_type,
                  COALESCE(d.name,'') AS department_name,
                  e.legal_entity_id, e.weekly_hours::text AS weekly_hours,
                  ps.net_payable::text, ps.gross_salary::text,
                  COALESCE(ps.base_salary, e.base_salary)::text AS base_salary,
                  ps.month AS mois_ref
           FROM "${schema}".employees e
           LEFT JOIN "${schema}".departments d ON d.id = e.department_id
           LEFT JOIN LATERAL (
             SELECT net_payable, gross_salary, base_salary, month
             FROM "${schema}".pay_slips
             WHERE employee_id = e.id AND month = ANY($1::text[])${entity ? ' AND legal_entity_id = $2' : ''}
             ORDER BY month DESC LIMIT 1
           ) ps ON true
           WHERE e.is_active = true AND e.deleted_at IS NULL${entity ? ' AND e.legal_entity_id = $2' : ''}
           ORDER BY e.last_name, e.first_name`,
          [months, ...entityParam]
        )
        const emps = empsRes.rows

        // ── 4. Déclarations trimestrielles ────────────────────────────────────
        const declRes = await rawPool.query<{
          quarter: number; status: string; total_cotisations: string; employees_count: number
          legal_entity_id?: string | null
        }>(
          `SELECT quarter, status,
                  COALESCE(total_cotisations, 0)::text AS total_cotisations,
                  COALESCE(employees_count, 0) AS employees_count,
                  legal_entity_id
           FROM "${schema}".cnps_declarations WHERE year = $1${entity ? ' AND legal_entity_id = $2' : ''}
           ORDER BY quarter`, [year, ...entityParam]
        )

        // ── 5. Stats cotisations de l'année ───────────────────────────────────
        const slipScope = entity
          ? ' AND ps.legal_entity_id = $4'
          : hasSubs ? ` AND ${civPayslipFilter(schema)}` : ''
        const cotisRes = await rawPool.query<{
          masse: string; cnps_sal: string; cnps_pat: string
          its: string; net: string; nb: string
          nb_plaf_retraite: string; nb_plaf_atpf: string
        }>(
          `SELECT SUM(ps.gross_salary)::text AS masse,
                  SUM(ps.total_cnps_sal)::text AS cnps_sal,
                  SUM(ps.total_cnps_pat)::text AS cnps_pat,
                  SUM(ps.its)::text AS its,
                  SUM(ps.net_payable)::text AS net,
                  COUNT(*)::text AS nb,
                  COUNT(*) FILTER (WHERE ps.gross_salary > $1)::text AS nb_plaf_retraite,
                  COUNT(*) FILTER (WHERE ps.gross_salary > $2)::text AS nb_plaf_atpf
           FROM "${schema}".pay_slips ps WHERE ps.month = ANY($3::text[])${slipScope}`,
          [scopePack.plafondCnpsRetraite, scopePack.plafondCnpsAtPf, months, ...entityParam]
        )
        const cotis = cotisRes.rows[0]

        // ── 6. Mensuel ────────────────────────────────────────────────────────
        const monthlyScope = entity
          ? ' AND ps.legal_entity_id = $2'
          : hasSubs ? ` AND ${civPayslipFilter(schema)}` : ''
        const monthlyRes = await rawPool.query<{
          month: string; nb: string; masse: string; cnps_sal: string; cnps_pat: string; its: string; net: string
        }>(
          `SELECT ps.month, COUNT(*)::text AS nb,
                  SUM(ps.gross_salary)::text AS masse,
                  SUM(ps.total_cnps_sal)::text AS cnps_sal,
                  SUM(ps.total_cnps_pat)::text AS cnps_pat,
                  SUM(ps.its)::text AS its,
                  SUM(ps.net_payable)::text AS net
           FROM "${schema}".pay_slips ps WHERE ps.month = ANY($1::text[])${monthlyScope}
           GROUP BY ps.month ORDER BY ps.month`, [months, ...entityParam]
        )

        // ── 7. Mobile Money répartition ───────────────────────────────────────
        const mobileRes = await rawPool.query<{ provider: string; cnt: string }>(
          `SELECT COALESCE(mobile_money_provider,'aucun') AS provider, COUNT(*)::text AS cnt
           FROM "${schema}".employees WHERE is_active = true AND deleted_at IS NULL${entity ? ' AND legal_entity_id = $1' : ''}
           GROUP BY mobile_money_provider ORDER BY COUNT(*) DESC`, entityParam
        )

        // ── 8. Agrégats par filiale (vue tenant multi-filiales) ───────────────
        const aggByEntity = new Map<string | null, {
          nb: number; masse: number; cnpsSal: number; cnpsPat: number; its: number
        }>()
        if (breakdown) {
          const aggRes = await rawPool.query<{
            legal_entity_id: string | null; nb: string; masse: string; cnps_sal: string; cnps_pat: string; its: string
          }>(
            `SELECT ps.legal_entity_id, COUNT(*)::text AS nb,
                    SUM(ps.gross_salary)::text AS masse,
                    SUM(ps.total_cnps_sal)::text AS cnps_sal,
                    SUM(ps.total_cnps_pat)::text AS cnps_pat,
                    SUM(ps.its)::text AS its
             FROM "${schema}".pay_slips ps WHERE ps.month = ANY($1::text[])
             GROUP BY ps.legal_entity_id`, [months]
          )
          for (const r of aggRes.rows) {
            aggByEntity.set(r.legal_entity_id ?? null, {
              nb: parseInt(r.nb ?? '0'), masse: parseInt(r.masse ?? '0'),
              cnpsSal: parseInt(r.cnps_sal ?? '0'), cnpsPat: parseInt(r.cnps_pat ?? '0'), its: parseInt(r.its ?? '0'),
            })
          }
        }

        // ── Évaluation par salarié (pack + périmètre CNPS) ────────────────────
        const evaluated = emps.map((e) => {
          const leId = e.legal_entity_id ?? null
          const pack = packFor(leId)
          const civ  = isCivFor(leId)
          const base = parseInt(e.base_salary ?? '0') || 0
          const wh   = parseFloat(e.weekly_hours ?? '')
          const hours = Number.isFinite(wh) ? Math.min(Math.max(wh, 1), 40) : 40
          const fullTime = Math.round(base * 40 / hours)
          const belowSmig = !!e.mois_ref && base > 0 && fullTime < pack.smigMensuel
          return { e, leId, pack, civ, base, fullTime, belowSmig }
        })

        type Anomaly = {
          code: string; severity: 'bloquant' | 'avertissement'; categorie: string
          message: string; employeeId?: string; employeeName?: string; legalEntityId?: string | null
        }
        const anomalies: Anomaly[] = []

        // ── 1. Employeur ─────────────────────────────────────────────────────
        // Mono-entité : le tenant. Filiale : la filiale. Vue tenant multi-filiales :
        // chaque filiale active (n° CNPS exigé pour les seules filiales CI).
        const employerRows: Array<{
          leId: string | null; label: string; civ: boolean; cnps: string; dgi: string; rccm: string
        }> = entity
          ? [{ leId: entity.id, label: `Filiale « ${entity.name ?? ''} » — `, civ: scopeCiv,
               cnps: entity.cnps_number ?? '', dgi: entity.dgi_number ?? '', rccm: entity.rccm ?? '' }]
          : breakdown
            ? entities.filter((le) => le.is_active !== false).map((le) => ({
                leId: le.id, label: `Filiale « ${le.name ?? ''} » — `, civ: isCivEntity(le),
                cnps: le.cnps_number ?? '', dgi: le.dgi_number ?? '', rccm: le.rccm ?? '',
              }))
            : [{ leId: null, label: '', civ: scopeCiv,
                 cnps: tenant?.cnps_number ?? '', dgi: tenant?.dgi_number ?? '', rccm: tenant?.rccm ?? '' }]
        if (checkEmployeur) {
          for (const r of employerRows) {
            if (r.civ && !r.cnps) anomalies.push({ code: 'EMP_CNPS_MISSING', severity: 'bloquant',      categorie: 'Employeur', message: `${r.label}N° CNPS employeur manquant — déclaration e-CNPS impossible`, legalEntityId: r.leId })
            if (!r.dgi)           anomalies.push({ code: 'EMP_DGI_MISSING',  severity: 'avertissement', categorie: 'Employeur', message: `${r.label}N° DGI/ITS manquant — télédéclaration ITS impossible`, legalEntityId: r.leId })
            if (!r.rccm)          anomalies.push({ code: 'EMP_RCCM_MISSING', severity: 'avertissement', categorie: 'Employeur', message: `${r.label}RCCM manquant — mention obligatoire sur contrats OHADA`, legalEntityId: r.leId })
          }
        }

        // ── 3. Anomalies salariés ─────────────────────────────────────────────
        if (checkCnps) {
          for (const { e, leId, civ } of evaluated) {
            if (!civ) continue // immatriculation CNPS CI : hors périmètre pour une filiale étrangère
            if (!e.nni)         anomalies.push({ code: 'EMP_NO_NNI',  severity: 'bloquant', categorie: 'Immatriculation', message: 'NNI manquant',       employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}`, legalEntityId: leId })
            if (!e.cnps_number) anomalies.push({ code: 'EMP_NO_CNPS', severity: 'bloquant', categorie: 'Immatriculation', message: 'N° CNPS manquant',   employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}`, legalEntityId: leId })
          }
        }
        if (checkSmig) {
          for (const { e, leId, pack, base, fullTime, belowSmig } of evaluated) {
            if (!belowSmig) continue
            const cur = currencyLabel(pack.currency)
            anomalies.push({
              code: 'BELOW_SMIG', severity: 'bloquant', categorie: 'SMIG',
              message: `Salaire de base ${fmtAmount(base)} ${cur}`
                + (fullTime !== base ? ` (soit ${fmtAmount(fullTime)} à temps plein)` : '')
                + ` < SMIG ${fmtAmount(pack.smigMensuel)} ${cur} (pack ${pack.code}, réf. ${e.mois_ref ?? ''})`,
              employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}`, legalEntityId: leId,
            })
          }
        }
        if (checkMobile) {
          for (const { e, leId } of evaluated) {
            if (!e.mobile_money_phone) anomalies.push({ code: 'NO_MOBILE', severity: 'avertissement', categorie: 'Paiement', message: 'Mobile Money non renseigné', employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}`, legalEntityId: leId })
          }
        }

        // ── Déclarations : par périmètre CNPS (tenant, filiale CI, ou chaque filiale CI)
        const declScopes: Array<{ leId: string | null; label: string }> = entity
          ? (scopeCiv ? [{ leId: entity.id, label: '' }] : [])
          : breakdown
            ? entities.filter((le) => le.is_active !== false && isCivEntity(le))
                .map((le) => ({ leId: le.id, label: `Filiale « ${le.name ?? ''} » — ` }))
            : (scopeCiv ? [{ leId: null, label: '' }] : [])
        const declsFor = (leId: string | null) =>
          breakdown ? declRes.rows.filter((d) => (d.legal_entity_id ?? null) === leId) : declRes.rows
        if (checkDecl) {
          const currentYear = now.getFullYear()
          const currentQtr  = Math.ceil((now.getMonth() + 1) / 3)
          for (const scope of declScopes) {
            const declMap = new Map(declsFor(scope.leId).map((d) => [d.quarter, d]))
            for (let qt = 1; qt <= 4; qt++) {
              let dm = qt * 3 + 1; let dy = year
              if (dm > 12) { dm = 1; dy++ }
              if (now > new Date(dy, dm - 1, 15) || year < currentYear || (year === currentYear && qt < currentQtr)) {
                const d = declMap.get(qt)
                if (!d)                        anomalies.push({ code: 'DECL_MISSING', severity: 'bloquant', categorie: 'Déclarations', message: `${scope.label}T${qt}/${year} — déclaration manquante (pénalités possibles)`, legalEntityId: scope.leId })
                else if (d.status === 'draft') anomalies.push({ code: 'DECL_DRAFT',   severity: 'bloquant', categorie: 'Déclarations', message: `${scope.label}T${qt}/${year} — en brouillon, non soumise sur e-CNPS`, legalEntityId: scope.leId })
              }
            }
          }
        }
        const scopedDecls = declScopes.flatMap((s) => declsFor(s.leId))

        // ── Calcul KPIs ───────────────────────────────────────────────────────
        const total       = emps.length
        const civEvaluated = evaluated.filter((x) => x.civ)
        const nbSansNni   = civEvaluated.filter((x) => !x.e.nni).length
        const nbSansCnps  = civEvaluated.filter((x) => !x.e.cnps_number).length
        const nbSousSmig  = evaluated.filter((x) => x.belowSmig).length
        const nbSansMob   = emps.filter((e) => !e.mobile_money_phone).length
        const civTotal    = civEvaluated.length

        const bloquants      = anomalies.filter((a) => a.severity === 'bloquant').length
        const avertissements = anomalies.filter((a) => a.severity === 'avertissement').length
        const score          = Math.max(0, 100 - bloquants * 15 - avertissements * 5)

        const declarationRows = declScopes.flatMap((s) => {
          const declMap = new Map(declsFor(s.leId).map((d) => [d.quarter, d]))
          return [1, 2, 3, 4].map((qt) => ({
            trimestre: qt, mois: [`${year}-${String((qt - 1) * 3 + 1).padStart(2, '0')}`, `${year}-${String((qt - 1) * 3 + 2).padStart(2, '0')}`, `${year}-${String(qt * 3).padStart(2, '0')}`],
            status: declMap.get(qt)?.status ?? 'missing',
            totalCotisations: declMap.get(qt) ? parseInt(declMap.get(qt)!.total_cotisations) : 0,
            employeesCount: declMap.get(qt)?.employees_count ?? 0,
            legalEntityId: s.leId,
            legalEntityName: entityName(s.leId),
          }))
        })

        // Ventilation par filiale (+ salariés non rattachés le cas échéant).
        const filiales = breakdown
          ? [
              ...entities.map((le) => ({ leId: le.id as string | null, le: le as AuditEntityRow | null })),
              ...(evaluated.some((x) => x.leId === null || !entityById.has(x.leId)) ? [{ leId: null, le: null }] : []),
            ].map(({ leId, le }) => {
              const pack = packFor(leId)
              const civ  = le ? isCivEntity(le) : isCivFor(null)
              const rows = evaluated.filter((x) => (le ? x.leId === le.id : (x.leId === null || !entityById.has(x.leId))))
              const agg  = aggByEntity.get(leId) ?? { nb: 0, masse: 0, cnpsSal: 0, cnpsPat: 0, its: 0 }
              const own  = anomalies.filter((a) => (a.legalEntityId ?? null) === leId)
              return {
                legalEntityId: leId,
                name: le?.name ?? null,
                countryCode: le?.country_code ?? null,
                legislationPackCode: pack.code,
                currency: pack.currency,
                cnpsApplicable: civ,
                employerCnps: le ? (le.cnps_number ?? null) : (tenant?.cnps_number || null),
                isActive: le ? le.is_active !== false : true,
                smigReference: pack.smigMensuel,
                totalEmployes: rows.length,
                nbSansNni:  civ ? rows.filter((x) => !x.e.nni).length : 0,
                nbSansCnps: civ ? rows.filter((x) => !x.e.cnps_number).length : 0,
                nbSousSmig: rows.filter((x) => x.belowSmig).length,
                nbSansMobile: rows.filter((x) => !x.e.mobile_money_phone).length,
                masseSalariale: agg.masse, totalCnpsSal: agg.cnpsSal, totalCnpsPat: agg.cnpsPat,
                totalIts: agg.its, nbBulletins: agg.nb,
                declarationsSoumises: civ && le ? declsFor(le.id).filter((d) => d.status === 'submitted').length : 0,
                bloquants: own.filter((a) => a.severity === 'bloquant').length,
                avertissements: own.filter((a) => a.severity === 'avertissement').length,
              }
            })
          : undefined

        const smigLabel = `${fmtAmount(scopePack.smigMensuel)} ${currencyLabel(scopePack.currency)}`
        return reply.send({
          year, scoreConformite: score,
          statut: bloquants === 0 ? (avertissements === 0 ? 'conforme' : 'avertissements') : 'non_conforme',
          auditParams: { checkEmployeur, checkCnps, checkSmig, checkDecl, checkMobile, checkPlafonds },
          legalEntityId: entity?.id ?? null,
          legalEntityName: entity?.name ?? null,
          legislationPackCode: scopePack.code,
          cnpsApplicable: scopeCiv,
          resume: {
            bloquants, avertissements, totalEmployes: total,
            nbSansNni, nbSansCnps, nbSousSmig, nbSansMobile: nbSansMob,
          },
          kpis: {
            tauxImmatriculation: civTotal > 0 ? Math.round(((civTotal - Math.max(nbSansNni, nbSansCnps)) / civTotal) * 100) : 100,
            tauxSmig:            total > 0 ? Math.round(((total - nbSousSmig) / total) * 100) : 100,
            tauxMobile:          total > 0 ? Math.round(((total - nbSansMob) / total) * 100) : 100,
            declarationsSoumises: scopedDecls.filter((d) => d.status === 'submitted').length,
            masseSalariale: parseInt(cotis?.masse ?? '0'),
            totalCnpsSal:   parseInt(cotis?.cnps_sal ?? '0'),
            totalCnpsPat:   parseInt(cotis?.cnps_pat ?? '0'),
            totalIts:       parseInt(cotis?.its ?? '0'),
            totalNet:       parseInt(cotis?.net ?? '0'),
            nbBulletins:    parseInt(cotis?.nb ?? '0'),
          },
          employeur: {
            cnpsOk: employerRows.every((r) => !r.civ || !!r.cnps),
            dgiOk:  employerRows.every((r) => !!r.dgi),
            rccmOk: employerRows.every((r) => !!r.rccm),
          },
          employees: evaluated.map(({ e, leId, pack, civ, belowSmig }) => ({
            id: e.id,
            nom: e.last_name, prenom: e.first_name,
            poste: e.job_title, departement: e.department_name,
            contractType: e.contract_type,
            legalEntityId: leId,
            legalEntityName: entityName(leId),
            cnpsApplicable: civ,
            nniOk: !civ || !!e.nni,   cnpsOk: !civ || !!e.cnps_number,
            smigOk: !belowSmig,
            smigReference: pack.smigMensuel,
            currency: pack.currency,
            mobileOk: !!e.mobile_money_phone,
            mobileProvider: e.mobile_money_provider ?? null,
            netPayable: e.net_payable ? parseInt(e.net_payable) : null,
            moisRef: e.mois_ref ?? null,
          })),
          declarations: declarationRows,
          mensuel: monthlyRes.rows.map((r) => ({
            mois: r.month, nb: parseInt(r.nb),
            masse: parseInt(r.masse ?? '0'), cnpsSal: parseInt(r.cnps_sal ?? '0'),
            cnpsPat: parseInt(r.cnps_pat ?? '0'), its: parseInt(r.its ?? '0'), net: parseInt(r.net ?? '0'),
          })),
          mobileMoney: mobileRes.rows.map((r) => ({ provider: r.provider, count: parseInt(r.cnt) })),
          // Plafonds CNPS : périmètre CI uniquement (pack de la filiale / du tenant).
          plafonds: scopeCiv ? {
            plafondRetraite: scopePack.plafondCnpsRetraite, plafondAtPf: scopePack.plafondCnpsAtPf,
            nbAuDessusRetraite: parseInt(cotis?.nb_plaf_retraite ?? '0'),
            nbAuDessusAtPf:     parseInt(cotis?.nb_plaf_atpf ?? '0'),
          } : null,
          smigReference: scopePack.smigMensuel, currency: scopePack.currency,
          ...(filiales ? { filiales } : {}),
          anomalies,
          recommandations: bloquants > 0 ? [
            'Immatriculer les salariés sans NNI/CNPS — obligation légale sous peine de sanctions',
            breakdown
              ? 'Régulariser les salaires de base inférieurs au SMIG du pays de chaque filiale'
              : `Régulariser les salaires de base inférieurs au SMIG (${smigLabel})`,
            'Soumettre les déclarations CNPS en retard sur e-CNPS (art. L.23 Code CNPS CI)',
          ] : avertissements > 0 ? [
            'Renseigner le N° DGI et le RCCM dans les paramètres entreprise',
            'Compléter les numéros Mobile Money pour fluidifier le paiement des salaires',
          ] : ['Dossier social conforme — aucune action requise'],
          generatedAt: new Date().toISOString(),
        })
      } catch (err) {
        fastify.log.error({ err: (err as Error).message }, '[cnps] audit-conformite failed')
        return reply.status(500).send({ error: "Échec de l'audit de conformité" })
      }
    },
  })
}

export default cnpsRoutes
