/**
 * GOLDEN — Service email : vérifie que l'envoi fonctionne mécaniquement
 * (transporter Gmail correctement configuré + contenu des emails), sans envoi
 * réel (nodemailer mocké). Couvre notamment l'email de bienvenue déclenché à la
 * création d'un tenant (POST /platform/tenants).
 *
 * NB : la LIVRAISON réelle dépend de SMTP_PASS (App Password Gmail) dans l'env de
 * déploiement — non testable ici. Ce test garantit que le code construit et
 * envoie l'email correctement dès que la config SMTP est présente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'test-id' })
  const createTransportMock = vi.fn((_opts?: Record<string, unknown>) => ({ sendMail: sendMailMock }))
  return { sendMailMock, createTransportMock }
})

vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}))

vi.mock('../config.js', () => ({
  config: {
    appUrl: 'http://localhost:3001',
    smtp: {
      host: 'smtp.gmail.com', port: 587, secure: false,
      user: 'infos@openlabconsulting.com', pass: 'app-password-16c',
      from: 'NexusRH CI <noreply@nexusrh-ci.com>',
    },
  },
}))

import { sendWelcomeTenantEmail, sendEmployeeWelcomeEmail } from './email.js'

beforeEach(() => { sendMailMock.mockClear() })

describe('email — transporter Gmail (lazy)', () => {
  it('configure le transporter Gmail (requireTLS + auth) au 1er envoi', async () => {
    await sendWelcomeTenantEmail({
      to: 'admin@acme.ci', firstName: 'Awa', lastName: 'Koné', tenantName: 'ACME',
      tenantCity: 'Abidjan', primaryColor: '#E85D04', loginUrl: 'http://x/login',
      tempPassword: 'CI_ABC123!', plan: 'business',
    })
    expect(createTransportMock).toHaveBeenCalled()
    const cfg = (createTransportMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>
    expect(cfg['host']).toBe('smtp.gmail.com')
    expect(cfg['requireTLS']).toBe(true)              // Gmail STARTTLS
    expect(cfg['auth']).toEqual({ user: 'infos@openlabconsulting.com', pass: 'app-password-16c' })
  })
})

describe('sendWelcomeTenantEmail — email de bienvenue création tenant', () => {
  it('envoie un email contenant le mot de passe temporaire et le lien de connexion', async () => {
    await sendWelcomeTenantEmail({
      to: 'admin@acme.ci', firstName: 'Awa', lastName: 'Koné', tenantName: 'ACME Corp',
      tenantCity: 'Bouaké', primaryColor: '#1D4ED8', loginUrl: 'https://app/login',
      tempPassword: 'CI_SECRET9!', plan: 'business',
    })
    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const mail = (sendMailMock.mock.calls[0]?.[0] ?? {}) as Record<string, string>
    expect(mail.to).toBe('admin@acme.ci')
    expect(mail.from).toBe('NexusRH CI <noreply@nexusrh-ci.com>')
    expect(mail.subject).toContain('ACME Corp')
    // Le mot de passe temporaire ET le lien doivent figurer (HTML + texte de repli)
    expect(mail.html).toContain('CI_SECRET9!')
    expect(mail.html).toContain('https://app/login')
    expect(mail.text).toContain('CI_SECRET9!')
    expect(mail.text).toContain('admin@acme.ci')
  })
})

describe('sendEmployeeWelcomeEmail — email création utilisateur tenant', () => {
  it('envoie un email avec mot de passe temporaire + lien', async () => {
    await sendEmployeeWelcomeEmail({
      to: 'user@acme.ci', firstName: 'Yao', lastName: 'N\'Guessan', tenantName: 'ACME',
      primaryColor: '#16A34A', loginUrl: 'https://app/login', tempPassword: 'CI_EMP42!',
    })
    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const mail = (sendMailMock.mock.calls[0]?.[0] ?? {}) as Record<string, string>
    expect(mail.to).toBe('user@acme.ci')
    expect(mail.html).toContain('CI_EMP42!')
    expect(mail.text).toContain('CI_EMP42!')
  })
})
