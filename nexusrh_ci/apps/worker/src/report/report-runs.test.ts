import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { claimRun, markSent, markFailed, ensureReportRunsTable } from './report-runs.js'
import { weeklyPeriod } from './period.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

beforeEach(() => queryMock.mockReset())

describe('claimRun', () => {
  it('prend la main quand aucune ligne n\'existe pour la période', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
    expect(await claimRun(pool, period, 'a@b.ci')).toBe(true)
  })

  it('refuse quand un rapport a déjà été envoyé pour la période', async () => {
    // ON CONFLICT ... WHERE status = 'failed' ne renvoie aucune ligne.
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await claimRun(pool, period, 'a@b.ci')).toBe(false)
  })

  it('reprend une ligne pending abandonnée depuis plus de deux heures', async () => {
    // Processus tué entre la prise de la ligne et l'écriture du statut : sans
    // cette reprise, la période restait 'pending' POUR TOUJOURS et plus aucun
    // rapport n'en partait, en silence, avec BullMQ affichant un succès.
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
    expect(await claimRun(pool, period, 'a@b.ci')).toBe(true)
    const sql = String(queryMock.mock.calls[0]?.[0])
    expect(sql).toContain("platform.report_runs.status = 'pending'")
    expect(sql).toContain("interval '2 hours'")
  })

  it('ne reprend pas une ligne pending récente : c’est un envoi en cours', async () => {
    // La clause SQL ne retient pas la ligne → aucune ligne renvoyée → refus.
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await claimRun(pool, period, 'a@b.ci')).toBe(false)
  })

  it('borne la liste des destinataires écrite en base', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
    await claimRun(pool, period, 'x'.repeat(5000))
    const params = queryMock.mock.calls[0]?.[1] as unknown[]
    expect(String(params[3]).length).toBeLessThanOrEqual(500)
  })
})

describe('markFailed', () => {
  it('tronque le message d\'erreur au lieu de faire échouer l\'écriture', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await markFailed(pool, period, 'e'.repeat(5000))
    const params = queryMock.mock.calls[0]?.[1] as unknown[]
    expect(String(params[2]).length).toBeLessThanOrEqual(1000)
  })
})

describe('markSent', () => {
  it('passe la ligne de la période en sent', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await markSent(pool, period)
    expect(String(queryMock.mock.calls[0]?.[0])).toContain("'sent'")
  })
})

describe('ensureReportRunsTable', () => {
  it('crée la table de façon idempotente', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    await ensureReportRunsTable(pool)
    expect(String(queryMock.mock.calls[0]?.[0])).toContain('CREATE TABLE IF NOT EXISTS platform.report_runs')
  })
})
