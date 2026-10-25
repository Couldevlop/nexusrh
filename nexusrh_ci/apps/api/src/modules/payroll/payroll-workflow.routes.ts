/**
 * Workflow paie centralisé multi-sites (Palier 3)
 *
 * Cycle : draft_central → sent_to_sites → completed_by_sites
 *       → validated_central → closed
 *
 * Acteurs :
 *  - Direction centrale (admin / hr_manager) : crée la période globale,
 *    déclenche l'envoi aux sites, valide après retour, clôture.
 *  - RAF site (raf_site) : reçoit le draft scopé sur sa legal_entity,
 *    complète les variables locales, soumet.
 *
 * Hypothèses :
 *  - Activé uniquement pour les tenants `has_subsidiaries=true`. Pour les
 *    autres, le module existant /payroll/periods continue d'être utilisé.
 *  - Une période parente porte legal_entity_id=NULL ; chaque déclinaison
 *    site porte parent_period_id + legal_entity_id + raf_user_id + pack.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { LEGISLATION_PACKS, getLegislationPack } from '../../services/legislation-packs.js'
import { calculatePayrollCI } from '../../services/payroll-engine-ci.js'
import { getWorkingDays } from '../../services/payroll-absences.service.js'
import { loadEffectiveAttendancePayrollSettings } from '../../services/attendance-payroll.service.js'
import {
  loadPayrollPopulation, markExpensesPaid, markSettlementPaid, resolveEmployeeMonth, slipPaymentMethod,
} from '../../services/final-payslip.service.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { auditTenant } from '../../utils/audit-log.js'
import {
  buildPayrollCircuitView, decideOnPayrollPeriod, describePendingPeriods, loadPayrollCircuit, loadPayrollUsers,
  loadPeriodApprovals, notifyPayrollUser, payrollDenialMessage, payrollLevelState, pendingValidationMessage,
  pendingWithOf, resetMultiSitePeriod, userDisplayName, PayrollResetConflict,
  type ApprovalForValidation, type PayrollCircuit, type PayrollLevelState, type PayrollUser, type PeriodForValidation,
} from '../../services/payroll-validation.service.js'

/**
 * OWASP A09 — Trace structurée pour chaque transition d'état du workflow
 * paie. Insert dans tenant_schema.audit_log si la table existe (sinon log
 * Pino uniquement). Non-bloquant : un échec audit n'empêche pas l'action.
 */
async function auditWorkflow(opts: {
  schema: string; userId: string; action: string
  entity: string; entityId: string; changes?: Record<string, unknown>
  ipAddress?: string
}): Promise<void> {
  try {
    auditTenant(opts.schema, { userId: opts.userId, action: opts.action, entity: opts.entity, entityId: opts.entityId, changes: opts.changes ?? {}, ip: opts.ipAddress ?? null })
  } catch {
    // Non-bloquant : tenant pré-migration peut ne pas avoir audit_log
  }
}

/**
 * Traduit une erreur (souvent Postgres) en message FR personnalisé + statut HTTP.
 * OWASP A10 : on mappe les codes connus vers des messages ACTIONNABLES pour le RH
 * sans jamais exposer le détail technique interne. Remplace les « Erreur serveur »
 * génériques par une explication utile (ce qui s'est passé + quoi faire).
 */
function describeWorkflowError(err: unknown): { status: number; error: string } {
  const code = (err as { code?: string } | null)?.code
  switch (code) {
    case '23505': // unique_violation — ex : déclinaison déjà faite, doublon de période
      return {
        status: 409,
        error: 'Cette opération a déjà été effectuée pour ce mois (doublon détecté). '
          + 'Rechargez la page pour voir l\'état à jour de la paie.',
      }
    case '23503': // foreign_key_violation — filiale/RAF référencé inexistant
      return {
        status: 400,
        error: 'Référence invalide : une filiale ou un responsable (RAF) est introuvable. '
          + 'Vérifiez la configuration des filiales dans Paramètres.',
      }
    case '42P10': // ON CONFLICT sans index correspondant
    case '42P01': // undefined_table
    case '42703': // undefined_column
      return {
        status: 500,
        error: 'Le schéma de ce tenant n\'est pas encore à jour pour la paie multi-filiales. '
          + 'Réessayez dans un instant ; si le problème persiste, contactez le support.',
      }
    default:
      return {
        status: 500,
        error: 'Une erreur est survenue lors de l\'opération de paie multi-filiales. '
          + 'Réessayez ; si le problème persiste, contactez le support.',
      }
  }
}

type PeriodStatus =
  | 'draft_central'
  | 'sent_to_sites'
  | 'completed_by_site'
  | 'validated_central'
  | 'closed'

const VALID_STATUSES: PeriodStatus[] = [
  'draft_central', 'sent_to_sites', 'completed_by_site',
  'validated_central', 'closed',
]

// OWASP A03 — validation des identifiants avant usage SQL
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Libellés FR des événements du workflow (suivi transparent pour les décideurs).
// Toute action workflow.* tracée dans l'audit_log est rendue lisible ici.
const WORKFLOW_EVENT_LABELS: Record<string, string> = {
  'workflow.create_draft':     'Brouillon initié',
  'workflow.send_to_sites':    'Décliné aux filiales',
  'workflow.submit_by_raf':    'Filiale soumise par le RAF',
  'workflow.validate_central': 'Consolidé par la RH centrale',
  'workflow.approve':          'Niveau de validation approuvé',
  'workflow.reject':           'Renvoyée en préparation',
  'workflow.cancel_initiation': 'Initiation annulée',
  'workflow.close':            'Paie clôturée',
}

// OWASP A03 — corps des actions du circuit de validation
const approveBodySchema = z.object({ notes: z.string().trim().max(2000).optional() }).strict()
const rejectBodySchema = z.object({
  reason: z.string().trim().min(10, 'Commentaire obligatoire (10 caractères minimum)').max(2000),
}).strict()
const cancelBodySchema = z.object({ comment: z.string().trim().max(2000).optional() }).strict()

/**
 * CIRCUIT DE VALIDATION NOMINATIF (mêmes règles que la paie mono-entité,
 * service payroll-validation) — où il s'applique dans le flux multi-filiales :
 *
 *   completed_by_site (toutes les filles)
 *     → POST validate-central : la RH centrale CONSOLIDE = INITIE le circuit
 *       (initiated_by / initiated_at posés sur la parente ; parente et filles
 *       passent en validated_central = « en attente de validation ») ;
 *     → POST approve (ou close, alias historique) : le valideur désigné de
 *       chaque niveau (puis l'équipe RH après l'échéance) valide ; l'initiateur
 *       ne valide jamais (SoD) ; le DERNIER niveau clôture la parente ET toutes
 *       ses filles (closed) — c'est seulement là que les bulletins deviennent
 *       visibles en self-service ;
 *     → POST reject (commentaire obligatoire) / cancel (initiateur, avant toute
 *       validation) : retour arrière transactionnel, parente et filles en
 *       sent_to_sites, bulletins de toutes les filles supprimés, chaque RAF
 *       re-soumet sa filiale.
 *
 * Le circuit porte sur la PÉRIODE PARENTE uniquement (pay_period_approvals,
 * « Mes validations ») : jamais de doublon parent / filles.
 */
interface MultiParentRow {
  id: string; month: string; status: string; parent_period_id: string | null
  initiated_by: string | null; initiated_at: string | Date | null
  validated_by: string | null; validated_central_at: string | Date | null
  rejection_reason: string | null; closed_at: string | null; closed_by: string | null
}

async function loadMultiParent(schema: string, id: string): Promise<MultiParentRow | null> {
  const r = await pool.query<MultiParentRow>(
    `SELECT id, month, status, parent_period_id, initiated_by, initiated_at, validated_by, validated_central_at,
            rejection_reason, closed_at, closed_by
       FROM "${schema}".pay_periods WHERE id = $1 LIMIT 1`,
    [id],
  )
  const row = r?.rows?.[0]
  return row && !row.parent_period_id ? row : null
}

/**
 * Projection de la parente sur le modèle du circuit : 'validated_central' =
 * en attente de validation. Initiateur = celui qui a consolidé (repli
 * validated_by pour une paie consolidée avant l'introduction du circuit).
 */
function asValidationPeriod(p: Pick<MultiParentRow, 'id' | 'status' | 'initiated_by' | 'initiated_at' | 'validated_by' | 'validated_central_at'>): PeriodForValidation {
  return {
    id: String(p.id),
    status: p.status === 'validated_central' ? 'pending_validation' : p.status,
    initiated_by: p.initiated_by ? String(p.initiated_by) : p.validated_by ? String(p.validated_by) : null,
    initiated_at: p.initiated_at ?? p.validated_central_at ?? null,
  }
}

type LoadedPending =
  | { status: 400 | 404 | 409; error: string }
  | {
      parent: MultiParentRow; period: PeriodForValidation; circuit: PayrollCircuit
      approvals: ApprovalForValidation[]; users: Map<string, PayrollUser>; state: PayrollLevelState | null
    }

/** Parente « consolidée, en attente de validation » + état de son circuit, ou l'erreur HTTP. */
async function loadPendingParent(schema: string, id: string): Promise<LoadedPending> {
  if (!UUID_RE.test(id)) return { status: 400, error: 'Identifiant de période invalide' }
  const parent = await loadMultiParent(schema, id)
  if (!parent) return { status: 404, error: 'Période parente introuvable' }
  if (parent.status === 'closed') {
    return { status: 409, error: 'Paie clôturée : elle est immuable (ni validation, ni rejet, ni annulation).' }
  }
  if (parent.status !== 'validated_central') {
    return {
      status: 409,
      error: 'Cette paie n\'est pas en attente de validation : consolidez-la d\'abord, une fois toutes les filiales soumises.',
    }
  }
  const period = asValidationPeriod(parent)
  const circuit = await loadPayrollCircuit(pool, schema)
  const approvals = (await loadPeriodApprovals(pool, schema, [period.id])).get(period.id) ?? []
  const users = await loadPayrollUsers(pool, schema, circuit.steps.map(s => s.userId))
  return { parent, period, circuit, approvals, users, state: payrollLevelState(circuit, period, approvals, users) }
}

function actorName(user: { firstName?: string; lastName?: string }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'un valideur'
}

async function assertMultiCountryTenant(
  schemaName: string,
): Promise<{ hasSubsidiaries: boolean }> {
  const res = await pool.query<{ has_subsidiaries: boolean }>(
    `SELECT has_subsidiaries FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
    [schemaName],
  )
  return { hasSubsidiaries: res.rows[0]?.has_subsidiaries === true }
}

const payrollWorkflowRoutes: FastifyPluginAsync = async (fastify) => {

  // Garantit que le schéma tenant porte les colonnes multi-filiales avant toute
  // opération (idempotent). Filet pour un tenant basculé en multi-pays par une
  // voie qui n'aurait pas re-provisionné le schéma. OWASP A04 : pas de calcul
  // sur un schéma incohérent.
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // ── GET /payroll-workflow/periods ─────────────────────────────────────────
  // Liste les périodes parentes + leurs déclinaisons site.
  // hr_officer : lecture (il peut être valideur désigné d'un niveau du circuit).
  fastify.get('/periods', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'raf_site', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        let sql = `SELECT pp.*, le.name AS legal_entity_name
                     FROM "${schema}".pay_periods pp
                     LEFT JOIN "${schema}".legal_entities le ON le.id = pp.legal_entity_id`
        const params: unknown[] = []
        // Un RAF site ne voit que les périodes de son entité
        if (request.user.role === 'raf_site') {
          sql += ` WHERE pp.raf_user_id = $1`
          params.push(request.user.sub)
        }
        sql += ` ORDER BY pp.month DESC, pp.parent_period_id NULLS FIRST, pp.created_at`
        const res = await pool.query<MultiParentRow & Record<string, unknown>>(sql, params)
        // Valideur attendu + échéance des paies consolidées en attente de validation
        const pendingParents = res.rows.filter(r => !r.parent_period_id && r.status === 'validated_central')
        if (pendingParents.length > 0) {
          const pendingWith = await describePendingPeriods(pool, schema, pendingParents.map(asValidationPeriod))
            .catch(() => new Map<string, ReturnType<typeof pendingWithOf>>())
          for (const r of pendingParents) r.pending_with = pendingWith.get(String(r.id)) ?? null
        }
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow operation failed')
        const { status, error } = describeWorkflowError(err)
        return reply.status(status).send({ error })
      }
    },
  })

  // ── POST /payroll-workflow/periods ────────────────────────────────────────
  // Direction centrale crée la période parente (un seul appel par mois global).
  fastify.post('/periods', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { hasSubsidiaries } = await assertMultiCountryTenant(schema)
      if (!hasSubsidiaries) {
        return reply.status(400).send({
          error: 'La gestion multi-pays (multi-filiales) n\'est pas activée pour votre entreprise. ' +
                 'Utilisez l\'écran Paie (clôture mensuelle) pour une paie mono-pays.',
        })
      }
      const body = request.body as { month: string }
      if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
        return reply.status(400).send({ error: 'month requis au format YYYY-MM' })
      }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".pay_periods
            (month, status, parent_period_id, legal_entity_id)
          VALUES ($1, 'draft_central', NULL, NULL)
          ON CONFLICT (month, legal_entity_id) DO NOTHING
          RETURNING *
        `, [body.month])
        if (!res.rows[0]) {
          return reply.status(409).send({ error: 'Période parente déjà existante pour ce mois' })
        }
        // OWASP A09 — trace l'initiation du brouillon (1re étape de la chronologie
        // de suivi consultée par les décideurs).
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.create_draft', entity: 'pay_period', entityId: res.rows[0].id,
          changes: { month: body.month },
          ipAddress: request.ip,
        })
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow operation failed')
        const { status, error } = describeWorkflowError(err)
        return reply.status(status).send({ error })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/send-to-sites ──────────────────────
  // La direction centrale décline le draft global vers chaque filiale.
  // Body : [{ legalEntityId, rafUserId, legislationPackCode }]
  fastify.post('/periods/:id/send-to-sites', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      // Le body est optionnel : sans `sites`, on auto-popule depuis
      // legal_entities WHERE is_active = true (Palier 3 simplifié, le RH
      // n'a pas à recopier la liste des filiales).
      const body = (request.body ?? {}) as {
        sites?: Array<{ legalEntityId: string; rafUserId: string; legislationPackCode: string }>
      }
      try {
        const parent = await pool.query<{ month: string; status: string }>(
          `SELECT month, status FROM "${schema}".pay_periods WHERE id = $1 AND parent_period_id IS NULL`,
          [id],
        )
        if (!parent.rows[0]) {
          return reply.status(404).send({ error: 'Période parente introuvable' })
        }
        if (parent.rows[0].status !== 'draft_central') {
          return reply.status(409).send({
            error: `Période non éligible (status=${parent.rows[0].status}, attendu=draft_central)`,
          })
        }

        // Auto-population depuis legal_entities si body.sites absent
        let sites = body.sites ?? []
        if (sites.length === 0) {
          const lesRes = await pool.query<{
            id: string; raf_user_id: string | null
            legislation_pack_code: string | null; country_code: string | null
            name: string
          }>(
            `SELECT id, raf_user_id, legislation_pack_code, country_code, name
             FROM "${schema}".legal_entities WHERE is_active = true`,
          )
          const missingRaf: string[] = []
          for (const le of lesRes.rows) {
            if (!le.raf_user_id) { missingRaf.push(le.name); continue }
            const code = le.legislation_pack_code ?? (
              le.country_code && LEGISLATION_PACKS[`${le.country_code}-2024`]
                ? `${le.country_code}-2024` : 'CIV-2024'
            )
            sites.push({ legalEntityId: le.id, rafUserId: le.raf_user_id, legislationPackCode: code })
          }
          if (missingRaf.length > 0) {
            return reply.status(400).send({
              error: `Filiales sans RAF assigné : ${missingRaf.join(', ')}. Définir legal_entities.raf_user_id d'abord.`,
            })
          }
        }
        if (sites.length === 0) {
          return reply.status(400).send({
            error: 'Aucune filiale active à scoper. Créez au moins une filiale '
              + '(avec un RAF assigné) dans Paramètres › Filiales avant de décliner la paie.',
          })
        }
        // Validation packs (qu'on vienne du body OU de l'auto-population)
        for (const s of sites) {
          if (!LEGISLATION_PACKS[s.legislationPackCode]) {
            return reply.status(400).send({ error: `Pack législatif inconnu : ${s.legislationPackCode}` })
          }
        }

        const month = parent.rows[0].month
        const created: unknown[] = []
        for (const s of sites) {
          const childRes = await pool.query(`
            INSERT INTO "${schema}".pay_periods
              (month, status, parent_period_id, legal_entity_id,
               legislation_pack_code, raf_user_id, sent_to_sites_at)
            VALUES ($1, 'sent_to_sites', $2, $3, $4, $5, now())
            RETURNING *
          `, [month, id, s.legalEntityId, s.legislationPackCode, s.rafUserId])
          created.push(childRes.rows[0])
        }

        await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'sent_to_sites', sent_to_sites_at = now()
           WHERE id = $1`,
          [id],
        )

        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.send_to_sites', entity: 'pay_period', entityId: id,
          changes: { sitesCount: sites.length },
          ipAddress: request.ip,
        })

        return reply.status(201).send({ data: { parent: id, sites: created } })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow operation failed')
        const { status, error } = describeWorkflowError(err)
        return reply.status(status).send({ error })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/submit-by-raf ──────────────────────
  // Le RAF du site marque sa période comme complétée (variables locales saisies).
  fastify.post('/periods/:id/submit-by-raf', {
    preHandler: [fastify.authorize('raf_site', 'admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const periodRes = await pool.query<{
          id: string; month: string; status: string
          raf_user_id: string | null; parent_period_id: string | null
          legal_entity_id: string | null; legislation_pack_code: string | null
        }>(
          `SELECT id, month, status, raf_user_id, parent_period_id, legal_entity_id, legislation_pack_code
           FROM "${schema}".pay_periods WHERE id = $1`,
          [id],
        )
        const period = periodRes.rows[0]
        if (!period) return reply.status(404).send({ error: 'Période introuvable' })
        if (!period.parent_period_id) {
          return reply.status(400).send({ error: 'Seules les périodes filles peuvent être soumises par un RAF' })
        }
        if (request.user.role === 'raf_site' && period.raf_user_id !== request.user.sub) {
          return reply.status(403).send({ error: 'Vous n\'êtes pas le RAF de cette filiale' })
        }
        if (period.status !== 'sent_to_sites') {
          return reply.status(409).send({
            error: `Période non éligible (status=${period.status}, attendu=sent_to_sites)`,
          })
        }
        if (!period.legal_entity_id) {
          return reply.status(500).send({ error: 'Période enfant sans legal_entity_id (incohérence)' })
        }

        // ── Génération réelle des bulletins de la filiale ──────────────────
        // On lit les paramètres de calcul depuis legal_entities + on applique
        // le pack législatif stocké sur la période enfant (résolu au send-to-sites).
        const leRes = await pool.query<{
          at_rate: string | null; name: string
        }>(
          `SELECT at_rate, name FROM "${schema}".legal_entities WHERE id = $1`,
          [period.legal_entity_id],
        )
        const le = leRes.rows[0]
        if (!le) return reply.status(500).send({ error: 'Filiale introuvable' })

        const pack = getLegislationPack(period.legislation_pack_code)
        if (pack.status === 'stub') {
          return reply.status(422).send({
            error: `Pack législatif "${pack.code}" en mode stub — non utilisable en production. Activer le pack ou changer la filiale.`,
          })
        }
        const atRate = le.at_rate ? parseFloat(le.at_rate) : 0.02

        const month = period.month
        // Employés de la filiale : actifs + sortants du mois (bulletin de solde)
        const emps = { rows: await loadPayrollPopulation(schema, month, { legalEntityId: period.legal_entity_id }) }

        const [yearStr, monthNumStr] = month.split('-')
        const year = parseInt(yearStr!, 10)
        const monthNum = parseInt(monthNumStr!, 10)
        const workingDaysMonth = getWorkingDays(year, monthNum)
        // Mêmes règles que le lot mono-filiale : absences validées + pointage
        const attendanceSettings = await loadEffectiveAttendancePayrollSettings(schema)

        let inserted = 0
        let totalGross = 0; let totalNet = 0; let totalCnps = 0; let totalIts = 0
        for (const emp of emps.rows) {
          // Variables locales (heures supp, primes, avances) — saisies par le RAF
          // dans la table variable_elements, scope (employé, période enfant).
          const varEls: Record<string, number> = {}
          const velRes = await pool.query<{ rule_code: string; amount: string }>(
            `SELECT rule_code, amount FROM "${schema}".variable_elements
             WHERE employee_id = $1 AND period_id = $2`,
            [emp.id, id],
          ).catch(() => ({ rows: [] as Array<{ rule_code: string; amount: string }> }))
          for (const v of velRes.rows) varEls[v.rule_code] = parseInt(v.amount)

          const baseSalary = parseInt(emp.base_salary)
          // Prorata entrée / sortie, absences, pointage et solde de tout compte
          const monthInputs = await resolveEmployeeMonth(schema, emp, month, attendanceSettings)
          const { absenceCtx, attendance } = monthInputs

          const result = calculatePayrollCI({
            baseSalary,
            workedDays:       monthInputs.workedDays,
            workingDaysMonth,
            atRate,
            maritalStatus:    emp.marital_status ?? 'single',
            childrenCount:    emp.children_count ?? 0,
            variableElements: varEls,
            absence:          absenceCtx?.info,
            attendanceDeductions: attendance?.deductions,
            settlementEarnings: monthInputs.settlementEarnings,
            expenseReimbursement: monthInputs.expenses.total,
            legislationPack:  pack,
          })
          totalGross += result.grossSalary
          totalNet   += result.netPayable
          totalCnps  += result.totalCnpsSal + result.totalCnpsPat
          totalIts   += result.its

          const slip = await pool.query<{ id: string }>(`
            INSERT INTO "${schema}".pay_slips
              (employee_id, period_id, month, base_salary, gross_salary,
               cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
               total_cnps_sal, total_cnps_pat, its, total_deductions,
               net_payable, employer_cost, lines, status, generated_at,
               payment_method, payment_status, legal_entity_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'generated',now(),$18,'pending',$17)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [
            emp.id, id, month, emp.base_salary, result.grossSalary,
            result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
            result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
            result.netPayable, result.employerCost, JSON.stringify(result.lines),
            period.legal_entity_id, slipPaymentMethod(emp),
          ])
          // Solde de tout compte porté sur ce bulletin : marqué payé
          const slipId = slip?.rows?.[0]?.id
          if (slipId && emp.offboarding_id && result.settlementTotal) {
            await markSettlementPaid(schema, emp.offboarding_id, month, slipId)
          }
          // Notes de frais remboursées par ce bulletin : marquées payées
          if (slipId) await markExpensesPaid(schema, monthInputs.expenses.ids, slipId)
          inserted++
        }

        const upd = await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'completed_by_site', completed_by_site_at = now(),
                 total_gross = $2, total_net = $3, total_cnps = $4, total_its = $5
           WHERE id = $1 RETURNING *`,
          [id, totalGross, totalNet, totalCnps, totalIts],
        )
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.submit_by_raf', entity: 'pay_period', entityId: id,
          changes: { inserted, totalGross, totalNet, legalEntityName: le.name },
          ipAddress: request.ip,
        })
        return reply.send({
          data: upd.rows[0],
          summary: { inserted, totalGross, totalNet, totalCnps, totalIts },
        })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow operation failed')
        const { status, error } = describeWorkflowError(err)
        return reply.status(status).send({ error })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/validate-central ───────────────────
  // Direction centrale CONSOLIDE la période parente une fois tous les sites
  // remontés en completed_by_site : c'est l'INITIATION du circuit de
  // validation nominatif (l'auteur de la consolidation = initiateur, qui ne
  // pourra ni valider ni rejeter). Parente et filles → validated_central.
  fastify.post('/periods/:id/validate-central', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const parent = await pool.query<{
          status: string; parent_period_id: string | null; month?: string
        }>(
          `SELECT status, parent_period_id, month FROM "${schema}".pay_periods WHERE id = $1`,
          [id],
        )
        if (!parent.rows[0]) return reply.status(404).send({ error: 'Période introuvable' })
        if (parent.rows[0].parent_period_id) {
          return reply.status(400).send({ error: 'La validation s\'applique à la période parente' })
        }
        // Une consolidation ne se rejoue pas : la paie est déjà en validation ou clôturée.
        if (parent.rows[0].status === 'validated_central' || parent.rows[0].status === 'closed') {
          return reply.status(409).send({
            error: parent.rows[0].status === 'closed'
              ? 'Paie clôturée : elle est immuable.'
              : 'Paie déjà consolidée et en attente de validation. Pour la recalculer, le valideur doit la renvoyer en préparation, ou l\'initiateur annuler son initiation tant qu\'aucun niveau n\'a validé.',
          })
        }
        // Vérifier que toutes les filles sont completed_by_site et consolider
        const children = await pool.query<{
          id: string; status: string; legal_entity_id: string | null
          total_gross: string | null; total_net: string | null
          total_cnps: string | null; total_its: string | null
        }>(
          `SELECT id, status, legal_entity_id, total_gross, total_net, total_cnps, total_its
           FROM "${schema}".pay_periods WHERE parent_period_id = $1`,
          [id],
        )
        if (children.rows.length === 0) {
          return reply.status(409).send({
            error: 'Aucune filiale n\'a encore été déclinée pour ce mois : déclinez la paie aux filiales avant de la consolider.',
          })
        }
        const pending = children.rows.filter(r => r.status !== 'completed_by_site')
        if (pending.length > 0) {
          return reply.status(409).send({
            error: `${pending.length} site(s) n'ont pas encore soumis leur draft (status attendu: completed_by_site)`,
          })
        }

        // Consolidation : somme des totaux enfants vers le parent
        let sumGross = 0; let sumNet = 0; let sumCnps = 0; let sumIts = 0
        for (const c of children.rows) {
          sumGross += parseInt(c.total_gross ?? '0')
          sumNet   += parseInt(c.total_net   ?? '0')
          sumCnps  += parseInt(c.total_cnps  ?? '0')
          sumIts   += parseInt(c.total_its   ?? '0')
        }

        // Consolidation = initiation du circuit de validation (SoD : l'initiateur
        // ne valide jamais) ; un éventuel motif de rejet précédent est effacé.
        await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'validated_central', validated_central_at = now(),
                 validated_by = $1, initiated_by = $1, initiated_at = now(), rejection_reason = NULL,
                 total_gross = $3, total_net = $4, total_cnps = $5, total_its = $6
           WHERE id = $2`,
          [request.user.sub, id, sumGross, sumNet, sumCnps, sumIts],
        )
        // Les enfants passent aussi à validated_central pour cohérence statut
        await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'validated_central', validated_central_at = now(), validated_by = $1
           WHERE parent_period_id = $2`,
          [request.user.sub, id],
        )
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.validate_central', entity: 'pay_period', entityId: id,
          changes: { sitesCount: children.rows.length, sumGross, sumNet, sumCnps, sumIts },
          ipAddress: request.ip,
        })

        // Valideur attendu du 1er niveau (circuit nominatif, Paramètres → Workflow)
        const month = parent.rows[0].month ?? ''
        let firstLevel: PayrollLevelState | null = null
        try {
          const circuit = await loadPayrollCircuit(pool, schema)
          const users = await loadPayrollUsers(pool, schema, [circuit.steps[0]?.userId])
          firstLevel = payrollLevelState(circuit,
            { id, status: 'pending_validation', initiated_by: request.user.sub, initiated_at: new Date() }, [], users)
        } catch { firstLevel = null }
        const pendingWith = pendingWithOf(firstLevel)
        if (pendingWith?.userId) {
          notifyPayrollUser(schema, pendingWith.userId, 'payroll_validation_requested', 'Paie à valider',
            `La paie multi-filiales ${month} attend votre validation (niveau 1/${pendingWith.requiredLevels}).`,
            { month, periodId: id, level: 1, scope: 'multi_sites' })
        }
        return reply.send({
          data: { id, status: 'validated_central' },
          consolidated: { sites: children.rows.length, sumGross, sumNet, sumCnps, sumIts },
          pendingWith,
          message: pendingValidationMessage(month, firstLevel),
        })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow operation failed')
        const { status, error } = describeWorkflowError(err)
        return reply.status(status).send({ error })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/approve (alias historique : /close) ─
  // Validation du niveau courant par le valideur désigné (ou, échéance
  // dépassée / désigné indisponible, par l'équipe RH hors initiateur et
  // approbateurs précédents). Le DERNIER niveau clôture la parente ET toutes
  // ses filles (statut terminal, bulletins publiés en self-service).
  const approveHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = request.user.schemaName
    const { id } = request.params as { id: string }
    const body = approveBodySchema.safeParse(request.body ?? {})
    if (!body.success) return reply.status(400).send({ error: 'Commentaire invalide (2000 caractères maximum).' })
    const notes = body.data.notes || null
    try {
      const loaded = await loadPendingParent(schema, id)
      if ('status' in loaded) return reply.status(loaded.status).send({ error: loaded.error })
      const { parent, period, circuit, approvals, users, state } = loaded

      const decision = decideOnPayrollPeriod(state, period.initiated_by, request.user)
      if (!decision.allowed) {
        return reply.status(403).send({ error: payrollDenialMessage(decision.reason, state) })
      }
      const requiredLevels = circuit.levels
      const level = state?.level ?? approvals.length + 1

      if (state) {
        try {
          await pool.query(
            `INSERT INTO "${schema}".pay_period_approvals
               (period_id, level, approver_id, approver_role, notes)
             VALUES ($1, $2, $3, $4, $5)`,
            [period.id, level, request.user.sub, request.user.role, notes],
          )
        } catch (err) {
          if ((err as { code?: string } | null)?.code === '23505') {
            return reply.status(409).send({ error: 'Ce niveau vient d\'être validé par quelqu\'un d\'autre. Rechargez la page.' })
          }
          throw err
        }
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.approve', entity: 'pay_period', entityId: period.id,
          changes: { month: parent.month, level, requiredLevels, escalated: decision.escalated },
          ipAddress: request.ip,
        })
      }

      // Dernier niveau requis atteint → clôture définitive de la parente ET des filles
      if (level >= requiredLevels) {
        await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'closed', closed_at = now(), closed_by = $1
           WHERE (id = $2 OR parent_period_id = $2) AND status = 'validated_central'`,
          [String(request.user.sub), period.id],
        )
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.close', entity: 'pay_period', entityId: period.id,
          changes: { month: parent.month, finalLevel: level, requiredLevels, escalated: decision.escalated },
          ipAddress: request.ip,
        })
        notifyPayrollUser(schema, period.initiated_by, 'payroll_closed', 'Paie clôturée',
          `La paie multi-filiales ${parent.month} a été validée à tous les niveaux et clôturée.`,
          { month: parent.month, periodId: period.id, scope: 'multi_sites' })
        return reply.send({
          data: { id: period.id, status: 'closed', level, requiredLevels, escalated: decision.escalated },
          message: `Paie ${parent.month} validée à tous les niveaux requis et clôturée : les bulletins de toutes les filiales sont publiés.`,
        })
      }

      const next = payrollLevelState(circuit, period,
        [...approvals, { level, approver_id: request.user.sub, approved_at: new Date() }], users)
      const pendingWith = pendingWithOf(next)
      if (pendingWith?.userId) {
        notifyPayrollUser(schema, pendingWith.userId, 'payroll_validation_requested', 'Paie à valider',
          `La paie multi-filiales ${parent.month} attend votre validation (niveau ${pendingWith.level}/${requiredLevels}).`,
          { month: parent.month, periodId: period.id, level: pendingWith.level, scope: 'multi_sites' })
      }
      return reply.send({
        data: { id: period.id, status: 'validated_central', level, requiredLevels, escalated: decision.escalated },
        pendingWith,
        message: `Validation niveau ${level}/${requiredLevels} enregistrée. ${pendingValidationMessage(parent.month, next)}.`,
      })
    } catch (err) {
      fastify.log.error({ err }, 'payroll-workflow approve failed')
      const { status, error } = describeWorkflowError(err)
      return reply.status(status).send({ error })
    }
  }
  fastify.post('/periods/:id/approve', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: approveHandler,
  })
  // Compatibilité : « Clôturer » = valider le niveau courant (mêmes règles).
  fastify.post('/periods/:id/close', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: approveHandler,
  })

  // ── POST /payroll-workflow/periods/:id/reject ─────────────────────────────
  // Rejet / renvoi en préparation par le valideur attendu (ou l'équipe RH
  // après échéance). Commentaire obligatoire. Transaction : bulletins de
  // toutes les filiales supprimés, notes de frais et soldes de tout compte
  // rétablis, parente et filles → sent_to_sites (chaque RAF re-soumet).
  fastify.post('/periods/:id/reject', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = rejectBodySchema.safeParse(request.body ?? {})
      if (!body.success) {
        return reply.status(400).send({ error: 'Commentaire obligatoire : expliquez le motif du renvoi en préparation (10 caractères minimum).' })
      }
      const reason = body.data.reason
      try {
        const loaded = await loadPendingParent(schema, id)
        if ('status' in loaded) return reply.status(loaded.status).send({ error: loaded.error })
        const { parent, period, state } = loaded
        const decision = decideOnPayrollPeriod(state, period.initiated_by, request.user)
        if (!decision.allowed) {
          return reply.status(403).send({ error: payrollDenialMessage(decision.reason, state) })
        }
        let reverted
        try {
          reverted = await resetMultiSitePeriod(schema, period.id, reason)
        } catch (err) {
          if (err instanceof PayrollResetConflict) return reply.status(409).send({ error: err.message })
          throw err
        }
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.reject', entity: 'pay_period', entityId: period.id,
          changes: {
            month: parent.month, reason, level: state?.level ?? null, escalated: decision.escalated,
            deletedPaySlips: reverted.deletedPaySlips, restoredExpenses: reverted.restoredExpenses,
            restoredSettlements: reverted.restoredSettlements, sitesReopened: reverted.sitesReopened,
          },
          ipAddress: request.ip,
        })
        const who = actorName(request.user)
        notifyPayrollUser(schema, period.initiated_by, 'payroll_rejected', 'Paie renvoyée en préparation',
          `La paie multi-filiales ${parent.month} a été renvoyée en préparation par ${who}. Motif : ${reason}`,
          { month: parent.month, periodId: period.id, scope: 'multi_sites' })
        for (const rafId of reverted.rafUserIds) {
          if (rafId === period.initiated_by) continue
          notifyPayrollUser(schema, rafId, 'payroll_rejected', 'Paie de votre filiale à re-soumettre',
            `La paie ${parent.month} a été renvoyée en préparation par ${who}. Motif : ${reason}. Vérifiez puis re-soumettez votre filiale.`,
            { month: parent.month, periodId: period.id, scope: 'multi_sites' })
        }
        return reply.send({
          data: {
            id: period.id, status: 'sent_to_sites',
            deletedPaySlips: reverted.deletedPaySlips, restoredExpenses: reverted.restoredExpenses,
            restoredSettlements: reverted.restoredSettlements, sitesReopened: reverted.sitesReopened,
          },
          message: 'Paie renvoyée en préparation : les bulletins générés ont été supprimés et chaque filiale doit être re-soumise par son RAF.',
        })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow reject failed')
        const { status, error } = describeWorkflowError(err)
        return reply.status(status).send({ error })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/cancel ─────────────────────────────
  // L'INITIATEUR (auteur de la consolidation) annule son initiation tant
  // qu'aucun niveau n'a validé : mêmes effets que le rejet, sans motif imposé.
  fastify.post('/periods/:id/cancel', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = cancelBodySchema.safeParse(request.body ?? {})
      if (!body.success) return reply.status(400).send({ error: 'Commentaire invalide (2000 caractères maximum).' })
      try {
        const loaded = await loadPendingParent(schema, id)
        if ('status' in loaded) return reply.status(loaded.status).send({ error: loaded.error })
        const { parent, period, approvals } = loaded
        if (period.initiated_by !== request.user.sub) {
          return reply.status(403).send({ error: 'Seul l\'initiateur (auteur de la consolidation) peut annuler son initiation.' })
        }
        if (approvals.length > 0) {
          return reply.status(409).send({ error: 'Un niveau a déjà été validé : l\'initiation ne peut plus être annulée. Demandez au valideur de renvoyer la paie en préparation.' })
        }
        let reverted
        try {
          reverted = await resetMultiSitePeriod(schema, period.id, null, { requireNoApproval: true })
        } catch (err) {
          if (err instanceof PayrollResetConflict) return reply.status(409).send({ error: err.message })
          throw err
        }
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.cancel_initiation', entity: 'pay_period', entityId: period.id,
          changes: {
            month: parent.month, comment: body.data.comment || null,
            deletedPaySlips: reverted.deletedPaySlips, restoredExpenses: reverted.restoredExpenses,
            restoredSettlements: reverted.restoredSettlements, sitesReopened: reverted.sitesReopened,
          },
          ipAddress: request.ip,
        })
        return reply.send({
          data: {
            id: period.id, status: 'sent_to_sites',
            deletedPaySlips: reverted.deletedPaySlips, restoredExpenses: reverted.restoredExpenses,
            restoredSettlements: reverted.restoredSettlements, sitesReopened: reverted.sitesReopened,
          },
          message: 'Initiation annulée : la paie est revenue en préparation et les bulletins générés ont été supprimés.',
        })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow cancel failed')
        const { status, error } = describeWorkflowError(err)
        return reply.status(status).send({ error })
      }
    },
  })

  // ── GET /payroll-workflow/periods/:id/workflow ────────────────────────────
  // État du circuit de la paie consolidée : niveaux validés (qui, quand),
  // niveau courant (valideur attendu + échéance) et droits du lecteur
  // (valider / rejeter / annuler) — même contrat que GET /payroll/periods/:month/workflow.
  fastify.get('/periods/:id/workflow', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Identifiant de période invalide' })
      try {
        const parent = await loadMultiParent(schema, id)
        if (!parent) return reply.status(404).send({ error: 'Période parente introuvable' })
        const period = asValidationPeriod(parent)
        const view = await buildPayrollCircuitView(pool, schema, period, request.user)
        const initiator = period.initiated_by
          ? (await loadPayrollUsers(pool, schema, [period.initiated_by])).get(period.initiated_by)
          : undefined
        return reply.send({
          period: {
            id: parent.id, month: parent.month, status: parent.status,
            initiatedAt: period.initiated_at, initiatedBy: period.initiated_by,
            initiatorName: userDisplayName(initiator),
            rejectionReason: parent.rejection_reason,
            closedAt: parent.closed_at, closedBy: parent.closed_by,
          },
          ...view,
        })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow circuit state failed')
        return reply.status(500).send({ error: 'Impossible de charger le circuit de validation de la paie. Réessayez.' })
      }
    },
  })

  // ── GET /payroll-workflow/periods/:id/timeline ────────────────────────────
  // Suivi TRANSPARENT de l'évolution du draft pour les responsables : chronologie
  // nominative (qui a fait quoi, quand, sur quelle filiale) reconstituée depuis
  // l'audit_log du parent + de ses filiales. Lecture seule.
  // RBAC (OWASP A01) : admin/hr_manager/readonly voient tout le draft ; raf_site
  // n'y accède que s'il pilote au moins une filiale de ce draft.
  fastify.get('/periods/:id/timeline', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'raf_site', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) {
        return reply.status(400).send({ error: 'Identifiant de période invalide' })
      }
      try {
        const parentRes = await pool.query<{
          id: string; month: string; status: string; parent_period_id: string | null
        }>(
          `SELECT id, month, status, parent_period_id
             FROM "${schema}".pay_periods WHERE id = $1`,
          [id],
        )
        const parent = parentRes.rows[0]
        if (!parent || parent.parent_period_id) {
          return reply.status(404).send({ error: 'Draft de paie introuvable (période parente attendue)' })
        }

        const childrenRes = await pool.query<{
          id: string; legal_entity_id: string | null
          raf_user_id: string | null; legal_entity_name: string | null
        }>(
          `SELECT pp.id, pp.legal_entity_id, pp.raf_user_id, le.name AS legal_entity_name
             FROM "${schema}".pay_periods pp
             LEFT JOIN "${schema}".legal_entities le ON le.id = pp.legal_entity_id
            WHERE pp.parent_period_id = $1`,
          [id],
        )
        const children = childrenRes.rows

        // OWASP A01 — un RAF ne peut suivre que les drafts qui le concernent
        if (request.user.role === 'raf_site') {
          const owns = children.some(c => c.raf_user_id === request.user.sub)
          if (!owns) {
            return reply.status(403).send({
              error: 'Accès refusé : vous ne pilotez aucune filiale de ce draft.',
            })
          }
        }

        const leById = new Map(children.map(c => [c.id, c.legal_entity_name]))
        const periodIds = [parent.id, ...children.map(c => c.id)]

        const eventsRes = await pool.query<{
          action: string; created_at: string; changes: Record<string, unknown> | null
          entity_id: string; first_name: string | null; last_name: string | null
        }>(
          `SELECT a.action, a.created_at, a.changes, a.entity_id,
                  u.first_name, u.last_name
             FROM "${schema}".audit_log a
             LEFT JOIN "${schema}".users u ON u.id = a.user_id
            WHERE a.entity = 'pay_period'
              AND a.entity_id = ANY($1::uuid[])
              AND a.action LIKE 'workflow.%'
            ORDER BY a.created_at ASC`,
          [periodIds],
        ).catch(() => ({ rows: [] as Array<{
          action: string; created_at: string; changes: Record<string, unknown> | null
          entity_id: string; first_name: string | null; last_name: string | null
        }> }))

        const events = eventsRes.rows.map((e) => {
          const actorName = [e.first_name, e.last_name].filter(Boolean).join(' ').trim() || 'Système'
          const ch = (e.changes && typeof e.changes === 'object') ? e.changes : {}
          const filialeFromChanges = typeof ch.legalEntityName === 'string' ? ch.legalEntityName : null
          const filiale = filialeFromChanges ?? leById.get(e.entity_id) ?? null
          return {
            action: e.action,
            label: WORKFLOW_EVENT_LABELS[e.action] ?? e.action,
            actorName,
            at: e.created_at,
            filiale,
            detail: ch,
          }
        })

        return reply.send({
          data: {
            period: { id: parent.id, month: parent.month, status: parent.status },
            totalSites: children.length,
            events,
          },
        })
      } catch (err) {
        fastify.log.error({ err }, 'payroll-workflow timeline failed')
        const { status, error } = describeWorkflowError(err)
        return reply.status(status).send({ error })
      }
    },
  })

  // ── GET /payroll-workflow/statuses (referenceval) ────────────────────────
  fastify.get('/statuses', {
    preHandler: [fastify.authenticate],
    handler: async (_req, reply) => reply.send({ data: VALID_STATUSES }),
  })
}

export default payrollWorkflowRoutes
