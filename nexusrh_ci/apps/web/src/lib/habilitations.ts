/**
 * Catalogue de la grille d'habilitations RH — miroir côté écran.
 *
 * La source de vérité est `apps/api/src/modules/habilitations/catalog.ts` :
 * l'API refuse toute case absente de SON catalogue. Ce fichier existe pour que
 * l'écran ne propose jamais une case que le serveur refuserait, et un test
 * golden côté API (`habilitations.ui-contract.golden.test.ts`) vérifie que les
 * deux listes restent identiques — une divergence casse la CI, pas la prod.
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

/** Cases réellement proposées par fonction (identique au catalogue serveur). */
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

/** Statuts d'une fiche, dans l'ordre du circuit. */
export const FICHE_STATUSES = ['draft', 'n1', 'n2', 'locked', 'applied', 'rejected', 'superseded'] as const
export type FicheStatus = (typeof FICHE_STATUSES)[number]

/** Une fiche verrouillée (ou au-delà) ne se modifie plus. */
export function isFicheEditable(status: string): boolean {
  return status === 'draft' || status === 'rejected' || status === 'n1' || status === 'n2'
}

/**
 * L'utilisateur a-t-il au moins une case de cette fonction ?
 * `permissions === null` = aucune affectation : l'accès reste celui du rôle,
 * donc rien n'est masqué (comportement historique).
 */
export function hasHabFunction(permissions: string[] | null, fn: HabFunction): boolean {
  if (permissions === null) return true
  return permissions.some((p) => p.startsWith(`${fn}:`))
}

/** Vrai si l'utilisateur porte la case transverse demandée. */
export function hasHabExtra(permissions: string[] | null, extra: HabExtra): boolean {
  if (permissions === null) return false
  return permissions.includes(extra)
}
