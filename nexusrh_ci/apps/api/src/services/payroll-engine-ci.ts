/**
 * PayrollEngineCi — Moteur de paie multi-pays (UEMOA et au-delà)
 *
 * Par défaut : utilise le pack CIV-2024 (Côte d'Ivoire, CNPS 2024, ITS/DGI)
 * — comportement identique à la version pré-Palier 2.
 *
 * Pour les filiales (Palier 2 multi-pays) : passer `legislationPack` dans
 * le PayrollContext. Le moteur refuse les packs `status: 'stub'` (sécurité).
 *
 * Devise : entiers (XOF/XAF/GNF, zéro décimale).
 */
import {
  DEFAULT_LEGISLATION_PACK,
  type LegislationPack,
} from './legislation-packs.js'

/** Informations d'absence à appliquer sur le bulletin du mois */
export interface AbsencePayrollInfo {
  type: 'maternite' | 'maladie_sans_at' | 'accident_travail'
  /** Nombre de jours d'absence dans le mois (hors jours travaillés) */
  absenceDays: number
  /** Maladie sans AT : taux de maintien (1.0 = 100%, 0.5 = 50%). Défaut : 1.0 */
  maintienTaux?: number
  /** AT : le jour de l'accident (J) tombe-t-il dans ce mois ? (payé par l'employeur) */
  atJourAccidentInMonth?: boolean
}

export interface PayrollContext {
  baseSalary:      number  // FCFA brut mensuel
  workedDays:      number  // jours travaillés dans le mois (hors jours absence)
  workingDaysMonth: number // jours ouvrables théoriques du mois
  atRate:          number  // taux AT CNPS secteur (ex: 0.03 pour BTP)
  maritalStatus:   string  // 'single' | 'married' | 'divorced' | 'widowed'
  childrenCount:   number
  variableElements: Record<string, number> // {'PRIME_TRANSPORT': 30000, ...}
  /** Absence du mois (optionnel — sans ce champ, calcul normal) */
  absence?: AbsencePayrollInfo
  /**
   * Pack législatif à appliquer (optionnel — défaut : CIV-2024).
   * Permet le multi-pays UEMOA (Palier 2). Un pack `status: 'stub'`
   * fait lever une erreur explicite (refus de calcul).
   */
  legislationPack?: LegislationPack
}

export interface PayrollLine {
  code:   string
  label:  string
  type:   'earning' | 'deduction' | 'employee_contribution' | 'employer_contribution'
  base:   number
  amount: number // FCFA entier
}

export interface BordereauCnps {
  motif: 'maternite' | 'accident_travail'
  montant: number  // FCFA — montant à récupérer auprès de la CNPS
  label: string
}

export interface PayrollResult {
  lines:          PayrollLine[]
  baseSalary:     number
  brutProrata:    number
  grossSalary:    number  // = brutProrata + primes + indemnités
  // CNPS
  cnpsRetraiteSal: number
  cnpsRetraitePat: number
  cnpsPfPat:       number
  cnpsAtPat:       number
  totalCnpsSal:    number
  totalCnpsPat:    number
  // ITS
  baseImposable:   number
  its:             number
  // Totaux
  totalDeductions: number
  netPayable:      number
  employerCost:    number
  currency:        'XOF'
  smigCompliant:   boolean
  workingDays:     number
  // Absences
  indemniteAbsence?: number      // montant indemnité (maternité / maladie / AT)
  bordereauCnps?:    BordereauCnps  // bordereau remboursement CNPS (maternité / AT)
}

/**
 * Applique le barème progressif d'impôt sur les salaires défini par le pack.
 * Si le pack utilise un barème annuel, on multiplie la base par 12 pour appliquer
 * le barème, puis on divise le résultat par 12 (approximation linéaire — la
 * régularisation annuelle reste à la charge du tenant).
 */
function calculerBaremeImpot(baseImposable: number, pack: LegislationPack): number {
  const annuel = pack.bracketScale === 'annual'
  const baseProjetee = annuel ? baseImposable * 12 : baseImposable
  let impot = 0
  for (const tranche of pack.tranchesImpotSalaire) {
    if (baseProjetee <= tranche.min) break
    const montant = Math.min(baseProjetee, tranche.max) - tranche.min
    impot += montant * tranche.taux
  }
  if (annuel) impot /= 12
  return Math.floor(impot)
}

/**
 * Crédit d'impôt famille — valeurs définies par le pack
 */
function getCreditImpot(
  maritalStatus: string, childrenCount: number, pack: LegislationPack,
): number {
  let credit = maritalStatus === 'married' ? pack.creditImpotMarieSansEnfant : 0
  if (childrenCount === 1)      credit += pack.creditImpotParEnfant[0]
  else if (childrenCount === 2) credit += pack.creditImpotParEnfant[1]
  else if (childrenCount >= 3)  credit += pack.creditImpotParEnfant[2]
  return credit
}

/**
 * Évalue une formule de rubrique de paie (whitelist sécurisée)
 */
function evalFormule(formula: string, vars: Record<string, number>): number {
  // Si formule commence par VAR: → lire directement une variable
  if (formula.startsWith('VAR:')) {
    const key = formula.slice(4)
    return vars[key] ?? 0
  }
  // Si formule = 'ITS' → valeur calculée
  if (formula === 'ITS') return vars['ITS'] ?? 0

  // Whitelist caractères autorisés
  if (!/^[A-Z0-9_\s\+\-\*\/\.\(\)]+$/.test(formula)) return 0

  // Substitution des variables connues
  let expr = formula
  for (const [k, v] of Object.entries(vars)) {
    expr = expr.replace(new RegExp(`\\b${k}\\b`, 'g'), String(v))
  }

  try {
    // eslint-disable-next-line no-new-func
    const result = new Function(`return (${expr})`)() as number
    return Math.floor(isFinite(result) ? Math.max(0, result) : 0)
  } catch {
    return 0
  }
}

// Primes liées à la présence physique — suspendues automatiquement en cas d'absence
const PRIMES_PRESENCE = new Set(['PRIME_TRANSPORT', 'PRIME_PANIER'])

/**
 * Moteur principal de calcul de paie multi-pays.
 * Sans `legislationPack` : applique CIV-2024 (comportement historique).
 */
export function calculatePayrollCI(ctx: PayrollContext): PayrollResult {
  const {
    baseSalary, workedDays, workingDaysMonth,
    atRate, maritalStatus, childrenCount, absence,
  } = ctx

  // Pack actif : défaut CIV-2024
  const pack = ctx.legislationPack ?? DEFAULT_LEGISLATION_PACK
  if (pack.status === 'stub') {
    throw new Error(
      `Pack législatif "${pack.code}" (status=stub) — les valeurs n'ont pas ` +
      `été validées par un expert paie local. Refus de calcul pour sécurité.`,
    )
  }

  // Suspension automatique des primes de présence si absence déclarée
  const variableElements = { ...ctx.variableElements }
  if (absence) {
    for (const prime of PRIMES_PRESENCE) delete variableElements[prime]
  }

  // ── ÉTAPE 1 : Variables de base ─────────────────────────────────────────────
  // brutProrata = salaire des jours de PRÉSENCE RÉELLE (hors jours d'absence)
  const brutProrata  = Math.floor(baseSalary * (workedDays / workingDaysMonth))
  const baseAtPf     = Math.min(brutProrata, pack.plafondCnpsAtPf)
  const baseRetraite = Math.min(brutProrata, pack.plafondCnpsRetraite)

  // ── ÉTAPE 2 : Cotisations sécurité sociale (sur présence uniquement) ────────
  const cnpsRetraiteSal = Math.floor(baseRetraite * pack.tauxCotisationRetraiteSalarie)
  const cnpsRetraitePat = Math.floor(baseRetraite * pack.tauxCotisationRetraitePatronal)
  const cnpsPfPat       = Math.floor(baseAtPf * (pack.tauxCotisationPfPatronal + pack.tauxCotisationMaternitePatronal))
  const cnpsAtPat       = Math.floor(baseAtPf * atRate)
  const totalCnpsSal    = cnpsRetraiteSal
  const totalCnpsPat    = cnpsRetraitePat + cnpsPfPat + cnpsAtPat

  // ── PRÉ-CALCUL ABSENCE : avant ITS pour déterminer la base imposable ────────
  // Indemnités maternité et AT sont exonérées d'ITS ; maladie est taxée normalement
  let indemniteAbsence    = 0
  let indemniteExoneree   = 0   // portion exonérée ITS (maternité + AT)
  let bordereauCnps: BordereauCnps | undefined

  if (absence && absence.absenceDays > 0) {
    const tauxJour = baseSalary / workingDaysMonth

    if (absence.type === 'maternite') {
      indemniteAbsence  = Math.floor(tauxJour * absence.absenceDays)
      indemniteExoneree = indemniteAbsence
      bordereauCnps = {
        motif: 'maternite',
        montant: indemniteAbsence,
        label: 'Bordereau remboursement CNPS — Congé maternité',
      }
    } else if (absence.type === 'maladie_sans_at') {
      const taux = absence.maintienTaux ?? 1.0
      indemniteAbsence = Math.floor(tauxJour * absence.absenceDays * taux)
      // Maladie : soumise à ITS — indemniteExoneree reste 0
    } else if (absence.type === 'accident_travail') {
      // Jour J payé par l'employeur = inclus dans brutProrata via workedDays
      const joursIjCnps = absence.atJourAccidentInMonth
        ? Math.max(0, absence.absenceDays - 1)
        : absence.absenceDays
      if (joursIjCnps > 0) {
        indemniteAbsence  = Math.floor(tauxJour * joursIjCnps)
        indemniteExoneree = indemniteAbsence
        bordereauCnps = {
          motif: 'accident_travail',
          montant: indemniteAbsence,
          label: 'Bordereau remboursement CNPS — Accident du travail',
        }
      }
    }
  }

  // ── ÉTAPE 3 : Impôt sur les salaires (ITS CI / IUTS BF / IR SN / …) ─────────
  // Base taxable = (présence + indemnité maladie) × abattement - cotisations sal.
  // Indemnités maternité et AT sont exclues de la base imposable
  const brutTaxable     = brutProrata + indemniteAbsence - indemniteExoneree
  const salaireAbattu   = Math.floor(brutTaxable * (1 - pack.abattementImpotSalaire))
  const baseImposable   = Math.max(0, salaireAbattu - totalCnpsSal)
  const itsBrut         = calculerBaremeImpot(baseImposable, pack)
  const creditImpot     = getCreditImpot(maritalStatus, childrenCount, pack)
  const its             = Math.max(0, itsBrut - creditImpot)

  // ── ÉTAPE 4 : Construction des lignes du bulletin ───────────────────────────
  const lines: PayrollLine[] = []

  lines.push({
    code: '1000', label: 'Salaire de base',
    type: 'earning', base: baseSalary, amount: brutProrata,
  })

  const varEarnings = [
    { code: '1100', label: "Prime d'ancienneté",           varKey: 'PRIME_ANCIENNETE'  },
    { code: '1200', label: 'Prime de rendement',            varKey: 'PRIME_RENDEMENT'   },
    { code: '1300', label: 'Prime de transport',            varKey: 'PRIME_TRANSPORT'   },
    { code: '1400', label: 'Heures supp. +15%',            varKey: 'HEURES_SUPP_NORM'  },
    { code: '1500', label: 'Heures supp. +50% (nuit/dim)', varKey: 'HEURES_SUPP_NUIT'  },
    { code: '1550', label: 'Heures supp. +100% (jour férié)', varKey: 'HEURES_SUPP_FERIE' },
    { code: '1600', label: 'Indemnité congés payés',        varKey: 'ICP'               },
  ]
  for (const e of varEarnings) {
    const amount = variableElements[e.varKey] ?? 0
    if (amount > 0) lines.push({ code: e.code, label: e.label, type: 'earning', base: brutProrata, amount })
  }

  // Ligne indemnité absence (si applicable)
  if (indemniteAbsence > 0 && absence) {
    if (absence.type === 'maternite') {
      lines.push({ code: '1700', label: 'Indemnités de congé maternité', type: 'earning', base: baseSalary, amount: indemniteAbsence })
    } else if (absence.type === 'maladie_sans_at') {
      lines.push({ code: '1800', label: 'Indemnité de maladie',           type: 'earning', base: baseSalary, amount: indemniteAbsence })
    } else if (absence.type === 'accident_travail') {
      lines.push({ code: '1900', label: 'Indemnité journalière AT (CNPS)', type: 'earning', base: baseSalary, amount: indemniteAbsence })
    }
  }

  const grossSalary = lines.filter(l => l.type === 'earning').reduce((s, l) => s + l.amount, 0)

  const tauxRetSalPct  = (pack.tauxCotisationRetraiteSalarie * 100).toFixed(1)
  const tauxRetPatPct  = (pack.tauxCotisationRetraitePatronal * 100).toFixed(1)
  const tauxPfPatPct   = (pack.tauxCotisationPfPatronal * 100).toFixed(1)
  const tauxMatPatPct  = (pack.tauxCotisationMaternitePatronal * 100).toFixed(2)
  const caisse = pack.labelCaisseSociale

  lines.push({ code: '2000', label: `${caisse} Retraite salarié (${tauxRetSalPct}%)`, type: 'employee_contribution', base: baseRetraite, amount: cnpsRetraiteSal })
  lines.push({ code: '2100', label: pack.labelImpotSalaire,                          type: 'employee_contribution', base: baseImposable, amount: its })

  // Mutuelle santé complémentaire (optionnelle, négociée tenant). Montant fixe
  // mensuel via variableElements (MUTUELLE_SAL / MUTUELLE_PAT). N'entre PAS
  // dans les bases CNPS ni dans le calcul ITS.
  const mutuelleSal = variableElements['MUTUELLE_SAL'] ?? 0
  if (mutuelleSal > 0) lines.push({ code: '4000', label: 'Mutuelle santé salarié',  type: 'employee_contribution', base: 0, amount: mutuelleSal })

  const avance = variableElements['AVANCE'] ?? 0
  if (avance > 0) lines.push({ code: '5000', label: 'Avance sur salaire', type: 'deduction', base: 0, amount: avance })

  lines.push({ code: '3000', label: `${caisse} Retraite patronal (${tauxRetPatPct}%)`, type: 'employer_contribution', base: baseRetraite, amount: cnpsRetraitePat })
  lines.push({ code: '3100', label: `${caisse} Prestations familiales (${tauxPfPatPct}%)`, type: 'employer_contribution', base: baseAtPf, amount: Math.floor(baseAtPf * pack.tauxCotisationPfPatronal) })
  if (pack.tauxCotisationMaternitePatronal > 0) {
    lines.push({ code: '3200', label: `${caisse} Assurance maternité (${tauxMatPatPct}%)`, type: 'employer_contribution', base: baseAtPf, amount: Math.floor(baseAtPf * pack.tauxCotisationMaternitePatronal) })
  }
  lines.push({ code: '3300', label: `${caisse} Accidents du travail (${(atRate * 100).toFixed(2)}%)`, type: 'employer_contribution', base: baseAtPf, amount: cnpsAtPat })

  const mutuellePat = variableElements['MUTUELLE_PAT'] ?? 0
  if (mutuellePat > 0) lines.push({ code: '4100', label: 'Mutuelle santé patronal', type: 'employer_contribution', base: 0, amount: mutuellePat })

  // ── ÉTAPE 5 : Totaux ─────────────────────────────────────────────────────────
  const totalRetenues = totalCnpsSal + its + avance + mutuelleSal
  const netPayable    = Math.max(0, grossSalary - totalRetenues)
  const employerCost  = grossSalary + totalCnpsPat + mutuellePat

  return {
    lines,
    baseSalary,
    brutProrata,
    grossSalary,
    cnpsRetraiteSal,
    cnpsRetraitePat,
    cnpsPfPat,
    cnpsAtPat,
    totalCnpsSal,
    totalCnpsPat,
    baseImposable,
    its,
    totalDeductions: totalRetenues,
    netPayable,
    employerCost,
    currency: 'XOF',
    smigCompliant: netPayable >= pack.smigMensuel,
    workingDays: workedDays,
    indemniteAbsence: indemniteAbsence > 0 ? indemniteAbsence : undefined,
    bordereauCnps,
  }
}
