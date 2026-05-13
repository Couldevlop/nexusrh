/**
 * Workflow paie centralisé multi-sites (Palier 3)
 *
 * Cycle : draft_central → sent_to_sites → completed_by_sites
 *       → validated_central → closed
 *
 * Acteurs :
 *  - Direction centrale (admin / hr_manager) : crée la période globale,
 *    déclenche l'envoi aux sites, valide après retour, clôture.
 *  - RAF site (raf_site) : reçoit le draft scopé sur sa legal_entity,
 *    complète les variables locales, soumet.
 *
 * Hypothèses :
 *  - Activé uniquement pour les tenants `has_subsidiaries=true`. Pour les
 *    autres, le module existant /payroll/periods continue d'être utilisé.
 *  - Une période parente porte legal_entity_id=NULL ; chaque déclinaison
 *    site porte parent_period_id + legal_entity_id + raf_user_id + pack.
 */
import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'
import { LEGISLATION_PACKS } from '../../services/legislation-packs.js'

const pool = new Pool({ connectionString: config.database.url })

/**
 * OWASP A09 — Trace structurée pour chaque transition d'état du workflow
 * paie. Insert dans tenant_schema.audit_log si la table existe (sinon log
 * Pino uniquement). Non-bloquant : un échec audit n'empêche pas l'action.
 */
async function auditWorkflow(opts: {
  schema: string; userId: string; action: string
  entity: string; entityId: string; changes?: Record<string, unknown>
  ipAddress?: string
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO "${opts.schema}".audit_log
         (user_id, action, entity, entity_id, changes, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        opts.userId, opts.action, opts.entity, opts.entityId,
        JSON.stringify(opts.changes ?? {}),
        opts.ipAddress ?? null,
      ],
    )
  } catch {
    // Non-bloquant : tenant pré-migration peut ne pas avoir audit_log
  }
}

type PeriodStatus =
  | 'draft_central'
  | 'sent_to_sites'
  | 'completed_by_site'
  | 'validated_central'
  | 'closed'

const VALID_STATUSES: PeriodStatus[] = [
  'draft_central', 'sent_to_sites', 'completed_by_site',
  'validated_central', 'closed',
]

async function assertMultiCountryTenant(
  schemaName: string,
): Promise<{ hasSubsidiaries: boolean }> {
  const res = await pool.query<{ has_subsidiaries: boolean }>(
    `SELECT has_subsidiaries FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
    [schemaName],
  )
  return { hasSubsidiaries: res.rows[0]?.has_subsidiaries === true }
}

const payrollWorkflowRoutes: FastifyPluginAsync = async (fastify) => {

  // ── GET /payroll-workflow/periods ─────────────────────────────────────────
  // Liste les périodes parentes + leurs déclinaisons site.
  fastify.get('/periods', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'raf_site', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        let sql = `SELECT pp.*, le.name AS legal_entity_name
                     FROM "${schema}".pay_periods pp
                     LEFT JOIN "${schema}".legal_entities le ON le.id = pp.legal_entity_id`
        const params: unknown[] = []
        // Un RAF site ne voit que les périodes de son entité
        if (request.user.role === 'raf_site') {
          sql += ` WHERE pp.raf_user_id = $1`
          params.push(request.user.sub)
        }
        sql += ` ORDER BY pp.month DESC, pp.parent_period_id NULLS FIRST, pp.created_at`
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll-workflow/periods ────────────────────────────────────────
  // Direction centrale crée la période parente (un seul appel par mois global).
  fastify.post('/periods', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { hasSubsidiaries } = await assertMultiCountryTenant(schema)
      if (!hasSubsidiaries) {
        return reply.status(400).send({
          error: 'Ce tenant n\'a pas activé la gestion multi-pays. ' +
                 'Utilisez /payroll/periods pour une paie mono-pays.',
        })
      }
      const body = request.body as { month: string }
      if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
        return reply.status(400).send({ error: 'month requis au format YYYY-MM' })
      }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".pay_periods
            (month, status, parent_period_id, legal_entity_id)
          VALUES ($1, 'draft_central', NULL, NULL)
          ON CONFLICT (month) WHERE parent_period_id IS NULL DO NOTHING
          RETURNING *
        `, [body.month])
        if (!res.rows[0]) {
          return reply.status(409).send({ error: 'Période parente déjà existante pour ce mois' })
        }
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/send-to-sites ──────────────────────
  // La direction centrale décline le draft global vers chaque filiale.
  // Body : [{ legalEntityId, rafUserId, legislationPackCode }]
  fastify.post('/periods/:id/send-to-sites', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const { sites } = request.body as {
        sites: Array<{ legalEntityId: string; rafUserId: string; legislationPackCode: string }>
      }
      if (!Array.isArray(sites) || sites.length === 0) {
        return reply.status(400).send({ error: 'Aucun site à déclencher (sites: [])' })
      }
      // Validation des packs
      for (const s of sites) {
        if (!LEGISLATION_PACKS[s.legislationPackCode]) {
          return reply.status(400).send({
            error: `Pack législatif inconnu : ${s.legislationPackCode}`,
          })
        }
      }
      try {
        const parent = await pool.query<{ month: string; status: string }>(
          `SELECT month, status FROM "${schema}".pay_periods WHERE id = $1 AND parent_period_id IS NULL`,
          [id],
        )
        if (!parent.rows[0]) {
          return reply.status(404).send({ error: 'Période parente introuvable' })
        }
        if (parent.rows[0].status !== 'draft_central') {
          return reply.status(409).send({
            error: `Période non éligible (status=${parent.rows[0].status}, attendu=draft_central)`,
          })
        }

        const month = parent.rows[0].month
        const created: unknown[] = []
        for (const s of sites) {
          const childRes = await pool.query(`
            INSERT INTO "${schema}".pay_periods
              (month, status, parent_period_id, legal_entity_id,
               legislation_pack_code, raf_user_id, sent_to_sites_at)
            VALUES ($1, 'sent_to_sites', $2, $3, $4, $5, now())
            RETURNING *
          `, [month, id, s.legalEntityId, s.legislationPackCode, s.rafUserId])
          created.push(childRes.rows[0])
        }

        await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'sent_to_sites', sent_to_sites_at = now()
           WHERE id = $1`,
          [id],
        )

        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.send_to_sites', entity: 'pay_period', entityId: id,
          changes: { sitesCount: sites.length },
          ipAddress: request.ip,
        })

        return reply.status(201).send({ data: { parent: id, sites: created } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/submit-by-raf ──────────────────────
  // Le RAF du site marque sa période comme complétée (variables locales saisies).
  fastify.post('/periods/:id/submit-by-raf', {
    preHandler: [fastify.authorize('raf_site', 'admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const periodRes = await pool.query<{
          status: string; raf_user_id: string | null; parent_period_id: string | null
        }>(
          `SELECT status, raf_user_id, parent_period_id FROM "${schema}".pay_periods WHERE id = $1`,
          [id],
        )
        const period = periodRes.rows[0]
        if (!period) return reply.status(404).send({ error: 'Période introuvable' })
        if (!period.parent_period_id) {
          return reply.status(400).send({ error: 'Seules les périodes filles peuvent être soumises par un RAF' })
        }
        if (request.user.role === 'raf_site' && period.raf_user_id !== request.user.sub) {
          return reply.status(403).send({ error: 'Vous n\'êtes pas le RAF de cette filiale' })
        }
        if (period.status !== 'sent_to_sites') {
          return reply.status(409).send({
            error: `Période non éligible (status=${period.status}, attendu=sent_to_sites)`,
          })
        }
        const upd = await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'completed_by_site', completed_by_site_at = now()
           WHERE id = $1 RETURNING *`,
          [id],
        )
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.submit_by_raf', entity: 'pay_period', entityId: id,
          ipAddress: request.ip,
        })
        return reply.send({ data: upd.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/validate-central ───────────────────
  // Direction centrale valide la période parente une fois tous les sites
  // remontés en completed_by_site. Verrouille le passage à 'closed'.
  fastify.post('/periods/:id/validate-central', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const parent = await pool.query<{
          status: string; parent_period_id: string | null
        }>(
          `SELECT status, parent_period_id FROM "${schema}".pay_periods WHERE id = $1`,
          [id],
        )
        if (!parent.rows[0]) return reply.status(404).send({ error: 'Période introuvable' })
        if (parent.rows[0].parent_period_id) {
          return reply.status(400).send({ error: 'La validation s\'applique à la période parente' })
        }
        // Vérifier que toutes les filles sont completed_by_site
        const children = await pool.query<{ status: string }>(
          `SELECT status FROM "${schema}".pay_periods WHERE parent_period_id = $1`,
          [id],
        )
        const pending = children.rows.filter(r => r.status !== 'completed_by_site')
        if (pending.length > 0) {
          return reply.status(409).send({
            error: `${pending.length} site(s) n'ont pas encore soumis leur draft (status attendu: completed_by_site)`,
          })
        }

        await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'validated_central', validated_central_at = now(), validated_by = $1
           WHERE id = $2 OR parent_period_id = $2`,
          [request.user.sub, id],
        )
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.validate_central', entity: 'pay_period', entityId: id,
          changes: { sitesCount: children.rows.length },
          ipAddress: request.ip,
        })
        return reply.send({ data: { id, status: 'validated_central' } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll-workflow/periods/:id/close ──────────────────────────────
  // Clôture finale après génération bulletins. Statut terminal.
  fastify.post('/periods/:id/close', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const parent = await pool.query<{ status: string }>(
          `SELECT status FROM "${schema}".pay_periods WHERE id = $1 AND parent_period_id IS NULL`,
          [id],
        )
        if (!parent.rows[0]) return reply.status(404).send({ error: 'Période parente introuvable' })
        if (parent.rows[0].status !== 'validated_central') {
          return reply.status(409).send({
            error: `Période non éligible à clôture (status=${parent.rows[0].status}, attendu=validated_central)`,
          })
        }
        await pool.query(
          `UPDATE "${schema}".pay_periods
             SET status = 'closed', closed_at = now(), closed_by = $1
           WHERE id = $2 OR parent_period_id = $2`,
          [String(request.user.sub), id],
        )
        await auditWorkflow({
          schema, userId: request.user.sub,
          action: 'workflow.close', entity: 'pay_period', entityId: id,
          ipAddress: request.ip,
        })
        return reply.send({ data: { id, status: 'closed' } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll-workflow/statuses (referenceval) ────────────────────────
  fastify.get('/statuses', {
    preHandler: [fastify.authenticate],
    handler: async (_req, reply) => reply.send({ data: VALID_STATUSES }),
  })
}

export default payrollWorkflowRoutes
