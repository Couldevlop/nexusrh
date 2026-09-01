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
