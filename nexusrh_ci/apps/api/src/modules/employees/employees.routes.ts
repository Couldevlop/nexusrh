import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { encryptIfPresent, decryptIfPresent } from '../../utils/crypto.js'
import { emitIntegrationEvent } from '../../services/integrations.service.js'
import { autoStartOnboarding } from '../../services/onboarding.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// OWASP A03 — validation Zod du body POST /employees
const createEmployeeSchema = z.object({
  firstName:           z.string().min(1).max(100).trim(),
  lastName:            z.string().min(1).max(100).trim(),
  email:               z.string().email().max(255).optional(),
  phone:               z.string().max(30).optional(),
  birthDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender:              z.enum(['M', 'F', 'X']).optional(),
  nni:                 z.string().max(50).optional(),
  cnpsNumber:          z.string().max(30).optional(),
  mobileMoneyProvider: z.enum(['wave', 'mtn', 'orange', 'cofina']).optional(),
  mobileMoneyPhone:    z.string().max(30).optional(),
  departmentId:        z.string().uuid().optional(),
  managerId:           z.string().uuid().optional(),
  jobTitle:            z.string().max(200).optional(),
  jobLevel:            z.string().max(50).optional(),
  contractType:        z.enum(['cdi', 'cdd', 'saisonnier', 'apprentissage', 'stage', 'mise_a_disposition']).optional(),
  hireDate:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  baseSalary:          z.number().int().min(0).max(100_000_000),
  // Temps de travail hebdomadaire (heures) — base légale CI : 40h
  weeklyHours:         z.number().min(1).max(60).optional(),
  // Catégorie professionnelle (convention collective : 1ère-6ème cat., AM, cadre…)
  professionalCategory: z.string().max(50).optional(),
  // RIB — chiffré AES-256 en base (RGPD, même traitement que le NNI)
  iban:                z.string().max(50).optional(),
  bankName:            z.string().max(100).optional(),
  city:                z.string().max(100).optional(),
  maritalStatus:       z.enum(['single', 'married', 'divorced', 'widowed', 'cohabiting']).optional(),
  childrenCount:       z.number().int().min(0).max(30).optional(),
})

// OWASP A03 — validation Zod du body PATCH /employees/:id
// Whitelist explicite : les clés non listées sont silencieusement ignorées.
const patchEmployeeSchema = z.object({
  firstName:           z.string().min(1).max(100).trim().optional(),
  lastName:            z.string().min(1).max(100).trim().optional(),
  email:               z.string().email().max(255).optional(),
  phone:               z.string().max(30).optional(),
  birthDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender:              z.enum(['M', 'F', 'X']).optional(),
  nni:                 z.string().max(50).optional(),
  cnpsNumber:          z.string().max(30).optional(),
  mobileMoneyProvider: z.enum(['wave', 'mtn', 'orange', 'cofina']).optional(),
  mobileMoneyPhone:    z.string().max(30).optional(),
  departmentId:        z.string().uuid().nullable().optional(),
  managerId:           z.string().uuid().nullable().optional(),
  jobTitle:            z.string().max(200).optional(),
  jobLevel:            z.string().max(50).optional(),
  contractType:        z.enum(['cdi', 'cdd', 'saisonnier', 'apprentissage', 'stage', 'mise_a_disposition']).optional(),
  hireDate:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  baseSalary:          z.number().int().min(0).max(100_000_000).optional(),
  weeklyHours:         z.number().min(1).max(60).optional(),
  professionalCategory: z.string().max(50).optional(),
  iban:                z.string().max(50).optional(),
  bankName:            z.string().max(100).optional(),
  city:                z.string().max(100).optional(),
  maritalStatus:       z.enum(['single', 'married', 'divorced', 'widowed', 'cohabiting']).optional(),
  childrenCount:       z.number().int().min(0).max(30).optional(),
  isActive:            z.boolean().optional(),
  profilePhotoUrl:     z.string().max(2000).optional(),
  address:             z.string().max(500).optional(),
}).strict()

// Champs qu'un employee a le droit de modifier sur son propre profil (subset
// strict de patchEmployeeSchema). Les autres clés sont écartées même en self.
// L'IBAN est modifiable par l'employé (self-service paie) — chiffré en base.
const EMPLOYEE_SELF_FIELDS = new Set([
  'phone', 'address', 'mobileMoneyProvider', 'mobileMoneyPhone', 'profilePhotoUrl',
  'iban', 'bankName',
])

function auditLogEmployee(
  schema: string, userId: string, action: string,
  employeeId: string, changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'employee', $3, $4, $5)`,
    [userId, action, employeeId, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

const employeesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /employees
  fastify.get('/', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    schema: { tags: ['employees'], summary: 'Liste des employés' },
    handler: async (request, reply) => {
      const { search, departmentId, isActive = 'true' } = request.query as Record<string, string>
      // pool module-level
      const schema = request.user.schemaName

      let sql = `SELECT e.*, d.name AS department_name
                 FROM "${schema}".employees e
                 LEFT JOIN "${schema}".departments d ON d.id = e.department_id
                 WHERE e.deleted_at IS NULL`
      const params: unknown[] = []
      let idx = 1

      if (isActive === 'true') { sql += ` AND e.is_active = true` }
      if (departmentId) { sql += ` AND e.department_id = $${idx++}`; params.push(departmentId) }
      if (search) {
        sql += ` AND (lower(e.first_name) LIKE $${idx} OR lower(e.last_name) LIKE $${idx} OR e.cnps_number LIKE $${idx})`
        params.push(`%${search.toLowerCase()}%`); idx++
      }
      // Si manager : filtre équipe directe (OWASP A01 fail-closed : sans dossier
      // employé associé, il ne voit personne au lieu de tout le tenant).
      if (request.user.role === 'manager') {
        const empRes = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        const mgr = empRes.rows[0]
        if (!mgr) return reply.send({ data: [], total: 0 })
        sql += ` AND e.manager_id = $${idx++}`; params.push(mgr.id)
      }

      sql += ` ORDER BY e.last_name, e.first_name`
      const res = await pool.query(sql, params)

      return reply.send({ data: res.rows, total: res.rowCount })
    },
  })

  // GET /employees/:id
  fastify.get('/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','employee','readonly')],
    schema: { tags: ['employees'], summary: 'Détail d\'un employé' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      // pool module-level
      const schema = request.user.schemaName

      const res = await pool.query(
        `SELECT e.*, d.name AS department_name,
                m.first_name AS manager_first_name, m.last_name AS manager_last_name
         FROM "${schema}".employees e
         LEFT JOIN "${schema}".departments d ON d.id = e.department_id
         LEFT JOIN "${schema}".employees m ON m.id = e.manager_id
         WHERE e.id = $1 AND e.deleted_at IS NULL LIMIT 1`,
        [id]
      )

      if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })

      const emp = res.rows[0]

      // OWASP A01 — contrôle d'accès fin par rôle :
      // - employee : uniquement son propre dossier
      // - manager : uniquement un membre de son équipe directe (manager_id)
      if (request.user.role === 'employee' && emp.email !== request.user.email) {
        return reply.status(403).send({ error: 'Accès interdit' })
      }
      if (request.user.role === 'manager') {
        const mgrRes = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        const mgrId = mgrRes.rows[0]?.id
        const isSelf = emp.email === request.user.email
        if (!mgrId || (emp.manager_id !== mgrId && !isSelf)) {
          return reply.status(403).send({ error: 'Accès interdit' })
        }
      }

      // OWASP A01/A02 — ne déchiffrer NNI/IBAN que pour les rôles RH (et le
      // salarié lui-même pour son propre dossier). manager/readonly ne voient
      // jamais ces données en clair.
      const canSeeSensitive =
        ['admin', 'hr_manager', 'hr_officer'].includes(request.user.role) ||
        emp.email === request.user.email
      if (canSeeSensitive) {
        if (emp.nni) emp.nni = decryptIfPresent(emp.nni)
        if (emp.iban) emp.iban = decryptIfPresent(emp.iban)
      } else {
        delete emp.nni
        delete emp.iban
      }
      return reply.send({ data: emp })
    },
  })

  // POST /employees
  fastify.post('/', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    schema: { tags: ['employees'], summary: 'Créer un employé CI' },
    handler: async (request, reply) => {
      // OWASP A03 : validation Zod stricte (rejette champs arbitraires + types)
      const parsed = createEmployeeSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données employé invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      if (body.baseSalary < 75000) {
        return reply.status(422).send({ error: 'Le salaire ne peut pas être inférieur au SMIG (75 000 FCFA)' })
      }

      // pool module-level
      const schema = request.user.schemaName

      const res = await pool.query(
        `INSERT INTO "${schema}".employees
           (first_name, last_name, email, phone, birth_date, gender,
            nni, cnps_number, mobile_money_provider, mobile_money_phone,
            department_id, manager_id, job_title, job_level, contract_type,
            hire_date, base_salary, weekly_hours, professional_category,
            iban, bank_name, city, marital_status, children_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING *`,
        [
          body.firstName, body.lastName, body.email ?? null, body.phone ?? null,
          body.birthDate ?? null, body.gender ?? null,
          encryptIfPresent(body.nni), body.cnpsNumber ?? null,
          body.mobileMoneyProvider ?? null, body.mobileMoneyPhone ?? null,
          body.departmentId ?? null, body.managerId ?? null,
          body.jobTitle ?? null, body.jobLevel ?? null, body.contractType ?? 'cdi',
          body.hireDate ?? null, body.baseSalary,
          // Base légale CI : 40h hebdomadaires par défaut
          body.weeklyHours ?? 40, body.professionalCategory ?? null,
          // RGPD — RIB chiffré AES-256 (même traitement que le NNI)
          encryptIfPresent(body.iban), body.bankName ?? null,
          body.city ?? 'Abidjan', body.maritalStatus ?? null, body.childrenCount ?? 0,
        ]
      )

      // OWASP A09 : trace de la création
      auditLogEmployee(schema, request.user.sub, 'employee.created', res.rows[0].id, {
        firstName: body.firstName, lastName: body.lastName,
        email: body.email ?? null, jobTitle: body.jobTitle ?? null,
        baseSalary: body.baseSalary,
      }, request.ip ?? null)

      // Connectivité : notifie les outils externes abonnés (non bloquant).
      emitIntegrationEvent(pool, schema, 'employee.created', {
        id: res.rows[0].id, firstName: body.firstName, lastName: body.lastName,
        email: body.email ?? null, jobTitle: body.jobTitle ?? null,
      }, decryptIfPresent)

      // Parcours d'intégration : auto-création depuis le modèle le plus
      // pertinent (séniorité / type de poste). Non bloquant — la création de
      // l'employé ne doit jamais échouer à cause de l'onboarding.
      autoStartOnboarding(pool, schema, {
        id: res.rows[0].id,
        job_title: body.jobTitle ?? null,
        job_level: body.jobLevel ?? null,
        department_id: body.departmentId ?? null,
        hire_date: body.hireDate ?? null,
      }, request.user.sub).catch(() => { /* best-effort */ })

      return reply.status(201).send({ data: res.rows[0] })
    },
  })

  // PATCH /employees/:id
  fastify.patch('/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','employee')],
    schema: { tags: ['employees'], summary: 'Modifier un employé' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) {
        return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      }
      // OWASP A01 (IDOR) : un employee ne peut PATCH que son propre profil.
      // On vérifie l'égalité avec request.user.employeeId — la valeur vient du
      // JWT signé au login, jamais saisie côté client.
      if (request.user.role === 'employee' && request.user.employeeId !== id) {
        return reply.status(403).send({ error: 'Vous ne pouvez modifier que votre propre profil' })
      }
      // OWASP A03 : Zod parse + whitelist
      const parsed = patchEmployeeSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Champs invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      // Si role = employee, restriction supplémentaire : seuls les champs self
      // (téléphone, adresse, mobile money, photo) sont autorisés. Le payload
      // peut contenir des autres champs grâce au Zod loose, mais on les retire.
      const body: Record<string, unknown> = parsed.data
      if (request.user.role === 'employee') {
        for (const k of Object.keys(body)) {
          if (!EMPLOYEE_SELF_FIELDS.has(k)) delete body[k]
        }
      }

      const schema = request.user.schemaName

      // Vérification SMIG si modification salaire
      if (body.baseSalary != null && Number(body.baseSalary) < 75000) {
        return reply.status(422).send({ error: 'Salaire inférieur au SMIG (75 000 FCFA)' })
      }

      // Zod a déjà filtré les champs autorisés. On convertit juste camelCase
      // → snake_case pour l'UPDATE SQL et on chiffre le NNI sensible.
      const sets: string[] = []
      const vals: unknown[] = []
      const modifiedKeys: string[] = []
      let idx = 1
      for (const [k, v] of Object.entries(body)) {
        const dbKey = k.replace(/([A-Z])/g, '_$1').toLowerCase()
        if (dbKey === 'address') {
          // `address` est une colonne jsonb : une chaîne brute déclenchait
          // « invalid input syntax for type json » (500). On encode en JSON.
          sets.push(`${dbKey} = $${idx++}::jsonb`)
          vals.push(JSON.stringify(v ?? null))
        } else {
          sets.push(`${dbKey} = $${idx++}`)
          // RGPD — NNI et IBAN chiffrés AES-256 avant écriture
          vals.push(dbKey === 'nni' || dbKey === 'iban' ? encryptIfPresent(v as string) : v)
        }
        modifiedKeys.push(dbKey)
      }
      if (sets.length === 0) return reply.status(400).send({ error: 'Aucun champ valide' })
      sets.push(`updated_at = now()`)
      vals.push(id)
      const res = await pool.query(
        `UPDATE "${schema}".employees SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
        vals
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })

      // OWASP A09 : trace de la modification (clés modifiées sans les valeurs
      // sensibles comme NNI/téléphone — on garde l'info utile à l'audit).
      auditLogEmployee(schema, request.user.sub, 'employee.updated', id, {
        modifiedFields: modifiedKeys,
        bySelf: request.user.role === 'employee',
      }, request.ip ?? null)

      return reply.send({ data: res.rows[0] })
    },
  })

  // GET /employees/:id/check-delete — vérifie les actions en attente avant suppression
  fastify.get('/:id/check-delete', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    schema: { tags: ['employees'], summary: 'Vérifier si un employé peut être supprimé' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      // pool module-level
      const schema = request.user.schemaName
      try {
        const pending: Array<{ type: string; label: string; path: string; count: number }> = []

        const absRes = await pool.query(
          `SELECT COUNT(*) FROM "${schema}".absences WHERE employee_id = $1 AND status IN ('submitted','pending')`, [id]
        )
        const absCount = parseInt(absRes.rows[0].count)
        if (absCount > 0) pending.push({ type: 'absences', label: `${absCount} absence(s) en attente de validation`, path: '/absences', count: absCount })

        const expRes = await pool.query(
          `SELECT COUNT(*) FROM "${schema}".expense_reports WHERE employee_id = $1 AND status IN ('draft','submitted')`, [id]
        )
        const expCount = parseInt(expRes.rows[0].count)
        if (expCount > 0) pending.push({ type: 'expenses', label: `${expCount} note(s) de frais non clôturée(s)`, path: '/expenses', count: expCount })

  
        return reply.send({ canDelete: pending.length === 0, pendingActions: pending })
      } catch (err) {
        fastify.log.error(err)
  
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /employees/:id (soft delete)
  fastify.delete('/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    schema: { tags: ['employees'], summary: 'Archiver un employé (soft delete)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) {
        return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      }
      const schema = request.user.schemaName
      try {
        // OWASP A09 : snapshot AVANT archivage pour la trace audit (sinon on
        // perd le nom/email/poste qui ont été supprimés)
        const snapshot = await pool.query<{
          first_name: string; last_name: string; email: string | null
          job_title: string | null
        }>(
          `SELECT first_name, last_name, email, job_title
             FROM "${schema}".employees WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        )
        if (!snapshot.rows[0]) {
          return reply.status(404).send({ error: 'Employé introuvable ou déjà archivé' })
        }
        await pool.query(
          `UPDATE "${schema}".employees SET deleted_at = now(), is_active = false WHERE id = $1`, [id]
        )
        // Le collaborateur peut avoir un COMPTE DE CONNEXION lié (users.employee_id).
        // Sans cette désactivation, un employé "supprimé" pouvait encore se
        // connecter et restait dans la liste des utilisateurs (OWASP A01).
        // On désactive le login (is_active=false) sans hard-delete (audit/RGPD).
        await pool.query(
          `UPDATE "${schema}".users SET is_active = false, updated_at = now() WHERE employee_id = $1`, [id]
        )
        // Cohérence employé ↔ contrat : un employé archivé/parti ne doit JAMAIS
        // laisser un contrat « actif » orphelin. On rompt tous ses contrats
        // actifs (statut → terminated, end_date posée) : ils basculent en archive
        // au lieu de rester actifs sur un dossier qui n'existe plus.
        const termContracts = await pool.query<{ id: string }>(
          `UPDATE "${schema}".contracts
              SET status = 'terminated',
                  end_date = COALESCE(end_date, CURRENT_DATE),
                  updated_at = now()
            WHERE employee_id = $1 AND status = 'active'
            RETURNING id`,
          [id],
        ).catch(() => ({ rows: [] as Array<{ id: string }> }))
        auditLogEmployee(schema, request.user.sub, 'employee.archived', id, {
          firstName: snapshot.rows[0].first_name,
          lastName:  snapshot.rows[0].last_name,
          email:     snapshot.rows[0].email,
          jobTitle:  snapshot.rows[0].job_title,
          terminatedContracts: termContracts.rows.length,
        }, request.ip ?? null)
        return reply.send({ message: 'Employé archivé', terminatedContracts: termContracts.rows.length })
      } catch (err) {
        fastify.log.error({ err, employeeId: id }, 'employee archive failed')
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /employees/departments
  fastify.get('/departments', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    schema: { tags: ['employees'], summary: 'Liste des départements' },
    handler: async (request, reply) => {
      // pool module-level
      const schema = request.user.schemaName
      const res = await pool.query(
        `SELECT d.*, e.first_name AS manager_first_name, e.last_name AS manager_last_name
         FROM "${schema}".departments d
         LEFT JOIN "${schema}".employees e ON e.id = d.manager_id
         ORDER BY d.name`
      )

      return reply.send({ data: res.rows })
    },
  })
}

export default employeesRoutes
