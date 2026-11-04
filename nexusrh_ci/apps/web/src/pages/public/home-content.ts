/**
 * Structure de la vitrine publique : domaines fonctionnels, modules, modes de
 * déploiement et FAQ. Le TEXTE est dans i18n (home.json, FR + EN) ; ce fichier
 * ne porte que les clés et leur ordre.
 *
 * Une seule source pour trois sorties :
 *   - le rendu React de la page d'accueil (HomePage) ;
 *   - le JSON-LD (FAQPage, featureList) du pré-rendu (src/prerender/entry.tsx) ;
 *   - llms.txt et llms-full.txt (mêmes textes, aucune divergence possible).
 *
 * Règle éditoriale : chaque module annoncé correspond à du code présent dans le
 * dépôt. `module` = clé du catalogue des modules activables par entreprise
 * (apps/api/src/services/tenant-modules.service.ts, MODULE_KEYS) — vérifiée par
 * home-page.test.tsx. `null` = fonction socle, toujours présente (dossiers
 * salariés, espace salarié, journal d'audit…).
 */

/** Clé du catalogue des modules activables (miroir de MODULE_KEYS côté API). */
export type CatalogModuleKey =
  | 'contracts' | 'payroll' | 'absences' | 'expenses' | 'recruitment' | 'onboarding' | 'training'
  | 'careers' | 'cnps' | 'mobile_money' | 'reporting' | 'integrations' | 'ai' | 'org_chart'
  | 'discipline' | 'offboarding' | 'climate' | 'succession' | 'competencies' | 'calibration'
  | 'mobility' | 'classification' | 'signature' | 'security' | 'sage' | 'dg_view' | 'attendance'
  | 'interview_sim' | 'employer_brand'

export interface HomeModule {
  /** Clé i18n : home.domains.<domaine>.modules.<key>.{title,text} */
  key: string
  module: CatalogModuleKey | null
}

export interface HomeDomain {
  /** Clé i18n : home.domains.<key>.title */
  key: string
  modules: HomeModule[]
}

export const HOME_DOMAINS: HomeDomain[] = [
  {
    key: 'people',
    modules: [
      { key: 'records',     module: null },
      { key: 'contracts',   module: 'contracts' },
      { key: 'orgChart',    module: 'org_chart' },
      { key: 'discipline',  module: 'discipline' },
      { key: 'offboarding', module: 'offboarding' },
      { key: 'dg',          module: 'dg_view' },
    ],
  },
  {
    key: 'payroll',
    modules: [
      { key: 'engine',       module: 'payroll' },
      { key: 'declarations', module: 'cnps' },
      { key: 'mobileMoney',  module: 'mobile_money' },
      { key: 'bank',         module: 'payroll' },
      { key: 'sage',         module: 'sage' },
      { key: 'expenses',     module: 'expenses' },
    ],
  },
  {
    key: 'time',
    modules: [
      { key: 'leave',          module: 'absences' },
      { key: 'attendance',     module: 'attendance' },
      { key: 'attendancePay',  module: 'attendance' },
    ],
  },
  {
    key: 'talent',
    modules: [
      { key: 'recruitment',  module: 'recruitment' },
      { key: 'agency',       module: null },
      { key: 'competencies', module: 'competencies' },
      { key: 'calibration',  module: 'calibration' },
      { key: 'succession',   module: 'succession' },
      { key: 'mobility',     module: 'mobility' },
      { key: 'training',     module: 'training' },
    ],
  },
  {
    key: 'experience',
    modules: [
      { key: 'selfService',   module: null },
      { key: 'onboarding',    module: 'onboarding' },
      { key: 'climate',       module: 'climate' },
      { key: 'employerBrand', module: 'employer_brand' },
      { key: 'interviewSim',  module: 'interview_sim' },
      { key: 'assistant',     module: 'ai' },
    ],
  },
  {
    key: 'security',
    modules: [
      { key: 'sso',            module: 'security' },
      { key: 'siem',           module: 'security' },
      { key: 'signature',      module: 'signature' },
      { key: 'classification', module: 'classification' },
      { key: 'integrations',   module: 'integrations' },
      { key: 'audit',          module: null },
    ],
  },
]

/** Lignes du tableau comparatif SaaS / on-premise (home.deploy.rows.<key>). */
export const DEPLOY_ROWS = ['hosting', 'data', 'updates', 'start', 'access', 'fit'] as const
/** Points de chaque mode (home.deploy.<mode>.<point>). */
export const DEPLOY_POINTS = {
  saas: ['p1', 'p2', 'p3', 'p4'],
  onprem: ['p1', 'p2', 'p3', 'p4', 'p5'],
} as const

/** FAQ visible de la vitrine (home.faq.items.<key>.{q,a}) — publiée aussi en FAQPage. */
export const HOME_FAQ = [
  'modes', 'hosting', 'compliance', 'mobileMoney', 'migration',
  'groups', 'coverage', 'languages', 'trial', 'support',
] as const

/** Ancres de la page d'accueil (navigation, llms.txt). */
export const HOME_ANCHORS = {
  modules: 'modules',
  deploy: 'deploiement',
  security: 'securite',
  trust: 'confiance',
  faq: 'faq',
  demo: 'demo',
} as const

/** Un numéro : affichage lisible + format E.164 (liens tel:, JSON-LD). */
export interface Phone { display: string; e164: string }

/**
 * Coordonnées de l'éditeur (CLAUDE.md § Contacts, numéros mis à jour sur
 * consigne du porteur le 04/11/2026). Ordre d'affichage : CI, CI, France.
 */
export const PHONES: readonly Phone[] = [
  { display: '+225 07 09 33 42 38', e164: '+2250709334238' },
  { display: '+225 07 49 43 92 03', e164: '+2250749439203' },
  { display: '+33 6 19 24 53 29',   e164: '+33619245329' },
]

export const PUBLISHER = {
  name: 'OpenLab Consulting',
  url: 'https://www.openlabconsulting.com',
  demoEmail: 'waopron@openlabconsulting.com',
  infoEmail: 'infos@openlabconsulting.com',
  supportEmail: 'support@nexusrh-ci.com',
  whatsappDisplay: '+225 07 49 43 92 03',
  whatsapp: 'https://wa.me/2250749439203',
} as const

/** Nombre de modules du catalogue activable (MODULE_KEYS.length côté API) — vérifié par test. */
export const CATALOG_MODULE_COUNT = 29
