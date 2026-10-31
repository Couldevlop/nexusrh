/**
 * Habilitations RH — moteur des droits effectifs et du périmètre SQL.
 *
 * Droits effectifs = fiche appliquée (hab_assignments.permissions) ∩ plafond du
 * sous-groupe (hab_subgroups.ceiling), calculés en SQL à chaque appel (aucun
 * cache : un plafond retiré s'applique immédiatement). Les extras
 * (all_entities, sensitive_data, manage_habilitations) sont soumis au plafond.
 */
import { pool } from '../db/pool.js'
import { assertValidSchemaName } from '../utils/schema-name.js'
import {
  SENSITIVE_IMPLIED,
  type HabAction,
  type HabFunction,
} from '../modules/habilitations/catalog.js'

export interface HabContext {
  userId: string
  subgroupId: string
  /** 'none' = contexte de refus (affectation inactive) : aucun droit, aucun périmètre. */
  kind: 'siege' | 'entity' | 'none'
  legalEntityId: string | null
  permissions: Set<string>
  allEntities: boolean
  sensitive: boolean
  manageHabilitations: boolean
  selfEmployeeId: string | null
  /**
   * Ids des filiales cochées « siège social » (is_head_office). Utile pour le
   * sous-groupe siège uniquement ; vide pour une filiale ou un refus.
   */
  headOfficeEntityIds: string[]
}

interface HabRow {
  user_id: string
  subgroup_id: string
  kind: 'siege' | 'entity' | null
  legal_entity_id: string | null
  permissions: string[] | null
  active: boolean
  self_employee_id: string | null
  /** Interrupteur du tenant (platform.tenants.habilitations_enforced). */
  enforced: boolean
  head_office_ids: string[] | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i

/**
 * Charge le contexte d'habilitation d'un utilisateur. `null` = aucune
 * affectation active (accès hérité par rôle) ou tables pas encore créées.
 */
export async function loadHabContext(schema: string, userId: string): Promise<HabContext | null> {
  assertValidSchemaName(schema)
  let rows: HabRow[]
  try {
    // Une seule requête : LEFT JOIN pour distinguer « aucune ligne » (null,
    // accès hérité) de « ligne inactive » (révoquée, future, sous-groupe absent
    // -> refus).
    const res = await pool.query<HabRow>(
      `SELECT a.user_id, a.subgroup_id, sg.kind, sg.legal_entity_id,
              ARRAY(SELECT unnest(a.permissions) INTERSECT SELECT unnest(COALESCE(sg.ceiling, '{}'::text[]))) AS permissions,
              u.employee_id AS self_employee_id,
              COALESCE((SELECT t.habilitations_enforced FROM platform.tenants t
                         WHERE t.schema_name = $2 LIMIT 1), false) AS enforced,
              ARRAY(SELECT le.id::text FROM "${schema}".legal_entities le
                     WHERE le.is_head_office = true ORDER BY le.id) AS head_office_ids,
              (a.revoked_at IS NULL
               AND (a.effective_from IS NULL OR a.effective_from <= current_date)
               AND sg.id IS NOT NULL) AS active
         FROM "${schema}".hab_assignments a
         LEFT JOIN "${schema}".hab_subgroups sg ON sg.id = a.subgroup_id
         LEFT JOIN "${schema}".users u ON u.id = a.user_id
        WHERE a.user_id = $1
        LIMIT 1`,
      [userId, schema],
    )
    rows = res.rows
  } catch (err) {
    // Tenant (ou colonne d'activation / siège social) pas encore migré : pas
    // d'habilitation, accès hérité (42P01 table absente, 42703 colonne absente).
    const code = (err as { code?: string }).code
    if (code === '42P01' || code === '42703') return null
    throw err
  }
  const r = rows[0]
  if (!r) return null
  // Activation progressive : tant que l'interrupteur du tenant est coupé, les
  // affectations sont préparées mais le contrôle reste celui des rôles.
  if (!r.enforced) return null
  // Fermé par défaut : une affectation existe mais n'est pas applicable.
  if (!r.active || !r.kind) {
    return {
      userId: r.user_id,
      subgroupId: r.subgroup_id ?? '',
      kind: 'none',
      legalEntityId: null,
      permissions: new Set<string>(),
      allEntities: false,
      sensitive: false,
      manageHabilitations: false,
      selfEmployeeId: r.self_employee_id,
      headOfficeEntityIds: [],
    }
  }

  const permissions = new Set<string>(r.permissions ?? [])
  const sensitive =
    permissions.has('sensitive_data') ||
    SENSITIVE_IMPLIED.some((fn) => [...permissions].some((p) => p.startsWith(`${fn}:`)))
  return {
    userId: r.user_id,
    subgroupId: r.subgroup_id,
    kind: r.kind,
    legalEntityId: r.legal_entity_id,
    permissions,
    // Un sous-groupe d'entité ne peut jamais être élargi (spec 5.4).
    allEntities: r.kind === 'siege' && permissions.has('all_entities'),
    sensitive,
    manageHabilitations: permissions.has('manage_habilitations'),
    selfEmployeeId: r.self_employee_id,
    headOfficeEntityIds: r.kind === 'siege' ? (r.head_office_ids ?? []) : [],
  }
}

export function can(ctx: HabContext, fn: HabFunction, action: HabAction): boolean {
  return ctx.permissions.has(`${fn}:${action}`)
}

/**
 * Fragment SQL booléen restreignant la ligne employé `alias` au périmètre de
 * l'utilisateur. `null` = accès hérité (TRUE).
 */
export function hrScopeSql(schema: string, alias: string, ctx: HabContext | null): string {
  assertValidSchemaName(schema)
  if (!ALIAS_RE.test(alias)) throw new Error(`Alias SQL invalide : ${alias}`)
  if (ctx === null) return 'TRUE'
  if (ctx.kind === 'none') return 'FALSE'
  if (ctx.kind === 'entity') {
    if (!ctx.legalEntityId || !UUID_RE.test(ctx.legalEntityId)) {
      throw new Error("Entité légale invalide pour le périmètre d'habilitation")
    }
    return `${alias}.legal_entity_id = '${ctx.legalEntityId}'`
  }
  if (ctx.allEntities) return 'TRUE'
  // Siège : employés sans filiale + ceux des filiales cochées « siège social ».
  const ids = ctx.headOfficeEntityIds
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error("Entité siège invalide pour le périmètre d'habilitation")
  }
  if (ids.length === 0) return `${alias}.legal_entity_id IS NULL`
  const list = ids.map((id) => `'${id}'`).join(',')
  return `(${alias}.legal_entity_id IS NULL OR ${alias}.legal_entity_id IN (${list}))`
}

/** Message renvoyé (403) quand une action RH vise le dossier de l'acteur. */
export const SELF_ACTION_ERROR = 'Action interdite sur votre propre dossier'

export class SelfActionError extends Error {
  constructor() {
    super(SELF_ACTION_ERROR)
    this.name = 'SelfActionError'
  }
}

/**
 * Garde « son propre dossier » : un habilité ne peut pas agir (salaire,
 * approbation, sanction, variables de paie) sur sa propre fiche employé.
 * `ctx = null` (utilisateur hérité sans affectation) : comportement inchangé.
 */
export function assertNotSelf(ctx: HabContext | null, targetEmployeeId: string): void {
  // PostgreSQL accepte un UUID en majuscules et cible la même ligne : on
  // compare donc les deux côtés normalisés (trim + minuscules).
  const norm = (v: string): string => v.trim().toLowerCase()
  if (ctx && ctx.selfEmployeeId !== null && norm(ctx.selfEmployeeId) === norm(targetEmployeeId)) {
    throw new SelfActionError()
  }
}

/**
 * Variante handler : vrai si l'action doit être refusée (le handler répond
 * alors 403 SELF_ACTION_ERROR). Ignorée pour le rôle effectif `employee`
 * (self-service : l'utilisateur agit légitimement sur son propre profil).
 */
export function isSelfAction(
  request: { hab?: HabContext | null; user: { role: string } },
  targetEmployeeId: string,
): boolean {
  if (request.user.role === 'employee') return false
  try {
    assertNotSelf(request.hab ?? null, targetEmployeeId)
    return false
  } catch (err) {
    if (err instanceof SelfActionError) return true
    throw err
  }
}
