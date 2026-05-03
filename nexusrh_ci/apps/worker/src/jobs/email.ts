import nodemailer from 'nodemailer'
import type { Job } from 'bullmq'
import { logger } from '../logger.js'

const transporter = nodemailer.createTransport({
  host: process.env['SMTP_HOST'] ?? 'localhost',
  port: Number(process.env['SMTP_PORT'] ?? 587),
  secure: process.env['SMTP_SECURE'] === 'true',
  auth: {
    user: process.env['SMTP_USER'] ?? '',
    pass: process.env['SMTP_PASS'] ?? '',
  },
  requireTLS: true,
  tls: { rejectUnauthorized: false },
})

interface EmailPayload {
  to: string
  subject: string
  html?: string
  text?: string
}

export async function processEmailJob(job: Job<EmailPayload, void>): Promise<void> {
  const { to, subject, html, text } = job.data

  try {
    await transporter.sendMail({
      from: process.env['SMTP_FROM'] ?? 'NexusRH CI <noreply@nexusrh-ci.com>',
      to,
      subject,
      html,
      text,
    })
    logger.info({ to, subject }, 'Email sent')
  } catch (err) {
    logger.error({ err, to, subject }, 'Email send failed')
    throw err
  }
}
