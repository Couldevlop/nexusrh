import nodemailer from 'nodemailer'
import type { Job } from 'bullmq'
import { logger } from '../logger.js'
import { parseEmailPayload, JobValidationError, type EmailPayload } from '../schemas.js'

// OWASP A02 (Cryptographic Failures) — TLS strict en production. En dev local
// (smtp4dev / mailhog), on tolère les certificats auto-signés. Sinon : refus
// d'un certificat invalide pour empêcher MITM sur credentials SMTP.
const isProduction = process.env['NODE_ENV'] === 'production'

const transporter = nodemailer.createTransport({
  host: process.env['SMTP_HOST'] ?? 'localhost',
  port: Number(process.env['SMTP_PORT'] ?? 587),
  secure: process.env['SMTP_SECURE'] === 'true',
  auth: {
    user: process.env['SMTP_USER'] ?? '',
    pass: process.env['SMTP_PASS'] ?? '',
  },
  requireTLS: true,
  tls: {
    rejectUnauthorized: isProduction,
    minVersion: 'TLSv1.2',
  },
})

export async function processEmailJob(job: Job<unknown, void>): Promise<void> {
  let payload: EmailPayload
  try {
    // OWASP A03 — valider to/subject/html|text + format email + bornes longueurs
    payload = parseEmailPayload(job.data)
  } catch (err) {
    if (err instanceof JobValidationError) {
      logger.error({ jobId: job.id, err: err.message }, 'email: payload invalide — job rejeté')
      return
    }
    throw err
  }

  const { to, subject, html, text } = payload

  try {
    await transporter.sendMail({
      from: process.env['SMTP_FROM'] ?? 'NexusRH CI <noreply@nexusrh-ci.com>',
      to,
      subject,
      html,
      text,
    })
    // OWASP A09 — log opération (sans corps du mail qui peut contenir PII)
    logger.info({ jobId: job.id, to, subjectLen: subject.length }, 'Email sent')
  } catch (err) {
    // OWASP A10 — ne pas logger le corps HTML/texte (peut contenir
    // bulletin de paie, salaire, données personnelles)
    const errMsg = err instanceof Error ? err.message : 'unknown'
    logger.error({ jobId: job.id, to, errMsg }, 'Email send failed')
    throw err
  }
}
