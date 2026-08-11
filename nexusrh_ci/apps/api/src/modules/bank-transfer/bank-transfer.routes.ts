/**
 * Virement bancaire des salaires — alternative au Mobile Money.
 *
 * Les employés dont `payment_method = 'bank_transfer'` sont payés par virement
 * sur leur RIB/IBAN. Ce module produit, pour une période de paie, un FICHIER
 * par banque (la liste des virements à exécuter), permet de le télécharger OU
 * de l'envoyer par email à la banque en un clic, et confirme.
 *
 * FORMAT DU FICHIER : chaque banque impose le sien (tableur à colonnes
 * variables, ou texte à positions fixes). Le tenant décrit le format de SA
 * banque dans un « profil » versionné (brouillon → aperçu → activation) ; sans
 * profil actif, on retombe sur le gabarit Excel historique — zéro régression.
 *
 * SÉCURITÉ : paramétrage réservé à `admin` (matrice RBAC : paramétrage tenant),
 * génération/envoi `admin` + `hr_manager` ; profils bornés au schéma du tenant
 * résolu depuis le JWT (A01) ; Zod strict (A03) ; audit de chaque action (A09).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { decryptIfPresent, encryptIfPresent } from '../../utils/crypto.js'
import { sendBankTransferEmail } from '../../services/email.js'
import { loadTenantMailBySchema } from '../../services/tenant-mail.service.js'
import {
  OUTPUT_KINDS, ENCODINGS, DELIMITERS, DATE_FORMATS, TRANSFORMS, SOURCE_CATALOG,
  MAX_COLUMNS, STARTER_PRESETS, isSourceKey, specIssues, buildBankFileAsync,
  previewTable, resolveFilename,
  type BankFileSpec, type BankFileRow, type BankFileContext,
} from './bank-file.service.js'
import { analyzeSample, SampleRejectedError, MAX_SAMPLE_BYTES } from './bank-sample.service.js'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const UUID_RE = /^[0-9a-fA-F-]{36}$/
const CONFIG_ROLES = ['admin'] as const
const OPERATE_ROLES = ['admin', 'hr_manager'] as const
const PREVIEW_ROWS = 10
const MAX_VERSIONS_PER_BANK = 50

/** Migration lazy — DOIT s'exécuter APRÈS l'authentification (sinon schemaName est indéfini). */
async function ensureSchema(request: FastifyRequest): Promise<void> {
  const schema = request.user?.schemaName
  if (schema) await ensureTenantSchema(schema)
}

/** Récupère les virements (RIB déchiffrés) d'une banque pour une période. */
async function fetchTransfers(schema: string, month: string, bank: string): Promise<BankFileRow[]> {
  const r = await rawPool.query<{
    first_name: string; last_name: string; employee_number: string | null; job_title: string | null
    department: string | null; nni: string | null; iban: string | null; bank_name: string | null
    net_payable: string; gross_salary: string | null
  }>(
    `SELECT e.first_name, e.last_name, e.employee_number, e.job_title, d.name AS department,
            e.nni, e.iban, e.bank_name, ps.net_payable, ps.gross_salary
       FROM "${schema}".pay_slips ps
       JOIN "${schema}".employees e ON e.id = ps.employee_id
       LEFT JOIN "${schema}".departments d ON d.id = e.department_id
      WHERE ps.month = $1 AND e.payment_method = 'bank_transfer'
        AND e.bank_name = $2 AND e.iban IS NOT NULL AND e.iban <> ''
      ORDER BY e.last_name, e.first_name`,
    [month, bank],
  )
  return r.rows.map((x) => ({
    lastName: (x.last_name ?? '').toUpperCase(),
    firstName: x.first_name ?? '',
    fullName: `${(x.last_name ?? '').toUpperCase()} ${x.first_name ?? ''}`.trim(),
    employeeNumber: x.employee_number ?? '',
    nni: decryptIfPresent(x.nni) ?? '',
    iban: decryptIfPresent(x.iban) ?? '',
    bankName: x.bank_name ?? bank,
    department: x.department ?? '',
    jobTitle: x.job_title ?? '',
    netPayable: parseInt(x.net_payable ?? '0', 10),
    grossSalary: parseInt(x.gross_salary ?? '0', 10),
  }))
}

/** Gabarit Excel historique — repli quand la banque n'a pas de profil actif. */
async function buildLegacyXlsx(bank: string, month: string, rows: BankFileRow[], tenantName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'NexusRH CI'
  const ws = wb.addWorksheet(`Virements ${month}`)
  ws.mergeCells('A1:G1')
  ws.getCell('A1').value = `Ordre de virement des salaires — ${tenantName} — ${bank} — Période ${month}`
  ws.getCell('A1').font = { bold: true, size: 13 }
  ws.addRow([])
  ws.columns = [
    { key: 'idx', width: 6 }, { key: 'name', width: 32 }, { key: 'nni', width: 18 },
    { key: 'iban', width: 36 }, { key: 'bank', width: 22 }, { key: 'amount', width: 18 }, { key: 'label', width: 28 },
  ]
  const header = ws.addRow(['N°', 'Bénéficiaire', 'NNI', 'IBAN / RIB', 'Banque', 'Montant (FCFA)', 'Libellé'])
  header.font = { bold: true }
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE85D04' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } } })
  let total = 0
  rows.forEach((r, i) => {
    total += r.netPayable
    ws.addRow([i + 1, r.fullName, r.nni, r.iban, bank, r.netPayable, `Salaire ${month}`])
  })
  const totalRow = ws.addRow(['', 'TOTAL', '', '', '', total, ''])
  totalRow.font = { bold: true }
  ws.getColumn('amount').numFmt = '#,##0'
  ws.getColumn('amount').alignment = { horizontal: 'right' }
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

interface BankDirectoryRow { email: string | null; ordering_account: string | null; ordering_label: string | null }

async function loadDirectory(schema: string, bank: string): Promise<BankDirectoryRow | null> {
  const r = await rawPool.query<BankDirectoryRow>(
    `SELECT email, ordering_account, ordering_label FROM "${schema}".bank_directory WHERE bank_name = $1 LIMIT 1`, [bank],
  ).catch(() => ({ rows: [] as BankDirectoryRow[] }))
  return r.rows[0] ?? null
}

async function loadActiveTemplate(schema: string, bank: string): Promise<{ id: string; version: number; spec: BankFileSpec } | null> {
  const r = await rawPool.query<{ id: string; version: number; spec: BankFileSpec }>(
    `SELECT id, version, spec FROM "${schema}".bank_file_templates
      WHERE bank_name = $1 AND status = 'active' LIMIT 1`, [bank],
  ).catch(() => ({ rows: [] as Array<{ id: string; version: number; spec: BankFileSpec }> }))
  return r.rows[0] ?? null
}

function buildContext(bank: string, month: string, tenantName: string, dir: BankDirectoryRow | null, rows: BankFileRow[]): BankFileContext {
  return {
    bank, month, tenantName,
    orderingAccount: decryptIfPresent(dir?.ordering_account ?? null),
    orderingLabel: dir?.ordering_label ?? null,
    valueDate: new Date().toISOString().slice(0, 10),
    totalAmount: rows.reduce((s, r) => s + r.netPayable, 0),
    rowCount: rows.length,
  }
}

interface GeneratedFile { buffer: Buffer; filename: string; mime: string; templateVersion: number | null }

/** Génère le fichier d'une banque : profil actif du tenant, ou gabarit historique. */
async function generateFile(schema: string, bank: string, month: string, rows: BankFileRow[], tenantName: string): Promise<GeneratedFile> {
  const [dir, tpl] = await Promise.all([loadDirectory(schema, bank), loadActiveTemplate(schema, bank)])
  const ctx = buildContext(bank, month, tenantName, dir, rows)
  if (tpl) {
    const built = await buildBankFileAsync(tpl.spec, rows, ctx)
    return { ...built, templateVersion: tpl.version }
  }
  return {
    buffer: await buildLegacyXlsx(bank, month, rows, tenantName),
    filename: `Virements_${bank.replace(/[^A-Za-z0-9]/g, '_')}_${month}.xlsx`,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    templateVersion: null,
  }
}

function auditBank(schema: string, userId: string, action: string, changes: Record<string, unknown>, ip: string | null): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'bank_transfer', NULL, $3, $4)`,
    [userId, action, JSON.stringify(changes), ip],
  ).catch(() => { /* non bloquant */ })
}

/** Masque un compte bancaire en lecture — il ne ressort jamais en clair. */
function maskAccount(value: string | null): string | null {
  const plain = decryptIfPresent(value)
  if (!plain) return null
  return plain.length <= 4 ? '****' : `****${plain.slice(-4)}`
}

// ── Validation du profil (Zod strict, bornes dures) ─────────────────────────

/**
 * Traduit un échec de validation en phrase ACTIONNABLE. Un « Validation » sec
 * laissait l'utilisateur devant une impasse : il voyait un 400 sans savoir
 * quelle colonne corriger. Les erreurs identiques sont regroupées — un modèle
 * bancaire mal détecté en produit une par colonne.
 */
function messageDeValidation(err: z.ZodError): string {
  const nom = (path: Array<string | number>): string => {
    const i = path.indexOf('columns')
    const champ = String(path[path.length - 1] ?? '')
    const libelle: Record<string, string> = {
      label: 'un intitulé', source: 'une donnée NexusRH', literal: 'un texte fixe',
      width: 'une largeur', truncate: 'une troncature', dateFormat: 'un format de date',
      amountScale: 'une échelle de montant', filename: 'le nom de fichier',
      delimiter: 'le séparateur', encoding: 'l\'encodage', output: 'le format de sortie',
      bank: 'le nom de la banque', mode: 'le mode d\'en-tête',
    }
    const quoi = libelle[champ] ?? `le champ « ${champ} »`
    return i >= 0 ? `${quoi} de colonne` : quoi
  }
  const raison = (issue: z.ZodIssue): string => {
    if (issue.code === 'too_big' && issue.type === 'string') return `trop long (maximum ${issue.maximum} caractères)`
    if (issue.code === 'too_small' && issue.type === 'string') return 'vide ou trop court'
    if (issue.code === 'too_big') return `au-delà du maximum autorisé (${issue.maximum})`
    if (issue.code === 'too_small') return `en deçà du minimum autorisé (${issue.minimum})`
    if (issue.code === 'invalid_enum_value') return 'avec une valeur non autorisée'
    if (issue.code === 'unrecognized_keys') return 'inattendu'
    if (issue.code === 'invalid_type') return 'du mauvais type'
    return issue.message
  }

  const groupes = new Map<string, number>()
  for (const issue of err.issues) {
    const cle = `${nom(issue.path)}|${raison(issue)}`
    groupes.set(cle, (groupes.get(cle) ?? 0) + 1)
  }
  const phrases = [...groupes.entries()].slice(0, 3).map(([cle, n]) => {
    const [quoi, pourquoi] = cle.split('|')
    return n > 1 ? `${n} colonnes ont ${quoi?.replace(' de colonne', '')} ${pourquoi}` : `${quoi} est ${pourquoi}`
  })
  return `Le profil n'est pas valide : ${phrases.join(' ; ')}.`
}

const padSchema = z.object({
  width: z.number().int().min(1).max(4000),
  align: z.enum(['left', 'right']),
  char: z.string().length(1),
}).strict()

const segmentSchema = z.object({
  label: z.string().max(120).optional(),
  source: z.string().max(60).refine((v) => v === 'unmapped' || isSourceKey(v), 'Source inconnue'),
  literal: z.string().max(200).optional(),
  transform: z.array(z.enum(TRANSFORMS)).max(TRANSFORMS.length).optional(),
  pad: padSchema.optional(),
  truncate: z.number().int().min(1).max(4000).optional(),
  dateFormat: z.enum(DATE_FORMATS).optional(),
  amountScale: z.number().int().min(1).max(1000).optional(),
}).strict()

const lineSchema = z.array(segmentSchema).max(MAX_COLUMNS)

const specSchema = z.object({
  output: z.enum(OUTPUT_KINDS),
  encoding: z.enum(ENCODINGS),
  delimiter: z.enum(DELIMITERS),
  lineEnding: z.enum(['crlf', 'lf']),
  filename: z.string().min(1).max(160),
  header: z.object({ mode: z.enum(['none', 'labels', 'custom']), lines: z.array(lineSchema).max(5) }).strict(),
  columns: z.array(segmentSchema).max(MAX_COLUMNS),
  footer: z.object({ enabled: z.boolean(), lines: z.array(lineSchema).max(5) }).strict(),
}).strict()

const bankTransferRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /bank-transfer/preview?month=YYYY-MM — banques + nb virements + total + email connu
  fastify.get('/preview', {
    preHandler: [fastify.authorize(...OPERATE_ROLES), ensureSchema],
    schema: { tags: ['bank-transfer'], summary: 'Aperçu des virements bancaires par banque' },
    handler: async (request, reply) => {
      const { month } = request.query as Record<string, string>
      if (!month || !MONTH_RE.test(month)) return reply.status(400).send({ error: 'month requis (YYYY-MM)' })
      const schema = request.user.schemaName
      const r = await rawPool.query<{ bank_name: string; count: number; total: string; email: string | null; template_version: number | null; output_kind: string | null }>(
        `SELECT e.bank_name,
                count(*)::int AS count,
                sum(ps.net_payable)::text AS total,
                bd.email,
                tpl.version   AS template_version,
                tpl.output_kind
           FROM "${schema}".pay_slips ps
           JOIN "${schema}".employees e ON e.id = ps.employee_id
           LEFT JOIN "${schema}".bank_directory bd ON bd.bank_name = e.bank_name
           LEFT JOIN "${schema}".bank_file_templates tpl
                  ON tpl.bank_name = e.bank_name AND tpl.status = 'active'
          WHERE ps.month = $1 AND e.payment_method = 'bank_transfer'
            AND e.iban IS NOT NULL AND e.iban <> '' AND e.bank_name IS NOT NULL
          GROUP BY e.bank_name, bd.email, tpl.version, tpl.output_kind
          ORDER BY e.bank_name`,
        [month],
      )
      return reply.send({
        data: r.rows.map((x) => ({
          bank: x.bank_name,
          count: x.count,
          total: parseInt(x.total ?? '0', 10),
          email: x.email ?? '',
          templateVersion: x.template_version,
          outputKind: x.output_kind ?? 'xlsx',
        })),
      })
    },
  })

  // GET /bank-transfer/file?month=YYYY-MM&bank=... — télécharger le fichier d'une banque
  fastify.get('/file', {
    preHandler: [fastify.authorize(...OPERATE_ROLES), ensureSchema],
    schema: { tags: ['bank-transfer'], summary: 'Télécharger le fichier de virement d\'une banque' },
    handler: async (request, reply) => {
      const { month, bank } = request.query as Record<string, string>
      if (!month || !MONTH_RE.test(month)) return reply.status(400).send({ error: 'month requis (YYYY-MM)' })
      if (!bank || bank.length > 100) return reply.status(400).send({ error: 'bank requis' })
      const schema = request.user.schemaName
      const rows = await fetchTransfers(schema, month, bank)
      if (rows.length === 0) return reply.status(404).send({ error: 'Aucun virement pour cette banque/période' })
      const tenant = await rawPool.query<{ name: string }>(`SELECT name FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]).catch(() => ({ rows: [] as Array<{ name: string }> }))
      const file = await generateFile(schema, bank, month, rows, tenant.rows[0]?.name ?? 'NexusRH CI')
      auditBank(schema, request.user.sub, 'bank_transfer.file_downloaded', { month, bank, count: rows.length, templateVersion: file.templateVersion }, request.ip ?? null)
      reply.header('Content-Type', file.mime)
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Disposition', `attachment; filename="${file.filename}"`)
      return reply.send(file.buffer)
    },
  })

  // POST /bank-transfer/send — {month, banks:[{name,email}]} → génère + envoie + confirme
  fastify.post('/send', {
    preHandler: [fastify.authorize(...OPERATE_ROLES), ensureSchema],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['bank-transfer'], summary: 'Générer et envoyer les fichiers de virement aux banques' },
    handler: async (request, reply) => {
      const parsed = z.object({
        month: z.string().regex(MONTH_RE, 'Format YYYY-MM requis'),
        banks: z.array(z.object({
          name: z.string().min(1).max(100),
          email: z.string().email('Email banque invalide').max(255),
        })).min(1).max(50),
      }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: messageDeValidation(parsed.error), issues: parsed.error.flatten() })
      const { month, banks } = parsed.data
      const schema = request.user.schemaName

      // Config email du TENANT : l'expéditeur (from) et le serveur SMTP sont ceux
      // paramétrés par le tenant (repli plateforme si non configuré).
      const mail = await loadTenantMailBySchema(schema).catch(() => null)
      const tenantName = mail?.name ?? 'NexusRH CI'
      const tenantFrom = mail?.from
      const tenantSmtp = mail?.smtp ?? null

      const results: Array<{ bank: string; count: number; total: number; sent: boolean; templateVersion?: number | null; error?: string }> = []
      for (const b of banks) {
        const rows = await fetchTransfers(schema, month, b.name)
        if (rows.length === 0) { results.push({ bank: b.name, count: 0, total: 0, sent: false, error: 'Aucun virement' }); continue }
        const total = rows.reduce((s, r) => s + r.netPayable, 0)
        try {
          const file = await generateFile(schema, b.name, month, rows, tenantName)
          await sendBankTransferEmail({
            to: b.email, bankName: b.name, month, count: rows.length, total, tenantName,
            primaryColor: mail?.primaryColor ?? null,
            from: tenantFrom, replyTo: tenantFrom, smtp: tenantSmtp,
            attachment: { filename: file.filename, content: file.buffer },
          })
          // Mémorise l'email de la banque pour la prochaine fois
          await rawPool.query(
            `INSERT INTO "${schema}".bank_directory (bank_name, email, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (bank_name) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
            [b.name, b.email],
          ).catch(() => undefined)
          results.push({ bank: b.name, count: rows.length, total, sent: true, templateVersion: file.templateVersion })
        } catch (e) {
          results.push({ bank: b.name, count: rows.length, total, sent: false, error: (e as Error).message })
        }
      }
      const okCount = results.filter((r) => r.sent).length
      auditBank(schema, request.user.sub, 'bank_transfer.sent', { month, banks: results.map((r) => ({ bank: r.bank, sent: r.sent, count: r.count, templateVersion: r.templateVersion ?? null })) }, request.ip ?? null)
      return reply.send({
        success: okCount === banks.length,
        message: okCount === banks.length
          ? `${okCount} fichier(s) de virement envoyé(s) avec succès.`
          : `${okCount}/${banks.length} envoyé(s) — voir le détail.`,
        results,
      })
    },
  })

  // PUT /bank-transfer/directory — coordonnées de la banque + donneur d'ordre
  fastify.put('/directory', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    schema: { tags: ['bank-transfer'], summary: 'Enregistrer les coordonnées d\'une banque' },
    handler: async (request, reply) => {
      const parsed = z.object({
        bank: z.string().min(1).max(100),
        email: z.string().email().max(255).optional(),
        orderingAccount: z.string().max(60).optional(),
        orderingLabel: z.string().max(140).optional(),
      }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: messageDeValidation(parsed.error), issues: parsed.error.flatten() })
      const { bank, email, orderingAccount, orderingLabel } = parsed.data
      const schema = request.user.schemaName
      await rawPool.query(
        `INSERT INTO "${schema}".bank_directory (bank_name, email, ordering_account, ordering_label, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (bank_name) DO UPDATE SET
           email            = COALESCE(EXCLUDED.email, "${schema}".bank_directory.email),
           ordering_account = COALESCE(EXCLUDED.ordering_account, "${schema}".bank_directory.ordering_account),
           ordering_label   = COALESCE(EXCLUDED.ordering_label, "${schema}".bank_directory.ordering_label),
           updated_at = now()`,
        [bank, email ?? null, orderingAccount ? encryptIfPresent(orderingAccount) : null, orderingLabel ?? null],
      )
      auditBank(schema, request.user.sub, 'bank_transfer.directory_updated', { bank, orderingAccountSet: Boolean(orderingAccount) }, request.ip ?? null)
      const dir = await loadDirectory(schema, bank)
      return reply.send({ data: { bank, email: dir?.email ?? null, orderingAccount: maskAccount(dir?.ordering_account ?? null), orderingLabel: dir?.ordering_label ?? null } })
    },
  })

  // ── Profils de fichier bancaire ────────────────────────────────────────────

  // GET /bank-transfer/templates — profils + référentiel pour l'éditeur
  fastify.get('/templates', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    schema: { tags: ['bank-transfer'], summary: 'Profils de fichier bancaire du tenant' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const r = await rawPool.query(
        `SELECT id, bank_name, version, status, label, output_kind, sample_filename,
                created_at, updated_at, activated_at
           FROM "${schema}".bank_file_templates
          ORDER BY bank_name, version DESC`,
      )
      const dirs = await rawPool.query<{ bank_name: string; email: string | null; ordering_account: string | null; ordering_label: string | null }>(
        `SELECT bank_name, email, ordering_account, ordering_label FROM "${schema}".bank_directory ORDER BY bank_name`,
      ).catch(() => ({ rows: [] as Array<{ bank_name: string; email: string | null; ordering_account: string | null; ordering_label: string | null }> }))
      return reply.send({
        data: r.rows.map((x) => ({
          id: x.id, bank: x.bank_name, version: x.version, status: x.status, label: x.label,
          outputKind: x.output_kind, sampleFilename: x.sample_filename,
          createdAt: x.created_at, updatedAt: x.updated_at, activatedAt: x.activated_at,
        })),
        directory: dirs.rows.map((d) => ({
          bank: d.bank_name, email: d.email,
          orderingAccount: maskAccount(d.ordering_account), orderingLabel: d.ordering_label,
        })),
        referential: {
          sources: SOURCE_CATALOG,
          transforms: TRANSFORMS,
          dateFormats: DATE_FORMATS,
          outputs: OUTPUT_KINDS,
          encodings: ENCODINGS,
          delimiters: DELIMITERS,
          presets: STARTER_PRESETS.map((p) => ({ key: p.key, label: p.label, description: p.description, output: p.spec.output })),
          maxColumns: MAX_COLUMNS,
          maxSampleBytes: MAX_SAMPLE_BYTES,
        },
      })
    },
  })

  // GET /bank-transfer/templates/:id — détail d'une version (y compris archivée)
  fastify.get('/templates/:id', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    schema: { tags: ['bank-transfer'], summary: 'Détail d\'un profil de fichier bancaire' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const schema = request.user.schemaName
      const r = await rawPool.query(
        `SELECT id, bank_name, version, status, label, output_kind, spec, sample_filename, sample_structure,
                created_at, updated_at, activated_at, archived_at
           FROM "${schema}".bank_file_templates WHERE id = $1 LIMIT 1`, [id],
      )
      const row = r.rows[0]
      if (!row) return reply.status(404).send({ error: 'Profil introuvable' })
      return reply.send({
        data: {
          id: row.id, bank: row.bank_name, version: row.version, status: row.status, label: row.label,
          outputKind: row.output_kind, spec: row.spec, sampleFilename: row.sample_filename,
          sampleStructure: row.sample_structure, createdAt: row.created_at, updatedAt: row.updated_at,
          activatedAt: row.activated_at, archivedAt: row.archived_at,
          issues: specIssues(row.spec as BankFileSpec),
        },
      })
    },
  })

  // POST /bank-transfer/templates/import — analyse du fichier exemple de la banque
  fastify.post('/templates/import', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { tags: ['bank-transfer'], summary: 'Analyser le fichier exemple d\'une banque (ne crée rien)' },
    handler: async (request, reply) => {
      const file = await request.file()
      if (!file) return reply.status(400).send({ error: 'Aucun fichier reçu' })
      const buf = await file.toBuffer()
      try {
        // Le fichier n'est JAMAIS conservé : on en extrait la structure, on jette les octets.
        const analysis = await analyzeSample(file.filename ?? '', buf)
        auditBank(request.user.schemaName, request.user.sub, 'bank_transfer.template_sample_analyzed',
          { filename: analysis.filename, output: analysis.output, columns: analysis.columns.length, unmapped: analysis.unmappedCount },
          request.ip ?? null)
        reply.header('Cache-Control', 'no-store')
        return reply.send({ data: analysis })
      } catch (err) {
        if (err instanceof SampleRejectedError) return reply.status(400).send({ error: err.message })
        request.log.error({ err }, 'Analyse du fichier exemple bancaire impossible')
        return reply.status(400).send({ error: 'Fichier illisible. Vérifiez qu\'il s\'agit bien d\'un .xlsx, .csv ou .txt.' })
      }
    },
  })

  // POST /bank-transfer/templates — crée une v1 en brouillon (depuis un modèle ou un profil fourni)
  fastify.post('/templates', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    schema: { tags: ['bank-transfer'], summary: 'Créer un profil de fichier bancaire (brouillon)' },
    handler: async (request, reply) => {
      const parsed = z.object({
        bank: z.string().min(1).max(100),
        label: z.string().max(140).optional(),
        presetKey: z.string().max(40).optional(),
        spec: specSchema.optional(),
        sampleFilename: z.string().max(160).optional(),
      }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: messageDeValidation(parsed.error), issues: parsed.error.flatten() })
      const { bank, label, presetKey, spec, sampleFilename } = parsed.data

      const preset = presetKey ? STARTER_PRESETS.find((p) => p.key === presetKey) : undefined
      if (presetKey && !preset) return reply.status(400).send({ error: 'Modèle de départ inconnu' })
      const finalSpec = (spec ?? preset?.spec) as BankFileSpec | undefined
      if (!finalSpec) return reply.status(400).send({ error: 'Fournissez un modèle de départ (presetKey) ou un profil (spec)' })

      const schema = request.user.schemaName
      const count = await rawPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${schema}".bank_file_templates WHERE bank_name = $1`, [bank])
      if (parseInt(count.rows[0]?.n ?? '0', 10) >= MAX_VERSIONS_PER_BANK) {
        return reply.status(400).send({ error: `Limite atteinte : ${MAX_VERSIONS_PER_BANK} versions par banque.` })
      }
      const r = await rawPool.query<{ id: string; version: number }>(
        `INSERT INTO "${schema}".bank_file_templates (bank_name, version, status, label, output_kind, spec, sample_filename, created_by)
         SELECT $1::varchar, COALESCE(max(version), 0) + 1, 'draft', $2, $3, $4::jsonb, $5, $6
           FROM "${schema}".bank_file_templates WHERE bank_name = $1::varchar
         RETURNING id, version`,
        [bank, label ?? preset?.label ?? null, finalSpec.output, JSON.stringify(finalSpec), sampleFilename ?? null, request.user.sub],
      )
      const created = r.rows[0]!
      auditBank(schema, request.user.sub, 'bank_transfer.template_created', { bank, version: created.version, output: finalSpec.output }, request.ip ?? null)
      return reply.status(201).send({ data: { id: created.id, bank, version: created.version, status: 'draft', issues: specIssues(finalSpec) } })
    },
  })

  // PUT /bank-transfer/templates/:id — édite un brouillon ; sur un profil ACTIF, crée la version n+1
  fastify.put('/templates/:id', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    schema: { tags: ['bank-transfer'], summary: 'Modifier un profil (un profil actif engendre une nouvelle version)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = z.object({ label: z.string().max(140).optional(), spec: specSchema }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: messageDeValidation(parsed.error), issues: parsed.error.flatten() })
      const { label, spec } = parsed.data
      const schema = request.user.schemaName

      const cur = await rawPool.query<{ bank_name: string; status: string; version: number }>(
        `SELECT bank_name, status, version FROM "${schema}".bank_file_templates WHERE id = $1 LIMIT 1`, [id])
      const row = cur.rows[0]
      if (!row) return reply.status(404).send({ error: 'Profil introuvable' })
      if (row.status === 'archived') return reply.status(400).send({ error: 'Une version archivée ne se modifie pas — repartez de la version active.' })

      // Modifier un profil ACTIF ne le modifie pas : on prépare la version
      // suivante en brouillon, pour que l'envoi en cours reste sur un format éprouvé.
      if (row.status === 'active') {
        const r = await rawPool.query<{ id: string; version: number }>(
          `INSERT INTO "${schema}".bank_file_templates (bank_name, version, status, label, output_kind, spec, created_by)
           SELECT $1::varchar, COALESCE(max(version), 0) + 1, 'draft', $2, $3, $4::jsonb, $5
             FROM "${schema}".bank_file_templates WHERE bank_name = $1::varchar
           RETURNING id, version`,
          [row.bank_name, label ?? null, spec.output, JSON.stringify(spec), request.user.sub],
        )
        const created = r.rows[0]!
        auditBank(schema, request.user.sub, 'bank_transfer.template_revised', { bank: row.bank_name, from: row.version, to: created.version }, request.ip ?? null)
        return reply.send({ data: { id: created.id, bank: row.bank_name, version: created.version, status: 'draft', createdNewVersion: true, issues: specIssues(spec as BankFileSpec) } })
      }

      await rawPool.query(
        `UPDATE "${schema}".bank_file_templates
            SET label = $2, output_kind = $3, spec = $4::jsonb, updated_at = now()
          WHERE id = $1`,
        [id, label ?? null, spec.output, JSON.stringify(spec)],
      )
      auditBank(schema, request.user.sub, 'bank_transfer.template_updated', { bank: row.bank_name, version: row.version }, request.ip ?? null)
      return reply.send({ data: { id, bank: row.bank_name, version: row.version, status: 'draft', createdNewVersion: false, issues: specIssues(spec as BankFileSpec) } })
    },
  })

  // POST /bank-transfer/templates/:id/preview — rendu sur une vraie paie
  fastify.post('/templates/:id/preview', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['bank-transfer'], summary: 'Aperçu du profil sur une période de paie réelle' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const parsed = z.object({ month: z.string().regex(MONTH_RE, 'Format YYYY-MM requis') }).strict().safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: messageDeValidation(parsed.error), issues: parsed.error.flatten() })
      const schema = request.user.schemaName

      const cur = await rawPool.query<{ bank_name: string; spec: BankFileSpec; version: number }>(
        `SELECT bank_name, spec, version FROM "${schema}".bank_file_templates WHERE id = $1 LIMIT 1`, [id])
      const row = cur.rows[0]
      if (!row) return reply.status(404).send({ error: 'Profil introuvable' })

      const issues = specIssues(row.spec)
      const allRows = await fetchTransfers(schema, parsed.data.month, row.bank_name)
      const sample = allRows.slice(0, PREVIEW_ROWS)
      const tenant = await rawPool.query<{ name: string }>(`SELECT name FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]).catch(() => ({ rows: [] as Array<{ name: string }> }))
      const dir = await loadDirectory(schema, row.bank_name)
      // Le total et le nombre de lignes restent ceux de la paie ENTIÈRE : c'est
      // ce que la banque recevra, l'aperçu ne doit pas laisser croire l'inverse.
      const ctx = buildContext(row.bank_name, parsed.data.month, tenant.rows[0]?.name ?? 'NexusRH CI', dir, allRows)

      const table = previewTable(row.spec, sample, ctx)
      const built = row.spec.output === 'xlsx' ? null : await buildBankFileAsync(row.spec, sample, ctx)

      auditBank(schema, request.user.sub, 'bank_transfer.template_previewed', { bank: row.bank_name, version: row.version, month: parsed.data.month, rows: sample.length }, request.ip ?? null)
      // Contient des IBAN/NNI déchiffrés : jamais mis en cache.
      reply.header('Cache-Control', 'no-store')
      return reply.send({
        data: {
          bank: row.bank_name, version: row.version, issues,
          filename: resolveFilename(row.spec.filename, row.spec.output, ctx),
          outputKind: row.spec.output,
          rowCount: allRows.length, previewRows: sample.length, totalAmount: ctx.totalAmount,
          table,
          lines: built ? built.buffer.toString(row.spec.encoding === 'latin1' ? 'latin1' : 'utf8').split(/\r?\n/) : null,
        },
      })
    },
  })

  // GET /bank-transfer/templates/:id/test-file?month=YYYY-MM — fichier d'essai téléchargeable
  fastify.get('/templates/:id/test-file', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['bank-transfer'], summary: 'Télécharger un fichier d\'essai produit par le profil' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { month } = request.query as Record<string, string>
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      if (!month || !MONTH_RE.test(month)) return reply.status(400).send({ error: 'month requis (YYYY-MM)' })
      const schema = request.user.schemaName

      const cur = await rawPool.query<{ bank_name: string; spec: BankFileSpec; version: number }>(
        `SELECT bank_name, spec, version FROM "${schema}".bank_file_templates WHERE id = $1 LIMIT 1`, [id])
      const row = cur.rows[0]
      if (!row) return reply.status(404).send({ error: 'Profil introuvable' })

      const rows = await fetchTransfers(schema, month, row.bank_name)
      if (rows.length === 0) return reply.status(404).send({ error: 'Aucun virement pour cette banque/période' })
      const tenant = await rawPool.query<{ name: string }>(`SELECT name FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]).catch(() => ({ rows: [] as Array<{ name: string }> }))
      const dir = await loadDirectory(schema, row.bank_name)
      const ctx = buildContext(row.bank_name, month, tenant.rows[0]?.name ?? 'NexusRH CI', dir, rows)
      const built = await buildBankFileAsync(row.spec, rows, ctx)

      auditBank(schema, request.user.sub, 'bank_transfer.template_test_file', { bank: row.bank_name, version: row.version, month, count: rows.length }, request.ip ?? null)
      reply.header('Content-Type', built.mime)
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Disposition', `attachment; filename="ESSAI_${built.filename}"`)
      return reply.send(built.buffer)
    },
  })

  // POST /bank-transfer/templates/:id/activate — bascule ; l'ancienne version est archivée
  fastify.post('/templates/:id/activate', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), ensureSchema],
    schema: { tags: ['bank-transfer'], summary: 'Activer un profil (archive la version précédente)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const schema = request.user.schemaName

      const cur = await rawPool.query<{ bank_name: string; status: string; version: number; spec: BankFileSpec }>(
        `SELECT bank_name, status, version, spec FROM "${schema}".bank_file_templates WHERE id = $1 LIMIT 1`, [id])
      const row = cur.rows[0]
      if (!row) return reply.status(404).send({ error: 'Profil introuvable' })
      if (row.status === 'active') return reply.status(400).send({ error: 'Ce profil est déjà actif.' })

      // Un mapping incomplet passe nos contrôles mais fait rejeter le fichier
      // par la banque : on refuse d'activer plutôt que de deviner.
      const issues = specIssues(row.spec)
      if (issues.length > 0) {
        return reply.status(400).send({ error: 'Profil incomplet — corrigez les colonnes signalées avant d\'activer.', issues })
      }

      // Bascule ATOMIQUE : un instant à deux profils actifs (ou zéro) enverrait
      // un fichier au mauvais format à la banque.
      const client = await rawPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE "${schema}".bank_file_templates
              SET status = 'archived', archived_at = now(), updated_at = now()
            WHERE bank_name = $1 AND status = 'active'`, [row.bank_name])
        await client.query(
          `UPDATE "${schema}".bank_file_templates
              SET status = 'active', activated_at = now(), archived_at = NULL, updated_at = now()
            WHERE id = $1`, [id])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        request.log.error({ err, schema, id }, 'Activation du profil bancaire impossible')
        return reply.status(500).send({ error: 'Activation impossible. Réessayez.' })
      } finally {
        client.release()
      }

      auditBank(schema, request.user.sub, 'bank_transfer.template_activated', { bank: row.bank_name, version: row.version }, request.ip ?? null)
      return reply.send({ data: { id, bank: row.bank_name, version: row.version, status: 'active' } })
    },
  })
}

export default bankTransferRoutes
