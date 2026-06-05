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
    `INSERT INTO "${schema}".onboarding_journeys (employee_id, template_id, template_name, status, created_by)
     VALUES ($1, $2, $3, 'in_progress', $4) RETURNING id`,
    [employee.id, template.id, template.name, createdBy],
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
