import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'

const pool = new Pool({ connectionString: config.database.url })

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
        const conditions: string[] = ['1=1']
        const values: unknown[] = []
        if (status)      { conditions.push(`c.status = $${values.length + 1}`);      values.push(status) }
        if (employee_id) { conditions.push(`c.employee_id = $${values.length + 1}`); values.push(employee_id) }
        if (type)        { conditions.push(`c.type = $${values.length + 1}`);        values.push(type) }

        const res = await pool.query(`
          SELECT c.*,
            e.first_name, e.last_name, e.employee_number AS registration_number,
            e.job_title AS current_job_title,
            d.name AS department_name
          FROM "${schema}".contracts c
          JOIN "${schema}".employees e ON e.id = c.employee_id AND e.deleted_at IS NULL
          LEFT JOIN "${schema}".departments d ON d.id = e.department_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY c.created_at DESC
        `, values)
        return reply.send({ data: res.rows })
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
            e.first_name, e.last_name, e.employee_number AS registration_number, e.nni,
            e.cnps_number AS employee_cnps, e.mobile_money_provider, e.mobile_money_phone AS mobile_money_number,
            d.name AS department_name
          FROM "${schema}".contracts c
          JOIN "${schema}".employees e ON e.id = c.employee_id AND e.deleted_at IS NULL
          LEFT JOIN "${schema}".departments d ON d.id = e.department_id
          WHERE c.id = $1
        `, [id])
        if (!res.rows[0]) return reply.status(404).send({ error: 'Contrat introuvable' })
        return reply.send({ data: res.rows[0] })
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
      const body = request.body as {
        employee_id: string
        type: 'cdi' | 'cdd' | 'saisonnier' | 'apprentissage' | 'stage' | 'mise_a_disposition'
        start_date: string
        end_date?: string
        trial_end_date?: string
        base_salary: number
        working_hours?: number
        convention?: string
        job_title?: string
        job_level?: string
        cnps_affiliation?: boolean
        ohada_clause?: boolean
        non_competition_clause?: boolean
        telecommuting_days?: number
      }
      try {
        // Calcul automatique de la fin de période d'essai selon Code du Travail CI
        let trialEndDate = body.trial_end_date || null
        if (!trialEndDate && body.start_date) {
          const start = new Date(body.start_date)
          // CDI : 15 jours employé / 1 mois cadre (Code Travail CI)
          const trialDays = body.job_level?.toLowerCase().includes('cadre') ? 30 : 15
          const trialEnd = new Date(start)
          trialEnd.setDate(trialEnd.getDate() + trialDays)
          trialEndDate = trialEnd.toISOString().split('T')[0]!
        }

        const res = await pool.query(`
          INSERT INTO "${schema}".contracts
            (employee_id, type, start_date, end_date, trial_end_date, base_salary,
             working_hours, convention, job_title, job_level, cnps_affiliation,
             ohada_clause, non_competition_clause, telecommuting_days, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active')
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
          `UPDATE "${schema}".employees SET base_salary = $1, job_title = COALESCE($2, job_title), updated_at = now() WHERE id = $3`,
          [body.base_salary, body.job_title || null, body.employee_id]
        )

        return reply.status(201).send({ data: res.rows[0] })
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
        const res = await pool.query(
          `UPDATE "${schema}".contracts SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Contrat introuvable' })
        return reply.send({ data: res.rows[0] })
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
      try {
        const res = await pool.query(`
          UPDATE "${schema}".contracts
          SET status = 'terminated', end_date = $1, updated_at = now()
          WHERE id = $2
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
            (employee_id, type, title, description, event_date)
          VALUES ($1,'termination',$2,$3,$4)
        `, [
          res.rows[0].employee_id,
          `Fin de contrat — ${body.termination_reason}`,
          body.comment || `Motif : ${body.termination_reason}. Préavis : ${body.notice_days || 0} jours.`,
          body.termination_date,
        ])

        // OWASP A09 : la rupture de contrat est un événement critique (statut
        // emploi, conséquences RGPD/CNPS). Trace obligatoire.
        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'contract.terminated', 'contract', $2, $3, $4)`,
          [
            request.user.sub, id,
            JSON.stringify({
              employeeId: res.rows[0].employee_id,
              terminationDate: body.termination_date,
              reason: body.termination_reason,
              noticeDays: body.notice_days ?? null,
            }),
            request.ip ?? null,
          ],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })

        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /contracts/:id/renew — renouvellement CDD
  fastify.post('/:id/renew', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as { new_end_date: string; base_salary?: number }
      try {
        const orig = await pool.query(
          `SELECT * FROM "${schema}".contracts WHERE id = $1`, [id]
        )
        if (!orig.rows[0]) return reply.status(404).send({ error: 'Contrat introuvable' })
        if (orig.rows[0].type !== 'cdd') return reply.status(400).send({ error: 'Seuls les CDD sont renouvelables' })

        const res = await pool.query(`
          UPDATE "${schema}".contracts
          SET end_date = $1, base_salary = COALESCE($2, base_salary), updated_at = now()
          WHERE id = $3 RETURNING *
        `, [body.new_end_date, body.base_salary || null, id])
        return reply.send({ data: res.rows[0] })
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
          WHERE employee_id = $1
          ORDER BY created_at DESC
        `, [employeeId])
        return reply.send({ data: res.rows })
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
      try {
        // OWASP A09 : snapshot du contrat AVANT suppression pour la trace audit
        // (sinon on perd l'employé concerné). Suppression suit dans la même
        // transaction logique.
        const snapshot = await pool.query<{ employee_id: string; type: string; status: string }>(
          `SELECT employee_id, type, status FROM "${schema}".contracts WHERE id = $1`,
          [id],
        )
        await pool.query(
          `DELETE FROM "${schema}".contracts WHERE id = $1`, [id]
        )
        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'contract.deleted', 'contract', $2, $3, $4)`,
          [
            request.user.sub, id,
            JSON.stringify({
              employeeId: snapshot.rows[0]?.employee_id ?? null,
              type: snapshot.rows[0]?.type ?? null,
              statusBeforeDelete: snapshot.rows[0]?.status ?? null,
            }),
            request.ip ?? null,
          ],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default contractsRoutes
