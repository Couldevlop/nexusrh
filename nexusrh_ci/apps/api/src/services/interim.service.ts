/**
 * Continuité des validations — qui est absent, et qui le remplace.
 *
 * Le circuit de validation (absences, notes de frais) s'arrêtait net dès que
 * le valideur d'une étape partait en congé : seul le responsable concerné
 * pouvait viser son étape, sans aucune échappatoire, et à l'étape RH le reste
 * de l'équipe devait attendre que l'échéance soit DÉPASSÉE pour reprendre la
 * main. Une semaine de congés du DRH ou d'un chef de service, et tout le
 * service attendait son retour.
 *
 * Deux sources de continuité, et seulement deux :
 *
 *  1. **L'absence constatée.** Le système sait déjà qui est absent : une
 *     absence APPROUVÉE qui couvre aujourd'hui. Aucune saisie supplémentaire
 *     n'est nécessaire, et c'est un fait vérifiable, pas une déclaration.
 *  2. **L'intérim déclaré** (`approval_interims`). Nommer le suppléant du DRH
 *     ne se déduit d'aucune donnée : cela se décide et s'enregistre, pour une
 *     période bornée.
 *
 * Ni l'une ni l'autre n'élargit un périmètre : le suppléant agit là où
 * l'absent était valideur, et l'escalade hiérarchique ne va qu'au niveau
 * SUPÉRIEUR (N+2…) ou à l'équipe RH, qui termine de toute façon le circuit.
 * Chaque décision prise à ce titre est tracée (`override`, cause).
 *
 * Un tenant provisionné avant ce module (table absente) obtient un contexte
 * vide : l'absence de la table n'est pas une panne, seulement l'absence
 * d'intérim déclaré.
 */
import { assertValidSchemaName } from '../utils/schema-name.js'

/** Codes PostgreSQL « table absente » / « colonne absente » : tenant non migré. */
const PG_UNDEFINED_TABLE = '42P01'
const PG_UNDEFINED_COLUMN = '42703'
function isMissingSchemaObject(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === PG_UNDEFINED_TABLE || code === PG_UNDEFINED_COLUMN
}

export interface InterimContext {
  /** Employés valideurs absents aujourd'hui (absence approuvée en cours). */
  absentEmployeeIds: ReadonlySet<string>
  /** Comptes de ces mêmes absents (l'étape RH désigne un utilisateur). */
  absentUserIds: ReadonlySet<string>
  /** Employé remplacé → employés suppléants déclarés. */
  standInEmployees: ReadonlyMap<string, ReadonlySet<string>>
  /** Utilisateur remplacé → utilisateurs suppléants déclarés. */
  standInUsers: ReadonlyMap<string, ReadonlySet<string>>
}

export const EMPTY_INTERIM: InterimContext = {
  absentEmployeeIds: new Set(),
  absentUserIds:     new Set(),
  standInEmployees:  new Map(),
  standInUsers:      new Map(),
}

interface Db {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>()
  set.add(value)
  map.set(key, set)
}

/**
 * Contexte de continuité du tenant : absents du jour et intérims en cours.
 *
 * Le pool est passé par l'appelant (aucun import de `db/pool`) : le service
 * de circuit qui dépend de ce module reste ainsi testable sans base ni
 * variables d'environnement.
 *
 * Deux requêtes, parcours en mémoire — comme la table employé → responsable du
 * circuit. La FENÊTRE de validité et la révocation sont filtrées DANS le SQL :
 * aucun calcul de date côté Node, donc aucune dérive d'horloge entre l'API et
 * la base, et un intérim cesse à la seconde prévue sans qu'aucun job ne
 * tourne.
 */
export async function loadInterimContext(schema: string, db: Db): Promise<InterimContext> {
  assertValidSchemaName(schema)
  const absentEmployeeIds = new Set<string>()
  const absentUserIds = new Set<string>()
  const standInEmployees = new Map<string, Set<string>>()
  const standInUsers = new Map<string, Set<string>>()

  try {
    const absents = await db.query<{ employee_id: string; user_id: string | null }>(
      `SELECT DISTINCT a.employee_id::text AS employee_id, u.id::text AS user_id
         FROM "${schema}".absences a
         LEFT JOIN "${schema}".users u ON u.employee_id = a.employee_id
        WHERE a.status = 'approved'
          AND current_date BETWEEN a.start_date AND a.end_date`,
    )
    for (const row of absents.rows) {
      absentEmployeeIds.add(row.employee_id)
      if (row.user_id) absentUserIds.add(row.user_id)
    }
  } catch (err) {
    if (!isMissingSchemaObject(err)) throw err
  }

  try {
    const interims = await db.query<{
      absent_user_id: string; interim_user_id: string
      absent_employee_id: string | null; interim_employee_id: string | null
    }>(
      `SELECT i.absent_user_id::text  AS absent_user_id,
              i.interim_user_id::text AS interim_user_id,
              ua.employee_id::text    AS absent_employee_id,
              ui.employee_id::text    AS interim_employee_id
         FROM "${schema}".approval_interims i
         LEFT JOIN "${schema}".users ua ON ua.id = i.absent_user_id
         LEFT JOIN "${schema}".users ui ON ui.id = i.interim_user_id
        WHERE i.revoked_at IS NULL
          AND now() BETWEEN i.starts_at AND i.ends_at`,
    )
    for (const row of interims.rows) {
      add(standInUsers, row.absent_user_id, row.interim_user_id)
      if (row.absent_employee_id && row.interim_employee_id) {
        add(standInEmployees, row.absent_employee_id, row.interim_employee_id)
      }
    }
  } catch (err) {
    if (!isMissingSchemaObject(err)) throw err
  }

  return { absentEmployeeIds, absentUserIds, standInEmployees, standInUsers }
}
