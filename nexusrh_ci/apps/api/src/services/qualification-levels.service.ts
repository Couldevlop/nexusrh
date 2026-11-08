/**
 * Niveau de qualification (diplôme) — référentiel d'un seul tenant de vérité.
 *
 * DÉNOMINATION : « niveau de qualification », et non « niveau d'étude » ni
 * « diplôme ». C'est le terme des classifications conventionnelles (CCI 1977
 * en Côte d'Ivoire, conventions UEMOA) : il désigne le niveau ATTEINT, qu'il
 * soit sanctionné par un diplôme général (BAC), technique (BT, BTS) ou par un
 * titre professionnel, et c'est à ce niveau que les grilles de classification
 * rattachent une catégorie.
 *
 * CE RÉFÉRENTIEL NE CHANGE AUCUN MONTANT. Aucun texte ne fait dépendre un
 * taux de cotisation, un barème d'impôt ou un salaire minimum du diplôme : le
 * salaire se détermine par la CATÉGORIE professionnelle (et son minimum
 * conventionnel), que le diplôme ne fait que positionner usuellement. Le
 * rapprochement ci-dessous est donc un REPÈRE de classification, annoncé comme
 * tel à l'écran, jamais une règle appliquée au calcul.
 *
 * Il sert à deux choses, toutes deux informatives :
 *   1. proposer le niveau de poste usuel (ouvrier / employé / agent de
 *      maîtrise / cadre), à comparer avec celui que le salaire saisi implique ;
 *   2. documenter la fiche salarié avec un vocabulaire stable, partagé par le
 *      simulateur, le recrutement et les référentiels de postes.
 */
import { type JobLevel, jobLevelForSalary } from '../db/job-level.js'

export const QUALIFICATION_KEYS = [
  'none', 'cepe', 'bepc', 'cap_bt', 'bac', 'bac2', 'bac3', 'bac4', 'bac5', 'bac6', 'bac8',
] as const

export type QualificationKey = (typeof QUALIFICATION_KEYS)[number]

export interface QualificationLevel {
  key: QualificationKey
  /** Libellé français, tel qu'il est écrit sur les grilles et les CV ivoiriens. */
  label: string
  /**
   * Années d'études après le baccalauréat (négatif en deçà). Sert à ordonner
   * la liste et à comparer deux profils, pas à calculer quoi que ce soit.
   */
  yearsAfterBac: number
  /** Niveau de poste USUEL pour ce niveau de qualification (repère, pas règle). */
  usualJobLevel: JobLevel
}

export const QUALIFICATION_LEVELS: readonly QualificationLevel[] = [
  { key: 'none',   label: 'Sans diplôme',                        yearsAfterBac: -4, usualJobLevel: 'ouvrier'        },
  { key: 'cepe',   label: 'CEPE (primaire)',                     yearsAfterBac: -3, usualJobLevel: 'ouvrier'        },
  { key: 'bepc',   label: 'BEPC (premier cycle)',                yearsAfterBac: -2, usualJobLevel: 'employe'        },
  { key: 'cap_bt', label: 'CAP / BEP / BT (technique)',          yearsAfterBac: -1, usualJobLevel: 'employe'        },
  { key: 'bac',    label: 'BAC (général ou technique)',          yearsAfterBac:  0, usualJobLevel: 'employe'        },
  { key: 'bac2',   label: 'BAC+2 (BTS, DUT, DUEL)',              yearsAfterBac:  2, usualJobLevel: 'agent_maitrise' },
  { key: 'bac3',   label: 'BAC+3 (Licence)',                     yearsAfterBac:  3, usualJobLevel: 'agent_maitrise' },
  { key: 'bac4',   label: 'BAC+4 (Master 1, Maîtrise)',          yearsAfterBac:  4, usualJobLevel: 'cadre'          },
  { key: 'bac5',   label: 'BAC+5 (Master 2, diplôme d’ingénieur)', yearsAfterBac: 5, usualJobLevel: 'cadre'         },
  { key: 'bac6',   label: 'BAC+6 (spécialisation, DESS)',        yearsAfterBac:  6, usualJobLevel: 'cadre'          },
  { key: 'bac8',   label: 'BAC+8 (Doctorat)',                    yearsAfterBac:  8, usualJobLevel: 'cadre'          },
]

const BY_KEY = new Map<string, QualificationLevel>(QUALIFICATION_LEVELS.map((q) => [q.key, q]))

export function qualificationLevel(key: string | null | undefined): QualificationLevel | null {
  return key ? BY_KEY.get(key) ?? null : null
}

/** Libellés des niveaux de poste, pour les messages de positionnement. */
export const JOB_LEVEL_LABELS: Record<JobLevel, string> = {
  ouvrier:        'ouvrier',
  employe:        'employé',
  agent_maitrise: 'agent de maîtrise',
  cadre:          'cadre',
}

export interface Positioning {
  /** Niveau de poste usuel du diplôme (null si aucun diplôme renseigné). */
  usualJobLevel: JobLevel | null
  /** Niveau de poste que le salaire saisi implique, dans les grilles de démo. */
  salaryJobLevel: JobLevel
  /** Les deux concordent (ou aucun diplôme renseigné : rien à comparer). */
  aligned: boolean
  /** Phrase prête à afficher — toujours indicative. */
  note: string
}

/**
 * Rapproche le niveau de qualification du niveau que le salaire implique.
 *
 * Aucune des deux valeurs n'entre dans le calcul de la paie : la fonction
 * produit une PHRASE, jamais un montant. Un écart n'est pas une erreur — il
 * signale seulement un profil à regarder (sur-diplômé sous-payé, ou poste
 * tenu sans le diplôme usuel).
 */
export function positionProfile(input: {
  qualificationKey?: string | null
  baseSalary: number
}): Positioning {
  const q = qualificationLevel(input.qualificationKey)
  const salaryJobLevel = jobLevelForSalary(input.baseSalary)
  if (!q) {
    return {
      usualJobLevel: null, salaryJobLevel, aligned: true,
      note: `Le salaire saisi correspond usuellement à un poste de niveau « ${JOB_LEVEL_LABELS[salaryJobLevel]} ».`,
    }
  }
  const aligned = q.usualJobLevel === salaryJobLevel
  const note = aligned
    ? `${q.label} : niveau de poste usuel « ${JOB_LEVEL_LABELS[q.usualJobLevel]} », cohérent avec le salaire saisi. Repère de classification : aucun montant n'en dépend.`
    : `${q.label} : niveau de poste usuel « ${JOB_LEVEL_LABELS[q.usualJobLevel]} », alors que le salaire saisi correspond plutôt à « ${JOB_LEVEL_LABELS[salaryJobLevel]} ». Repère de classification : aucun montant n'en dépend.`
  return { usualJobLevel: q.usualJobLevel, salaryJobLevel, aligned, note }
}
