/**
 * Pré-tri recrutement — moteur de RÈGLES DURES (déterministe, pur).
 *
 * Clean Architecture : ce module est une fonction de domaine PURE. Aucune I/O,
 * aucune dépendance DB/réseau. Il prend en entrée :
 *   - les critères paramétrés par le recruteur sur l'offre (ScreeningCriteria)
 *   - les données structurées extraites du CV par l'IA (CandidateExtracted)
 *   - le score IA global (0-100)
 * et retourne un verdict de pré-tri (auto_reject | review) avec la liste des
 * règles échouées en clair (français), pour traçabilité et affichage UI.
 *
 * L'IA fait l'EXTRACTION (subjective, floue) ; ce moteur applique les RÈGLES
 * (objectives, reproductibles). La séparation garantit qu'un auto-rejet est
 * toujours explicable et auditable — pas une boîte noire.
 *
 * OWASP A04 (Insecure Design) : règle de prudence — on ne déclenche un knockout
 * que lorsque la donnée candidate est CONNUE et clairement non conforme. Une
 * donnée manquante (diplôme non détecté, localisation absente) ne provoque JAMAIS
 * un auto-rejet : elle bascule en revue humaine. Mieux vaut un faux positif en
 * revue qu'un candidat valable rejeté sur une extraction incomplète.
 */

/** Niveaux de diplôme ordonnés (système CI/OHADA + équivalences françaises). */
export type DiplomaLevel =
  | 'cep' | 'bepc' | 'cap' | 'bac' | 'bac+2' | 'bac+3'
  | 'bac+4' | 'bac+5' | 'doctorat'

const DIPLOMA_RANK: Record<DiplomaLevel, number> = {
  cep: 1, bepc: 2, cap: 3, bac: 4,
  'bac+2': 5, 'bac+3': 6, 'bac+4': 7, 'bac+5': 8, doctorat: 9,
}

export const DIPLOMA_LEVELS: DiplomaLevel[] = [
  'cep', 'bepc', 'cap', 'bac', 'bac+2', 'bac+3', 'bac+4', 'bac+5', 'doctorat',
]

/**
 * Critères de pré-tri paramétrés par le recruteur sur une offre.
 * Tous optionnels : un critère absent (null/undefined/vide) n'est pas évalué.
 */
export interface ScreeningCriteria {
  /** Années d'expérience minimum requises. */
  minExperienceYears?: number | null
  /** Compétences OBLIGATOIRES : chacune manquante = knockout. */
  requiredSkills?: string[]
  /** Compétences appréciées (informatif — n'entraîne jamais de rejet). */
  preferredSkills?: string[]
  /** Localisations acceptées (ville/pays). Hors liste = knockout. */
  allowedLocations?: string[]
  /** Prétention salariale max acceptée (FCFA). Au-dessus = knockout. */
  maxExpectedSalary?: number | null
  /** Diplôme minimum requis. En dessous = knockout. */
  minDiploma?: DiplomaLevel | null
  /** Langues OBLIGATOIRES : chacune manquante = knockout. */
  requiredLanguages?: string[]
  /** Seuil de score IA en dessous duquel on auto-rejette (0-100). */
  autoRejectBelowScore?: number | null
  /**
   * Interrupteur général des règles dures (knockout). Défaut : true.
   * Si false, AUCUN critère structurel ne provoque de rejet — seul le seuil de
   * score (autoRejectBelowScore) reste actif s'il est défini.
   */
  knockoutEnabled?: boolean
}

/** Données structurées extraites du CV (par l'IA) + champs applicatifs connus. */
export interface CandidateExtracted {
  yearsExperience?: number | null
  skills?: string[]
  highestDiploma?: string | null
  location?: string | null
  languages?: string[]
  /** Prétention salariale issue de la candidature (pas de l'IA). */
  expectedSalary?: number | null
}

export type ScreeningDecision = 'auto_reject' | 'review'

export interface ScreeningVerdict {
  decision: ScreeningDecision
  /** Au moins une règle dure (knockout) a échoué. */
  knockoutFailed: boolean
  /** Le score IA est sous le seuil d'auto-rejet. */
  belowScoreThreshold: boolean
  /** Règles échouées, en clair (français) — pour UI + rejection_reason. */
  failedRules: string[]
  /** Règles vérifiées avec succès, en clair — pour transparence. */
  passedRules: string[]
  /** Motif consolidé d'auto-rejet (null si decision = review). */
  autoRejectReason: string | null
}

// ── Helpers de normalisation (purs) ──────────────────────────────────────────

/** Normalise une chaîne : minuscules, sans accents, espaces compactés. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Une compétence requise est présente si un skill candidat la contient (ou
 *  inversement) après normalisation. Tolérant aux variantes ("Node" ↔ "Node.js"). */
function skillPresent(required: string, candidateSkills: string[]): boolean {
  const r = norm(required)
  if (!r) return true
  return candidateSkills.some((s) => {
    const n = norm(s)
    return n === r || n.includes(r) || r.includes(n)
  })
}

/** Tente de mapper un libellé de diplôme libre vers un DiplomaLevel connu.
 *  Retourne null si non reconnu (→ on ne knockout pas sur le diplôme). */
export function parseDiploma(raw: string | null | undefined): DiplomaLevel | null {
  if (!raw) return null
  const n = norm(raw)
  if (!n) return null
  // Cas explicites bac+N (et synonymes courants)
  if (/\bdoctorat\b|\bphd\b|\bdoctorate\b/.test(n)) return 'doctorat'
  if (/bac\s*\+\s*5|\bmaster\b|\bmastere\b|\bmba\b|\bingenieur\b|\bm2\b|\bdess\b|\bdea\b/.test(n)) return 'bac+5'
  if (/bac\s*\+\s*4|\bmaitrise\b|\bm1\b/.test(n)) return 'bac+4'
  if (/bac\s*\+\s*3|\blicence\b|\bbachelor\b|\bl3\b/.test(n)) return 'bac+3'
  if (/bac\s*\+\s*2|\bbts\b|\bdut\b|\bdeug\b|\bl2\b/.test(n)) return 'bac+2'
  if (/\bcap\b|\bbep\b/.test(n)) return 'cap'
  if (/\bbepc\b|\bbrevet\b/.test(n)) return 'bepc'
  if (/\bcep\b|\bcepe\b/.test(n)) return 'cep'
  if (/\bbac\b|\bbaccalaureat\b/.test(n)) return 'bac'
  return null
}

/** Indique si un DiplomaLevel libre est valide. */
export function isDiplomaLevel(v: unknown): v is DiplomaLevel {
  return typeof v === 'string' && (DIPLOMA_LEVELS as string[]).includes(v)
}

// ── Cœur du moteur (pur) ─────────────────────────────────────────────────────

/**
 * Évalue les règles dures d'une offre contre un candidat extrait + son score IA.
 * Déterministe : mêmes entrées → même verdict.
 */
export function evaluateScreening(
  criteria: ScreeningCriteria | null | undefined,
  extracted: CandidateExtracted,
  aiScore: number,
): ScreeningVerdict {
  const failedRules: string[] = []
  const passedRules: string[] = []

  const c = criteria ?? {}
  const knockoutEnabled = c.knockoutEnabled !== false // défaut = true

  // ── 1. Expérience minimum ──────────────────────────────────────────────────
  if (knockoutEnabled && typeof c.minExperienceYears === 'number' && c.minExperienceYears > 0) {
    const exp = extracted.yearsExperience
    if (typeof exp === 'number') {
      if (exp < c.minExperienceYears) {
        failedRules.push(`Expérience insuffisante : ${exp} an(s) < ${c.minExperienceYears} requis`)
      } else {
        passedRules.push(`Expérience : ${exp} an(s) ≥ ${c.minExperienceYears} requis`)
      }
    }
    // exp inconnue → pas de knockout (revue humaine)
  }

  // ── 2. Compétences obligatoires ─────────────────────────────────────────────
  if (knockoutEnabled && c.requiredSkills && c.requiredSkills.length > 0) {
    const skills = (extracted.skills ?? []).filter((s) => typeof s === 'string')
    const missing = c.requiredSkills
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !skillPresent(s, skills))
    if (missing.length > 0) {
      failedRules.push(`Compétence(s) obligatoire(s) absente(s) : ${missing.join(', ')}`)
    } else {
      passedRules.push(`Toutes les compétences obligatoires présentes (${c.requiredSkills.length})`)
    }
  }

  // ── 3. Localisation autorisée ───────────────────────────────────────────────
  if (knockoutEnabled && c.allowedLocations && c.allowedLocations.length > 0) {
    const loc = extracted.location ? norm(extracted.location) : null
    if (loc) {
      const allowed = c.allowedLocations
        .map((l) => norm(l))
        .filter((l) => l.length > 0)
      const ok = allowed.some((l) => loc.includes(l) || l.includes(loc))
      if (!ok) {
        failedRules.push(`Localisation hors zone : "${extracted.location}" non autorisée`)
      } else {
        passedRules.push(`Localisation conforme : ${extracted.location}`)
      }
    }
    // localisation inconnue → pas de knockout
  }

  // ── 4. Prétention salariale max ─────────────────────────────────────────────
  if (knockoutEnabled && typeof c.maxExpectedSalary === 'number' && c.maxExpectedSalary > 0) {
    const sal = extracted.expectedSalary
    if (typeof sal === 'number' && sal > 0) {
      if (sal > c.maxExpectedSalary) {
        failedRules.push(
          `Prétention salariale trop élevée : ${sal} FCFA > ${c.maxExpectedSalary} max`,
        )
      } else {
        passedRules.push(`Prétention salariale dans le budget (${sal} FCFA)`)
      }
    }
  }

  // ── 5. Diplôme minimum ──────────────────────────────────────────────────────
  if (knockoutEnabled && c.minDiploma) {
    const required = DIPLOMA_RANK[c.minDiploma]
    const candidate = parseDiploma(extracted.highestDiploma)
    if (candidate) {
      if (DIPLOMA_RANK[candidate] < required) {
        failedRules.push(
          `Diplôme insuffisant : ${candidate} < ${c.minDiploma} requis`,
        )
      } else {
        passedRules.push(`Diplôme conforme : ${candidate} ≥ ${c.minDiploma}`)
      }
    }
    // diplôme non reconnu → pas de knockout (revue humaine)
  }

  // ── 6. Langues obligatoires ─────────────────────────────────────────────────
  if (knockoutEnabled && c.requiredLanguages && c.requiredLanguages.length > 0) {
    const langs = (extracted.languages ?? []).filter((l) => typeof l === 'string')
    if (langs.length > 0) {
      const missing = c.requiredLanguages
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !skillPresent(l, langs))
      if (missing.length > 0) {
        failedRules.push(`Langue(s) obligatoire(s) absente(s) : ${missing.join(', ')}`)
      } else {
        passedRules.push(`Langues obligatoires présentes (${c.requiredLanguages.length})`)
      }
    }
    // aucune langue détectée → pas de knockout
  }

  // ── 7. Seuil de score IA ────────────────────────────────────────────────────
  const safeScore = Math.max(0, Math.min(100, Math.round(Number.isFinite(aiScore) ? aiScore : 0)))
  let belowScoreThreshold = false
  if (typeof c.autoRejectBelowScore === 'number' && c.autoRejectBelowScore > 0) {
    if (safeScore < c.autoRejectBelowScore) {
      belowScoreThreshold = true
      failedRules.push(`Score IA ${safeScore}/100 sous le seuil de ${c.autoRejectBelowScore}`)
    } else {
      passedRules.push(`Score IA ${safeScore}/100 ≥ seuil ${c.autoRejectBelowScore}`)
    }
  }

  const knockoutFailed = failedRules.some((r) => !r.startsWith('Score IA'))
  const decision: ScreeningDecision =
    (knockoutFailed || belowScoreThreshold) ? 'auto_reject' : 'review'

  const autoRejectReason = decision === 'auto_reject'
    ? `Pré-tri automatique — ${failedRules.join(' ; ')}`
    : null

  return {
    decision,
    knockoutFailed,
    belowScoreThreshold,
    failedRules,
    passedRules,
    autoRejectReason,
  }
}

/**
 * Valide/normalise un objet critères provenant de l'extérieur (body API ou JSON
 * stocké). Retourne un ScreeningCriteria propre. OWASP A03/A04 : bornes strictes,
 * pas de champ inattendu propagé, tailles de listes capées.
 */
export function sanitizeCriteria(input: unknown): ScreeningCriteria {
  const o = (input && typeof input === 'object') ? input as Record<string, unknown> : {}

  const intInRange = (v: unknown, min: number, max: number): number | null => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n < min || n > max) return null
    return n
  }
  const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim())
          .filter((x) => x.length > 0 && x.length <= maxLen)
          .slice(0, maxItems)
      : []

  return {
    minExperienceYears: intInRange(o['minExperienceYears'], 0, 50),
    requiredSkills:     strList(o['requiredSkills'], 30, 60),
    preferredSkills:    strList(o['preferredSkills'], 30, 60),
    allowedLocations:   strList(o['allowedLocations'], 30, 80),
    maxExpectedSalary:  intInRange(o['maxExpectedSalary'], 0, 50_000_000),
    minDiploma:         isDiplomaLevel(o['minDiploma']) ? o['minDiploma'] : null,
    requiredLanguages:  strList(o['requiredLanguages'], 15, 40),
    autoRejectBelowScore: intInRange(o['autoRejectBelowScore'], 0, 100),
    knockoutEnabled:    o['knockoutEnabled'] !== false,
  }
}
