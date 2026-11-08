/**
 * Garde-fou d'export, piloté par la grille de classification du tenant.
 *
 * Une seule fonction, appelée en tête de chaque route d'export. Elle rend
 * `true` quand elle a REFUSÉ et déjà envoyé la réponse :
 *
 *   if (await refuserExportSiClassifie(request, reply, 'payslips')) return reply
 *
 * ── Pourquoi un booléen et non la réponse ───────────────────────────────────
 * Une `FastifyReply` est « thenable ». Rendre la réponse depuis une fonction
 * `async` la fait donc déballer par le `await` de l'appelant, qui reçoit
 * `undefined` — valeur fausse — et poursuit le handler : la route répondait
 * 403 PUIS exécutait quand même l'export. Le booléen ferme ce piège, et c'est
 * la forme déjà retenue par `denyUnlessSensitive` dans ce dépôt.
 *
 * Le refus est journalisé : un export empêché est une information de
 * conformité, et son absence de trace priverait le client de la preuve que sa
 * grille a effectivement joué.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { pool } from '../db/pool.js'
import { auditTenant } from './audit-log.js'
import { decideFor } from '../services/classification-policy.service.js'

/**
 * Catégories de la grille standard utilisées par les exports de l'application.
 * Nommées ici pour que le lien route → catégorie soit lisible d'un seul
 * endroit, et pour qu'une faute de frappe ne désarme pas silencieusement un
 * contrôle (une catégorie inconnue rend une décision neutre).
 */
export const CATEGORIES = {
  remuneration: 'remuneration',
  payslips: 'payslips',
  contracts: 'contracts',
  evaluations: 'evaluations',
  careerHistory: 'career_history',
  disciplinary: 'disciplinary',
  medical: 'medical',
} as const

export type CategoryKey = (typeof CATEGORIES)[keyof typeof CATEGORIES]

/**
 * Refuse l'export si la grille du tenant le ferme à ce rôle.
 *
 * Rend `false` si l'export est permis — ou si aucune politique ne s'applique,
 * ce qui est le cas des tenants qui n'ont jamais paramétré la grille.
 */
export async function refuserExportSiClassifie(
  request: FastifyRequest,
  reply: FastifyReply,
  category: CategoryKey,
): Promise<boolean> {
  const schema = request.user.schemaName
  const role = request.user.role
  const d = await decideFor(schema, pool, category, role)
  if (!d.enforced || d.canExport) return false

  auditTenant(schema, {
    userId: request.user.sub,
    action: 'classification.export_refused',
    entity: 'classification',
    entityId: null,
    changes: { category, level: d.level, levelKey: d.levelKey, role },
    ip: request.ip ?? null,
  })
  // Le message nomme la catégorie et le niveau : sans cela, l'utilisateur ne
  // peut ni comprendre le refus ni savoir à qui demander la levée.
  await reply.status(403).send({
    error: "Cet export est fermé par la grille de classification des données de votre organisation",
    details: { category, level: d.level, levelKey: d.levelKey },
  })
  return true
}

/**
 * Ferme un module de niveau RESTREINT aux rôles que la grille en exclut.
 *
 * Pourquoi un refus et non un masquage : une sanction disciplinaire ou une
 * donnée de santé n'a pas de version « partielle » utile. Servir la fiche
 * d'un salarié avec le motif de sa sanction masqué apprendrait déjà qu'il y a
 * une sanction — ce qui est précisément l'information à protéger.
 *
 * Le refus est un 404 et non un 403 : répondre « interdit » sur une donnée
 * restreinte confirme son existence. C'est la convention déjà retenue pour le
 * hors-périmètre des habilitations dans ce dépôt.
 *
 * Rend `true` quand elle a refusé et déjà envoyé la réponse.
 */
export async function refuserAccesSiRestreint(
  request: FastifyRequest,
  reply: FastifyReply,
  category: CategoryKey,
): Promise<boolean> {
  const schema = request.user.schemaName
  const role = request.user.role
  const d = await decideFor(schema, pool, category, role)
  if (!d.enforced || d.canAccess) return false

  auditTenant(schema, {
    userId: request.user.sub,
    action: 'classification.access_refused',
    entity: 'classification',
    entityId: null,
    changes: { category, level: d.level, levelKey: d.levelKey, role },
    ip: request.ip ?? null,
  })
  await reply.status(404).send({ error: 'Ressource introuvable' })
  return true
}

/**
 * Journalise un accès à une catégorie dont le niveau l'exige.
 *
 * Le niveau 3 et le niveau 4 de la grille standard portent `audit_required` :
 * sans cet appel, le réglage était un affichage. Ne journalise rien quand la
 * grille ne le demande pas — une piste saturée d'entrées sans objet est une
 * piste qu'on ne lit plus.
 */
export async function journaliserAccesClassifie(
  request: FastifyRequest,
  category: CategoryKey,
  details: Record<string, unknown> = {},
): Promise<void> {
  const schema = request.user.schemaName
  const d = await decideFor(schema, pool, category, request.user.role)
  if (!d.enforced || !d.auditRequired || !d.canAccess) return
  auditTenant(schema, {
    userId: request.user.sub,
    action: 'classification.sensitive_access',
    entity: 'classification',
    entityId: null,
    changes: { category, level: d.level, levelKey: d.levelKey, ...details },
    ip: request.ip ?? null,
  })
}
