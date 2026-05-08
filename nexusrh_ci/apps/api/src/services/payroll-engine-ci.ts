/**
 * PayrollEngineCi — Moteur de paie Côte d'Ivoire
 * Conforme Code du Travail CI + CNPS 2024 + ITS/DGI
 * Devise : FCFA (entiers, zéro décimale)
 */

// ─── Constantes légales CI 2024 ───────────────────────────────────────────────
const SMIG_MENSUEL          = 75_000   // FCFA (revalorisation 2026)
const PLAFOND_CNPS_AT_PF    = 70_000   // FCFA / mois
const PLAFOND_CNPS_RETRAITE = 1_647_315 // FCFA / mois
const ABATTEMENT_ITS        = 0.15     // 15% du salaire brut
const TAUX_CNPS_RETRAITE_SAL = 0.063
const TAUX_CNPS_RETRAITE_PAT = 0.077
const TAUX_CNPS_PF_PAT       = 0.050
const TAUX_CNPS_MAT_PAT      = 0.0075

const TRANCHES_ITS = [
  { min: 0,          max: 75_000,    taux: 0.000 },
  { min: 75_001,     max: 240_000,   taux: 0.015 },
  { min: 240_001,    max: 800_000,   taux: 0.050 },
  { min: 800_001,    max: 2_000_000, taux: 0.100 },
  { min: 2_000_001,  max: Infinity,  taux: 0.150 },
] as const

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
 * Applique le barème ITS progressif DGI CI
 */
function calculerBaremeITS(baseImposable: number): number {
  let its = 0
  for (const tranche of TRANCHES_ITS) {
    if (baseImposable <= tranche.min) break
    const montant = Math.min(baseImposable, tranche.max) - tranche.min
    its += montant * tranche.taux
  }
  return Math.floor(its)
}

/**
 * Crédit d'impôt famille selon situation CI
 */
function getCreditImpot(maritalStatus: string, childrenCount: number): number {
  let credit = maritalStatus === 'married' ? 5_500 : 0
  if (childrenCount === 1)      credit += 3_000
  else if (childrenCount === 2) credit += 6_000
  else if (childrenCount >= 3)  credit += 9_000
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
 * Moteur principal de calcul de paie CI
 */
export function calculatePayrollCI(ctx: PayrollContext): PayrollResult {
  const {
    baseSalary, workedDays, workingDaysMonth,
    atRate, maritalStatus, childrenCount, absence,
  } = ctx

  // Suspension automatique des primes de présence si absence déclarée
  const variableElements = { ...ctx.variableElements }
  if (absence) {
    for (const prime of PRIMES_PRESENCE) delete variableElements[prime]
  }

  // ── ÉTAPE 1 : Variables de base ─────────────────────────────────────────────
  // brutProrata = salaire des jours de PRÉSENCE RÉELLE (hors jours d'absence)
  const brutProrata  = Math.floor(baseSalary * (workedDays / workingDaysMonth))
  const baseAtPf     = Math.min(brutProrata, PLAFOND_CNPS_AT_PF)
  const baseRetraite = Math.min(brutProrata, PLAFOND_CNPS_RETRAITE)

  // ── ÉTAPE 2 : Cotisations CNPS (sur présence uniquement) ────────────────────
  const cnpsRetraiteSal = Math.floor(baseRetraite * TAUX_CNPS_RETRAITE_SAL)
  const cnpsRetraitePat = Math.floor(baseRetraite * TAUX_CNPS_RETRAITE_PAT)
  const cnpsPfPat       = Math.floor(baseAtPf * (TAUX_CNPS_PF_PAT + TAUX_CNPS_MAT_PAT))
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

  // ── ÉTAPE 3 : ITS/DGI ───────────────────────────────────────────────────────
  // Base taxable = (présence + indemnité maladie) × abattement — CNPS sal
  // Indemnités maternité et AT sont exclues de la base imposable
  const brutTaxable     = brutProrata + indemniteAbsence - indemniteExoneree
  const salaireAbattu   = Math.floor(brutTaxable * (1 - ABATTEMENT_ITS))
  const baseImposable   = Math.max(0, salaireAbattu - totalCnpsSal)
  const itsBrut         = calculerBaremeITS(baseImposable)
  const creditImpot     = getCreditImpot(maritalStatus, childrenCount)
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

  lines.push({ code: '2000', label: 'CNPS Retraite salarié (6,3%)',               type: 'employee_contribution', base: baseRetraite, amount: cnpsRetraiteSal })
  lines.push({ code: '2100', label: 'ITS — Impôt sur Traitements et Salaires',    type: 'employee_contribution', base: baseImposable, amount: its })

  const avance = variableElements['AVANCE'] ?? 0
  if (avance > 0) lines.push({ code: '5000', label: 'Avance sur salaire', type: 'deduction', base: 0, amount: avance })

  lines.push({ code: '3000', label: 'CNPS Retraite patronal (7,7%)',              type: 'employer_contribution', base: baseRetraite, amount: cnpsRetraitePat })
  lines.push({ code: '3100', label: 'CNPS Prestations familiales (5%)',           type: 'employer_contribution', base: baseAtPf, amount: Math.floor(baseAtPf * TAUX_CNPS_PF_PAT) })
  lines.push({ code: '3200', label: 'CNPS Assurance maternité (0,75%)',           type: 'employer_contribution', base: baseAtPf, amount: Math.floor(baseAtPf * TAUX_CNPS_MAT_PAT) })
  lines.push({ code: '3300', label: `CNPS Accidents du travail (${(atRate * 100).toFixed(2)}%)`, type: 'employer_contribution', base: baseAtPf, amount: cnpsAtPat })

  // ── ÉTAPE 5 : Totaux ─────────────────────────────────────────────────────────
  const totalRetenues = totalCnpsSal + its + avance
  const netPayable    = Math.max(0, grossSalary - totalRetenues)
  const employerCost  = grossSalary + totalCnpsPat

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
    smigCompliant: netPayable >= SMIG_MENSUEL,
    workingDays: workedDays,
    indemniteAbsence: indemniteAbsence > 0 ? indemniteAbsence : undefined,
    bordereauCnps,
  }
}
