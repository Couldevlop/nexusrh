/**
 * COVERAGE — Service email : exerce TOUTES les fonctions d'envoi et toutes leurs
 * branches sans envoi réel (nodemailer mocké). Complète email.golden.test.ts pour
 * porter la couverture de src/services/email.ts à ~100 %.
 *
 * Branches couvertes :
 *  - brandHeader avec logo (img) ET sans logo (initiales colorées)
 *  - expéditeur From/Reply-To personnalisés (cabinet) ET valeurs par défaut
 *  - SMTP configuré (auth présent) ET non configuré (auth undefined)
 *  - hôte Gmail (requireTLS=true) ET hôte non-Gmail (requireTLS=false)
 *  - mot de passe temporaire, ville présente/absente (reset admin)
 *  - rejet de sendMail (l'erreur remonte bien à l'appelant)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { sendMailMock, createTransportMock, configMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'cov-id' })
  const createTransportMock = vi.fn((_opts?: Record<string, unknown>) => ({ sendMail: sendMailMock }))
  const configMock = {
    appUrl: 'http://localhost:3001',
    smtp: {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      user: 'infos@openlabconsulting.com',
      pass: 'app-password-16c',
      from: 'NexusRH CI <noreply@nexusrh-ci.com>',
    },
  }
  return { sendMailMock, createTransportMock, configMock }
})

vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}))

vi.mock('../config.js', () => ({ config: configMock }))

import {
  sendWelcomeTenantEmail,
  sendEmployeeWelcomeEmail,
  sendWelcomeAgencyEmail,
  sendPasswordResetEmail,
  sendPasswordResetLinkEmail,
} from './email.js'

type Mail = Record<string, string>
const lastMail = (): Mail => (sendMailMock.mock.calls.at(-1)?.[0] ?? {}) as Mail

beforeEach(() => {
  sendMailMock.mockClear()
  sendMailMock.mockResolvedValue({ messageId: 'cov-id' })
  createTransportMock.mockClear()
  // Réinitialise la config SMTP par défaut (Gmail, authentifié) avant chaque test
  configMock.smtp.host = 'smtp.gmail.com'
  configMock.smtp.user = 'infos@openlabconsulting.com'
  configMock.smtp.pass = 'app-password-16c'
  configMock.smtp.from = 'NexusRH CI <noreply@nexusrh-ci.com>'
})

describe('sendWelcomeTenantEmail — branches logo / expéditeur', () => {
  it('utilise le logo (balise img) et le From/Reply-To personnalisés du cabinet', async () => {
    await sendWelcomeTenantEmail({
      to: 'admin@acme.ci', firstName: 'Awa', lastName: 'Koné', tenantName: 'ACME',
      tenantCity: 'Abidjan', primaryColor: '#E85D04', loginUrl: 'http://x/login',
      tempPassword: 'CI_ABC123!', plan: 'business',
      logoUrl: 'https://cdn/brand/acme.png',
      from: 'Cabinet RH <rh@cabinet.ci>',
      replyTo: 'reply@cabinet.ci',
    })
    const mail = lastMail()
    expect(mail.from).toBe('Cabinet RH <rh@cabinet.ci>')
    expect(mail.replyTo).toBe('reply@cabinet.ci')
    expect(mail.html).toContain('https://cdn/brand/acme.png')
    expect(mail.html).toContain('<img')
  })

  it('sans logo : affiche les initiales (fallback) et le From par défaut, sans Reply-To', async () => {
    await sendWelcomeTenantEmail({
      to: 'admin@beta.ci', firstName: 'Yao', lastName: 'Bley', tenantName: 'Beta SARL',
      tenantCity: 'Bouaké', primaryColor: '#1D4ED8', loginUrl: 'http://x/login',
      tempPassword: 'CI_XYZ!', plan: 'starter',
      logoUrl: null,
    })
    const mail = lastMail()
    expect(mail.from).toBe('NexusRH CI <noreply@nexusrh-ci.com>')
    expect(mail.replyTo).toBeUndefined()
    expect(mail.html).not.toContain('<img')
    expect(mail.html).toContain('BE') // initiales de "Beta SARL"
  })
})

describe('sendEmployeeWelcomeEmail — branches logo / expéditeur', () => {
  it('avec logo + From/Reply-To personnalisés', async () => {
    await sendEmployeeWelcomeEmail({
      to: 'user@acme.ci', firstName: 'Aya', lastName: 'Touré', tenantName: 'ACME',
      primaryColor: '#16A34A', loginUrl: 'http://x/login', tempPassword: 'CI_EMP!',
      logoUrl: 'https://cdn/brand/acme.png',
      from: 'Cabinet RH <rh@cabinet.ci>', replyTo: 'reply@cabinet.ci',
    })
    const mail = lastMail()
    expect(mail.from).toBe('Cabinet RH <rh@cabinet.ci>')
    expect(mail.replyTo).toBe('reply@cabinet.ci')
    expect(mail.html).toContain('<img')
  })

  it('sans logo ni expéditeur personnalisé : From par défaut, pas de Reply-To, initiales', async () => {
    await sendEmployeeWelcomeEmail({
      to: 'user@gamma.ci', firstName: 'Koffi', lastName: 'N\'Da', tenantName: 'Gamma',
      primaryColor: '#16A34A', loginUrl: 'http://x/login', tempPassword: 'CI_EMP2!',
    })
    const mail = lastMail()
    expect(mail.from).toBe('NexusRH CI <noreply@nexusrh-ci.com>')
    expect(mail.replyTo).toBeUndefined()
    expect(mail.html).not.toContain('<img')
    expect(mail.html).toContain('GA')
    expect(mail.text).toContain('CI_EMP2!')
  })
})

describe('sendWelcomeAgencyEmail — email cabinet de recrutement', () => {
  it('envoie au 1er owner avec mot de passe temporaire + lien et logo cabinet', async () => {
    await sendWelcomeAgencyEmail({
      to: 'owner@cabinet.ci', firstName: 'Mariam', lastName: 'Diallo',
      agencyName: 'Talents CI', primaryColor: '#7C3AED', loginUrl: 'https://app/login',
      tempPassword: 'CI_AGENCY9!', logoUrl: 'https://cdn/brand/talents.png',
    })
    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const mail = lastMail()
    expect(mail.to).toBe('owner@cabinet.ci')
    expect(mail.from).toBe('NexusRH CI <noreply@nexusrh-ci.com>')
    expect(mail.subject).toContain('Talents CI')
    expect(mail.html).toContain('CI_AGENCY9!')
    expect(mail.html).toContain('https://app/login')
    expect(mail.html).toContain('<img')
    expect(mail.text).toContain('CI_AGENCY9!')
  })

  it('sans logo : affiche les initiales du cabinet (fallback)', async () => {
    await sendWelcomeAgencyEmail({
      to: 'owner2@cab.ci', firstName: 'Sara', lastName: 'Kouamé',
      agencyName: 'Recrut Pro', primaryColor: '#7C3AED', loginUrl: 'https://app/login',
      tempPassword: 'CI_AG2!',
    })
    const mail = lastMail()
    expect(mail.html).not.toContain('<img')
    expect(mail.html).toContain('RE') // initiales "Recrut Pro"
  })
})

describe('sendPasswordResetEmail — reset administratif (mot de passe temporaire)', () => {
  it('envoie le mot de passe temporaire avec la ville du tenant', async () => {
    await sendPasswordResetEmail({
      to: 'admin@sotra.ci', firstName: 'Jean', tempPassword: 'CI_RESET7!',
      loginUrl: 'https://app/login', tenantName: 'SOTRA', primaryColor: '#E85D04',
      tenantCity: 'Abidjan',
    })
    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const mail = lastMail()
    expect(mail.to).toBe('admin@sotra.ci')
    expect(mail.from).toBe('NexusRH CI <noreply@nexusrh-ci.com>')
    expect(mail.subject).toContain('SOTRA')
    expect(mail.html).toContain('CI_RESET7!')
    expect(mail.html).toContain('Abidjan')
    expect(mail.text).toContain('CI_RESET7!')
  })

  it('sans ville (null) : le bloc ville est omis mais l\'email est envoyé', async () => {
    await sendPasswordResetEmail({
      to: 'admin@beta.ci', firstName: 'Awa', tempPassword: 'CI_RESET8!',
      loginUrl: 'https://app/login', tenantName: 'Beta', primaryColor: '#1D4ED8',
      tenantCity: null,
    })
    const mail = lastMail()
    expect(mail.html).toContain('CI_RESET8!')
    expect(mail.html).toContain('NexusRH CI')
  })

  it('sans ville (champ absent) : branche par défaut', async () => {
    await sendPasswordResetEmail({
      to: 'admin@delta.ci', firstName: 'Yao', tempPassword: 'CI_RESET9!',
      loginUrl: 'https://app/login', tenantName: 'Delta', primaryColor: '#1D4ED8',
    })
    expect(lastMail().html).toContain('CI_RESET9!')
  })
})

describe('sendPasswordResetLinkEmail — lien magique self-service', () => {
  it('envoie un lien de réinitialisation avec la durée de validité', async () => {
    await sendPasswordResetLinkEmail({
      to: 'user@acme.ci', firstName: 'Fatou',
      resetUrl: 'https://app/reset-password?token=XYZ', expiresInMinutes: 15,
    })
    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const mail = lastMail()
    expect(mail.to).toBe('user@acme.ci')
    expect(mail.from).toBe('NexusRH CI <noreply@nexusrh-ci.com>')
    expect(mail.html).toContain('https://app/reset-password?token=XYZ')
    expect(mail.html).toContain('15 minutes')
    expect(mail.text).toContain('https://app/reset-password?token=XYZ')
    expect(mail.text).toContain('15 minutes')
  })
})

describe('transporter — branches de configuration SMTP', () => {
  // Le transporter est créé une seule fois (lazy + caché). Pour exercer les
  // différentes branches de createTransport il faut réinitialiser le module afin
  // de forcer une nouvelle création au prochain envoi.
  it('SMTP non configuré (user vide) : auth=undefined dans createTransport', async () => {
    vi.resetModules()
    configMock.smtp.user = ''
    configMock.smtp.pass = ''
    createTransportMock.mockClear()
    const mod = await import('./email.js')
    await mod.sendPasswordResetLinkEmail({
      to: 'x@y.ci', firstName: 'X', resetUrl: 'https://app/r?token=A', expiresInMinutes: 30,
    })
    expect(createTransportMock).toHaveBeenCalledTimes(1)
    const cfg = (createTransportMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>
    expect(cfg['auth']).toBeUndefined()
    expect(cfg['requireTLS']).toBe(true) // toujours Gmail ici
  })

  it('hôte non-Gmail : requireTLS=false', async () => {
    vi.resetModules()
    configMock.smtp.host = 'smtp.mailgun.org'
    createTransportMock.mockClear()
    const mod = await import('./email.js')
    await mod.sendPasswordResetLinkEmail({
      to: 'x@y.ci', firstName: 'X', resetUrl: 'https://app/r?token=B', expiresInMinutes: 30,
    })
    const cfg = (createTransportMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>
    expect(cfg['requireTLS']).toBe(false)
    expect(cfg['host']).toBe('smtp.mailgun.org')
  })
})

describe('propagation des erreurs d\'envoi', () => {
  it('si sendMail rejette, l\'erreur remonte à l\'appelant', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('SMTP down'))
    await expect(
      sendWelcomeTenantEmail({
        to: 'admin@acme.ci', firstName: 'Awa', lastName: 'Koné', tenantName: 'ACME',
        tenantCity: 'Abidjan', primaryColor: '#E85D04', loginUrl: 'http://x/login',
        tempPassword: 'CI_ABC123!', plan: 'business',
      }),
    ).rejects.toThrow('SMTP down')
  })
})
