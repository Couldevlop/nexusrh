/**
 * Parcours d'intégration — logique métier partagée.
 *
 * - selectBestTemplate : choisit le modèle le plus pertinent pour un nouveau
 *   collaborateur (séniorité, mots-clés du poste, département, modèle par
 *   défaut en repli). Fonction PURE sur les données chargées → testable.
 * - startOnboardingJourney : instancie un parcours + ses étapes (échéances
 *   calculées depuis la date d'embauche) pour un employé.
 * - autoStartOnboarding : déclenché à la création d'un employé (non bloquant) —
 *   meilleure pratique RH : le pré-boarding démarre dès la signature, pas le
 *   jour J.
 */
import type { Pool } from 'pg'

export interface OnboardingTemplateRow {
  id: string
  name: string
  seniority: string
  job_keywords: string | null
  department_id: string | null
  is_active: boolean
  is_default: boolean
}

export interface EmployeeForOnboarding {
  id: string
  job_title: string | null
  job_level: string | null
  department_id: string | null
  hire_date: string | null
}

/**
 * Score de pertinence d'un modèle pour un employé :
 *   +3 séniorité exacte · +1 séniorité 'any'
 *   +2 par mot-clé du modèle présent dans l'intitulé de poste
 *   +2 département identique
 *   +1 modèle par défaut (départage)
 * Retourne null si aucun modèle actif ne s'applique (score nul et non défaut).
 */
export function selectBestTemplate(
  templates: OnboardingTemplateRow[],
  employee: Pick<EmployeeForOnboarding, 'job_title' | 'job_level' | 'department_id'>,
): OnboardingTemplateRow | null {
  const jobTitle = (employee.job_title ?? '').toLowerCase()
  const jobLevel = (employee.job_level ?? '').toLowerCase()

  let best: OnboardingTemplateRow | null = null
  let bestScore = 0
  for (const tpl of templates) {
    if (!tpl.is_active) continue
    let score = 0
    const seniority = (tpl.seniority ?? 'any').toLowerCase()
    if (seniority !== 'any' && jobLevel && seniority === jobLevel) score += 3
    else if (seniority === 'any') score += 1
    else if (seniority !== 'any' && jobLevel && seniority !== jobLevel) {
      // Séniorité explicite qui ne correspond pas : modèle hors-cible.
      continue
    }
    const keywords = (tpl.job_keywords ?? '')
      .split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
    for (const kw of keywords) {
      if (jobTitle.includes(kw)) score += 2
    }
    if (tpl.department_id && employee.department_id && tpl.department_id === employee.department_id) score += 2
    if (tpl.is_default) score += 1
    if (score > bestScore) { best = tpl; bestScore = score }
  }
  return best
}

/** Échéance d'une étape : date d'embauche + offset (jours). Sans date → null. */
export function computeDueDate(hireDate: string | null, offsetDays: number): string | null {
  if (!hireDate) return null
  const d = new Date(`${hireDate}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

/**
 * Instancie un parcours pour un employé depuis un modèle.
 * @returns l'id du parcours créé, ou null si le modèle n'a pas d'étapes.
 */
export async function startOnboardingJourney(
  pool: Pool,
  schema: string,
  employee: EmployeeForOnboarding,
  template: { id: string; name: string },
  createdBy: string | null,
  applicationId: string | null = null,
): Promise<string | null> {
  const steps = await pool.query<{
    title: string; description: string | null; phase: string; owner_role: string
    due_offset_days: number; sort_order: number; resources: unknown
  }>(
    `SELECT title, description, phase, owner_role, due_offset_days, sort_order, resources
     FROM "${schema}".onboarding_template_steps WHERE template_id = $1
     ORDER BY sort_order ASC, created_at ASC`,
    [template.id],
  )
  if (steps.rows.length === 0) return null

  const journey = await pool.query<{ id: string }>(
    `INSERT INTO "${schema}".onboarding_journeys (employee_id, template_id, template_name, status, created_by, application_id)
     VALUES ($1, $2, $3, 'in_progress', $4, $5) RETURNING id`,
    [employee.id, template.id, template.name, createdBy, applicationId],
  )
  const journeyId = journey.rows[0]!.id

  for (const s of steps.rows) {
    await pool.query(
      `INSERT INTO "${schema}".onboarding_steps
         (journey_id, title, description, phase, owner_role, status, due_date, sort_order, resources)
       VALUES ($1, $2, $3, $4, $5, 'todo', $6, $7, $8)`,
      [
        journeyId, s.title, s.description, s.phase, s.owner_role,
        computeDueDate(employee.hire_date, s.due_offset_days), s.sort_order,
        JSON.stringify(s.resources ?? []),
      ],
    )
  }
  return journeyId
}

/**
 * Auto-création du parcours à la création d'un employé.
 * Best-effort : toute erreur est avalée (la création d'employé ne doit JAMAIS
 * échouer à cause de l'onboarding) — l'appelant utilise .catch() en plus.
 */
export async function autoStartOnboarding(
  pool: Pool,
  schema: string,
  employee: EmployeeForOnboarding,
  createdBy: string | null,
): Promise<string | null> {
  // Pas de doublon : un parcours actif existe déjà pour cet employé ?
  const existing = await pool.query(
    `SELECT 1 FROM "${schema}".onboarding_journeys WHERE employee_id = $1 AND status = 'in_progress' LIMIT 1`,
    [employee.id],
  )
  if (existing.rows[0]) return null

  const templates = await pool.query<OnboardingTemplateRow>(
    `SELECT id, name, seniority, job_keywords, department_id, is_active, is_default
     FROM "${schema}".onboarding_templates WHERE is_active = true`,
  )
  const tpl = selectBestTemplate(templates.rows, employee)
  if (!tpl) return null
  return startOnboardingJourney(pool, schema, employee, tpl, createdBy)
}

// ─── Embauche depuis le recrutement : parcours GARANTI ───────────────────────

/** Clé stable du modèle standard intégré (jamais dupliqué : index unique). */
export const BUILTIN_ONBOARDING_TEMPLATE_KEY = 'standard_ci'

export interface BuiltinTemplateStep {
  title: string
  description: string
  phase: 'before_start' | 'day_one' | 'first_week' | 'first_month' | 'probation_end'
  owner_role: 'hr' | 'manager' | 'employee' | 'it' | 'buddy'
  due_offset_days: number
}

/**
 * Contenu du modèle standard, écrit UNE FOIS dans le tenant comme un modèle
 * ordinaire (éditable, désactivable depuis /onboarding) au premier besoin —
 * jamais relu ensuite : c'est la version du tenant qui fait foi.
 */
export const BUILTIN_ONBOARDING_TEMPLATE: { name: string; description: string; steps: BuiltinTemplateStep[] } = {
  name: "Parcours d'intégration standard",
  description: 'Modèle par défaut créé automatiquement à la première embauche sans modèle applicable. Modifiable librement.',
  steps: [
    { title: 'Contrat de travail signé', description: 'Faire signer le contrat (CDI/CDD) et en archiver un exemplaire au dossier.', phase: 'before_start', owner_role: 'hr', due_offset_days: -7 },
    { title: 'Pièces administratives', description: "Collecter la CNI, le numéro CNPS (ou l'immatriculation), le RIB ou le numéro Mobile Money et une photo d'identité.", phase: 'before_start', owner_role: 'hr', due_offset_days: -5 },
    { title: 'Matériel et accès', description: 'Préparer le poste de travail, le matériel et les comptes (messagerie, applications).', phase: 'before_start', owner_role: 'it', due_offset_days: -2 },
    { title: 'Accueil du collaborateur', description: "Accueil, visite des locaux, remise du livret d'accueil et du règlement intérieur.", phase: 'day_one', owner_role: 'hr', due_offset_days: 0 },
    { title: "Présentation à l'équipe", description: 'Présenter le collaborateur à son équipe et à ses interlocuteurs clés.', phase: 'day_one', owner_role: 'manager', due_offset_days: 0 },
    { title: 'Désignation du parrain', description: 'Nommer un parrain ou une marraine et planifier un premier échange.', phase: 'day_one', owner_role: 'manager', due_offset_days: 0 },
    { title: "Objectifs de la période d'essai", description: 'Fixer et partager les objectifs des premières semaines.', phase: 'first_week', owner_role: 'manager', due_offset_days: 5 },
    { title: "Point d'étape — 2 semaines", description: 'Faire le point sur la prise de poste et les besoins éventuels.', phase: 'first_month', owner_role: 'manager', due_offset_days: 14 },
    { title: "Point d'étape — 1 mois", description: 'Bilan du premier mois avec le collaborateur et le parrain.', phase: 'first_month', owner_role: 'hr', due_offset_days: 30 },
    { title: "Entretien de fin de période d'essai", description: "Entretien de validation de la période d'essai, formalisé par écrit.", phase: 'probation_end', owner_role: 'manager', due_offset_days: 90 },
  ],
}

/**
 * Modèle standard du tenant, créé s'il n'existe pas — en UNE instruction
 * (modèle + étapes) pour qu'un lecteur concurrent ne voie jamais un modèle
 * sans étapes. Il devient le modèle par défaut seulement si le tenant n'en a
 * pas déjà un.
 */
export async function ensureBuiltinOnboardingTemplate(
  pool: Pool,
  schema: string,
  createdBy: string | null,
): Promise<{ id: string; name: string; created: boolean }> {
  const inserted = await pool.query<{ id: string; name: string }>(
    `WITH tpl AS (
       INSERT INTO "${schema}".onboarding_templates
         (name, description, seniority, is_active, is_default, created_by, builtin_key)
       SELECT $1, $2, 'any', true,
              NOT EXISTS (SELECT 1 FROM "${schema}".onboarding_templates WHERE is_default = true),
              $3::uuid, $4
       ON CONFLICT (builtin_key) WHERE builtin_key IS NOT NULL DO NOTHING
       RETURNING id, name
     ),
     steps AS (
       INSERT INTO "${schema}".onboarding_template_steps
         (template_id, title, description, phase, owner_role, due_offset_days, sort_order)
       SELECT tpl.id, s.title, s.description, s.phase, s.owner_role, s.due_offset_days, (s.ord - 1)::int
         FROM tpl,
              jsonb_to_recordset($5::jsonb) WITH ORDINALITY
                AS s(title text, description text, phase text, owner_role text, due_offset_days int, ord bigint)
     )
     SELECT id, name FROM tpl`,
    [
      BUILTIN_ONBOARDING_TEMPLATE.name, BUILTIN_ONBOARDING_TEMPLATE.description, createdBy,
      BUILTIN_ONBOARDING_TEMPLATE_KEY, JSON.stringify(BUILTIN_ONBOARDING_TEMPLATE.steps),
    ],
  )
  const created = inserted.rows[0]
  if (created) return { ...created, created: true }
  const existing = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "${schema}".onboarding_templates WHERE builtin_key = $1 LIMIT 1`,
    [BUILTIN_ONBOARDING_TEMPLATE_KEY],
  )
  const row = existing.rows[0]
  if (!row) throw new Error("Modèle d'intégration standard introuvable après création")
  return { ...row, created: false }
}

export interface HireOnboardingResult {
  journeyId: string | null
  /** 'existing' : parcours déjà présent (rejeu, ou parcours en cours de l'employé). */
  outcome: 'existing' | 'template' | 'builtin'
  templateName: string | null
  builtinTemplateCreated: boolean
}

/**
 * Parcours d'intégration d'une EMBAUCHE — toujours créé, un seul par
 * candidature :
 *   1. un parcours déjà lié à la candidature → rien à faire (idempotence) ;
 *   2. un parcours en cours de l'employé (fiche existante) → on le relie ;
 *   3. sinon le meilleur modèle actif (séniorité / mots-clés / département) ;
 *   4. à défaut (aucun modèle, ou modèle sans étape) : le modèle standard du
 *      tenant, créé à la première occasion.
 */
export async function ensureHireOnboarding(
  pool: Pool,
  schema: string,
  employee: EmployeeForOnboarding,
  applicationId: string,
  createdBy: string | null,
): Promise<HireOnboardingResult> {
  const linked = await pool.query<{ id: string; template_name: string | null }>(
    `SELECT id, template_name FROM "${schema}".onboarding_journeys WHERE application_id = $1 LIMIT 1`,
    [applicationId],
  )
  if (linked.rows[0]) {
    return { journeyId: linked.rows[0].id, outcome: 'existing', templateName: linked.rows[0].template_name, builtinTemplateCreated: false }
  }

  const running = await pool.query<{ id: string; template_name: string | null }>(
    `UPDATE "${schema}".onboarding_journeys SET application_id = $2, updated_at = now()
      WHERE id = (SELECT id FROM "${schema}".onboarding_journeys
                   WHERE employee_id = $1 AND status = 'in_progress' AND application_id IS NULL
                   ORDER BY started_at DESC LIMIT 1)
      RETURNING id, template_name`,
    [employee.id, applicationId],
  )
  if (running.rows[0]) {
    return { journeyId: running.rows[0].id, outcome: 'existing', templateName: running.rows[0].template_name, builtinTemplateCreated: false }
  }

  const templates = await pool.query<OnboardingTemplateRow>(
    `SELECT id, name, seniority, job_keywords, department_id, is_active, is_default
     FROM "${schema}".onboarding_templates WHERE is_active = true`,
  )
  const best = selectBestTemplate(templates.rows, employee)
  if (best) {
    const journeyId = await startOnboardingJourney(pool, schema, employee, best, createdBy, applicationId)
    if (journeyId) return { journeyId, outcome: 'template', templateName: best.name, builtinTemplateCreated: false }
  }

  const builtin = await ensureBuiltinOnboardingTemplate(pool, schema, createdBy)
  const journeyId = await startOnboardingJourney(pool, schema, employee, builtin, createdBy, applicationId)
  return { journeyId, outcome: 'builtin', templateName: builtin.name, builtinTemplateCreated: builtin.created }
}

/** Recalcule le statut d'un parcours (terminé si toutes les étapes sont done). */
export async function refreshJourneyStatus(pool: Pool, schema: string, journeyId: string): Promise<void> {
  await pool.query(
    `UPDATE "${schema}".onboarding_journeys j
     SET status = CASE
           WHEN NOT EXISTS (SELECT 1 FROM "${schema}".onboarding_steps s
                            WHERE s.journey_id = j.id AND s.status <> 'done')
           THEN 'completed' ELSE 'in_progress' END,
         completed_at = CASE
           WHEN NOT EXISTS (SELECT 1 FROM "${schema}".onboarding_steps s
                            WHERE s.journey_id = j.id AND s.status <> 'done')
           THEN COALESCE(j.completed_at, now()) ELSE NULL END,
         updated_at = now()
     WHERE j.id = $1 AND j.status <> 'cancelled'`,
    [journeyId],
  )
}
