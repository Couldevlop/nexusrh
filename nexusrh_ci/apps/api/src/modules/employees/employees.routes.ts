import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { encryptIfPresent, decryptIfPresent } from '@nexusrhci/shared/crypto'
import { describeDbError } from '../../utils/db-error.js'
import { insertEmployeeRecord, afterEmployeeCreated } from '../../services/employee-create.service.js'
import { archiveEmployeeCascade } from '../../services/employee-archive.service.js'
import { encodeField } from '../sage/sage.service.js'
import { parseInterviewFocus } from '../../services/interview-focus.service.js'
import { scanBuffer, scanRejectionMessage } from '../../services/antivirus.service.js'
import { auditTenant } from '../../utils/audit-log.js'
import { canonicalEmployeeMmProvider } from '../../services/mobile-money-providers.js'
import { isValidSocialId } from './social-id.js'
import { actorEmployeeSql } from '../../utils/actor-employee.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { EMPLOYEE_NUMBER_MAX_LENGTH } from '../../db/employee-number.js'
import {
  isInManagerScope, managerScopeSql, resolveManagerEmployeeId,
  wouldCreateManagerCycle,
} from '../../services/manager-scope.service.js'
import { loadEmployeeTenantContext } from '../../services/employee-tenant-context.service.js'
import { currencyLabel, type LegislationPack } from '../../services/legislation-packs.js'
import {
  parseFieldDefinitions, redactCustomFields, validateCustomFieldValues,
  type CustomFieldError,
} from '../../services/employee-custom-fields.service.js'

// SMIG du pays de l'employé (pack législatif), plus de 75 000 FCFA en dur.
function smigError(pack: LegislationPack, baseSalary: number): string | null {
  if (baseSalary >= pack.smigMensuel) return null
  // Séparateur de milliers = espace simple (toLocaleString('fr-FR') insère une
  // espace fine insécable, qui changerait le message historique).
  const amount = String(pack.smigMensuel).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `Le salaire ne peut pas être inférieur au SMIG (${amount} ${currencyLabel(pack.currency)})`
}

function customFieldsError(errors: CustomFieldError[]) {
  return {
    error: 'Champs personnalisés invalides',
    details: errors.map((e) => ({ path: `customFields.${e.key}`, message: e.message })),
  }
}

// Définitions des champs personnalisés du tenant (lecture seule). Échec de
// lecture → aucune définition : redactCustomFields masque alors tout (fail-closed).
async function loadCustomFieldDefinitions(schema: string) {
  try {
    const r = await pool.query<{ employee_custom_fields: unknown }>(
      `SELECT employee_custom_fields FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
    )
    return parseFieldDefinitions(r?.rows?.[0]?.employee_custom_fields)
  } catch {
    return []
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A08-2 — la photo de profil est servie par un endpoint AUTHENTIFIÉ tenant-scopé.
// On stocke une URL RELATIVE (chemin d'API) et non une URL publique absolue :
// le front l'appelle via son client authentifié.
export const employeePhotoUrl = (employeeId: string) => `/employees/${employeeId}/photo`

// EMP-003/004/005 — validations de format (NNI, CNPS, Mobile Money).
// Champs optionnels : '' / null → undefined (non fourni) ; sinon le format est
// imposé. NNI/CNPS = format ivoirien (l'employeur est en CI) ; le téléphone
// Mobile Money accepte toute la zone africaine (employés CI, Burkina, Mali…).
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v)
const nniField = z.preprocess(emptyToUndef,
  z.string().regex(/^CI\d{9,13}$/, 'NNI invalide : format attendu CI suivi de 9 à 13 chiffres (ex : CI123456789)').optional())
const cnpsField = z.preprocess(emptyToUndef,
  z.string().refine(isValidSocialId,
    'Numéro de sécurité sociale invalide : CNPS CI = CI + 8 chiffres + 1 lettre (ex : CI12345678A) ; hors Côte d\'Ivoire = code pays + numéro (ex : BJ-1234567)').optional())
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

// Matricule saisi à la main (sinon généré par la base : MAT00001…). Caractères
// limités à ce qu'acceptent les imports SAGE / fichiers bancaires.
const EMPLOYEE_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const employeeNumberField = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : emptyToUndef(v)),
  z.string()
    .max(EMPLOYEE_NUMBER_MAX_LENGTH, `Matricule trop long (${EMPLOYEE_NUMBER_MAX_LENGTH} caractères maximum)`)
    .regex(EMPLOYEE_NUMBER_RE, 'Matricule invalide : lettres, chiffres, point, tiret, slash ou souligné uniquement (ex : MAT00012)')
    .optional())

const EMPLOYEE_NUMBER_TAKEN_MESSAGE = 'Ce matricule est déjà attribué à un autre employé.'

/**
 * Matricule déjà porté par une AUTRE fiche active du tenant ? Contrôle
 * applicatif (message clair) ; l'index UNIQUE partiel reste le filet en cas
 * de course entre deux saisies simultanées.
 */
async function employeeNumberTaken(schema: string, employeeNumber: string, excludeId: string | null): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM "${schema}".employees
      WHERE employee_number = $1 AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      LIMIT 1`,
    [employeeNumber, excludeId],
  )
  return (r?.rows?.length ?? 0) > 0
}

const EMPLOYEE_UNIQUE_MESSAGES = {
  email: 'Un employé avec cet email existe déjà.',
  employee_number: EMPLOYEE_NUMBER_TAKEN_MESSAGE,
}

// OWASP A03 — validation Zod du body POST /employees
// Opérateur Mobile Money : formes historiques (mtn_momo/orange_money) acceptées,
// toujours ÉCRITES sous la forme canonique du formulaire (wave|mtn|orange|cofina).
const mmProviderField = z.enum(['wave', 'mtn', 'mtn_momo', 'orange', 'orange_money', 'cofina'])
  .transform((v) => canonicalEmployeeMmProvider(v) ?? v)
  .optional()

const createEmployeeSchema = z.object({
  firstName:           z.string().min(1).max(100).trim(),
  lastName:            z.string().min(1).max(100).trim(),
  email:               z.string().email().max(255).optional(),
  phone:               z.string().max(30).optional(),
  birthDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender:              z.enum(['M', 'F', 'X']).optional(),
  nni:                 nniField,
  cnpsNumber:          cnpsField,
  mobileMoneyProvider: mmProviderField,
  mobileMoneyPhone:    mmPhoneField,
  departmentId:        z.string().uuid().optional(),
  managerId:           z.string().uuid().optional(),
  // MPF-005 — rattachement à une filiale (legal_entity) pour la paie multi-pays
  legalEntityId:       z.string().uuid().optional(),
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
  paymentMethod:       z.enum(['mobile_money', 'bank_transfer']).optional(),
  city:                z.string().max(100).optional(),
  maritalStatus:       z.enum(['single', 'married', 'divorced', 'widowed', 'cohabiting']).optional(),
  nationality:         z.string().trim().min(2).max(100).optional(),
  childrenCount:       z.number().int().min(0).max(30).optional(),
  // Champs personnalisés du tenant — validés contre leur définition au handler.
  customFields:        z.record(z.unknown()).optional(),
  // Matricule : facultatif, généré automatiquement (MAT00001…) si absent.
  employeeNumber:      employeeNumberField,
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
  mobileMoneyProvider: mmProviderField,
  mobileMoneyPhone:    mmPhoneField,
  departmentId:        z.string().uuid().nullable().optional(),
  managerId:           z.string().uuid().nullable().optional(),
  // MPF-005 — réaffectation d'un employé à une autre filiale (ou détachement)
  legalEntityId:       z.string().uuid().nullable().optional(),
  jobTitle:            z.string().max(200).optional(),
  jobLevel:            z.string().max(50).optional(),
  contractType:        z.enum(['cdi', 'cdd', 'saisonnier', 'apprentissage', 'stage', 'mise_a_disposition']).optional(),
  hireDate:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  baseSalary:          z.number().int().min(0).max(100_000_000).optional(),
  weeklyHours:         z.number().min(1).max(60).optional(),
  professionalCategory: z.string().max(50).optional(),
  iban:                z.string().max(50).optional(),
  bankName:            z.string().max(100).optional(),
  paymentMethod:       z.enum(['mobile_money', 'bank_transfer']).optional(),
  city:                z.string().max(100).optional(),
  maritalStatus:       z.enum(['single', 'married', 'divorced', 'widowed', 'cohabiting']).optional(),
  nationality:         z.string().trim().min(2).max(100).optional(),
  childrenCount:       z.number().int().min(0).max(30).optional(),
  isActive:            z.boolean().optional(),
  profilePhotoUrl:     z.string().max(2000).optional(),
  address:             z.string().max(500).optional(),
  customFields:        z.record(z.unknown()).optional(),
  // Matricule modifiable par les RH (vide = inchangé : un matricule ne s'efface pas).
  employeeNumber:      employeeNumberField,
}).strict()

// Champs qu'un employee a le droit de modifier sur son propre profil (subset
// strict de patchEmployeeSchema). Les autres clés sont écartées même en self.
// L'IBAN est modifiable par l'employé (self-service paie) — chiffré en base.
const EMPLOYEE_SELF_FIELDS = new Set([
  'phone', 'address', 'mobileMoneyProvider', 'mobileMoneyPhone', 'profilePhotoUrl',
  'iban', 'bankName', 'paymentMethod',
])

function auditLogEmployee(
  schema: string, userId: string, action: string,
  employeeId: string, changes: Record<string, unknown>, ip: string | null,
): void {
  auditTenant(schema, { userId: userId, action: action, entity: 'employee', entityId: employeeId, changes: changes, ip: ip })
}

/** Rôles d'un utilisateur de tenant (tout sauf la plateforme). */
const TENANT_USER_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'raf_site', 'dg'] as const

/**
 * Objets d'audit rattachés à un salarié : entité d'audit → table portant
 * `employee_id`. L'entrée d'audit vise l'id de la ligne (absence, bulletin…).
 */
const ACCESS_LOG_SOURCES: ReadonlyArray<{ entities: readonly string[]; table: string }> = [
  { entities: ['absence'], table: 'absences' },
  { entities: ['expense_report'], table: 'expense_reports' },
  { entities: ['payslip', 'pay_slip'], table: 'pay_slips' },
  { entities: ['contract', 'contrat'], table: 'contracts' },
  { entities: ['disciplinary_action'], table: 'disciplinary_actions' },
  { entities: ['offboarding_case'], table: 'offboarding_cases' },
  { entities: ['career'], table: 'evaluations' },
]

/**
 * SQL du journal d'accès d'UN salarié ($1 = employee_id, $2 = user connecté). Seules les tables
 * présentes dans le schéma (`present`) sont interrogées : un tenant ancien sans
 * table de sanctions/sorties ne fait pas échouer la requête.
 */
function accessLogSql(schema: string, present: ReadonlySet<string>): string {
  const clauses = [
    // La fiche elle-même, et les actions « carrière » ciblant directement la fiche.
    `(al.entity IN ('employee', 'career') AND al.entity_id = $1)`,
    ...ACCESS_LOG_SOURCES.filter(s => present.has(s.table)).map(s =>
      `(al.entity IN (${s.entities.map(e => `'${e}'`).join(', ')})
         AND al.entity_id IN (SELECT id FROM "${schema}".${s.table} WHERE employee_id = $1))`),
  ]
  return `SELECT al.id, al.action, al.entity, al.entity_id, al.ip_address, al.created_at,
                 u.first_name AS actor_first_name, u.last_name AS actor_last_name,
                 u.role AS actor_role, (al.user_id = $2::uuid) AS actor_is_self
            FROM "${schema}".audit_log al
            LEFT JOIN "${schema}".users u ON u.id = al.user_id
           WHERE ${clauses.join(' OR ')}
           ORDER BY al.created_at DESC
           LIMIT 20`
}

/** RIB masqué pour l'affichage en liste : « •••• 1234 » (jamais le RIB complet). */
function maskIban(iban: string): string {
  const compact = iban.replace(/\s/g, '')
  return compact.length <= 4 ? '••••' : `•••• ${compact.slice(-4)}`
}

const employeesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

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
        where += ` AND (lower(e.first_name) LIKE $${idx} OR lower(e.last_name) LIKE $${idx} OR e.cnps_number LIKE $${idx} OR lower(e.employee_number) LIKE $${idx})`
        params.push(`%${search.toLowerCase()}%`); idx++
      }
      // Si manager : filtre équipe directe (OWASP A01 fail-closed : sans dossier
      // employé associé, il ne voit personne au lieu de tout le tenant).
      // On privilégie l'employeeId du token (autoritatif) ; repli sur l'email
      // (l'ancienne recherche par email seule pouvait retourner un mauvais
      // dossier quand l'email n'est pas unique → équipe vide à tort).
      // Périmètre : équipe directe ou toute la branche selon le réglage tenant.
      if (request.user.role === 'manager') {
        const mgrId = await resolveManagerEmployeeId(pool, schema, request.user)
        if (!mgrId) return reply.send({ data: [], total: 0, page, limit })
        where += ` AND ${managerScopeSql(schema, 'e', `$${idx++}`)}`; params.push(mgrId)
      }

      // total réel (mêmes filtres) — affiché « 80+ employés » même en page 1.
      const countRes = await pool.query(`SELECT count(*)::int AS c FROM "${schema}".employees e ${where}`, params)
      const total = countRes.rows[0]?.c ?? 0

      // Compte utilisateur lié : lien explicite users.employee_id d'abord,
      // repli sur l'égalité d'email pour les comptes non encore rattachés.
      const listSql = `SELECT e.*, d.name AS department_name,
                              lu.id AS linked_user_id, lu.role AS linked_user_role
                       FROM "${schema}".employees e
                       LEFT JOIN "${schema}".departments d ON d.id = e.department_id
                       LEFT JOIN LATERAL (
                         SELECT u.id, u.role FROM "${schema}".users u
                          WHERE u.employee_id = e.id
                             OR (u.employee_id IS NULL AND e.email IS NOT NULL AND lower(u.email) = lower(e.email))
                          ORDER BY (u.employee_id = e.id) DESC NULLS LAST
                          LIMIT 1
                       ) lu ON true
                       ${where}
                       ORDER BY e.last_name, e.first_name
                       LIMIT $${idx++} OFFSET $${idx++}`
      const res = await pool.query(listSql, [...params, limit, offset])

      // RIB : jamais le chiffré dans la liste ; RH → RIB MASQUÉ (4 derniers
      // caractères) pour l'affichage du mode de paiement. Compte lié : RH only.
      const isHr = ['admin', 'hr_manager', 'hr_officer'].includes(request.user.role)
      for (const row of res.rows as Array<Record<string, unknown>>) {
        const iban = isHr && typeof row.iban === 'string' ? decryptIfPresent(row.iban) : null
        row.iban_masked = iban ? maskIban(iban) : null
        delete row.iban
        if (!isHr) { row.linked_user_id = null; row.linked_user_role = null }
      }

      // Champs personnalisés sensibles : réservés aux rôles RH (A01).
      if (!isHr && res.rows.length) {
        const defs = await loadCustomFieldDefinitions(schema)
        for (const row of res.rows) row.custom_fields = redactCustomFields(defs, row.custom_fields)
      }

      return reply.send({ data: res.rows, total, page, limit })
    },
  })

  // GET /employees/me/access-log — journal d'accès ARTCI (loi CI 2013-450) :
  // « qui a accédé à VOS données RH ». Ne liste QUE les entrées d'audit dont
  // l'objet concerne la fiche du salarié connecté (sa fiche, ses absences,
  // bulletins, notes de frais, contrats, sanctions, dossier de sortie,
  // évaluations) — jamais les actions que l'utilisateur a faites sur les
  // données d'AUTRES salariés. Auteur (nom + rôle) joint pour la transparence.
  fastify.get('/me/access-log', {
    preHandler: [fastify.authorize(...TENANT_USER_ROLES)],
    schema: { tags: ['employees'], summary: 'Journal des accès à mes données personnelles (ARTCI)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        let employeeId = request.user.employeeId ?? null
        if (!employeeId) {
          const r = await pool.query<{ id: string | null }>(actorEmployeeSql(schema), [request.user.email])
          employeeId = r.rows[0]?.id ?? null
        }
        // Sans fiche employé liée, aucune donnée RH personnelle : liste vide
        // (fail-closed — surtout pas un repli sur les actions de l'utilisateur).
        if (!employeeId) return reply.send({ data: [] })
        const tables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
          [schema, ACCESS_LOG_SOURCES.map(s => s.table)],
        )
        const present = new Set(tables.rows.map(r => r.table_name))
        const res = await pool.query(accessLogSql(schema, present), [employeeId, request.user.sub])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
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
                m.first_name AS manager_first_name, m.last_name AS manager_last_name,
                lu.id AS linked_user_id, lu.role AS linked_user_role
         FROM "${schema}".employees e
         LEFT JOIN "${schema}".departments d ON d.id = e.department_id
         LEFT JOIN "${schema}".employees m ON m.id = e.manager_id
         LEFT JOIN LATERAL (
           SELECT u.id, u.role FROM "${schema}".users u
            WHERE u.employee_id = e.id
               OR (u.employee_id IS NULL AND e.email IS NOT NULL AND lower(u.email) = lower(e.email))
            ORDER BY (u.employee_id = e.id) DESC NULLS LAST
            LIMIT 1
         ) lu ON true
         WHERE e.id = $1 AND e.deleted_at IS NULL LIMIT 1`,
        [id]
      )

      if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })

      const emp = res.rows[0]

      // OWASP A01 — contrôle d'accès fin par rôle :
      // - employee : uniquement son propre dossier
      // - manager : uniquement un membre de son périmètre (équipe directe ou
      //   branche selon le réglage tenant) — même règle que la liste.
      if (request.user.role === 'employee' && emp.email !== request.user.email) {
        return reply.status(403).send({ error: 'Accès interdit' })
      }
      if (request.user.role === 'manager') {
        const mgrId = await resolveManagerEmployeeId(pool, schema, request.user)
        const isSelf = emp.email === request.user.email || (!!mgrId && emp.id === mgrId)
        if (!mgrId || (!isSelf && !(await isInManagerScope(pool, schema, mgrId, emp.id)))) {
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
        emp.custom_fields = redactCustomFields(await loadCustomFieldDefinitions(schema), emp.custom_fields)
      }
      // Compte utilisateur lié : information d'administration, rôles RH seulement.
      if (!['admin', 'hr_manager', 'hr_officer'].includes(request.user.role)) {
        emp.linked_user_id = null
        emp.linked_user_role = null
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
      const schema = request.user.schemaName

      // Pays de l'employé (filiale ou tenant) + champs personnalisés du tenant.
      const ctx = await loadEmployeeTenantContext(pool, schema, body.legalEntityId)
      const smig = smigError(ctx.legislation.legislationPack, body.baseSalary)
      if (smig) return reply.status(422).send({ error: smig })
      const custom = validateCustomFieldValues(ctx.customFields, body.customFields, 'create')
      if (!custom.ok) return reply.status(400).send(customFieldsError(custom.errors))

      // Matricule saisi : unicité vérifiée avant l'INSERT (message clair). Non
      // fourni → NULL, la base attribue le prochain matricule (trigger).
      if (body.employeeNumber) {
        try {
          if (await employeeNumberTaken(schema, body.employeeNumber, null)) {
            return reply.status(409).send({ error: EMPLOYEE_NUMBER_TAKEN_MESSAGE, code: 'EMPLOYEE_NUMBER_TAKEN' })
          }
        } catch (err) {
          request.log.error({ err, schema, action: 'employee.create' }, 'Échec contrôle matricule')
          return reply.status(500).send({
            error: "Impossible d'enregistrer l'employé pour le moment. Réessayez ou contactez le support.",
          })
        }
      }

      let created
      try {
        created = await insertEmployeeRecord(pool, schema, body, custom.values)
      } catch (err) {
        // Aucune erreur technique brute ne doit remonter : message personnalisé.
        const mapped = describeDbError(err, {
          entity: 'employé',
          uniqueMessages: EMPLOYEE_UNIQUE_MESSAGES,
        })
        request.log.error({ err, schema, action: 'employee.create' }, 'Échec création employé')
        if (mapped) return reply.status(mapped.statusCode).send({ error: mapped.error, code: mapped.code })
        return reply.status(500).send({
          error: "Impossible d'enregistrer l'employé pour le moment. Réessayez ou contactez le support.",
        })
      }

      // Audit (A09), webhooks `employee.created` et parcours d'intégration
      // auto-démarré : voie partagée avec l'embauche depuis le recrutement.
      afterEmployeeCreated(pool, schema, created, body,
        { userId: request.user.sub, ip: request.ip ?? null }, { startOnboarding: true })

      return reply.status(201).send({ data: created })
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

      // Responsable hiérarchique : ni soi-même, ni l'un de ses subordonnés
      // (sinon boucle A → B → A dans la hiérarchie).
      if (typeof body.managerId === 'string'
          && await wouldCreateManagerCycle(pool, schema, id, body.managerId)) {
        return reply.status(422).send({
          error: 'Responsable invalide : un employé ne peut pas dépendre de lui-même ni de l\'un de ses subordonnés.',
        })
      }

      // EMP-010 — capter l'ancien salaire AVANT l'UPDATE pour historiser le
      // changement (augmentation/baisse) dans hr_events après le succès. La
      // même lecture donne la filiale (pays du SMIG) et les champs personnalisés
      // existants (fusion).
      let oldSalary: number | null = null
      if (body.baseSalary != null || body.customFields !== undefined) {
        const prev = await pool.query<{
          base_salary: string | null; legal_entity_id: string | null; custom_fields: unknown
        }>(
          `SELECT base_salary, legal_entity_id, custom_fields FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [id])
        const cur = prev.rows[0]
        oldSalary = cur?.base_salary != null ? Number(cur.base_salary) : null
        const legalEntityId = body.legalEntityId !== undefined
          ? (body.legalEntityId as string | null) : (cur?.legal_entity_id ?? null)
        const ctx = await loadEmployeeTenantContext(pool, schema, legalEntityId)

        // SMIG du pays de l'employé si modification du salaire
        if (body.baseSalary != null) {
          const smig = smigError(ctx.legislation.legislationPack, Number(body.baseSalary))
          if (smig) return reply.status(422).send({ error: smig })
        }
        if (body.customFields !== undefined) {
          const custom = validateCustomFieldValues(ctx.customFields, body.customFields, 'update', cur?.custom_fields)
          if (!custom.ok) return reply.status(400).send(customFieldsError(custom.errors))
          body.customFields = custom.values
        }
      }

      // Matricule : vide = inchangé ; sinon unicité vérifiée (hors fiche courante).
      if (body.employeeNumber === undefined) delete body.employeeNumber
      if (typeof body.employeeNumber === 'string') {
        try {
          if (await employeeNumberTaken(schema, body.employeeNumber, id)) {
            return reply.status(409).send({ error: EMPLOYEE_NUMBER_TAKEN_MESSAGE, code: 'EMPLOYEE_NUMBER_TAKEN' })
          }
        } catch (err) {
          request.log.error({ err, schema, action: 'employee.update', id }, 'Échec contrôle matricule')
          return reply.status(500).send({
            error: "Impossible de modifier l'employé pour le moment. Réessayez ou contactez le support.",
          })
        }
      }

      // Zod a déjà filtré les champs autorisés. On convertit juste camelCase
      // → snake_case pour l'UPDATE SQL et on chiffre le NNI sensible.
      const sets: string[] = []
      const vals: unknown[] = []
      const modifiedKeys: string[] = []
      let idx = 1
      for (const [k, v] of Object.entries(body)) {
        const dbKey = k.replace(/([A-Z])/g, '_$1').toLowerCase()
        if (dbKey === 'address' || dbKey === 'custom_fields') {
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
          uniqueMessages: EMPLOYEE_UNIQUE_MESSAGES,
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

  // GET /employees/:id/interview-focus — profil technique structuré (RH only,
  // PAS de self-service — contrairement à PATCH /:id, l'employé n'a jamais
  // accès à sa propre fiche ici).
  fastify.get('/:id/interview-focus', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureTenantSchema(schema)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      try {
        const res = await pool.query<{ interview_focus: unknown }>(
          `SELECT interview_focus FROM "${schema}".employees WHERE id = $1 LIMIT 1`,
          [id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })
        const focus = parseInterviewFocus(res.rows[0].interview_focus)
        return reply.send({ data: { focus: focus ?? { technologies: [], tools: [], methodologies: [], languages: [] } } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PUT /employees/:id/interview-focus — enregistre le profil technique.
  fastify.put('/:id/interview-focus', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureTenantSchema(schema)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const body = (request.body ?? {}) as { focus?: unknown }
      const focus = parseInterviewFocus(body.focus)
      if (focus === null) return reply.status(400).send({ error: 'Profil technique invalide' })
      try {
        const res = await pool.query<{ id: string }>(
          `UPDATE "${schema}".employees SET interview_focus = $1, updated_at = now()
           WHERE id = $2 RETURNING id`,
          [JSON.stringify(focus), id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })
        auditTenant(schema, { userId: request.user.sub, action: 'employees.interview_focus_updated', entity: 'employee', entityId: id, changes: { focus }, ip: request.ip ?? null })
        return reply.send({ data: { focus } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
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

  // GET /employees/manager-options — choix du responsable hiérarchique dans les
  // formulaires RH. Tous les employés actifs, sans pagination (la liste paginée
  // plafonne à 200) et avec le strict minimum (aucun salaire ni donnée sensible).
  fastify.get('/manager-options', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['employees'], summary: 'Responsables hiérarchiques sélectionnables' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await pool.query(
        `SELECT id, first_name, last_name, job_title
         FROM "${schema}".employees
         WHERE deleted_at IS NULL AND is_active = true
         ORDER BY last_name, first_name`
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

  // EMP-015 / A08-2 — POST /employees/:id/photo : upload de la photo de profil.
  // SÉCURITÉ (audit OWASP A08-2) : la photo est une DONNÉE PERSONNELLE. Elle est
  // stockée dans "<schema>".employee_photos (table TENANT-SCOPÉE) et JAMAIS dans
  // platform.brand_assets (table globale cross-tenant servie sans auth par
  // /public/brand/:id, réservée aux logos publics). Elle n'est lisible que par
  // GET /employees/:id/photo (authentifié, schéma issu du JWT).
  // A08-6 : UPSERT sur employee_id → une seule ligne par employé (l'ancienne
  // image est écrasée, pas empilée).
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
      // OWASP A08 — analyse antivirale (désactivée si CLAMAV_HOST absent).
      const av = await scanBuffer(buf)
      if (!av.clean) return reply.status(400).send({ error: scanRejectionMessage(av) })
      try {
        // URL RELATIVE vers l'endpoint authentifié (jamais une URL publique
        // absolue : une URL publique qui fuit reste accessible à vie).
        const url = employeePhotoUrl(id)
        const upd = await pool.query(
          `UPDATE "${schema}".employees SET profile_photo_url = $1, updated_at = now()
           WHERE id = $2 AND deleted_at IS NULL RETURNING id`, [url, id])
        if (!upd.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })
        await pool.query(
          `INSERT INTO "${schema}".employee_photos (employee_id, mime, bytes, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (employee_id) DO UPDATE
             SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
                 size_bytes = EXCLUDED.size_bytes, uploaded_by = EXCLUDED.uploaded_by,
                 updated_at = now()`,
          [id, mime, buf, buf.byteLength, request.user.sub])
        auditLogEmployee(schema, request.user.sub, 'employee.photo_updated', id, {}, request.ip ?? null)
        return reply.status(201).send({ data: { profilePhotoUrl: url } })
      } catch (err) {
        request.log.error({ err, schema, id }, 'Échec upload photo employé')
        return reply.status(500).send({ error: "Impossible d'enregistrer la photo. Réessayez." })
      }
    },
  })

  // A08-2 — GET /employees/:id/photo : service AUTHENTIFIÉ et TENANT-SCOPÉ de la
  // photo de profil. Le schéma vient EXCLUSIVEMENT du JWT (jamais du body/query/
  // params) → aucune lecture cross-tenant possible. RBAC aligné sur
  // GET /employees/:id : qui peut voir l'employé peut voir sa photo ; un
  // `employee` ne voit que la sienne ; un `manager` que son équipe directe.
  // Cache-Control: no-store (PII) — cohérent avec la politique de app.ts.
  fastify.get('/:id/photo', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly')],
    schema: { tags: ['employees'], summary: 'Photo de profil d\'un employé (authentifiée)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const schema = request.user.schemaName
      const res = await pool.query<{
        mime: string; bytes: Buffer; email: string | null; manager_id: string | null
      }>(
        `SELECT p.mime, p.bytes, e.email, e.manager_id
           FROM "${schema}".employee_photos p
           JOIN "${schema}".employees e ON e.id = p.employee_id
          WHERE p.employee_id = $1 AND e.deleted_at IS NULL LIMIT 1`, [id])
      const row = res.rows[0]
      if (!row) return reply.status(404).send({ error: 'Photo introuvable' })

      // OWASP A01 — contrôle d'accès fin, identique à GET /employees/:id.
      const isSelf = row.email === request.user.email || request.user.employeeId === id
      if (request.user.role === 'employee' && !isSelf) {
        return reply.status(403).send({ error: 'Accès interdit' })
      }
      if (request.user.role === 'manager' && !isSelf) {
        const mgrId = await resolveManagerEmployeeId(pool, schema, request.user)
        if (!(await isInManagerScope(pool, schema, mgrId, id))) {
          return reply.status(403).send({ error: 'Accès interdit' })
        }
      }

      reply
        .header('Content-Type', row.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
        .header('Pragma', 'no-cache')
      return reply.send(row.bytes)
    },
  })
}

export default employeesRoutes
