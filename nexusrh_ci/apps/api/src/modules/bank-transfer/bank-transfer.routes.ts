/**
 * Virement bancaire des salaires — alternative au Mobile Money.
 *
 * Les employés dont `payment_method = 'bank_transfer'` sont payés par virement
 * sur leur RIB/IBAN. Ce module produit, pour une période de paie, un FICHIER
 * EXCEL (.xlsx) par banque (la liste des virements à exécuter), permet de le
 * télécharger OU de l'envoyer par email à la banque en un clic, et confirme.
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { decryptIfPresent } from '../../utils/crypto.js'
import { sendBankTransferEmail } from '../../services/email.js'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

interface TransferRow { name: string; nni: string; iban: string; amount: number }

/** Récupère les virements (RIB déchiffrés) d'une banque pour une période. */
async function fetchTransfers(schema: string, month: string, bank: string): Promise<TransferRow[]> {
  const r = await rawPool.query<{ first_name: string; last_name: string; nni: string | null; iban: string | null; net_payable: string }>(
    `SELECT e.first_name, e.last_name, e.nni, e.iban, ps.net_payable
       FROM "${schema}".pay_slips ps
       JOIN "${schema}".employees e ON e.id = ps.employee_id
      WHERE ps.month = $1 AND e.payment_method = 'bank_transfer'
        AND e.bank_name = $2 AND e.iban IS NOT NULL AND e.iban <> ''
      ORDER BY e.last_name, e.first_name`,
    [month, bank],
  )
  return r.rows.map((x) => ({
    name: `${x.last_name.toUpperCase()} ${x.first_name}`.trim(),
    nni: decryptIfPresent(x.nni) ?? '',
    iban: decryptIfPresent(x.iban) ?? '',
    amount: parseInt(x.net_payable ?? '0', 10),
  }))
}

/** Construit le fichier .xlsx d'ordre de virement d'une banque. */
async function buildXlsx(bank: string, month: string, rows: TransferRow[], tenantName: string): Promise<Buffer> {
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
    total += r.amount
    ws.addRow([i + 1, r.name, r.nni, r.iban, bank, r.amount, `Salaire ${month}`])
  })
  const totalRow = ws.addRow(['', 'TOTAL', '', '', '', total, ''])
  totalRow.font = { bold: true }
  ws.getColumn('amount').numFmt = '#,##0'
  ws.getColumn('amount').alignment = { horizontal: 'right' }
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

function auditBank(schema: string, userId: string, action: string, changes: Record<string, unknown>, ip: string | null): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'bank_transfer', NULL, $3, $4)`,
    [userId, action, JSON.stringify(changes), ip],
  ).catch(() => { /* non bloquant */ })
}

const bankTransferRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /bank-transfer/preview?month=YYYY-MM — banques + nb virements + total + email connu
  fastify.get('/preview', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['bank-transfer'], summary: 'Aperçu des virements bancaires par banque' },
    handler: async (request, reply) => {
      const { month } = request.query as Record<string, string>
      if (!month || !MONTH_RE.test(month)) return reply.status(400).send({ error: 'month requis (YYYY-MM)' })
      const schema = request.user.schemaName
      const r = await rawPool.query<{ bank_name: string; count: number; total: string; email: string | null }>(
        `SELECT e.bank_name,
                count(*)::int AS count,
                sum(ps.net_payable)::text AS total,
                bd.email
           FROM "${schema}".pay_slips ps
           JOIN "${schema}".employees e ON e.id = ps.employee_id
           LEFT JOIN "${schema}".bank_directory bd ON bd.bank_name = e.bank_name
          WHERE ps.month = $1 AND e.payment_method = 'bank_transfer'
            AND e.iban IS NOT NULL AND e.iban <> '' AND e.bank_name IS NOT NULL
          GROUP BY e.bank_name, bd.email
          ORDER BY e.bank_name`,
        [month],
      )
      return reply.send({
        data: r.rows.map((x) => ({ bank: x.bank_name, count: x.count, total: parseInt(x.total ?? '0', 10), email: x.email ?? '' })),
      })
    },
  })

  // GET /bank-transfer/file?month=YYYY-MM&bank=... — télécharger le .xlsx d'une banque
  fastify.get('/file', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['bank-transfer'], summary: 'Télécharger le fichier de virement d\'une banque' },
    handler: async (request, reply) => {
      const { month, bank } = request.query as Record<string, string>
      if (!month || !MONTH_RE.test(month)) return reply.status(400).send({ error: 'month requis (YYYY-MM)' })
      if (!bank || bank.length > 100) return reply.status(400).send({ error: 'bank requis' })
      const schema = request.user.schemaName
      const rows = await fetchTransfers(schema, month, bank)
      if (rows.length === 0) return reply.status(404).send({ error: 'Aucun virement pour cette banque/période' })
      const tenant = await rawPool.query<{ name: string }>(`SELECT name FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema]).catch(() => ({ rows: [] as Array<{ name: string }> }))
      const buf = await buildXlsx(bank, month, rows, tenant.rows[0]?.name ?? 'NexusRH CI')
      auditBank(schema, request.user.sub, 'bank_transfer.file_downloaded', { month, bank, count: rows.length }, request.ip ?? null)
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      reply.header('Content-Disposition', `attachment; filename="Virements_${bank.replace(/[^A-Za-z0-9]/g, '_')}_${month}.xlsx"`)
      return reply.send(buf)
    },
  })

  // POST /bank-transfer/send — {month, banks:[{name,email}]} → génère + envoie + confirme
  fastify.post('/send', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
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
      if (!parsed.success) return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      const { month, banks } = parsed.data
      const schema = request.user.schemaName

      // Config email du TENANT : l'expéditeur (from) et le serveur SMTP sont ceux
      // paramétrés par le tenant (repli plateforme si non configuré).
      const tRes = await rawPool.query<{
        name: string; primary_color: string | null; sender_email: string | null; sender_name: string | null
        smtp_host: string | null; smtp_port: number | null; smtp_secure: boolean | null
        smtp_user: string | null; smtp_pass_enc: string | null
      }>(
        `SELECT name, primary_color, sender_email, sender_name,
                smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc
           FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
      ).catch(() => ({ rows: [] as never[] }))
      const trow = tRes.rows[0]
      const tenantName = trow?.name ?? 'NexusRH CI'
      const tenantFrom = trow?.sender_email
        ? (trow.sender_name ? `${trow.sender_name} <${trow.sender_email}>` : trow.sender_email)
        : undefined
      const tenantSmtp = trow?.smtp_host
        ? { host: trow.smtp_host, port: trow.smtp_port ?? 587, secure: trow.smtp_secure ?? false, user: trow.smtp_user, pass: decryptIfPresent(trow.smtp_pass_enc) }
        : null

      const results: Array<{ bank: string; count: number; total: number; sent: boolean; error?: string }> = []
      for (const b of banks) {
        const rows = await fetchTransfers(schema, month, b.name)
        if (rows.length === 0) { results.push({ bank: b.name, count: 0, total: 0, sent: false, error: 'Aucun virement' }); continue }
        const total = rows.reduce((s, r) => s + r.amount, 0)
        try {
          const buf = await buildXlsx(b.name, month, rows, tenantName)
          await sendBankTransferEmail({
            to: b.email, bankName: b.name, month, count: rows.length, total, tenantName,
            primaryColor: trow?.primary_color ?? null,
            from: tenantFrom, replyTo: tenantFrom, smtp: tenantSmtp,
            attachment: { filename: `Virements_${b.name.replace(/[^A-Za-z0-9]/g, '_')}_${month}.xlsx`, content: buf },
          })
          // Mémorise l'email de la banque pour la prochaine fois
          await rawPool.query(
            `INSERT INTO "${schema}".bank_directory (bank_name, email, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (bank_name) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
            [b.name, b.email],
          ).catch(() => undefined)
          results.push({ bank: b.name, count: rows.length, total, sent: true })
        } catch (e) {
          results.push({ bank: b.name, count: rows.length, total, sent: false, error: (e as Error).message })
        }
      }
      const okCount = results.filter((r) => r.sent).length
      auditBank(schema, request.user.sub, 'bank_transfer.sent', { month, banks: results.map((r) => ({ bank: r.bank, sent: r.sent, count: r.count })) }, request.ip ?? null)
      return reply.send({
        success: okCount === banks.length,
        message: okCount === banks.length
          ? `${okCount} fichier(s) de virement envoyé(s) avec succès.`
          : `${okCount}/${banks.length} envoyé(s) — voir le détail.`,
        results,
      })
    },
  })
}

export default bankTransferRoutes
