import type { Job } from 'bullmq'
import { Pool } from 'pg'
import nodemailer from 'nodemailer'
import { logger } from '../logger.js'
import { weeklyPeriod, monthlyPeriod, type Period } from '../report/period.js'
import { ensureReportRunsTable, claimRun, markSent, markFailed } from '../report/report-runs.js'
import { collectReport } from '../report/collect.js'
import { analyze } from '../report/analyze.js'
import { renderHtml, renderText } from '../report/render-html.js'
import { renderPdf } from '../report/render-pdf.js'

// Orchestration du rapport statistique périodique de la plateforme :
// période → anti-doublon → collecte → analyse → corps HTML + texte + PDF → envoi.
// Aucune adresse en dur non surchargeable : le destinataire principal et la
// copie sont surchageables via l'environnement, pour ne jamais figer un envoi
// de production sur une adresse personnelle.
//
// ── Variables d'environnement du rapport ─────────────────────────────────────
// | Variable                       | Défaut            | Rôle                  |
// |--------------------------------|-------------------|-----------------------|
// | PLATFORM_REPORT_TO             | waopron@openlabconsulting.com | destinataire principal |
// | PLATFORM_REPORT_CC             | coulwao@gmail.com | copie                 |
// | PLATFORM_REPORT_WEEKLY_CRON    | 0 6 * * 0         | planification hebdomadaire (index.ts, fuseau Africa/Abidjan) |
// | PLATFORM_REPORT_MONTHLY_CRON   | 15 6 1 * *        | planification mensuelle (index.ts, même fuseau) |
// | PLATFORM_REPORT_MAX_TENANTS    | 500               | plafond de collecte (report/collect.ts) ; au-delà, le rapport est partiel ET le signale |
//
// Plusieurs destinataires : séparer par des virgules, nodemailer les accepte
// tels quels. Changer une adresse ne demande donc aucune reconstruction
// d'image — c'est tout l'intérêt de ne rien figer dans le code.
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
    // Partie texte : un client configuré en texte seul recevait jusqu'ici un
    // message vide, le corps n'existant qu'en HTML.
    const text = renderText(data, analysis)
    const pdf = await renderPdf(data, analysis)

    const nom = `nexusrh-rapport-${period.type}-${period.start.toISOString().slice(0, 10)}.pdf`
    await transporter.sendMail({
      from: process.env['SMTP_FROM'] ?? 'NexusRH CI <noreply@nexusrh-ci.com>',
      to: TO,
      cc: CC,
      subject: `NexusRH CI — ${periodType === 'weekly' ? 'rapport hebdomadaire' : 'rapport mensuel'} · ${period.label}`,
      html,
      text,
      attachments: [{ filename: nom, content: Buffer.from(pdf), contentType: 'application/pdf' }],
    })

    // OWASP A09 — on journalise des COMPTES, jamais le contenu du rapport
    // (il porte des données de clients).
    logger.info(
      { periodType, tenants: data.tenants.length, agencies: data.agencies.length, alerts: analysis.alerts.length },
      'platform-report: rapport envoyé',
    )

    // `markSent` est volontairement HORS du try/catch générique ci-dessus : le
    // mail est déjà parti à ce stade, donc son échec n'est PAS de la même
    // nature qu'un échec de collecte/rendu/envoi. Si on le laissait tomber
    // dans le catch générique, celui-ci appellerait `markFailed`, qui repasse
    // la ligne en 'failed' — et `claimRun` réclame une ligne 'failed' au
    // prochain déclenchement, ce qui renverrait le rapport une DEUXIÈME fois
    // aux vrais destinataires. Un rapport envoyé en double est pire qu'un
    // statut manquant : mieux vaut bloquer volontairement la période (elle
    // reste en 'pending') que de spammer.
    //
    // ⚠️ RÉSERVE, depuis que `claimRun` reprend un 'pending' de plus de deux
    // heures (report-runs.ts) : ce blocage n'est plus absolu. Il tient tant
    // que le prochain déclenchement pour LA MÊME période survient dans les
    // deux heures — ce qui couvre les reprises BullMQ (secondes à minutes)
    // mais pas un déclenchement manuel tardif sur la même période. Le
    // compromis est assumé : une ligne 'pending' orpheline bloquait sinon la
    // période POUR TOUJOURS, y compris quand aucun mail n'était jamais parti.
    try {
      await markSent(pool, period)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'erreur inconnue'
      logger.error(
        { periodType, errMsg: msg },
        'platform-report: le rapport A ÉTÉ ENVOYÉ mais son statut n\'a pas pu être enregistré '
        + '— la période reste \'pending\' et ne sera pas renvoyée (blocage volontaire, pas un bug)',
      )
      // Ni markFailed, ni throw : on ne veut surtout pas que BullMQ retente
      // (ça rejouerait tout l'envoi) ni que la ligne repasse en 'failed'
      // (ça la rendrait de nouveau réclamable par claimRun).
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erreur inconnue'
    await markFailed(pool, period, msg).catch(() => undefined)
    logger.error({ periodType, errMsg: msg }, 'platform-report: échec')
    throw e  // laisse BullMQ retenter
  }
}
