// N° de sécurité sociale : format CNPS ivoirien strict pour un numéro préfixé
// CI ; pour une filiale hors CI (CNSS Bénin/Burkina, IPRES…), le numéro est
// préfixé du code pays ISO à 2 lettres (BJ-…, BF-…) puis 4 à 20 caractères.
export const CNPS_CI_RE = /^CI\d{8}[A-Z]$/
export const SOCIAL_ID_FOREIGN_RE = /^(?!CI)[A-Z]{2}-?[A-Z0-9-]{4,20}$/

export const isValidSocialId = (v: string): boolean => CNPS_CI_RE.test(v) || SOCIAL_ID_FOREIGN_RE.test(v)
