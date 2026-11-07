/**
 * Migration de données — renommage « NexusRH CI » -> « NexusRH » et nouveau
 * numéro de support, sur la table singleton platform.platform_settings.
 *
 * Ciblée et idempotente : elle ne touche QUE les valeurs encore égales à
 * l'ancienne valeur par défaut ; une valeur personnalisée par un super_admin
 * n'est jamais écrasée. Une fois appliquée, plus aucune ligne ne correspond.
 * L'ancien numéro est reconnu sous toutes ses graphies (espaces, points,
 * indicatif +225 / 00225 / sans indicatif) en comparant les chiffres seuls.
 */
export const OLD_APP_NAME = 'NexusRH CI'
export const NEW_APP_NAME = 'NexusRH'
export const NEW_SUPPORT_PHONE = '+225 07 49 43 92 03'

export function platformRenameStatements(): string[] {
  return [
    `UPDATE platform.platform_settings
        SET app_name = '${NEW_APP_NAME}', updated_at = now()
      WHERE app_name = '${OLD_APP_NAME}'`,
    `UPDATE platform.platform_settings
        SET support_phone = '${NEW_SUPPORT_PHONE}', updated_at = now()
      WHERE regexp_replace(support_phone, '[^0-9]', '', 'g')
            IN ('0709320594', '2250709320594', '002250709320594')`,
  ]
}
