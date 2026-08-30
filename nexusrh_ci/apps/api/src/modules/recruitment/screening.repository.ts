/**
 * Accès aux données du pré-tri.
 *
 * Le schéma du tenant est reçu UNE FOIS à la construction et validé ici : les
 * appelants ne peuvent plus l'oublier dans une requête, ni le passer sous une
 * forme non conforme. C'est la première application de la direction A-05 de
 * l'audit du 30/08/2026 — 872 requêtes SQL écrites à la main dans les handlers,
 * l'isolation multi-tenant garantie par la répétition plutôt que par la
 * construction — appliquée ici sur du code neuf, sans réécriture de l'existant.
 */
import { pool } from '../../db/pool.js'
import { isValidSchemaName } from '../../utils/schema-name.js'
import {
  sanitizeQuestions, type ScreeningQuestion,
} from '../../services/recruitment-screening.service.js'

/** Ligne de la file de revue — jamais le binaire du CV, seulement le drapeau. */
export interface QueueRow {
  id: string
  first_name: string
  last_name: string
  email: string | null
  screening_verdict: 'pass' | 'flagged'
  screening_failed_rules: string[]
  screening_answers: Record<string, unknown>
  ai_score: number | null
  ai_summary: string | null
  has_cv: boolean
  created_at: string
}

/** Candidature en attente de décision, telle qu'utilisée par l'évaluation. */
export interface PendingRow {
  id: string
  screening_answers: Record<string, unknown> | null
  ai_score: number | null
  ai_years_experience: number | null
  ai_skills: string[] | null
  ai_diploma: string | null
  ai_location: string | null
  ai_languages: string[] | null
  expected_salary: number | null
  ai_analyzed_at: string | null
}

export interface DecideResult {
  id: string
  screening_verdict: 'pass' | 'flagged'
}

export function screeningRepo(schema: string) {
  if (!isValidSchemaName(schema)) {
    throw new Error('Schéma tenant non conforme')
  }
  const s = `"${schema}"`

  return {
    async getQuestions(jobId: string): Promise<ScreeningQuestion[]> {
      const r = await pool.query<{ screening_questions: unknown }>(
        `SELECT screening_questions FROM ${s}.recruitment_jobs WHERE id = $1 LIMIT 1`,
        [jobId],
      )
      return sanitizeQuestions(r.rows[0]?.screening_questions ?? [])
    },

    /** Retourne false si l'offre n'existe pas (le handler répond alors 404). */
    async setQuestions(jobId: string, questions: ScreeningQuestion[]): Promise<boolean> {
      const r = await pool.query<{ id: string }>(
        `UPDATE ${s}.recruitment_jobs
            SET screening_questions = $1, updated_at = now()
          WHERE id = $2 RETURNING id`,
        [JSON.stringify(questions), jobId],
      )
      return r.rows.length > 0
    },

    async getCriteria(jobId: string): Promise<unknown> {
      const r = await pool.query<{ screening_criteria: unknown }>(
        `SELECT screening_criteria FROM ${s}.recruitment_jobs WHERE id = $1 LIMIT 1`,
        [jobId],
      )
      return r.rows[0]?.screening_criteria ?? {}
    },

    /**
     * Candidatures de l'offre encore SANS décision humaine — la matière du
     * recalcul comme de la file de revue.
     */
    async listPending(jobId: string): Promise<PendingRow[]> {
      const r = await pool.query<PendingRow>(
        `SELECT id, screening_answers, ai_score, ai_years_experience, ai_skills,
                ai_diploma, ai_location, ai_languages, expected_salary, ai_analyzed_at
           FROM ${s}.applications
          WHERE job_id = $1 AND screening_decision IS NULL`,
        [jobId],
      )
      return r.rows
    },

    async saveVerdict(
      appId: string,
      verdict: 'pass' | 'flagged',
      failedRules: string[],
    ): Promise<void> {
      await pool.query(
        `UPDATE ${s}.applications
            SET screening_verdict = $1, screening_failed_rules = $2,
                screened_at = now(), updated_at = now()
          WHERE id = $3 AND screening_decision IS NULL`,
        [verdict, JSON.stringify(failedRules), appId],
      )
    },

    /**
     * File de revue. Les dossiers conformes viennent d'abord : on traite le
     * volume simple avant les cas à discuter.
     */
    async queue(jobId: string, limit: number, offset: number): Promise<QueueRow[]> {
      const r = await pool.query<QueueRow>(
        `SELECT id, first_name, last_name, email, screening_verdict,
                screening_failed_rules, screening_answers, ai_score, ai_summary,
                (cv_blob IS NOT NULL) AS has_cv, created_at
           FROM ${s}.applications
          WHERE job_id = $1 AND screening_decision IS NULL
          ORDER BY (screening_verdict = 'flagged'), created_at ASC
          LIMIT $2 OFFSET $3`,
        [jobId, limit, offset],
      )
      return r.rows
    },

    /** Verdict machine seul — lu avant de décider, pour savoir si l'humain le contredit. */
    async getVerdict(appId: string): Promise<'pass' | 'flagged' | null> {
      const r = await pool.query<{ screening_verdict: 'pass' | 'flagged' }>(
        `SELECT screening_verdict FROM ${s}.applications
          WHERE id = $1 AND screening_decision IS NULL LIMIT 1`,
        [appId],
      )
      return r.rows[0]?.screening_verdict ?? null
    },

    /**
     * Enregistre la DÉCISION HUMAINE et fait entrer (ou sortir) la candidature
     * du pipeline. `WHERE screening_decision IS NULL` rend l'opération
     * idempotente : une candidature déjà tranchée ne peut pas l'être deux fois
     * (le handler renvoie alors 404).
     */
    async decide(
      appId: string,
      decision: 'kept' | 'dismissed',
      reason: string | null,
      userId: string,
    ): Promise<DecideResult | null> {
      const stage = decision === 'kept' ? 'screening' : 'rejected'
      const r = await pool.query<DecideResult>(
        `UPDATE ${s}.applications
            SET screening_decision = $1, screening_reason = $2,
                screening_decided_by = $3, screening_decided_at = now(),
                stage = $4, updated_at = now()
          WHERE id = $5 AND screening_decision IS NULL
          RETURNING id, screening_verdict`,
        [decision, reason, userId, stage, appId],
      )
      return r.rows[0] ?? null
    },
  }
}

export type ScreeningRepo = ReturnType<typeof screeningRepo>
