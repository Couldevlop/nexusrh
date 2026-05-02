import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'
import {
  getEmployee,
  listEmployees,
  createNewEmployee,
  updateExistingEmployee,
  archiveEmployee,
} from './employees.service'
import { updateEmployeeSchema } from '@nexusrh/shared'
import { searchEmployees } from '../../services/search.service'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { departments, hrEvents, employeeDocuments } from '../../db/schema/employees'
import { employeeSkills, skills } from '../../db/schema/careers'
import { eq, asc, desc } from 'drizzle-orm'
import { config } from '../../config'
import { sendWelcomeEmail } from '../../services/email.service'
import { uploadFile } from '../../services/storage.service'
import { ensureTenantSchema } from '../../utils/schema-migrations'

// Shared raw pool for user account creation (outside tenant Drizzle instance)
const rawPool = new Pool({ connectionString: config.database.url })

function generateTempPassword(length = 12): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghjkmnpqrstuvwxyz'
  const digits = '23456789'
  const special = '@#$!'
  const all = upper + lower + digits + special
  let pwd = upper[Math.floor(Math.random() * upper.length)]!
       + lower[Math.floor(Math.random() * lower.length)]!
       + digits[Math.floor(Math.random() * digits.length)]!
       + special[Math.floor(Math.random() * special.length)]!
  for (let i = 4; i < length; i++) {
    pwd += all[Math.floor(Math.random() * all.length)]!
  }
  return pwd.split('').sort(() => Math.random() - 0.5).join('')
}

// Relaxed create schema: entityId is optional — resolved server-side from the
// tenant's first legal entity when not provided.
const createEmployeeRouteSchema = z.object({
  entityId: z.string().uuid().optional(),
  profileType: z
    .enum(['employee', 'intern', 'contractor', 'temp', 'candidate', 'apprentice'])
    .optional()
    .default('employee'),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  birthDate: z.string().optional(),
  birthPlace: z.string().max(100).optional(),
  nationality: z.string().length(2).optional(),
  hireDate: z.string().optional(),
  jobTitle: z.string().max(200).optional(),
  jobLevel: z.string().max(50).optional(),
  departmentId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  workingTimePercentage: z.union([z.string(), z.number()]).optional().transform((v) => v !== undefined ? String(v) : '100.00'),
  weeklyHours: z.union([z.string(), z.number()]).optional().transform((v) => v !== undefined ? String(v) : '35.00'),
  customFields: z.record(z.unknown()).optional().default({}),
})

const employeesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schemaName = request.user?.schemaName
    if (schemaName) await ensureTenantSchema(schemaName)
  })

  // GET /employees/my-profile — profil de l'employé connecté
  fastify.get('/my-profile', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['employees'], summary: 'Mon profil employé' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId, email } = request.user

      let empId = employeeId ?? null
      if (!empId) {
        const { employees: emp } = await import('../../db/schema/employees')
        const [found] = await db.select({ id: emp.id }).from(emp).where(eq(emp.email, email)).limit(1)
        empId = found?.id ?? null
      }
      if (!empId) return reply.status(404).send({ error: 'Aucun dossier employé associé à ce compte' })

      const employee = await getEmployee(empId, db)
      return reply.send({ data: employee })
    },
  })

  // PATCH /employees/my-profile — mise à jour du profil par l'employé
  fastify.patch('/my-profile', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['employees'], summary: 'Mettre à jour mon profil' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId, email } = request.user
      const body = request.body as { phone?: string; address?: string; iban?: string }

      let empId = employeeId ?? null
      if (!empId) {
        const { employees: emp } = await import('../../db/schema/employees')
        const [found] = await db.select({ id: emp.id }).from(emp).where(eq(emp.email, email)).limit(1)
        empId = found?.id ?? null
      }
      if (!empId) return reply.status(404).send({ error: 'Aucun dossier employé associé à ce compte' })

      const updatable: Record<string, unknown> = {}
      if (body.phone !== undefined) updatable['phone'] = body.phone || null
      if (body.address !== undefined) updatable['address'] = body.address || null
      if (body.iban !== undefined) updatable['iban'] = body.iban || null

      const employee = await updateExistingEmployee(empId, updatable, db)
      return reply.send({ data: employee })
    },
  })

  // GET /employees/departments
  fastify.get('/departments', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['employees'], summary: 'Liste des départements' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const list = await db.select().from(departments).orderBy(asc(departments.name))
      return reply.send({ data: list })
    },
  })

  // GET /employees
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['employees'],
      summary: 'Liste des collaborateurs',
      querystring: {
        type: 'object',
        properties: {
          entityId: { type: 'string' },
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 25 },
          status: { type: 'string' },
          departmentId: { type: 'string' },
          profileType: { type: 'string' },
          search: { type: 'string' },
          sortBy: { type: 'string' },
          sortOrder: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const query = request.query as Record<string, string>
      // Only use entityId filter if it looks like a valid UUID; otherwise skip it
      const rawEntityId = query['entityId'] ?? ''
      const entityId = /^[0-9a-f-]{36}$/i.test(rawEntityId) ? rawEntityId : ''

      if (query['search']) {
        try {
          const results = await searchEmployees(query['search'], {
            entityId,
            departmentId: query['departmentId'],
            status: query['status'],
            limit: Number(query['limit'] ?? 25),
            offset: (Number(query['page'] ?? 1) - 1) * Number(query['limit'] ?? 25),
          })
          return reply.send({
            data: results.hits,
            total: results.totalHits,
            page: Number(query['page'] ?? 1),
            limit: Number(query['limit'] ?? 25),
            totalPages: Math.ceil(results.totalHits / Number(query['limit'] ?? 25)),
          })
        } catch {
          // Fall through to regular query if search service unavailable
        }
      }

      const result = await listEmployees(entityId, {
        page: Number(query['page'] ?? 1),
        limit: Number(query['limit'] ?? 25),
        status: query['status'],
        departmentId: query['departmentId'],
        profileType: query['profileType'],
        sortOrder: query['sortOrder'] as 'asc' | 'desc' | undefined,
      }, db)

      return reply.send(result)
    },
  })

  // GET /employees/:id
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['employees'],
      summary: 'Détail d\'un collaborateur',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const employee = await getEmployee(id, db)
      return reply.send({ data: employee })
    },
  })

  // POST /employees
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['employees'],
      summary: 'Créer un collaborateur',
    },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const rawBody = request.body as Record<string, unknown>
        const input = createEmployeeRouteSchema.parse(rawBody)
        const schemaName = request.user.schemaName ?? ''
        const schemaHint = schemaName
          .replace(/^tenant_/, '')
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())

        const employee = await createNewEmployee({ ...input, _tenantName: schemaHint || undefined }, db)

        // ── Optionnel : créer un compte utilisateur + envoyer email de bienvenue ──
        const sendCredentials = rawBody['createAccount'] === true || rawBody['sendCredentials'] === true
        if (sendCredentials && employee.email && schemaName) {
          try {
            const tempPassword = generateTempPassword(12)
            const passwordHash = await bcrypt.hash(tempPassword, 12)

            // Create or update user account in tenant schema
            const insertResult = await rawPool.query<{ id: string }>(
              `INSERT INTO "${schemaName}".users
                 (email, password_hash, first_name, last_name, role, employee_id, is_active)
               VALUES ($1, $2, $3, $4, 'employee', $5, true)
               ON CONFLICT (email) DO UPDATE
                 SET password_hash = EXCLUDED.password_hash,
                     employee_id   = EXCLUDED.employee_id,
                     is_active     = true,
                     updated_at    = NOW()
               RETURNING id`,
              [employee.email, passwordHash, employee.firstName, employee.lastName, employee.id],
            )
            request.log.info({ userId: insertResult.rows[0]?.id }, 'User account created/updated')

            // Fetch tenant branding for the welcome email
            let tenantBranding: { primaryColor?: string; secondaryColor?: string; logoUrl?: string; logoInitials?: string } | undefined
            try {
              const tenantRow = await rawPool.query<{ name: string; primary_color: string; secondary_color: string; logo_url: string | null }>(
                `SELECT name, primary_color, secondary_color, logo_url FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
                [schemaName],
              )
              if (tenantRow.rows[0]) {
                const t = tenantRow.rows[0]
                tenantBranding = {
                  primaryColor: t.primary_color,
                  secondaryColor: t.secondary_color,
                  logoUrl: t.logo_url ?? undefined,
                  logoInitials: t.name.slice(0, 2).toUpperCase(),
                }
              }
            } catch { /* branding non critique */ }

            // Send welcome email — block to capture result, then respond
            let emailSent = false
            let emailError: string | null = null
            try {
              await sendWelcomeEmail(
                employee.email,
                employee.firstName ?? '',
                employee.lastName ?? '',
                schemaHint || 'votre entreprise',
                `${config.app.url}/login`,
                tempPassword,
                tenantBranding,
              )
              emailSent = true
              request.log.info({ to: employee.email }, 'Welcome email sent')
            } catch (emailErr) {
              emailError = emailErr instanceof Error ? emailErr.message : String(emailErr)
              request.log.error({ emailErr, to: employee.email, smtp: config.email.host }, 'Welcome email FAILED')
            }

            return reply.status(201).send({
              data: employee,
              accountCreated: true,
              emailSent,
              // Always return tempPassword — filet de sécurité si email échoue
              tempPassword,
              message: emailSent
                ? `Compte créé — email de bienvenue envoyé à ${employee.email}`
                : `Compte créé — email non envoyé (${emailError ?? 'erreur SMTP'}). Mot de passe temporaire : ${tempPassword}`,
            })
          } catch (accountErr) {
            request.log.warn({ accountErr }, 'Account creation failed — employee created without account')
          }
        }

        return reply.status(201).send({ data: employee })
      } catch (err) {
        request.log.error({ err, body: request.body, user: request.user }, 'POST /employees failed')
        throw err
      }
    },
  })

  // PATCH /employees/:id
  fastify.patch('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['employees'],
      summary: 'Mettre à jour un collaborateur',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const input = updateEmployeeSchema.parse(request.body)
      const employee = await updateExistingEmployee(id, input, db)
      return reply.send({ data: employee })
    },
  })

  // ── GET /employees/:id/timeline ──────────────────────────────────────────────
  fastify.get('/:id/timeline', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['employees'], summary: 'Timeline RH d\'un collaborateur' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const events = await db
        .select()
        .from(hrEvents)
        .where(eq(hrEvents.employeeId, id))
        .orderBy(desc(hrEvents.eventDate))
      return reply.send({ data: events })
    },
  })

  // POST /employees/:id/timeline
  fastify.post('/:id/timeline', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['employees'], summary: 'Ajouter un événement RH' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as {
        type: string
        title: string
        description?: string
        eventDate: string
        isPrivate?: boolean
      }
      const [event] = await db
        .insert(hrEvents)
        .values({
          employeeId: id,
          type: body.type,
          title: body.title,
          description: body.description ?? null,
          eventDate: body.eventDate,
          isPrivate: body.isPrivate ?? false,
          createdBy: request.user.sub,
        } as never)
        .returning()
      return reply.status(201).send({ data: event })
    },
  })

  // DELETE /employees/:id/timeline/:eventId
  fastify.delete('/:id/timeline/:eventId', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['employees'], summary: 'Supprimer un événement RH' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { eventId } = request.params as { id: string; eventId: string }
      await db.delete(hrEvents).where(eq(hrEvents.id, eventId))
      return reply.status(204).send()
    },
  })

  // ── GET /employees/:id/skills ─────────────────────────────────────────────
  fastify.get('/:id/skills', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['employees'], summary: 'Compétences d\'un collaborateur' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const rows = await db
        .select({
          id: employeeSkills.id,
          employeeId: employeeSkills.employeeId,
          skillId: employeeSkills.skillId,
          level: employeeSkills.level,
          assessedAt: employeeSkills.assessedAt,
          skillName: skills.name,
          skillCategory: skills.category,
        })
        .from(employeeSkills)
        .leftJoin(skills, eq(employeeSkills.skillId, skills.id))
        .where(eq(employeeSkills.employeeId, id))
        .orderBy(asc(skills.category), asc(skills.name))
      return reply.send({ data: rows })
    },
  })

  // POST /employees/:id/skills
  fastify.post('/:id/skills', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'manager', 'super_admin')],
    schema: { tags: ['employees'], summary: 'Ajouter une compétence' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as { skillId: string; level: number; assessedAt?: string }
      const [row] = await db
        .insert(employeeSkills)
        .values({
          employeeId: id,
          skillId: body.skillId,
          level: body.level,
          assessedAt: body.assessedAt ?? null,
        } as never)
        .onConflictDoUpdate({
          target: [employeeSkills.employeeId, employeeSkills.skillId],
          set: { level: body.level, assessedAt: body.assessedAt ?? null },
        })
        .returning()
      return reply.status(201).send({ data: row })
    },
  })

  // DELETE /employees/:id/skills/:skillId
  fastify.delete('/:id/skills/:skillId', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['employees'], summary: 'Retirer une compétence' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { skillId } = request.params as { id: string; skillId: string }
      await db.delete(employeeSkills).where(eq(employeeSkills.id, skillId))
      return reply.status(204).send()
    },
  })

  // ── POST /employees/:id/documents ─────────────────────────────────────────
  fastify.post('/:id/documents', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['employees'], summary: 'Uploader un document pour un collaborateur' },
    handler: async (request, reply) => {
      try {
        const { id: employeeId } = request.params as { id: string }
        const schemaName = request.user.schemaName

        // Lazy migration — crée la table si elle n'existe pas encore
        await rawPool.query(`
          CREATE TABLE IF NOT EXISTS "${schemaName}".employee_documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            employee_id UUID REFERENCES "${schemaName}".employees(id) ON DELETE CASCADE,
            type VARCHAR(50) NOT NULL DEFAULT 'other',
            title VARCHAR(255) NOT NULL,
            file_url TEXT,
            file_size INTEGER,
            mime_type VARCHAR(100),
            is_confidential BOOLEAN DEFAULT false,
            signed_by_employee BOOLEAN DEFAULT false,
            signed_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            created_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `)
        // Rendre file_url nullable sur les tenants existants
        await rawPool.query(
          `ALTER TABLE "${schemaName}".employee_documents ALTER COLUMN file_url DROP NOT NULL`
        ).catch(() => { /* already nullable — ignore */ })

        // Lire toutes les parties multipart (champs + fichier)
        request.log.info({ employeeId, schemaName }, 'POST /documents — parsing multipart')

        let docType = 'contract'
        let docTitle = ''
        let isConfidential = false
        let fileBuffer: Buffer | null = null
        let filename = 'document'
        let mimetype = 'application/octet-stream'

        for await (const part of request.parts()) {
          if (part.type === 'file') {
            filename = part.filename ?? 'document'
            mimetype = part.mimetype
            fileBuffer = await part.toBuffer()
          } else {
            // MultipartValue — .value contient la string
            const raw = (part as unknown as { value: string }).value ?? ''
            const str = String(raw).trim()
            if (part.fieldname === 'type')                docType        = str.slice(0, 50)
            else if (part.fieldname === 'title')          docTitle       = str.slice(0, 255)
            else if (part.fieldname === 'isConfidential') isConfidential = str === 'true'
          }
        }

        if (!fileBuffer || fileBuffer.length === 0) {
          return reply.status(422).send({ error: 'Aucun fichier reçu ou fichier vide' })
        }
        if (!docTitle) docTitle = filename

        // Upload S3/MinIO — non bloquant si indisponible
        let fileUrl: string | null = null
        let fileSize: number = fileBuffer.length
        let s3Warning: string | null = null
        try {
          const folder = `${schemaName}/employees/${employeeId}/documents`
          const result = await uploadFile(fileBuffer, filename, folder, mimetype)
          fileUrl = result.url
          fileSize = result.size
        } catch (s3Err) {
          const s3Msg = s3Err instanceof Error ? s3Err.message : String(s3Err)
          request.log.warn({ employeeId, s3Msg }, 'S3 indisponible — document enregistré sans URL')
          s3Warning = `Fichier non stocké (S3 indisponible) : ${s3Msg}`
        }

        const docRes = await rawPool.query<{ id: string; type: string; title: string; file_url: string | null; created_at: string }>(
          `INSERT INTO "${schemaName}".employee_documents
             (employee_id, type, title, file_url, file_size, mime_type, is_confidential)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [employeeId, docType, docTitle, fileUrl, fileSize, mimetype, isConfidential],
        )

        return reply.status(201).send({
          data: docRes.rows[0],
          ...(s3Warning ? { warning: s3Warning } : {}),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        request.log.error({ err, path: request.url }, 'POST /documents error')
        return reply.status(500).send({ error: 'Erreur serveur', detail: message })
      }
    },
  })

  // ── GET /employees/:id/documents ──────────────────────────────────────────
  fastify.get('/:id/documents', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['employees'], summary: 'Documents d\'un collaborateur' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const docs = await db
        .select()
        .from(employeeDocuments)
        .where(eq(employeeDocuments.employeeId, id))
        .orderBy(desc(employeeDocuments.createdAt))
      return reply.send({ data: docs })
    },
  })

  // ── POST /employees/import-csv — import universel (ADP, Silae, format générique) ──
  fastify.post('/import-csv', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['employees'], summary: 'Importer des employés depuis un CSV (ADP, Silae, générique)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const data = await request.file()
      if (!data) return reply.status(400).send({ error: 'Fichier CSV requis' })

      try {
        const rawContent = await data.toBuffer()
        const content = rawContent.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        const lines = content.split('\n').filter((l) => l.trim().length > 0)
        if (lines.length < 2) return reply.status(400).send({ error: 'CSV vide ou sans données' })

        const delimiter = lines[0]!.includes(';') ? ';' : ','
        const headers = lines[0]!.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase())

        // ── Mapping colonnes universel (ADP + Silae + NexusRH natif) ─────────
        const colMap: Record<string, string[]> = {
          firstName:   ['prenom', 'firstname', 'first_name', 'prénom', 'prenom_usuel', 'prenomcollab'],
          lastName:    ['nom', 'lastname', 'last_name', 'nom_famille', 'nomcollab', 'nomtop'],
          email:       ['email', 'mail', 'email_professionnel', 'emailpro', 'adresse_mail'],
          jobTitle:    ['poste', 'job_title', 'fonction', 'libelle_emploi', 'emploi', 'intitule_poste'],
          hireDate:    ['date_entree', 'hire_date', 'dateembauche', 'date_debut', 'date_embauche'],
          birthDate:   ['date_naissance', 'birth_date', 'datenaissance', 'date_nais'],
          departmentId:['departement', 'department', 'service', 'libelle_service', 'unite'],
          phone:       ['telephone', 'tel', 'phone', 'portable', 'tel_mobile'],
          matricule:   ['matricule', 'mat', 'identifiant_salarie', 'id_salarie', 'num_salarie'],
          grossSalary: ['salaire_brut', 'brut', 'salaire', 'remuneration', 'remuneration_brute'],
          contractType:['type_contrat', 'contrat', 'nature_contrat', 'type_de_contrat'],
          nationality: ['nationalite', 'nationality', 'pays_nationalite'],
        }

        function findCol(field: string): number {
          const aliases = colMap[field] ?? []
          for (const alias of aliases) {
            const idx = headers.findIndex((h) => h.includes(alias) || alias.includes(h))
            if (idx >= 0) return idx
          }
          return -1
        }

        const colIdxs = Object.fromEntries(
          Object.keys(colMap).map((field) => [field, findCol(field)])
        )

        function getCell(row: string[], field: string): string {
          const idx = colIdxs[field] ?? -1
          if (idx < 0) return ''
          const raw = (row[idx] ?? '').trim().replace(/^"|"$/g, '')
          return raw
        }

        // Récupérer l'entité légale par défaut
        const { legalEntities: le } = await import('../../db/schema/employees')
        const [defaultEntity] = await db.select({ id: le.id }).from(le).limit(1)
        const defaultEntityId = defaultEntity?.id

        // Récupérer les départements existants
        const deptList = await db.select({ id: departments.id, name: departments.name }).from(departments)
        const deptMap = new Map(deptList.map((d) => [d.name.toLowerCase(), d.id]))

        const results = { created: 0, skipped: 0, errors: [] as string[] }

        for (let i = 1; i < lines.length; i++) {
          const row = lines[i]!.split(delimiter)
          const firstName = getCell(row, 'firstName')
          const lastName = getCell(row, 'lastName')

          if (!firstName || !lastName) {
            results.skipped++
            continue
          }

          try {
            const emailRaw = getCell(row, 'email')
            const hireDateRaw = getCell(row, 'hireDate')
            const deptNameRaw = getCell(row, 'departmentId')
            const contractRaw = getCell(row, 'contractType').toLowerCase()

            // Résoudre département
            let deptId: string | undefined
            if (deptNameRaw) {
              deptId = deptMap.get(deptNameRaw.toLowerCase()) ?? undefined
            }

            // Normaliser date (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY)
            function normalizeDate(raw: string): string | undefined {
              if (!raw) return undefined
              if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
              const parts = raw.split(/[/\-.]/)
              if (parts.length === 3) {
                if ((parts[0]?.length ?? 0) === 4) return `${parts[0]}-${parts[1]?.padStart(2,'0')}-${parts[2]?.padStart(2,'0')}`
                return `${parts[2]}-${parts[1]?.padStart(2,'0')}-${parts[0]?.padStart(2,'0')}`
              }
              return undefined
            }

            // Normaliser type contrat
            const contractType = contractRaw.includes('cdd') ? 'cdd'
              : contractRaw.includes('cdi') ? 'cdi'
              : contractRaw.includes('stage') || contractRaw.includes('intern') ? 'internship'
              : 'cdi'

            await createNewEmployee({
              entityId: defaultEntityId ?? '',
              firstName,
              lastName,
              email: emailRaw || undefined,
              hireDate: normalizeDate(hireDateRaw),
              birthDate: normalizeDate(getCell(row, 'birthDate')),
              jobTitle: getCell(row, 'jobTitle') || undefined,
              phone: getCell(row, 'phone') || undefined,
              departmentId: deptId,
              nationality: getCell(row, 'nationality') || undefined,
              weeklyHours: '35.00',
              workingTimePercentage: '100.00',
              profileType: 'employee',
            } as any, db)

            results.created++
          } catch (rowErr) {
            const msg = rowErr instanceof Error ? rowErr.message : String(rowErr)
            results.errors.push(`Ligne ${i + 1} (${firstName} ${lastName}): ${msg}`)
          }
        }

        return reply.send({
          data: results,
          message: `Import terminé : ${results.created} créé(s), ${results.skipped} ignoré(s), ${results.errors.length} erreur(s)`,
        })
      } catch (err) {
        fastify.log.error({ err }, 'import-csv error')
        return reply.status(500).send({ error: 'Erreur traitement CSV' })
      }
    },
  })

  // ── GET /employees/export-csv — export CSV pour migration ────────────────
  fastify.get('/export-csv', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['employees'], summary: 'Exporter les employés en CSV' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      try {
        const { employees: emp } = await import('../../db/schema/employees')
        const { isNull } = await import('drizzle-orm')
        const list = await db
          .select({
            matricule: emp.employeeNumber,
            firstName: emp.firstName,
            lastName: emp.lastName,
            email: emp.email,
            jobTitle: emp.jobTitle,
            hireDate: emp.hireDate,
            birthDate: emp.birthDate,
            phone: emp.phone,
            weeklyHours: emp.weeklyHours,
            nationality: emp.nationality,
            status: emp.status,
          })
          .from(emp)
          .where(isNull(emp.deletedAt))
          .orderBy(emp.lastName)

        const headers = ['Matricule','Prénom','Nom','Email','Poste','Date d\'embauche','Date naissance','Téléphone','Type contrat','Heures semaine','Nationalité','Statut']
        const rows = list.map((e) => [
          e.matricule ?? '',
          e.firstName,
          e.lastName,
          e.email ?? '',
          e.jobTitle ?? '',
          e.hireDate ?? '',
          e.birthDate ?? '',
          e.phone ?? '',
          'cdi',
          e.weeklyHours ?? '35.00',
          e.nationality ?? 'FR',
          e.status,
        ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';'))

        const csv = [headers.join(';'), ...rows].join('\r\n')
        const filename = `employes_export_${new Date().toISOString().slice(0, 10)}.csv`

        reply.header('Content-Type', 'text/csv; charset=utf-8')
        reply.header('Content-Disposition', `attachment; filename="${filename}"`)
        return reply.send('\uFEFF' + csv) // BOM UTF-8 pour Excel
      } catch (err) {
        fastify.log.error({ err }, 'export-csv error')
        return reply.status(500).send({ error: 'Erreur export CSV' })
      }
    },
  })

  // DELETE /employees/:id
  fastify.delete('/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: {
      tags: ['employees'],
      summary: 'Archiver un collaborateur',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      await archiveEmployee(id, db)
      return reply.status(204).send()
    },
  })
}

export default employeesRoutes
