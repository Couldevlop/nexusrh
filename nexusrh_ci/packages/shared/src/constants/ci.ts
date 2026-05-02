/**
 * Constantes légales CI 2024
 * Code du Travail ivoirien + CNPS 2024 + DGI/ITS
 * NexusRH CI — OpenLab Consulting
 */

// ─── SMIG ────────────────────────────────────────────────────────────────────
export const SMIG_MENSUEL_FCFA = 75_000   // FCFA — revalorisation 2026
export const SMIG_HORAIRE_FCFA = 433      // FCFA (75 000 / 173,33h)

// ─── CNPS ────────────────────────────────────────────────────────────────────
export const PLAFOND_CNPS_AT_PF_MENSUEL = 70_000        // FCFA
export const PLAFOND_CNPS_RETRAITE_MENSUEL = 1_647_315  // FCFA

export const TAUX_CNPS = {
  retraite: {
    salarial:  0.063,
    patronal:  0.077,
  },
  prestationsFamiliales: {
    salarial:  0,
    patronal:  0.050,
  },
  maternite: {
    salarial:  0,
    patronal:  0.0075,
  },
  accidentsTravail: {
    commerce:  0.020,
    btp:       0.030,
    industrie: 0.040,
    extraction: 0.050,
  },
} as const

export type SecteurAT = keyof typeof TAUX_CNPS.accidentsTravail

export function getTauxAT(secteur: SecteurAT): number {
  return TAUX_CNPS.accidentsTravail[secteur]
}

// ─── ITS / DGI ───────────────────────────────────────────────────────────────
export const ABATTEMENT_ITS = 0.15  // 15 % du salaire brut

export const TRANCHES_ITS_MENSUELLES = [
  { min: 0,          max: 75_000,    taux: 0.000 },
  { min: 75_001,     max: 240_000,   taux: 0.015 },
  { min: 240_001,    max: 800_000,   taux: 0.050 },
  { min: 800_001,    max: 2_000_000, taux: 0.100 },
  { min: 2_000_001,  max: Infinity,  taux: 0.150 },
] as const

export const CREDITS_IMPOT_FAMILLE = {
  celibataire_sans_enfant:    0,
  marie_sans_enfant:          5_500,
  avec_1_enfant:              3_000,  // supplémentaire par rapport à marié sans enfant
  avec_2_enfants:             6_000,
  avec_3_enfants_et_plus:     9_000,
} as const

export function calculerITS(
  salaireBrut: number,
  cotisationsCNPS: number,
  nbEnfants: number,
  estMarie: boolean,
): number {
  const salaireNetImposable = Math.floor(salaireBrut * (1 - ABATTEMENT_ITS))
  const baseImposable = Math.max(0, salaireNetImposable - cotisationsCNPS)

  let itsBrut = 0
  for (const tranche of TRANCHES_ITS_MENSUELLES) {
    if (baseImposable <= tranche.min) break
    const montantDansTranche = Math.min(baseImposable, tranche.max) - tranche.min
    itsBrut += montantDansTranche * tranche.taux
  }

  // Crédit d'impôt famille
  let creditImpot = 0
  if (estMarie) {
    creditImpot = CREDITS_IMPOT_FAMILLE.marie_sans_enfant
  }
  if (nbEnfants >= 3) {
    creditImpot += CREDITS_IMPOT_FAMILLE.avec_3_enfants_et_plus
  } else if (nbEnfants === 2) {
    creditImpot += CREDITS_IMPOT_FAMILLE.avec_2_enfants
  } else if (nbEnfants === 1) {
    creditImpot += CREDITS_IMPOT_FAMILLE.avec_1_enfant
  }

  return Math.max(0, Math.floor(itsBrut - creditImpot))
}

// ─── CONGÉS CI ───────────────────────────────────────────────────────────────
export const JOURS_CONGES_PAR_MOIS = 2.5  // jours ouvrables

export const BONUS_ANCIENNETE_CONGES = [
  { annees: 5,  joursSupp: 1 },
  { annees: 10, joursSupp: 2 },
  { annees: 15, joursSupp: 3 },
] as const

export function calculerCongesAcquis(moisTravailles: number, anneesAnciennete: number): number {
  const base = moisTravailles * JOURS_CONGES_PAR_MOIS
  const bonus = BONUS_ANCIENNETE_CONGES
    .filter(b => anneesAnciennete >= b.annees)
    .reduce((acc, b) => Math.max(acc, b.joursSupp), 0)
  // bonus = jours/an supplémentaires → ramener au prorata mois
  return base + (bonus * moisTravailles / 12)
}

// ─── HEURES SUPPLÉMENTAIRES ───────────────────────────────────────────────────
export const MAJORATIONS_HEURES_SUPP = {
  normal:   0.15,   // 41–48h/semaine
  nuit:     0.50,   // 20h–5h
  dimanche: 0.50,
  ferie:    1.00,
} as const

// ─── JOURS FÉRIÉS CI ─────────────────────────────────────────────────────────
export const JOURS_FERIES_CI_2024 = [
  '2024-01-01', // Jour de l'An
  '2024-04-01', // Lundi de Pâques
  '2024-04-10', // Eid Al-Fitr
  '2024-05-01', // Fête du Travail
  '2024-05-09', // Ascension
  '2024-05-20', // Lundi de Pentecôte
  '2024-06-17', // Eid Al-Adha (Tabaski)
  '2024-07-07', // Mouloud
  '2024-08-07', // Fête Nationale CI
  '2024-08-15', // Assomption
  '2024-11-01', // Toussaint
  '2024-11-15', // Journée Nationale de la Paix
  '2024-12-25', // Noël
] as const

export const JOURS_FERIES_CI_2025 = [
  '2025-01-01',
  '2025-03-31', // Eid Al-Fitr (approximatif)
  '2025-04-21', // Lundi de Pâques
  '2025-05-01',
  '2025-05-29', // Ascension
  '2025-06-06', // Eid Al-Adha (approximatif)
  '2025-06-09', // Pentecôte
  '2025-08-07', // Fête Nationale
  '2025-08-15',
  '2025-11-01',
  '2025-11-15',
  '2025-12-25',
] as const

export function isJourFerie(date: string, annee: 2024 | 2025 = 2024): boolean {
  const feries = annee === 2024 ? JOURS_FERIES_CI_2024 : JOURS_FERIES_CI_2025
  return (feries as readonly string[]).includes(date)
}

// ─── VILLES CI ───────────────────────────────────────────────────────────────
export const VILLES_CI = [
  'Abidjan',
  'Bouaké',
  'Daloa',
  'San-Pédro',
  'Yamoussoukro',
  'Korhogo',
  'Man',
  'Gagnoa',
  'Abengourou',
  'Divo',
] as const

export type VilleCI = typeof VILLES_CI[number]

// ─── SECTEURS D'ACTIVITÉ CI ───────────────────────────────────────────────────
export const SECTEURS_CI = [
  { id: 'commerce',   label: 'Commerce & Distribution',   tauxAT: 0.020 },
  { id: 'services',   label: 'Services & Tertiaire',      tauxAT: 0.020 },
  { id: 'btp',        label: 'BTP & Transports',          tauxAT: 0.030 },
  { id: 'industrie',  label: 'Industrie & Manufacture',   tauxAT: 0.040 },
  { id: 'extraction', label: 'Extraction & Mines',        tauxAT: 0.050 },
  { id: 'finance',    label: 'Finance & Assurances',      tauxAT: 0.020 },
  { id: 'sante',      label: 'Santé & Pharmacie',         tauxAT: 0.030 },
  { id: 'education',  label: 'Éducation & Formation',     tauxAT: 0.020 },
  { id: 'agriculture',label: 'Agriculture & Agro-industrie', tauxAT: 0.040 },
  { id: 'public',     label: 'Secteur Public & ONG',      tauxAT: 0.020 },
] as const

// ─── PLANS TARIFICATION FCFA ─────────────────────────────────────────────────
export const PLAN_DEFAULTS_CI = {
  trial:         { maxUsers: 10,   maxEmployees: 20,   prixFCFA: 0 },
  starter:       { maxUsers: 30,   maxEmployees: 30,   prixFCFA: 70_000 },
  business:      { maxUsers: 100,  maxEmployees: 150,  prixFCFA: 0 },  // 10 000 FCFA/sal
  enterprise:    { maxUsers: 9999, maxEmployees: 9999, prixFCFA: 0 },  // sur devis
  public_sector: { maxUsers: 200,  maxEmployees: 500,  prixFCFA: 0 },  // sur convention
} as const

export type PlanTypeCi = keyof typeof PLAN_DEFAULTS_CI

// ─── MOBILE MONEY ─────────────────────────────────────────────────────────────
export const MOBILE_MONEY_PROVIDERS = ['wave', 'mtn_momo', 'orange_money', 'cofina', 'bank_transfer'] as const
export type MobileMoneyProvider = typeof MOBILE_MONEY_PROVIDERS[number]

// Format téléphone CI : +225 07/05 XX XX XX XX
export const CI_PHONE_REGEX = /^\+2250[57]\d{8}$/

export function isCIPhoneValid(phone: string): boolean {
  return CI_PHONE_REGEX.test(phone)
}

// ─── CONTRATS CI / OHADA ─────────────────────────────────────────────────────
export const TYPES_CONTRATS_CI = [
  'cdi',
  'cdd',
  'saisonnier',
  'apprentissage',
  'stage',
  'mise_a_disposition',
] as const

export type TypeContratCI = typeof TYPES_CONTRATS_CI[number]

export const PERIODES_ESSAI_CI = {
  cdi_ouvrier:   { duree: 15, unite: 'jours' },
  cdi_employe:   { duree: 1,  unite: 'mois' },
  cdi_cadre:     { duree: 3,  unite: 'mois' },
  cdd:           { duree: 0,  unite: null },
} as const

export const PREAVIS_LICENCIEMENT_CI = [
  { ancienneteMax: 1,   preavis: 1,  unite: 'mois' },
  { ancienneteMax: 5,   preavis: 2,  unite: 'mois' },
  { ancienneteMax: 999, preavis: 3,  unite: 'mois' },
] as const

// ─── FDFP ─────────────────────────────────────────────────────────────────────
export const TAUX_CONTRIBUTION_FDFP = 0.004  // 0,4% masse salariale (> 10 sal.)
export const SEUIL_FDFP_EMPLOYES = 10
