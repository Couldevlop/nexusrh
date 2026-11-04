/**
 * Habilitations RH — structure par défaut et reprise d'office des tenants existants.
 *
 *  - `ensureHabilitationStructure` : groupe « DRH Groupe », sous-groupe « RH Siège »
 *    et un sous-groupe « RH Filiale <nom> » par filiale active non siège. Idempotent,
 *    rejoué à CHAQUE ensureTenantSchema (les filiales créées par script, hors route,
 *    obtiennent ainsi leur sous-groupe).
 *  - `bootstrapExistingUsers` : affecte les utilisateurs RH actifs sans affectation
 *    avec les droits que leur rôle leur donne AUJOURD'HUI, route par route : le jour
 *    de l'activation, rien ne change (invariant : takeover-fidelity.test.ts).
 *  - `runHabilitationBootstrap` : orchestration appelée par la migration lazy
 *    (ensureTenantSchema) — reprise une seule fois par tenant, grâce au marqueur
 *    `platform.tenants.hab_bootstrapped_at` posé dans la MÊME transaction.
 *
 * Jamais exécuté par le seed (aucun corps de seed en prod) : la reprise passe
 * uniquement par la migration.
 */
import type { QueryResultRow } from 'pg'
import { pool } from './pool.js'
import { assertValidSchemaName } from '../utils/schema-name.js'
import { auditTenant, auditTenantInTx } from '../utils/audit-log.js'
import { HAB_GRID, isPermission, type HabAction, type HabFunction } from '../modules/habilitations/catalog.js'

export const HAB_GROUP_NAME = 'DRH Groupe'
export const HAB_SIEGE_NAME = 'RH Siège'
export const HAB_FILIALE_PREFIX = 'RH Filiale '

/** Sous-ensemble de pg.Pool / pg.PoolClient dont ce module a besoin. */
export interface HabDb {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>
}

export type BootstrapRole = 'hr_manager' | 'hr_officer' | 'raf_site'

const A = (fn: HabFunction, actions: readonly HabAction[]): string[] => actions.map((a) => `${fn}:${a}`)
const ALL = (fn: HabFunction): string[] => A(fn, HAB_GRID[fn])

/**
 * Droits par défaut d'un rôle RH = l'accès EFFECTIF d'aujourd'hui, route par route
 * (authorize() historique), exprimé en cases de la grille. Les routes qui
 * partageaient une case avec un rôle moins large ont été rangées dans une case
 * dédiée (route-permissions.ts, « Routes réservées au DRH ») : la reprise ne
 * crée AUCUN gain d'accès. Chaque clé existe dans le catalogue (test + garde).
 * `sensitive_data` / `all_entities` sont ajoutés par `takeoverPermissions`.
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<BootstrapRole, string[]> = {
  // DRH : toutes les cases (paramétrage RH et de la paie compris).
  hr_manager: [
    ...ALL('employees'), ...ALL('contracts'), ...ALL('absences'), ...ALL('attendance'),
    ...ALL('payroll'), ...ALL('payroll_multi'), ...ALL('declarations'), ...ALL('payments'),
    ...ALL('expenses'), ...ALL('recruitment'), ...ALL('lifecycle'), ...ALL('discipline'),
    ...ALL('training'), ...ALL('talent'), ...ALL('climate'), ...ALL('signature'),
    ...ALL('reporting'), ...ALL('hr_settings'),
  ],
  // Gestionnaire RH : exactement les routes qu'il ouvre aujourd'hui (il approuve /
  // rejette absences, notes de frais, paie et paie multi-filiales ; il clôture la
  // paie multi-filiales ; il supprime talents et inscriptions de formation).
  hr_officer: [
    ...A('absences', ['view', 'validate']),
    ...A('attendance', ['view', 'create', 'update']),
    ...A('climate', ['view', 'create', 'update']),
    ...A('contracts', ['view', 'create', 'update', 'export']),
    ...A('declarations', ['view', 'export']),
    ...A('discipline', ['view', 'create', 'update']),
    ...A('employees', ['view', 'create', 'update', 'export']),
    ...A('expenses', ['view', 'create', 'update', 'validate']),
    ...A('hr_settings', ['view']),
    ...A('lifecycle', ['view', 'create', 'update']),
    ...A('payroll', ['view', 'create', 'validate', 'export']),
    ...A('payroll_multi', ['view', 'validate', 'close']),
    ...A('recruitment', ['view', 'create', 'update']),
    ...A('reporting', ['view', 'export']),
    ...A('signature', ['view', 'create', 'update']),
    ...A('talent', ['view', 'create', 'update', 'delete']),
    ...A('training', ['view', 'create', 'delete']),
  ],
  // RAF de site : variables, état de préparation et soumission de SA paie. Ni
  // clôture, ni validation centrale, ni approbation (séparation des tâches : un
  // RAF ne valide jamais sa propre soumission).
  raf_site: ['payroll_multi:view', 'payroll_multi:update'],
}

/** Rôles pour lesquels la reprise ajoute `sensitive_data`. */
const SENSITIVE_ROLES: readonly BootstrapRole[] = ['hr_manager', 'raf_site']
/**
 * Rôles qui voient tout le tenant aujourd'hui => `all_entities`. Le gestionnaire
 * RH n'a pas `sensitive_data` explicite : il l'obtient de toute façon par les
 * cases payroll/declarations (SENSITIVE_IMPLIED), ce qui reproduit l'existant.
 */
const ALL_ENTITIES_ROLES: readonly BootstrapRole[] = ['hr_manager', 'hr_officer']

/** Droits écrits à la reprise pour un rôle (cases + extras). */
export function takeoverPermissions(role: BootstrapRole): string[] {
  const perms = [...ROLE_DEFAULT_PERMISSIONS[role]]
  if (SENSITIVE_ROLES.includes(role)) perms.push('sensitive_data')
  if (ALL_ENTITIES_ROLES.includes(role)) perms.push('all_entities')
  return perms
}

/** Garde-fou : une clé absente du catalogue ne doit jamais être écrite. */
function assertCatalog(perms: readonly string[]): void {
  for (const p of perms) {
    if (!isPermission(p)) throw new Error(`Permission hors catalogue : ${p}`)
  }
}

/** Identifiant du groupe racine, créé au besoin. */
async function ensureGroup(db: HabDb, schema: string): Promise<string> {
  await db.query(`INSERT INTO "${schema}".hab_groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [HAB_GROUP_NAME])
  const res = await db.query<{ id: string }>(`SELECT id::text AS id FROM "${schema}".hab_groups WHERE name = $1`, [HAB_GROUP_NAME])
  const id = res.rows[0]?.id
  if (!id) throw new Error('Groupe DRH introuvable')
  return id
}

/** Identifiant du sous-groupe « RH Siège » (un seul : kind = 'siege'), créé au besoin. */
async function ensureSiegeSubgroup(db: HabDb, schema: string, groupId: string): Promise<string> {
  await db.query(
    `INSERT INTO "${schema}".hab_subgroups (group_id, name, kind)
     SELECT $1::uuid, $2, 'siege'
      WHERE NOT EXISTS (SELECT 1 FROM "${schema}".hab_subgroups WHERE kind = 'siege')
     ON CONFLICT DO NOTHING`,
    [groupId, HAB_SIEGE_NAME],
  )
  const res = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM "${schema}".hab_subgroups WHERE kind = 'siege' ORDER BY created_at LIMIT 1`,
  )
  const id = res.rows[0]?.id
  if (!id) throw new Error('Sous-groupe RH Siège introuvable')
  return id
}

/**
 * Crée la structure par défaut : DRH Groupe, RH Siège, et un « RH Filiale <nom> »
 * par filiale active qui n'est pas le siège social (le siège est couvert par
 * « RH Siège »). Idempotent : unicité de `legal_entity_id`, du nom de groupe et
 * (index partiel) du sous-groupe siège. `db` permet de l'exécuter dans une
 * transaction existante.
 */
export async function ensureHabilitationStructure(schema: string, db: HabDb = pool): Promise<void> {
  assertValidSchemaName(schema)
  const groupId = await ensureGroup(db, schema)
  await ensureSiegeSubgroup(db, schema, groupId)
  await db.query(
    `INSERT INTO "${schema}".hab_subgroups (group_id, name, kind, legal_entity_id)
     SELECT $1::uuid, left($2 || le.name, 150), 'entity', le.id
       FROM "${schema}".legal_entities le
      WHERE le.is_active = true AND le.is_head_office = false
     ON CONFLICT (legal_entity_id) DO NOTHING`,
    [groupId, HAB_FILIALE_PREFIX],
  )
}

interface CandidateRow extends QueryResultRow {
  id: string
  role: BootstrapRole
  entity_id: string | null
  raf_entities: number
}

/**
 * Reprise : affecte les utilisateurs RH actifs sans affectation avec les droits
 * que leur rôle leur donne aujourd'hui. Renvoie le nombre de personnes affectées.
 *
 *  - hr_manager / hr_officer : TOUJOURS « RH Siège » avec `all_entities` (le seul
 *    sous-groupe où ce droit s'exerce, spec §5.4) : ils voient tout le tenant
 *    aujourd'hui, la reprise ne les cantonne donc pas. Les restreindre à une
 *    filiale est une décision explicite de l'admin après l'activation.
 *  - raf_site : sous-groupe de SA filiale (entité dont il est RAF, ou période de
 *    paie dont il est RAF, ou fiche employé) ; filiale siège ou inconnue => RH Siège.
 *    Une seule affectation par utilisateur (index unique) : un RAF de plusieurs
 *    filiales est rattaché à la première et journalisé (`multiEntityRaf`).
 *
 * L'audit `habilitation.bootstrap` est écrit sur la même connexion (donc annulé
 * avec la transaction) et ne contient que des nombres et des identifiants.
 */
export async function bootstrapExistingUsers(schema: string, db: HabDb = pool): Promise<number> {
  assertValidSchemaName(schema)
  const groupId = await ensureGroup(db, schema)
  const siegeId = await ensureSiegeSubgroup(db, schema, groupId)
  const headRes = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM "${schema}".legal_entities WHERE is_head_office = true`,
  )
  const headIds = new Set(headRes.rows.map((r) => r.id))

  const cand = await db.query<CandidateRow>(
    `SELECT u.id::text AS id, u.role,
            COALESCE(
              CASE WHEN u.role = 'raf_site' THEN COALESCE(
                (SELECT le.id FROM "${schema}".legal_entities le WHERE le.raf_user_id = u.id AND le.is_active = true ORDER BY le.id LIMIT 1),
                (SELECT pp.legal_entity_id FROM "${schema}".pay_periods pp WHERE pp.raf_user_id = u.id AND pp.legal_entity_id IS NOT NULL ORDER BY pp.legal_entity_id LIMIT 1)
              ) END,
              (SELECT e.legal_entity_id FROM "${schema}".employees e
                WHERE e.id = u.employee_id OR e.user_id = u.id
                ORDER BY (e.id = u.employee_id) DESC LIMIT 1)
            )::text AS entity_id,
            CASE WHEN u.role = 'raf_site' THEN (
              SELECT count(*)::int FROM (
                SELECT le.id FROM "${schema}".legal_entities le WHERE le.raf_user_id = u.id AND le.is_active = true
                UNION
                SELECT pp.legal_entity_id FROM "${schema}".pay_periods pp WHERE pp.raf_user_id = u.id AND pp.legal_entity_id IS NOT NULL
              ) x
            ) ELSE 0 END AS raf_entities
       FROM "${schema}".users u
      WHERE u.is_active = true
        AND u.role IN ('hr_manager', 'hr_officer', 'raf_site')
        AND NOT EXISTS (SELECT 1 FROM "${schema}".hab_assignments a WHERE a.user_id = u.id)
      ORDER BY u.id`,
  )

  const ceilings = new Map<string, Set<string>>()
  const assignedIds: string[] = []
  const skippedIds: string[] = []
  const multiRafIds: string[] = []
  for (const u of cand.rows) {
    let subgroupId = siegeId
    const wantsEntity = u.role === 'raf_site' && u.entity_id !== null && !headIds.has(u.entity_id)
    if (wantsEntity && u.entity_id) {
      // Sous-groupe de la filiale, créé au besoin (filiale inactive, créée hors route…).
      await db.query(
        `INSERT INTO "${schema}".hab_subgroups (group_id, name, kind, legal_entity_id)
         SELECT $1::uuid, left($3 || le.name, 150), 'entity', le.id
           FROM "${schema}".legal_entities le WHERE le.id = $2::uuid
         ON CONFLICT (legal_entity_id) DO NOTHING`,
        [groupId, u.entity_id, HAB_FILIALE_PREFIX],
      )
      const sg = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM "${schema}".hab_subgroups WHERE legal_entity_id = $1::uuid`,
        [u.entity_id],
      )
      const found = sg.rows[0]?.id
      if (!found) {
        // Filiale disparue : on n'élargit jamais vers le siège. L'utilisateur reste
        // en accès hérité ; il est compté, journalisé et listé dans l'audit.
        skippedIds.push(u.id)
        continue
      }
      subgroupId = found
      if (u.raf_entities > 1) multiRafIds.push(u.id)
    }
    const perms = takeoverPermissions(u.role)
    assertCatalog(perms)
    const ins = await db.query(
      `INSERT INTO "${schema}".hab_assignments (user_id, subgroup_id, permissions, source)
       VALUES ($1::uuid, $2::uuid, $3::text[], 'reprise')
       ON CONFLICT (user_id) DO NOTHING`,
      [u.id, subgroupId, perms],
    )
    if ((ins.rowCount ?? 0) > 0) {
      assignedIds.push(u.id)
      const set = ceilings.get(subgroupId) ?? new Set<string>()
      for (const p of perms) set.add(p)
      ceilings.set(subgroupId, set)
    }
  }

  // Plafond de chaque sous-groupe = union des droits de ses membres (et de l'existant).
  for (const [subgroupId, set] of ceilings) {
    await db.query(
      `UPDATE "${schema}".hab_subgroups
          SET ceiling = ARRAY(SELECT DISTINCT unnest(ceiling || $2::text[]))
        WHERE id = $1::uuid`,
      [subgroupId, [...set].sort()],
    )
  }

  if (skippedIds.length > 0) {
    console.warn(`[habilitations] reprise du tenant ${schema} : ${skippedIds.length} utilisateur(s) ignoré(s), filiale introuvable`)
  }
  if (multiRafIds.length > 0) {
    console.warn(`[habilitations] reprise du tenant ${schema} : ${multiRafIds.length} RAF de plusieurs filiales rattaché(s) à la première`)
  }
  if (assignedIds.length > 0 || skippedIds.length > 0) {
    // Audit : nombres et identifiants uniquement, aucune donnée personnelle.
    await auditTenantInTx(db, schema, {
      userId: null,
      action: 'habilitation.bootstrap',
      entity: 'habilitation',
      entityId: null,
      changes: {
        count: assignedIds.length,
        userIds: assignedIds,
        skipped: skippedIds,
        ...(multiRafIds.length > 0 ? { multiEntityRaf: multiRafIds } : {}),
      },
      ip: null,
    })
  }
  return assignedIds.length
}

/**
 * Orchestration de la migration lazy. Ne lève JAMAIS : une erreur est journalisée
 * et le marqueur n'est pas posé (nouvelle tentative au prochain démarrage).
 *  1. structure : à CHAQUE appel, transaction propre sous verrou consultatif ;
 *  2. marqueur `hab_bootstrapped_at` déjà posé => fin ;
 *  3. reprise + marqueur + audit dans UNE transaction (verrou, relecture du marqueur).
 * La colonne du marqueur est créée par ensurePlatformSchema / createPlatformSchema
 * (pas d'ALTER dans ce chemin : verrou exclusif sur la table la plus lue).
 */
export async function runHabilitationBootstrap(schema: string): Promise<void> {
  try {
    assertValidSchemaName(schema)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hab_bootstrap:${schema}`])
      await ensureHabilitationStructure(schema, client)
      await client.query('COMMIT')

      const mark = await client.query<{ done: boolean }>(
        `SELECT (hab_bootstrapped_at IS NOT NULL) AS done FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
        [schema],
      )
      if (mark.rows[0]?.done === true) return

      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hab_bootstrap:${schema}`])
      // Relecture sous verrou : une instance concurrente a pu terminer entre-temps.
      const again = await client.query<{ done: boolean }>(
        `SELECT (hab_bootstrapped_at IS NOT NULL) AS done FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
        [schema],
      )
      if (again.rows[0]?.done !== true) {
        await bootstrapExistingUsers(schema, client)
        await client.query(`UPDATE platform.tenants SET hab_bootstrapped_at = now() WHERE schema_name = $1`, [schema])
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error(`[habilitations] reprise du tenant ${schema} échouée :`, (err as Error).message)
  }
}

/**
 * Nouveau tenant : structure créée, reprise interdite (marqueur posé tout de suite).
 * Le premier DRH est habilité par l'admin (source = 'bootstrap').
 */
export async function provisionHabilitationStructure(schema: string, db: HabDb = pool): Promise<void> {
  assertValidSchemaName(schema)
  await ensureHabilitationStructure(schema, db)
  await db.query(`UPDATE platform.tenants SET hab_bootstrapped_at = now() WHERE schema_name = $1`, [schema])
}

/** Rôles dont l'accès passe par la grille d'habilitations. */
const GRID_ROLES: readonly string[] = ['hr_manager', 'hr_officer', 'raf_site']

/**
 * Changement de rôle : un utilisateur qui quitte hr_manager / hr_officer /
 * raf_site perd son affectation active (revoked_at) — sinon, une fois le tenant
 * activé, la grille continuerait à lui ouvrir des routes RH. Audit
 * `habilitation.revoked` (raison `role_changed`, identifiants seulement).
 * Non bloquant : tables d'habilitation absentes => rien à révoquer.
 */
export async function revokeHabilitationOnRoleChange(
  schema: string,
  userId: string,
  newRole: string,
  actorId: string | null,
  ip: string | null,
  db: HabDb = pool,
): Promise<boolean> {
  assertValidSchemaName(schema)
  if (GRID_ROLES.includes(newRole)) return false
  try {
    const res = await db.query<{ id: string }>(
      `UPDATE "${schema}".hab_assignments SET revoked_at = now()
        WHERE user_id = $1::uuid AND revoked_at IS NULL
        RETURNING id::text AS id`,
      [userId],
    )
    if (res.rows.length === 0) return false
    auditTenant(schema, {
      userId: actorId,
      action: 'habilitation.revoked',
      entity: 'habilitation',
      entityId: userId,
      changes: { reason: 'role_changed', newRole, assignmentIds: res.rows.map((r) => r.id) },
      ip,
    })
    return true
  } catch (err) {
    console.error(`[habilitations] révocation au changement de rôle échouée (${schema}) :`, (err as Error).message)
    return false
  }
}
