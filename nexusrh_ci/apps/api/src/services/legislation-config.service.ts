/**
 * Construction de la vue « paramétrage légal » d'un tenant à partir de son pays.
 *
 * Responsabilité unique et PURE (aucune I/O) : à partir d'un code pays ISO-3,
 * retourner le pack législatif applicable (SMIG, barème impôt, cotisations
 * sociales, conventions/congés) PLUS la liste des pays sélectionnables. C'est ce
 * que consomme l'onglet « Paramètres → Légal » : choisir un pays installe
 * automatiquement toute la configuration de paie/RH correspondante.
 *
 * Le moteur de paie continue de refuser un pack `status='stub'` au calcul
 * (sécurité — valeurs non validées par un expert local) : la vue expose donc
 * `usable` pour que l'UI prévienne clairement avant activation réelle.
 */
import {
  type LegislationPack,
  getPackByCountry,
  isSupportedCountry,
  listCountries,
  DEFAULT_LEGISLATION_PACK,
  COUNTRY_LABELS,
} from './legislation-packs.js'

export interface LegislationConfigView {
  /** Pays effectivement résolu (repli CIV si pays inconnu) */
  countryCode: string
  countryLabel: string
  /** Le pays demandé est-il pris en charge ? (false → repli CIV) */
  supported: boolean
  /** Le pack est-il utilisable pour un calcul de paie réel ? (status active) */
  usable: boolean
  /** Pack complet appliqué (toutes les valeurs de paramétrage) */
  pack: LegislationPack
  /** Pays sélectionnables (résumé pour le menu déroulant) */
  available: ReturnType<typeof listCountries>
}

/**
 * Construit la vue de configuration légale pour un code pays.
 * Pays inconnu / absent → repli sur le pack par défaut (Côte d'Ivoire).
 */
export function buildLegislationConfig(countryCode: string | null | undefined): LegislationConfigView {
  const supported = isSupportedCountry(countryCode)
  const pack = getPackByCountry(countryCode) ?? DEFAULT_LEGISLATION_PACK
  return {
    countryCode: pack.countryCode,
    countryLabel: COUNTRY_LABELS[pack.countryCode] ?? pack.name,
    supported,
    usable: pack.status === 'active',
    pack,
    available: listCountries(),
  }
}
