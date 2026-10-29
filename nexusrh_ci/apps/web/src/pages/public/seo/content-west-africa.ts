/**
 * Pages multi-pays : hub Afrique de l'Ouest (FR + EN) et pages pays.
 *
 * Règle éditoriale : on ne publie que ce que le moteur applique réellement.
 * Les valeurs viennent des packs législatifs 2024 (apps/api/src/services/
 * legislation-packs.ts) ; seo-content.test.ts compare COUNTRY_FACTS aux packs,
 * donc une valeur modifiée dans un pack sans être reportée ici casse le build.
 * Les limites connues d'un pack (règles fines non modélisées) sont dites.
 */
import type { SeoPageContent } from './types'

const UPDATED = '2026-10-29'

export interface CountryFacts {
  /** Code du pack législatif (clé de LEGISLATION_PACKS). */
  pack: string
  fr: string
  en: string
  caisse: string
  impot: string
  currency: 'XOF' | 'XAF' | 'NGN' | 'GHS'
  smig: number
  retraiteSal: number
  retraitePat: number
  pf: number
  plafondRetraite: number
  plafondAtPf: number
  congesParMois: number
  joursParSemaine: number
}

/** Pays CEDEAO couverts par un pack (ordre d'affichage). */
export const COUNTRY_FACTS = {
  CIV: { pack: 'CIV-2024', fr: "Côte d'Ivoire", en: "Côte d'Ivoire", caisse: 'CNPS', impot: 'ITS', currency: 'XOF', smig: 75_000, retraiteSal: 0.063, retraitePat: 0.077, pf: 0.05, plafondRetraite: 1_647_315, plafondAtPf: 70_000, congesParMois: 2.2, joursParSemaine: 6 },
  SEN: { pack: 'SEN-2024', fr: 'Sénégal', en: 'Senegal', caisse: 'IPRES + CSS', impot: 'IR', currency: 'XOF', smig: 64_710, retraiteSal: 0.056, retraitePat: 0.084, pf: 0.07, plafondRetraite: 432_000, plafondAtPf: 63_000, congesParMois: 2.0, joursParSemaine: 5 },
  BFA: { pack: 'BFA-2024', fr: 'Burkina Faso', en: 'Burkina Faso', caisse: 'CNSS', impot: 'IUTS', currency: 'XOF', smig: 45_000, retraiteSal: 0.055, retraitePat: 0.085, pf: 0.06, plafondRetraite: 800_000, plafondAtPf: 800_000, congesParMois: 2.5, joursParSemaine: 6 },
  BEN: { pack: 'BEN-2024', fr: 'Bénin', en: 'Benin', caisse: 'CNSS', impot: 'ITS', currency: 'XOF', smig: 52_000, retraiteSal: 0.036, retraitePat: 0.064, pf: 0.09, plafondRetraite: 0, plafondAtPf: 0, congesParMois: 2.0, joursParSemaine: 6 },
  TGO: { pack: 'TGO-2024', fr: 'Togo', en: 'Togo', caisse: 'CNSS (avec AMU)', impot: 'IRPP', currency: 'XOF', smig: 52_500, retraiteSal: 0.09, retraitePat: 0.175, pf: 0.03, plafondRetraite: 0, plafondAtPf: 0, congesParMois: 2.5, joursParSemaine: 6 },
  MLI: { pack: 'MLI-2024', fr: 'Mali', en: 'Mali', caisse: 'INPS', impot: 'ITS', currency: 'XOF', smig: 40_000, retraiteSal: 0.036, retraitePat: 0.054, pf: 0.08, plafondRetraite: 0, plafondAtPf: 0, congesParMois: 2.5, joursParSemaine: 6 },
  NER: { pack: 'NER-2024', fr: 'Niger', en: 'Niger', caisse: 'CNSS', impot: 'ITS', currency: 'XOF', smig: 30_047, retraiteSal: 0.0525, retraitePat: 0.065, pf: 0.085, plafondRetraite: 0, plafondAtPf: 0, congesParMois: 2.5, joursParSemaine: 6 },
  GNB: { pack: 'GNB-2024', fr: 'Guinée-Bissau', en: 'Guinea-Bissau', caisse: 'INSS', impot: 'Imposto Profissional', currency: 'XOF', smig: 50_000, retraiteSal: 0.08, retraitePat: 0.14, pf: 0, plafondRetraite: 0, plafondAtPf: 0, congesParMois: 2.5, joursParSemaine: 5 },
  GHA: { pack: 'GHA-2024', fr: 'Ghana', en: 'Ghana', caisse: 'SSNIT', impot: 'PAYE', currency: 'GHS', smig: 490, retraiteSal: 0.055, retraitePat: 0.13, pf: 0, plafondRetraite: 0, plafondAtPf: 0, congesParMois: 1.25, joursParSemaine: 5 },
  NGA: { pack: 'NGA-2024', fr: 'Nigeria', en: 'Nigeria', caisse: 'PenCom / NHF', impot: 'PAYE', currency: 'NGN', smig: 70_000, retraiteSal: 0.08, retraitePat: 0.10, pf: 0.025, plafondRetraite: 0, plafondAtPf: 0, congesParMois: 0.5, joursParSemaine: 5 },
} as const satisfies Record<string, CountryFacts>

export type CountryKey = keyof typeof COUNTRY_FACTS

/** Pays UEMOA (zone franc, XOF) couverts. */
const UEMOA: CountryKey[] = ['CIV', 'SEN', 'BFA', 'BEN', 'TGO', 'MLI', 'NER', 'GNB']
const ANGLO: CountryKey[] = ['GHA', 'NGA']
/** Pays ayant une page dédiée (lien depuis le tableau). */
const COUNTRY_PAGE: Partial<Record<CountryKey, string>> = {
  CIV: '/logiciel-paie-cote-divoire',
  SEN: '/logiciel-paie-senegal',
  BFA: '/logiciel-paie-burkina-faso',
  BEN: '/logiciel-paie-benin',
}

// ── Formatage (espaces simples : pas d'U+202F, cf. toLocaleString) ──────────
const n = (v: number): string => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const pctFr = (r: number): string => `${String(Math.round(r * 10000) / 100).replace('.', ',')} %`
const pctEn = (r: number): string => `${Math.round(r * 10000) / 100}%`
const money = (f: CountryFacts, lang: 'fr' | 'en'): string => {
  const unit = f.currency === 'XOF' || f.currency === 'XAF' ? 'FCFA' : f.currency
  return lang === 'fr' ? `${n(f.smig)} ${unit}` : `${n(f.smig).replace(/ /g, ',')} ${unit}`
}
const ceiling = (v: number, lang: 'fr' | 'en'): string =>
  v > 0 ? (lang === 'fr' ? n(v) : n(v).replace(/ /g, ',')) : (lang === 'fr' ? 'sans plafond' : 'no ceiling')

function countryRows(keys: CountryKey[], lang: 'fr' | 'en'): string[][] {
  return keys.map((k) => {
    const f: CountryFacts = COUNTRY_FACTS[k]
    const pct = lang === 'fr' ? pctFr : pctEn
    return [
      lang === 'fr' ? f.fr : f.en,
      f.caisse,
      f.impot,
      money(f, lang),
      `${pct(f.retraiteSal)} / ${pct(f.retraitePat)}`,
    ]
  })
}

const PACK_STATUS_FR =
  "La Côte d'Ivoire est le pack de référence : chaque règle y est verrouillée par des cas de paie calculés à la main. " +
  "Les autres packs reprennent les taux et barèmes publiés (codes des impôts, caisses nationales, CLEISS) ; certaines " +
  "règles fines propres à un pays ne sont pas encore modélisées et sont signalées sur la page du pays. Chaque " +
  "paramétrage est revu avec votre expert paie local avant la première paie."

export const WEST_AFRICA: SeoPageContent = {
  path: '/sirh-afrique-ouest',
  lang: 'fr',
  kind: 'landing',
  title: "SIRH et paie multi-pays en Afrique de l'Ouest (UEMOA) | NexusRH",
  description:
    "Un seul SIRH pour vos filiales en Côte d'Ivoire, au Sénégal, au Burkina Faso, au Bénin, au Togo, au Mali, " +
    'au Niger, au Ghana et au Nigeria.',
  h1: "SIRH et paie multi-pays pour l'Afrique de l'Ouest",
  lead:
    "Un groupe qui s'étend dans la zone UEMOA garde un seul système RH : chaque filiale applique la législation de son " +
    'pays (caisse sociale, impôt sur salaire, SMIG, congés), et la direction garde une vue consolidée.',
  crumb: "Afrique de l'Ouest",
  alternate: '/en/hris-payroll-west-africa',
  updated: UPDATED,
  sections: [
    {
      h2: 'Pays de la zone UEMOA pris en charge',
      id: 'pays',
      blocks: [
        { type: 'table', caption: 'Packs législatifs 2024 — zone UEMOA',
          head: ['Pays', 'Caisse sociale', 'Impôt sur salaire', 'SMIG mensuel', 'Retraite salarié / employeur'],
          rows: countryRows(UEMOA, 'fr') },
        { type: 'links', items: UEMOA.filter((k) => COUNTRY_PAGE[k]).map((k) => ({
          to: COUNTRY_PAGE[k]!, label: `Logiciel de paie — ${COUNTRY_FACTS[k].fr}`,
        })) },
      ],
    },
    {
      h2: 'Ghana et Nigeria',
      blocks: [
        { type: 'p', text:
          "Pour les groupes présents dans la CEDEAO anglophone, deux packs supplémentaires gèrent la paie en cedi (GHS) " +
          "et en naira (NGN)." },
        { type: 'table', caption: 'Packs législatifs 2024 — Ghana et Nigeria',
          head: ['Pays', 'Caisse sociale', 'Impôt sur salaire', 'Salaire minimum mensuel', 'Retraite salarié / employeur'],
          rows: countryRows(ANGLO, 'fr') },
        { type: 'p', text:
          "Ghana : les allègements fiscaux individuels et le plafond SSNIT ne sont pas encore modélisés. Nigeria : la " +
          "Consolidated Relief Allowance et le barème NTA 2025 applicable en 2026 restent à intégrer." },
      ],
    },
    {
      h2: 'Comment fonctionne un groupe multi-pays',
      blocks: [
        { type: 'ul', items: [
          "Chaque société du groupe est une entité avec son pays : le pack législatif du pays s'installe automatiquement.",
          'Devise, SMIG, préavis et cotisations suivent le pays de l’entité ; les montants restent des entiers dans la devise locale.',
          'Les responsables de site ne voient que leur périmètre ; la direction du groupe consolide effectifs et masse salariale.',
          "Les packs couvrent aussi six pays de la CEMAC (Cameroun, Gabon, Congo, Tchad, Centrafrique, Guinée équatoriale), en FCFA CEMAC.",
        ] },
      ],
    },
    {
      h2: 'Niveau de validation des packs',
      blocks: [{ type: 'p', text: PACK_STATUS_FR }],
    },
  ],
  related: ['/logiciel-paie-cote-divoire', '/logiciel-paie-senegal', '/logiciel-paie-burkina-faso', '/logiciel-paie-benin'],
}

export const WEST_AFRICA_EN: SeoPageContent = {
  path: '/en/hris-payroll-west-africa',
  lang: 'en',
  kind: 'landing',
  title: 'HRIS and multi-country payroll for West Africa | NexusRH CI',
  description:
    "One HRIS for subsidiaries in Côte d'Ivoire, Senegal, Burkina Faso, Benin, Togo, Mali, Niger, Ghana and " +
    'Nigeria, with country payroll rules built in.',
  h1: 'HRIS and multi-country payroll for West Africa',
  lead:
    'A group expanding across the WAEMU zone keeps a single HR system: each subsidiary applies its own country’s ' +
    'law (social security fund, payroll tax, minimum wage, leave) while head office keeps a consolidated view.',
  crumb: 'West Africa',
  alternate: '/sirh-afrique-ouest',
  updated: UPDATED,
  sections: [
    {
      h2: 'WAEMU countries supported',
      id: 'countries',
      blocks: [
        { type: 'table', caption: '2024 country packs — WAEMU zone',
          head: ['Country', 'Social security fund', 'Payroll tax', 'Monthly minimum wage', 'Pension employee / employer'],
          rows: countryRows(UEMOA, 'en') },
      ],
    },
    {
      h2: 'Ghana and Nigeria',
      blocks: [
        { type: 'p', text:
          'For groups operating in English-speaking ECOWAS countries, two additional packs run payroll in cedi (GHS) and naira (NGN).' },
        { type: 'table', caption: '2024 country packs — Ghana and Nigeria',
          head: ['Country', 'Social security fund', 'Payroll tax', 'Monthly minimum wage', 'Pension employee / employer'],
          rows: countryRows(ANGLO, 'en') },
        { type: 'p', text:
          'Ghana: individual tax reliefs and the SSNIT insurable earnings cap are not modelled yet. Nigeria: the ' +
          'Consolidated Relief Allowance and the NTA 2025 brackets that apply from 2026 are still to be added.' },
      ],
    },
    {
      h2: 'How a multi-country group works',
      blocks: [
        { type: 'ul', items: [
          'Each company in the group is an entity with its own country; the matching country pack is installed automatically.',
          'Currency, minimum wage, notice periods and contributions follow the entity’s country; amounts are whole numbers in local currency.',
          'Site managers only see their own scope; group management consolidates headcount and payroll costs.',
          'Packs also cover six CEMAC countries (Cameroon, Gabon, Congo, Chad, Central African Republic, Equatorial Guinea).',
          'The application is available in French and English.',
        ] },
      ],
    },
    {
      h2: 'How far each pack is validated',
      blocks: [{ type: 'p', text:
        "Côte d'Ivoire is the reference pack: every rule is locked by hand-calculated payroll test cases. The other packs use " +
        'published rates and brackets (tax codes, national funds, CLEISS); some country-specific rules are not modelled yet ' +
        'and are listed above. Every set-up is reviewed with your local payroll adviser before the first payroll run.' }],
    },
  ],
  related: [],
}

export const SENEGAL: SeoPageContent = {
  path: '/logiciel-paie-senegal',
  lang: 'fr',
  kind: 'landing',
  title: 'Logiciel de paie Sénégal : IPRES, CSS et IR | NexusRH CI',
  description:
    'Paie sénégalaise dans NexusRH CI : cotisations IPRES et CSS avec leurs plafonds, IR, semaine de 40 heures, ' +
    'pour les groupes présents au Sénégal.',
  h1: 'Logiciel de paie pour le Sénégal',
  lead:
    "Le pack Sénégal permet à une filiale sénégalaise d'être payée dans le même SIRH que le reste du groupe, avec les " +
    'cotisations IPRES et CSS et l’impôt sur le revenu sénégalais.',
  crumb: 'Sénégal',
  updated: UPDATED,
  sections: [
    {
      h2: 'Cotisations IPRES et CSS',
      blocks: [
        { type: 'table', caption: 'Paramètres du pack Sénégal 2024 (FCFA par mois)',
          head: ['Élément', 'Valeur'],
          rows: [
            ['IPRES régime général — salarié', '5,6 %'],
            ['IPRES régime général — employeur', '8,4 %'],
            ['Plafond IPRES', '432 000'],
            ['CSS prestations familiales — employeur', '7 %'],
            ['Plafond CSS', '63 000'],
            ['CSS accident du travail — taux par défaut', '1 % (ajustable au taux notifié)'],
            ['SMIG retenu', '64 710'],
          ] },
      ],
    },
    {
      h2: 'Impôt sur le revenu et temps de travail',
      blocks: [
        { type: 'ul', items: [
          "L'IR est calculé avec un abattement de 30 % et un barème progressif de 0 à 40 %.",
          "Le quotient familial sénégalais (parts) n'est pas encore modélisé : le calcul de l'IR est à contrôler pour les salariés ayant des charges de famille.",
          'Semaine de travail de cinq jours (40 heures) ; congés acquis à 2 jours par mois.',
          'Le régime complémentaire cadres de l’IPRES se paramètre en rubrique propre à l’entreprise.',
        ] },
      ],
    },
    {
      h2: 'Le reste du SIRH',
      blocks: [
        { type: 'p', text:
          'Dossiers salariés, congés, recrutement, formation et entretiens fonctionnent de la même manière dans toutes les ' +
          "filiales. Le groupe consolide ses effectifs et sa masse salariale, en FCFA, avec la Côte d'Ivoire et les autres pays." },
        { type: 'p', text: PACK_STATUS_FR },
      ],
    },
  ],
  related: ['/sirh-afrique-ouest', '/logiciel-paie-burkina-faso', '/logiciel-paie-benin', '/logiciel-paie-cote-divoire'],
}

export const BURKINA: SeoPageContent = {
  path: '/logiciel-paie-burkina-faso',
  lang: 'fr',
  kind: 'landing',
  title: 'Logiciel de paie Burkina Faso : IUTS et CNSS | NexusRH CI',
  description:
    'Paie burkinabè : IUTS selon le CGI (barème 0 à 25 %, abattement 25 %, réduction pour charges de famille), ' +
    'cotisations CNSS plafonnées à 800 000 FCFA.',
  h1: 'Logiciel de paie pour le Burkina Faso',
  lead:
    'Le pack Burkina Faso applique l’IUTS et les cotisations CNSS tels que prévus par le code général des impôts et la ' +
    'réglementation de la CNSS, pour une filiale burkinabè gérée dans le même SIRH que le groupe.',
  crumb: 'Burkina Faso',
  updated: UPDATED,
  sections: [
    {
      h2: 'Cotisations CNSS',
      blocks: [
        { type: 'table', caption: 'Paramètres du pack Burkina Faso 2024 (FCFA par mois)',
          head: ['Élément', 'Valeur'],
          rows: [
            ['Retraite — salarié', '5,5 %'],
            ['Retraite — employeur', '8,5 %'],
            ['Prestations familiales — employeur', '6 %'],
            ['Risques professionnels — employeur', '1,5 %'],
            ['Plafond de cotisation', '800 000'],
            ['SMIG retenu', '45 000'],
          ] },
      ],
    },
    {
      h2: "L'IUTS",
      blocks: [
        { type: 'ul', items: [
          'Abattement forfaitaire de 25 % calculé sur le seul salaire de base (article 111 du CGI).',
          'Réduction pour charges de famille de 8, 10, 12 ou 14 % de l’IUTS pour 1 à 4 charges (article 113).',
          "L'abattement de 20 % propre aux catégories supérieures n'est pas encore modélisé.",
        ] },
        { type: 'table', caption: 'Barème mensuel de l’IUTS (article 112 du CGI)',
          head: ['Tranche de revenu net imposable', 'Taux'],
          rows: [
            ['0 à 30 000', '0 %'], ['30 001 à 50 000', '12,1 %'], ['50 001 à 80 000', '13,9 %'],
            ['80 001 à 120 000', '15,7 %'], ['120 001 à 170 000', '18,4 %'], ['170 001 à 250 000', '21,7 %'],
            ['Au-delà de 250 000', '25 %'],
          ] },
        { type: 'p', text: 'Congés acquis à 2,5 jours par mois ; congé de maternité de 14 semaines.' },
      ],
    },
    {
      h2: 'Validation',
      blocks: [{ type: 'p', text: PACK_STATUS_FR }],
    },
  ],
  related: ['/sirh-afrique-ouest', '/logiciel-paie-senegal', '/logiciel-paie-benin', '/logiciel-paie-cote-divoire'],
}

export const BENIN: SeoPageContent = {
  path: '/logiciel-paie-benin',
  lang: 'fr',
  kind: 'landing',
  title: 'Logiciel de paie Bénin : ITS et CNSS | NexusRH CI',
  description:
    'Paie béninoise : ITS au barème mensuel de 0 à 30 %, cotisations CNSS sans plafond, prestations familiales ' +
    'à 9 %, dans le même SIRH que le reste du groupe.',
  h1: 'Logiciel de paie pour le Bénin',
  lead:
    "Le pack Bénin applique l'impôt sur les traitements et salaires béninois et les cotisations CNSS, pour une filiale " +
    'gérée dans le même SIRH que le reste du groupe.',
  crumb: 'Bénin',
  updated: UPDATED,
  sections: [
    {
      h2: 'Cotisations CNSS',
      blocks: [
        { type: 'table', caption: 'Paramètres du pack Bénin 2024 (FCFA par mois)',
          head: ['Élément', 'Valeur'],
          rows: [
            ['Retraite — salarié', '3,6 %'],
            ['Retraite — employeur', '6,4 %'],
            ['Prestations familiales — employeur (maternité incluse)', '9 %'],
            ['Risques professionnels — employeur', '2 % par défaut (1 à 4 % selon le risque)'],
            ['Plafond de cotisation', 'aucun'],
            ['SMIG retenu', '52 000'],
          ] },
      ],
    },
    {
      h2: "L'ITS béninois",
      blocks: [
        { type: 'table', caption: 'Barème mensuel de l’ITS',
          head: ['Tranche de salaire imposable', 'Taux'],
          rows: [
            ['0 à 60 000', '0 %'], ['60 001 à 150 000', '10 %'], ['150 001 à 250 000', '15 %'],
            ['250 001 à 500 000', '19 %'], ['Au-delà de 500 000', '30 %'],
          ] },
        { type: 'p', text:
          "Aucune réduction pour charges de famille n'est appliquée. Congés acquis à 2 jours par mois ; congé de maternité " +
          'de 14 semaines, indemnisé à parts égales par la CNSS et l’employeur.' },
      ],
    },
    {
      h2: 'Validation',
      blocks: [{ type: 'p', text: PACK_STATUS_FR }],
    },
  ],
  related: ['/sirh-afrique-ouest', '/logiciel-paie-burkina-faso', '/logiciel-paie-senegal', '/logiciel-paie-cote-divoire'],
}
