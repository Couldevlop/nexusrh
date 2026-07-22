/**
 * Profil technique structuré d'une offre / d'un employé, utilisé (phase
 * suivante) pour calibrer la génération de questions du module
 * `interview_sim` sur les VRAIES exigences du poste plutôt que sur un prompt
 * générique. Module PUR — aucune I/O, uniquement validation/normalisation.
 *
 * Isolé du champ `screening_criteria` existant (pré-tri de CV) : zéro risque
 * de régression sur cette feature. Entièrement optionnel — un profil absent
 * (NULL) laisse le comportement actuel de simulation inchangé.
 */
import { z } from 'zod'

export const CECRL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
export type CecrlLevel = (typeof CECRL_LEVELS)[number]

export interface InterviewFocusTechnology {
  name: string
  yearsRequired: number
}

export interface InterviewFocusLanguage {
  language: string
  level: CecrlLevel
}

export interface InterviewFocus {
  /** Ordre = priorité : la 1ère technologie est la plus prioritaire. */
  technologies: InterviewFocusTechnology[]
  tools: string[]
  methodologies: string[]
  languages: InterviewFocusLanguage[]
}

const EMPTY_FOCUS: InterviewFocus = { technologies: [], tools: [], methodologies: [], languages: [] }

const interviewFocusSchema = z.object({
  technologies: z.array(z.object({
    name: z.string().min(1).max(80),
    yearsRequired: z.number().int().min(0).max(40),
  })).max(15),
  tools: z.array(z.string().min(1).max(60)).max(15),
  methodologies: z.array(z.string().min(1).max(60)).max(10),
  languages: z.array(z.object({
    language: z.string().min(1).max(40),
    level: z.enum(CECRL_LEVELS),
  })).max(6),
}).strict()

/**
 * Valide et normalise un `interview_focus` reçu du client (body JSON ou
 * colonne jsonb relue). `null`/`undefined` (non renseigné) → profil vide,
 * jamais une erreur. Toute autre valeur non conforme au schéma → `null`
 * (à traiter comme "requête invalide" par l'appelant, jamais silencieusement
 * acceptée).
 */
export function parseInterviewFocus(input: unknown): InterviewFocus | null {
  if (input === null || input === undefined) return EMPTY_FOCUS
  const parsed = interviewFocusSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}
