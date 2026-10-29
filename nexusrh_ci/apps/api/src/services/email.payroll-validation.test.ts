/**
 * Email d'alerte / de relance des valideurs de paie : SMTP du tenant, contenu
 * en français (mois, niveau x/n, échéance, lien), sans donnée salariale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { sendMailMock, createTransportMock, assertSafeMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'id' })
  return {
    sendMailMock,
    createTransportMock: vi.fn((_opts?: Record<string, unknown>) => ({ sendMail: sendMailMock })),
    assertSafeMock: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock }, createTransport: createTransportMock }))
vi.mock('@nexusrhci/shared/ssrf-guard', () => ({ assertSafeSmtpHost: assertSafeMock }))
vi.mock('../config.js', () => ({
  config: { env: 'test', appUrl: 'http://localhost:3001', smtp: { host: 'smtp.platform', port: 587, secure: false, user: 'u', pass: 'p', from: 'NexusRH CI <noreply@nexusrh-ci.com>' } },
}))

import { sendPayrollValidationEmail } from './email.js'

const base = {
  to: 'drh@sotra.ci', firstName: 'Fanta', tenantName: 'SOTRA <script>', monthLabel: 'octobre 2026',
  level: 2, requiredLevels: 3, dueLabel: '27/10/2026 10:00', actionUrl: 'http://localhost:3001/payroll/multi-filiales',
  smtp: { host: 'smtp.sotra.ci', port: 587, secure: false, user: 'paie@sotra.ci', pass: 'x' },
}

beforeEach(() => { sendMailMock.mockClear(); createTransportMock.mockClear(); assertSafeMock.mockClear() })

describe('sendPayrollValidationEmail', () => {
  it('alerte : passe par le SMTP du tenant (garde SSRF), sujet et corps en français', async () => {
    await sendPayrollValidationEmail({ ...base, overdue: false, kind: 'requested', multiSites: true })
    expect(assertSafeMock).toHaveBeenCalledWith('smtp.sotra.ci')
    expect(createTransportMock.mock.calls[0]![0]).toMatchObject({ host: 'smtp.sotra.ci' })
    const mail = sendMailMock.mock.calls[0]![0] as Record<string, string>
    expect(mail.subject).toBe('Paie multi-filiales octobre 2026 à valider (niveau 2/3)')
    expect(mail.from).toBe('paie@sotra.ci')
    expect(mail.html).toContain('2/3')
    expect(mail.html).toContain('27/10/2026 10:00')
    expect(mail.html).toContain('/payroll/multi-filiales')
    expect(mail.html).not.toContain('<script>')
    expect(mail.text).toContain('Examiner la paie : http://localhost:3001/payroll/multi-filiales')
  })

  it('relance en retard : sujet explicite + mention « dépassée »', async () => {
    await sendPayrollValidationEmail({ ...base, overdue: true, kind: 'reminder', multiSites: false })
    const mail = sendMailMock.mock.calls[0]![0] as Record<string, string>
    expect(mail.subject).toBe('Relance : validation de la paie octobre 2026 en retard (niveau 2/3)')
    expect(mail.text).toContain('(dépassée)')
  })

  it('erreur SMTP propagée à l\'appelant (qui la compte sans bloquer)', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('down'))
    await expect(sendPayrollValidationEmail({ ...base, overdue: false, kind: 'reminder', multiSites: false })).rejects.toThrow('down')
  })
})
