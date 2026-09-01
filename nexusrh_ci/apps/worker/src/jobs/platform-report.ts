import type { Job } from 'bullmq'
import { Pool } from 'pg'
import nodemailer from 'nodemailer'
import { logger } from '../logger.js'
import { weeklyPeriod, monthlyPeriod, type Period } from '../report/period.js'
import { ensureReportRunsTable, claimRun, markSent, markFailed } from '../report/report-runs.js'
import { collectReport } from '../report/collect.js'
import { analyze } from '../report/analyze.js'
import { renderHtml } from '../report/render-html.js'
import { renderPdf } from '../report/render-pdf.js'

// Orchestration du rapport statistique périodique de la plateforme :
// période → anti-doublon → collecte → analyse → corps HTML + PDF → envoi.
// Aucune adresse en dur non surchargeable : le destinataire principal et la
// copie sont surchageables via l'environnement, pour ne jamais figer un envoi
// de production sur une adresse personnelle.
const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 3 })

const TO = process.env['PLATFORM_REPORT_TO'] ?? 'waopron@openlabconsulting.com'
const CC = process.env['PLATFORM_REPORT_CC'] ?? 'coulwao@gmail.com'

const isProduction = process.env['NODE_ENV'] === 'production'
const transporter = nodemailer.createTransport({
  host: process.env['SMTP_HOST'] ?? 'localhost',
  port: Number(process.env['SMTP_PORT'] ?? 587),
  secure: process.env['SMTP_SECURE'] === 'true',
  auth: { user: process.env['SMTP_USER'] ?? '', pass: process.env['SMTP_PASS'] ?? '' },
  requireTLS: true,
  tls: { rejectUnauthorized: isProduction, minVersion: 'TLSv1.2' },
})

export async function processPlatformReportJob(job: Job): Promise<void> {
  const periodType = (job.data as { periodType?: unknown })?.periodType
  if (periodType !== 'weekly' && periodType !== 'monthly') {
    throw new Error(`platform-report: periodType invalide (${String(periodType)})`)
  }
  const now = new Date()
  const period: Period = periodType === 'weekly' ? weeklyPeriod(now) : monthlyPeriod(now)

  await ensureReportRunsTable(pool)
  const recipients = `${TO}, ${CC}`
  if (!await claimRun(pool, period, recipients)) {
    logger.info({ periodType, start: period.start }, 'platform-report: période déjà traitée, envoi ignoré')
    return
  }

  try {
    const data = await collectReport(pool, period)
    const analysis = analyze(data, now)
    const html = renderHtml(data, analysis)
    const pdf = await renderPdf(data, analysis)

    const nom = `nexusrh-rapport-${period.type}-${period.start.toISOString().slice(0, 10)}.pdf`
    await transporter.sendMail({
      from: process.env['SMTP_FROM'] ?? 'NexusRH CI <noreply@nexusrh-ci.com>',
      to: TO,
      cc: CC,
      subject: `NexusRH CI — ${periodType === 'weekly' ? 'rapport hebdomadaire' : 'rapport mensuel'} · ${period.label}`,
      html,
      attachments: [{ filename: nom, content: Buffer.from(pdf), contentType: 'application/pdf' }],
    })

    await markSent(pool, period)
    // OWASP A09 — on journalise des COMPTES, jamais le contenu du rapport
    // (il porte des données de clients).
    logger.info(
      { periodType, tenants: data.tenants.length, agencies: data.agencies.length, alerts: analysis.alerts.length },
      'platform-report: rapport envoyé',
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erreur inconnue'
    await markFailed(pool, period, msg).catch(() => undefined)
    logger.error({ periodType, errMsg: msg }, 'platform-report: échec')
    throw e  // laisse BullMQ retenter
  }
}
