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
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i

/** Code pg « table/colonne absente » : 42P01 relation, 42703 colonne. */
const pgCode = (err: unknown): string | undefined => (err as { code?: string }).code

/**
 * Interrupteur d'activation du tenant. Absence de la ligne tenant ou
 * COALESCE false => accès hérité : choix délibéré (déploiement progressif,
 * désactivé par défaut). Seule l'absence de la colonne de plateforme
 * `habilitations_enforced` (plateforme pas migrée) vaut « coupé ».
 */
async function isEnforced(schema: string): Promise<boolean> {
  try {
    const res = await pool.query<{ enforced: boolean | null }>(
      `SELECT habilitations_enforced AS enforced FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
      [schema],
    )
    return res.rows[0]?.enforced === true
  } catch (err) {
    if (pgCode(err) === '42P01' || pgCode(err) === '42703') return false
    throw err
  }
}

/**
 * Ids des filiales « siège social ». Colonne tenant pas encore migrée (42703)
 * => liste vide, plus restrictive (siège = employés sans filiale seulement).
 */
async function loadHeadOfficeIds(schema: string): Promise<string[]> {
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM "${schema}".legal_entities WHERE is_head_office = true ORDER BY id`,
    )
    return res.rows.map((x) => x.id)
  } catch (err) {
    if (pgCode(err) === '42703') return []
    throw err
  }
}

/**
 * Charge le contexte d'habilitation d'un utilisateur. `null` = contrôle par
 * la grille non actif pour le tenant, ou aucune affectation (accès hérité par
 * rôle). Une fois l'interrupteur actif, aucune erreur de schéma ne donne null
 * (hors tables d'habilitation absentes, donc sans affectation possible) :
 * les autres erreurs sont relancées (authorize les traduit en 403).
 */
export async function loadHabContext(schema: string, userId: string): Promise<HabContext | null> {
  assertValidSchemaName(schema)
  if (!(await isEnforced(schema))) return null
  let rows: HabRow[]
  try {
    // LEFT JOIN pour distinguer « aucune ligne » (null, accès hérité) de
    // « ligne inactive » (révoquée, future, sous-groupe absent -> refus).
    const res = await pool.query<HabRow>(
      `SELECT a.user_id, a.subgroup_id, sg.kind, sg.legal_entity_id,
              ARRAY(SELECT unnest(a.permissions) INTERSECT SELECT unnest(COALESCE(sg.ceiling, '{}'::text[]))) AS permissions,
              u.employee_id AS self_employee_id,
              (a.revoked_at IS NULL
               AND (a.effective_from IS NULL OR a.effective_from <= current_date)
               AND sg.id IS NOT NULL) AS active
         FROM "${schema}".hab_assignments a
         LEFT JOIN "${schema}".hab_subgroups sg ON sg.id = a.subgroup_id
         LEFT JOIN "${schema}".users u ON u.id = a.user_id
        WHERE a.user_id = $1
        LIMIT 1`,
      [userId],
    )
    rows = res.rows
  } catch (err) {
    // Tables d'habilitation pas encore créées : aucune affectation possible.
    if (pgCode(err) === '42P01') return null
    throw err
  }
  const r = rows[0]
  if (!r) return null
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
    headOfficeEntityIds: r.kind === 'siege' ? await loadHeadOfficeIds(schema) : [],
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

/** Identifiant UUID (toute version) : permet de répondre 400 plutôt que 500 sur un id mal formé. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
