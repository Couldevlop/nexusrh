import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { describeDbError } from '../../utils/db-error.js'
import { auditTenant } from '../../utils/audit-log.js'
import { isSelfAction, isUuid, SELF_ACTION_ERROR } from '../../services/habilitation.service.js'
import { requestHrScope, requestEmployeeScope, employeeInHrScope, requestSensitiveCtx } from '../../utils/hr-scope.js'
import { maskSensitive, maskSensitiveRows } from '../../services/sensitive-mask.js'
import { loadEmployeeTenantContext } from '../../services/employee-tenant-context.service.js'
import { DEFAULT_LEGISLATION_PACK, type LegislationPack } from '../../services/legislation-packs.js'

// OWASP A03 — validation stricte du body POST /contracts (whitelist de champs
// et types). Rejette les types inattendus et les enums hors liste légale OHADA/CI.
const CONTRACT_TYPES = ['cdi', 'cdd', 'saisonnier', 'apprentissage', 'stage', 'mise_a_disposition'] as const
const createContractSchema = z.object({
  employee_id:             z.string().uuid(),
  type:                    z.enum(CONTRACT_TYPES),
  start_date:              z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD requis'),
  end_date:                z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  trial_end_date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  base_salary:             z.number().int().nonnegative().max(100_000_000),
  working_hours:           z.number().int().min(1).max(80).optional(),
  convention:              z.string().max(200).optional(),
  job_title:               z.string().max(200).optional(),
  job_level:               z.string().max(50).optional(),
  cnps_affiliation:        z.boolean().optional(),
  ohada_clause:            z.boolean().optional(),
  non_competition_clause:  z.boolean().optional(),
  telecommuting_days:      z.number().int().min(0).max(7).optional(),
})
  // Un contrat à durée déterminée SANS terme est irrégulier (art. 15.4 CT CI) :
  // la base en portait pourtant, `end_date` n'étant qu'`optional()`. Le terme
  // est exigé pour tous les contrats à durée déterminée, et jamais antérieur au
  // début. La durée maximale, elle, dépend du pays : elle est vérifiée dans le
  // handler, où le pack du tenant est accessible.
  .superRefine((c, ctx) => {
    if (FIXED_TERM_TYPES.includes(c.type) && !c.end_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['end_date'],
        message: `Un contrat ${c.type.toUpperCase()} doit porter une date de fin (terme)`,
      })
    }
    if (c.end_date && c.end_date <= c.start_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['end_date'],
        message: 'La date de fin doit être postérieure à la date de début',
      })
    }
  })

// OWASP A03 — le renouvellement lisait son corps sans aucune validation
// (`request.body as {…}`) : ni format de date, ni borne de salaire.
const renewContractSchema = z.object({
  new_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD requis'),
  base_salary:  z.number().int().positive().max(100_000_000).optional(),
})

/** Types de contrats à terme : une date de fin y est constitutive. */
const FIXED_TERM_TYPES: readonly string[] = ['cdd', 'saisonnier', 'apprentissage', 'stage', 'mise_a_disposition']

/**
 * Pack législatif du pays du tenant — résolu UNE fois par requête (durée du
 * CDD, renouvellements, période d'essai en dépendent). Repli sur le pack par
 * défaut si la lecture échoue : jamais d'exception sur un chemin de création.
 *
 * Une règle absente du pack n'est PAS appliquée : on ne transpose pas le droit
 * ivoirien aux quinze autres pays couverts.
 */
async function tenantPack(schema: string): Promise<LegislationPack> {
  try {
    const ctx = await loadEmployeeTenantContext(pool, schema, null)
    return ctx.legislation.legislationPack
  } catch {
    return DEFAULT_LEGISLATION_PACK
  }
}

/** Mois entiers écoulés entre deux dates ISO, arrondis au mois commencé. */
function monthsBetween(startIso: string, endIso: string): number {
  const [sy, sm, sd] = startIso.split('-').map(Number) as [number, number, number]
  const [ey, em, ed] = endIso.split('-').map(Number) as [number, number, number]
  const months = (ey - sy) * 12 + (em - sm)
  // Un terme au 31/12/2027 pour un début au 01/01/2026 fait 24 mois, pas 23 :
  // le jour de fin complète le dernier mois dès qu'il atteint la veille.
  return ed >= sd - 1 ? months : months - 1
}

function auditLogContract(
  schema: string, userId: string, action: string,
  contractId: string, changes: Record<string, unknown>, ip: string | null,
): void {
  auditTenant(schema, { userId: userId, action: action, entity: 'contract', entityId: contractId, changes: changes, ip: ip })
}

/** Salarié titulaire d'un contrat (SELECT minimal) pour la garde « propre dossier ». */
async function contractOwner(schema: string, id: string, scope: string): Promise<string | null> {
  const r = await pool.query<{ employee_id: string | null }>(
    `SELECT employee_id FROM "${schema}".contracts WHERE id = $1 AND ${scope}`, [id])
  return r.rows[0]?.employee_id ?? null
}

const contractsRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /contracts — liste tous les contrats du tenant
  fastify.get('/', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { status, employee_id, type } = request.query as {
        status?: string; employee_id?: string; type?: string
      }
      try {
        // Périmètre filiale (habilitations) sur l'employé titulaire.
        const conditions: string[] = [await requestHrScope(request, 'e')]
        const values: unknown[] = []
        if (status)      { conditions.push(`c.status = $${values.length + 1}`);      values.push(status) }
        if (employee_id) { conditions.push(`c.employee_id = $${values.length + 1}`); values.push(employee_id) }
        if (type)        { conditions.push(`c.type = $${values.length + 1}`);        values.push(type) }

        // NB : on NE filtre PAS sur e.deleted_at — un contrat dont l'employé a été
        // archivé doit rester visible (en statut « terminated », via la cascade de
        // rupture à l'archivage) pour consultation dans l'archive, au lieu de
        // disparaître silencieusement. `employee_archived` permet à l'UI de le baliser.
        const res = await pool.query(`
          SELECT c.*,
            e.first_name, e.last_name, e.employee_number AS registration_number,
            e.job_title AS current_job_title,
            (e.deleted_at IS NOT NULL) AS employee_archived,
            d.name AS department_name
          FROM "${schema}".contracts c
          JOIN "${schema}".employees e ON e.id = c.employee_id
          LEFT JOIN "${schema}".departments d ON d.id = e.department_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY c.created_at DESC
        `, values)
        return reply.send({ data: maskSensitiveRows(res.rows, await requestSensitiveCtx(request)) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /contracts/:id — détail d'un contrat
  fastify.get('/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const res = await pool.query(`
          SELECT c.*,
            e.first_name, e.last_name, e.employee_number AS registration_number,
            e.cnps_number AS employee_cnps, e.mobile_money_provider, e.mobile_money_phone AS mobile_money_number,
            (e.deleted_at IS NOT NULL) AS employee_archived,
            d.name AS department_name
          FROM "${schema}".contracts c
          JOIN "${schema}".employees e ON e.id = c.employee_id
          LEFT JOIN "${schema}".departments d ON d.id = e.department_id
          WHERE c.id = $1 AND ${await requestHrScope(request, 'e')}
        `, [id])
        if (!res.rows[0]) return reply.status(404).send({ error: 'Contrat introuvable' })
        return reply.send({ data: maskSensitive(res.rows[0], await requestSensitiveCtx(request)) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /contracts — créer un contrat OHADA
  fastify.post('/', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 : validation stricte du body, rejette champs arbitraires
      const parsed = createContractSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données de contrat invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      if (isSelfAction(request, body.employee_id)) return reply.status(403).send({ error: SELF_ACTION_ERROR })
      // Pack du pays : durée maximale du contrat à terme, puis période d'essai.
      const pack = await tenantPack(schema)
      if (body.end_date && FIXED_TERM_TYPES.includes(body.type)) {
        const rule = pack.fixedTermContract
        if (rule && monthsBetween(body.start_date, body.end_date) > rule.maxMonths) {
          return reply.status(400).send({
            error: `Un contrat à durée déterminée ne peut excéder ${rule.maxMonths} mois (${rule.maxMonths / 12} ans), renouvellements compris`,
          })
        }
      }
      try {
        // Périmètre filiale : l'employé visé doit être dans le périmètre (sinon 404).
        const empScope = await requestHrScope(request, 'employees')
        if (!(await employeeInHrScope(schema, body.employee_id, await requestHrScope(request, 'e')))) {
          return reply.status(404).send({ error: 'Employé introuvable' })
        }
        // Fin de période d'essai calculée d'après le PACK du pays du tenant
        // (CI : 15 jours employé / 1 mois cadre, art. 14 CT). Les 15 et 30
        // jours étaient écrits en dur : faux pour les quinze autres pays
        // couverts. Un pack sans règle d'essai ne calcule rien — la valeur
        // saisie fait foi.
        let trialEndDate = body.trial_end_date || null
        if (!trialEndDate && body.start_date) {
          const trial = pack.trialPeriodDays
          if (trial) {
            const isExecutive = /cadre|executive|manager/i.test(body.job_level ?? '')
            const trialEnd = new Date(body.start_date)
            trialEnd.setDate(trialEnd.getDate() + (isExecutive ? trial.executive : trial.employee))
            trialEndDate = trialEnd.toISOString().split('T')[0]!
          }
        }

        const res = await pool.query(`
          INSERT INTO "${schema}".contracts
            (employee_id, type, start_date, end_date, trial_end_date, base_salary,
             working_hours, convention, job_title, job_level, cnps_affiliation,
             ohada_clause, non_competition_clause, telecommuting_days, status, renewal_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',0)
          RETURNING *
        `, [
          body.employee_id, body.type, body.start_date, body.end_date || null,
          trialEndDate, body.base_salary, body.working_hours || 40,
          body.convention || null, body.job_title || null, body.job_level || null,
          body.cnps_affiliation ?? true, body.ohada_clause ?? true,
          body.non_competition_clause ?? false, body.telecommuting_days || 0,
        ])

        // Met à jour le salaire de base de l'employé
        await pool.query(
          `UPDATE "${schema}".employees SET base_salary = $1, job_title = COALESCE($2, job_title), updated_at = now() WHERE id = $3 AND ${empScope}`,
          [body.base_salary, body.job_title || null, body.employee_id]
        )

        // OWASP A09 : trace de la création (employé concerné, type, salaire)
        auditLogContract(schema, request.user.sub, 'contract.created', res.rows[0].id, {
          employeeId: body.employee_id,
          type: body.type,
          startDate: body.start_date,
          // Jamais la valeur du salaire dans l'audit : uniquement les noms de champs.
          changedFields: ['baseSalary'],
        }, request.ip ?? null)

        return reply.status(201).send({ data: maskSensitive(res.rows[0], await requestSensitiveCtx(request)) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /contracts/:id — modifier un contrat
  fastify.patch('/:id', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return reply.status(400).send({ error: 'Identifiant de contrat invalide' })
      const body = request.body as Record<string, unknown>
      const allowed = ['end_date', 'trial_end_date', 'base_salary', 'working_hours',
        'convention', 'job_title', 'job_level', 'status', 'non_competition_clause',
        'telecommuting_days', 'signature_status', 'file_url', 'ohada_clause']
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of allowed) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(body[f]) }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        const scope = await requestEmployeeScope(request, 'contracts.employee_id')
        const own = await contractOwner(schema, id, scope)
        if (own && isSelfAction(request, own)) return reply.status(403).send({ error: SELF_ACTION_ERROR })
        const res = await pool.query(
          `UPDATE "${schema}".contracts SET ${updates.join(', ')} WHERE id = $${values.length} AND ${scope} RETURNING *`,
          values
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Contrat introuvable' })
        return reply.send({ data: maskSensitive(res.rows[0], await requestSensitiveCtx(request)) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /contracts/:id/terminate — rupture contrat
  fastify.post('/:id/terminate', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as {
        termination_date: string
        termination_reason: 'resignation' | 'dismissal' | 'conventional' | 'end_of_cdd' | 'retirement' | 'other'
        notice_days?: number
        comment?: string
      }
      if (!isUuid(id)) return reply.status(400).send({ error: 'Identifiant de contrat invalide' })
      try {
        const scope = await requestEmployeeScope(request, 'contracts.employee_id')
        const own = await contractOwner(schema, id, scope)
        if (own && isSelfAction(request, own)) return reply.status(403).send({ error: SELF_ACTION_ERROR })
        const res = await pool.query(`
          UPDATE "${schema}".contracts
          SET status = 'terminated', end_date = $1, updated_at = now()
          WHERE id = $2 AND ${scope}
          RETURNING employee_id
        `, [body.termination_date, id])
        if (!res.rows[0]) return reply.status(404).send({ error: 'Contrat introuvable' })

        // Désactiver l'employé
        await pool.query(
          `UPDATE "${schema}".employees SET is_active = false, updated_at = now() WHERE id = $1`,
          [res.rows[0].employee_id]
        )
        // Enregistrer l'événement RH
        await pool.query(`
          INSERT INTO "${schema}".hr_events
            (employee_id, type, title, description, date)
          VALUES ($1,'termination',$2,$3,$4)
        `, [
          res.rows[0].employee_id,
          `Fin de contrat — ${body.termination_reason}`,
          body.comment || `Motif : ${body.termination_reason}. Préavis : ${body.notice_days || 0} jours.`,
          body.termination_date,
        ])

        // OWASP A09 : la rupture de contrat est un événement critique (statut
        // emploi, conséquences RGPD/CNPS). Trace obligatoire.
        auditLogContract(schema, request.user.sub, 'contract.terminated', id, {
          employeeId: res.rows[0].employee_id,
          terminationDate: body.termination_date,
          reason: body.termination_reason,
          noticeDays: body.notice_days ?? null,
        }, request.ip ?? null)

        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error({ err, contractId: id, action: 'contract.terminate' }, 'Échec rupture de contrat')
        const mapped = describeDbError(err, { entity: 'contrat' })
        if (mapped) return reply.status(mapped.statusCode).send({ error: mapped.error, code: mapped.code })
        return reply.status(500).send({
          error: 'Impossible de rompre le contrat pour le moment. Réessayez ou contactez le support.',
        })
      }
    },
  })

  // POST /contracts/:id/renew — renouvellement CDD
  fastify.post('/:id/renew', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return reply.status(400).send({ error: 'Identifiant de contrat invalide' })
      const parsedRenew = renewContractSchema.safeParse(request.body)
      if (!parsedRenew.success) {
        return reply.status(400).send({
          error: 'Données de renouvellement invalides',
          details: parsedRenew.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsedRenew.data
      try {
        const orig = await pool.query(
          `SELECT * FROM "${schema}".contracts WHERE id = $1 AND ${await requestEmployeeScope(request, 'contracts.employee_id')}`, [id]
        )
        if (!orig.rows[0]) return reply.status(404).send({ error: 'Contrat introuvable' })
        if (orig.rows[0].employee_id && isSelfAction(request, String(orig.rows[0].employee_id))) {
          return reply.status(403).send({ error: SELF_ACTION_ERROR })
        }
        if (orig.rows[0].type !== 'cdd') return reply.status(400).send({ error: 'Seuls les CDD sont renouvelables' })

        // Le renouvellement PROLONGE : un terme plus proche serait une rupture
        // anticipée déguisée, qui passe par /terminate et sa traçabilité.
        const current = orig.rows[0] as { start_date: string | Date; end_date: string | Date | null; renewal_count: number | null }
        const iso = (d: string | Date | null): string | null =>
          d == null ? null : (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10))
        const currentEnd = iso(current.end_date)
        if (currentEnd && body.new_end_date <= currentEnd) {
          return reply.status(400).send({
            error: `Le renouvellement doit prolonger le contrat : terme actuel ${currentEnd}`,
          })
        }

        // Bornes du pays : nombre de renouvellements, puis durée totale.
        const rule = (await tenantPack(schema)).fixedTermContract
        const already = Number(current.renewal_count ?? 0)
        if (rule && already >= rule.maxRenewals) {
          return reply.status(400).send({
            error: `Ce CDD a déjà été renouvelé ${already} fois : le maximum légal est de ${rule.maxRenewals} renouvellements`,
          })
        }
        const startIso = iso(current.start_date)
        if (rule && startIso && monthsBetween(startIso, body.new_end_date) > rule.maxMonths) {
          return reply.status(400).send({
            error: `Renouvellements compris, un CDD ne peut excéder ${rule.maxMonths} mois (${rule.maxMonths / 12} ans)`,
          })
        }

        const res = await pool.query(`
          UPDATE "${schema}".contracts
          SET end_date = $1, base_salary = COALESCE($2, base_salary),
              renewal_count = COALESCE(renewal_count, 0) + 1, updated_at = now()
          WHERE id = $3 RETURNING *
        `, [body.new_end_date, body.base_salary || null, id])

        // OWASP A09 — un renouvellement change le terme : il se trace.
        auditLogContract(schema, request.user.sub, 'contract.renewed', id, {
          employeeId: String(orig.rows[0].employee_id ?? ''),
          newEndDate: body.new_end_date,
          renewalCount: already + 1,
        }, request.ip ?? null)
        return reply.send({ data: maskSensitive(res.rows[0], await requestSensitiveCtx(request)) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /contracts/employee/:employeeId — contrats d'un employé
  fastify.get('/employee/:employeeId', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      try {
        const res = await pool.query(`
          SELECT * FROM "${schema}".contracts
          WHERE employee_id = $1 AND ${await requestEmployeeScope(request, 'contracts.employee_id')}
          ORDER BY created_at DESC
        `, [employeeId])
        return reply.send({ data: maskSensitiveRows(res.rows, await requestSensitiveCtx(request)) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /contracts/my-contract — contrat de l'employé connecté
  fastify.get('/my-contract', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const email = request.user.email
      try {
        const empRes = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 AND deleted_at IS NULL LIMIT 1`, [email]
        )
        if (!empRes.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })
        const res = await pool.query(`
          SELECT c.*
          FROM "${schema}".contracts c
          WHERE c.employee_id = $1 AND c.status = 'active'
          ORDER BY c.created_at DESC LIMIT 1
        `, [empRes.rows[0].id])
        if (!res.rows[0]) return reply.status(404).send({ error: 'Aucun contrat actif' })
        // Libre-service : toujours SON contrat, jamais masqué (même pour un RH sans la case).
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /contracts/:id — suppression physique (admin seulement)
  fastify.delete('/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return reply.status(400).send({ error: 'Identifiant de contrat invalide' })
      try {
        // OWASP A09 : snapshot du contrat AVANT suppression pour la trace audit
        // (sinon on perd l'employé concerné). Suppression suit dans la même
        // transaction logique.
        const snapshot = await pool.query<{ employee_id: string; type: string; status: string }>(
          `SELECT employee_id, type, status FROM "${schema}".contracts WHERE id = $1`,
          [id],
        )
        const ownerId = snapshot.rows[0]?.employee_id
        if (ownerId && isSelfAction(request, ownerId)) return reply.status(403).send({ error: SELF_ACTION_ERROR })
        await pool.query(
          `DELETE FROM "${schema}".contracts WHERE id = $1`, [id]
        )
        auditLogContract(schema, request.user.sub, 'contract.deleted', id, {
          employeeId: snapshot.rows[0]?.employee_id ?? null,
          type: snapshot.rows[0]?.type ?? null,
          statusBeforeDelete: snapshot.rows[0]?.status ?? null,
        }, request.ip ?? null)
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default contractsRoutes
