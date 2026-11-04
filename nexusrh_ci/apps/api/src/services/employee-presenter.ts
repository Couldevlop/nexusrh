/**
 * Présentation d'une ligne employé dans une réponse API : UN SEUL ordre, pour
 * que la liste, le détail, POST et PATCH ne divergent jamais.
 *   1. champs personnalisés sensibles retirés (si `redactCustom`), AVANT toute
 *      copie faite par le masquage ;
 *   2. NNI / IBAN chiffrés jamais servis bruts : retirés (`secrets: 'drop'`) ou
 *      laissés tels quels quand l'appelant les a déjà déchiffrés (`'keep'`) ;
 *   3. masquage des données sensibles (habilitations).
 * Si le masque s'applique, les chiffrés sont laissés à maskSensitive, qui les
 * met à null et le signale dans `maskedFields`.
 */
import { redactCustomFields, type CustomFieldDefinition } from './employee-custom-fields.service.js'
import { isMasked, maskSensitive, type Masked } from './sensitive-mask.js'
import type { HabContext } from './habilitation.service.js'

export interface PresentOptions {
  ctx: HabContext | null
  /** Définitions des champs personnalisés du tenant (requises si redactCustom). */
  defs: CustomFieldDefinition[]
  /** Retirer les champs personnalisés `sensitive` de la ligne. */
  redactCustom: boolean
  /** 'drop' : NNI/IBAN retirés ; 'keep' : l'appelant les a déjà traités (déchiffrés ou retirés). */
  secrets: 'drop' | 'keep'
}

export function presentEmployeeRow<T extends Record<string, unknown>>(row: T, opts: PresentOptions): Masked<T> {
  const out: Record<string, unknown> = { ...row }
  if (opts.redactCustom) out.custom_fields = redactCustomFields(opts.defs, out.custom_fields)
  if (opts.secrets === 'drop' && !isMasked(opts.ctx)) {
    delete out.nni
    delete out.iban
  }
  return maskSensitive(out, opts.ctx) as Masked<T>
}
