/**
 * Catalogue de la grille d'habilitations RH : fonctions × actions + extras.
 * Une permission s'écrit `fonction:action` (ex. `payroll:validate`) ; les
 * extras (`sensitive_data`, …) sont des permissions transverses sans fonction.
 */
export const HAB_FUNCTIONS = [
  'employees', 'contracts', 'absences', 'attendance', 'payroll',
  'payroll_multi', 'declarations', 'payments', 'expenses',
  'recruitment', 'lifecycle', 'discipline', 'training', 'talent',
  'climate', 'signature', 'reporting', 'hr_settings',
] as const

export const HAB_ACTIONS = [
  'view', 'create', 'update', 'delete', 'validate',
  'close', 'export', 'pay', 'configure',
] as const

export const HAB_EXTRA = ['sensitive_data', 'all_entities', 'manage_habilitations'] as const

export type HabFunction = (typeof HAB_FUNCTIONS)[number]
export type HabAction = (typeof HAB_ACTIONS)[number]
export type HabExtra = (typeof HAB_EXTRA)[number]
export type Permission = `${HabFunction}:${HabAction}`

/** Cases proposées par fonction (`pay` : payments seul ; `configure` : hr_settings et payroll). */
export const HAB_GRID: Record<HabFunction, readonly HabAction[]> = {
  employees: ['view', 'create', 'update', 'delete', 'export'],
  contracts: ['view', 'create', 'update', 'delete', 'validate', 'export'],
  absences: ['view', 'create', 'update', 'delete', 'validate', 'export'],
  attendance: ['view', 'create', 'update', 'delete', 'validate', 'export'],
  payroll: ['view', 'create', 'update', 'validate', 'close', 'export', 'configure'],
  payroll_multi: ['view', 'create', 'update', 'validate', 'close', 'export'],
  declarations: ['view', 'create', 'update', 'validate', 'close', 'export'],
  payments: ['view', 'create', 'validate', 'pay', 'export'],
  expenses: ['view', 'create', 'update', 'delete', 'validate', 'export'],
  recruitment: ['view', 'create', 'update', 'delete', 'validate', 'export'],
  lifecycle: ['view', 'create', 'update', 'delete', 'validate', 'export'],
  discipline: ['view', 'create', 'update', 'delete', 'validate'],
  training: ['view', 'create', 'update', 'delete', 'validate', 'export'],
  talent: ['view', 'create', 'update', 'delete', 'validate', 'export'],
  climate: ['view', 'create', 'update', 'delete', 'export'],
  signature: ['view', 'create', 'update', 'delete', 'validate'],
  reporting: ['view', 'export'],
  hr_settings: ['view', 'update', 'configure'],
}

/** Fonctions dont l'accès implique l'extra `sensitive_data`. */
export const SENSITIVE_IMPLIED: HabFunction[] = ['payroll', 'declarations', 'payments']

/** Vrai pour une case valide de la grille (`fn:action`) ou un extra. */
export function isPermission(s: string): boolean {
  if ((HAB_EXTRA as readonly string[]).includes(s)) return true
  const i = s.indexOf(':')
  if (i < 0) return false
  const fn = s.slice(0, i)
  const action = s.slice(i + 1)
  if (!Object.prototype.hasOwnProperty.call(HAB_GRID, fn)) return false
  return (HAB_GRID[fn as HabFunction] as readonly string[]).includes(action)
}
