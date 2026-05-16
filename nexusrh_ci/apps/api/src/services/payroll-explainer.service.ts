// Service d'explication transparente des bulletins de paie CI
// Inspiration : Workday "Pay Explained" · PayFit Smart Lines · Gusto Pay Insights
// Objectif : casser la "boîte noire" en exposant pour chaque ligne :
//   - formule de calcul (texte humain)
//   - taux ou variable de référence
//   - article de loi / décret CI applicable

import type { PayrollLine } from './payroll-engine-ci.js'

// Constantes CNPS CI 2024 (copiées de packages/shared/src/constants/ci.ts
// pour éviter une dépendance cross-package au build).
const TAUX_CNPS = {
  retraite:               { salarial: 0.063,  patronal: 0.077  },
  prestationsFamiliales:  { salarial: 0,      patronal: 0.050  },
  maternite:              { salarial: 0,      patronal: 0.0075 },
}
const PLAFOND_CNPS_RETRAITE_MENSUEL = 1_647_315
const PLAFOND_CNPS_AT_PF_MENSUEL    = 70_000

export interface ExplainedLine extends PayrollLine {
  formulaHuman: string
  rate?: number
  baseLabel?: string
  legalReference?: string
  category: 'salary' | 'premium' | 'overtime' | 'leave' | 'cnps' | 'tax' | 'health' | 'advance' | 'other'
}

interface RuleExplainer {
  formulaHuman: (rate?: number) => string
  rate?: number
  baseLabel?: string
  legalReference: string
  category: ExplainedLine['category']
}

const FCFA = (n: number) => n.toLocaleString('fr-FR')

const CI_RULE_EXPLAINERS: Record<string, RuleExplainer> = {
  // ─── GAINS ───────────────────────────────────────────────────────────────
  '1000': {
    formulaHuman: () => 'Salaire de base mensuel contractuel (au prorata des jours travaillés)',
    legalReference: 'Code du Travail CI - Article 31.1 (rémunération contractuelle)',
    category: 'salary',
  },
  '1100': {
    formulaHuman: () => 'Prime d\'ancienneté selon la grille interne',
    legalReference: 'CCN sectorielle CI - Prime d\'ancienneté',
    category: 'premium',
  },
  '1200': {
    formulaHuman: () => 'Prime de rendement variable (saisie manuellement)',
    legalReference: 'Politique RH interne',
    category: 'premium',
  },
  '1300': {
    formulaHuman: () => 'Prime de transport mensuelle',
    legalReference: 'CCN CI - Indemnité de déplacement (exonérée CNPS dans la limite légale)',
    category: 'premium',
  },
  '1400': {
    formulaHuman: () => 'Heures supplémentaires majorées de +15 % (41h → 48h/semaine)',
    rate: 0.15,
    legalReference: 'Code du Travail CI - Article 21.3 (heures supplémentaires)',
    category: 'overtime',
  },
  '1500': {
    formulaHuman: () => 'Heures supplémentaires de nuit / dimanche majorées de +50 %',
    rate: 0.50,
    legalReference: 'Code du Travail CI - Article 21.3 (travail de nuit & dimanche)',
    category: 'overtime',
  },
  '1600': {
    formulaHuman: () => 'Indemnité de congés payés (2,5 jours ouvrables / mois travaillé)',
    legalReference: 'Code du Travail CI - Article 25 (droit aux congés payés)',
    category: 'leave',
  },

  // ─── COTISATIONS SALARIÉ ─────────────────────────────────────────────────
  '2000': {
    formulaHuman: () => `Base retraite × ${(TAUX_CNPS.retraite.salarial * 100).toFixed(2)} %`,
    rate: TAUX_CNPS.retraite.salarial,
    baseLabel: `Salaire brut plafonné à ${FCFA(PLAFOND_CNPS_RETRAITE_MENSUEL)} FCFA`,
    legalReference: 'Code CNPS CI - Décret 96-194 (cotisation retraite salariale 6,30 %)',
    category: 'cnps',
  },
  '2100': {
    formulaHuman: () => 'ITS — Barème DGI progressif sur (Brut × 85 % − cotisations CNPS) puis crédit d\'impôt famille',
    baseLabel: 'Abattement professionnel 15 % + barème 0/1,5/5/10/15 %',
    legalReference: 'Loi de finances CI - Code Général des Impôts, articles 116 à 124 (ITS)',
    category: 'tax',
  },
  '4000': {
    formulaHuman: () => 'Mutuelle / Assurance santé — part salariale (selon contrat collectif)',
    legalReference: 'Convention santé d\'entreprise',
    category: 'health',
  },

  // ─── COTISATIONS EMPLOYEUR ────────────────────────────────────────────────
  '3000': {
    formulaHuman: () => `Base retraite × ${(TAUX_CNPS.retraite.patronal * 100).toFixed(2)} %`,
    rate: TAUX_CNPS.retraite.patronal,
    baseLabel: `Salaire brut plafonné à ${FCFA(PLAFOND_CNPS_RETRAITE_MENSUEL)} FCFA`,
    legalReference: 'Code CNPS CI - Décret 96-194 (cotisation retraite patronale 7,70 %)',
    category: 'cnps',
  },
  '3100': {
    formulaHuman: () => `Base AT/PF × ${(TAUX_CNPS.prestationsFamiliales.patronal * 100).toFixed(2)} %`,
    rate: TAUX_CNPS.prestationsFamiliales.patronal,
    baseLabel: `Salaire brut plafonné à ${FCFA(PLAFOND_CNPS_AT_PF_MENSUEL)} FCFA`,
    legalReference: 'Code CNPS CI - Prestations familiales (5,00 %)',
    category: 'cnps',
  },
  '3200': {
    formulaHuman: () => `Base AT/PF × ${(TAUX_CNPS.maternite.patronal * 100).toFixed(2)} %`,
    rate: TAUX_CNPS.maternite.patronal,
    baseLabel: `Salaire brut plafonné à ${FCFA(PLAFOND_CNPS_AT_PF_MENSUEL)} FCFA`,
    legalReference: 'Code CNPS CI - Assurance maternité (0,75 %)',
    category: 'cnps',
  },
  '3300': {
    formulaHuman: (rate) => `Base AT/PF × ${rate ? (rate * 100).toFixed(2) : '?'} % (taux variable selon secteur)`,
    baseLabel: `Salaire brut plafonné à ${FCFA(PLAFOND_CNPS_AT_PF_MENSUEL)} FCFA · Taux 2-5 % selon secteur`,
    legalReference: 'Code CNPS CI - Accidents du travail (2,00-5,00 % selon secteur)',
    category: 'cnps',
  },
  '4100': {
    formulaHuman: () => 'Mutuelle / Assurance santé — part patronale (selon contrat collectif)',
    legalReference: 'Convention santé d\'entreprise',
    category: 'health',
  },

  // ─── RETENUES DIVERSES ────────────────────────────────────────────────────
  '5000': {
    formulaHuman: () => 'Avance sur salaire (déduite du net)',
    legalReference: 'Code du Travail CI - Avances et acomptes',
    category: 'advance',
  },
  '5100': {
    formulaHuman: () => 'Retenue pour absence non justifiée (au prorata des jours)',
    legalReference: 'Code du Travail CI - Article 26 (absences non rémunérées)',
    category: 'other',
  },
}

const FALLBACK: RuleExplainer = {
  formulaHuman: () => 'Élément calculé selon le paramétrage du tenant',
  legalReference: 'Paramétrage interne — référence légale non répertoriée',
  category: 'other',
}

export function explainLine(line: PayrollLine, computedRate?: number): ExplainedLine {
  const exp = CI_RULE_EXPLAINERS[line.code] ?? FALLBACK
  const rate = exp.rate ?? computedRate
  return {
    ...line,
    formulaHuman: exp.formulaHuman(rate),
    rate,
    baseLabel: exp.baseLabel,
    legalReference: exp.legalReference,
    category: exp.category,
  }
}

export function explainLines(lines: PayrollLine[]): ExplainedLine[] {
  return lines.map(l => {
    const computedRate = l.base > 0 ? Math.abs(l.amount) / l.base : undefined
    return explainLine(l, computedRate)
  })
}
