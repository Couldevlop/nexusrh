/**
 * Le salarié relève-t-il du pack de paie ivoirien (CIV) ? Même règle que
 * l'API (cnps.routes `isCivEntity`, rapport d'impact `isCivSlip`) :
 *  1. filiale avec pack explicite → pack « CIV-* » ;
 *  2. filiale sans pack → pays de la filiale (CIV par défaut) ;
 *  3. pas de filiale, ou filiale non visible pour ce rôle → pays du tenant
 *     (CIV par défaut).
 * Sert à n'afficher que pour la CIV les données propres à la paie ivoirienne
 * (CMU).
 */
export interface CivScopeEntity {
  id: string
  country_code?: string | null
  legislation_pack_code?: string | null
}

export function isCivPayrollScope(
  legalEntityId: string | null | undefined,
  entities: readonly CivScopeEntity[],
  tenantCountry: string | null | undefined,
): boolean {
  const le = legalEntityId ? entities.find(e => e.id === legalEntityId) : undefined
  if (le) {
    const pack = le.legislation_pack_code?.trim()
    if (pack) return pack.toUpperCase().startsWith('CIV-')
    return (le.country_code?.trim() || 'CIV').toUpperCase() === 'CIV'
  }
  return (tenantCountry?.trim() || 'CIV').toUpperCase() === 'CIV'
}
