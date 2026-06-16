/**
 * i18n NexusRH CI — Français (défaut) + Anglais.
 *
 * - Détection : localStorage `nexusrh:lang` puis langue du navigateur, repli fr.
 * - Persistance : chaque changement de langue est mémorisé dans localStorage.
 * - Un namespace par domaine fonctionnel : chaque page importe le sien via
 *   useTranslation('<ns>') — les fichiers vivent dans ./locales/{fr,en}/<ns>.json.
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// ── Français ──────────────────────────────────────────────────────────────────
import frCommon from './locales/fr/common.json'
import frNav from './locales/fr/nav.json'
import frAuth from './locales/fr/auth.json'
import frDashboard from './locales/fr/dashboard.json'
import frEmployees from './locales/fr/employees.json'
import frContracts from './locales/fr/contracts.json'
import frCareers from './locales/fr/careers.json'
import frPayroll from './locales/fr/payroll.json'
import frCnps from './locales/fr/cnps.json'
import frMobileMoney from './locales/fr/mobileMoney.json'
import frAbsences from './locales/fr/absences.json'
import frExpenses from './locales/fr/expenses.json'
import frTraining from './locales/fr/training.json'
import frRecruitment from './locales/fr/recruitment.json'
import frOnboarding from './locales/fr/onboarding.json'
import frReporting from './locales/fr/reporting.json'
import frSettings from './locales/fr/settings.json'
import frPlatform from './locales/fr/platform.json'
import frAgency from './locales/fr/agency.json'
import frMonEspace from './locales/fr/monEspace.json'
import frReferentiels from './locales/fr/referentiels.json'
import frRaf from './locales/fr/raf.json'
import frPublicPages from './locales/fr/publicPages.json'
import frDg from './locales/fr/dg.json'
import frOrgChart from './locales/fr/orgChart.json'
import frDiscipline from './locales/fr/discipline.json'
import frOffboarding from './locales/fr/offboarding.json'
import frClimate from './locales/fr/climate.json'

// ── English ───────────────────────────────────────────────────────────────────
import enCommon from './locales/en/common.json'
import enNav from './locales/en/nav.json'
import enAuth from './locales/en/auth.json'
import enDashboard from './locales/en/dashboard.json'
import enEmployees from './locales/en/employees.json'
import enContracts from './locales/en/contracts.json'
import enCareers from './locales/en/careers.json'
import enPayroll from './locales/en/payroll.json'
import enCnps from './locales/en/cnps.json'
import enMobileMoney from './locales/en/mobileMoney.json'
import enAbsences from './locales/en/absences.json'
import enExpenses from './locales/en/expenses.json'
import enTraining from './locales/en/training.json'
import enRecruitment from './locales/en/recruitment.json'
import enOnboarding from './locales/en/onboarding.json'
import enReporting from './locales/en/reporting.json'
import enSettings from './locales/en/settings.json'
import enPlatform from './locales/en/platform.json'
import enAgency from './locales/en/agency.json'
import enMonEspace from './locales/en/monEspace.json'
import enReferentiels from './locales/en/referentiels.json'
import enRaf from './locales/en/raf.json'
import enPublicPages from './locales/en/publicPages.json'
import enDg from './locales/en/dg.json'
import enOrgChart from './locales/en/orgChart.json'
import enDiscipline from './locales/en/discipline.json'
import enOffboarding from './locales/en/offboarding.json'
import enClimate from './locales/en/climate.json'

export const LANGUAGE_STORAGE_KEY = 'nexusrh:lang'
export const SUPPORTED_LANGUAGES = ['fr', 'en'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const NAMESPACES = [
  'common', 'nav', 'auth', 'dashboard', 'employees', 'contracts', 'careers',
  'payroll', 'cnps', 'mobileMoney', 'absences', 'expenses', 'training',
  'recruitment', 'onboarding', 'reporting', 'settings', 'platform', 'agency',
  'monEspace', 'referentiels', 'raf', 'publicPages', 'dg', 'orgChart', 'discipline', 'offboarding', 'climate',
] as const

const resources = {
  fr: {
    common: frCommon, nav: frNav, auth: frAuth, dashboard: frDashboard,
    employees: frEmployees, contracts: frContracts, careers: frCareers,
    payroll: frPayroll, cnps: frCnps, mobileMoney: frMobileMoney,
    absences: frAbsences, expenses: frExpenses, training: frTraining,
    recruitment: frRecruitment, onboarding: frOnboarding, reporting: frReporting,
    settings: frSettings, platform: frPlatform, agency: frAgency,
    monEspace: frMonEspace, referentiels: frReferentiels, raf: frRaf,
    publicPages: frPublicPages, dg: frDg, orgChart: frOrgChart, discipline: frDiscipline,
    offboarding: frOffboarding, climate: frClimate,
  },
  en: {
    common: enCommon, nav: enNav, auth: enAuth, dashboard: enDashboard,
    employees: enEmployees, contracts: enContracts, careers: enCareers,
    payroll: enPayroll, cnps: enCnps, mobileMoney: enMobileMoney,
    absences: enAbsences, expenses: enExpenses, training: enTraining,
    recruitment: enRecruitment, onboarding: enOnboarding, reporting: enReporting,
    settings: enSettings, platform: enPlatform, agency: enAgency,
    monEspace: enMonEspace, referentiels: enReferentiels, raf: enRaf,
    publicPages: enPublicPages, dg: enDg, orgChart: enOrgChart, discipline: enDiscipline,
    offboarding: enOffboarding, climate: enClimate,
  },
} as const

function detectInitialLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (stored === 'fr' || stored === 'en') return stored
  } catch { /* stockage inaccessible (navigation privée stricte) */ }
  try {
    if (navigator.language?.toLowerCase().startsWith('en')) return 'en'
  } catch { /* environnement sans navigator */ }
  return 'fr'
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectInitialLanguage(),
  fallbackLng: 'fr',
  defaultNS: 'common',
  ns: [...NAMESPACES],
  interpolation: { escapeValue: false }, // React échappe déjà
  returnNull: false,
})

i18n.on('languageChanged', (lng) => {
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, lng) } catch { /* non bloquant */ }
  try { document.documentElement.lang = lng } catch { /* environnement sans DOM */ }
})

export default i18n
