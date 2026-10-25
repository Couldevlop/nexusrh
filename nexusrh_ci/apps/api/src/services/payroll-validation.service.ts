/**
 * Circuit de validation NOMINATIF de la clôture de paie, commun aux deux flux :
 *  - mono-entité : open → pending_validation → N validations → closed ;
 *  - multi-filiales (période parente) : … → completed_by_site (toutes les
 *    filles) → validated_central (consolidation = INITIATION du circuit)
 *    → N validations → closed (parente ET filles). Le flux multi-filiales
 *    projette 'validated_central' sur 'pending_validation' pour réutiliser
 *    payrollLevelState / decidePayrollActor tels quels.
 *
 * Paramétrage (Paramètres → Workflow, module `payroll`) :
 *  - workflow_configs.levels_count = nombre de validations requises (1 à 10,
 *    l'UI en propose 1 à 5) ;
 *  - workflow_configs.config.validators[i] = niveau i+1 :
 *      { userId: users.id | null, functionLabel: « Chef de service paie », slaDays }.
 *
 * Règles (même philosophie que approval-workflow.service : valideur désigné,
 * puis escalade à l'équipe RH une fois l'échéance dépassée) :
 *  - SoD : l'initiateur de la clôture ne valide ni ne rejette JAMAIS sa propre
 *    paie ; un approbateur ne valide jamais deux niveaux (contrainte UNIQUE
 *    (period_id, approver_id) de pay_period_approvals).
 *  - Niveau avec valideur désigné DISPONIBLE : lui seul agit ; échéance (SLA)
 *    dépassée, tout admin / hr_manager (hors initiateur et approbateurs
 *    précédents) peut agir — l'action est tracée comme escalade.
 *  - Valideur désigné INDISPONIBLE (c'est l'initiateur, il a déjà validé un
 *    niveau précédent, compte désactivé / supprimé / rôle retiré) : le niveau
 *    est ouvert d'emblée à l'équipe RH (admin / hr_manager hors initiateur),
 *    sans attendre le SLA — attendre une échéance qu'il ne pourra jamais tenir
 *    bloquerait la paie. Tracé comme escalade.
 *  - Sans désignation : comportement historique (tout admin / hr_manager autre
 *    que l'initiateur et les approbateurs précédents).
 *  - Un gestionnaire RH (hr_officer) n'agit que s'il est le valideur désigné du
 *    niveau (pas d'escalade vers lui : la clôture paie reste admin / hr_manager).
 *
 * Rejet / annulation : revertPeriodPayslips() supprime les bulletins générés
 * (jamais payés), remet les notes de frais remboursées par ces bulletins au
 * statut « approuvée » et défait le marquage du solde de tout compte posé par
 * markSettlementPaid() — la période peut alors être recalculée.
 */
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'

/** Accès SQL : pool partagé ou client d'une transaction. */
export interface Queryable { query: PoolClient['query'] }

const DAY_MS = 86_400_000
const MIN_LEVELS = 1
const MAX_LEVELS = 10
/** Nombre de validations requises par défaut (provisioning : 2). */
const DEFAULT_LEVELS = 2
export const DEFAULT_PAYROLL_SLA_DAYS = 2
/** Rôles pouvant être désignés valideurs de la paie. */
export const PAYROLL_DESIGNABLE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
/** Rôles de l'équipe RH qui prennent la main sans désignation / après échéance. */
const PAYROLL_TEAM_ROLES = ['admin', 'hr_manager'] as const

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrateur', hr_manager: 'Responsable RH', hr_officer: 'Gestionnaire RH',
}

export interface PayrollLevelConfig {
  level: number
  userId: string | null
  functionLabel: string | null
  slaDays: number
}

export interface PayrollCircuit {
  levels: number
  steps: PayrollLevelConfig[]
}

function boundedInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/** Normalise levels_count + config jsonb (valeurs absentes / invalides → défauts). */
export function parsePayrollCircuit(levelsCount: unknown, raw: unknown): PayrollCircuit {
  const levels = boundedInt(typeof levelsCount === 'number' ? levelsCount : Number(levelsCount ?? NaN), DEFAULT_LEVELS, MIN_LEVELS, MAX_LEVELS)
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const validators = Array.isArray(c.validators) ? c.validators : []
  const steps: PayrollLevelConfig[] = []
  for (let i = 0; i < levels; i++) {
    const v = (validators[i] && typeof validators[i] === 'object' ? validators[i] : {}) as Record<string, unknown>
    const label = typeof v.functionLabel === 'string' ? v.functionLabel.trim().slice(0, 80) : ''
    steps.push({
      level: i + 1,
      userId: typeof v.userId === 'string' && v.userId ? v.userId : null,
      functionLabel: label || null,
      slaDays: boundedInt(v.slaDays, DEFAULT_PAYROLL_SLA_DAYS, 1, 30),
    })
  }
  return { levels, steps }
}

/** Circuit paie du tenant (défauts si absent ou illisible). */
export async function loadPayrollCircuit(db: Queryable, schema: string): Promise<PayrollCircuit> {
  try {
    const r = await db.query<{ levels_count: number; config: unknown }>(
      `SELECT levels_count, config FROM "${schema}".workflow_configs WHERE module = 'payroll' LIMIT 1`,
    )
    const row = r?.rows?.[0]
    return parsePayrollCircuit(row?.levels_count ?? DEFAULT_LEVELS, row?.config)
  } catch {
    return parsePayrollCircuit(DEFAULT_LEVELS, null)
  }
}

export interface PayrollUser {
  id: string
  firstName: string | null
  lastName: string | null
  role: string
  isActive: boolean
}

/** Comptes utilisateurs du tenant (par id), pour nommer valideurs et initiateurs. */
export async function loadPayrollUsers(db: Queryable, schema: string, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, PayrollUser>> {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))]
  const map = new Map<string, PayrollUser>()
  if (wanted.length === 0) return map
  try {
    const r = await db.query<{ id: string; first_name: string | null; last_name: string | null; role: string; is_active: boolean | null }>(
      `SELECT id, first_name, last_name, role, is_active FROM "${schema}".users WHERE id::text = ANY($1::text[])`,
      [wanted],
    )
    for (const u of r?.rows ?? []) {
      map.set(String(u.id), {
        id: String(u.id), firstName: u.first_name, lastName: u.last_name, role: u.role, isActive: u.is_active !== false,
      })
    }
  } catch { /* noms indisponibles : le circuit retombe sur l'équipe RH */ }
  return map
}

export function userDisplayName(u: Pick<PayrollUser, 'firstName' | 'lastName'> | null | undefined): string | null {
  if (!u) return null
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
  return name || null
}

export interface PeriodForValidation {
  id: string
  status: string
  initiated_by: string | null
  initiated_at: string | Date | null
}

export interface ApprovalForValidation {
  level: number
  approver_id: string
  approved_at: string | Date
}

export interface PayrollValidator {
  userId: string
  name: string | null
  role: string
  functionLabel: string | null
}

/** État du niveau en attente d'une période en validation. */
export interface PayrollLevelState {
  level: number
  requiredLevels: number
  /** Valideur désigné du niveau (même indisponible), sinon null. */
  designated: PayrollValidator | null
  /** Le valideur désigné peut effectivement agir (actif, ni initiateur, ni approbateur précédent). */
  designatedAvailable: boolean
  functionLabel: string | null
  slaDays: number
  enteredAt: string | null
  dueAt: string | null
  overdue: boolean
  /** Le niveau est ouvert à l'équipe RH (sans désignation, désigné indisponible ou échéance dépassée). */
  teamCanAct: boolean
  initiatorId: string | null
  approverIds: string[]
}

function toTime(v: string | Date | null | undefined): number | null {
  if (!v) return null
  const t = v instanceof Date ? v.getTime() : Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** Niveau courant (null si la période n'est pas en validation ou est complète). */
export function payrollLevelState(
  circuit: PayrollCircuit,
  period: PeriodForValidation,
  approvals: readonly ApprovalForValidation[],
  users: ReadonlyMap<string, PayrollUser>,
  now: Date = new Date(),
): PayrollLevelState | null {
  if (period.status !== 'pending_validation') return null
  const done = [...approvals].sort((a, b) => a.level - b.level)
  if (done.length >= circuit.levels) return null
  const level = done.length + 1
  const step = circuit.steps[level - 1] ?? { level, userId: null, functionLabel: null, slaDays: DEFAULT_PAYROLL_SLA_DAYS }
  const approverIds = done.map((a) => String(a.approver_id))
  const initiatorId = period.initiated_by ? String(period.initiated_by) : null

  const enteredMs = level === 1 ? toTime(period.initiated_at) : toTime(done[level - 2]?.approved_at)
  const dueMs = enteredMs === null ? null : enteredMs + step.slaDays * DAY_MS
  const overdue = dueMs !== null && now.getTime() > dueMs

  let designated: PayrollValidator | null = null
  let designatedAvailable = false
  if (step.userId) {
    const u = users.get(step.userId)
    designated = {
      userId: step.userId,
      name: userDisplayName(u),
      role: u?.role ?? '',
      functionLabel: step.functionLabel,
    }
    designatedAvailable = !!u && u.isActive
      && (PAYROLL_DESIGNABLE_ROLES as readonly string[]).includes(u.role)
      && step.userId !== initiatorId
      && !approverIds.includes(step.userId)
  }
  return {
    level,
    requiredLevels: circuit.levels,
    designated,
    designatedAvailable,
    functionLabel: step.functionLabel,
    slaDays: step.slaDays,
    enteredAt: enteredMs === null ? null : new Date(enteredMs).toISOString(),
    dueAt: dueMs === null ? null : new Date(dueMs).toISOString(),
    overdue,
    teamCanAct: !designatedAvailable || overdue,
    initiatorId,
    approverIds,
  }
}

export type PayrollDenial = 'initiator' | 'already_approved' | 'awaiting_designated' | 'role'

export type PayrollDecision =
  | { allowed: true; escalated: boolean }
  | { allowed: false; reason: PayrollDenial }

function isTeamRole(role: string): boolean {
  return (PAYROLL_TEAM_ROLES as readonly string[]).includes(role)
}

/** L'acteur peut-il valider / rejeter le niveau courant ? */
export function decidePayrollActor(state: PayrollLevelState, actor: { userId: string; role: string }): PayrollDecision {
  if (state.initiatorId && actor.userId === state.initiatorId) return { allowed: false, reason: 'initiator' }
  if (state.approverIds.includes(actor.userId)) return { allowed: false, reason: 'already_approved' }
  if (state.designatedAvailable && state.designated) {
    if (actor.userId === state.designated.userId) return { allowed: true, escalated: false }
    if (state.overdue && isTeamRole(actor.role)) return { allowed: true, escalated: true }
    return { allowed: false, reason: isTeamRole(actor.role) || actor.role === 'hr_officer' ? 'awaiting_designated' : 'role' }
  }
  if (isTeamRole(actor.role)) return { allowed: true, escalated: state.designated !== null }
  return { allowed: false, reason: 'role' }
}

/**
 * Droit d'agir sur une période en validation (valider / rejeter). Sans niveau
 * courant (tous les niveaux déjà validés après une réduction du circuit),
 * l'équipe RH hors initiateur finalise la clôture.
 */
export function decideOnPayrollPeriod(
  state: PayrollLevelState | null, initiatorId: string | null, user: { sub: string; role: string },
): PayrollDecision {
  if (state) return decidePayrollActor(state, { userId: user.sub, role: user.role })
  if (initiatorId && initiatorId === user.sub) return { allowed: false, reason: 'initiator' }
  if (isTeamRole(user.role)) return { allowed: true, escalated: false }
  return { allowed: false, reason: 'role' }
}

function roleLabel(role: string | null | undefined): string {
  return (role && ROLE_LABELS[role]) || 'équipe RH'
}

/** « Prénom Nom (fonction) » du valideur attendu, ou null (équipe RH). */
export function expectedValidatorText(state: PayrollLevelState | null): string | null {
  if (!state?.designatedAvailable || !state.designated) return null
  const who = state.designated.name ?? 'le valideur désigné'
  return `${who} (${state.designated.functionLabel ?? roleLabel(state.designated.role)})`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { timeZone: 'Africa/Abidjan' })
}

/** Message utilisateur : « Période 2026-10 en attente de validation de … ». */
export function pendingValidationMessage(month: string, state: PayrollLevelState | null): string {
  const who = expectedValidatorText(state)
  return who
    ? `Période ${month} en attente de validation de ${who}`
    : `Période ${month} en attente de validation par un administrateur ou responsable RH autre que l'initiateur`
}

/** Message d'erreur d'un refus d'action (403). */
export function payrollDenialMessage(reason: PayrollDenial, state: PayrollLevelState | null): string {
  switch (reason) {
    case 'initiator':
      return 'Vous avez initié cette paie. Un autre approbateur est requis (séparation des tâches).'
    case 'already_approved':
      return 'Vous avez déjà approuvé un niveau précédent. Un autre approbateur est requis.'
    case 'awaiting_designated': {
      const due = formatDate(state?.dueAt ?? null)
      return `Le niveau ${state?.level ?? ''} est assigné à ${expectedValidatorText(state) ?? 'un valideur désigné'} : `
        + `le reste de l'équipe RH pourra agir après l'échéance${due ? ` du ${due}` : ''}.`
    }
    default:
      return 'Seul le valideur désigné, ou un administrateur / responsable RH, peut valider ou rejeter la paie.'
  }
}

/** Informations exposées à l'UI sur le valideur attendu. */
export interface PendingWith {
  level: number
  requiredLevels: number
  userId: string | null
  name: string | null
  functionLabel: string | null
  role: string | null
  dueAt: string | null
  overdue: boolean
  /** Le reste de l'équipe RH peut agir (pas de désignation, désigné indisponible, ou échéance dépassée). */
  teamCanAct: boolean
}

export function pendingWithOf(state: PayrollLevelState | null): PendingWith | null {
  if (!state) return null
  const d = state.designatedAvailable ? state.designated : null
  return {
    level: state.level,
    requiredLevels: state.requiredLevels,
    userId: d?.userId ?? null,
    name: d?.name ?? null,
    functionLabel: d ? d.functionLabel ?? roleLabel(d.role) : null,
    role: d?.role ?? null,
    dueAt: state.dueAt,
    overdue: state.overdue,
    teamCanAct: state.teamCanAct,
  }
}

/** Validations déjà enregistrées d'une période. */
export async function loadPeriodApprovals(db: Queryable, schema: string, periodIds: readonly string[]): Promise<Map<string, ApprovalForValidation[]>> {
  const map = new Map<string, ApprovalForValidation[]>()
  if (periodIds.length === 0) return map
  const r = await db.query<{ period_id: string; level: number; approver_id: string; approved_at: string }>(
    `SELECT period_id, level, approver_id, approved_at FROM "${schema}".pay_period_approvals
      WHERE period_id::text = ANY($1::text[]) ORDER BY level ASC`,
    [periodIds],
  )
  for (const row of r?.rows ?? []) {
    const list = map.get(String(row.period_id)) ?? []
    list.push({ level: Number(row.level), approver_id: String(row.approver_id), approved_at: row.approved_at })
    map.set(String(row.period_id), list)
  }
  return map
}

/** Valideurs attendus des périodes en validation (historique des périodes). */
export async function describePendingPeriods(
  db: Queryable, schema: string, periods: readonly PeriodForValidation[], now: Date = new Date(),
): Promise<Map<string, PendingWith>> {
  const out = new Map<string, PendingWith>()
  const pending = periods.filter((p) => p.status === 'pending_validation')
  if (pending.length === 0) return out
  const circuit = await loadPayrollCircuit(db, schema)
  const approvals = await loadPeriodApprovals(db, schema, pending.map((p) => String(p.id)))
  const users = await loadPayrollUsers(db, schema, circuit.steps.map((s) => s.userId))
  for (const p of pending) {
    const w = pendingWithOf(payrollLevelState(circuit, p, approvals.get(String(p.id)) ?? [], users, now))
    if (w) out.set(String(p.id), w)
  }
  return out
}

export interface PayrollApprovalView {
  level: number
  approverId: string
  approverRole: string | null
  approverName: string | null
  approvedAt: string
  notes: string | null
}

/** État complet du circuit exposé à l'UI (niveaux, valideur attendu, droits du lecteur). */
export interface PayrollCircuitView {
  requiredLevels: number
  currentLevel: number
  isComplete: boolean
  approvals: PayrollApprovalView[]
  levels: Array<{
    level: number
    status: 'approved' | 'current' | 'upcoming'
    validator: { userId: string; name: string | null; role: string | null; available: boolean } | null
    functionLabel: string | null
    slaDays: number
    dueAt: string | null
    overdue: boolean
    teamCanAct: boolean
    approval: (PayrollApprovalView & { escalated: boolean }) | null
  }>
  pendingWith: PendingWith | null
  viewer: {
    canApprove: boolean
    canReject: boolean
    canCancel: boolean
    escalated: boolean
    deniedReason: PayrollDenial | null
    deniedMessage: string | null
  }
}

/**
 * Vue du circuit d'une période (mono-entité ou période parente multi-filiales) :
 * niveaux validés (qui, quand), niveau courant (valideur attendu + échéance) et
 * droits du lecteur (valider / rejeter / annuler), calculés ici — l'UI n'en
 * duplique rien. `period.status` vaut 'pending_validation' quand la période
 * attend une validation (le flux multi-filiales y projette 'validated_central').
 */
export async function buildPayrollCircuitView(
  db: Queryable, schema: string, period: PeriodForValidation, viewer: { sub: string; role: string }, now: Date = new Date(),
): Promise<PayrollCircuitView> {
  const circuit = await loadPayrollCircuit(db, schema)
  const approvals = await db.query<{
    level: number; approver_id: string; approver_role: string | null
    approved_at: string; notes: string | null
    first_name: string | null; last_name: string | null
  }>(
    `SELECT a.level, a.approver_id, a.approver_role, a.approved_at, a.notes,
            u.first_name, u.last_name
       FROM "${schema}".pay_period_approvals a
       LEFT JOIN "${schema}".users u ON u.id = a.approver_id
      WHERE a.period_id = $1
      ORDER BY a.level ASC`,
    [period.id],
  )
  const approvalRowsRaw = approvals?.rows ?? []
  const users = await loadPayrollUsers(db, schema, circuit.steps.map(s => s.userId))
  const state = payrollLevelState(circuit, period, approvalRowsRaw, users, now)
  const decision = decideOnPayrollPeriod(state, period.initiated_by ? String(period.initiated_by) : null, viewer)
  const approvalRows: PayrollApprovalView[] = approvalRowsRaw.map(a => ({
    level: a.level,
    approverId: a.approver_id,
    approverRole: a.approver_role,
    approverName: [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
    approvedAt: a.approved_at,
    notes: a.notes,
  }))
  const levels = circuit.steps.map(step => {
    const done = approvalRows.find(a => a.level === step.level) ?? null
    const designatedUser = step.userId ? users.get(step.userId) : undefined
    const isCurrent = state?.level === step.level
    return {
      level: step.level,
      status: (done ? 'approved' : isCurrent ? 'current' : 'upcoming') as 'approved' | 'current' | 'upcoming',
      validator: step.userId ? {
        userId: step.userId,
        name: userDisplayName(designatedUser),
        role: designatedUser?.role ?? null,
        available: isCurrent ? state?.designatedAvailable ?? false : !!designatedUser && designatedUser.isActive,
      } : null,
      functionLabel: step.functionLabel,
      slaDays: step.slaDays,
      dueAt: isCurrent ? state?.dueAt ?? null : null,
      overdue: isCurrent ? state?.overdue ?? false : false,
      teamCanAct: isCurrent ? state?.teamCanAct ?? false : false,
      approval: done ? { ...done, escalated: !!step.userId && done.approverId !== step.userId } : null,
    }
  })
  const pending = period.status === 'pending_validation'
  return {
    requiredLevels: circuit.levels,
    currentLevel: approvalRowsRaw.length,
    isComplete: approvalRowsRaw.length >= circuit.levels,
    approvals: approvalRows,
    levels,
    pendingWith: pendingWithOf(state),
    viewer: {
      canApprove: pending && decision.allowed,
      canReject: pending && decision.allowed,
      canCancel: pending && !!period.initiated_by && String(period.initiated_by) === viewer.sub && approvalRowsRaw.length === 0,
      escalated: pending && decision.allowed && decision.escalated,
      deniedReason: pending && !decision.allowed ? decision.reason : null,
      deniedMessage: pending && !decision.allowed ? payrollDenialMessage(decision.reason, state) : null,
    },
  }
}

/** Notification non bloquante (table notifications). */
export function notifyPayrollUser(
  schema: string, userId: string | null | undefined, type: string,
  title: string, message: string, data: Record<string, unknown> = {},
): void {
  if (!userId) return
  void Promise.resolve()
    .then(() => pool.query(
      `INSERT INTO "${schema}".notifications (user_id, type, title, message, data) VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, message, JSON.stringify(data)],
    ))
    .catch(() => { /* table absente / utilisateur supprimé : non bloquant */ })
}

/** Bulletin modifiable : généré, non payé, sans paiement Mobile Money engagé. */
function isRevertible(row: { status: string | null; payment_status: string | null; paid_at: unknown; has_payment: boolean | null }): boolean {
  return (row.status === 'generated' || row.status === 'draft')
    && (row.payment_status === null || row.payment_status === 'pending' || row.payment_status === 'failed')
    && !row.paid_at
    && row.has_payment !== true
}

export type RevertResult =
  | { ok: true; deletedPaySlips: number; restoredExpenses: number; restoredSettlements: number }
  | { ok: false; lockedPaySlips: number }

/**
 * Annule les effets de la génération des bulletins d'une période (à appeler
 * DANS une transaction) : suppression des bulletins générés, notes de frais
 * remboursées par ces bulletins remises « approuvées », marquage du solde de
 * tout compte (settlement.paidInMonth / paySlipId) retiré. Refuse (ok:false)
 * dès qu'un bulletin de la période est payé ou en cours de paiement.
 */
export async function revertPeriodPayslips(db: Queryable, schema: string, periodId: string): Promise<RevertResult> {
  const slips = await db.query<{ id: string; status: string | null; payment_status: string | null; paid_at: unknown; has_payment: boolean | null }>(
    `SELECT ps.id, ps.status, ps.payment_status, ps.paid_at,
            EXISTS (SELECT 1 FROM "${schema}".mobile_money_payments mm
                     WHERE mm.pay_slip_id = ps.id AND COALESCE(mm.status, 'pending') NOT IN ('failed', 'cancelled')) AS has_payment
       FROM "${schema}".pay_slips ps
      WHERE ps.period_id = $1
      FOR UPDATE OF ps`,
    [periodId],
  )
  const rows = slips?.rows ?? []
  const locked = rows.filter((r) => !isRevertible(r)).length
  if (locked > 0) return { ok: false, lockedPaySlips: locked }
  const ids = rows.map((r) => String(r.id))
  if (ids.length === 0) return { ok: true, deletedPaySlips: 0, restoredExpenses: 0, restoredSettlements: 0 }

  const expenses = await db.query(
    `UPDATE "${schema}".expense_reports
        SET status = 'approved', payment_method = NULL, payment_reference = NULL, paid_at = NULL, updated_at = now()
      WHERE status = 'paid' AND payment_method = 'payslip' AND payment_reference = ANY($1::text[])`,
    [ids],
  )
  const settlements = await db.query(
    `UPDATE "${schema}".offboarding_cases
        SET settlement = (settlement - 'paidInMonth') - 'paySlipId', updated_at = now()
      WHERE settlement IS NOT NULL AND settlement->>'paySlipId' = ANY($1::text[])`,
    [ids],
  )
  const deleted = await db.query(
    `DELETE FROM "${schema}".pay_slips WHERE id::text = ANY($1::text[])`,
    [ids],
  )
  return {
    ok: true,
    deletedPaySlips: deleted?.rowCount ?? ids.length,
    restoredExpenses: expenses?.rowCount ?? 0,
    restoredSettlements: settlements?.rowCount ?? 0,
  }
}

/** Erreur métier levée dans la transaction de remise en préparation. */
export class PayrollResetConflict extends Error {
  constructor(message: string, readonly lockedPaySlips = 0) { super(message) }
}

/**
 * Renvoie une période « en validation » en préparation (statut open), dans
 * une transaction : bulletins défaits, validations partielles purgées,
 * initiation effacée. `reason` = motif du rejet (null pour une annulation).
 */
export async function resetPendingPeriod(
  schema: string, periodId: string, reason: string | null, opts: { requireNoApproval?: boolean } = {},
): Promise<Extract<RevertResult, { ok: true }>> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Verrou + garde de concurrence : seule une période encore en validation est remise en préparation.
    const upd = await client.query<{ id: string }>(
      `UPDATE "${schema}".pay_periods
          SET status = 'open', rejection_reason = $2, initiated_at = NULL, initiated_by = NULL,
              total_gross = NULL, total_net = NULL, total_cnps = NULL, total_its = NULL
        WHERE id = $1 AND status = 'pending_validation'
        RETURNING id`,
      [periodId, reason],
    )
    if (!upd?.rows?.[0]) throw new PayrollResetConflict('La période n\'est plus en validation (déjà traitée entre-temps). Rechargez la page.')
    if (opts.requireNoApproval) {
      const cnt = await client.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM "${schema}".pay_period_approvals WHERE period_id = $1`, [periodId],
      )
      if (Number(cnt?.rows?.[0]?.cnt ?? 0) > 0) {
        throw new PayrollResetConflict('Un niveau a déjà été validé : l\'initiation ne peut plus être annulée. Demandez au valideur de renvoyer la période en préparation.')
      }
    }
    const revert = await revertPeriodPayslips(client, schema, periodId)
    if (!revert.ok) {
      throw new PayrollResetConflict(
        `${revert.lockedPaySlips} bulletin(s) de cette période sont déjà payés ou en cours de paiement : la période ne peut plus être renvoyée en préparation.`,
        revert.lockedPaySlips,
      )
    }
    await client.query(`DELETE FROM "${schema}".pay_period_approvals WHERE period_id = $1`, [periodId])
    await client.query('COMMIT')
    return revert
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/** Résultat du renvoi en préparation d'une paie multi-filiales. */
export interface MultiSiteResetResult {
  deletedPaySlips: number
  restoredExpenses: number
  restoredSettlements: number
  /** Filiales (périodes filles) rouvertes à la soumission de leur RAF. */
  sitesReopened: number
  /** RAF des filiales rouvertes (à prévenir). */
  rafUserIds: string[]
}

/**
 * Renvoie une paie MULTI-FILIALES consolidée « en validation »
 * (validated_central) en préparation, dans UNE transaction :
 *  - période parente → sent_to_sites (initiation, consolidation et totaux effacés) ;
 *  - toutes ses filles → sent_to_sites : bulletins générés supprimés
 *    (revertPeriodPayslips sur la parente ET chaque fille : notes de frais
 *    remises « approuvées », solde de tout compte démarqué) ; chaque RAF
 *    re-soumet sa filiale, ce qui regénère ses bulletins ;
 *  - validations partielles purgées.
 * Refus (PayrollResetConflict, rien n'est modifié — ROLLBACK) si la paie n'est
 * plus en validation (clôturée / traitée entre-temps), si un niveau a déjà
 * validé alors que `requireNoApproval`, ou si un bulletin est payé / en paiement.
 * `reason` = motif du rejet (null pour une annulation de l'initiation).
 */
export async function resetMultiSitePeriod(
  schema: string, parentId: string, reason: string | null, opts: { requireNoApproval?: boolean } = {},
): Promise<MultiSiteResetResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Verrou + garde de concurrence : seule une parente encore en validation est rouverte.
    const upd = await client.query<{ id: string }>(
      `UPDATE "${schema}".pay_periods
          SET status = 'sent_to_sites', rejection_reason = $2, initiated_at = NULL, initiated_by = NULL,
              validated_central_at = NULL, validated_by = NULL,
              total_gross = NULL, total_net = NULL, total_cnps = NULL, total_its = NULL
        WHERE id = $1 AND parent_period_id IS NULL AND status = 'validated_central'
        RETURNING id`,
      [parentId, reason],
    )
    if (!upd?.rows?.[0]) throw new PayrollResetConflict('La paie n\'est plus en validation (déjà clôturée ou traitée entre-temps). Rechargez la page.')
    if (opts.requireNoApproval) {
      const cnt = await client.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM "${schema}".pay_period_approvals WHERE period_id = $1`, [parentId],
      )
      if (Number(cnt?.rows?.[0]?.cnt ?? 0) > 0) {
        throw new PayrollResetConflict('Un niveau a déjà été validé : l\'initiation ne peut plus être annulée. Demandez au valideur de renvoyer la paie en préparation.')
      }
    }
    const children = await client.query<{ id: string; raf_user_id: string | null }>(
      `SELECT id, raf_user_id FROM "${schema}".pay_periods WHERE parent_period_id = $1 ORDER BY id FOR UPDATE`,
      [parentId],
    )
    const childRows = children?.rows ?? []
    const totals = { deletedPaySlips: 0, restoredExpenses: 0, restoredSettlements: 0 }
    let locked = 0
    for (const periodId of [parentId, ...childRows.map(c => String(c.id))]) {
      const revert = await revertPeriodPayslips(client, schema, periodId)
      if (!revert.ok) { locked += revert.lockedPaySlips; continue }
      totals.deletedPaySlips += revert.deletedPaySlips
      totals.restoredExpenses += revert.restoredExpenses
      totals.restoredSettlements += revert.restoredSettlements
    }
    if (locked > 0) {
      throw new PayrollResetConflict(
        `${locked} bulletin(s) de cette paie sont déjà payés ou en cours de paiement : elle ne peut plus être renvoyée en préparation.`,
        locked,
      )
    }
    await client.query(
      `UPDATE "${schema}".pay_periods
          SET status = 'sent_to_sites', rejection_reason = $2, completed_by_site_at = NULL,
              validated_central_at = NULL, validated_by = NULL,
              total_gross = NULL, total_net = NULL, total_cnps = NULL, total_its = NULL
        WHERE parent_period_id = $1`,
      [parentId, reason],
    )
    await client.query(`DELETE FROM "${schema}".pay_period_approvals WHERE period_id = $1`, [parentId])
    await client.query('COMMIT')
    return {
      ...totals,
      sitesReopened: childRows.length,
      rafUserIds: [...new Set(childRows.map(c => c.raf_user_id).filter((x): x is string => !!x).map(String))],
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
