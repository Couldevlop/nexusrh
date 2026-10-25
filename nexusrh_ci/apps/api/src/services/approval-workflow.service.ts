/**
 * Circuit de validation hiérarchique → RH (absences, notes de frais).
 *
 * Le tenant règle le nombre de niveaux HIÉRARCHIQUES (workflow_configs.levels_count,
 * Paramètres → Workflow) : 1 = N+1, 2 = N+1 puis N+2, … La décision finale
 * revient TOUJOURS à l'équipe RH : la demande « atterrit » chez elle.
 *
 * Le circuit s'adapte au cas réel :
 *  - un niveau hiérarchique inexistant (pas de N+2…) est sauté ;
 *  - un responsable qui saisit pour son équipe vaut visa de son niveau (et des
 *    niveaux inférieurs) ;
 *  - personne ne valide ni ne refuse sa propre demande (RH et managers sont
 *    aussi des salariés).
 *
 * Échéances (SLA, workflow_configs.config) : 1 jour par niveau hiérarchique,
 * 2 jours pour la RH ; une étape en retard déclenche les rappels (popup +
 * bannière du valideur). Les visas hiérarchiques ne se court-circuitent pas.
 * À l'étape RH, le valideur RH désigné (s'il est paramétré) agit ; échéance
 * dépassée, n'importe quel membre de l'équipe RH peut valider (escalade,
 * tracée dans l'audit).
 *
 * Visibilité RH (HR_VISIBILITY) : une absence n'apparaît à la RH qu'une fois
 * les visas hiérarchiques obtenus ; une note de frais lui est visible dès la
 * soumission, en lecture seule tant qu'elle n'est pas à son niveau.
 */
import type { Pool } from 'pg'

export type ApprovalModule = 'absences' | 'expenses'

/** Quand une demande en attente devient visible de l'équipe RH. */
export const HR_VISIBILITY: Record<ApprovalModule, 'at_hr_step' | 'from_submission'> = {
  absences: 'at_hr_step',
  expenses: 'from_submission',
}

/**
 * Une demande en attente est-elle visible d'un membre de l'équipe RH ?
 * (Il la voit aussi s'il en est lui-même le valideur hiérarchique.)
 */
export function hrCanSee(module: ApprovalModule, summary: WorkflowSummary): boolean {
  if (summary.next === null || summary.canAct) return true
  return HR_VISIBILITY[module] === 'from_submission' || summary.next.kind === 'hr'
}

/** Rôles de l'équipe RH habilités à la décision finale. */
export const HR_DECISION_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const

/** Bornes du nombre de niveaux hiérarchiques (aligné sur Paramètres → Workflow). */
const MIN_LEVELS = 1
const MAX_LEVELS = 10
const DAY_MS = 86_400_000

export type WorkflowStep =
  | { kind: 'manager'; level: number; approverEmployeeId: string }
  | { kind: 'hr' }

export interface ApprovalTrailEntry {
  step: number
  kind: 'manager' | 'hr'
  by: string
  byEmployeeId: string | null
  at: string
  override?: boolean
  onCreation?: boolean
}

export type DenialReason = 'self' | 'not_your_step' | 'awaiting_designated'

export type ActorDecision =
  | { allowed: true; override: boolean }
  | { allowed: false; reason: DenialReason }

export interface Actor { role: string; employeeId: string | null; userId: string }

/** Délai de prévenance des absences planifiables. */
export interface NoticeRules {
  enabled: boolean
  /** Types soumis au préavis (codes absence_types). */
  typeCodes: string[]
  shortMinDays: number
  shortMaxDays: number
  shortNoticeDays: number
  longNoticeDays: number
}

/** Paramètres du circuit, stockés dans workflow_configs (levels_count + config jsonb). */
export interface WorkflowSettings {
  levels: number
  managerSlaDays: number
  hrSlaDays: number
  /** Valideur RH désigné (users.id) ; null = toute l'équipe RH d'emblée. */
  hrValidatorUserId: string | null
  notice: NoticeRules
}

export const DEFAULT_NOTICE: NoticeRules = {
  enabled: true, typeCodes: ['CP', 'SANS_SOLDE'],
  shortMinDays: 2, shortMaxDays: 5, shortNoticeDays: 7, longNoticeDays: 30,
}

export const DEFAULT_SETTINGS: WorkflowSettings = {
  levels: 1, managerSlaDays: 1, hrSlaDays: 2, hrValidatorUserId: null, notice: DEFAULT_NOTICE,
}

export function isHrDecisionRole(role: string): boolean {
  return (HR_DECISION_ROLES as readonly string[]).includes(role)
}

export function clampLevels(levels: number | null | undefined): number {
  const n = Number.isFinite(levels) ? Math.trunc(Number(levels)) : MIN_LEVELS
  return Math.min(MAX_LEVELS, Math.max(MIN_LEVELS, n))
}

/**
 * Responsables successifs (N+1, N+2, …) de `employeeId`, au plus `depth`.
 * S'arrête sur un trou ou un cycle dans les manager_id.
 */
export function managerChain(
  employeeId: string,
  managerOf: ReadonlyMap<string, string | null>,
  depth: number,
): string[] {
  const chain: string[] = []
  const seen = new Set<string>([employeeId])
  let current = managerOf.get(employeeId) ?? null
  while (current && chain.length < depth && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current = managerOf.get(current) ?? null
  }
  return chain
}

/** Étapes du circuit : niveaux hiérarchiques existants puis décision RH. */
export function planSteps(levels: number, chain: readonly string[]): WorkflowStep[] {
  const steps: WorkflowStep[] = chain
    .slice(0, clampLevels(levels))
    .map((approverEmployeeId, i) => ({ kind: 'manager' as const, level: i + 1, approverEmployeeId }))
  steps.push({ kind: 'hr' })
  return steps
}

/** Circuit complet d'une demande de `requesterEmployeeId`. */
export function stepsFor(
  levels: number,
  managerOf: ReadonlyMap<string, string | null>,
  requesterEmployeeId: string,
): WorkflowStep[] {
  return planSteps(levels, managerChain(requesterEmployeeId, managerOf, clampLevels(levels)))
}

/** Étape courante d'une demande ayant franchi `validationLevel` étapes. */
export function currentStep(steps: readonly WorkflowStep[], validationLevel: number): { index: number; step: WorkflowStep } {
  const index = Math.min(Math.max(0, validationLevel), steps.length - 1)
  return { index, step: steps[index]! }
}

/** Échéance de l'étape entrée à `enteredAt`. */
export function stepDueAt(step: WorkflowStep, enteredAt: Date, settings: Pick<WorkflowSettings, 'managerSlaDays' | 'hrSlaDays'>): Date {
  const days = step.kind === 'hr' ? settings.hrSlaDays : settings.managerSlaDays
  return new Date(enteredAt.getTime() + days * DAY_MS)
}

/** Début de l'étape courante : dernière action du circuit, sinon la soumission. */
export function stepEnteredAt(trail: readonly ApprovalTrailEntry[] | null | undefined, submittedAt: Date): Date {
  const last = (Array.isArray(trail) ? trail : []).reduce<number>((max, e) => Math.max(max, Date.parse(e.at) || 0), 0)
  return new Date(Math.max(last, submittedAt.getTime()))
}

/**
 * L'acteur peut-il agir (valider ou refuser) à cette étape ?
 * `overdue` : l'échéance (SLA) de l'étape est dépassée.
 */
export function decideActor(
  step: WorkflowStep,
  actor: Actor,
  requesterEmployeeId: string,
  ctx: { overdue: boolean; hrValidatorUserId: string | null } = { overdue: false, hrValidatorUserId: null },
): ActorDecision {
  if (actor.employeeId && actor.employeeId === requesterEmployeeId) return { allowed: false, reason: 'self' }
  // Étape hiérarchique : seul le responsable concerné vise (la RH n'agit
  // qu'une fois la demande arrivée à son niveau ; les retards sont relancés).
  if (step.kind === 'manager') {
    if (actor.employeeId && actor.employeeId === step.approverEmployeeId) return { allowed: true, override: false }
    return { allowed: false, reason: 'not_your_step' }
  }
  if (!isHrDecisionRole(actor.role)) return { allowed: false, reason: 'not_your_step' }
  if (!ctx.hrValidatorUserId || ctx.hrValidatorUserId === actor.userId) return { allowed: true, override: false }
  // Valideur RH désigné en retard : toute l'équipe RH prend la main (escalade).
  if (ctx.overdue) return { allowed: true, override: true }
  return { allowed: false, reason: 'awaiting_designated' }
}

/**
 * Étapes déjà franchies à la création : un responsable de la chaîne qui saisit
 * pour son collaborateur vaut visa jusqu'à son niveau inclus.
 */
export function initialValidationLevel(
  steps: readonly WorkflowStep[],
  creatorEmployeeId: string | null,
  requesterEmployeeId: string,
): number {
  if (!creatorEmployeeId || creatorEmployeeId === requesterEmployeeId) return 0
  const idx = steps.findIndex((s) => s.kind === 'manager' && s.approverEmployeeId === creatorEmployeeId)
  return idx >= 0 ? idx + 1 : 0
}

/** Libellé lisible d'une étape (messages d'erreur, audit). */
export function stepLabel(step: WorkflowStep): string {
  return step.kind === 'hr' ? 'validation RH' : `visa du N+${step.level}`
}

/** Message d'erreur d'un refus d'action (`noun` : « absence », « note de frais »). */
export function denialMessage(reason: DenialReason, step: WorkflowStep, noun: string): string {
  if (reason === 'self') return `Vous ne pouvez pas valider ni refuser votre propre ${noun}`
  if (reason === 'awaiting_designated') {
    return `Cette ${noun} est assignée au valideur RH désigné : le reste de l'équipe RH pourra la traiter une fois l'échéance dépassée.`
  }
  return `Cette ${noun} attend le ${stepLabel(step)} : elle n'est pas à votre étape (équipe directe / circuit de validation).`
}

/**
 * Délai de prévenance d'une absence planifiable : 2 à 5 jours → 7 jours
 * avant ; au-delà → 1 mois avant. Renvoie le message d'erreur, ou null.
 */
export function checkNotice(
  rules: NoticeRules,
  typeCode: string | null | undefined,
  days: number,
  startDate: string,
  today: Date,
): string | null {
  if (!rules.enabled || !typeCode || !rules.typeCodes.includes(typeCode)) return null
  if (days < rules.shortMinDays) return null
  const long = days > rules.shortMaxDays
  const required = long ? rules.longNoticeDays : rules.shortNoticeDays
  const startUtc = Date.parse(`${startDate}T00:00:00Z`)
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const noticeDays = Math.floor((startUtc - todayUtc) / DAY_MS)
  if (noticeDays >= required) return null
  const scope = long
    ? `de plus de ${rules.shortMaxDays} jours`
    : `de ${rules.shortMinDays} à ${rules.shortMaxDays} jours`
  return `Une absence ${scope} se déclare au moins ${required} jours à l'avance (prévenance actuelle : ${Math.max(0, noticeDays)} j).`
}

function boundedInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/** Normalise la config jsonb (valeurs absentes ou invalides → défauts). */
export function parseWorkflowSettings(levels: unknown, raw: unknown): WorkflowSettings {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const n = (c.notice && typeof c.notice === 'object' ? c.notice : {}) as Record<string, unknown>
  const codes = Array.isArray(n.typeCodes)
    ? n.typeCodes.filter((x): x is string => typeof x === 'string')
    : DEFAULT_NOTICE.typeCodes
  return {
    levels: clampLevels(typeof levels === 'number' ? levels : MIN_LEVELS),
    managerSlaDays: boundedInt(c.managerSlaDays, DEFAULT_SETTINGS.managerSlaDays, 1, 30),
    hrSlaDays: boundedInt(c.hrSlaDays, DEFAULT_SETTINGS.hrSlaDays, 1, 30),
    hrValidatorUserId: typeof c.hrValidatorUserId === 'string' && c.hrValidatorUserId ? c.hrValidatorUserId : null,
    notice: {
      enabled: typeof n.enabled === 'boolean' ? n.enabled : DEFAULT_NOTICE.enabled,
      typeCodes: codes,
      shortMinDays: boundedInt(n.shortMinDays, DEFAULT_NOTICE.shortMinDays, 1, 365),
      shortMaxDays: boundedInt(n.shortMaxDays, DEFAULT_NOTICE.shortMaxDays, 1, 365),
      shortNoticeDays: boundedInt(n.shortNoticeDays, DEFAULT_NOTICE.shortNoticeDays, 0, 365),
      longNoticeDays: boundedInt(n.longNoticeDays, DEFAULT_NOTICE.longNoticeDays, 0, 365),
    },
  }
}

/** Paramètres du circuit du module pour le tenant (défauts si absents). */
export async function loadWorkflowSettings(pool: Pool, schema: string, module: ApprovalModule): Promise<WorkflowSettings> {
  try {
    const r = await pool.query<{ levels_count: number; config: unknown }>(
      `SELECT levels_count, config FROM "${schema}".workflow_configs WHERE module = $1 LIMIT 1`, [module],
    )
    const row = r?.rows?.[0]
    return parseWorkflowSettings(row?.levels_count ?? MIN_LEVELS, row?.config)
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Table employé → responsable direct du tenant (une requête, parcours en mémoire). */
export async function loadManagerMap(pool: Pool, schema: string): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  try {
    const r = await pool.query<{ id: string; manager_id: string | null }>(
      `SELECT id, manager_id FROM "${schema}".employees`,
    )
    for (const row of r?.rows ?? []) map.set(row.id, row.manager_id ?? null)
  } catch { /* carte vide : seule l'étape RH subsiste */ }
  return map
}

/** Demande soumise au circuit (absence ou note de frais). */
export interface WorkflowRequest {
  employeeId: string
  validationLevel: number
  status: string
  submittedAt: Date
  trail?: ApprovalTrailEntry[] | null
}

export interface Evaluation {
  steps: WorkflowStep[]
  index: number
  step: WorkflowStep
  dueAt: Date
  overdue: boolean
  decision: ActorDecision
}

/** État d'une demande pour un acteur : étape, échéance, droit d'agir. */
export function evaluateRequest(
  settings: WorkflowSettings,
  managerOf: ReadonlyMap<string, string | null>,
  request: WorkflowRequest,
  actor: Actor,
  now: Date = new Date(),
): Evaluation {
  const steps = stepsFor(settings.levels, managerOf, request.employeeId)
  const { index, step } = currentStep(steps, request.validationLevel)
  const dueAt = stepDueAt(step, stepEnteredAt(request.trail, request.submittedAt), settings)
  const overdue = now.getTime() > dueAt.getTime()
  const decision = decideActor(step, actor, request.employeeId, { overdue, hrValidatorUserId: settings.hrValidatorUserId })
  return { steps, index, step, dueAt, overdue, decision }
}

/** Résumé exposé à l'UI pour une demande. */
export interface WorkflowSummary {
  totalSteps: number
  doneSteps: number
  next: { kind: 'manager'; level: number; approverEmployeeId: string } | { kind: 'hr' } | null
  dueAt: string | null
  overdue: boolean
  canAct: boolean
  /** L'utilisateur est le valideur désigné de l'étape (sinon : escalade). */
  designated: boolean
}

export function summarize(
  settings: WorkflowSettings,
  managerOf: ReadonlyMap<string, string | null>,
  request: WorkflowRequest,
  actor: Actor,
  now: Date = new Date(),
): WorkflowSummary {
  const ev = evaluateRequest(settings, managerOf, request, actor, now)
  if (request.status !== 'submitted') {
    return { totalSteps: ev.steps.length, doneSteps: ev.steps.length, next: null, dueAt: null, overdue: false, canAct: false, designated: false }
  }
  const designated = ev.step.kind === 'manager'
    ? actor.employeeId === ev.step.approverEmployeeId
    : isHrDecisionRole(actor.role) && (!settings.hrValidatorUserId || settings.hrValidatorUserId === actor.userId)
  return {
    totalSteps: ev.steps.length,
    doneSteps: ev.index,
    next: ev.step.kind === 'hr'
      ? { kind: 'hr' }
      : { kind: 'manager', level: ev.step.level, approverEmployeeId: ev.step.approverEmployeeId },
    dueAt: ev.dueAt.toISOString(),
    overdue: ev.overdue,
    canAct: ev.decision.allowed,
    designated: designated && ev.decision.allowed,
  }
}

/** Entrée de piste d'audit pour une action à l'étape `index`. */
export function trailEntry(
  index: number, step: WorkflowStep, actor: Actor, override: boolean, now: Date = new Date(),
): ApprovalTrailEntry {
  return {
    step: index + 1, kind: step.kind, by: actor.userId, byEmployeeId: actor.employeeId,
    at: now.toISOString(), ...(override ? { override: true } : {}),
  }
}
