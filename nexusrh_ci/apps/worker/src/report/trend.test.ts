import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { collectTrend } from './collect.js'
import { weeklyPeriod } from './period.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

beforeEach(() => queryMock.mockReset())

describe('collectTrend', () => {
  it('rend une série continue de 12 points, même sans données', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_sotra' }] })
    queryMock.mockResolvedValue({ rows: [] })
    const t = await collectTrend(pool, period)
    expect(t).toHaveLength(12)
    expect(t.every(p => p.hires === 0 && p.logins === 0)).toBe(true)
  })

  it('range chaque valeur dans la bonne tranche', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_sotra' }] })
    queryMock.mockResolvedValueOnce({ rows: [{ jour: '2026-08-30', n: '2' }] })
    queryMock.mockResolvedValueOnce({ rows: [{ jour: '2026-08-30', n: '40' }] })
    const t = await collectTrend(pool, period)
    expect(t[11]?.hires).toBe(2)
    expect(t[11]?.logins).toBe(40)
  })

  it('ignore un tenant dont le schéma est cassé', async () => {
    // Une seule implémentation stable pour tout le test, pilotée par le SQL
    // reçu : la liste des tenants réussit, toute requête de tendance
    // (arrivées/connexions) échoue. Contourne un défaut d'outillage Vitest où
    // un rejet arrivant après un appel déjà résolu sur le même mock refait
    // surface hors du test, alors même que le `catch` de `collectTrend`
    // s'exécute correctement (voir task-8-report.md).
    queryMock.mockImplementation((sql?: unknown) => {
      const texte = String(sql ?? '')
      if (texte.includes('employees') || texte.includes('audit_log')) {
        return Promise.reject(Object.assign(new Error('absente'), { code: '42P01' }))
      }
      return Promise.resolve({ rows: [{ schema_name: 'tenant_ko' }] })
    })
    const t = await collectTrend(pool, period)
    expect(t).toHaveLength(12)
    expect(t.every(p => p.hires === 0 && p.logins === 0)).toBe(true)
  })

  it('range un jour quelconque dans la bonne tranche, quel que soit le jour de la semaine', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (String(sql).includes('platform.tenants')) return Promise.resolve({ rows: [{ schema_name: 'tenant_sotra' }] })
      if (String(sql).includes('employees')) return Promise.resolve({ rows: [{ jour: '2026-09-02', n: '5' }] }) // un MERCREDI
      return Promise.resolve({ rows: [] })
    })
    const t = await collectTrend(pool, period)
    // Le mercredi 2 septembre 2026 tombe dans la tranche qui commence le
    // dimanche 30 août — la dernière des douze.
    expect(t[11]?.hires).toBe(5)
    expect(t.reduce((s, p) => s + p.hires, 0)).toBe(5)
  })

  it('ignore un jour antérieur à la fenêtre plutôt que de le ranger dans la première tranche', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (String(sql).includes('platform.tenants')) return Promise.resolve({ rows: [{ schema_name: 'tenant_sotra' }] })
      if (String(sql).includes('employees')) return Promise.resolve({ rows: [{ jour: '2020-01-01', n: '9' }] })
      return Promise.resolve({ rows: [] })
    })
    const t = await collectTrend(pool, period)
    expect(t.reduce((s, p) => s + p.hires, 0)).toBe(0)
  })
})
