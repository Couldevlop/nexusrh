/**
 * Écriture de la piste d'audit — implémentation UNIQUE (OWASP A09).
 *
 * ── Le problème corrigé ─────────────────────────────────────────────────────
 * 33 fichiers de routes hébergeaient chacun leur propre fonction d'audit :
 * `auditLogEmployee`, `auditLogSettings`, `auditMfa`, `audit`, `auditExport`…
 * 31 d'entre elles avaient un corps rigoureusement identique — le même INSERT,
 * le même `.catch()` non bloquant — recopié à la main. Conséquences :
 *
 *   - toute évolution transverse de la piste d'audit (nouvelle colonne, mise en
 *     file, redaction d'un champ sensible) demandait 33 modifications ;
 *   - les variantes avaient déjà divergé : validation du nom de schéma présente
 *     dans une seule copie, commentaires et gestion d'erreur légèrement
 *     différents d'un module à l'autre ;
 *   - un module créé par copier-coller héritait silencieusement de la variante
 *     copiée, sans que rien ne signale l'écart.
 *
 * Les fonctions locales des modules subsistent — elles fixent l'`entity` propre
 * au module et gardent les appelants inchangés — mais elles ne sont plus que des
 * adaptateurs d'une ligne au-dessus de ce fichier.
 *
 * ── Contrat ─────────────────────────────────────────────────────────────────
 * L'écriture est TOUJOURS « au mieux » : elle ne bloque jamais la requête
 * métier et n'échoue jamais bruyamment. Un tenant provisionné avant l'ajout de
 * `audit_log` doit continuer à fonctionner — c'était déjà le comportement des
 * 33 copies, il est ici garanti en un seul endroit.
 */
import { pool } from '../db/pool.js'
import { isValidSchemaName } from './schema-name.js'

export interface AuditEntry {
  /** Auteur de l'action ; `null` pour une action système ou anonyme. */
  userId: string | null | undefined
  /** Verbe métier, ex. `employee.updated`. */
  action: string
  /** Type d'objet concerné, ex. `employee`, `absence`, `settings`. */
  entity: string
  /** Identifiant de l'objet ; `null` si l'action ne cible pas une ligne. */
  entityId?: string | null
  /** Détail sérialisé en JSON dans la colonne `changes`. */
  changes?: Record<string, unknown>
  /** IP de l'appelant, telle que résolue par Fastify (cf. config.TRUST_PROXY). */
  ip?: string | null
}

const TENANT_SQL =
  `INSERT INTO "%SCHEMA%".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`

const PLATFORM_SQL =
  `INSERT INTO platform.audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`

function values(e: AuditEntry): unknown[] {
  return [
    e.userId ?? null,
    e.action,
    e.entity,
    e.entityId ?? null,
    JSON.stringify(e.changes ?? {}),
    e.ip ?? null,
  ]
}

/**
 * Écrit dans la piste d'audit d'un TENANT.
 *
 * Le nom de schéma est interpolé dans un identifiant SQL : il est donc validé
 * ici, systématiquement. C'est une défense en profondeur — `plugins/auth.ts`
 * rejette déjà en amont, au point de passage central de l'authentification,
 * tout jeton dont le `schemaName` n'est pas conforme — mais cette fonction est
 * désormais le seul endroit du dépôt où cette interpolation a lieu pour
 * l'audit, et elle ne doit pas dépendre de la vigilance de ses appelants.
 */
export function auditTenant(schema: string, entry: AuditEntry): void {
  if (!isValidSchemaName(schema)) return
  pool
    .query(TENANT_SQL.replace('%SCHEMA%', schema), values(entry))
    .catch(() => { /* tenant sans table audit_log : non bloquant */ })
}

/** Écrit dans la piste d'audit de la PLATEFORME (schéma `platform`). */
export function auditPlatform(entry: AuditEntry): void {
  pool
    .query(PLATFORM_SQL, values(entry))
    .catch(() => { /* table absente : non bloquant */ })
}

/**
 * Journal d'activité de la plateforme — table distincte de `platform.audit_log`
 * (colonnes `actor_user_id` / `payload`), utilisée par le parcours MFA.
 */
export function activityPlatform(entry: Pick<AuditEntry, 'userId' | 'action' | 'changes' | 'ip'>): void {
  pool
    .query(
      `INSERT INTO platform.activity_log (actor_user_id, action, payload, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [entry.userId ?? null, entry.action, JSON.stringify(entry.changes ?? {}), entry.ip ?? null],
    )
    .catch(() => { /* table absente : non bloquant */ })
}
