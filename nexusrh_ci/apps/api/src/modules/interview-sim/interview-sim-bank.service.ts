/**
 * Banque de questions d'entretien GLOBALE, partagée par tous les tenants
 * (platform.interview_sim_question_banks). Clé par métier NORMALISÉ.
 *
 * Trois rôles (§4) : repli (readBank), nourrissage (les questions passées sont
 * réinjectées au prompt de génération) et réutilisation inter-tenant. Aucune
 * écriture ne doit jamais casser une simulation → tout est non bloquant.
 */
import { pool } from '../../db/pool.js'

/**
 * Normalise un intitulé de poste (+ secteur) en clé métier stable, indépendante
 * du tenant/entreprise (garde-fou anti-fuite §4). Déterministe : accents retirés,
 * minuscules, tout caractère non alphanumérique → tiret, tirets condensés.
 */
export function normalizeRoleKey(title: string, secteur?: string | null): string {
  const raw = `${title ?? ''} ${secteur ?? ''}`
  const slug = raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // retire les diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return slug || 'poste-generique'
}

export interface BankEntry {
  questions: string[]
  sourceModel: string | null
}

/** Dernier jeu de questions stocké pour ce métier/langue (repli hors IA). */
export async function readBank(roleKey: string, langue: string): Promise<BankEntry | null> {
  try {
    const r = await pool.query<{ questions: unknown; source_model: string | null }>(
      `SELECT questions, source_model
         FROM platform.interview_sim_question_banks
        WHERE role_key = $1 AND langue = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [roleKey, langue],
    )
    const row = r.rows[0]
    if (!row) return null
    const questions = Array.isArray(row.questions)
      ? row.questions.filter((q): q is string => typeof q === 'string')
      : []
    if (questions.length === 0) return null
    return { questions, sourceModel: row.source_model }
  } catch {
    return null // banque indisponible → repli géré par l'appelant
  }
}

/** Nombre maximal de jeux de questions conservés par (role_key, langue) — évite
 * une croissance illimitée de la banque partagée (tous tenants confondus). */
const MAX_BANK_ENTRIES_PER_ROLE = 20

/** Enrichit la banque avec un nouveau jeu généré. Non bloquant. */
export async function feedBank(
  roleKey: string,
  secteur: string | null,
  langue: string,
  questions: string[],
  sourceModel: string | null,
): Promise<void> {
  if (questions.length === 0) return
  await pool.query(
    `INSERT INTO platform.interview_sim_question_banks
       (role_key, secteur, langue, questions, source_model)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [roleKey, secteur, langue, JSON.stringify(questions), sourceModel],
  ).catch(() => { /* enrichissement best-effort — jamais bloquant */ })
  // Purge : ne garde que les MAX_BANK_ENTRIES_PER_ROLE jeux les plus récents
  // pour ce (role_key, langue). Best-effort — ne doit jamais bloquer le
  // nourrissage de la banque, même si la purge échoue.
  await pool.query(
    `DELETE FROM platform.interview_sim_question_banks
      WHERE role_key = $1 AND langue = $2
        AND id NOT IN (
          SELECT id FROM platform.interview_sim_question_banks
           WHERE role_key = $1 AND langue = $2
           ORDER BY created_at DESC
           LIMIT $3
        )`,
    [roleKey, langue, MAX_BANK_ENTRIES_PER_ROLE],
  ).catch(() => { /* purge best-effort — jamais bloquant */ })
}

/** Incrémente le compteur d'usage ANONYME agrégé (aucune identité). Non bloquant. */
export async function incrementUsage(roleKey: string, langue: string): Promise<void> {
  await pool.query(
    `INSERT INTO platform.interview_sim_usage (role_key, langue, attempts_count, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (role_key, langue)
       DO UPDATE SET attempts_count = platform.interview_sim_usage.attempts_count + 1,
                     updated_at = now()`,
    [roleKey, langue],
  ).catch(() => { /* compteur anonyme best-effort */ })
}
