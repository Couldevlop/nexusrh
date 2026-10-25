/**
 * Modes de paiement du salaire — normalisation et libellés lisibles.
 *
 * La base contient des codes hétérogènes : la fiche employé stocke la forme
 * canonique du formulaire (wave | mtn | orange | cofina), mais d'anciennes
 * données (seed, import, self-service) portent mtn_momo / orange_money, et les
 * bulletins stockent soit le mode (mobile_money | bank_transfer) soit
 * l'opérateur. Toute l'UI passe par ces deux fonctions.
 */
import i18n from '@/i18n'

export type MmProvider = 'wave' | 'mtn' | 'orange' | 'cofina'

/** Forme canonique d'un opérateur (accepte les formes historiques), '' si inconnue. */
export function canonicalMmProvider(raw: string | null | undefined): MmProvider | '' {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'wave': return 'wave'
    case 'mtn': case 'mtn_momo': case 'momo': return 'mtn'
    case 'orange': case 'orange_money': case 'om': return 'orange'
    case 'cofina': return 'cofina'
    default: return ''
  }
}

const METHOD_ALIASES: Record<string, string> = {
  virement: 'bank_transfer', bank: 'bank_transfer', especes: 'cash', espèces: 'cash',
}

/** Libellé traduit d'un mode de paiement ou d'un opérateur (code brut en repli). */
export function paymentMethodLabel(raw: string | null | undefined): string {
  if (!raw) return ''
  const v = raw.trim().toLowerCase()
  const key = canonicalMmProvider(v) || METHOD_ALIASES[v] || v
  return i18n.t(`common:paymentMethods.${key}`, { defaultValue: raw })
}
