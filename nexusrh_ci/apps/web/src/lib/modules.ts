import type { TenantConfig } from '@/stores/authStore'

/**
 * Modules activables par tenant — miroir frontend de
 * apps/api/src/services/tenant-modules.service.ts (source de vérité : API).
 * Le frontend ne fait que MASQUER la navigation ; le blocage réel est le hook
 * API global (403 moduleDisabled).
 */
export const MODULE_KEYS = [
  'contracts',
  'payroll',
  'absences',
  'expenses',
  'recruitment',
  'onboarding',
  'training',
  'careers',
  'cnps',
  'mobile_money',
  'reporting',
  'integrations',
  'ai',
  'org_chart',
  'discipline',
  'offboarding',
  'climate',
  'succession',
  'dg_view',
] as const

export type ModuleKey = (typeof MODULE_KEYS)[number]

// Tout actif par défaut SAUF la vue DG 360° (opt-in, activée par le super_admin).
export const MODULE_DEFAULTS: Record<ModuleKey, boolean> = {
  contracts:    true,
  payroll:      true,
  absences:     true,
  expenses:     true,
  recruitment:  true,
  onboarding:   true,
  training:     true,
  careers:      true,
  cnps:         true,
  mobile_money: true,
  reporting:    true,
  integrations: true,
  ai:           true,
  org_chart:    true,
  discipline:   true,
  offboarding:  true,
  climate:      true,
  succession:   true,
  dg_view:      false,
}

/** Module activé pour le tenant courant ? (défauts si config absente) */
export function isModuleEnabled(
  tenantConfig: Pick<TenantConfig, 'enabledModules'> | null | undefined,
  key: ModuleKey,
): boolean {
  const v = tenantConfig?.enabledModules?.[key]
  return typeof v === 'boolean' ? v : MODULE_DEFAULTS[key]
}
