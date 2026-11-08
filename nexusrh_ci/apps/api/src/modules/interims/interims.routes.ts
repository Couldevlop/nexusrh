/**
 * Intérims de validation — déclarer qui remplace qui pendant un congé.
 *
 * Le besoin (07/11/2026) : les congés des membres de l'équipe RH et des
 * responsables arrêtaient le circuit de validation. Seul le valideur de
 * l'étape pouvait agir ; à l'étape RH, l'équipe devait attendre que
 * l'échéance soit dépassée. Une semaine de congés du DRH, et tout le service
 * attendait son retour.
 *
 * CE N'EST PAS UNE DÉLÉGATION D'HABILITATION (`hab_delegations`). Les deux
 * objets se ressemblent de loin et n'ont ni le même fondement ni le même
 * effet ; les confondre reviendrait à faire signer au DRH une procuration
 * pour que son équipe traite les congés pendant le sien.
 *
 *  | | Délégation d'habilitation | Intérim de validation |
 *  |---|---|---|
 *  | Fondement | acte VOLONTAIRE du titulaire, qui cède son propre droit | CONTINUITÉ D'UN POSTE, décidée par l'organisation (admin/DRH), y compris pendant que l'intéressé est déjà parti |
 *  | Origine | aucune : on délègue quand on veut | le CONGÉ DÉJÀ SAISI : `absenceId` fournit les bornes, on ne retape pas les dates |
 *  | Objet transmis | droit de RÉDIGER une fiche d'habilitation | pouvoir de DÉCIDER à une étape de circuit (congés, notes de frais) |
 *  | Périmètre | plafonné par sous-groupe du délégant | l'étape où l'absent était valideur, et rien d'autre |
 *  | Sans acte déclaré | rien : pas de délégation, pas de droit | le circuit continue quand même — une absence CONSTATÉE ouvre l'étape au niveau SUPÉRIEUR et à l'équipe RH |
 *  | Durée | 90 jours | 180 jours (un congé de maternité dure 98 jours) |
 *
 * L'intérim ne crée AUCUN droit nouveau : le suppléant agit là où l'absent
 * était le valideur désigné (son étape hiérarchique, ou l'étape RH quand c'est
 * lui le valideur désigné), et nulle part ailleurs. Quatre bornes, toutes
 * appliquées côté serveur :
 *
 *  1. **Durée.** La période vient du congé (`absenceId`) ou, à défaut, de
 *     `endsAt` ; dans le futur, 180 jours au plus — un congé de maternité
 *     dure 98 jours, mais l'intérim reste borné et relu.
 *  2. **Comptes réels.** Remplacé et suppléant sont des utilisateurs ACTIFS du
 *     tenant ; un compte désactivé ne tient pas un intérim.
 *  3. **Pas de chaîne.** Un suppléant ne se fait pas remplacer à son tour, et
 *     on ne désigne pas comme suppléant quelqu'un qui est lui-même remplacé :
 *     la trace resterait lisible, mais plus personne ne saurait qui répond de
 *     la décision.
 *  4. **Pas de doublon actif.** Deux intérims en cours pour le même absent
 *     brouillent la responsabilité : le second est refusé.
 *
 * SÉCURITÉ : OWASP A01 (déclaration et révocation réservées à l'admin du
 * tenant et au DRH ; la lecture est ouverte aux rôles RH et à l'intéressé),
 * A03 (Zod, UUID validés, nom de schéma validé avant interpolation), A09
 * (chaque création et chaque révocation sont auditées ; aucune donnée
 * personnelle journalisée, seulement des identifiants et des dates).
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { auditTenant } from '../../utils/audit-log.js'
import { badRequest, badRequestFromZod } from '../../utils/http-errors.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { assertValidSchemaName } from '../../utils/schema-name.js'
import { isUuid } from '../../services/habilitation.service.js'

/** Plafond de durée d'un intérim, en jours. */
export const MAX_INTERIM_DAYS = 180

/** Rôles qui déclarent et révoquent un intérim (décision d'organisation). */
const MANAGE_ROLES = ['admin', 'hr_manager'] as const
/** Rôles qui consultent la liste des intérims du tenant. */
const READ_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const

const PG_UNDEFINED_TABLE = '42P01'
const PG_UNDEFINED_COLUMN = '42703'
function isMissingSchemaObject(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === PG_UNDEFINED_TABLE || code === PG_UNDEFINED_COLUMN
}

const createSchema = z.object({
  absentUserId:  z.string(),
  interimUserId: z.string(),
  /** Congé d'origine : ses dates deviennent celles de l'intérim. */
  absenceId:     z.string().optional(),
  endsAt:        z.string().min(1).optional(),
  startsAt:      z.string().min(1).optional(),
  reason:        z.string().max(200).optional(),
}).strict()

/**
 * Rôles qui portent une étape de validation : ce sont leurs congés qui
 * arrêtent un circuit, donc eux seuls que l'écran de couverture surveille.
 */
const VALIDATOR_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'dg'] as const

const interimsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  /**
   * Intérims du tenant (en cours et passés). Lecture RH ; chaque utilisateur
   * voit en plus ceux qui le concernent, pour savoir ce qu'on attend de lui.
   */
  fastify.get('/interims', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['interims'], summary: 'Intérims de validation du tenant' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      assertValidSchemaName(schema)
      const isRh = (READ_ROLES as readonly string[]).includes(request.user.role)
      try {
        const res = await pool.query(
          `SELECT i.id::text AS id,
                  i.absent_user_id::text  AS "absentUserId",
                  i.interim_user_id::text AS "interimUserId",
                  ua.first_name || ' ' || ua.last_name AS "absentName",
                  ui.first_name || ' ' || ui.last_name AS "interimName",
                  ua.role AS "absentRole", ui.role AS "interimRole",
                  i.starts_at AS "startsAt", i.ends_at AS "endsAt",
                  i.reason, i.revoked_at AS "revokedAt",
                  i.absence_id::text AS "absenceId",
                  (CASE WHEN i.absence_id IS NULL THEN 'manual' ELSE 'absence' END) AS source,
                  (i.revoked_at IS NULL AND now() BETWEEN i.starts_at AND i.ends_at) AS active
             FROM "${schema}".approval_interims i
             LEFT JOIN "${schema}".users ua ON ua.id = i.absent_user_id
             LEFT JOIN "${schema}".users ui ON ui.id = i.interim_user_id
            WHERE $2::boolean OR i.absent_user_id = $1 OR i.interim_user_id = $1
            ORDER BY active DESC, i.ends_at DESC
            LIMIT 200`,
          [request.user.sub, isRh],
        )
        return reply.send({ data: res.rows })
      } catch (err) {
        // Tenant provisionné avant ce module : aucun intérim, pas une panne.
        if (isMissingSchemaObject(err)) return reply.send({ data: [] })
        throw err
      }
    },
  })

  /**
   * Congés des VALIDEURS, et lequel n'a personne derrière lui.
   *
   * C'est la question que posait la direction : « comment gérer les congés des
   * membres des équipes RH pour assurer la continuité ? ». La réponse n'est pas
   * une liste d'intérims — elle est ici : les absences à venir ou en cours des
   * personnes qui portent une étape de validation, avec un drapeau `covered`
   * indiquant si une suppléance les recouvre. Les non couvertes d'abord : ce
   * sont les circuits qui vont s'arrêter.
   *
   * Aucune délégation d'habilitation n'a d'écran équivalent, et pour cause :
   * elle ne part pas d'un congé.
   */
  fastify.get('/interims/coverage', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['interims'], summary: 'Congés des valideurs et leur couverture' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      assertValidSchemaName(schema)
      try {
        const res = await pool.query(
          `SELECT a.id::text AS "absenceId", a.start_date AS "startDate", a.end_date AS "endDate",
                  a.status,
                  u.id::text AS "userId", u.role,
                  u.first_name || ' ' || u.last_name AS name,
                  EXISTS (
                    SELECT 1 FROM "${schema}".approval_interims i
                     WHERE i.absent_user_id = u.id
                       AND i.revoked_at IS NULL
                       AND i.starts_at <= (a.end_date + 1)::timestamptz
                       AND i.ends_at   >= a.start_date::timestamptz
                  ) AS covered
             FROM "${schema}".absences a
             JOIN "${schema}".users u ON u.employee_id = a.employee_id
            WHERE a.status IN ('pending', 'approved')
              AND a.end_date >= current_date
              AND u.is_active = true
              AND u.role = ANY($1::text[])
            ORDER BY covered ASC, a.start_date ASC
            LIMIT 100`,
          [[...VALIDATOR_ROLES]],
        )
        return reply.send({ data: res.rows })
      } catch (err) {
        if (isMissingSchemaObject(err)) return reply.send({ data: [] })
        throw err
      }
    },
  })

  fastify.post('/interims', {
    preHandler: [fastify.authorize(...MANAGE_ROLES)],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['interims'], summary: 'Déclarer un intérim de validation' },
    handler: async (request, reply) => {
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const { absentUserId, interimUserId, absenceId, endsAt, startsAt, reason } = parsed.data
      const schema = request.user.schemaName
      assertValidSchemaName(schema)

      if (!isUuid(absentUserId) || !isUuid(interimUserId)) return badRequest(reply, 'Identifiant invalide')
      if (absentUserId === interimUserId) {
        return badRequest(reply, 'Le suppléant ne peut pas être la personne remplacée')
      }
      if (absenceId && !isUuid(absenceId)) return badRequest(reply, 'Identifiant de congé invalide')
      if (!absenceId && !endsAt) {
        return badRequest(reply, 'Indiquez le congé à couvrir, ou à défaut une date de fin')
      }

      // ADOSSEMENT AU CONGÉ : quand le congé est désigné, ses dates FONT la
      // période d'intérim. Personne ne retape des dates déjà saisies, et la
      // suppléance ne peut pas déborder le congé qu'elle couvre. C'est ce qui
      // distingue l'intérim d'une délégation, qui n'a aucun congé pour borne.
      let coveredAbsence: { id: string; start: Date; end: Date } | null = null
      if (absenceId) {
        try {
          const abs = await pool.query<{ id: string; start_date: string; end_date: string; status: string }>(
            `SELECT a.id::text AS id, a.start_date, a.end_date, a.status
               FROM "${schema}".absences a
               JOIN "${schema}".users u ON u.employee_id = a.employee_id
              WHERE a.id = $1 AND u.id = $2`,
            [absenceId, absentUserId],
          )
          const row = abs.rows[0]
          if (!row) return badRequest(reply, 'Ce congé n’est pas celui de la personne remplacée')
          if (row.status === 'rejected' || row.status === 'cancelled') {
            return badRequest(reply, 'Ce congé est refusé ou annulé : il n’y a rien à couvrir')
          }
          // Le congé se compte en JOURS : la suppléance couvre le dernier jour
          // entier, pas jusqu'à minuit de son matin.
          const end = new Date(`${row.end_date}T23:59:59.999Z`)
          if (end.getTime() <= Date.now()) {
            return badRequest(reply, 'Ce congé est terminé : un intérim ne se déclare pas après coup')
          }
          coveredAbsence = { id: row.id, start: new Date(`${row.start_date}T00:00:00.000Z`), end }
        } catch (err) {
          if (!isMissingSchemaObject(err)) throw err
          return reply.status(503).send({ error: 'Module indisponible : schéma non migré' })
        }
      }

      const end = coveredAbsence ? coveredAbsence.end : new Date(endsAt!)
      if (Number.isNaN(end.getTime())) return badRequest(reply, 'Date de fin invalide')
      const start = coveredAbsence
        ? coveredAbsence.start
        : (startsAt ? new Date(startsAt) : new Date())
      if (Number.isNaN(start.getTime())) return badRequest(reply, 'Date de début invalide')
      if (end.getTime() <= Date.now()) return badRequest(reply, 'La date de fin doit être dans le futur')
      if (end.getTime() <= start.getTime()) {
        return badRequest(reply, 'La date de fin doit suivre la date de début')
      }
      if (end.getTime() - start.getTime() > MAX_INTERIM_DAYS * 24 * 3600 * 1000) {
        return badRequest(reply, `Un intérim dure ${MAX_INTERIM_DAYS} jours au plus`)
      }

      try {
        // Les deux comptes existent, sont actifs, et appartiennent au tenant.
        const users = await pool.query<{ id: string }>(
          `SELECT id::text AS id FROM "${schema}".users
            WHERE id = ANY($1::uuid[]) AND is_active = true`,
          [[absentUserId, interimUserId]],
        )
        if (users.rows.length !== 2) {
          return badRequest(reply, 'Le remplacé et le suppléant doivent être des utilisateurs actifs du tenant')
        }

        // Pas de chaîne d'intérims, et pas deux intérims actifs pour le même
        // absent : dans les deux cas, plus personne ne répond de la décision.
        const conflicts = await pool.query<{ absent_user_id: string; interim_user_id: string }>(
          `SELECT absent_user_id::text AS absent_user_id, interim_user_id::text AS interim_user_id
             FROM "${schema}".approval_interims
            WHERE revoked_at IS NULL AND now() < ends_at
              AND (absent_user_id = ANY($1::uuid[]) OR interim_user_id = ANY($1::uuid[]))`,
          [[absentUserId, interimUserId]],
        )
        for (const row of conflicts.rows) {
          if (row.absent_user_id === absentUserId) {
            return badRequest(reply, 'Cette personne a déjà un intérim en cours : révoquez-le d’abord')
          }
          if (row.absent_user_id === interimUserId) {
            return badRequest(reply, 'Le suppléant est lui-même remplacé en ce moment')
          }
          if (row.interim_user_id === absentUserId) {
            return badRequest(reply, 'La personne remplacée assure déjà l’intérim de quelqu’un : un intérim ne se délègue pas en chaîne')
          }
        }

        const res = await pool.query<{ id: string }>(
          `INSERT INTO "${schema}".approval_interims
             (absent_user_id, interim_user_id, starts_at, ends_at, reason, created_by, absence_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id::text AS id`,
          [absentUserId, interimUserId, start.toISOString(), end.toISOString(), reason ?? null,
           request.user.sub, coveredAbsence?.id ?? null],
        )
        const id = res.rows[0]!.id
        auditTenant(schema, {
          userId: request.user.sub, action: 'interim.created', entity: 'interim', entityId: id,
          changes: {
            absentUserId, interimUserId,
            startsAt: start.toISOString(), endsAt: end.toISOString(),
            // D'où viennent les bornes : le congé, ou une saisie manuelle.
            source: coveredAbsence ? 'absence' : 'manual', absenceId: coveredAbsence?.id ?? null,
          },
          ip: request.ip ?? null,
        })
        return reply.status(201).send({
          data: {
            id, startsAt: start.toISOString(), endsAt: end.toISOString(),
            source: coveredAbsence ? 'absence' : 'manual',
          },
        })
      } catch (err) {
        if (isMissingSchemaObject(err)) {
          return reply.status(503).send({ error: 'Module indisponible : schéma non migré' })
        }
        throw err
      }
    },
  })

  /** Révoquer un intérim : il cesse immédiatement, sans attendre son terme. */
  fastify.delete('/interims/:id', {
    preHandler: [fastify.authorize(...MANAGE_ROLES)],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['interims'], summary: 'Révoquer un intérim de validation' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const schema = request.user.schemaName
      assertValidSchemaName(schema)
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      try {
        const res = await pool.query<{ id: string }>(
          `UPDATE "${schema}".approval_interims
              SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING id::text AS id`,
          [id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Intérim introuvable ou déjà révoqué' })
        auditTenant(schema, {
          userId: request.user.sub, action: 'interim.revoked', entity: 'interim', entityId: id,
          changes: {}, ip: request.ip ?? null,
        })
        return reply.send({ data: { id } })
      } catch (err) {
        if (isMissingSchemaObject(err)) return reply.status(404).send({ error: 'Intérim introuvable' })
        throw err
      }
    },
  })
}

export default interimsRoutes
