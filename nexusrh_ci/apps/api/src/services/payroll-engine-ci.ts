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
  type FamilyTaxReduction,
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

/**
 * Retenues issues du pointage (badgeuse), déjà chiffrées par
 * attendance-payroll.service selon le paramétrage du tenant. Absent = aucune
 * retenue (pas de badgeuse, lien paie désactivé, aucun écart).
 */
export interface AttendancePayrollDeductions {
  /** Jours d'absence injustifiée retenus */
  absenceDays: number
  absenceAmount: number
  /** Minutes de retard retenues (après franchise) */
  lateMinutes: number
  latenessAmount: number
  /** Suspendre les primes de présence (transport, panier) */
  suspendAttendanceBonus: boolean
}

/**
 * Indemnité du solde de tout compte portée sur le bulletin de solde. Le
 * traitement social / fiscal vient du pack (`settlementTreatment`).
 */
export interface SettlementEarning {
  key: 'conges' | 'preavis' | 'licenciement'
  label: string
  amount: number
}

export type SettlementTreatment = Record<SettlementEarning['key'], { social: boolean; tax: boolean }>

/**
 * Défaut : congés et préavis sont des salaires (cotisations + impôt) ;
 * l'indemnité de licenciement / de départ à la retraite en est exonérée.
 */
export const DEFAULT_SETTLEMENT_TREATMENT: SettlementTreatment = {
  conges:       { social: true,  tax: true },
  preavis:      { social: true,  tax: true },
  licenciement: { social: false, tax: false },
}

const SETTLEMENT_LINE_CODES: Record<SettlementEarning['key'], string> = {
  conges: '1610', preavis: '1620', licenciement: '1630',
}

export type VariableTreatment = Readonly<Record<string, { social: boolean; tax: boolean }>>
export type VariableTreatmentOverride = Readonly<Record<string, { social?: boolean; tax?: boolean }>>

/**
 * Défaut : les éléments de rémunération (primes, heures supplémentaires,
 * indemnité de congés, gratifications, avantages en nature) sont du salaire —
 * assujettis aux cotisations et à l'impôt. La prime de transport est traitée
 * à part (exonérée dans la limite du plafond du pack). Un pack peut surcharger
 * ce traitement élément par élément (`traitementElementsVariables`).
 */
const DEFAULT_VARIABLE_TREATMENT: VariableTreatment = {
  PRIME_ANCIENNETE:  { social: true, tax: true },
  PRIME_RENDEMENT:   { social: true, tax: true },
  PRIME_PANIER:      { social: true, tax: true },
  HEURES_SUPP_NORM:  { social: true, tax: true },
  HEURES_SUPP_NUIT:  { social: true, tax: true },
  HEURES_SUPP_FERIE: { social: true, tax: true },
  ICP:               { social: true, tax: true },
  GRATIFICATION:     { social: true, tax: true },
  AVANTAGE_NATURE:   { social: true, tax: true },
}

/** Plafond exonéré de la prime de transport (null = entièrement exonérée). */
function plafondTransport(pack: LegislationPack, zone: string | undefined): number | null {
  const p = pack.primeTransportExoneree
  if (!p) return null
  const z = zone?.trim().toLowerCase()
  return (z && p.parZone?.[z] !== undefined) ? p.parZone[z]! : p.defaut
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
  /** Retenues pointage (optionnel — sans ce champ, aucune retenue) */
  attendanceDeductions?: AttendancePayrollDeductions
  /** Bulletin de solde : indemnités du solde de tout compte (optionnel) */
  settlementEarnings?: SettlementEarning[]
  /**
   * Remboursement de notes de frais approuvées (FCFA). Hors brut : ni CNPS
   * ni ITS (frais professionnels réels justifiés) ; ajouté au net à payer.
   */
  expenseReimbursement?: number
  /**
   * Pack législatif à appliquer (optionnel — défaut : CIV-2024).
   * Permet le multi-pays UEMOA (Palier 2). Un pack `status: 'stub'`
   * fait lever une erreur explicite (refus de calcul).
   */
  legislationPack?: LegislationPack
  /**
   * Zone de travail pour le plafond exonéré de la prime de transport (clé de
   * `pack.primeTransportExoneree.parZone`, ex. abidjan / bouake / autres).
   * Absent ou inconnu = plafond par défaut du pack.
   */
  transportZone?: string
  /**
   * Paramétrage tenant de l'assujettissement des éléments variables (colonnes
   * `payroll_rules.subject_social` / `subject_tax`), fusionné champ par champ
   * après le défaut moteur et celui du pack. Un champ absent garde la valeur
   * du pack.
   */
  variableTreatment?: VariableTreatmentOverride
}

export interface PayrollLine {
  code:   string
  label:  string
  type:   'earning' | 'deduction' | 'employee_contribution' | 'employer_contribution' | 'reimbursement'
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
  /** Impôt brut issu du barème, avant réduction famille */
  itsBrut:         number
  /** Réduction famille imputée (RICF CI ou crédits du pack) */
  reductionImpot:  number
  /** Nombre de parts fiscales retenu (packs à RICF uniquement) */
  partsFiscales?:  number
  its:             number
  // Totaux
  totalDeductions: number
  netPayable:      number
  employerCost:    number
  currency:        LegislationPack['currency']
  smigCompliant:   boolean
  workingDays:     number
  // Absences
  indemniteAbsence?: number      // montant indemnité (maternité / maladie / AT)
  settlementTotal?:  number      // indemnités du solde de tout compte portées au bulletin
  reimbursementTotal?: number    // notes de frais remboursées (hors brut, ajoutées au net)
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
  // Les tranches sont déclarées en bornes entières incluses (0–75 000,
  // 75 001–240 000…) : la portion imposée dans une tranche part de la borne
  // haute de la tranche précédente, sinon on perdrait 1 F par tranche
  // (240 000 → (240 000 − 75 000) × 16 %, pas (240 000 − 75 001) × 16 %).
  let borneBasse = 0
  for (const tranche of pack.tranchesImpotSalaire) {
    if (baseProjetee <= borneBasse) break
    const montant = Math.min(baseProjetee, tranche.max) - borneBasse
    if (montant > 0) impot += montant * tranche.taux
    borneBasse = tranche.max
  }
  if (annuel) impot /= 12
  // Arrondi à l'entier inférieur ; l'epsilon neutralise les erreurs de
  // représentation binaire (165 000 × 0,16 = 26 399,999…).
  return Math.floor(impot + 1e-6)
}

/** Nombre de parts fiscales (RICF) selon la situation familiale. */
function getPartsFiscales(
  maritalStatus: string, childrenCount: number, r: FamilyTaxReduction,
): number {
  const enfants = Math.max(0, Math.floor(childrenCount))
  let parts: number
  if (maritalStatus === 'married' || (maritalStatus === 'widowed' && enfants > 0)) {
    parts = r.partsMarie + enfants * r.partsParEnfant
  } else if (enfants > 0) {
    parts = r.partsSansEnfant + r.majorationParentIsole + enfants * r.partsParEnfant
  } else {
    parts = r.partsSansEnfant
  }
  return Math.min(parts, r.plafondParts)
}

/**
 * Réduction d'impôt famille — définie par le pack : RICF par parts si le pack
 * la porte, sinon crédits historiques marié / enfants.
 */
function getCreditImpot(
  maritalStatus: string, childrenCount: number, pack: LegislationPack,
): { credit: number; parts?: number } {
  const ricf = pack.reductionChargesFamille
  if (ricf) {
    const parts = getPartsFiscales(maritalStatus, childrenCount, ricf)
    let credit = 0
    for (const palier of ricf.montantsParParts) {
      if (palier.parts <= parts) credit = palier.montant
    }
    return { credit, parts }
  }
  let credit = maritalStatus === 'married' ? pack.creditImpotMarieSansEnfant : 0
  if (childrenCount === 1)      credit += pack.creditImpotParEnfant[0]
  else if (childrenCount === 2) credit += pack.creditImpotParEnfant[1]
  else if (childrenCount >= 3)  credit += pack.creditImpotParEnfant[2]
  return { credit }
}

/**
 * Évalue une formule de rubrique de paie (whitelist sécurisée).
 *
 * Exporté pour test unitaire : cette fonction n'est pas (encore) appelée par
 * le moteur lui-même mais reste l'évaluateur de référence des formules de
 * rubriques (`payroll_rules.formula`), utilisé par les seeds/provisioning et
 * destiné au moteur de paie générique piloté par règles.
 */
/**
 * Évalue une expression arithmétique purement numérique (`+ - * / ( )`, unaire
 * inclus) par descente récursive. Lève sur toute entrée non conforme.
 *
 * Remplace un `new Function()` : cet évaluateur ne peut construire QUE des
 * nombres. Aucune entrée, même si la liste blanche de caractères venait à être
 * élargie, ne peut atteindre un identifiant, un appel de fonction ou une
 * portée JavaScript — la classe de vulnérabilité disparaît au lieu d'être
 * simplement rendue improbable (OWASP A03).
 */
function evalArithmetic(src: string): number {
  let i = 0
  const skip = (): void => { while (i < src.length && /\s/.test(src[i] as string)) i++ }
  const peek = (): string | undefined => { skip(); return src[i] }

  // primary := NUMBER | '(' expr ')'
  const primary = (): number => {
    skip()
    if (src[i] === '(') {
      i++
      const v = expr()
      skip()
      if (src[i] !== ')') throw new Error('parenthèse fermante attendue')
      i++
      return v
    }
    const start = i
    while (i < src.length && /[0-9.]/.test(src[i] as string)) i++
    if (i === start) throw new Error(`nombre attendu en position ${i}`)
    const raw = src.slice(start, i)
    // Rejette `1.2.3` (Number le rendrait NaN, on préfère l'erreur explicite).
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`nombre invalide : ${raw}`)
    return n
  }

  // factor := ('-' | '+')* primary
  const factor = (): number => {
    const op = peek()
    if (op === '-') { i++; return -factor() }
    if (op === '+') { i++; return factor() }
    return primary()
  }

  // term := factor (('*' | '/') factor)*
  const term = (): number => {
    let v = factor()
    for (;;) {
      const op = peek()
      if (op === '*')      { i++; v *= factor() }
      else if (op === '/') { i++; v /= factor() }
      else return v
    }
  }

  // expr := term (('+' | '-') term)*
  function expr(): number {
    let v = term()
    for (;;) {
      const op = peek()
      if (op === '+')      { i++; v += term() }
      else if (op === '-') { i++; v -= term() }
      else return v
    }
  }

  const result = expr()
  skip()
  if (i < src.length) throw new Error(`caractère inattendu : ${src[i]}`)
  return result
}

export function evalFormule(formula: string, vars: Record<string, number>): number {
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
    // Analyse arithmétique dédiée : aucune évaluation de code JavaScript.
    // Une variable non substituée (identifiant restant) ou toute syntaxe
    // invalide lève ici et retombe sur 0, comme le faisait le try/catch autour
    // du `new Function()` d'origine.
    const result = evalArithmetic(expr)
    return Math.floor(isFinite(result) ? Math.max(0, result) : 0)
  } catch {
    return 0
  }
}

// Éléments variables de rémunération portés sur le bulletin (ordre d'affichage).
// Leur assujettissement CNPS / ITS est donné par le traitement des éléments
// variables (défaut moteur ← pack ← paramétrage tenant).
const VARIABLE_EARNINGS: ReadonlyArray<{ code: string; label: string; varKey: string }> = [
  { code: '1100', label: "Prime d'ancienneté",              varKey: 'PRIME_ANCIENNETE'  },
  { code: '1200', label: 'Prime de rendement',               varKey: 'PRIME_RENDEMENT'   },
  { code: '1250', label: 'Gratification',                    varKey: 'GRATIFICATION'     },
  { code: '1260', label: 'Avantage en nature',               varKey: 'AVANTAGE_NATURE'   },
  { code: '1300', label: 'Prime de transport',               varKey: 'PRIME_TRANSPORT'   },
  { code: '1350', label: 'Prime de panier',                  varKey: 'PRIME_PANIER'      },
  { code: '1400', label: 'Heures supp. +15%',               varKey: 'HEURES_SUPP_NORM'  },
  { code: '1500', label: 'Heures supp. +50% (nuit/dim)',    varKey: 'HEURES_SUPP_NUIT'  },
  { code: '1550', label: 'Heures supp. +100% (jour férié)', varKey: 'HEURES_SUPP_FERIE' },
  { code: '1600', label: 'Indemnité congés payés',           varKey: 'ICP'               },
]

// Communes du District autonome d'Abidjan (plafond transport « Abidjan »).
const COMMUNES_ABIDJAN = new Set([
  'abidjan', 'abobo', 'adjame', 'anyama', 'attecoube', 'bingerville', 'cocody', 'koumassi',
  'marcory', 'plateau', 'port-bouet', 'port bouet', 'songon', 'treichville', 'yopougon',
])

/**
 * Zone de plafond d'exonération de la prime de transport à partir de la ville
 * du lieu de travail (filiale, sinon tenant). Ville absente → undefined
 * (plafond par défaut du pack).
 */
export function transportZoneFromCity(city?: string | null): string | undefined {
  const c = (city ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
  if (!c) return undefined
  if (COMMUNES_ABIDJAN.has(c) || c.startsWith('abidjan')) return 'abidjan'
  if (c.startsWith('bouake')) return 'bouake'
  return 'autres'
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
    atRate, maritalStatus, childrenCount, absence, attendanceDeductions: att,
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
  if (absence || att?.suspendAttendanceBonus) {
    for (const prime of PRIMES_PRESENCE) delete variableElements[prime]
  }

  // ── ÉTAPE 1 : Variables de base ─────────────────────────────────────────────
  // brutProrata = salaire des jours de PRÉSENCE RÉELLE (hors jours d'absence)
  // Les retenues pointage (absences injustifiées, retards) viennent en
  // déduction du salaire de base, avant cotisations et impôt.
  const salaireJours = Math.floor(baseSalary * (workedDays / workingDaysMonth))
  const retenueAbsences = Math.min(salaireJours, Math.max(0, Math.floor(att?.absenceAmount ?? 0)))
  const retenueRetards  = Math.min(salaireJours - retenueAbsences, Math.max(0, Math.floor(att?.latenessAmount ?? 0)))
  const brutProrata  = salaireJours - retenueAbsences - retenueRetards

  // Solde de tout compte : chaque indemnité entre (ou non) dans l'assiette des
  // cotisations et dans la base imposable selon le pack.
  const treatment = pack.settlementTreatment ?? DEFAULT_SETTLEMENT_TREATMENT
  const settlement = (ctx.settlementEarnings ?? [])
    .map(s => ({ ...s, amount: Math.max(0, Math.round(s.amount)) }))
    .filter(s => s.amount > 0)
  const settlementSocial = settlement.filter(s => treatment[s.key]?.social).reduce((t, s) => t + s.amount, 0)
  const settlementTax    = settlement.filter(s => treatment[s.key]?.tax).reduce((t, s) => t + s.amount, 0)

  // Éléments variables : part soumise aux cotisations et part imposable.
  // Prime de transport : exonérée jusqu'au plafond du pack (zone de travail),
  // l'excédent est cotisable et imposable. Éléments inconnus du traitement :
  // assujettis (rémunération par défaut).
  const baseTreatment: VariableTreatment = { ...DEFAULT_VARIABLE_TREATMENT, ...(pack.traitementElementsVariables ?? {}) }
  const treatmentOf = (key: string): { social: boolean; tax: boolean } => {
    const b = baseTreatment[key] ?? { social: true, tax: true }
    const o = ctx.variableTreatment?.[key]
    return { social: o?.social ?? b.social, tax: o?.tax ?? b.tax }
  }
  const plafondTr = plafondTransport(pack, ctx.transportZone)
  let variablesSocial = 0
  let variablesTax    = 0
  for (const { varKey } of VARIABLE_EARNINGS) {
    const amount = variableElements[varKey] ?? 0
    if (!(amount > 0)) continue
    const o = ctx.variableTreatment?.[varKey]
    if (varKey === 'PRIME_TRANSPORT' && o?.social === undefined && o?.tax === undefined) {
      const excedent = plafondTr === null ? 0 : Math.max(0, amount - plafondTr)
      variablesSocial += excedent
      variablesTax    += excedent
      continue
    }
    const t = treatmentOf(varKey)
    if (t.social) variablesSocial += amount
    if (t.tax)    variablesTax    += amount
  }

  // Plafond ≤ 0 = pas de plafond (BEN, MLI, NER… : sinon base nulle, aucune cotisation)
  const plafond      = (p: number) => (p > 0 ? p : Infinity)
  const baseAtPf     = Math.min(brutProrata + variablesSocial + settlementSocial, plafond(pack.plafondCnpsAtPf))
  const baseRetraite = Math.min(brutProrata + variablesSocial + settlementSocial, plafond(pack.plafondCnpsRetraite))

  // ── ÉTAPE 2 : Cotisations sécurité sociale (présence + éléments variables soumis)
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
    // Indemnité des jours d'absence. Quand présence + absence couvrent tout le
    // mois, l'indemnité est le COMPLÉMENT exact du salaire des jours travaillés
    // (base − prorata) : deux arrondis indépendants feraient perdre 1 F
    // (ex. 77 777 + 62 222 = 139 999 pour une base de 140 000).
    const indemniteJours = (jours: number, taux = 1): number =>
      workedDays + jours >= workingDaysMonth
        ? Math.floor((baseSalary - salaireJours) * taux + 1e-6)
        : Math.floor(tauxJour * jours * taux)

    if (absence.type === 'maternite') {
      indemniteAbsence  = indemniteJours(absence.absenceDays)
      indemniteExoneree = indemniteAbsence
      bordereauCnps = {
        motif: 'maternite',
        montant: indemniteAbsence,
        label: 'Bordereau remboursement CNPS — Congé maternité',
      }
    } else if (absence.type === 'maladie_sans_at') {
      const taux = absence.maintienTaux ?? 1.0
      indemniteAbsence = indemniteJours(absence.absenceDays, taux)
      // Maladie : soumise à ITS — indemniteExoneree reste 0
    } else if (absence.type === 'accident_travail') {
      // Jour J payé par l'employeur = inclus dans brutProrata via workedDays
      const joursIjCnps = absence.atJourAccidentInMonth
        ? Math.max(0, absence.absenceDays - 1)
        : absence.absenceDays
      if (joursIjCnps > 0) {
        indemniteAbsence  = indemniteJours(joursIjCnps)
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
  // Base taxable = (présence + indemnité maladie + indemnités de solde
  // imposables) × (1 − abattement du pack) − cotisations salariales si le pack
  // les déduit. CI (réforme 2024) : abattement 0 et aucune déduction → barème
  // sur 100 % du brut imposable. Indemnités maternité / AT, indemnité de
  // licenciement (limite légale) et remboursements de frais restent hors base.
  const brutTaxable     = brutProrata + variablesTax + indemniteAbsence - indemniteExoneree + settlementTax
  const salaireAbattu   = pack.abattementSurSalaireBase
    ? brutTaxable - Math.floor(brutProrata * pack.abattementImpotSalaire)
    : Math.floor(brutTaxable * (1 - pack.abattementImpotSalaire))
  const deduireCotis    = pack.deduireCotisationsAssietteImpot ?? true
  const baseImposable   = Math.max(0, salaireAbattu - (deduireCotis ? totalCnpsSal : 0))
  const itsBrut         = calculerBaremeImpot(baseImposable, pack)
  const { credit: creditImpot, parts: partsFiscales } = getCreditImpot(maritalStatus, childrenCount, pack)
  // Réduction familiale en % de l'impôt (BF) : charges = conjoint + enfants
  const pctCharges      = pack.reductionImpotPctParCharges
  const nbCharges       = (maritalStatus === 'married' ? 1 : 0) + Math.max(0, childrenCount)
  const reductionPct    = pctCharges?.length ? pctCharges[Math.min(nbCharges, pctCharges.length - 1)] ?? 0 : 0
  const its             = Math.max(0, itsBrut - Math.floor(itsBrut * reductionPct) - creditImpot)

  // ── ÉTAPE 4 : Construction des lignes du bulletin ───────────────────────────
  const lines: PayrollLine[] = []

  lines.push({
    code: '1000', label: 'Salaire de base',
    type: 'earning', base: baseSalary, amount: salaireJours,
  })
  if (retenueAbsences > 0 && att) {
    lines.push({ code: '1010', label: `Retenue absences injustifiées (${att.absenceDays} j)`, type: 'earning', base: baseSalary, amount: -retenueAbsences })
  }
  if (retenueRetards > 0 && att) {
    lines.push({ code: '1020', label: `Retenue retards (${att.lateMinutes} min)`, type: 'earning', base: baseSalary, amount: -retenueRetards })
  }

  for (const e of VARIABLE_EARNINGS) {
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

  for (const s of settlement) {
    lines.push({ code: SETTLEMENT_LINE_CODES[s.key], label: s.label, type: 'earning', base: s.amount, amount: s.amount })
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

  // Avantage en nature : valorisé dans le brut (soumis CNPS / ITS) puis repris
  // en retenue, l'avantage ayant déjà été fourni en nature (logement, véhicule…).
  const avantageNature = Math.max(0, variableElements['AVANTAGE_NATURE'] ?? 0)
  if (avantageNature > 0) lines.push({ code: '5200', label: 'Avantage en nature (fourni en nature)', type: 'deduction', base: 0, amount: avantageNature })

  lines.push({ code: '3000', label: `${caisse} Retraite patronal (${tauxRetPatPct}%)`, type: 'employer_contribution', base: baseRetraite, amount: cnpsRetraitePat })
  lines.push({ code: '3100', label: `${caisse} Prestations familiales (${tauxPfPatPct}%)`, type: 'employer_contribution', base: baseAtPf, amount: Math.floor(baseAtPf * pack.tauxCotisationPfPatronal) })
  if (pack.tauxCotisationMaternitePatronal > 0) {
    lines.push({ code: '3200', label: `${caisse} Assurance maternité (${tauxMatPatPct}%)`, type: 'employer_contribution', base: baseAtPf, amount: Math.floor(baseAtPf * pack.tauxCotisationMaternitePatronal) })
  }
  lines.push({ code: '3300', label: `${caisse} Accidents du travail (${(atRate * 100).toFixed(2)}%)`, type: 'employer_contribution', base: baseAtPf, amount: cnpsAtPat })

  const mutuellePat = variableElements['MUTUELLE_PAT'] ?? 0
  if (mutuellePat > 0) lines.push({ code: '4100', label: 'Mutuelle santé patronal', type: 'employer_contribution', base: 0, amount: mutuellePat })

  // Notes de frais : remboursement de frais réels, hors brut (ni CNPS ni ITS).
  const reimbursement = Math.max(0, Math.round(ctx.expenseReimbursement ?? 0))
  if (reimbursement > 0) {
    lines.push({ code: '6000', label: 'Remboursement de frais professionnels', type: 'reimbursement', base: 0, amount: reimbursement })
  }

  // ── ÉTAPE 5 : Totaux ─────────────────────────────────────────────────────────
  const totalRetenues = totalCnpsSal + its + avance + mutuelleSal + avantageNature
  const netPayable    = Math.max(0, grossSalary - totalRetenues) + reimbursement
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
    itsBrut,
    reductionImpot: Math.min(itsBrut, creditImpot),
    partsFiscales,
    its,
    totalDeductions: totalRetenues,
    netPayable,
    employerCost,
    currency: pack.currency,
    smigCompliant: netPayable >= pack.smigMensuel,
    workingDays: workedDays,
    indemniteAbsence: indemniteAbsence > 0 ? indemniteAbsence : undefined,
    settlementTotal: settlement.length > 0 ? settlement.reduce((t, s) => t + s.amount, 0) : undefined,
    reimbursementTotal: reimbursement > 0 ? reimbursement : undefined,
    bordereauCnps,
  }
}
