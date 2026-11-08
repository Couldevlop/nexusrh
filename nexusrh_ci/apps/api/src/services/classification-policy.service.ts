/**
 * Politique de classification — application effective, et non plus registre.
 *
 * ── Le problème corrigé ─────────────────────────────────────────────────────
 * Le module `classification` savait tout dire et ne décidait rien. Un tenant
 * pouvait déclarer « Bulletins de paie = Confidentiel, export interdit au-delà
 * de ces rôles », et l'export CSV continuait de s'ouvrir à qui avait la
 * permission technique. La grille était un document, pas une règle : elle
 * rassurait en recette et ne protégeait rien en production. Pire, un client
 * l'ayant paramétrée pouvait soutenir de bonne foi que ses données de santé
 * étaient inexportables — ce qui était faux.
 *
 * Ce service lit la grille DU TENANT et rend une décision. Les routes
 * d'export et les modules de niveau 4 s'y réfèrent désormais avant d'agir.
 *
 * ── Zéro régression, par construction ───────────────────────────────────────
 * Si le module n'est pas provisionné sur le tenant (tables absentes) ou si la
 * catégorie n'est pas cartographiée, la politique est `null` : AUCUNE règle ne
 * s'applique et le comportement existant est inchangé. L'application d'une
 * politique est donc toujours le résultat d'un paramétrage explicite du
 * client, jamais d'un effet de bord de la mise à jour.
 *
 * ── Pourquoi un cache ───────────────────────────────────────────────────────
 * Sans lui, chaque export paierait deux requêtes avant même de commencer, et
 * le contrôle de permissions deviendrait une raison de ne pas l'appeler. Le
 * cache est par schéma, borné dans le temps (30 s) : un changement de grille
 * prend effet au plus tard une demi-minute après, ce qui est sans conséquence
 * pour un paramétrage, et il est vidé explicitement quand le module écrit.
 */
import { isValidSchemaName } from '../utils/schema-name.js'
import { LEVEL_KEYS, roleCanAccess, roleCanExport, accessRequiresAudit, type LevelRule } from '../modules/classification/classification.service.js'

export interface ClassificationPolicy {
  /** Règles par niveau (1–4), telles que le tenant les a réglées. */
  rules: Map<number, LevelRule>
  /** Cartographie catégorie de données → niveau. */
  categories: Map<string, number>
}

export interface ClassificationDecision {
  /** Niveau de la catégorie, ou `null` si elle n'est pas cartographiée. */
  level: number | null
  /** Clé i18n du niveau (`restricted`…), pour un message compréhensible. */
  levelKey: string | null
  canAccess: boolean
  canExport: boolean
  auditRequired: boolean
  /**
   * `false` quand aucune politique ne s'applique (module non provisionné,
   * catégorie non cartographiée). L'appelant laisse alors passer : c'est ce
   * qui garantit l'absence de régression sur les tenants existants.
   */
  enforced: boolean
}

/** Décision neutre : rien à appliquer, l'appelant poursuit normalement. */
const LIBRE: ClassificationDecision = {
  level: null, levelKey: null, canAccess: true, canExport: true,
  auditRequired: false, enforced: false,
}

interface Db { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }

interface LevelRow {
  level: number; allowed_roles: string[] | null
  export_allowed: boolean; encryption_required: boolean; audit_required: boolean
}
interface CategoryRow { category_key: string; level: number }

/** Codes PostgreSQL d'un objet absent : tenant provisionné avant le module. */
function estObjetAbsent(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === '42P01' || code === '42703'
}

const TTL_MS = 30_000
const cache = new Map<string, { at: number; policy: ClassificationPolicy | null }>()

/** Vide le cache d'un tenant — appelé quand sa grille change. */
export function invalidateClassificationPolicy(schema: string): void {
  cache.delete(schema)
}

/**
 * Charge la grille du tenant. `null` = rien à appliquer.
 *
 * Ne lève jamais : une politique illisible ne doit pas faire échouer une
 * requête métier qui fonctionnait avant elle.
 */
export async function loadClassificationPolicy(schema: string, db: Db): Promise<ClassificationPolicy | null> {
  if (!isValidSchemaName(schema)) return null
  const hit = cache.get(schema)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.policy

  let policy: ClassificationPolicy | null = null
  try {
    const [lvl, cat] = await Promise.all([
      db.query(
        `SELECT level, allowed_roles, export_allowed, encryption_required, audit_required
           FROM "${schema}".classification_levels`,
      ),
      db.query(
        `SELECT category_key, level FROM "${schema}".data_classification_categories`,
      ),
    ])
    const rules = new Map<number, LevelRule>()
    for (const r of lvl.rows as LevelRow[]) {
      rules.set(Number(r.level), {
        level: Number(r.level),
        allowedRoles: r.allowed_roles ?? [],
        exportAllowed: r.export_allowed,
        encryptionRequired: r.encryption_required,
        auditRequired: r.audit_required,
      })
    }
    const categories = new Map<string, number>()
    for (const c of cat.rows as CategoryRow[]) categories.set(c.category_key, Number(c.level))
    // Une grille vide n'est pas une grille : ne rien appliquer plutôt que de
    // tout refuser faute de règles.
    policy = rules.size > 0 && categories.size > 0 ? { rules, categories } : null
  } catch (err) {
    // Objet absent = module non provisionné : état stable, qu'on met en cache.
    // Toute autre erreur (coupure, saturation) est passagère : ne pas la
    // mettre en cache, sinon un incident de 50 ms désarmerait la politique
    // pendant 30 s — exactement la fenêtre où un export passerait.
    if (!estObjetAbsent(err)) return null
  }
  cache.set(schema, { at: Date.now(), policy })
  return policy
}

/**
 * Décision pour un rôle sur une catégorie de données.
 *
 * `super_admin` n'accède à aucune donnée RH : la règle vient de
 * `roleCanAccess`, et elle n'est pas contournable par un paramétrage de
 * tenant.
 */
export function decide(policy: ClassificationPolicy | null, categoryKey: string, role: string): ClassificationDecision {
  if (!policy) return LIBRE
  const level = policy.categories.get(categoryKey)
  if (level === undefined) return LIBRE
  const rule = policy.rules.get(level)
  if (!rule) return LIBRE
  return {
    level,
    levelKey: LEVEL_KEYS[level] ?? null,
    canAccess: roleCanAccess(rule, role),
    canExport: roleCanExport(rule, role),
    auditRequired: accessRequiresAudit(rule),
    enforced: true,
  }
}

/** Raccourci : charge la grille et décide, en une fois. */
export async function decideFor(schema: string, db: Db, categoryKey: string, role: string): Promise<ClassificationDecision> {
  return decide(await loadClassificationPolicy(schema, db), categoryKey, role)
}

/**
 * Champs à masquer dans une réponse, d'après la grille.
 *
 * Un refus franc (403) convient à un export : l'utilisateur a demandé un
 * fichier, il apprend qu'il n'y a pas droit. Il ne convient PAS à une fiche
 * salarié, où bloquer l'écran entier parce qu'une ligne est confidentielle
 * empêcherait le travail courant. D'où le masquage : la fiche s'ouvre, la
 * rémunération n'y est pas, et l'utilisateur voit laquelle des informations
 * lui est fermée plutôt qu'un écran vide inexplicable.
 */
export function maskFields<T extends Record<string, unknown>>(
  row: T,
  champsParCategorie: Record<string, readonly string[]>,
  policy: ClassificationPolicy | null,
  role: string,
): { row: T; masked: string[] } {
  if (!policy) return { row, masked: [] }
  const masked: string[] = []
  const sortie: Record<string, unknown> = { ...row }
  for (const [categorie, champs] of Object.entries(champsParCategorie)) {
    const d = decide(policy, categorie, role)
    if (!d.enforced || d.canAccess) continue
    for (const champ of champs) {
      if (!(champ in sortie)) continue
      sortie[champ] = null
      masked.push(champ)
    }
  }
  return { row: sortie as T, masked }
}
