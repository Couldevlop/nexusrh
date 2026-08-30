/**
 * Réponses d'erreur HTTP normalisées — implémentation UNIQUE.
 *
 * Onze fichiers de routes déclaraient chacun leur propre `badRequest()`, au
 * corps rigoureusement identique. Les variantes avaient déjà commencé à diverger
 * (message par défaut présent ici, obligatoire là), ce qui produisait des
 * réponses subtilement différentes pour la même situation métier selon le
 * module appelé. Une seule définition supprime cette dérive.
 */
import type { FastifyReply } from 'fastify'
import type { z } from 'zod'

/** 400 — requête invalide, avec un message métier rédigé en français. */
export function badRequest(reply: FastifyReply, msg = 'Validation échouée') {
  return reply.status(400).send({ error: msg })
}

/**
 * 400 — échec de validation Zod, avec le détail champ par champ.
 * Le client peut ainsi surligner les champs fautifs plutôt que d'afficher un
 * message global (OWASP A09 : aucun détail technique n'est divulgué, seuls le
 * chemin du champ et le message de validation le sont).
 */
export function badRequestFromZod(reply: FastifyReply, err: z.ZodError) {
  return reply.status(400).send({
    error: 'Validation échouée',
    details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  })
}
