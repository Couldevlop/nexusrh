import type { FastifyPluginAsync } from 'fastify'
import { eq, asc } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'
import ExcelJS from 'exceljs'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { parameters, departments, legalEntities, employees } from '../../db/schema/employees'
import { absenceTypes, absenceBalances } from '../../db/schema/absences'
import { users } from '../../db/schema/auth'
import { config } from '../../config'
import { seedDefaultParameters } from '../../db/provisioning'
import { sendWelcomeEmail } from '../../services/email.service'

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function csvRow(values: (string | number | boolean | null | undefined)[]): string {
  return values
    .map((v) => {
      const s = v == null ? '' : String(v)
      // Quote if contains comma, quote, or newline
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`
      }
      return s
    })
    .join(',')
}

function buildCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const lines = [csvRow(headers), ...rows.map(csvRow)]
  // BOM for Excel UTF-8 detection
  return '\uFEFF' + lines.join('\r\n')
}

function parseCsv(content: string): string[][] {
  // Strip BOM if present
  const clean = content.startsWith('\uFEFF') ? content.slice(1) : content
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.map((line) => {
    const result: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuote = !inQuote
        }
      } else if (ch === ',' && !inQuote) {
        result.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    result.push(cur)
    return result
  })
}

// ─── Template definitions ─────────────────────────────────────────────────────

const TEMPLATES: Record<string, { headers: string[]; example: (string | number | null)[][]; description: string }> = {
  employees: {
    description: 'Import des employés',
    headers: [
      'matricule', 'prenom*', 'nom*', 'email', 'telephone',
      'date_naissance', 'titre_poste', 'niveau_poste',
      'departement_code', 'date_embauche*', 'salaire_brut',
      'type_contrat', 'pourcentage_temps', 'statut',
    ],
    example: [
      ['EMP001', 'Alice', 'Martin', 'alice.martin@entreprise.com', '0612345678',
       '1990-05-15', 'Développeur Frontend', 'Confirmé',
       'ENG', '2023-01-15', '48000', 'CDI', '100', 'active'],
      ['EMP002', 'Thomas', 'Dupont', 'thomas.dupont@entreprise.com', '0687654321',
       '1985-11-22', 'Lead Developer', 'Senior',
       'ENG', '2021-03-01', '65000', 'CDI', '100', 'active'],
    ],
  },
  departments: {
    description: 'Import des départements',
    headers: ['nom*', 'code', 'centre_de_cout', 'responsable_email'],
    example: [
      ['Engineering', 'ENG', 'CC-001', 'manager@entreprise.com'],
      ['Product', 'PRD', 'CC-002', ''],
      ['Marketing', 'MKT', 'CC-003', ''],
    ],
  },
  absences: {
    description: 'Initialisation des soldes de congés',
    headers: [
      'matricule_ou_email*', 'type_absence_code*', 'acquis', 'pris', 'en_attente', 'annee',
    ],
    example: [
      ['alice.martin@entreprise.com', 'CP', '25', '10', '3', '2024'],
      ['alice.martin@entreprise.com', 'RTT', '12', '5', '0', '2024'],
      ['thomas.dupont@entreprise.com', 'CP', '25', '8', '2', '2024'],
    ],
  },
  payroll_rules: {
    description: 'Import des rubriques de paie',
    headers: [
      'code*', 'libelle*', 'type*', 'taux', 'base', 'plafond_ss',
      'tranche', 'ordre', 'actif',
    ],
    example: [
      ['1000', 'Salaire de base', 'earning', '', 'BRUT', '', '', '10', 'oui'],
      ['4100', 'CSG déductible', 'employee_contribution', '0.0680', 'BRUT*0.9825', '', '', '41', 'oui'],
      ['5000', 'Mutuelle salarié', 'employee_contribution', '', '', '', '', '50', 'oui'],
    ],
  },
  contracts: {
    description: 'Import des contrats',
    headers: [
      'matricule_ou_email*', 'type_contrat*', 'date_debut*', 'date_fin',
      'salaire_brut*', 'periode_essai_fin', 'motif_cdd',
    ],
    example: [
      ['alice.martin@entreprise.com', 'CDI', '2023-01-15', '', '48000', '2023-03-15', ''],
      ['thomas.dupont@entreprise.com', 'CDI', '2021-03-01', '', '65000', '', ''],
      ['julie.leroy@entreprise.com', 'CDD', '2024-01-01', '2024-12-31', '35000', '2024-02-01', 'Remplacement'],
    ],
  },
  users: {
    description: 'Import des utilisateurs',
    headers: ['prenom*', 'nom*', 'email*', 'role*', 'matricule_employe'],
    example: [
      ['Sophie', 'Bernard', 'sophie.bernard@entreprise.com', 'hr_manager', ''],
      ['Marc', 'Dubois', 'marc.dubois@entreprise.com', 'manager', 'EMP003'],
      ['Lucie', 'Moreau', 'lucie.moreau@entreprise.com', 'employee', 'EMP004'],
    ],
  },
}

// ─── Helper: resolve first entityId for the tenant ───────────────────────────
async function resolveEntityId(db: ReturnType<typeof getTenantDbForRequest>) {
  const [entity] = await db.select({ id: legalEntities.id }).from(legalEntities).limit(1)
  return entity?.id ?? null
}

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = new Pool({ connectionString: config.database.url })

  // ════════════════════════════════════════════════════════════════════════════
  // PARAMETERS
  // ════════════════════════════════════════════════════════════════════════════

  fastify.get('/parameters', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['settings'], summary: 'Liste des paramètres par catégorie' },
    handler: async (request, reply) => {
      const schemaName = request.user?.schemaName
      const { category } = request.query as { category?: string }

      // Fallback lazy: si la table parameters est absente (tenant créé avant la v2),
      // la recrée et la peuple depuis seedDefaultParameters
      const ensureParametersTable = async () => {
        if (!schemaName) return
        const client = await pool.connect()
        try {
          await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
          await client.query(`
            CREATE TABLE IF NOT EXISTS "${schemaName}".parameters (
              id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
              category VARCHAR(50) NOT NULL,
              code VARCHAR(100) NOT NULL,
              label VARCHAR(255) NOT NULL,
              color VARCHAR(20),
              metadata JSONB NOT NULL DEFAULT '{}',
              sort_order INTEGER NOT NULL DEFAULT 0,
              is_active BOOLEAN NOT NULL DEFAULT TRUE,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              UNIQUE(category, code)
            )
          `)
          await seedDefaultParameters(client, schemaName)
          request.log.info(`Auto-provisioned parameters table for schema ${schemaName}`)
        } finally {
          client.release()
        }
      }

      try {
        const db = getTenantDbForRequest(request)
        const query = db.select().from(parameters).orderBy(asc(parameters.sortOrder), asc(parameters.label))
        const list = category
          ? await query.where(eq(parameters.category, category))
          : await query
        return reply.send({ data: list })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('does not exist') || msg.includes('42P01')) {
          // Table missing → auto-create and retry once
          await ensureParametersTable()
          try {
            const db = getTenantDbForRequest(request)
            const query = db.select().from(parameters).orderBy(asc(parameters.sortOrder), asc(parameters.label))
            const list = category
              ? await query.where(eq(parameters.category, category))
              : await query
            return reply.send({ data: list })
          } catch {
            return reply.send({ data: [] })
          }
        }
        throw err
      }
    },
  })

  fastify.post('/parameters', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Créer un paramètre' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        category: string
        code: string
        label: string
        color?: string
        metadata?: Record<string, unknown>
        sortOrder?: number
      }

      if (!body.category || !body.code || !body.label) {
        return reply.status(422).send({ error: 'category, code et label sont requis' })
      }

      const code = body.code.toUpperCase().replace(/\s+/g, '_')

      const [param] = await db
        .insert(parameters)
        .values({
          category: body.category,
          code,
          label: body.label,
          color: body.color ?? null,
          metadata: body.metadata ?? {},
          sortOrder: body.sortOrder ?? 0,
          isActive: true,
        } as never)
        .returning()

      return reply.status(201).send({ data: param })
    },
  })

  fastify.patch('/parameters/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Modifier un paramètre' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>

      const allowed = ['label', 'color', 'metadata', 'sortOrder', 'isActive']
      const set: Record<string, unknown> = { updatedAt: new Date() }
      for (const key of allowed) {
        if (body[key] !== undefined) set[key] = body[key]
      }

      const [updated] = await db
        .update(parameters)
        .set(set as never)
        .where(eq(parameters.id, id))
        .returning()

      if (!updated) return reply.status(404).send({ error: 'Paramètre introuvable' })
      return reply.send({ data: updated })
    },
  })

  fastify.delete('/parameters/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Supprimer un paramètre' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      await db.delete(parameters).where(eq(parameters.id, id))
      return reply.status(204).send()
    },
  })

  // ════════════════════════════════════════════════════════════════════════════
  // DEPARTMENTS
  // ════════════════════════════════════════════════════════════════════════════

  fastify.get('/departments', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['settings'], summary: 'Liste des départements' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const list = await db.select().from(departments).orderBy(asc(departments.name))
        return reply.send({ data: list })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('does not exist') || msg.includes('42P01')) {
          return reply.send({ data: [] })
        }
        throw err
      }
    },
  })

  fastify.post('/departments', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Créer un département' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as { name: string; code?: string; costCenter?: string }

      if (!body.name) return reply.status(422).send({ error: 'name est requis' })

      const entityId = await resolveEntityId(db)
      if (!entityId) return reply.status(422).send({ error: 'Aucune entité juridique configurée' })

      const [dept] = await db
        .insert(departments)
        .values({
          entityId,
          name: body.name,
          code: body.code ?? null,
          costCenter: body.costCenter ?? null,
        } as never)
        .returning()

      return reply.status(201).send({ data: dept })
    },
  })

  fastify.patch('/departments/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Modifier un département' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as { name?: string; code?: string; costCenter?: string }

      const set: Record<string, unknown> = {}
      if (body.name !== undefined) set['name'] = body.name
      if (body.code !== undefined) set['code'] = body.code
      if (body.costCenter !== undefined) set['costCenter'] = body.costCenter

      const [updated] = await db
        .update(departments)
        .set(set as never)
        .where(eq(departments.id, id))
        .returning()

      if (!updated) return reply.status(404).send({ error: 'Département introuvable' })
      return reply.send({ data: updated })
    },
  })

  fastify.delete('/departments/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Supprimer un département' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      await db.delete(departments).where(eq(departments.id, id))
      return reply.status(204).send()
    },
  })

  // ════════════════════════════════════════════════════════════════════════════
  // ABSENCE TYPES
  // ════════════════════════════════════════════════════════════════════════════

  fastify.get('/absence-types', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['settings'], summary: 'Types d\'absence' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const list = await db.select().from(absenceTypes).orderBy(asc(absenceTypes.label))
        return reply.send({ data: list })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('does not exist') || msg.includes('42P01')) {
          return reply.send({ data: [] })
        }
        throw err
      }
    },
  })

  fastify.post('/absence-types', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Créer un type d\'absence' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        code: string
        label: string
        category: string
        color?: string
        requiresApproval?: boolean
        requiresJustification?: boolean
        isPaid?: boolean
        impactsPayroll?: boolean
        maxDaysPerYear?: number
      }

      if (!body.code || !body.label || !body.category) {
        return reply.status(422).send({ error: 'code, label et category sont requis' })
      }

      const entityId = await resolveEntityId(db)
      if (!entityId) return reply.status(422).send({ error: 'Aucune entité juridique configurée' })

      const [type] = await db
        .insert(absenceTypes)
        .values({
          entityId,
          code: body.code.toUpperCase().replace(/\s+/g, '_'),
          label: body.label,
          category: body.category,
          color: body.color ?? '#4F46E5',
          requiresApproval: body.requiresApproval ?? true,
          requiresJustification: body.requiresJustification ?? false,
          isPaid: body.isPaid ?? true,
          impactsPayroll: body.impactsPayroll ?? false,
          maxDaysPerYear: body.maxDaysPerYear ? String(body.maxDaysPerYear) : null,
          isActive: true,
        } as never)
        .returning()

      return reply.status(201).send({ data: type })
    },
  })

  fastify.patch('/absence-types/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Modifier un type d\'absence' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>

      const allowed = ['label', 'category', 'color', 'requiresApproval', 'requiresJustification', 'isPaid', 'impactsPayroll', 'maxDaysPerYear', 'isActive']
      const set: Record<string, unknown> = {}
      for (const key of allowed) {
        if (body[key] !== undefined) set[key] = body[key]
      }

      const [updated] = await db
        .update(absenceTypes)
        .set(set as never)
        .where(eq(absenceTypes.id, id))
        .returning()

      if (!updated) return reply.status(404).send({ error: 'Type d\'absence introuvable' })
      return reply.send({ data: updated })
    },
  })

  fastify.delete('/absence-types/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['settings'], summary: 'Supprimer un type d\'absence' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      await db.delete(absenceTypes).where(eq(absenceTypes.id, id))
      return reply.status(204).send()
    },
  })

  // ════════════════════════════════════════════════════════════════════════════
  // USERS — gestion des utilisateurs du tenant
  // ════════════════════════════════════════════════════════════════════════════

  // GET /settings/users
  fastify.get('/users', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Liste des utilisateurs du tenant' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const list = await db
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
            isActive: users.isActive,
            lastLoginAt: users.lastLoginAt,
            createdAt: users.createdAt,
          })
          .from(users)
          .orderBy(asc(users.lastName), asc(users.firstName))
        return reply.send({ data: list })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('does not exist') || msg.includes('42P01')) {
          return reply.send({ data: [] })
        }
        throw err
      }
    },
  })

  // POST /settings/users
  fastify.post('/users', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Créer un utilisateur tenant' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        email: string
        firstName: string
        lastName: string
        role: string
        password: string
      }

      if (!body.email || !body.firstName || !body.lastName || !body.role || !body.password) {
        return reply.status(422).send({ error: 'Tous les champs obligatoires doivent être renseignés' })
      }

      if (body.password.length < 8) {
        return reply.status(422).send({ error: 'Le mot de passe doit comporter au moins 8 caractères' })
      }

      const validRoles = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly']
      if (!validRoles.includes(body.role)) {
        return reply.status(422).send({ error: 'Rôle invalide' })
      }

      // Check email uniqueness
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1)
      if (existing.length > 0) {
        return reply.status(409).send({ error: `Un utilisateur avec l'email ${body.email} existe déjà` })
      }

      const passwordHash = await bcrypt.hash(body.password, 12)

      const [user] = await db
        .insert(users)
        .values({
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          role: body.role,
          passwordHash,
          isActive: true,
        })
        .returning({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          isActive: users.isActive,
          createdAt: users.createdAt,
        })

      // Send welcome email with login credentials (non-blocking)
      const tenantName = (request.user.schemaName ?? '')
        .replace(/^tenant_/, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())

      sendWelcomeEmail(
        body.email,
        body.firstName,
        body.lastName,
        tenantName,
        `${config.app.url}/login`,
        body.password,
      ).catch((emailErr) => {
        request.log.warn({ emailErr, to: body.email }, 'Welcome email failed (non-blocking)')
      })

      return reply.status(201).send({ data: user, message: `Compte créé — email de bienvenue envoyé à ${body.email}` })
    },
  })

  // PATCH /settings/users/:id
  fastify.patch('/users/:id', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Modifier un utilisateur tenant' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as { role?: string; isActive?: boolean; password?: string }
      const { sub } = request.user

      // Prevent admin from deactivating/deleting themselves
      if (id === sub && body.isActive === false) {
        return reply.status(403).send({ error: 'Vous ne pouvez pas vous désactiver vous-même' })
      }

      const set: Record<string, unknown> = { updatedAt: new Date() }

      const validRoles = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly']
      if (body.role !== undefined) {
        if (!validRoles.includes(body.role)) {
          return reply.status(422).send({ error: 'Rôle invalide' })
        }
        set['role'] = body.role
      }

      if (body.isActive !== undefined) set['isActive'] = body.isActive

      if (body.password !== undefined) {
        if (body.password.length < 8) {
          return reply.status(422).send({ error: 'Le mot de passe doit comporter au moins 8 caractères' })
        }
        set['passwordHash'] = await bcrypt.hash(body.password, 12)
      }

      const [updated] = await db
        .update(users)
        .set(set as never)
        .where(eq(users.id, id))
        .returning({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          isActive: users.isActive,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
        })

      if (!updated) return reply.status(404).send({ error: 'Utilisateur introuvable' })
      return reply.send({ data: updated })
    },
  })

  // DELETE /settings/users/:id
  fastify.delete('/users/:id', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Supprimer un utilisateur tenant' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const { sub } = request.user

      if (id === sub) {
        return reply.status(403).send({ error: 'Vous ne pouvez pas supprimer votre propre compte' })
      }

      await db.delete(users).where(eq(users.id, id))
      return reply.status(204).send()
    },
  })

  // ════════════════════════════════════════════════════════════════════════════
  // IMPORT — modèles Excel (CSV) + traitement upload
  // ════════════════════════════════════════════════════════════════════════════

  // GET /settings/import/template/:type — télécharger le modèle Excel (.xlsx) compatible Excel 2016+
  fastify.get('/import/template/:type', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: { tags: ['settings'], summary: 'Télécharger un modèle d\'import Excel (.xlsx)' },
    handler: async (request, reply) => {
      const { type } = request.params as { type: string }
      const tpl = TEMPLATES[type]

      if (!tpl) {
        return reply.status(404).send({ error: `Type d'import inconnu : ${type}` })
      }

      // Build real .xlsx with ExcelJS (compatible Excel 2016+)
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'NexusRH'
      workbook.created = new Date()

      // ── Main sheet ─────────────────────────────────────────────────────────
      const sheet = workbook.addWorksheet('Import', {
        properties: { tabColor: { argb: 'FF4F46E5' } },
        views: [{ state: 'frozen', ySplit: 1 }],
      })

      // Column definitions with widths
      const COL_WIDTHS: Record<string, number> = {
        matricule: 14, 'prenom*': 18, 'nom*': 18, email: 30, telephone: 16,
        date_naissance: 16, titre_poste: 28, niveau_poste: 16, departement_code: 18,
        'date_embauche*': 16, salaire_brut: 14, type_contrat: 22, pourcentage_temps: 18,
        statut: 12, nom: 24, code: 12, centre_de_cout: 16, responsable_email: 30,
        'matricule_ou_email*': 30, 'type_absence_code*': 20, acquis: 10, pris: 10,
        en_attente: 12, annee: 8, 'code*': 12, 'libelle*': 28, 'type*': 20, taux: 10,
        base: 20, plafond_ss: 12, tranche: 10, ordre: 8, actif: 8,
        'date_debut*': 16, date_fin: 14, 'salaire_brut*': 14, periode_essai_fin: 18,
        motif_cdd: 20, 'email*': 30, 'role*': 16,
        matricule_employe: 18,
      }

      sheet.columns = tpl.headers.map((h) => ({
        header: h,
        key: h,
        width: COL_WIDTHS[h] ?? 20,
      }))

      // Header row styling
      const headerRow = sheet.getRow(1)
      headerRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } }
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 11, name: 'Calibri' }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false }
        cell.border = {
          bottom: { style: 'medium', color: { argb: 'FF3730A3' } },
        }
        // Mark required columns with asterisk styling
        if (cell.value && String(cell.value).endsWith('*')) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3730A3' } }
        }
      })
      headerRow.height = 22

      // Example data rows
      tpl.example.forEach((exampleRow, rowIdx) => {
        const dataRow = sheet.addRow(exampleRow)
        dataRow.eachCell((cell) => {
          cell.font = { size: 11, name: 'Calibri' }
          cell.alignment = { vertical: 'middle' }
          cell.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: rowIdx % 2 === 0 ? 'FFF5F3FF' : 'FFFFFFFF' },
          }
        })
        dataRow.height = 20
      })

      // ── Instructions sheet ─────────────────────────────────────────────────
      const infoSheet = workbook.addWorksheet('Instructions', {
        properties: { tabColor: { argb: 'FFFBBF24' } },
      })
      infoSheet.columns = [
        { header: 'Colonne', key: 'col', width: 28 },
        { header: 'Obligatoire', key: 'req', width: 14 },
        { header: 'Format attendu', key: 'fmt', width: 40 },
        { header: 'Exemple', key: 'ex', width: 32 },
      ]

      // Info header styling
      infoSheet.getRow(1).eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBBF24' } }
        cell.font = { bold: true, size: 11, name: 'Calibri' }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
      })
      infoSheet.getRow(1).height = 22

      const FORMAT_HINTS: Record<string, { fmt: string; ex: string }> = {
        'prenom*':              { fmt: 'Texte libre',                ex: 'Alice' },
        'nom*':                 { fmt: 'Texte libre',                ex: 'Martin' },
        email:                  { fmt: 'Adresse e-mail valide',      ex: 'alice@entreprise.com' },
        'email*':               { fmt: 'Adresse e-mail valide',      ex: 'alice@entreprise.com' },
        telephone:              { fmt: '10 chiffres (0XXXXXXXXX)',   ex: '0612345678' },
        date_naissance:         { fmt: 'AAAA-MM-JJ',                 ex: '1990-05-15' },
        'date_embauche*':       { fmt: 'AAAA-MM-JJ',                 ex: '2023-01-15' },
        date_debut:             { fmt: 'AAAA-MM-JJ',                 ex: '2023-01-15' },
        'date_debut*':          { fmt: 'AAAA-MM-JJ',                 ex: '2023-01-15' },
        date_fin:               { fmt: 'AAAA-MM-JJ (vide = CDI)',    ex: '2024-12-31' },
        periode_essai_fin:      { fmt: 'AAAA-MM-JJ',                 ex: '2023-03-15' },
        titre_poste:            { fmt: 'Texte libre',                ex: 'Développeur Frontend' },
        niveau_poste:           { fmt: 'Code niveau (IC1-IC7, M1-M7)', ex: 'IC3' },
        departement_code:       { fmt: 'Code département existant',  ex: 'ENG' },
        salaire_brut:           { fmt: 'Montant annuel brut (€)',    ex: '48000' },
        'salaire_brut*':        { fmt: 'Montant annuel brut (€)',    ex: '48000' },
        type_contrat:           { fmt: 'CDI | CDD | STAGE | CTT…',  ex: 'CDI' },
        'type_contrat*':        { fmt: 'CDI | CDD | STAGE | CTT…',  ex: 'CDI' },
        pourcentage_temps:      { fmt: '1–100 (100 = temps plein)',  ex: '100' },
        statut:                 { fmt: 'active | inactive | trial',  ex: 'active' },
        matricule:              { fmt: 'Alphanumériqu libre',        ex: 'EMP001' },
        'matricule_ou_email*':  { fmt: 'Email ou matricule employé', ex: 'alice@entreprise.com' },
        'type_absence_code*':   { fmt: 'CP | RTT | MAL | MAT…',     ex: 'CP' },
        acquis:                 { fmt: 'Nombre décimal (jours)',     ex: '25' },
        pris:                   { fmt: 'Nombre décimal (jours)',     ex: '10' },
        en_attente:             { fmt: 'Nombre décimal (jours)',     ex: '3' },
        annee:                  { fmt: 'Année (AAAA)',               ex: '2024' },
        'code*':                { fmt: 'Code alphanumérique unique', ex: '4100' },
        'libelle*':             { fmt: 'Texte libre',                ex: 'CSG déductible' },
        'type*':                { fmt: 'earning|employee_contribution|employer_contribution|deduction', ex: 'employee_contribution' },
        taux:                   { fmt: 'Taux décimal (0.068 = 6,8%)', ex: '0.068' },
        base:                   { fmt: 'Base de calcul (BRUT, TRANCHE_A…)', ex: 'BRUT*0.9825' },
        'role*':                { fmt: 'admin|hr_manager|hr_officer|manager|employee|readonly', ex: 'employee' },
        matricule_employe:      { fmt: 'Matricule existant (facultatif)', ex: 'EMP001' },
      }

      tpl.headers.forEach((h, i) => {
        const hint = FORMAT_HINTS[h] ?? { fmt: 'Texte', ex: '' }
        const isRequired = h.endsWith('*')
        const infoRow = infoSheet.addRow({
          col: h,
          req: isRequired ? 'Oui ✓' : 'Non',
          fmt: hint.fmt,
          ex: tpl.example[0]?.[i] ?? hint.ex,
        })
        infoRow.getCell('req').font = { color: { argb: isRequired ? 'FFD97706' : 'FF6B7280' }, bold: isRequired }
        infoRow.eachCell((cell) => {
          cell.font = cell.font ?? {}
          cell.font.size = 10
          cell.font.name = 'Calibri'
          cell.alignment = { vertical: 'middle' }
        })
        infoRow.height = 18
      })

      // Title banner in instructions
      infoSheet.insertRow(1, ['', '', '', ''])
      infoSheet.insertRow(1, [
        `Modèle NexusRH — Import ${tpl.description}`,
        '', '', '',
      ])
      infoSheet.getRow(1).height = 28
      infoSheet.getRow(1).getCell(1).font = { bold: true, size: 13, name: 'Calibri', color: { argb: 'FF1E1B4B' } }
      infoSheet.getRow(1).getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } }
      infoSheet.mergeCells(1, 1, 1, 4)

      // Freeze header + instructions header
      infoSheet.views = [{ state: 'frozen', ySplit: 3 }]

      // Write to buffer
      const buffer = await workbook.xlsx.writeBuffer()

      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="modele_${type}_nexusrh.xlsx"`)
        .send(buffer)
    },
  })

  // POST /settings/import/:type — importer un fichier CSV
  fastify.post('/import/:type', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Importer des données depuis un fichier CSV/Excel' },
    handler: async (request, reply) => {
      const { type } = request.params as { type: string }
      const tpl = TEMPLATES[type]

      if (!tpl) {
        return reply.status(404).send({ error: `Type d'import inconnu : ${type}` })
      }

      // Parse multipart file
      const data = await request.file()
      if (!data) {
        return reply.status(422).send({ error: 'Aucun fichier fourni' })
      }

      const mimetype = data.mimetype
      const isCsv = mimetype.includes('csv') || data.filename.endsWith('.csv')
      const isXls = data.filename.endsWith('.xlsx') || data.filename.endsWith('.xls')

      if (!isCsv && !isXls) {
        return reply.status(422).send({ error: 'Format non supporté. Utilisez .csv, .xlsx ou .xls' })
      }

      const buffer = await data.toBuffer()

      let rows: string[][]
      try {
        if (isXls) {
          // Parse xlsx with ExcelJS
          const wb = new ExcelJS.Workbook()
          await wb.xlsx.load(buffer as unknown as ArrayBuffer)
          const ws = wb.worksheets[0]
          if (!ws) throw new Error('Aucune feuille trouvée dans le fichier Excel')
          rows = []
          ws.eachRow((row) => {
            const values = (row.values as (ExcelJS.CellValue | undefined)[]).slice(1) // skip index 0
            rows.push(values.map((v) => {
              if (v == null) return ''
              if (typeof v === 'object' && 'text' in v) return String((v as { text: string }).text)
              if (typeof v === 'object' && 'result' in v) return String((v as { result: unknown }).result)
              return String(v)
            }))
          })
        } else {
          const content = buffer.toString('utf-8')
          rows = parseCsv(content)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erreur de lecture'
        return reply.status(422).send({ error: `Impossible de lire le fichier : ${msg}` })
      }

      if (rows.length < 2) {
        return reply.status(422).send({ error: 'Le fichier est vide ou ne contient que les en-têtes' })
      }

      const headers = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
      const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ''))

      const imported: number[] = []
      const errors: string[] = []
      const warnings: string[] = []

      const db = getTenantDbForRequest(request)
      const entityId = await resolveEntityId(db)

      // ── Import employees ──────────────────────────────────────────────────
      if (type === 'employees') {
        if (!entityId) {
          return reply.status(422).send({ error: 'Aucune entité juridique configurée' })
        }

        const col = (name: string) => headers.indexOf(name)
        const iPrenom   = col('prenom*')
        const iNom      = col('nom*')
        const iEmail    = col('email')
        const iPoste    = col('titre_poste')
        const iNiveau   = col('niveau_poste')
        const iDeptCode = col('departement_code')
        const iHire     = col('date_embauche*')
        const iSalaire  = col('salaire_brut')
        const iMatricule = col('matricule')
        const iContrat  = col('type_contrat')
        const iStatut   = col('statut')
        const iTemps    = col('pourcentage_temps')

        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i]
          if (!row) continue
          const lineNum = i + 2

          const prenom = row[iPrenom]?.trim()
          const nom    = row[iNom]?.trim()
          if (!prenom || !nom) {
            errors.push(`Ligne ${lineNum} : prénom et nom sont obligatoires`)
            continue
          }

          const hireDate = row[iHire]?.trim()
          if (!hireDate) {
            errors.push(`Ligne ${lineNum} : date_embauche est obligatoire`)
            continue
          }

          // Find department by code
          let departmentId: string | null = null
          const deptCode = row[iDeptCode]?.trim()
          if (deptCode) {
            try {
              const deptResult = await pool.query<{ id: string }>(
                `SELECT id FROM departments WHERE code = $1 LIMIT 1`,
                [deptCode],
              )
              if (deptResult.rows[0]) {
                departmentId = deptResult.rows[0].id
              } else {
                warnings.push(`Ligne ${lineNum} : département "${deptCode}" non trouvé — ignoré`)
              }
            } catch {
              warnings.push(`Ligne ${lineNum} : erreur lors de la recherche du département`)
            }
          }

          try {
            await db.insert(employees).values({
              entityId,
              firstName: prenom,
              lastName: nom,
              email: row[iEmail]?.trim() || null,
              employeeNumber: row[iMatricule]?.trim() || null,
              jobTitle: row[iPoste]?.trim() || null,
              jobLevel: row[iNiveau]?.trim() || null,
              departmentId,
              hireDate,
              status: row[iStatut]?.trim() || 'active',
              workingTimePercentage: row[iTemps]?.trim() || '100.00',
            } as never)
            imported.push(lineNum)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('unique') || msg.includes('duplicate')) {
              warnings.push(`Ligne ${lineNum} : ${prenom} ${nom} — doublon ignoré`)
            } else {
              errors.push(`Ligne ${lineNum} : ${msg}`)
            }
          }
        }
      }

      // ── Import departments ────────────────────────────────────────────────
      else if (type === 'departments') {
        if (!entityId) {
          return reply.status(422).send({ error: 'Aucune entité juridique configurée' })
        }

        const col = (name: string) => headers.indexOf(name)
        const iNom  = col('nom*')
        const iCode = col('code')
        const iCC   = col('centre_de_cout')

        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i]
          if (!row) continue
          const lineNum = i + 2
          const nom = row[iNom]?.trim()
          if (!nom) {
            errors.push(`Ligne ${lineNum} : nom est obligatoire`)
            continue
          }
          try {
            await db.insert(departments).values({
              entityId,
              name: nom,
              code: row[iCode]?.trim() || null,
              costCenter: row[iCC]?.trim() || null,
            } as never)
            imported.push(lineNum)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('unique') || msg.includes('duplicate')) {
              warnings.push(`Ligne ${lineNum} : département "${nom}" — doublon ignoré`)
            } else {
              errors.push(`Ligne ${lineNum} : ${msg}`)
            }
          }
        }
      }

      // ── Import users ──────────────────────────────────────────────────────
      else if (type === 'users') {
        const col = (name: string) => headers.indexOf(name)
        const iPrenom = col('prenom*')
        const iNom    = col('nom*')
        const iEmail  = col('email*')
        const iRole   = col('role*')
        const validRoles = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly']

        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i]
          if (!row) continue
          const lineNum = i + 2

          const prenom = row[iPrenom]?.trim()
          const nom    = row[iNom]?.trim()
          const email  = row[iEmail]?.trim()
          const role   = row[iRole]?.trim()?.toLowerCase()

          if (!prenom || !nom || !email || !role) {
            errors.push(`Ligne ${lineNum} : prénom, nom, email et rôle sont obligatoires`)
            continue
          }

          if (!validRoles.includes(role)) {
            errors.push(`Ligne ${lineNum} : rôle "${role}" invalide (valeurs : ${validRoles.join(', ')})`)
            continue
          }

          try {
            // Generate a temporary password
            const tempPassword = Math.random().toString(36).slice(-8) + 'A1!'
            const passwordHash = await bcrypt.hash(tempPassword, 10)

            await db.insert(users).values({
              email,
              firstName: prenom,
              lastName: nom,
              role,
              passwordHash,
              isActive: true,
            })
            imported.push(lineNum)
            warnings.push(`Ligne ${lineNum} : mot de passe temporaire pour ${email} — à réinitialiser`)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('unique') || msg.includes('duplicate')) {
              warnings.push(`Ligne ${lineNum} : utilisateur "${email}" — doublon ignoré`)
            } else {
              errors.push(`Ligne ${lineNum} : ${msg}`)
            }
          }
        }
      }

      // ── Import absence balances ───────────────────────────────────────────
      else if (type === 'absences') {
        const absTypesTable = absenceTypes
        const emps = employees
        const col = (name: string) => headers.indexOf(name)

        const iRef    = col('matricule_ou_email*')
        const iCode   = col('type_absence_code*')
        const iAcquis = col('acquis')
        const iPris   = col('pris')
        const iAttente = col('en_attente')
        const iAnnee  = col('annee')

        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i]
          if (!row) continue
          const lineNum = i + 2

          const ref  = row[iRef]?.trim()
          const code = row[iCode]?.trim()
          if (!ref || !code) {
            errors.push(`Ligne ${lineNum} : matricule_ou_email et type_absence_code sont obligatoires`)
            continue
          }

          try {
            // Find employee
            const empResult = ref.includes('@')
              ? await db.select({ id: emps.id }).from(emps).where(eq(emps.email, ref)).limit(1)
              : await db.select({ id: emps.id }).from(emps).where(eq(emps.employeeNumber, ref)).limit(1)

            if (!empResult[0]) {
              errors.push(`Ligne ${lineNum} : employé "${ref}" introuvable`)
              continue
            }

            // Find absence type
            const typeResult = await db
              .select({ id: absTypesTable.id })
              .from(absTypesTable)
              .where(eq(absTypesTable.code, code.toUpperCase()))
              .limit(1)

            if (!typeResult[0]) {
              errors.push(`Ligne ${lineNum} : type d'absence "${code}" introuvable`)
              continue
            }

            const year = row[iAnnee]?.trim() || String(new Date().getFullYear())

            await db.insert(absenceBalances).values({
              employeeId: empResult[0].id,
              absenceTypeId: typeResult[0].id,
              year: parseInt(year, 10),
              acquired: row[iAcquis]?.trim() || '0',
              taken: row[iPris]?.trim() || '0',
              pending: row[iAttente]?.trim() || '0',
            } as never).onConflictDoNothing()

            imported.push(lineNum)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            errors.push(`Ligne ${lineNum} : ${msg}`)
          }
        }
      }

      // ── Other types — placeholder ─────────────────────────────────────────
      else {
        warnings.push(`Import de type "${type}" : traitement non encore configuré pour ce modèle`)
      }

      return reply.send({
        success: errors.length === 0,
        imported: imported.length,
        errors,
        warnings,
      })
    },
  })

  // ── GET /settings/workflow ─────────────────────────────────────────────────
  fastify.get('/workflow', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['settings'], summary: 'Configuration des workflows de validation' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const schemaName = request.user.schemaName ?? ''

      // Ensure table exists for existing tenants (safe lazy migration)
      await pool.query(
        `CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_configs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          module VARCHAR(50) NOT NULL UNIQUE,
          levels_count INT NOT NULL DEFAULT 1,
          level1_role VARCHAR(50) NOT NULL DEFAULT 'manager',
          level2_role VARCHAR(50),
          level3_role VARCHAR(50),
          level4_role VARCHAR(50),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      )
      await pool.query(
        `INSERT INTO "${schemaName}".workflow_configs (module, levels_count, level1_role)
         VALUES ('absences', 1, 'manager'), ('expenses', 1, 'manager')
         ON CONFLICT (module) DO NOTHING`,
      )

      const rows = await pool.query<{
        id: string; module: string; levels_count: number
        level1_role: string; level2_role: string | null
        level3_role: string | null; level4_role: string | null
        updated_at: string
      }>(
        `SELECT * FROM "${schemaName}".workflow_configs ORDER BY module`,
      )
      return reply.send({ data: rows.rows })
    },
  })

  // ── PUT /settings/workflow/:module ─────────────────────────────────────────
  fastify.put('/workflow/:module', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Mettre à jour la config workflow d\'un module' },
    handler: async (request, reply) => {
      const schemaName = request.user.schemaName ?? ''
      const { module } = request.params as { module: string }
      const body = request.body as {
        levelsCount: number
        level1Role: string
        level2Role?: string | null
        level3Role?: string | null
        level4Role?: string | null
      }

      if (!['absences', 'expenses'].includes(module)) {
        return reply.status(422).send({ error: 'Module invalide' })
      }
      if (body.levelsCount < 1 || body.levelsCount > 4) {
        return reply.status(422).send({ error: 'levelsCount doit être entre 1 et 4' })
      }

      const res = await pool.query<{ id: string }>(
        `INSERT INTO "${schemaName}".workflow_configs
           (module, levels_count, level1_role, level2_role, level3_role, level4_role, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (module) DO UPDATE SET
           levels_count = EXCLUDED.levels_count,
           level1_role  = EXCLUDED.level1_role,
           level2_role  = EXCLUDED.level2_role,
           level3_role  = EXCLUDED.level3_role,
           level4_role  = EXCLUDED.level4_role,
           updated_at   = NOW()
         RETURNING *`,
        [
          module,
          body.levelsCount,
          body.level1Role,
          body.level2Role ?? null,
          body.level3Role ?? null,
          body.level4Role ?? null,
        ],
      )
      return reply.send({ data: res.rows[0] })
    },
  })

  // ════════════════════════════════════════════════════════════════════════════
  // APP SETTINGS (appearance, notifications, integrations)
  // ════════════════════════════════════════════════════════════════════════════

  /** Ensure app_settings table exists (lazy migration) */
  async function ensureAppSettings(schemaName: string): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  }

  async function getAppSetting(schemaName: string, key: string): Promise<Record<string, unknown>> {
    await ensureAppSettings(schemaName)
    const res = await pool.query<{ value: Record<string, unknown> }>(
      `SELECT value FROM "${schemaName}".app_settings WHERE key = $1`,
      [key],
    )
    return res.rows[0]?.value ?? {}
  }

  async function setAppSetting(schemaName: string, key: string, value: Record<string, unknown>): Promise<void> {
    await ensureAppSettings(schemaName)
    await pool.query(
      `INSERT INTO "${schemaName}".app_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    )
  }

  // ── GET /settings/appearance ────────────────────────────────────────────────
  fastify.get('/appearance', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['settings'], summary: 'Paramètres d\'apparence' },
    handler: async (request, reply) => {
      const schemaName = request.user.schemaName ?? ''
      // Colors come from platform.tenants (source of truth)
      const tenantRes = await pool.query<{ primary_color: string; secondary_color: string; logo_url: string | null }>(
        `SELECT primary_color, secondary_color, logo_url FROM platform.tenants WHERE schema_name = $1`,
        [schemaName],
      )
      const tenant = tenantRes.rows[0]
      const extra = await getAppSetting(schemaName, 'appearance')
      return reply.send({
        data: {
          primaryColor:   tenant?.primary_color   ?? '#4F46E5',
          secondaryColor: tenant?.secondary_color ?? '#818CF8',
          logoUrl:        tenant?.logo_url        ?? null,
          density:        extra['density']        ?? 'comfortable',
          sidebarStyle:   extra['sidebarStyle']   ?? 'full',
          fontFamily:     extra['fontFamily']     ?? 'inter',
          theme:          extra['theme']          ?? 'light',
        },
      })
    },
  })

  // ── PATCH /settings/appearance ──────────────────────────────────────────────
  fastify.patch('/appearance', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Mettre à jour l\'apparence' },
    handler: async (request, reply) => {
      const schemaName = request.user.schemaName ?? ''
      const body = request.body as {
        primaryColor?: string
        secondaryColor?: string
        density?: string
        sidebarStyle?: string
        fontFamily?: string
        theme?: string
      }

      // Update colors in platform.tenants
      if (body.primaryColor || body.secondaryColor) {
        await pool.query(
          `UPDATE platform.tenants
           SET primary_color   = COALESCE($1, primary_color),
               secondary_color = COALESCE($2, secondary_color),
               updated_at      = NOW()
           WHERE schema_name = $3`,
          [body.primaryColor ?? null, body.secondaryColor ?? null, schemaName],
        )
      }

      // Save extra appearance settings
      const current = await getAppSetting(schemaName, 'appearance')
      await setAppSetting(schemaName, 'appearance', {
        ...current,
        ...(body.density      && { density: body.density }),
        ...(body.sidebarStyle && { sidebarStyle: body.sidebarStyle }),
        ...(body.fontFamily   && { fontFamily: body.fontFamily }),
        ...(body.theme        && { theme: body.theme }),
      })

      return reply.send({
        data: {
          primaryColor:   body.primaryColor   ?? null,
          secondaryColor: body.secondaryColor ?? null,
          density:        body.density        ?? null,
          sidebarStyle:   body.sidebarStyle   ?? null,
          fontFamily:     body.fontFamily     ?? null,
          theme:          body.theme          ?? null,
        },
      })
    },
  })

  // ── GET /settings/notifications ─────────────────────────────────────────────
  fastify.get('/notifications', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['settings'], summary: 'Paramètres de notifications' },
    handler: async (request, reply) => {
      const schemaName = request.user.schemaName ?? ''
      const value = await getAppSetting(schemaName, 'notifications')
      // Default notification settings if not configured
      const defaults: Record<string, { channel: string; enabled: boolean }> = {
        absence_request:  { channel: 'email', enabled: true },
        absence_approved: { channel: 'email', enabled: true },
        absence_rejected: { channel: 'email', enabled: true },
        expense_submitted:{ channel: 'email', enabled: true },
        expense_approved: { channel: 'email', enabled: true },
        contract_expiry:  { channel: 'email', enabled: true },
        trial_expiry:     { channel: 'email', enabled: true },
        payslip_available:{ channel: 'email', enabled: true },
        new_employee:     { channel: 'email', enabled: false },
        birthday:         { channel: 'app',   enabled: true },
      }
      // Merge saved settings over defaults
      const merged: Record<string, { channel: string; enabled: boolean }> = { ...defaults }
      for (const [k, v] of Object.entries(value)) {
        if (k in merged) merged[k] = v as { channel: string; enabled: boolean }
      }
      return reply.send({ data: merged })
    },
  })

  // ── PATCH /settings/notifications ───────────────────────────────────────────
  fastify.patch('/notifications', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['settings'], summary: 'Mettre à jour les notifications' },
    handler: async (request, reply) => {
      const schemaName = request.user.schemaName ?? ''
      const body = request.body as Record<string, { channel: string; enabled: boolean }>
      const current = await getAppSetting(schemaName, 'notifications')
      await setAppSetting(schemaName, 'notifications', { ...current, ...body })
      return reply.send({ success: true })
    },
  })

  // ── GET /settings/integrations ──────────────────────────────────────────────
  fastify.get('/integrations', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Liste des intégrations configurées' },
    handler: async (request, reply) => {
      const schemaName = request.user.schemaName ?? ''
      const value = await getAppSetting(schemaName, 'integrations')
      return reply.send({ data: value })
    },
  })

  // ── POST /settings/integrations/:id ─────────────────────────────────────────
  fastify.post('/integrations/:id', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Sauvegarder config intégration' },
    handler: async (request, reply) => {
      const schemaName = request.user.schemaName ?? ''
      const { id } = request.params as { id: string }
      const config = request.body as Record<string, string>

      const current = await getAppSetting(schemaName, 'integrations') as Record<string, unknown>
      current[id] = { connected: true, configuredAt: new Date().toISOString(), ...config }
      await setAppSetting(schemaName, 'integrations', current)
      return reply.send({ success: true, integrationId: id })
    },
  })

  // ── DELETE /settings/integrations/:id ───────────────────────────────────────
  fastify.delete('/integrations/:id', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Déconnecter une intégration' },
    handler: async (request, reply) => {
      const schemaName = request.user.schemaName ?? ''
      const { id } = request.params as { id: string }
      const current = await getAppSetting(schemaName, 'integrations') as Record<string, unknown>
      delete current[id]
      await setAppSetting(schemaName, 'integrations', current)
      return reply.send({ success: true })
    },
  })

  // ── POST /settings/integrations/:id/test ────────────────────────────────────
  fastify.post('/integrations/:id/test', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['settings'], summary: 'Tester une intégration' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const config = request.body as Record<string, string>

      // Light validation: check required fields are non-empty
      const REQUIRED: Record<string, string[]> = {
        google:    ['clientId', 'clientSecret'],
        microsoft: ['tenantId', 'clientId', 'clientSecret'],
        slack:     ['webhookUrl'],
        teams:     ['webhookUrl'],
        docusign:  ['integrationKey', 'secretKey'],
        yousign:   ['apiKey'],
        silae:     ['url', 'login', 'password'],
        payfit:    ['apiKey', 'companyId'],
        workday:   ['tenant', 'username', 'password'],
        bamboohr:  ['subdomain', 'apiKey'],
        zapier:    ['webhookUrl'],
        webhook:   ['url'],
      }

      const required = REQUIRED[id] ?? []
      const missing = required.filter((k) => !config[k])

      if (missing.length > 0) {
        return reply.status(422).send({
          success: false,
          message: `Champs requis manquants : ${missing.join(', ')}`,
        })
      }

      // For Slack/Teams/Zapier/Webhook: test the webhook URL format
      if (['slack', 'teams', 'zapier', 'webhook'].includes(id) && config['webhookUrl']) {
        try {
          new URL(config['webhookUrl'] ?? config['url'] ?? '')
        } catch {
          return reply.status(422).send({ success: false, message: 'URL invalide. Vérifiez le format.' })
        }
      }

      // Configuration looks valid — return success (real connectivity test would call external APIs)
      return reply.send({
        success: true,
        message: `Configuration validée pour ${id}. Sauvegardez pour activer l'intégration.`,
      })
    },
  })

  // Cleanup
  fastify.addHook('onClose', async () => {
    await pool.end().catch(() => undefined)
  })
}

export default settingsRoutes
