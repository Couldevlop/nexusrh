/**
 * Habilitations RH — structure par défaut et reprise d'office des tenants existants.
 *
 *  - `ensureHabilitationStructure` : groupe « DRH Groupe », sous-groupe « RH Siège »
 *    et un sous-groupe « RH Filiale <nom> » par filiale active non siège. Idempotent.
 *  - `bootstrapExistingUsers` : affecte les utilisateurs RH actifs sans affectation
 *    avec les droits que leur rôle leur donnait jusque-là (aucune régression le jour
 *    où le tenant est basculé en `habilitations_enforced`).
 *  - `runHabilitationBootstrap` : orchestration appelée par la migration lazy
 *    (ensureTenantSchema) — une seule fois par tenant, grâce au marqueur
 *    `platform.tenants.hab_bootstrapped_at` posé dans la MÊME transaction.
 *
 * Jamais exécuté par le seed (aucun corps de seed en prod) : la reprise passe
 * uniquement par la migration.
 */
import type { QueryResultRow } from 'pg'
import { pool } from './pool.js'
import { assertValidSchemaName } from '../utils/schema-name.js'
import { auditTenant } from '../utils/audit-log.js'
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

type BootstrapRole = 'hr_manager' | 'hr_officer' | 'raf_site'

const A = (fn: HabFunction, actions: readonly HabAction[]): string[] => actions.map((a) => `${fn}:${a}`)
const ALL = (fn: HabFunction): string[] => A(fn, HAB_GRID[fn])

/**
 * Droits par défaut d'un rôle RH, dérivés de la matrice RBAC de CLAUDE.md et des
 * rôles réellement autorisés sur les routes. Toutes les clés existent dans le
 * catalogue (vérifié par le test). `sensitive_data` / `all_entities` ne figurent
 * PAS ici : ils sont ajoutés par `bootstrapExistingUsers` selon rôle et rattachement.
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<BootstrapRole, string[]> = {
  // DRH : RW partout sauf paramétrage tenant et utilisateurs (admin seul).
  hr_manager: [
    ...ALL('employees'), ...ALL('contracts'), ...ALL('absences'), ...ALL('attendance'),
    ...A('payroll', ['view', 'create', 'update', 'validate', 'close', 'export']),
    ...ALL('payroll_multi'), ...ALL('declarations'), ...ALL('payments'), ...ALL('expenses'),
    ...ALL('recruitment'), ...ALL('lifecycle'), ...ALL('discipline'), ...ALL('training'),
    ...ALL('talent'), ...ALL('climate'), ...ALL('signature'), ...ALL('reporting'),
    ...A('hr_settings', ['view', 'update']),
  ],
  // Gestionnaire RH : saisie et consultation, ni clôture, ni suppression, ni paiement,
  // ni validation de paie.
  hr_officer: [
    ...A('employees', ['view', 'create', 'update', 'export']),
    ...A('contracts', ['view']),
    ...A('absences', ['view', 'create', 'update']),
    ...A('attendance', ['view', 'create', 'update']),
    ...A('payroll', ['view', 'export']),
    ...A('payroll_multi', ['view']),
    ...A('declarations', ['view', 'export']),
    ...A('expenses', ['view', 'create', 'update']),
    ...A('recruitment', ['view', 'create', 'update', 'export']),
    ...A('lifecycle', ['view', 'create', 'update', 'export']),
    ...A('discipline', ['view', 'create', 'update']),
    ...A('training', ['view', 'create', 'update', 'export']),
    ...A('talent', ['view', 'create', 'update', 'export']),
    ...A('climate', ['view', 'create', 'update', 'export']),
    ...A('signature', ['view', 'create', 'update']),
    ...A('reporting', ['view', 'export']),
    ...A('hr_settings', ['view']),
  ],
  // RAF de site : paie centralisée multi-filiales de sa filiale.
  raf_site: ['payroll_multi:view', 'payroll_multi:update', 'payroll_multi:close', 'payroll_multi:validate'],
}

/** Rôles pour lesquels la reprise ajoute `sensitive_data`. */
const SENSITIVE_ROLES: readonly BootstrapRole[] = ['hr_manager', 'raf_site']
/** Rôles du siège qui voyaient toutes les filiales avant la grille. */
const ALL_ENTITIES_ROLES: readonly BootstrapRole[] = ['hr_manager', 'hr_officer']

/** Garde-fou : une clé de table absente du catalogue ne doit jamais être écrite. */
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
      WHERE NOT EXISTS (SELECT 1 FROM "${schema}".hab_subgroups WHERE kind = 'siege')`,
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
 * « RH Siège »). Idempotent : unicité de `legal_entity_id` et du nom de groupe.
 * `db` permet de l'exécuter dans une transaction existante.
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
}

/**
 * Reprise : affecte les utilisateurs RH actifs sans affectation avec les droits
 * que leur rôle leur donnait. Renvoie le nombre de personnes affectées.
 * Sous-groupe : filiale du `raf_site` (entité dont il est RAF, ou période de paie
 * dont il est RAF) ou de la fiche employé ; sinon (ou si filiale siège) « RH Siège ».
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
            )::text AS entity_id
       FROM "${schema}".users u
      WHERE u.is_active = true
        AND u.role IN ('hr_manager', 'hr_officer', 'raf_site')
        AND NOT EXISTS (SELECT 1 FROM "${schema}".hab_assignments a WHERE a.user_id = u.id)
      ORDER BY u.id`,
  )

  const ceilings = new Map<string, Set<string>>()
  const assignedIds: string[] = []
  for (const u of cand.rows) {
    let subgroupId = siegeId
    const isSiege = u.entity_id === null || headIds.has(u.entity_id)
    if (!isSiege && u.entity_id) {
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
      if (!found) continue // filiale disparue : on n'élargit jamais vers le siège
      subgroupId = found
    }
    const perms = [...ROLE_DEFAULT_PERMISSIONS[u.role]]
    if (SENSITIVE_ROLES.includes(u.role)) perms.push('sensitive_data')
    if (isSiege && ALL_ENTITIES_ROLES.includes(u.role)) perms.push('all_entities')
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

  if (assignedIds.length > 0) {
    // Audit : nombre et identifiants uniquement, aucune donnée personnelle.
    auditTenant(schema, {
      userId: null,
      action: 'habilitation.bootstrap',
      entity: 'habilitation',
      entityId: null,
      changes: { count: assignedIds.length, userIds: assignedIds },
      ip: null,
    })
  }
  return assignedIds.length
}

/**
 * Orchestration de la migration lazy. Ne lève JAMAIS : une erreur est journalisée
 * et le marqueur n'est pas posé (nouvelle tentative au prochain démarrage).
 *  1. colonne marqueur (idempotent) ; marqueur déjà posé => rien à faire ;
 *  2. structure (transaction propre, committée même si la reprise échoue) ;
 *  3. reprise + marqueur dans UNE transaction.
 */
export async function runHabilitationBootstrap(schema: string): Promise<void> {
  try {
    assertValidSchemaName(schema)
    await pool.query(`ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS hab_bootstrapped_at timestamptz`)
    const mark = await pool.query<{ done: boolean }>(
      `SELECT (hab_bootstrapped_at IS NOT NULL) AS done FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
      [schema],
    )
    if (mark.rows[0]?.done === true) return

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hab_bootstrap:${schema}`])
      await ensureHabilitationStructure(schema, client)
      await client.query('COMMIT')
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
  await db.query(`ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS hab_bootstrapped_at timestamptz`)
  await db.query(`UPDATE platform.tenants SET hab_bootstrapped_at = now() WHERE schema_name = $1`, [schema])
}
