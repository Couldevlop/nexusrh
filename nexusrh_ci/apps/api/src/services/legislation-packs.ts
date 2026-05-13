/**
 * Packs législatifs UEMOA / hors UEMOA — Palier 2 de la stratégie multi-pays.
 *
 * Le pack CIV-2024 reflète strictement les constantes du moteur CI 2024
 * actuel : un refactor du moteur consommant le pack par défaut CIV-2024
 * produit des résultats identiques au comportement précédent (les 46 tests
 * existants doivent rester verts sans modification).
 *
 * Les packs autres pays sont déclarés mais marqués `status: 'stub'`.
 * Le moteur refusera explicitement de les exécuter tant qu'un expert paie
 * local n'a pas validé chaque valeur. Cela évite tout calcul faux involontaire.
 *
 * Pour activer un pack : passer `status: 'active'` après validation des
 * taux + barèmes avec un expert paie du pays.
 */

export interface ItsBracket {
  /** Borne basse incluse (FCFA / mois) */
  min: number
  /** Borne haute incluse (Infinity pour la dernière tranche) */
  max: number
  /** Taux marginal appliqué à la portion dans la tranche */
  taux: number
}

export interface LegislationPack {
  /** Identifiant : ISO-3 pays + année (ex: CIV-2024, BFA-2024) */
  code: string
  /** Nom lisible (ex: "Côte d'Ivoire — 2024") */
  name: string
  /** Pays ISO-3 */
  countryCode: string
  /** Année de référence des valeurs */
  year: number
  /** Devise paie (XOF pour UEMOA, XAF pour CEMAC, NGN pour Nigeria) */
  currency: 'XOF' | 'GNF' | 'EUR' | 'XAF' | 'NGN'

  /** Échelle du barème impôt : mensuel (CI/BEN) ou annuel (TGO/TCD/NGA) */
  bracketScale: 'monthly' | 'annual'
  /** active = utilisable / stub = déclaré mais valeurs non validées */
  status: 'active' | 'stub'

  /** SMIG mensuel (FCFA/mois) */
  smigMensuel: number

  /** Plafonds CNPS/CNSS mensuels (FCFA) */
  plafondCnpsRetraite: number
  /** Plafond AT + Prestations Familiales + Maternité */
  plafondCnpsAtPf: number

  /** Cotisations salariales (part employé) */
  tauxCotisationRetraiteSalarie: number
  /** Cotisations patronales (part employeur) */
  tauxCotisationRetraitePatronal: number
  tauxCotisationPfPatronal: number
  tauxCotisationMaternitePatronal: number
  /**
   * Taux AT par défaut si non précisé tenant.
   * En CI : variable selon secteur (2-5%) — le tenant porte sa valeur.
   */
  tauxAtDefaultPatronal: number

  /** Abattement appliqué au brut avant calcul impôt (0.15 = 15%) */
  abattementImpotSalaire: number
  /** Barème impôt progressif sur traitements et salaires (mensuel) */
  tranchesImpotSalaire: readonly ItsBracket[]

  /** Crédit d'impôt mensuel — marié sans enfant */
  creditImpotMarieSansEnfant: number
  /** Crédit d'impôt mensuel par enfant à charge (indexé [0]=1 enfant, [1]=2, [2]=3+) */
  creditImpotParEnfant: readonly [number, number, number]

  /**
   * Libellé local de l'impôt sur les salaires (utilisé pour l'affichage
   * dans le bulletin et les rubriques de paie).
   * CI: "ITS — Impôt sur Traitements et Salaires"
   * BFA: "IUTS — Impôt Unique sur Traitements et Salaires"
   * SEN: "IR — Impôt sur le Revenu"
   */
  labelImpotSalaire: string

  /** Libellé local de la caisse de sécurité sociale */
  labelCaisseSociale: string  // CNPS / CNSS / IPRES / INPS

  /** Note pour les administrateurs */
  notes?: string
}

// ─── Pack CI 2024 — référence stable, ne pas modifier ─────────────────────────
// Les valeurs ici DOIVENT correspondre exactement aux constantes utilisées
// historiquement par le moteur CI : c'est ce qui garantit zéro régression.
export const CIV_2024: LegislationPack = {
  code: 'CIV-2024',
  name: 'Côte d\'Ivoire — CNPS + ITS 2024',
  countryCode: 'CIV',
  year: 2024,
  currency: 'XOF',
  bracketScale: 'monthly',
  status: 'active',
  smigMensuel: 75_000,
  plafondCnpsRetraite: 1_647_315,
  plafondCnpsAtPf: 70_000,
  tauxCotisationRetraiteSalarie: 0.063,
  tauxCotisationRetraitePatronal: 0.077,
  tauxCotisationPfPatronal: 0.050,
  tauxCotisationMaternitePatronal: 0.0075,
  tauxAtDefaultPatronal: 0.02,
  abattementImpotSalaire: 0.15,
  tranchesImpotSalaire: [
    { min: 0,          max: 75_000,    taux: 0.000 },
    { min: 75_001,     max: 240_000,   taux: 0.015 },
    { min: 240_001,    max: 800_000,   taux: 0.050 },
    { min: 800_001,    max: 2_000_000, taux: 0.100 },
    { min: 2_000_001,  max: Infinity,  taux: 0.150 },
  ],
  creditImpotMarieSansEnfant: 5_500,
  creditImpotParEnfant: [3_000, 6_000, 9_000],
  labelImpotSalaire: 'ITS — Impôt sur Traitements et Salaires',
  labelCaisseSociale: 'CNPS',
}

// ─── Packs autres pays — STATUS = 'stub' ─────────────────────────────────────
// Valeurs issues de sources officielles ou semi-officielles (CLEISS, PwC Tax
// Summaries, sites des caisses nationales). Marqués `stub` car l'application
// concrète à un cas réel demande des règles fines non encore implémentées
// (parts familiales, abattements spécifiques, AT par secteur local…). Le
// moteur REFUSE de calculer sur un pack stub — c'est volontaire et sécurise.
//
// Pour activer un pack : faire valider chaque ligne par un expert paie local,
// passer `status: 'active'` après validation.

// Bénin — CNSS + ITS 2024 (source : Code général des impôts 2024 + CNSS Bénin)
export const BEN_2024: LegislationPack = {
  code: 'BEN-2024',
  name: 'Bénin — CNSS + ITS 2024',
  countryCode: 'BEN',
  year: 2024,
  currency: 'XOF',
  bracketScale: 'monthly',
  status: 'stub',
  smigMensuel: 52_000,                       // CLEISS — depuis 01/01/2023
  plafondCnpsRetraite: 0,                    // pas de plafond CNSS Bénin
  plafondCnpsAtPf: 0,
  tauxCotisationRetraiteSalarie: 0.036,      // CLEISS Bénin 2024
  tauxCotisationRetraitePatronal: 0.064,     // CLEISS Bénin 2024
  tauxCotisationPfPatronal: 0.09,            // CLEISS — PF (incl. 0,2% maternité)
  tauxCotisationMaternitePatronal: 0.0,      // intégré dans PF (0,2% sur 9%)
  tauxAtDefaultPatronal: 0.02,               // 1-4% selon risque
  abattementImpotSalaire: 0.0,               // pas d'abattement forfaitaire
  tranchesImpotSalaire: [
    { min: 0,        max: 60_000,    taux: 0.000 },
    { min: 60_001,   max: 150_000,   taux: 0.100 },
    { min: 150_001,  max: 250_000,   taux: 0.150 },
    { min: 250_001,  max: 500_000,   taux: 0.190 },
    { min: 500_001,  max: Infinity,  taux: 0.300 },
  ],
  creditImpotMarieSansEnfant: 0,
  creditImpotParEnfant: [0, 0, 0],
  labelImpotSalaire: 'ITS — Impôt sur Traitements et Salaires',
  labelCaisseSociale: 'CNSS',
  notes: 'Sources: CLEISS (cleiss.fr/docs/cotisations/benin.html), CGI Bénin 2024 ' +
         '(api.impots.bj). À valider avec un expert paie local avant activation. ' +
         'Note : la réforme 2025 a supprimé les déductions familiales.',
}

// Togo — CNSS + IRPP 2024 (source : CNSS.tg, Code général des impôts Togo)
// ATTENTION : barème IRPP Togo est ANNUEL — bracketScale: 'annual'
export const TGO_2024: LegislationPack = {
  code: 'TGO-2024',
  name: 'Togo — CNSS (avec AMU) + IRPP 2024',
  countryCode: 'TGO',
  year: 2024,
  currency: 'XOF',
  bracketScale: 'annual',
  status: 'stub',
  smigMensuel: 52_500,                       // CLEISS Togo 2023
  plafondCnpsRetraite: 0,
  plafondCnpsAtPf: 0,
  tauxCotisationRetraiteSalarie: 0.09,       // CNSS.tg 2024 : 4% vieillesse + 5% AMU
  tauxCotisationRetraitePatronal: 0.175,     // 12,5% vieillesse + 5% AMU
  tauxCotisationPfPatronal: 0.03,            // CNSS.tg 2024
  tauxCotisationMaternitePatronal: 0.0,      // intégré dans PF
  tauxAtDefaultPatronal: 0.02,               // Risques professionnels
  abattementImpotSalaire: 0.28,              // Abattement forfaitaire après CNSS
  tranchesImpotSalaire: [
    // Bornes ANNUELLES (cf. bracketScale: 'annual')
    { min: 0,           max: 900_000,     taux: 0.00 },
    { min: 900_001,     max: 3_000_000,   taux: 0.03 },
    { min: 3_000_001,   max: 6_000_000,   taux: 0.10 },
    { min: 6_000_001,   max: 9_000_000,   taux: 0.15 },
    { min: 9_000_001,   max: 12_000_000,  taux: 0.20 },
    { min: 12_000_001,  max: 15_000_000,  taux: 0.25 },
    { min: 15_000_001,  max: 20_000_000,  taux: 0.30 },
    { min: 20_000_001,  max: Infinity,    taux: 0.35 },
  ],
  creditImpotMarieSansEnfant: 0,             // Togo : déduction 10 000 FCFA/mois/personne (max 6)
  creditImpotParEnfant: [10_000, 20_000, 30_000],
  labelImpotSalaire: 'IRPP — Impôt sur le Revenu des Personnes Physiques',
  labelCaisseSociale: 'CNSS',
  notes: 'Sources: CNSS.tg (cnss.tg/employeurs/cotisations-sociales/), togofirst.com, ' +
         'Code général des impôts Togo. Barème IRPP ANNUEL — déduction familiale ' +
         '10 000 FCFA/mois/personne (max 6). À valider avant activation.',
}

// Burkina Faso — CNSS + IUTS 2024
export const BFA_2024: LegislationPack = {
  code: 'BFA-2024',
  name: 'Burkina Faso — CNSS + IUTS 2024',
  countryCode: 'BFA',
  year: 2024,
  currency: 'XOF',
  bracketScale: 'monthly',
  status: 'stub',
  smigMensuel: 37_500,
  plafondCnpsRetraite: 600_000,
  plafondCnpsAtPf: 600_000,
  tauxCotisationRetraiteSalarie: 0.055,
  tauxCotisationRetraitePatronal: 0.055,
  tauxCotisationPfPatronal: 0.07,
  tauxCotisationMaternitePatronal: 0.0,
  tauxAtDefaultPatronal: 0.035,
  abattementImpotSalaire: 0.0,
  tranchesImpotSalaire: [
    { min: 0,        max: 30_000,   taux: 0.000 },
    { min: 30_001,   max: 50_000,   taux: 0.110 },
    { min: 50_001,   max: 80_000,   taux: 0.140 },
    { min: 80_001,   max: 120_000,  taux: 0.170 },
    { min: 120_001,  max: 170_000,  taux: 0.190 },
    { min: 170_001,  max: 250_000,  taux: 0.215 },
    { min: 250_001,  max: Infinity, taux: 0.250 },
  ],
  creditImpotMarieSansEnfant: 0,
  creditImpotParEnfant: [0, 0, 0],
  labelImpotSalaire: 'IUTS — Impôt Unique sur Traitements et Salaires',
  labelCaisseSociale: 'CNSS',
  notes: 'Sources : CNSS Burkina, Code général des impôts BF. À valider expert local.',
}

// Sénégal — IPRES + CSS + IR 2024
export const SEN_2024: LegislationPack = {
  code: 'SEN-2024',
  name: 'Sénégal — IPRES + CSS + IR 2024',
  countryCode: 'SEN',
  year: 2024,
  currency: 'XOF',
  bracketScale: 'monthly',
  status: 'stub',
  smigMensuel: 64_710,
  plafondCnpsRetraite: 432_000,
  plafondCnpsAtPf: 63_000,
  tauxCotisationRetraiteSalarie: 0.056,
  tauxCotisationRetraitePatronal: 0.084,
  tauxCotisationPfPatronal: 0.07,
  tauxCotisationMaternitePatronal: 0.0,
  tauxAtDefaultPatronal: 0.01,
  abattementImpotSalaire: 0.30,
  tranchesImpotSalaire: [
    { min: 0,         max: 50_000,     taux: 0.000 },
    { min: 50_001,    max: 145_833,    taux: 0.200 },
    { min: 145_834,   max: 333_333,    taux: 0.250 },
    { min: 333_334,   max: 583_333,    taux: 0.300 },
    { min: 583_334,   max: 1_250_000,  taux: 0.350 },
    { min: 1_250_001, max: Infinity,   taux: 0.400 },
  ],
  creditImpotMarieSansEnfant: 0,
  creditImpotParEnfant: [0, 0, 0],
  labelImpotSalaire: 'IR — Impôt sur le Revenu',
  labelCaisseSociale: 'IPRES + CSS',
  notes: 'Régime sénégalais avec parts familiales (système complexe à implémenter ' +
         'séparément). À valider expert local.',
}

// Mali — INPS + ITS 2024
export const MLI_2024: LegislationPack = {
  code: 'MLI-2024',
  name: 'Mali — INPS + ITS 2024',
  countryCode: 'MLI',
  year: 2024,
  currency: 'XOF',
  bracketScale: 'monthly',
  status: 'stub',
  smigMensuel: 40_000,
  plafondCnpsRetraite: 0,
  plafondCnpsAtPf: 0,
  tauxCotisationRetraiteSalarie: 0.036,
  tauxCotisationRetraitePatronal: 0.054,
  tauxCotisationPfPatronal: 0.08,
  tauxCotisationMaternitePatronal: 0.0,
  tauxAtDefaultPatronal: 0.02,
  abattementImpotSalaire: 0.0,
  tranchesImpotSalaire: [
    { min: 0,        max: 175_000,   taux: 0.000 },
    { min: 175_001,  max: 600_000,   taux: 0.050 },
    { min: 600_001,  max: 1_200_000, taux: 0.130 },
    { min: 1_200_001,max: Infinity,  taux: 0.300 },
  ],
  creditImpotMarieSansEnfant: 0,
  creditImpotParEnfant: [0, 0, 0],
  labelImpotSalaire: 'ITS — Impôt sur Traitements et Salaires',
  labelCaisseSociale: 'INPS',
  notes: 'Valeurs indicatives Mali. À valider expert local.',
}

// Niger — CNSS + ITS 2024
export const NER_2024: LegislationPack = {
  code: 'NER-2024',
  name: 'Niger — CNSS + ITS 2024',
  countryCode: 'NER',
  year: 2024,
  currency: 'XOF',
  bracketScale: 'monthly',
  status: 'stub',
  smigMensuel: 30_047,
  plafondCnpsRetraite: 0,
  plafondCnpsAtPf: 0,
  tauxCotisationRetraiteSalarie: 0.0525,
  tauxCotisationRetraitePatronal: 0.065,
  tauxCotisationPfPatronal: 0.085,
  tauxCotisationMaternitePatronal: 0.0,
  tauxAtDefaultPatronal: 0.0175,
  abattementImpotSalaire: 0.17,
  tranchesImpotSalaire: [
    { min: 0,        max: 25_000,    taux: 0.010 },
    { min: 25_001,   max: 50_000,    taux: 0.020 },
    { min: 50_001,   max: 100_000,   taux: 0.060 },
    { min: 100_001,  max: 165_000,   taux: 0.130 },
    { min: 165_001,  max: 330_000,   taux: 0.250 },
    { min: 330_001,  max: 1_000_000, taux: 0.320 },
    { min: 1_000_001,max: Infinity,  taux: 0.350 },
  ],
  creditImpotMarieSansEnfant: 0,
  creditImpotParEnfant: [0, 0, 0],
  labelImpotSalaire: 'ITS — Impôt sur Traitements et Salaires',
  labelCaisseSociale: 'CNSS',
  notes: 'Valeurs indicatives Niger. À valider expert local.',
}

// Tchad — CNPS + IRPP 2024 (CEMAC, devise XAF)
// ATTENTION : Tchad est hors UEMOA — devise XAF (CEMAC), pas XOF
export const TCD_2024: LegislationPack = {
  code: 'TCD-2024',
  name: 'Tchad — CNPS + IRPP 2024',
  countryCode: 'TCD',
  year: 2024,
  currency: 'XAF',
  bracketScale: 'annual',
  status: 'stub',
  smigMensuel: 60_000,                       // wageindicator.org / Loi 09.004
  plafondCnpsRetraite: 500_000,              // cnps-tchad.com — plafond uniforme
  plafondCnpsAtPf: 500_000,
  tauxCotisationRetraiteSalarie: 0.035,      // 3,5% salarié (retraite uniquement)
  tauxCotisationRetraitePatronal: 0.05,      // 5% employeur
  tauxCotisationPfPatronal: 0.075,           // 7,5% PF/maternité
  tauxCotisationMaternitePatronal: 0.0,      // intégré dans PF
  tauxAtDefaultPatronal: 0.04,               // 4% AT (uniforme)
  abattementImpotSalaire: 0.0,
  tranchesImpotSalaire: [
    // Bornes ANNUELLES en XAF — source : PwC Tax Summaries Chad (août 2024)
    { min: 0,           max: 800_000,     taux: 0.000  },
    { min: 800_001,     max: 6_000_000,   taux: 0.105  },
    { min: 6_000_001,   max: 7_500_000,   taux: 0.150  },
    { min: 7_500_001,   max: 9_000_000,   taux: 0.200  },
    { min: 9_000_001,   max: 12_000_000,  taux: 0.250  },
    { min: 12_000_001,  max: Infinity,    taux: 0.300  },
  ],
  creditImpotMarieSansEnfant: 0,
  creditImpotParEnfant: [0, 0, 0],
  labelImpotSalaire: 'IRPP — Impôt sur le Revenu des Personnes Physiques',
  labelCaisseSociale: 'CNPS Tchad',
  notes: 'Sources : CNPS Tchad (cnps-tchad.com), PwC Worldwide Tax Summaries Chad ' +
         '(mise à jour août 2024). Devise XAF (CEMAC, pas UEMOA). SMIG stagnant ' +
         'à 60 000 XAF depuis 2011. À valider avec expert paie local.',
}

// Nigeria — PAYE + Pension 2024 (devise NGN, hors zone franc)
// ATTENTION : barème NTA 2025 plus favorable s'applique à partir de 2026
export const NGA_2024: LegislationPack = {
  code: 'NGA-2024',
  name: 'Nigeria — PAYE + Pension 2024',
  countryCode: 'NGA',
  year: 2024,
  currency: 'NGN',
  bracketScale: 'annual',
  status: 'stub',
  smigMensuel: 70_000,                       // 70 000 NGN/mois (eff. 1er mai 2024)
  plafondCnpsRetraite: 0,
  plafondCnpsAtPf: 0,
  tauxCotisationRetraiteSalarie: 0.08,       // Pension contribution 8% employee
  tauxCotisationRetraitePatronal: 0.10,      // 10% employer
  tauxCotisationPfPatronal: 0.025,           // NHF 2,5% (charge salarié réelle, simplifié patronal)
  tauxCotisationMaternitePatronal: 0.0,
  tauxAtDefaultPatronal: 0.01,               // EC Scheme — approximatif
  abattementImpotSalaire: 0.0,               // Nigeria : pas d'abattement % mais CRA fixe
  tranchesImpotSalaire: [
    // Bornes ANNUELLES en NGN — source : PwC Worldwide Tax Summaries Nigeria
    { min: 0,           max: 300_000,     taux: 0.07 },
    { min: 300_001,     max: 600_000,     taux: 0.11 },
    { min: 600_001,     max: 1_100_000,   taux: 0.15 },
    { min: 1_100_001,   max: 1_600_000,   taux: 0.19 },
    { min: 1_600_001,   max: 3_200_000,   taux: 0.21 },
    { min: 3_200_001,   max: Infinity,    taux: 0.24 },
  ],
  creditImpotMarieSansEnfant: 0,
  creditImpotParEnfant: [0, 0, 0],
  labelImpotSalaire: 'PAYE — Pay As You Earn (PIT)',
  labelCaisseSociale: 'PenCom / NHF',
  notes: 'Sources : PwC Worldwide Tax Summaries Nigeria, FIRS, PenCom. ' +
         'Barème PAYE ANNUEL en NGN. Le Nigeria Tax Act (NTA) 2025 introduit ' +
         'un barème plus progressif applicable à partir de 2026 ' +
         '(0/7/11/15/25% — à intégrer dans NGA-2026). Le calcul réel inclut ' +
         'la Consolidated Relief Allowance (CRA = 200 000 NGN + 20% du brut) ' +
         'non encore implémentée dans le moteur générique. À valider avant activation.',
}

export const LEGISLATION_PACKS: Record<string, LegislationPack> = {
  'CIV-2024': CIV_2024,
  'BEN-2024': BEN_2024,
  'TGO-2024': TGO_2024,
  'BFA-2024': BFA_2024,
  'SEN-2024': SEN_2024,
  'MLI-2024': MLI_2024,
  'NER-2024': NER_2024,
  'TCD-2024': TCD_2024,
  'NGA-2024': NGA_2024,
}

/** Pack par défaut : CI 2024 — garantit le comportement existant. */
export const DEFAULT_LEGISLATION_PACK = CIV_2024

export function getLegislationPack(code: string | null | undefined): LegislationPack {
  if (!code) return DEFAULT_LEGISLATION_PACK
  return LEGISLATION_PACKS[code] ?? DEFAULT_LEGISLATION_PACK
}

export function listLegislationPacks(): Array<Omit<LegislationPack, 'tranchesImpotSalaire' | 'creditImpotParEnfant'>> {
  return Object.values(LEGISLATION_PACKS).map(p => ({
    code: p.code,
    name: p.name,
    countryCode: p.countryCode,
    year: p.year,
    currency: p.currency,
    bracketScale: p.bracketScale,
    status: p.status,
    smigMensuel: p.smigMensuel,
    plafondCnpsRetraite: p.plafondCnpsRetraite,
    plafondCnpsAtPf: p.plafondCnpsAtPf,
    tauxCotisationRetraiteSalarie: p.tauxCotisationRetraiteSalarie,
    tauxCotisationRetraitePatronal: p.tauxCotisationRetraitePatronal,
    tauxCotisationPfPatronal: p.tauxCotisationPfPatronal,
    tauxCotisationMaternitePatronal: p.tauxCotisationMaternitePatronal,
    tauxAtDefaultPatronal: p.tauxAtDefaultPatronal,
    abattementImpotSalaire: p.abattementImpotSalaire,
    creditImpotMarieSansEnfant: p.creditImpotMarieSansEnfant,
    labelImpotSalaire: p.labelImpotSalaire,
    labelCaisseSociale: p.labelCaisseSociale,
    notes: p.notes,
  }))
}
