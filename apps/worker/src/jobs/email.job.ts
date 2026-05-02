import { Worker } from 'bullmq'
import nodemailer from 'nodemailer'
import { redisConnection } from '../queues'
import pino from 'pino'

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' })

export interface EmailJobData {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  attachments?: Array<{
    filename: string
    content: string
    encoding?: string
    contentType?: string
  }>
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env['SMTP_HOST'] ?? 'smtp.example.com',
    port: Number(process.env['SMTP_PORT'] ?? 587),
    secure: process.env['SMTP_SECURE'] === 'true',
    auth:
      process.env['SMTP_USER']
        ? {
            user: process.env['SMTP_USER'],
            pass: process.env['SMTP_PASS'],
          }
        : undefined,
  })
}

export const emailWorker = new Worker<EmailJobData>(
  'email',
  async (job) => {
    const { to, subject, html, text, attachments } = job.data
    const transporter = createTransporter()

    await transporter.sendMail({
      from: process.env['SMTP_FROM'] ?? 'NexusRH <noreply@nexusrh.com>',
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
      text,
      attachments: attachments?.map((a) => ({
        ...a,
        content: Buffer.from(a.content, (a.encoding as BufferEncoding) ?? 'base64'),
      })),
    })

    logger.info({ to, subject }, 'Email envoyé')
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
)

emailWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Job email échoué')
})
