import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { collectReport } from './collect.js'
import { weeklyPeriod } from './period.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

const TENANT = {
  id: 't1', name: 'SOTRA', schema_name: 'tenant_sotra', status: 'active',
  plan_type: 'business', sector: 'transport', max_users: 100, max_employees: 150,
  trial_ends_at: null, created_at: new Date('2026-01-01T00:00:00Z'),
}

/**
 * Réponses pilotées par le SQL reçu plutôt que par l'ordre des appels : la
 * collecte enchaîne des requêtes dont l'ordre est un détail d'implémentation
 * (colonnes présentes, audit plateforme…), et un mock ordonné se casse au
 * moindre ajout sans rien dire d'utile.
 */
function repondSelonSql(reponses: Array<[RegExp, unknown]>): void {
  queryMock.mockImplementation((sql: unknown) => {
    const texte = String(sql ?? '')
    for (const [motif, valeur] of reponses) {
      if (motif.test(texte)) return Promise.resolve(valeur)
    }
    return Promise.resolve({ rows: [] })
  })
}

beforeEach(() => queryMock.mockReset())

describe('collectReport', () => {
  it('ignore un schéma au nom invalide plutôt que de l’interpoler', async () => {
    repondSelonSql([[/FROM platform\.tenants/, { rows: [{ ...TENANT, schema_name: 'tenant"; DROP' }] }]])
    const data = await collectReport(pool, period)
    expect(data.tenants).toHaveLength(1)
    expect(data.tenants[0]?.collected).toBe(false)
    // Aucune requête n'a interpolé le nom hostile.
    const sql = queryMock.mock.calls.map(c => String(c[0])).join('\n')
    expect(sql).not.toContain('DROP')
  })

  it('isole un tenant dont le schéma est cassé sans faire échouer le rapport', async () => {
    const t2 = { ...TENANT, id: 't2', name: 'CABEX', schema_name: 'tenant_cabex' }
    queryMock.mockImplementation((sql: unknown) => {
      const texte = String(sql ?? '')
      if (/FROM platform\.tenants/.test(texte)) return Promise.resolve({ rows: [TENANT, t2] })
      if (texte.includes('tenant_cabex')) {
        return Promise.reject(Object.assign(new Error('relation absente'), { code: '42P01' }))
      }
      if (/information_schema\.columns/.test(texte)) return Promise.resolve({ rows: [{ column_name: 'deleted_at' }] })
      if (/FROM "tenant_sotra"\.employees/.test(texte) && texte.includes('headcount')) {
        return Promise.resolve({ rows: [{ headcount: 82, hires: 3, departures: 1 }] })
      }
      if (/FROM "tenant_sotra"\.users/.test(texte)) {
        return Promise.resolve({ rows: [{ active_users: 10, logged_in: 7, last_login_at: null }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const data = await collectReport(pool, period)
    expect(data.tenants[0]?.collected).toBe(true)
    expect(data.tenants[0]?.headcount).toBe(82)
    expect(data.tenants[1]?.collected).toBe(false)
  })

  it('agrège l’effectif des entreprises rattachées à chaque cabinet actif', async () => {
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: [TENANT] }],
      [/FROM platform\.agencies/, { rows: [{ id: 'a1', name: 'Cabinet Expertise', status: 'active' }] }],
      [/FROM platform\.agency_tenants/, { rows: [{ agency_id: 'a1', tenant_id: 't1', attached: true, detached: false }] }],
      [/information_schema\.columns/, { rows: [{ column_name: 'deleted_at' }] }],
      [/headcount/, { rows: [{ headcount: 82, hires: 3, departures: 1 }] }],
      [/active_users/, { rows: [{ active_users: 10, logged_in: 7, last_login_at: null }] }],
    ])

    const data = await collectReport(pool, period)
    expect(data.agencies[0]?.managedTenants).toBe(1)
    expect(data.agencies[0]?.headcount).toBe(82)
    // La spec parle des cabinets ACTIFS : le filtre doit être dans le SQL.
    const sqlAgences = queryMock.mock.calls.map(c => String(c[0])).find(s => s.includes('platform.agencies'))
    expect(sqlAgences).toContain("status = 'active'")
  })

  it('lit les échecs de connexion dans platform.audit_log, en total plateforme et sans la colonne changes', async () => {
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: [TENANT] }],
      [/FROM platform\.audit_log/, {
        rows: [{ action: 'auth.login.failed', n: '17' }, { action: 'auth.login.locked', n: '2' }],
      }],
      [/information_schema\.columns/, { rows: [{ column_name: 'deleted_at' }] }],
    ])

    const data = await collectReport(pool, period)
    expect(data.platformAuth).toEqual({ loginFailed: 17, loginLocked: 2 })
    const sqlPlateforme = queryMock.mock.calls.map(c => String(c[0]))
      .find(s => s.includes('FROM platform.audit_log'))
    // RGPD : `changes` porte l'e-mail saisi, il ne doit JAMAIS être lu.
    expect(sqlPlateforme).not.toContain('changes')
    expect(sqlPlateforme).toContain('auth.login.failed')
  })

  it('compte les départs sur exit_date et deleted_at, jamais sur updated_at', async () => {
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: [TENANT] }],
      [/information_schema\.columns/, { rows: [{ column_name: 'exit_date' }, { column_name: 'deleted_at' }] }],
      [/headcount/, { rows: [{ headcount: 82, hires: 3, departures: 4 }] }],
    ])

    const data = await collectReport(pool, period)
    expect(data.tenants[0]?.departures).toBe(4)
    const sqlEmp = queryMock.mock.calls.map(c => String(c[0])).find(s => s.includes('headcount'))
    expect(sqlEmp).toContain('exit_date')
    expect(sqlEmp).toContain('deleted_at')
    expect(sqlEmp).not.toContain('updated_at')
    // Arrivées : colonne métier hire_date, repli created_at.
    expect(sqlEmp).toContain('COALESCE(hire_date')
  })

  it('n’utilise pas deleted_at quand la colonne n’existe pas dans ce schéma', async () => {
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: [TENANT] }],
      [/information_schema\.columns/, { rows: [{ column_name: 'exit_date' }] }],
      [/headcount/, { rows: [{ headcount: 5, hires: 0, departures: 0 }] }],
    ])

    await collectReport(pool, period)
    const sqlEmp = queryMock.mock.calls.map(c => String(c[0])).find(s => s.includes('headcount'))
    expect(sqlEmp).toContain('exit_date')
    expect(sqlEmp).not.toContain('deleted_at')
  })

  it('n’utilise pas exit_date quand la colonne n’existe pas dans ce schéma', async () => {
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: [TENANT] }],
      [/information_schema\.columns/, { rows: [{ column_name: 'deleted_at' }] }],
      [/headcount/, { rows: [{ headcount: 5, hires: 0, departures: 0 }] }],
    ])

    await collectReport(pool, period)
    const sqlEmp = queryMock.mock.calls.map(c => String(c[0])).find(s => s.includes('headcount'))
    expect(sqlEmp).not.toContain('exit_date')
    expect(sqlEmp).toContain('deleted_at')
  })

  it('ramène le compteur de départs à 0 sans faire échouer la collecte quand ni exit_date ni deleted_at n’existent', async () => {
    const t2 = { ...TENANT, id: 't2', name: 'ANCIEN', schema_name: 'tenant_ancien' }
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: [TENANT, t2] }],
      [/information_schema\.columns/, { rows: [] }],
      [/headcount/, { rows: [{ headcount: 5, hires: 0, departures: 0 }] }],
      [/active_users/, { rows: [{ active_users: 3, logged_in: 1, last_login_at: null }] }],
    ])

    const data = await collectReport(pool, period)
    expect(data.tenants[0]?.collected).toBe(true)
    expect(data.tenants[0]?.departures).toBe(0)
    expect(data.tenants[1]?.collected).toBe(true)
    expect(data.tenants[1]?.departures).toBe(0)
    const sqlEmp = queryMock.mock.calls.map(c => String(c[0])).find(s => s.includes('headcount'))
    expect(sqlEmp).not.toContain('exit_date')
    expect(sqlEmp).not.toContain('deleted_at')
  })

  it('ramène les jours en UTC explicitement, sans dépendre du fuseau de session', async () => {
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: [TENANT] }],
      [/information_schema\.columns/, { rows: [{ column_name: 'deleted_at' }] }],
    ])
    await collectReport(pool, period)
    const jours = queryMock.mock.calls.map(c => String(c[0])).filter(s => s.includes('to_char('))
    expect(jours.length).toBeGreaterThan(0)
    for (const sql of jours) expect(sql).toContain("AT TIME ZONE 'UTC'")
  })

  it('signale la troncature quand le parc dépasse le plafond de collecte', async () => {
    // Le plafond par défaut est 500 : on renvoie 501 lignes, la 501e n'étant
    // là que pour révéler le dépassement.
    const parc = Array.from({ length: 501 }, (_, i) => ({
      ...TENANT, id: `t${i}`, name: `E${i}`, schema_name: `tenant_${i}`,
    }))
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: parc }],
      [/information_schema\.columns/, { rows: [] }],
    ])
    const data = await collectReport(pool, period)
    expect(data.truncated).toBe(true)
    expect(data.tenants).toHaveLength(500)
  })

  it('ne relit pas la liste des tenants pour la tendance', async () => {
    repondSelonSql([
      [/FROM platform\.tenants/, { rows: [TENANT] }],
      [/information_schema\.columns/, { rows: [{ column_name: 'deleted_at' }] }],
    ])
    await collectReport(pool, period)
    const lectures = queryMock.mock.calls.map(c => String(c[0]))
      .filter(s => s.includes('FROM platform.tenants'))
    expect(lectures).toHaveLength(1)
  })
})
