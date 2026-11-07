/**
 * Fiche d'habilitation — circuit brouillon → N+1 → N+2 → verrouillée → appliquée.
 *
 * La fiche est la PREUVE écrite d'une décision d'accès : elle porte qui a
 * demandé, qui a validé, quand, et avec quelles cases. D'où trois règles qui
 * tiennent tout le module :
 *
 *  1. Chaque transition écrit un événement (`hab_fiche_events`) : le circuit
 *     est reconstituable même si la fiche est ensuite périmée ou rejetée.
 *  2. Un événement ne porte JAMAIS de donnée personnelle — seules des clés de
 *     permission (le diff d'une édition est `{ before, after }` de cases).
 *  3. Les droits ne sont jamais écrits ailleurs qu'à l'application (admin), et
 *     toujours sous le plafond du sous-groupe : une case hors plafond est
 *     refusée dès la saisie, pas silencieusement rognée à l'exécution.
 *
 * SÉCURITÉ : OWASP A01 (acteur attendu à chaque étape, aucune auto-habilitation,
 * périmètre du créateur), A03 (cases bornées au catalogue puis au plafond),
 * A09 (journal d'événements + audit).
 */
import type { QueryResultRow } from 'pg'
import { pool } from '../../db/pool.js'
import { assertValidSchemaName } from '../../utils/schema-name.js'
import { auditTenant } from '../../utils/audit-log.js'
import { isPermission } from './catalog.js'
import type { HabContext } from '../../services/habilitation.service.js'

/** Sous-ensemble de pg.Pool / pg.PoolClient utilisé ici. */
export interface FicheDb {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>
}

/** Erreur métier portant le code HTTP que la route doit rendre. */
export class FicheError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FicheError'
    this.status = status
  }
}

export interface Delegation {
  id: string
  delegatorId: string
  /** Sous-groupe du délégant ; `null` = périmètre groupe (tout sous-groupe). */
  subgroupId: string | null
  endsAt: string
}

export interface SodAlert { ruleId: string; label: string }

export interface FicheRow {
  id: string
  number: string
  target_user_id: string
  subgroup_id: string | null
  permissions: string[] | null
  status: string
  kind: 'grant' | 'revoke'
  n1_user_id: string | null
  n2_user_id: string | null
  created_by: string | null
  sod_alerts: SodAlert[] | null
  motive: string | null
  effective_from: string | null
  rejected_reason: string | null
  /** Plafond du sous-groupe, joint à la lecture (jamais stocké sur la fiche). */
  ceiling?: string[] | null
}

export interface FicheActor {
  actorId: string
  role: string
  ctx: HabContext | null
  ip: string | null
  /** Délégation active de l'acteur, si la route en a chargé une (tâche 12). */
  delegation?: Delegation | null
}

export interface FicheInput {
  targetUserId: string
  subgroupId: string
  permissions: string[]
  motive?: string | null
  effectiveFrom?: string | null
  kind?: 'grant' | 'revoke'
  templateKey?: string | null
}

export interface FichePatch {
  permissions?: string[]
  motive?: string | null
  effectiveFrom?: string | null
}

const FICHE_COLUMNS = `f.id::text AS id, f.number, f.target_user_id::text AS target_user_id,
        f.subgroup_id::text AS subgroup_id, f.permissions, f.status, f.kind,
        f.n1_user_id::text AS n1_user_id, f.n2_user_id::text AS n2_user_id,
        f.created_by::text AS created_by, f.sod_alerts, f.motive, f.effective_from,
        f.rejected_reason, f.created_at, f.locked_at, f.applied_at`

/**
 * Qui peut demander une fiche, et pour quel sous-groupe.
 * `admin` partout ; un titulaire de « gérer les habilitations » au siège
 * (DRH Groupe) partout ; sur une filiale, son sous-groupe seulement ; une
 * délégation active ouvre le périmètre du délégant, pas davantage.
 */
export function canCreateFiche(
  ctx: HabContext | null,
  role: string,
  subgroupId: string,
  activeDelegation: Delegation | null,
): boolean {
  if (role === 'admin') return true
  if (ctx && ctx.manageHabilitations) {
    if (ctx.kind === 'siege') return true
    if (ctx.kind === 'entity') return ctx.subgroupId === subgroupId
  }
  if (activeDelegation) {
    return activeDelegation.subgroupId === null || activeDelegation.subgroupId === subgroupId
  }
  return false
}

/** Un titulaire de « gérer les habilitations » au siège, sinon un admin actif. */
async function fallbackApprover(schema: string, db: FicheDb, excluded: string[]): Promise<string | null> {
  const holder = await db.query<{ id: string }>(
    `SELECT a.user_id::text AS id
       FROM "${schema}".hab_assignments a
       JOIN "${schema}".hab_subgroups sg ON sg.id = a.subgroup_id
      WHERE a.revoked_at IS NULL AND sg.kind = 'siege'
        AND 'manage_habilitations' = ANY(a.permissions)
      ORDER BY a.created_at
      LIMIT 10`,
  )
  const holderId = holder.rows.map((r) => r.id).find((id) => !excluded.includes(id))
  if (holderId) return holderId
  const admin = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM "${schema}".users
      WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 10`,
  )
  return admin.rows.map((r) => r.id).find((id) => !excluded.includes(id)) ?? null
}

/**
 * Validateurs d'une fiche : le N+1 puis le N+2 du dossier ciblé. Un validateur
 * sans compte, qui serait la personne ciblée, ou le créateur lui-même, est
 * sauté — le suivant monte d'un cran, et le dernier cran est rattrapé par un
 * titulaire de « gérer les habilitations » ou un admin. Sans ce rattrapage, une
 * fiche resterait bloquée faute d'acteur, ce qui pousserait à habiliter « à la
 * main » hors circuit.
 */
export async function resolveApprovers(
  schema: string,
  targetUserId: string,
  creatorId: string,
  db: FicheDb = pool,
): Promise<{ n1: string | null; n2: string | null }> {
  assertValidSchemaName(schema)
  const res = await db.query<{ n1_user: string | null; n2_user: string | null }>(
    `WITH tgt AS (
        SELECT e.id, e.manager_id FROM "${schema}".users u
          JOIN "${schema}".employees e ON e.id = u.employee_id
         WHERE u.id = $1::uuid
     ), lvl1 AS (
        SELECT e.id, e.manager_id FROM "${schema}".employees e JOIN tgt ON e.id = tgt.manager_id
     ), lvl2 AS (
        SELECT e.id FROM "${schema}".employees e JOIN lvl1 ON e.id = lvl1.manager_id
     )
     SELECT (SELECT u.id::text FROM "${schema}".users u JOIN lvl1 ON u.employee_id = lvl1.id
              WHERE u.is_active = true LIMIT 1) AS n1_user,
            (SELECT u.id::text FROM "${schema}".users u JOIN lvl2 ON u.employee_id = lvl2.id
              WHERE u.is_active = true LIMIT 1) AS n2_user`,
    [targetUserId],
  )
  const row = res.rows[0]
  const excluded = [targetUserId, creatorId]
  const chain: string[] = []
  for (const candidate of [row?.n1_user ?? null, row?.n2_user ?? null]) {
    if (candidate && !excluded.includes(candidate) && !chain.includes(candidate)) chain.push(candidate)
  }
  const n1 = chain[0] ?? (await fallbackApprover(schema, db, excluded))
  const n2 = chain[1] ?? (await fallbackApprover(schema, db, [...excluded, ...(n1 ? [n1] : [])]))
  return { n1: n1 ?? null, n2: n2 ?? null }
}

/**
 * Cumuls sensibles : les cases de la fiche sont confrontées à celles DÉJÀ
 * affectées à la personne. Juger la fiche seule laisserait passer le cumul
 * construit en deux fiches successives.
 */
export async function computeSodAlerts(
  schema: string,
  targetUserId: string,
  permissions: string[],
  db: FicheDb = pool,
): Promise<SodAlert[]> {
  assertValidSchemaName(schema)
  const rules = await db.query<{ id: string; label: string; left_perm: string; right_perm: string }>(
    `SELECT id::text AS id, label, left_perm, right_perm FROM "${schema}".hab_sod_rules WHERE active = true`,
  )
  const existing = await db.query<{ permissions: string[] | null }>(
    `SELECT permissions FROM "${schema}".hab_assignments WHERE user_id = $1::uuid AND revoked_at IS NULL LIMIT 1`,
    [targetUserId],
  )
  const all = new Set<string>([...permissions, ...(existing.rows[0]?.permissions ?? [])])
  return rules.rows
    .filter((r) => all.has(r.left_perm) && all.has(r.right_perm))
    .map((r) => ({ ruleId: r.id, label: r.label }))
}

async function loadFiche(schema: string, ficheId: string, db: FicheDb): Promise<FicheRow> {
  const res = await db.query<FicheRow>(
    `SELECT ${FICHE_COLUMNS}, sg.ceiling
       FROM "${schema}".hab_fiches f
       LEFT JOIN "${schema}".hab_subgroups sg ON sg.id = f.subgroup_id
      WHERE f.id = $1::uuid`,
    [ficheId],
  )
  const fiche = res.rows[0]
  if (!fiche) throw new FicheError(404, 'Fiche introuvable')
  return fiche
}

/** Cases hors catalogue (400) puis hors plafond (400, en les nommant). */
function assertPermissions(permissions: readonly string[], ceiling: readonly string[] | null | undefined): void {
  const unknown = permissions.find((p) => !isPermission(p))
  if (unknown !== undefined) throw new FicheError(400, `Permission inconnue : ${unknown}`)
  const over = permissions.filter((p) => !(ceiling ?? []).includes(p))
  if (over.length > 0) {
    throw new FicheError(400, `Cases hors plafond du sous-groupe : ${over.join(', ')}`)
  }
}

function event(
  schema: string, db: FicheDb, ficheId: string, actorId: string | null,
  name: string, diff: Record<string, unknown>, ip: string | null,
): Promise<unknown> {
  return db.query(
    `INSERT INTO "${schema}".hab_fiche_events (fiche_id, actor_id, event, diff, ip)
     VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)`,
    [ficheId, actorId, name, JSON.stringify(diff), ip],
  )
}

function notify(
  schema: string, db: FicheDb, userId: string | null,
  type: string, title: string, message: string, data: Record<string, unknown>,
): Promise<unknown> {
  if (!userId) return Promise.resolve(undefined)
  return db.query(
    `INSERT INTO "${schema}".notifications (user_id, type, title, message, data)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
    [userId, type, title, message, JSON.stringify(data)],
  ).catch(() => undefined)
}

/** Crée un brouillon : validateurs résolus, cumuls calculés, événement `created`. */
export async function createFiche(
  schema: string, actor: FicheActor, input: FicheInput, db: FicheDb = pool,
): Promise<FicheRow> {
  assertValidSchemaName(schema)
  // Personne ne s'habilite soi-même, quel que soit son rôle.
  if (input.targetUserId === actor.actorId) {
    throw new FicheError(403, 'Impossible de rédiger une fiche pour soi-même')
  }
  if (!canCreateFiche(actor.ctx, actor.role, input.subgroupId, actor.delegation ?? null)) {
    throw new FicheError(403, 'Ce sous-groupe est hors de votre périmètre')
  }
  const sg = await db.query<{ id: string; ceiling: string[] | null }>(
    `SELECT id::text AS id, ceiling FROM "${schema}".hab_subgroups WHERE id = $1::uuid`,
    [input.subgroupId],
  )
  const subgroup = sg.rows[0]
  if (!subgroup) throw new FicheError(404, 'Sous-groupe introuvable')
  assertPermissions(input.permissions, subgroup.ceiling)

  const { n1, n2 } = await resolveApprovers(schema, input.targetUserId, actor.actorId, db)
  const alerts = await computeSodAlerts(schema, input.targetUserId, input.permissions, db)
  const res = await db.query<FicheRow>(
    `INSERT INTO "${schema}".hab_fiches
       (target_user_id, subgroup_id, permissions, template_key, motive, effective_from,
        n1_user_id, n2_user_id, created_by, kind, sod_alerts, number)
     VALUES ($1::uuid, $2::uuid, $3::text[], $4, $5, $6::date, $7::uuid, $8::uuid, $9::uuid, $10, $11::jsonb,
       'HAB-' || to_char(now(), 'YYYY') || '-' || lpad((
         (SELECT count(*) + 1 FROM "${schema}".hab_fiches
           WHERE number LIKE 'HAB-' || to_char(now(), 'YYYY') || '-%'))::text, 4, '0'))
     RETURNING ${FICHE_COLUMNS.replace(/f\./g, '')}`,
    [
      input.targetUserId, input.subgroupId, input.permissions, input.templateKey ?? null,
      input.motive ?? null, input.effectiveFrom ?? null, n1, n2, actor.actorId,
      input.kind ?? 'grant', JSON.stringify(alerts),
    ],
  )
  const fiche = res.rows[0]
  if (!fiche) throw new FicheError(500, 'Création de la fiche impossible')
  await event(schema, db, fiche.id, actor.actorId, 'created', {
    permissions: input.permissions, kind: input.kind ?? 'grant', sodAlerts: alerts.map((a) => a.label),
  }, actor.ip)
  auditTenant(schema, {
    userId: actor.actorId, action: 'habilitation.fiche.created', entity: 'habilitation_fiche',
    entityId: fiche.id, changes: { permissions: input.permissions, subgroupId: input.subgroupId }, ip: actor.ip,
  })
  return fiche
}

/** Brouillon (ou fiche rejetée) → N+1, avec notification du validateur. */
export async function submitFiche(
  schema: string, ficheId: string, actorId: string, role: string, db: FicheDb = pool, ip: string | null = null,
): Promise<FicheRow> {
  assertValidSchemaName(schema)
  const fiche = await loadFiche(schema, ficheId, db)
  if (!['draft', 'rejected'].includes(fiche.status)) {
    throw new FicheError(409, 'Cette fiche a déjà été soumise')
  }
  if (fiche.created_by !== actorId && role !== 'admin') {
    throw new FicheError(403, 'Seul le rédacteur de la fiche peut la soumettre')
  }
  const res = await db.query<FicheRow>(
    `UPDATE "${schema}".hab_fiches SET status = 'n1', rejected_reason = NULL
      WHERE id = $1::uuid RETURNING ${FICHE_COLUMNS.replace(/f\./g, '')}`,
    [ficheId],
  )
  await event(schema, db, ficheId, actorId, 'submitted', {}, ip)
  await notify(schema, db, fiche.n1_user_id, 'habilitation_fiche',
    'Fiche d\'habilitation à valider', `Fiche ${fiche.number} en attente de votre validation`, { ficheId })
  return res.rows[0] ?? fiche
}

/**
 * N+1 → N+2, puis N+2 → verrouillée. Les admins ne sont prévenus qu'au
 * verrouillage : avant, la fiche peut encore changer, et une notification par
 * étape ferait de la piste d'audit un bruit de fond.
 */
export async function validateFiche(
  schema: string, ficheId: string, actorId: string, role: string,
  opts: { acceptSod?: boolean } = {}, db: FicheDb = pool, ip: string | null = null,
): Promise<FicheRow> {
  assertValidSchemaName(schema)
  const fiche = await loadFiche(schema, ficheId, db)
  if (fiche.status !== 'n1' && fiche.status !== 'n2') {
    throw new FicheError(409, 'Cette fiche n\'est pas en attente de validation')
  }
  const expected = fiche.status === 'n1' ? fiche.n1_user_id : fiche.n2_user_id
  if (expected !== actorId) {
    throw new FicheError(403, 'Vous n\'êtes pas le validateur attendu à cette étape')
  }
  const alerts = fiche.sod_alerts ?? []
  if (alerts.length > 0 && opts.acceptSod !== true) {
    throw new FicheError(409, `Cumul sensible à confirmer : ${alerts.map((a) => a.label).join(', ')}`)
  }
  if (alerts.length > 0) {
    await event(schema, db, ficheId, actorId, 'sod_accepted', { rules: alerts.map((a) => a.label) }, ip)
  }
  const next = fiche.status === 'n1' ? 'n2' : 'locked'
  const res = await db.query<FicheRow>(
    next === 'n2'
      ? `UPDATE "${schema}".hab_fiches SET status = 'n2' WHERE id = $1::uuid RETURNING ${FICHE_COLUMNS.replace(/f\./g, '')}`
      : `UPDATE "${schema}".hab_fiches SET status = 'locked', locked_at = now() WHERE id = $1::uuid RETURNING ${FICHE_COLUMNS.replace(/f\./g, '')}`,
    [ficheId],
  )
  await event(schema, db, ficheId, actorId, 'validated', { step: fiche.status }, ip)
  if (next === 'n2') {
    await notify(schema, db, fiche.n2_user_id, 'habilitation_fiche',
      'Fiche d\'habilitation à valider', `Fiche ${fiche.number} en attente de votre validation`, { ficheId })
  } else {
    await event(schema, db, ficheId, actorId, 'locked', {}, ip)
    const admins = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM "${schema}".users WHERE role = 'admin' AND is_active = true`,
    )
    for (const a of admins.rows) {
      await notify(schema, db, a.id, 'habilitation_fiche',
        'Fiche d\'habilitation à appliquer', `Fiche ${fiche.number} validée, prête à être appliquée`, { ficheId })
    }
  }
  auditTenant(schema, {
    userId: actorId, action: 'habilitation.fiche.validated', entity: 'habilitation_fiche',
    entityId: ficheId, changes: { from: fiche.status, to: next }, ip,
  })
  return res.rows[0] ?? fiche
}

/** Refus motivé : la fiche retourne à son rédacteur, qui peut rééditer. */
export async function rejectFiche(
  schema: string, ficheId: string, actorId: string, role: string, reason: string,
  db: FicheDb = pool, ip: string | null = null,
): Promise<FicheRow> {
  assertValidSchemaName(schema)
  const motive = (reason ?? '').trim()
  if (motive.length < 3) throw new FicheError(400, 'Le motif du refus est obligatoire')
  const fiche = await loadFiche(schema, ficheId, db)
  if (!['n1', 'n2', 'locked'].includes(fiche.status)) {
    throw new FicheError(409, 'Cette fiche n\'est pas refusable à ce stade')
  }
  const expected = fiche.status === 'n1' ? fiche.n1_user_id : fiche.status === 'n2' ? fiche.n2_user_id : null
  const allowed = fiche.status === 'locked' ? role === 'admin' : expected === actorId || role === 'admin'
  if (!allowed) throw new FicheError(403, 'Vous n\'êtes pas l\'acteur attendu à cette étape')
  const res = await db.query<FicheRow>(
    `UPDATE "${schema}".hab_fiches SET status = 'rejected', rejected_reason = $1
      WHERE id = $2::uuid RETURNING ${FICHE_COLUMNS.replace(/f\./g, '')}`,
    [motive, ficheId],
  )
  await event(schema, db, ficheId, actorId, 'rejected', { step: fiche.status }, ip)
  await notify(schema, db, fiche.created_by, 'habilitation_fiche',
    'Fiche d\'habilitation refusée', `Fiche ${fiche.number} refusée : ${motive}`, { ficheId })
  auditTenant(schema, {
    userId: actorId, action: 'habilitation.fiche.rejected', entity: 'habilitation_fiche',
    entityId: ficheId, changes: { step: fiche.status }, ip,
  })
  return res.rows[0] ?? fiche
}

/**
 * Édition : le rédacteur sur son brouillon (ou après refus), le N+1 à l'étape
 * n1, le N+2 à l'étape n2. Après verrouillage, plus rien ne change — sinon la
 * signature des validateurs ne vaudrait plus pour ce qui est appliqué.
 */
export async function editFiche(
  schema: string, ficheId: string, actorId: string, role: string, patch: FichePatch,
  db: FicheDb = pool, ip: string | null = null,
): Promise<FicheRow> {
  assertValidSchemaName(schema)
  const fiche = await loadFiche(schema, ficheId, db)
  if (!['draft', 'rejected', 'n1', 'n2'].includes(fiche.status)) {
    throw new FicheError(409, 'Fiche verrouillée : plus aucune modification')
  }
  const expected = fiche.status === 'n1' ? fiche.n1_user_id
    : fiche.status === 'n2' ? fiche.n2_user_id
    : fiche.created_by
  if (expected !== actorId && role !== 'admin') {
    throw new FicheError(403, 'Vous n\'êtes pas l\'acteur attendu à cette étape')
  }
  if (patch.permissions) assertPermissions(patch.permissions, fiche.ceiling)
  const res = await db.query<FicheRow>(
    `UPDATE "${schema}".hab_fiches
        SET permissions = COALESCE($1::text[], permissions),
            motive = COALESCE($2, motive),
            effective_from = COALESCE($3::date, effective_from)
      WHERE id = $4::uuid RETURNING ${FICHE_COLUMNS.replace(/f\./g, '')}`,
    [patch.permissions ?? null, patch.motive ?? null, patch.effectiveFrom ?? null, ficheId],
  )
  // Diff : uniquement des clés de permission (aucun motif, aucun identifiant de personne).
  if (patch.permissions) {
    await event(schema, db, ficheId, actorId, 'edited', {
      before: fiche.permissions ?? [], after: patch.permissions,
    }, ip)
  } else {
    await event(schema, db, ficheId, actorId, 'edited', { fields: Object.keys(patch) }, ip)
  }
  // Le cumul est recalculé : une édition peut en créer ou en lever un.
  if (patch.permissions) {
    const alerts = await computeSodAlerts(schema, fiche.target_user_id, patch.permissions, db)
    await db.query(
      `UPDATE "${schema}".hab_fiches SET sod_alerts = $1::jsonb WHERE id = $2::uuid`,
      [JSON.stringify(alerts), ficheId],
    )
  }
  return res.rows[0] ?? fiche
}

/**
 * Application (admin seul) : la fiche verrouillée devient l'affectation de la
 * personne. Une seule affectation par personne (index unique) : la précédente
 * est remplacée, et la fiche qui la portait passe à `superseded` — l'historique
 * reste lisible sans jamais laisser deux fiches « appliquées » en concurrence.
 */
export async function applyFiche(
  schema: string, ficheId: string, actorId: string, role: string,
  ip: string | null = null, db: FicheDb = pool,
): Promise<FicheRow> {
  assertValidSchemaName(schema)
  const fiche = await loadFiche(schema, ficheId, db)
  if (role !== 'admin') throw new FicheError(403, 'Seul l\'administrateur applique une fiche')
  if (fiche.status !== 'locked') throw new FicheError(409, 'Seule une fiche verrouillée peut être appliquée')

  if (fiche.kind === 'revoke') {
    await db.query(
      `UPDATE "${schema}".hab_assignments SET revoked_at = now()
        WHERE user_id = $1::uuid AND revoked_at IS NULL`,
      [fiche.target_user_id],
    )
  } else {
    await db.query(
      `INSERT INTO "${schema}".hab_assignments (user_id, subgroup_id, permissions, source, fiche_id, effective_from)
       VALUES ($1::uuid, $2::uuid, $3::text[], 'fiche', $4::uuid, $5::date)
       ON CONFLICT (user_id) DO UPDATE
         SET subgroup_id = EXCLUDED.subgroup_id, permissions = EXCLUDED.permissions,
             source = 'fiche', fiche_id = EXCLUDED.fiche_id,
             effective_from = EXCLUDED.effective_from, revoked_at = NULL`,
      [fiche.target_user_id, fiche.subgroup_id, fiche.permissions ?? [], ficheId, fiche.effective_from],
    )
  }
  await db.query(
    `UPDATE "${schema}".hab_fiches SET status = 'superseded'
      WHERE target_user_id = $1::uuid AND status = 'applied' AND id <> $2::uuid`,
    [fiche.target_user_id, ficheId],
  )
  const res = await db.query<FicheRow>(
    `UPDATE "${schema}".hab_fiches SET status = 'applied', applied_at = now(), applied_by = $1::uuid
      WHERE id = $2::uuid RETURNING ${FICHE_COLUMNS.replace(/f\./g, '')}`,
    [actorId, ficheId],
  )
  await event(schema, db, ficheId, actorId, 'applied', { permissions: fiche.permissions ?? [], kind: fiche.kind }, ip)
  await notify(schema, db, fiche.target_user_id, 'habilitation_fiche',
    fiche.kind === 'revoke' ? 'Habilitations retirées' : 'Habilitations accordées',
    `Fiche ${fiche.number} appliquée`, { ficheId })
  auditTenant(schema, {
    userId: actorId, action: 'habilitation.fiche.applied', entity: 'habilitation_fiche',
    entityId: ficheId, changes: { kind: fiche.kind, permissions: fiche.permissions ?? [] }, ip,
  })
  return res.rows[0] ?? fiche
}

/** Fiches où l'appelant est acteur (rédacteur, validateur) ; l'admin voit tout. */
export async function listFiches(
  schema: string, actorId: string, role: string, db: FicheDb = pool,
): Promise<FicheRow[]> {
  assertValidSchemaName(schema)
  const mine = role === 'admin'
    ? ''
    : `WHERE f.created_by = $1::uuid OR f.n1_user_id = $1::uuid OR f.n2_user_id = $1::uuid`
  const res = await db.query<FicheRow>(
    `SELECT ${FICHE_COLUMNS}
       FROM "${schema}".hab_fiches f
       ${mine}
      ORDER BY f.created_at DESC
      LIMIT 500`,
    role === 'admin' ? [] : [actorId],
  )
  return res.rows
}

/** Une fiche et son journal ; `null` si l'appelant n'en est pas un acteur. */
export async function getFicheWithEvents(
  schema: string, ficheId: string, actorId: string, role: string, db: FicheDb = pool,
): Promise<{ fiche: FicheRow; events: unknown[] } | null> {
  assertValidSchemaName(schema)
  const fiche = await loadFiche(schema, ficheId, db)
  const isActor = role === 'admin' || [fiche.created_by, fiche.n1_user_id, fiche.n2_user_id].includes(actorId)
  if (!isActor) return null
  const events = await db.query(
    `SELECT id::text AS id, actor_id::text AS actor_id, event, diff, created_at
       FROM "${schema}".hab_fiche_events WHERE fiche_id = $1::uuid ORDER BY created_at`,
    [ficheId],
  )
  return { fiche, events: events.rows }
}
