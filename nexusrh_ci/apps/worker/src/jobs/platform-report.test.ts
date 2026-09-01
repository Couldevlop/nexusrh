import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const { queryMock, sendMailMock } = vi.hoisted(() => ({
  queryMock: vi.fn(), sendMailMock: vi.fn(async (_opts: unknown) => ({ messageId: 'x' })),
}))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail: sendMailMock }) } }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { processPlatformReportJob } from './platform-report.js'

const job = (periodType: string) => ({ id: 'j1', data: { periodType } } as unknown as Job)

beforeEach(() => {
  queryMock.mockReset(); sendMailMock.mockClear()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('processPlatformReportJob', () => {
  it('n’envoie rien si la période a déjà été traitée', async () => {
    // ensure table, puis claim qui ne renvoie aucune ligne
    queryMock.mockResolvedValueOnce({ rows: [] })   // CREATE TABLE
    queryMock.mockResolvedValueOnce({ rows: [] })   // claim -> refusé
    await processPlatformReportJob(job('weekly'))
    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it('envoie au destinataire principal avec la copie et le PDF joint', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })            // CREATE TABLE
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] }) // claim -> pris
    queryMock.mockResolvedValue({ rows: [] })                 // collecte : parc vide
    await processPlatformReportJob(job('weekly'))
    const envoi = sendMailMock.mock.calls[0]?.[0] as {
      to: string; cc: string; subject: string; attachments: Array<{ filename: string }>
    }
    expect(envoi.to).toBe('waopron@openlabconsulting.com')
    expect(envoi.cc).toBe('coulwao@gmail.com')
    expect(envoi.attachments[0]?.filename).toMatch(/\.pdf$/)
  })

  it('marque l’échec et relance l’erreur pour que BullMQ retente', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
    queryMock.mockResolvedValue({ rows: [] })
    sendMailMock.mockRejectedValueOnce(new Error('SMTP indisponible'))
    await expect(processPlatformReportJob(job('weekly'))).rejects.toThrow('SMTP indisponible')
    const sql = queryMock.mock.calls.map(c => String(c[0])).join('\n')
    expect(sql).toContain("'failed'")
  })

  it('rejette un type de période inconnu', async () => {
    await expect(processPlatformReportJob(job('quotidien'))).rejects.toThrow()
  })

  it('n’envoie jamais deux fois : un échec d’enregistrement après envoi ne repasse pas la période en échec', async () => {
    // Le mail part normalement (claim pris, collecte vide, sendMail OK), mais
    // le seul UPDATE qui repasse le statut à 'sent' échoue (incident DB après
    // l'envoi).
    queryMock.mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes("status = 'sent'")) throw new Error('DB indisponible après envoi')
      if (text.includes('INSERT INTO platform.report_runs')) return { rows: [{ id: 'r1' }] }
      return { rows: [] }
    })

    await expect(processPlatformReportJob(job('weekly'))).resolves.toBeUndefined()

    expect(sendMailMock).toHaveBeenCalledTimes(1)
    // Note : le SQL de claimRun contient légitimement le littéral "= 'failed'"
    // dans sa clause ON CONFLICT (reprise d'une ligne en échec) — on vérifie
    // donc précisément l'ABSENCE de l'UPDATE de markFailed (`SET status =
    // 'failed'`), pas l'absence du mot dans n'importe quelle requête.
    const sql = queryMock.mock.calls.map(c => String(c[0])).join('\n')
    expect(sql).not.toContain("SET status = 'failed'")
  })
})
