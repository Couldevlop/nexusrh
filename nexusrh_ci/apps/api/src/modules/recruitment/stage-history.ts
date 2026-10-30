/**
 * Entonnoir de recrutement fiable — historique des étapes et motifs de rejet.
 *
 * Chaque changement de `applications.stage` laisse une ligne dans
 * `application_stage_history` (from_stage → to_stage, auteur, horodatage). Les
 * écritures sont faites DANS la même instruction SQL que le changement d'étape
 * (CTE) : l'historique ne peut pas diverger de l'état courant, et les handlers
 * gardent le même nombre d'appels à la base.
 */

/** Étapes ordonnées de l'entonnoir (hors `rejected`, qui est une sortie). */
export const FUNNEL_STAGES = ['new', 'screening', 'interview', 'test', 'offer', 'hired'] as const
export type FunnelStage = typeof FUNNEL_STAGES[number]

/** Liste FERMÉE des motifs de rejet (contrôlée par Zod ET par une contrainte CHECK). */
export const REJECTION_REASONS = [
  'declined_by_candidate_salary',
  'declined_by_candidate_other_offer',
  'declined_by_candidate_delay',
  'declined_by_candidate_other',
  'rejected_profile',
  'rejected_after_interview',
  'rejected_auto_screening',
  'position_closed',
  'other',
] as const
export type RejectionReason = typeof REJECTION_REASONS[number]

/** Préfixe commun des motifs « le candidat a décliné ». */
export const DECLINED_BY_CANDIDATE_PREFIX = 'declined_by_candidate_'

export const REJECTION_NOTE_MAX = 500

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Auteur d'un changement d'étape, tel qu'écrit dans `changed_by uuid`. Un
 * identifiant non UUID (jeton technique) devient NULL plutôt que de faire
 * échouer l'écriture métier.
 */
export function actorUuid(sub: string | null | undefined): string | null {
  return typeof sub === 'string' && UUID_RE.test(sub) ? sub : null
}

/**
 * Enveloppe un `INSERT INTO applications … RETURNING …` (qui DOIT renvoyer
 * `id` et `stage`) pour écrire l'entrée initiale de l'historique dans la même
 * instruction. `changedByParam` est un placeholder (`$8`) ou `NULL`.
 */
export function withInitialStageHistory(schema: string, insertSql: string, changedByParam: string): string {
  return `WITH ins AS (${insertSql}),
    stage_hist AS (
      INSERT INTO "${schema}".application_stage_history (application_id, from_stage, to_stage, changed_by)
      SELECT ins.id, NULL, COALESCE(ins.stage, 'new'), ${changedByParam}::uuid FROM ins
    )
    SELECT * FROM ins`
}
