/**
 * Catalogue des sources officielles d'information juridique par pays.
 *
 * Utilisé par le module Veille Réglementaire (legal-watch) comme suggestions
 * pour le super_admin. Le scraping direct n'est PAS automatique : le super_admin
 * choisit lesquelles activer via la variable d'env LEGAL_WATCH_SOURCES.
 *
 * SOURCES PRIORITAIRES = sites gouvernementaux officiels (.gouv, ministères,
 * organismes publics CNPS/CSS/IPRES/DGI). Évite les agrégateurs tiers.
 *
 * À mettre à jour quand un site change d'URL (vérifier `last_verified` sous
 * forme d'audit annuel).
 */

export interface OfficialLegalSource {
  /** Code ISO-3 du pays */
  countryCode:  string
  /** Libellé pays */
  countryName:  string
  /** Catégorie : code_travail | jo | dgi | cnps | css | ipres | ministere | autres */
  source:       string
  /** Nom officiel de l'organisme/source */
  organism:     string
  /** URL principale (page d'accueil ou base) */
  url:          string
  /** Sections fréquemment mises à jour (URLs spécifiques) */
  watchUrls?:   string[]
  /** Notes : licence, scraping autorisé, format des publications */
  notes?:       string
  /** Date de dernière vérification manuelle (ISO date) */
  lastVerified?: string
}

export const LEGAL_SOURCES_CATALOG: OfficialLegalSource[] = [
  // ─── Côte d'Ivoire (CIV) ────────────────────────────────────────────────
  {
    countryCode: 'CIV', countryName: 'Côte d\'Ivoire',
    source: 'jo', organism: 'Secrétariat Général du Gouvernement',
    url: 'https://www.sgg.gouv.ci/',
    watchUrls: ['https://www.sgg.gouv.ci/journal-officiel'],
    notes: 'Journal Officiel CI — lois, décrets, arrêtés (PDF). Mise à jour hebdomadaire.',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'CIV', countryName: 'Côte d\'Ivoire',
    source: 'dgi', organism: 'Direction Générale des Impôts (DGI)',
    url: 'https://www.dgi.gouv.ci/',
    watchUrls: ['https://www.dgi.gouv.ci/site/textes-fiscaux'],
    notes: 'Barème ITS, circulaires, instructions fiscales',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'CIV', countryName: 'Côte d\'Ivoire',
    source: 'cnps', organism: 'Caisse Nationale de Prévoyance Sociale (CNPS)',
    url: 'https://www.cnps.ci/',
    watchUrls: ['https://www.cnps.ci/textes-officiels', 'https://www.cnps.ci/cotisations'],
    notes: 'Taux cotisations retraite/PF/AT/maternité, plafonds, DISA',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'CIV', countryName: 'Côte d\'Ivoire',
    source: 'ministere', organism: 'Ministère de la Fonction Publique et de l\'Emploi',
    url: 'https://www.emploi.gouv.ci/',
    notes: 'Code du Travail CI, conventions collectives, SMIG',
    lastVerified: '2026-05-16',
  },

  // ─── Sénégal (SEN) ───────────────────────────────────────────────────────
  {
    countryCode: 'SEN', countryName: 'Sénégal',
    source: 'jo', organism: 'Journal Officiel République du Sénégal',
    url: 'http://www.jo.gouv.sn/',
    notes: 'Lois, décrets sénégalais (PDF/HTML)',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'SEN', countryName: 'Sénégal',
    source: 'dgi', organism: 'Direction Générale des Impôts et Domaines (DGID)',
    url: 'https://www.impotsetdomaines.gouv.sn/',
    notes: 'IRPP, IS, TVA Sénégal',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'SEN', countryName: 'Sénégal',
    source: 'ipres', organism: 'Institution de Prévoyance Retraite du Sénégal (IPRES)',
    url: 'https://www.ipres.sn/',
    notes: 'Cotisations retraite SN (régimes Général + Cadre)',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'SEN', countryName: 'Sénégal',
    source: 'css', organism: 'Caisse de Sécurité Sociale (CSS)',
    url: 'https://www.css.sn/',
    notes: 'Prestations familiales, AT/MP, maternité SN',
    lastVerified: '2026-05-16',
  },

  // ─── Bénin (BEN) ─────────────────────────────────────────────────────────
  {
    countryCode: 'BEN', countryName: 'Bénin',
    source: 'ministere', organism: 'Ministère du Travail et de la Fonction Publique',
    url: 'https://travail.gouv.bj/',
    notes: 'Code du Travail Bénin, SMIG',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'BEN', countryName: 'Bénin',
    source: 'cnss', organism: 'Caisse Nationale de Sécurité Sociale du Bénin',
    url: 'https://www.cnss.bj/',
    notes: 'Cotisations sociales Bénin',
    lastVerified: '2026-05-16',
  },

  // ─── Togo (TGO) ──────────────────────────────────────────────────────────
  {
    countryCode: 'TGO', countryName: 'Togo',
    source: 'cnss', organism: 'Caisse Nationale de Sécurité Sociale du Togo',
    url: 'https://www.cnss.tg/',
    notes: 'Régime sécurité sociale Togo',
    lastVerified: '2026-05-16',
  },

  // ─── Burkina Faso (BFA) ─────────────────────────────────────────────────
  {
    countryCode: 'BFA', countryName: 'Burkina Faso',
    source: 'cnss', organism: 'Caisse Nationale de Sécurité Sociale du Burkina',
    url: 'https://www.cnssbf.com/',
    notes: 'Cotisations BF',
    lastVerified: '2026-05-16',
  },

  // ─── Mali (MLI) ──────────────────────────────────────────────────────────
  {
    countryCode: 'MLI', countryName: 'Mali',
    source: 'inps', organism: 'Institut National de Prévoyance Sociale du Mali',
    url: 'https://www.inps.ml/',
    notes: 'Cotisations Mali',
    lastVerified: '2026-05-16',
  },

  // ─── Niger (NER) ─────────────────────────────────────────────────────────
  {
    countryCode: 'NER', countryName: 'Niger',
    source: 'cnss', organism: 'Caisse Nationale de Sécurité Sociale du Niger',
    url: 'https://www.cnss.ne/',
    notes: 'Cotisations Niger',
    lastVerified: '2026-05-16',
  },

  // ─── Cameroun (CMR) ──────────────────────────────────────────────────────
  {
    countryCode: 'CMR', countryName: 'Cameroun',
    source: 'cnps', organism: 'Caisse Nationale de Prévoyance Sociale du Cameroun',
    url: 'https://www.cnps.cm/',
    notes: 'Cotisations CMR, CEMAC',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'CMR', countryName: 'Cameroun',
    source: 'dgi', organism: 'Direction Générale des Impôts Cameroun',
    url: 'https://www.impots.cm/',
    notes: 'IR, IS, TVA Cameroun',
    lastVerified: '2026-05-16',
  },

  // ─── Tchad (TCD) ─────────────────────────────────────────────────────────
  {
    countryCode: 'TCD', countryName: 'Tchad',
    source: 'cnps', organism: 'Caisse Nationale de Prévoyance Sociale du Tchad',
    url: 'https://www.cnpstchad.org/',
    notes: 'Cotisations TCD',
    lastVerified: '2026-05-16',
  },

  // ─── Nigeria (NGA) — hors UEMOA, NGN ─────────────────────────────────────
  {
    countryCode: 'NGA', countryName: 'Nigeria',
    source: 'nsitf', organism: 'Nigeria Social Insurance Trust Fund',
    url: 'https://nsitf.gov.ng/',
    notes: 'Employee Compensation Scheme Nigeria',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'NGA', countryName: 'Nigeria',
    source: 'firs', organism: 'Federal Inland Revenue Service',
    url: 'https://www.firs.gov.ng/',
    notes: 'PAYE, PIT, VAT Nigeria',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'NGA', countryName: 'Nigeria',
    source: 'pencom', organism: 'National Pension Commission',
    url: 'https://www.pencom.gov.ng/',
    notes: 'Pension Reform Act, taux pensions NGA',
    lastVerified: '2026-05-16',
  },

  // ─── Ghana (GHA) — CEDEAO ────────────────────────────────────────────────
  {
    countryCode: 'GHA', countryName: 'Ghana',
    source: 'ssnit', organism: 'Social Security and National Insurance Trust',
    url: 'https://ssnit.org.gh/',
    notes: 'Cotisations SSNIT Ghana',
    lastVerified: '2026-05-16',
  },
  {
    countryCode: 'GHA', countryName: 'Ghana',
    source: 'gra', organism: 'Ghana Revenue Authority',
    url: 'https://gra.gov.gh/',
    notes: 'PAYE Ghana, taux impôt',
    lastVerified: '2026-05-16',
  },
]

/** Liste les sources par pays — utilitaire frontend */
export function getSourcesByCountry(countryCode: string): OfficialLegalSource[] {
  return LEGAL_SOURCES_CATALOG.filter(s => s.countryCode === countryCode.toUpperCase())
}
