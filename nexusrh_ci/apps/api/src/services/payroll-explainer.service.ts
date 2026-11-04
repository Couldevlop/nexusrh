// Service d'explication transparente des bulletins de paie CI
// Inspiration : Workday "Pay Explained" · PayFit Smart Lines · Gusto Pay Insights
// Objectif : casser la "boîte noire" en exposant pour chaque ligne :
//   - formule de calcul (texte humain)
//   - taux ou variable de référence
//   - article de loi / décret CI applicable

import type { PayrollLine } from './payroll-engine-ci.js'
import { CIV_2024, type LegislationPack } from './legislation-packs.js'

// Taux, plafonds et majorations CI : lus dans le pack CIV (source unique),
// jamais recopiés ici.
const TAUX_CNPS = {
  retraite:               { salarial: CIV_2024.tauxCotisationRetraiteSalarie, patronal: CIV_2024.tauxCotisationRetraitePatronal },
  prestationsFamiliales:  { salarial: 0, patronal: CIV_2024.tauxCotisationPfPatronal },
  maternite:              { salarial: 0, patronal: CIV_2024.tauxCotisationMaternitePatronal },
}
const PLAFOND_CNPS_RETRAITE_MENSUEL = CIV_2024.plafondCnpsRetraite
const PLAFOND_CNPS_AT_PF_MENSUEL    = CIV_2024.plafondCnpsAtPf
const CIV_OT = CIV_2024.leaveRules?.overtimeRates ?? {}
const CIV_CMU = CIV_2024.cmu
const REF_PLAFONDS_CNPS = 'plafond : communiqué CNPS du 11/01/2023 (décret n° 2022-986 du 21/12/2022), en vigueur au 01/01/2023'
const REF_HEURES_SUPP = 'Décret n° 2024-898 du 16/10/2024 relatif à la durée du travail, art. 25 (abroge le décret n° 96-203, mêmes taux)'
const REF_CMU = 'Loi n° 2014-131 du 24/03/2014 instituant la Couverture maladie universelle ; 1 000 F/mois par personne, partagés 50/50 employeur / salarié, recouvrés par la CNPS'
const LAST_WEEKLY_HOUR = (CIV_OT.weeklyBeyondFromHour ?? 47) - 1

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
    formulaHuman: () => `Heures supplémentaires de la 41e à la ${LAST_WEEKLY_HOUR}e heure de la semaine, majorées de +${pctFr(CIV_OT.weekly ?? 0)} — soumises CNPS et ITS`,
    rate: CIV_OT.weekly,
    legalReference: REF_HEURES_SUPP,
    category: 'overtime',
  },
  '1450': {
    formulaHuman: () => `Heures supplémentaires au-delà de la ${LAST_WEEKLY_HOUR}e heure de la semaine, majorées de +${pctFr(CIV_OT.weeklyBeyond ?? 0)} — soumises CNPS et ITS`,
    rate: CIV_OT.weeklyBeyond,
    legalReference: REF_HEURES_SUPP,
    category: 'overtime',
  },
  '1500': {
    formulaHuman: () => `Heures supplémentaires de nuit majorées de +${pctFr(CIV_OT.night ?? 0)} — soumises CNPS et ITS`,
    rate: CIV_OT.night,
    legalReference: REF_HEURES_SUPP,
    category: 'overtime',
  },
  '1520': {
    formulaHuman: () => `Heures supplémentaires de jour, les dimanches et jours fériés, majorées de +${pctFr(CIV_OT.sunday ?? 0)} — soumises CNPS et ITS`,
    rate: CIV_OT.sunday,
    legalReference: REF_HEURES_SUPP,
    category: 'overtime',
  },
  '1550': {
    formulaHuman: () => `Heures supplémentaires de nuit, les dimanches et jours fériés, majorées de +${pctFr(CIV_OT.sundayHolidayNight ?? 0)} — soumises CNPS et ITS`,
    rate: CIV_OT.sundayHolidayNight,
    legalReference: REF_HEURES_SUPP,
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
    legalReference: `Code CNPS CI - Décret 96-194 (cotisation retraite salariale 6,30 %) ; ${REF_PLAFONDS_CNPS}`,
    category: 'cnps',
  },
  '2100': {
    formulaHuman: () => 'ITS — Barème mensuel progressif appliqué sur 100 % du brut imposable, puis réduction pour charges de famille (RICF) selon le nombre de parts',
    baseLabel: 'Brut imposable sans abattement · barème 0/16/21/24/28/32 % (0-75k / 75k-240k / 240k-800k / 800k-2,4M / 2,4M-8M / >8M)',
    legalReference: 'Ordonnance n° 2023-719 du 13/09/2023 (réforme ITS, en vigueur au 01/01/2024) — Code Général des Impôts CI',
    category: 'tax',
  },
  '2200': {
    formulaHuman: () => CIV_CMU
      ? `CMU — ${FCFA(CIV_CMU.perBeneficiary * (1 - CIV_CMU.employerShare))} F par bénéficiaire (salarié, conjoint sans emploi, jusqu'à ${CIV_CMU.maxSharedChildren} enfants de moins de 21 ans) + ${FCFA(CIV_CMU.perBeneficiary)} F par enfant au-delà du ${CIV_CMU.maxSharedChildren}e — hors assiettes CNPS et ITS`
      : 'CMU — part salariale',
    legalReference: REF_CMU,
    category: 'health',
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
    legalReference: `Code CNPS CI - Décret 96-194 (cotisation retraite patronale 7,70 %) ; ${REF_PLAFONDS_CNPS}`,
    category: 'cnps',
  },
  '3100': {
    formulaHuman: () => `Base AT/PF × ${(TAUX_CNPS.prestationsFamiliales.patronal * 100).toFixed(2)} %`,
    rate: TAUX_CNPS.prestationsFamiliales.patronal,
    baseLabel: `Salaire brut plafonné à ${FCFA(PLAFOND_CNPS_AT_PF_MENSUEL)} FCFA`,
    legalReference: `Code CNPS CI - Prestations familiales (5,00 %) ; ${REF_PLAFONDS_CNPS}`,
    category: 'cnps',
  },
  '3200': {
    formulaHuman: () => `Base AT/PF × ${(TAUX_CNPS.maternite.patronal * 100).toFixed(2)} %`,
    rate: TAUX_CNPS.maternite.patronal,
    baseLabel: `Salaire brut plafonné à ${FCFA(PLAFOND_CNPS_AT_PF_MENSUEL)} FCFA`,
    legalReference: `Code CNPS CI - Assurance maternité (0,75 %) ; ${REF_PLAFONDS_CNPS}`,
    category: 'cnps',
  },
  '3300': {
    formulaHuman: (rate) => `Base AT/PF × ${rate ? (rate * 100).toFixed(2) : '?'} % (taux variable selon secteur)`,
    baseLabel: `Salaire brut plafonné à ${FCFA(PLAFOND_CNPS_AT_PF_MENSUEL)} FCFA · Taux 2-5 % selon secteur`,
    legalReference: `Code CNPS CI - Accidents du travail (2,00-5,00 % selon secteur) ; ${REF_PLAFONDS_CNPS}`,
    category: 'cnps',
  },
  '3400': {
    formulaHuman: () => CIV_CMU
      ? `CMU — ${FCFA(CIV_CMU.perBeneficiary * CIV_CMU.employerShare)} F par bénéficiaire (salarié, conjoint sans emploi, jusqu'à ${CIV_CMU.maxSharedChildren} enfants de moins de 21 ans) — hors assiettes CNPS et ITS`
      : 'CMU — part patronale',
    legalReference: REF_CMU,
    category: 'health',
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

/** Pourcentage à la française : 0 ou 1 décimale (virgule) selon le besoin. */
function pctFr(rate: number): string {
  const v = Math.round(rate * 1000) / 10
  return `${String(v).replace('.', ',')} %`
}

function isCivPack(pack?: LegislationPack): boolean {
  return !pack || pack.countryCode === 'CIV'
}

// Rubriques dont la référence légale est générique (non propre à la CI).
const GENERIC_LEGAL_CODES = new Set(['4000', '4100'])

function ceilingLabel(amount: number): string {
  return amount > 0 ? `Salaire brut plafonné à ${FCFA(amount)} FCFA` : 'Salaire brut (aucun plafond paramétré)'
}

/** Explication d'une rubrique pour un pack non ivoirien : tout est dérivé du pack. */
function packExplainer(code: string, base: RuleExplainer, pack: LegislationPack): RuleExplainer {
  const caisse = pack.labelCaisseSociale
  const impot = pack.labelImpotSalaire.split(' — ')[0] ?? pack.labelImpotSalaire
  const ot = pack.leaveRules?.overtimeRates ?? {}
  const swap = (t: string): string => t.replace(/CNPS/g, caisse).replace(/ITS/g, impot)
  const generic: RuleExplainer = {
    ...base,
    formulaHuman: (r) => swap(base.formulaHuman(r)),
    baseLabel: base.baseLabel === undefined ? undefined : swap(base.baseLabel),
    legalReference: GENERIC_LEGAL_CODES.has(code) ? base.legalReference : '',
  }
  switch (code) {
    case '1300': {
      const t = pack.primeTransportExoneree
      let txt: string
      if (!t) {
        txt = `Prime de transport mensuelle — aucun plafond d'exonération paramétré pour ce pays`
      } else {
        const zones = Object.entries(t.parZone ?? {}).map(([z, v]) => `${FCFA(v)} F (${z})`)
        txt = `Prime de transport mensuelle — exonérée ${caisse} et ${impot} jusqu'à ${FCFA(t.defaut)} F`
          + (zones.length > 0 ? ` (par zone : ${zones.join(', ')})` : '')
          + ` ; l'excédent est soumis`
      }
      return { ...generic, formulaHuman: () => txt }
    }
    case '1400': {
      const r = ot.weekly
      return {
        ...generic, rate: r,
        formulaHuman: () => r === undefined
          ? 'Heures supplémentaires — majoration non paramétrée pour ce pays'
          : `Heures supplémentaires majorées de +${pctFr(r)} — soumises ${caisse} et ${impot}`,
      }
    }
    case '1500': {
      const n = ot.night, d = ot.sunday
      let txt: string
      if (n !== undefined && d !== undefined) {
        txt = n === d
          ? `Heures supplémentaires de nuit / dimanche majorées de +${pctFr(n)} — soumises ${caisse} et ${impot}`
          : `Heures supplémentaires de nuit (+${pctFr(n)}) / dimanche (+${pctFr(d)}) — soumises ${caisse} et ${impot}`
      } else if (n !== undefined) {
        txt = `Heures supplémentaires de nuit majorées de +${pctFr(n)} — soumises ${caisse} et ${impot}`
      } else if (d !== undefined) {
        txt = `Heures supplémentaires de dimanche majorées de +${pctFr(d)} — soumises ${caisse} et ${impot}`
      } else {
        txt = 'Heures supplémentaires de nuit / dimanche — majoration non paramétrée pour ce pays'
      }
      return { ...generic, rate: n ?? d, formulaHuman: () => txt }
    }
    case '1450': {
      const r = ot.weeklyBeyond
      return {
        ...generic, rate: r,
        formulaHuman: () => r === undefined
          ? 'Heures supplémentaires au-delà du seuil hebdomadaire — majoration non paramétrée pour ce pays'
          : `Heures supplémentaires au-delà du seuil hebdomadaire majorées de +${pctFr(r)} — soumises ${caisse} et ${impot}`,
      }
    }
    case '1520': {
      const r = ot.sunday
      return {
        ...generic, rate: r,
        formulaHuman: () => r === undefined
          ? 'Heures supplémentaires de dimanche — majoration non paramétrée pour ce pays'
          : `Heures supplémentaires de dimanche majorées de +${pctFr(r)} — soumises ${caisse} et ${impot}`,
      }
    }
    case '2200':
    case '3400':
      return { ...generic, formulaHuman: () => 'Couverture maladie selon les règles du pays (hors assiettes des cotisations et de l’impôt)' }
    case '1550': {
      const r = ot.holiday
      return {
        ...generic, rate: r,
        formulaHuman: () => r === undefined
          ? 'Heures supplémentaires de jour férié — majoration non paramétrée pour ce pays'
          : `Heures supplémentaires de jour férié majorées de +${pctFr(r)} — soumises ${caisse} et ${impot}`,
      }
    }
    case '1600':
      return { ...generic, formulaHuman: () => `Allocation de congés payés selon les règles du pays — soumise ${caisse} et ${impot}` }
    case '1610':
    case '1620':
    case '1630':
      return { ...generic, formulaHuman: () => `Élément de solde de tout compte selon les règles du pays (${base.formulaHuman().split('(')[0]?.trim() ?? ''})` }
    case '2000':
      return { ...generic, rate: pack.tauxCotisationRetraiteSalarie, baseLabel: ceilingLabel(pack.plafondCnpsRetraite),
        formulaHuman: () => `Base retraite × ${(pack.tauxCotisationRetraiteSalarie * 100).toFixed(2)} %` }
    case '2100':
      return { ...generic, baseLabel: undefined,
        formulaHuman: () => `${impot} — barème progressif du pays appliqué au brut imposable, puis réductions pour charges de famille selon le pack` }
    case '3000':
      return { ...generic, rate: pack.tauxCotisationRetraitePatronal, baseLabel: ceilingLabel(pack.plafondCnpsRetraite),
        formulaHuman: () => `Base retraite × ${(pack.tauxCotisationRetraitePatronal * 100).toFixed(2)} %` }
    case '3100':
      return { ...generic, rate: pack.tauxCotisationPfPatronal, baseLabel: ceilingLabel(pack.plafondCnpsAtPf),
        formulaHuman: () => `Base AT/PF × ${(pack.tauxCotisationPfPatronal * 100).toFixed(2)} %` }
    case '3200':
      return { ...generic, rate: pack.tauxCotisationMaternitePatronal, baseLabel: ceilingLabel(pack.plafondCnpsAtPf),
        formulaHuman: () => `Base AT/PF × ${(pack.tauxCotisationMaternitePatronal * 100).toFixed(2)} %` }
    case '3300':
      return { ...generic, baseLabel: ceilingLabel(pack.plafondCnpsAtPf),
        formulaHuman: (r) => `Base AT/PF × ${r ? (r * 100).toFixed(2) : '?'} % (taux variable selon secteur)` }
    default:
      return generic
  }
}

export function explainLine(line: PayrollLine, computedRate?: number, pack?: LegislationPack): ExplainedLine {
  const civ = CI_RULE_EXPLAINERS[line.code] ?? FALLBACK
  if (isCivPack(pack) || !pack) {
    const rate = civ.rate ?? computedRate
    return {
      ...line,
      formulaHuman: civ.formulaHuman(rate),
      rate,
      baseLabel: civ.baseLabel,
      legalReference: civ.legalReference,
      category: civ.category,
    }
  }
  const exp = line.code in CI_RULE_EXPLAINERS ? packExplainer(line.code, civ, pack) : { ...civ, legalReference: '' }
  const isOvertime = civ.category === 'overtime'
  const rate = isOvertime ? exp.rate : (exp.rate ?? computedRate)
  return {
    ...line,
    formulaHuman: exp.formulaHuman(rate),
    rate,
    baseLabel: exp.baseLabel,
    legalReference: exp.legalReference === '' ? undefined : exp.legalReference,
    category: exp.category,
  }
}

export function explainLines(lines: PayrollLine[], pack?: LegislationPack): ExplainedLine[] {
  return lines.map(l => {
    const computedRate = l.base > 0 ? Math.abs(l.amount) / l.base : undefined
    return explainLine(l, computedRate, pack)
  })
}
