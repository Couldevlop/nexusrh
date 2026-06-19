/**
 * Modules activables / désactivables par tenant (pilotés par le super_admin).
 *
 * Représentation : platform.tenants.enabled_modules (jsonb) ne stocke QUE les
 * surcharges — ex. { "recruitment": false, "dg_view": true }. Un module absent
 * de la colonne prend sa valeur par défaut (tous actifs, sauf la vue DG 360°
 * qui est opt-in). Backward compatible : les tenants existants ('{}') gardent
 * exactement le comportement actuel.
 *
 * Enforcement : hook preHandler global (app.ts) qui mappe le préfixe d'URL vers
 * une clé de module et renvoie 403 { moduleDisabled: true } si désactivé.
 * Le frontend masque en plus les entrées de sidebar (defense in depth, mais la
 * vérité est côté API — OWASP A01).
 */
import type { Pool } from 'pg'
import { z } from 'zod'

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
  'competencies',
  'calibration',
  'mobility',
  'classification',
  'signature',
  'security',
  'sage',
  'dg_view',
] as const

export type ModuleKey = (typeof MODULE_KEYS)[number]

// Tous les modules sont actifs par défaut, SAUF la vue DG 360° (opt-in par
// tenant, activable uniquement par le super_admin — exigence produit).
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
  competencies: true,
  calibration:  true,
  mobility:     true,
  classification: true,
  signature:    true,
  security:     true,
  sage:         true,
  dg_view:      false,
}

/**
 * OWASP A03 — carte { module: boolean } dont les clés sont STRICTEMENT bornées à
 * la liste canonique MODULE_KEYS (aucune clé arbitraire ne peut entrer dans le
 * jsonb). Forme unique réutilisée par PUT /tenants/:id/modules, le bulk cabinet
 * ET la sélection de modules à la création du tenant (POST /tenants).
 */
export const modulesMapSchema = z.record(z.string(), z.boolean())
  .refine(m => Object.keys(m).length > 0, 'Au moins un module requis')
  .refine(
    m => Object.keys(m).every(k => (MODULE_KEYS as readonly string[]).includes(k)),
    'Clé de module inconnue',
  )

export type ModulesMap = z.infer<typeof modulesMapSchema>

/** Préfixe d'URL API → clé de module. Premier préfixe correspondant gagne. */
const URL_PREFIX_TO_MODULE: Array<[string, ModuleKey]> = [
  ['/contracts',        'contracts'],
  ['/payroll-workflow', 'payroll'],
  ['/payroll',          'payroll'],
  ['/raf',              'payroll'],
  ['/absences',         'absences'],
  ['/expenses',         'expenses'],
  ['/recruitment',      'recruitment'],
  ['/onboarding',       'onboarding'],
  ['/training',         'training'],
  ['/careers',          'careers'],
  ['/cnps',             'cnps'],
  ['/mobile-money',     'mobile_money'],
  ['/reporting',        'reporting'],
  ['/integrations',     'integrations'],
  ['/ai',               'ai'],
  ['/org-chart',        'org_chart'],
  ['/discipline',       'discipline'],
  ['/offboarding',      'offboarding'],
  ['/climate',          'climate'],
  ['/succession',       'succession'],
  ['/competencies',     'competencies'],
  ['/calibration',      'calibration'],
  ['/mobility',         'mobility'],
  ['/classification',   'classification'],
  ['/signature',        'signature'],
  ['/security',         'security'],
  ['/sage',             'sage'],
  ['/dg',               'dg_view'],
]

export function moduleKeyForUrl(pathname: string): ModuleKey | null {
  for (const [prefix, key] of URL_PREFIX_TO_MODULE) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return key
  }
  return null
}

/** Surcharges jsonb (potentiellement partielles/inconnues) → carte complète. */
export function resolveEnabledModules(overrides: unknown): Record<ModuleKey, boolean> {
  const out = { ...MODULE_DEFAULTS }
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const key of MODULE_KEYS) {
      const v = (overrides as Record<string, unknown>)[key]
      if (typeof v === 'boolean') out[key] = v
    }
  }
  return out
}

// Cache 30s par schéma (même TTL que le statut hors-ligne) : évite une requête
// platform.tenants par requête API tout en propageant un toggle en ≤ 30s.
const modulesCache = new Map<string, { value: Record<ModuleKey, boolean>; expiresAt: number }>()
const MODULES_CACHE_TTL_MS = 30_000

export function invalidateModulesCache(): void {
  modulesCache.clear()
}

/**
 * Modules effectifs d'un tenant (par schema_name). Fail-open : en cas d'erreur
 * DB ou de colonne absente (base pré-migration), tout est considéré actif
 * (défauts) — un toggle commercial ne doit jamais rendre la plateforme indisponible.
 */
export async function getModulesForSchema(
  pool: Pool,
  schemaName: string,
): Promise<Record<ModuleKey, boolean>> {
  const cached = modulesCache.get(schemaName)
  if (cached && Date.now() < cached.expiresAt) return cached.value

  let value = { ...MODULE_DEFAULTS }
  try {
    const res = await pool.query<{ enabled_modules: unknown }>(
      `SELECT enabled_modules FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
      [schemaName],
    )
    if (res.rows[0]) value = resolveEnabledModules(res.rows[0].enabled_modules)
  } catch {
    // colonne absente / DB indisponible → défauts (fail-open)
  }
  modulesCache.set(schemaName, { value, expiresAt: Date.now() + MODULES_CACHE_TTL_MS })
  return value
}
