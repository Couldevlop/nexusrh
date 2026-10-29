/**
 * Alertes des VALIDEURS du circuit de clôture de paie (mono-entité ET
 * multi-filiales — voir payroll-validation.service pour le circuit).
 *
 *  1. Alerte à l'entrée d'un niveau en attente (initiation / consolidation,
 *     validation du niveau précédent, ré-initiation après rejet) : TOUS les
 *     valideurs ÉLIGIBLES sont prévenus — in-app (table notifications) et email
 *     via le SMTP du tenant (repli SMTP plateforme), sans jamais faire échouer
 *     la route appelante.
 *  2. Relance unique : un balayage périodique (planification BullMQ hébergée
 *     par l'API, payroll-reminder.scheduler) relance une fois par niveau et par
 *     fenêtre (période × niveau × entrée dans le niveau) les valideurs d'un
 *     niveau dont l'échéance est à moins de 24 h ou dépassée. Idempotence et
 *     sûreté multi-réplicas : réservation par INSERT … ON CONFLICT DO NOTHING
 *     dans pay_period_reminders AVANT l'envoi.
 *
 * Éligibilité = EXACTEMENT les règles SoD de decidePayrollActor (aucune
 * duplication) : un utilisateur actif est alerté s'il pourrait valider le
 * niveau maintenant. Concrètement : le valideur désigné disponible ; sinon (ou
 * une fois l'échéance dépassée) l'équipe RH (admin / hr_manager) hors
 * initiateur et hors approbateurs des niveaux précédents.
 *
 * Confidentialité : messages et emails ne portent que le mois, le niveau,
 * l'échéance et un lien — aucune donnée salariale nominative.
 */
import { config } from '../config.js'
import { pool } from '../db/pool.js'
import { ensureTenantSchema } from '../utils/schema-migrations.js'
import { sendPayrollValidationEmail } from './email.js'
import { loadTenantMailBySchema } from './tenant-mail.service.js'
import {
  PAYROLL_TEAM_ROLES, asValidationPeriod, decidePayrollActor, loadPayrollCircuit, loadPayrollUsers,
  loadPeriodApprovals, notifyPayrollUser, payrollLevelState,
  type PayrollLevelState, type PeriodValidationRow, type Queryable,
} from './payroll-validation.service.js'

const HOUR_MS = 3_600_000
/** Fenêtre de relance : échéance à moins de 24 h, ou dépassée. */
export const PAYROLL_REMINDER_WINDOW_MS = 24 * HOUR_MS
const SAFE_SCHEMA = /^[a-z0-9_]{1,63}$/
const MAX_TENANTS = 500

export type PayrollAlertKind = 'requested' | 'reminder'
export type PayrollAlertScope = 'mono' | 'multi_sites'

export interface ValidatorCandidate {
  id: string
  role: string
  isActive: boolean
  email: string | null
  firstName: string | null
  lastName: string | null
}

/**
 * Valideurs à alerter pour le niveau courant : chaque candidat actif que
 * decidePayrollActor autoriserait à agir (même règle que l'action elle-même —
 * initiateur et approbateurs précédents exclus, désigné prioritaire).
 */
export function eligibleValidators<T extends Pick<ValidatorCandidate, 'id' | 'role' | 'isActive'>>(
  state: PayrollLevelState, candidates: readonly T[],
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const c of candidates) {
    const id = String(c.id)
    if (!c.isActive || seen.has(id)) continue
    seen.add(id)
    if (decidePayrollActor(state, { userId: id, role: c.role }).allowed) out.push(c)
  }
  return out
}

/** Comptes susceptibles de valider : équipe RH active + valideur désigné du niveau. */
export async function loadValidatorCandidates(db: Queryable, schema: string, designatedUserId: string | null): Promise<ValidatorCandidate[]> {
  const r = await db.query<{
    id: string; role: string; is_active: boolean | null; email: string | null
    first_name: string | null; last_name: string | null
  }>(
    `SELECT id, role, is_active, email, first_name, last_name FROM "${schema}".users
      WHERE COALESCE(is_active, true) AND (role = ANY($1::text[]) OR id::text = $2)`,
    [[...PAYROLL_TEAM_ROLES], designatedUserId ?? ''],
  )
  return (r?.rows ?? []).map(u => ({
    id: String(u.id), role: u.role, isActive: u.is_active !== false,
    email: u.email, firstName: u.first_name, lastName: u.last_name,
  }))
}

/** « 2026-10 » → « octobre 2026 » (repli : la valeur brute). */
export function formatPayrollMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return month
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function formatDue(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('fr-FR', {
    timeZone: 'Africa/Abidjan', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** Écran où le valideur agit. */
export function payrollActionUrl(scope: PayrollAlertScope): string {
  return `${config.appUrl}${scope === 'multi_sites' ? '/payroll/multi-filiales' : '/payroll'}`
}

export interface PayrollAlertContext {
  schema: string
  periodId: string
  month: string
  scope: PayrollAlertScope
  kind: PayrollAlertKind
  state: PayrollLevelState
}

export interface PayrollAlertResult {
  recipients: number
  emailed: number
  emailFailed: number
}

function inAppMessage(ctx: PayrollAlertContext, monthLabel: string, dueLabel: string | null): { title: string; message: string } {
  const { state, kind, scope } = ctx
  const what = `La paie ${scope === 'multi_sites' ? 'multi-filiales ' : ''}${monthLabel}`
  const lvl = `niveau ${state.level}/${state.requiredLevels}`
  if (kind === 'reminder') {
    return state.overdue
      ? { title: 'Relance : paie à valider (échéance dépassée)', message: `${what} attend toujours votre validation (${lvl}) : l'échéance${dueLabel ? ` du ${dueLabel}` : ''} est dépassée.` }
      : { title: 'Relance : paie à valider', message: `${what} attend votre validation (${lvl}) avant le ${dueLabel ?? 'terme de l\'échéance'}.` }
  }
  return { title: 'Paie à valider', message: `${what} attend votre validation (${lvl})${dueLabel ? `. Échéance : ${dueLabel}` : ''}.` }
}

/**
 * Alerte les valideurs éligibles du niveau courant (in-app + email). Ne lève
 * jamais : un échec email est compté, pas propagé.
 */
export async function alertPayrollValidators(ctx: PayrollAlertContext): Promise<PayrollAlertResult> {
  const result: PayrollAlertResult = { recipients: 0, emailed: 0, emailFailed: 0 }
  let recipients: ValidatorCandidate[]
  try {
    const designated = ctx.state.designatedAvailable ? ctx.state.designated?.userId ?? null : null
    recipients = eligibleValidators(ctx.state, await loadValidatorCandidates(pool, ctx.schema, designated))
  } catch {
    return result
  }
  result.recipients = recipients.length
  if (recipients.length === 0) return result

  const monthLabel = formatPayrollMonth(ctx.month)
  const dueLabel = formatDue(ctx.state.dueAt)
  const { title, message } = inAppMessage(ctx, monthLabel, dueLabel)
  const type = ctx.kind === 'reminder' ? 'payroll_validation_reminder' : 'payroll_validation_requested'
  const data = {
    month: ctx.month, periodId: ctx.periodId, level: ctx.state.level,
    ...(ctx.scope === 'multi_sites' ? { scope: 'multi_sites' } : {}),
  }
  for (const r of recipients) notifyPayrollUser(ctx.schema, r.id, type, title, message, data)

  const withEmail = recipients.filter(r => !!r.email)
  if (withEmail.length === 0) return result
  const mail = await loadTenantMailBySchema(ctx.schema).catch(() => null)
  // Ni SMTP tenant ni SMTP plateforme authentifié : in-app seulement.
  if (!mail?.smtp && !config.smtp?.user) return result
  const actionUrl = payrollActionUrl(ctx.scope)
  for (const r of withEmail) {
    try {
      await sendPayrollValidationEmail({
        to: r.email as string, firstName: r.firstName, tenantName: mail?.name || 'NexusRH CI',
        primaryColor: mail?.primaryColor ?? null, monthLabel, level: ctx.state.level,
        requiredLevels: ctx.state.requiredLevels, dueLabel, overdue: ctx.state.overdue, kind: ctx.kind,
        multiSites: ctx.scope === 'multi_sites', actionUrl,
        from: mail?.from, replyTo: mail?.from, smtp: mail?.smtp ?? null,
      })
      result.emailed++
    } catch {
      result.emailFailed++
    }
  }
  return result
}

/** Variante « fire-and-forget » pour les routes : ne bloque ni ne fait échouer la réponse. */
export function notifyPayrollValidators(ctx: PayrollAlertContext): void {
  void alertPayrollValidators(ctx).catch(() => undefined)
}

/** Le niveau doit-il être relancé maintenant ? (échéance < 24 h ou dépassée) */
export function reminderDue(state: PayrollLevelState | null, now: Date, windowMs = PAYROLL_REMINDER_WINDOW_MS): state is PayrollLevelState {
  if (!state?.dueAt || !state.enteredAt) return false
  const due = Date.parse(state.dueAt)
  return Number.isFinite(due) && due - now.getTime() <= windowMs
}

interface PendingPeriodRow extends PeriodValidationRow { month: string }

/**
 * Relance (une seule fois par période × niveau × entrée dans le niveau) les
 * valideurs des périodes en attente d'un tenant. Retourne le nombre de relances.
 */
export async function sweepTenantPayrollReminders(schema: string, now: Date = new Date()): Promise<number> {
  const r = await pool.query<PendingPeriodRow>(
    `SELECT id, month, status, initiated_by, initiated_at, validated_by, validated_central_at
       FROM "${schema}".pay_periods
      WHERE parent_period_id IS NULL AND status IN ('pending_validation', 'validated_central')`,
  )
  const rows = r?.rows ?? []
  if (rows.length === 0) return 0
  const circuit = await loadPayrollCircuit(pool, schema)
  const approvals = await loadPeriodApprovals(pool, schema, rows.map(p => String(p.id)))
  const users = await loadPayrollUsers(pool, schema, circuit.steps.map(s => s.userId))
  let sent = 0
  for (const row of rows) {
    const id = String(row.id)
    const state = payrollLevelState(circuit, asValidationPeriod(row), approvals.get(id) ?? [], users, now)
    if (!reminderDue(state, now)) continue
    // Réservation AVANT l'envoi : deux balayages concurrents (réplicas) ne
    // relancent jamais deux fois le même niveau de la même fenêtre.
    const claim = await pool.query<{ id: string }>(
      `INSERT INTO "${schema}".pay_period_reminders (period_id, level, window_start)
       VALUES ($1, $2, $3) ON CONFLICT (period_id, level, window_start) DO NOTHING RETURNING id`,
      [id, state.level, state.enteredAt],
    )
    const claimId = claim?.rows?.[0]?.id
    if (!claimId) continue
    const res = await alertPayrollValidators({
      schema, periodId: id, month: row.month, scope: row.status === 'validated_central' ? 'multi_sites' : 'mono',
      kind: 'reminder', state,
    })
    await pool.query(
      `UPDATE "${schema}".pay_period_reminders SET recipients = $2, emailed = $3 WHERE id = $1`,
      [claimId, res.recipients, res.emailed],
    ).catch(() => undefined)
    sent++
  }
  return sent
}

export interface ReminderSweepSummary { tenants: number; reminders: number; failedTenants: number }

/** Balayage de tous les tenants actifs (pannes isolées par tenant). */
export async function runPayrollValidationReminders(
  now: Date = new Date(), log?: { error: (obj: unknown, msg?: string) => void },
): Promise<ReminderSweepSummary> {
  const summary: ReminderSweepSummary = { tenants: 0, reminders: 0, failedTenants: 0 }
  const tenants = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM platform.tenants
      WHERE status NOT IN ('rejected', 'suspended', 'cancelled') AND schema_name IS NOT NULL
      LIMIT $1`,
    [MAX_TENANTS],
  )
  for (const t of tenants?.rows ?? []) {
    const schema = t.schema_name
    if (!SAFE_SCHEMA.test(schema)) continue
    try {
      await ensureTenantSchema(schema)
      summary.reminders += await sweepTenantPayrollReminders(schema, now)
      summary.tenants++
    } catch (err) {
      summary.failedTenants++
      log?.error({ err, schema }, 'payroll reminder sweep failed for tenant')
    }
  }
  return summary
}
