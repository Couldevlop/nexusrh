import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { encryptIfPresent, decryptIfPresent } from '../../utils/crypto.js'
import { describeDbError } from '../../utils/db-error.js'
import { emitIntegrationEvent } from '../../services/integrations.service.js'
import { autoStartOnboarding } from '../../services/onboarding.service.js'
import { archiveEmployeeCascade } from '../../services/employee-archive.service.js'
import { encodeField } from '../sage/sage.service.js'
import { config } from '../../config.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// EMP-003/004/005 — validations de format (NNI, CNPS, Mobile Money).
// Champs optionnels : '' / null → undefined (non fourni) ; sinon le format est
// imposé. NNI/CNPS = format ivoirien (l'employeur est en CI) ; le téléphone
// Mobile Money accepte toute la zone africaine (employés CI, Burkina, Mali…).
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v)
const nniField = z.preprocess(emptyToUndef,
  z.string().regex(/^CI\d{9,13}$/, 'NNI invalide : format attendu CI suivi de 9 à 13 chiffres (ex : CI123456789)').optional())
const cnpsField = z.preprocess(emptyToUndef,
  z.string().regex(/^CI\d{8}[A-Z]$/, 'Numéro CNPS invalide : format attendu CI + 8 chiffres + 1 lettre (ex : CI12345678A)').optional())
// Téléphone Mobile Money : les employés peuvent venir de toute la zone (CI,
// Burkina, Mali, Niger, Sénégal, Tchad, Congo, RDC, Cameroun…). On valide donc
// un indicatif AFRICAIN supporté (CEDEAO + CEMAC + RDC), suivi de 6 à 10 chiffres,
// espaces tolérés. Rejette les indicatifs hors zone (ex : +33 France) et trop courts.
const AFRICA_MM_DIAL_CODES = [
  '225', '226', '223', '227', '221', '229', '228', '224', '245', '220', '238', '234', '233', '231', '232', // CEDEAO
  '237', '235', '236', '242', '241', '240', '243', // CEMAC + RDC
]
const AFRICA_MM_PHONE_RE = new RegExp(`^\\+(${AFRICA_MM_DIAL_CODES.join('|')})\\d{6,10}$`)
const mmPhoneField = z.preprocess(emptyToUndef,
  z.string().refine((v) => AFRICA_MM_PHONE_RE.test(String(v).replace(/\s/g, '')),
    'Numéro Mobile Money invalide : indicatif africain attendu (ex : +225, +226, +223, +235, +242…) suivi du numéro').optional())

// OWASP A03 — validation Zod du body POST /employees
const createEmployeeSchema = z.object({
  firstName:           z.string().min(1).max(100).trim(),
  lastName:            z.string().min(1).max(100).trim(),
  email:               z.string().email().max(255).optional(),
  phone:               z.string().max(30).optional(),
  birthDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender:              z.enum(['M', 'F', 'X']).optional(),
  nni:                 nniField,
  cnpsNumber:          cnpsField,
  mobileMoneyProvider: z.enum(['wave', 'mtn', 'mtn_momo', 'orange', 'orange_money', 'cofina']).optional(),
  mobileMoneyPhone:    mmPhoneField,
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
  nni:                 nniField,
  cnpsNumber:          cnpsField,
  mobileMoneyProvider: z.enum(['wave', 'mtn', 'mtn_momo', 'orange', 'orange_money', 'cofina']).optional(),
  mobileMoneyPhone:    mmPhoneField,
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
      // EMP-006 — pagination : page/limit + total réel (COUNT) pour 80+ employés.
      const { search, departmentId, isActive = 'true', page: pageRaw, limit: limitRaw } = request.query as Record<string, string>
      const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1)
      const limit = Math.min(200, Math.max(1, parseInt(limitRaw ?? '20', 10) || 20))
      const offset = (page - 1) * limit
      const schema = request.user.schemaName

      // Clause WHERE commune (filtres) — réutilisée par le COUNT et la page.
      let where = ` WHERE e.deleted_at IS NULL`
      const params: unknown[] = []
      let idx = 1

      if (isActive === 'true') { where += ` AND e.is_active = true` }
      if (departmentId) { where += ` AND e.department_id = $${idx++}`; params.push(departmentId) }
      if (search) {
        where += ` AND (lower(e.first_name) LIKE $${idx} OR lower(e.last_name) LIKE $${idx} OR e.cnps_number LIKE $${idx})`
        params.push(`%${search.toLowerCase()}%`); idx++
      }
      // Si manager : filtre équipe directe (OWASP A01 fail-closed : sans dossier
      // employé associé, il ne voit personne au lieu de tout le tenant).
      if (request.user.role === 'manager') {
        const empRes = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        const mgr = empRes.rows[0]
        if (!mgr) return reply.send({ data: [], total: 0, page, limit })
        where += ` AND e.manager_id = $${idx++}`; params.push(mgr.id)
      }

      // total réel (mêmes filtres) — affiché « 80+ employés » même en page 1.
      const countRes = await pool.query(`SELECT count(*)::int AS c FROM "${schema}".employees e ${where}`, params)
      const total = countRes.rows[0]?.c ?? 0

      const listSql = `SELECT e.*, d.name AS department_name
                       FROM "${schema}".employees e
                       LEFT JOIN "${schema}".departments d ON d.id = e.department_id
                       ${where}
                       ORDER BY e.last_name, e.first_name
                       LIMIT $${idx++} OFFSET $${idx++}`
      const res = await pool.query(listSql, [...params, limit, offset])

      return reply.send({ data: res.rows, total, page, limit })
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

      // EMP-009 — ancienneté CALCULÉE depuis la date d'embauche.
      if (emp.hire_date) {
        const hire = new Date(emp.hire_date)
        const now = new Date()
        const months = Math.max(0,
          (now.getFullYear() - hire.getFullYear()) * 12 + (now.getMonth() - hire.getMonth())
          - (now.getDate() < hire.getDate() ? 1 : 0))
        emp.seniority_months = months
        emp.seniority_label = `${Math.floor(months / 12)} an(s) ${months % 12} mois`
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

      let res
      try {
        res = await pool.query(
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
      } catch (err) {
        // Aucune erreur technique brute ne doit remonter : message personnalisé.
        const mapped = describeDbError(err, {
          entity: 'employé',
          uniqueMessages: { email: 'Un employé avec cet email existe déjà.' },
        })
        request.log.error({ err, schema, action: 'employee.create' }, 'Échec création employé')
        if (mapped) return reply.status(mapped.statusCode).send({ error: mapped.error, code: mapped.code })
        return reply.status(500).send({
          error: "Impossible d'enregistrer l'employé pour le moment. Réessayez ou contactez le support.",
        })
      }

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

      // EMP-010 — capter l'ancien salaire AVANT l'UPDATE pour historiser le
      // changement (augmentation/baisse) dans hr_events après le succès.
      let oldSalary: number | null = null
      if (body.baseSalary != null) {
        const prev = await pool.query<{ base_salary: string | null }>(
          `SELECT base_salary FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [id])
        oldSalary = prev.rows[0]?.base_salary != null ? Number(prev.rows[0].base_salary) : null
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
      let res
      try {
        res = await pool.query(
          `UPDATE "${schema}".employees SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
          vals
        )
      } catch (err) {
        const mapped = describeDbError(err, {
          entity: 'employé',
          uniqueMessages: { email: 'Un employé avec cet email existe déjà.' },
        })
        request.log.error({ err, schema, action: 'employee.update', id }, 'Échec modification employé')
        if (mapped) return reply.status(mapped.statusCode).send({ error: mapped.error, code: mapped.code })
        return reply.status(500).send({
          error: "Impossible de modifier l'employé pour le moment. Réessayez ou contactez le support.",
        })
      }
      if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })

      // EMP-010 — historise un changement de salaire dans hr_events (non bloquant).
      if (body.baseSalary != null && Number(body.baseSalary) !== oldSalary) {
        const newSalary = Number(body.baseSalary)
        const evtType = oldSalary != null && newSalary > oldSalary ? 'augmentation' : 'salary_change'
        await pool.query(
          `INSERT INTO "${schema}".hr_events (employee_id, type, title, description, date, metadata, created_by)
           VALUES ($1, $2, 'Modification de salaire', $3, CURRENT_DATE, $4::jsonb, $5)`,
          [id, evtType, `Salaire mensuel : ${oldSalary ?? 0} → ${newSalary} FCFA`,
           JSON.stringify({ oldSalary, newSalary, field: 'base_salary' }), request.user.sub],
        ).catch((err) => request.log.error({ err, schema, id }, 'Échec écriture hr_events salaire'))
      }

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
        fastify.log.error({ err, employeeId: id, action: 'employee.check-delete' }, 'Échec vérification suppression')
        const mapped = describeDbError(err, { entity: 'employé' })
        if (mapped) return reply.status(mapped.statusCode).send({ error: mapped.error, code: mapped.code })
        return reply.status(500).send({
          error: "Impossible de vérifier la suppression de l'employé pour le moment. Réessayez plus tard.",
        })
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
        // Archivage cohérent : désactive le compte lié + rompt les contrats actifs
        // + annule les sanctions disciplinaires en cours + annule les demandes de
        // signature en attente. Aucun processus ne reste orphelin sur un dossier
        // archivé (cf. employee-archive.service). Cascade partagée avec la clôture
        // d'un dossier de sortie (offboarding).
        const cascade = await archiveEmployeeCascade(pool, schema, id)
        auditLogEmployee(schema, request.user.sub, 'employee.archived', id, {
          firstName: snapshot.rows[0].first_name,
          lastName:  snapshot.rows[0].last_name,
          email:     snapshot.rows[0].email,
          jobTitle:  snapshot.rows[0].job_title,
          terminatedContracts: cascade.terminatedContracts,
          cancelledDiscipline: cascade.cancelledDiscipline,
          cancelledSignatures: cascade.cancelledSignatures,
        }, request.ip ?? null)
        return reply.send({
          message: 'Employé archivé',
          terminatedContracts: cascade.terminatedContracts,
          cancelledDiscipline: cascade.cancelledDiscipline,
          cancelledSignatures: cascade.cancelledSignatures,
        })
      } catch (err) {
        fastify.log.error({ err, employeeId: id, action: 'employee.archive' }, 'Échec archivage employé')
        const mapped = describeDbError(err, { entity: 'employé' })
        if (mapped) return reply.status(mapped.statusCode).send({ error: mapped.error, code: mapped.code })
        return reply.status(500).send({
          error: "Impossible d'archiver l'employé pour le moment. Réessayez ou contactez le support.",
        })
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

  // EMP-014 — GET /employees/export.csv : export de la liste (BOM UTF-8, anti-injection
  // CSV, salaires FCFA ENTIERS). NNI/IBAN exclus (RGPD : données chiffrées sensibles).
  fastify.get('/export.csv', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['employees'], summary: 'Export CSV de la liste des employés' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await pool.query(
        `SELECT e.employee_number, e.last_name, e.first_name, e.email, e.phone,
                e.job_title, e.professional_category, d.name AS department,
                e.contract_type, e.hire_date, e.cnps_number,
                e.base_salary, e.currency, e.is_active
         FROM "${schema}".employees e
         LEFT JOIN "${schema}".departments d ON d.id = e.department_id
         WHERE e.deleted_at IS NULL
         ORDER BY e.last_name, e.first_name`,
      )
      const headers = ['Matricule', 'Nom', 'Prénom', 'Email', 'Téléphone', 'Poste', 'Catégorie',
        'Département', 'Type contrat', 'Date embauche', 'N° CNPS', 'Salaire (FCFA)', 'Devise', 'Actif']
      const enc = (v: unknown) => encodeField(v, ';')
      const lines = [headers.map(enc).join(';')]
      for (const r of res.rows) {
        lines.push([
          r.employee_number, r.last_name, r.first_name, r.email, r.phone,
          r.job_title, r.professional_category, r.department, r.contract_type,
          r.hire_date, r.cnps_number,
          r.base_salary != null ? Math.round(Number(r.base_salary)) : '', // FCFA entier
          r.currency ?? 'XOF', r.is_active ? 'Oui' : 'Non',
        ].map(enc).join(';'))
      }
      auditLogEmployee(schema, request.user.sub, 'employees.exported', '', { count: res.rowCount }, request.ip ?? null)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', 'attachment; filename="employes.csv"')
      return reply.send('﻿' + lines.join('\r\n'))
    },
  })

  // EMP-015 — POST /employees/:id/photo : upload de la photo de profil (multipart).
  // Réutilise le store image générique (platform.brand_assets) servi par /public/brand/:id.
  // RBAC : RH + l'employé sur SON propre dossier.
  fastify.post('/:id/photo', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'employee')],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: { tags: ['employees'], summary: 'Uploader la photo de profil d\'un employé' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      if (request.user.role === 'employee' && request.user.employeeId !== id) {
        return reply.status(403).send({ error: 'Vous ne pouvez modifier que votre propre profil' })
      }
      const schema = request.user.schemaName
      const file = await request.file()
      if (!file) return reply.status(400).send({ error: 'Aucun fichier reçu' })
      const mime = (file.mimetype || '').toLowerCase()
      // OWASP A03 — SVG exclu (XSS stocké) ; allowlist stricte.
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
        return reply.status(400).send({ error: 'Format non autorisé. Accepté : PNG, JPEG, WEBP, GIF.' })
      }
      const buf = await file.toBuffer()
      if (buf.byteLength > 2 * 1024 * 1024) {
        return reply.status(400).send({ error: 'Image trop volumineuse (max 2 MB).' })
      }
      try {
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO platform.brand_assets (mime, bytes) VALUES ($1, $2) RETURNING id`, [mime, buf])
        const url = `${config.apiUrl}/public/brand/${ins.rows[0]?.id}`
        const upd = await pool.query(
          `UPDATE "${schema}".employees SET profile_photo_url = $1, updated_at = now()
           WHERE id = $2 AND deleted_at IS NULL RETURNING id`, [url, id])
        if (!upd.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })
        auditLogEmployee(schema, request.user.sub, 'employee.photo_updated', id, {}, request.ip ?? null)
        return reply.status(201).send({ data: { profilePhotoUrl: url } })
      } catch (err) {
        request.log.error({ err, schema, id }, 'Échec upload photo employé')
        return reply.status(500).send({ error: "Impossible d'enregistrer la photo. Réessayez." })
      }
    },
  })
}

export default employeesRoutes
