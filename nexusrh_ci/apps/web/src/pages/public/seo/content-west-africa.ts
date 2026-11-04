/**
 * Pages multi-pays : hub Afrique de l'Ouest (FR + EN) et pages pays (FR seulement).
 *
 * Règle éditoriale : on ne publie que ce qui est vérifié. La Côte d'Ivoire est le
 * pays de référence ; pour les autres pays de l'UEMOA, les données de paie (SMIG,
 * taux, plafonds, barèmes, abattements, durées) sont en cours de vérification et
 * ne sont PAS publiées : les pages n'en gardent que le contenu qualitatif (caisses,
 * nom de l'impôt, limites connues du pack).
 *
 * Réactiver les chiffres d'un pays, une fois ses valeurs vérifiées dans le pack :
 *   1. passer son `payroll` de 'pending' à 'verified' dans COUNTRY_FACTS ;
 *   2. remettre les tableaux de la page pays, alimentés par le pack ;
 *   3. dans seo-content.test.ts, comparer de nouveau ces chiffres au pack
 *      (le test « données de paie en cours de vérification » l'exige).
 */
import type { SeoPageContent } from './types'

const UPDATED = '2026-11-04'

/** Mention affichée à la place de toute donnée de paie non vérifiée. */
export const PAYROLL_PENDING_FR = 'Données de paie en cours de vérification'
export const PAYROLL_PENDING_EN = 'Payroll data being verified'

export interface CountryFacts {
  /** Code du pack législatif (clé de LEGISLATION_PACKS). */
  pack: string
  fr: string
  en: string
  caisse: string
  impot: string
  currency: 'XOF'
  /** 'verified' : pays de référence, chiffres publiés ; 'pending' : aucun chiffre publié. */
  payroll: 'verified' | 'pending'
}

/** Pays UEMOA couverts par un pack (ordre d'affichage). */
export const COUNTRY_FACTS = {
  CIV: { pack: 'CIV-2024', fr: "Côte d'Ivoire", en: "Côte d'Ivoire", caisse: 'CNPS', impot: 'ITS', currency: 'XOF', payroll: 'verified' },
  SEN: { pack: 'SEN-2024', fr: 'Sénégal', en: 'Senegal', caisse: 'IPRES + CSS', impot: 'IR', currency: 'XOF', payroll: 'pending' },
  BFA: { pack: 'BFA-2024', fr: 'Burkina Faso', en: 'Burkina Faso', caisse: 'CNSS', impot: 'IUTS', currency: 'XOF', payroll: 'pending' },
  BEN: { pack: 'BEN-2024', fr: 'Bénin', en: 'Benin', caisse: 'CNSS', impot: 'ITS', currency: 'XOF', payroll: 'pending' },
  TGO: { pack: 'TGO-2024', fr: 'Togo', en: 'Togo', caisse: 'CNSS (avec AMU)', impot: 'IRPP', currency: 'XOF', payroll: 'pending' },
  MLI: { pack: 'MLI-2024', fr: 'Mali', en: 'Mali', caisse: 'INPS', impot: 'ITS', currency: 'XOF', payroll: 'pending' },
  NER: { pack: 'NER-2024', fr: 'Niger', en: 'Niger', caisse: 'CNSS', impot: 'ITS', currency: 'XOF', payroll: 'pending' },
  GNB: { pack: 'GNB-2024', fr: 'Guinée-Bissau', en: 'Guinea-Bissau', caisse: 'INSS', impot: 'Imposto Profissional', currency: 'XOF', payroll: 'pending' },
} as const satisfies Record<string, CountryFacts>

export type CountryKey = keyof typeof COUNTRY_FACTS

/** Pays UEMOA (zone franc, XOF) couverts. */
export const UEMOA: CountryKey[] = ['CIV', 'SEN', 'BFA', 'BEN', 'TGO', 'MLI', 'NER', 'GNB']
/** Seuls ces pays ont une page dédiée (lien depuis le hub) ; les pages pays sont en français. */
const COUNTRY_PAGE: Partial<Record<CountryKey, string>> = {
  CIV: '/logiciel-paie-cote-divoire',
  SEN: '/logiciel-paie-senegal',
  BFA: '/logiciel-paie-burkina-faso',
  BEN: '/logiciel-paie-benin',
}

function countryRows(keys: CountryKey[], lang: 'fr' | 'en'): string[][] {
  return keys.map((k) => {
    const f: CountryFacts = COUNTRY_FACTS[k]
    const status = f.payroll === 'verified'
      ? (lang === 'fr' ? 'Pays de référence' : 'Reference country')
      : (lang === 'fr' ? PAYROLL_PENDING_FR : PAYROLL_PENDING_EN)
    return [lang === 'fr' ? f.fr : f.en, f.caisse, f.impot, status]
  })
}

const PACK_STATUS_FR =
  "La Côte d'Ivoire est le pays de référence : chaque règle de paie y est verrouillée par des cas calculés à la main. " +
  "Pour les autres pays de la zone UEMOA, les données de paie (SMIG, taux, plafonds, barèmes) sont en cours de " +
  "vérification et ne sont pas publiées ici. Chaque paramétrage est revu avec votre expert paie local avant la première paie."

const PENDING_NOTE_FR = (pays: string): string =>
  `${PAYROLL_PENDING_FR} : les taux, plafonds, barèmes et le SMIG ${pays} seront publiés sur cette page une fois vérifiés.`

export const WEST_AFRICA: SeoPageContent = {
  path: '/sirh-afrique-ouest',
  lang: 'fr',
  kind: 'landing',
  title: "SIRH et paie multi-filiales en Afrique de l'Ouest | NexusRH",
  description:
    "Un seul SIRH pour vos filiales : paie en Côte d'Ivoire et dans la zone UEMOA, extensible aux autres pays " +
    'de la CEDEAO et de la CEMAC.',
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
        { type: 'table', caption: 'Packs législatifs — zone UEMOA',
          head: ['Pays', 'Caisse sociale', 'Impôt sur salaire', 'Données de paie'],
          rows: countryRows(UEMOA, 'fr') },
        { type: 'links', items: UEMOA.filter((k) => COUNTRY_PAGE[k]).map((k) => ({
          to: COUNTRY_PAGE[k]!, label: `Logiciel de paie — ${COUNTRY_FACTS[k].fr}`,
        })) },
      ],
    },
    {
      h2: 'Comment fonctionne un groupe multi-pays',
      blocks: [
        { type: 'ul', items: [
          "Chaque société du groupe est une entité avec son pays : le pack législatif du pays s'installe automatiquement.",
          "Devise, SMIG, préavis et cotisations suivent le pays de l'entité ; les montants restent des entiers dans la devise locale.",
          'La direction du groupe consolide effectifs et masse salariale.',
          "Paie : Côte d'Ivoire et UEMOA, extensible aux autres pays de la CEDEAO et de la CEMAC.",
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
  title: 'HRIS and multi-country payroll for West Africa | NexusRH',
  description:
    "One HRIS for all your subsidiaries: payroll in Côte d'Ivoire and the WAEMU zone, extensible to other " +
    'ECOWAS and CEMAC countries.',
  h1: 'HRIS and multi-country payroll for West Africa',
  lead:
    "A group expanding across the WAEMU zone keeps a single HR system: each subsidiary applies its own country's " +
    'law (social security fund, payroll tax, minimum wage, leave) while head office keeps a consolidated view.',
  crumb: 'West Africa',
  alternate: '/sirh-afrique-ouest',
  updated: UPDATED,
  sections: [
    {
      h2: 'WAEMU countries supported',
      id: 'countries',
      blocks: [
        { type: 'table', caption: 'Country packs — WAEMU zone',
          head: ['Country', 'Social security fund', 'Payroll tax', 'Payroll data'],
          rows: countryRows(UEMOA, 'en') },
      ],
    },
    {
      h2: 'How a multi-country group works',
      blocks: [
        { type: 'ul', items: [
          'Each company in the group is an entity with its own country; the matching country pack is installed automatically.',
          "Currency, minimum wage, notice periods and contributions follow the entity's country; amounts are whole numbers in local currency.",
          'Group management consolidates headcount and payroll costs.',
          "Payroll: Côte d'Ivoire and WAEMU, extensible to other ECOWAS and CEMAC countries.",
          'The application is available in French and English.',
        ] },
      ],
    },
    {
      h2: 'How far each pack is validated',
      blocks: [{ type: 'p', text:
        "Côte d'Ivoire is the reference country: every payroll rule is locked by hand-calculated test cases. For the other " +
        'WAEMU countries, payroll data (minimum wage, rates, ceilings, tax brackets) is being verified and is not published ' +
        'here. Every set-up is reviewed with your local payroll adviser before the first payroll run.' }],
    },
  ],
  related: [],
}

export const SENEGAL: SeoPageContent = {
  path: '/logiciel-paie-senegal',
  lang: 'fr',
  kind: 'landing',
  title: 'Logiciel de paie Sénégal : IPRES, CSS et IR | NexusRH',
  description:
    'Paie sénégalaise dans NexusRH : cotisations IPRES et CSS, impôt sur le revenu, dans le même SIRH que le groupe. ' +
    'Données de paie en cours de vérification.',
  h1: 'Logiciel de paie pour le Sénégal',
  lead:
    "Le pack Sénégal permet à une filiale sénégalaise d'être payée dans le même SIRH que le reste du groupe, avec les " +
    "cotisations IPRES et CSS et l'impôt sur le revenu sénégalais.",
  crumb: 'Sénégal',
  updated: UPDATED,
  sections: [
    {
      h2: 'Cotisations IPRES et CSS',
      blocks: [
        { type: 'p', text:
          "La retraite relève de l'IPRES ; les prestations familiales et les accidents du travail relèvent de la CSS. " +
          'Chaque cotisation est calculée sur sa propre assiette, avec son propre plafond.' },
        { type: 'p', text: PENDING_NOTE_FR('du Sénégal') },
      ],
    },
    {
      h2: 'Impôt sur le revenu',
      blocks: [
        { type: 'ul', items: [
          "L'impôt sur le revenu (IR) est retenu à la source sur le bulletin.",
          "Le quotient familial sénégalais (parts) n'est pas encore modélisé : le calcul de l'IR est à contrôler pour les salariés ayant des charges de famille.",
          "Le régime complémentaire cadres de l'IPRES se paramètre en rubrique propre à l'entreprise.",
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
  title: 'Logiciel de paie Burkina Faso : IUTS et CNSS | NexusRH',
  description:
    'Paie burkinabè dans NexusRH : IUTS selon le code des impôts et cotisations CNSS, dans le même SIRH ' +
    'que le groupe. Données de paie en cours de vérification.',
  h1: 'Logiciel de paie pour le Burkina Faso',
  lead:
    "Le pack Burkina Faso applique l'IUTS et les cotisations CNSS tels que prévus par le code général des impôts et la " +
    'réglementation de la CNSS, pour une filiale burkinabè gérée dans le même SIRH que le groupe.',
  crumb: 'Burkina Faso',
  updated: UPDATED,
  sections: [
    {
      h2: 'Cotisations CNSS',
      blocks: [
        { type: 'p', text:
          'La CNSS couvre la retraite, les prestations familiales et les risques professionnels ; chaque branche a sa ' +
          'part salarié et sa part employeur sur le bulletin.' },
        { type: 'p', text: PENDING_NOTE_FR('du Burkina Faso') },
      ],
    },
    {
      h2: "L'IUTS",
      blocks: [
        { type: 'ul', items: [
          "L'IUTS est calculé selon le code général des impôts : abattement forfaitaire sur le salaire de base, barème " +
            'progressif, puis réduction pour charges de famille.',
          "L'abattement propre aux catégories supérieures n'est pas encore modélisé.",
        ] },
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
  title: 'Logiciel de paie pour le Bénin : ITS et CNSS | NexusRH',
  description:
    'Paie béninoise dans NexusRH : ITS et cotisations CNSS, dans le même SIRH que le reste du groupe. ' +
    'Données de paie en cours de vérification avant publication.',
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
        { type: 'p', text:
          'La CNSS couvre la retraite, les prestations familiales (maternité incluse) et les risques professionnels, ' +
          "dont le taux dépend du risque de l'activité." },
        { type: 'p', text: PENDING_NOTE_FR('du Bénin') },
      ],
    },
    {
      h2: "L'ITS béninois",
      blocks: [
        { type: 'p', text:
          "L'impôt sur les traitements et salaires est retenu à la source selon un barème progressif. Aucune réduction " +
          "pour charges de famille n'est appliquée." },
      ],
    },
    {
      h2: 'Validation',
      blocks: [{ type: 'p', text: PACK_STATUS_FR }],
    },
  ],
  related: ['/sirh-afrique-ouest', '/logiciel-paie-burkina-faso', '/logiciel-paie-senegal', '/logiciel-paie-cote-divoire'],
}
