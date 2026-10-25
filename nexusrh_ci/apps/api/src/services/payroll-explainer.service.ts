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
    formulaHuman: () => 'Prime d\'ancienneté selon la grille interne (soumise CNPS et ITS)',
    legalReference: 'CCN sectorielle CI - Prime d\'ancienneté',
    category: 'premium',
  },
  '1200': {
    formulaHuman: () => 'Prime de rendement variable (saisie manuellement ; soumise CNPS et ITS)',
    legalReference: 'Politique RH interne ; CGI CI art. 116 (assiette ITS)',
    category: 'premium',
  },
  '1250': {
    formulaHuman: () => 'Gratification (13e mois, prime de bilan…) — soumise CNPS et ITS',
    legalReference: 'CGI CI art. 116 (assiette ITS) ; CNPS — assiette des cotisations',
    category: 'premium',
  },
  '1260': {
    formulaHuman: () => 'Avantage en nature (logement, véhicule, domesticité…) valorisé au brut, soumis CNPS et ITS, puis repris en retenue (ligne 5200)',
    legalReference: 'CGI CI art. 116 (avantages en nature imposables)',
    category: 'premium',
  },
  '1300': {
    formulaHuman: () => 'Prime de transport mensuelle — exonérée CNPS et ITS jusqu\'à 30 000 F (Abidjan), 24 000 F (Bouaké), 20 000 F (autres villes) ; l\'excédent est soumis',
    legalReference: 'CGI CI art. 116 al. 10 (annexe fiscale 2023) ; arrêté n° 2020-012/MEPS/CAB du 30/01/2020',
    category: 'premium',
  },
  '1400': {
    formulaHuman: () => 'Heures supplémentaires majorées de +15 % (41h → 48h/semaine) — soumises CNPS et ITS',
    rate: 0.15,
    legalReference: 'Code du Travail CI - Article 21.3 (heures supplémentaires)',
    category: 'overtime',
  },
  '1500': {
    formulaHuman: () => 'Heures supplémentaires de nuit / dimanche majorées de +50 % — soumises CNPS et ITS',
    rate: 0.50,
    legalReference: 'Code du Travail CI - Article 21.3 (travail de nuit & dimanche)',
    category: 'overtime',
  },
  '1550': {
    formulaHuman: () => 'Heures supplémentaires de jour férié majorées de +100 % — soumises CNPS et ITS',
    rate: 1.0,
    legalReference: 'Code du Travail CI - Article 21.3 (heures supplémentaires)',
    category: 'overtime',
  },
  '1600': {
    formulaHuman: () => 'Allocation de congés payés (2,2 jours ouvrables / mois de service ; salaire moyen des 12 mois ÷ 30 × jours calendaires) — soumise CNPS et ITS',
    legalReference: 'Code du Travail CI - Article 25 (droit aux congés payés)',
    category: 'leave',
  },
  // ─── BULLETIN DE SOLDE (solde de tout compte) ───────────────────────────
  '1610': {
    formulaHuman: () => 'Indemnité compensatrice des congés acquis non pris à la date de sortie (soumise CNPS et ITS)',
    legalReference: 'Code du Travail CI - Article 25 ; CCI art. 71',
    category: 'leave',
  },
  '1620': {
    formulaHuman: () => 'Indemnité compensatrice du préavis non effectué (soumise CNPS et ITS)',
    legalReference: 'Convention collective interprofessionnelle CI (préavis)',
    category: 'leave',
  },
  '1630': {
    formulaHuman: () => 'Indemnité de licenciement ou de départ à la retraite, dans la limite légale (hors assiette CNPS, exonérée d’ITS)',
    legalReference: 'Décret n° 2017-210 du 30 mars 2017 (indemnité de licenciement)',
    category: 'leave',
  },
  '6000': {
    formulaHuman: () => 'Remboursement des notes de frais approuvées (frais professionnels réels justifiés) — hors brut, ni CNPS ni ITS, ajouté au net à payer',
    legalReference: 'CGI CI - frais professionnels remboursés sur justificatifs (non imposables)',
    category: 'other',
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
    formulaHuman: () => 'ITS — Barème mensuel progressif appliqué sur 100 % du brut imposable, puis réduction pour charges de famille (RICF) selon le nombre de parts',
    baseLabel: 'Brut imposable sans abattement · barème 0/16/21/24/28/32 % (0-75k / 75k-240k / 240k-800k / 800k-2,4M / 2,4M-8M / >8M)',
    legalReference: 'Ordonnance n° 2023-719 du 13/09/2023 (réforme ITS, en vigueur au 01/01/2024) — Code Général des Impôts CI',
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
