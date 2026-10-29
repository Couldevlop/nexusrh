/**
 * Chemins des pages publiques de contenu (pages d'atterrissage + guides).
 *
 * Fichier volontairement minuscule : App.tsx l'importe pour déclarer les
 * routes, sans embarquer le contenu (chargé à la demande avec la page).
 * Toute entrée ici doit avoir son contenu dans ./content et une règle nginx
 * (nginx.conf) — le test seo-content.test.ts vérifie les deux premiers points.
 */
export const SEO_PATHS = [
  '/logiciel-paie-cote-divoire',
  '/gestion-conges-cote-divoire',
  '/paiement-salaires-mobile-money',
  '/sirh-afrique-ouest',
  '/logiciel-paie-senegal',
  '/logiciel-paie-burkina-faso',
  '/logiciel-paie-benin',
  '/guides/calcul-its-2024-cote-divoire',
  '/guides/cotisations-cnps-2024',
  '/en/hris-payroll-west-africa',
] as const

export type SeoPath = (typeof SEO_PATHS)[number]
