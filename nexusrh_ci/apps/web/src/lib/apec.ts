/**
 * Libellés et options des champs d'offre au standard APEC (partagés entre le
 * formulaire admin, le détail interne et la page carrières publique).
 * Les codes doivent rester alignés avec les énumérations backend
 * (recruitment.routes.ts : EXPERIENCE_LEVELS, JOB_LEVELS_APEC, WORK_MODES,
 * EDUCATION_LEVELS, JOB_SECTORS).
 */
export const EXPERIENCE_LABELS: Record<string, string> = {
  debutant_accepte: 'Débutant accepté',
  min_1_an:         'Min. 1 an',
  '1_3_ans':        '1 à 3 ans',
  '3_7_ans':        '3 à 7 ans',
  min_7_ans:        'Min. 7 ans',
}

export const JOB_LEVEL_LABELS: Record<string, string> = {
  employe_technicien: 'Employé / Technicien',
  agent_maitrise:     'Agent de maîtrise',
  cadre:              'Cadre',
  cadre_dirigeant:    'Cadre dirigeant',
}

export const WORK_MODE_LABELS: Record<string, string> = {
  on_site: 'Présentiel',
  hybrid:  'Hybride',
  remote:  'Télétravail',
}

export const EDUCATION_LABELS: Record<string, string> = {
  aucun:    'Sans diplôme',
  cap_bep:  'CAP / BEP',
  bac:      'Bac',
  bac_2:    'Bac +2',
  bac_3:    'Bac +3',
  bac_5:    'Bac +5',
  doctorat: 'Doctorat',
}

export const SECTOR_LABELS: Record<string, string> = {
  industrie: 'Industrie', commerce: 'Commerce', services: 'Services', btp: 'BTP',
  finance: 'Finance', sante: 'Santé', ong: 'ONG', public: 'Secteur public',
  transport: 'Transport', agriculture: 'Agriculture', mines: 'Mines',
  telecom: 'Télécom', education: 'Éducation', autre: 'Autre',
}

function toOptions(map: Record<string, string>): Array<{ value: string; label: string }> {
  return Object.entries(map).map(([value, label]) => ({ value, label }))
}

export const EXPERIENCE_OPTIONS = toOptions(EXPERIENCE_LABELS)
export const JOB_LEVEL_OPTIONS  = toOptions(JOB_LEVEL_LABELS)
export const WORK_MODE_OPTIONS  = toOptions(WORK_MODE_LABELS)
export const EDUCATION_OPTIONS  = toOptions(EDUCATION_LABELS)
export const SECTOR_OPTIONS     = toOptions(SECTOR_LABELS)

/** Champs APEC d'une offre (partie commune des objets job). */
export interface ApecJobFields {
  reference?: string | null
  experience_level?: string | null
  job_level?: string | null
  sector?: string | null
  required_education?: string | null
  benefits?: string | null
  work_mode?: string | null
  start_date?: string | null
  recruitment_process?: string | null
}

/** Paires [label, valeur] prêtes à afficher dans une grille de méta-infos APEC. */
export function apecMetaPairs(j: ApecJobFields): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = []
  if (j.reference)          pairs.push({ label: 'Référence',        value: j.reference })
  if (j.job_level)          pairs.push({ label: 'Statut',           value: JOB_LEVEL_LABELS[j.job_level] ?? j.job_level })
  if (j.experience_level)   pairs.push({ label: 'Expérience',       value: EXPERIENCE_LABELS[j.experience_level] ?? j.experience_level })
  if (j.required_education)  pairs.push({ label: 'Formation',        value: EDUCATION_LABELS[j.required_education] ?? j.required_education })
  if (j.sector)             pairs.push({ label: 'Secteur',          value: SECTOR_LABELS[j.sector] ?? j.sector })
  if (j.work_mode)          pairs.push({ label: 'Mode de travail',  value: WORK_MODE_LABELS[j.work_mode] ?? j.work_mode })
  if (j.start_date)         pairs.push({ label: 'Prise de poste',   value: new Date(j.start_date).toLocaleDateString('fr-FR') })
  return pairs
}
