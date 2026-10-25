import { describe, it, expect, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn().mockResolvedValue({ rows: [] }) }))
vi.mock('../db/pool.js', () => ({ pool: { query: queryMock } }))

import { actorEmployeeSql } from './actor-employee.js'
import { ensureTenantSchema } from './schema-migrations.js'

describe('actorEmployeeSql — lien compte ↔ fiche', () => {
  it('préfère users.employee_id puis se replie sur l’email ($1 seul paramètre)', () => {
    const sql = actorEmployeeSql('tenant_sotra')
    const iExplicit = sql.indexOf('u.employee_id FROM "tenant_sotra".users')
    const iEmail = sql.indexOf('FROM "tenant_sotra".employees WHERE email = $1')
    expect(iExplicit).toBeGreaterThan(-1)
    expect(iEmail).toBeGreaterThan(iExplicit)
    expect(sql).toMatch(/COALESCE\(/)
    expect(sql).not.toContain('$2')
  })

  it('refuse un nom de schéma non sûr (OWASP A03)', () => {
    expect(() => actorEmployeeSql('tenant"; DROP TABLE users; --')).toThrow()
  })
})

describe('schema-migrations — reprises recette 10/2026 (idempotentes)', () => {
  it('normalise l’opérateur Mobile Money et renseigne users.employee_id sur email unique', async () => {
    await ensureTenantSchema('tenant_reprise')
    const sqls = queryMock.mock.calls.map(c => String(c[0]))
    const mm = sqls.find(s => s.includes('SET mobile_money_provider = CASE'))!
    expect(mm).toContain(`WHEN 'mtn_momo' THEN 'mtn'`)
    expect(mm).toContain(`WHEN 'orange_money' THEN 'orange'`)
    // Idempotence : ne vise que les formes historiques.
    expect(mm).toContain(`IN ('mtn_momo', 'momo', 'orange_money', 'om')`)

    const link = sqls.find(s => s.includes('".users u') && s.includes('SET employee_id = e.id'))!
    expect(link).toContain('u.employee_id IS NULL')
    expect(link).toContain('= 1') // email désignant UNE seule fiche
    expect(link).toContain('NOT EXISTS')
    const iLink = sqls.indexOf(link)
    const iIdx = sqls.findIndex(s => s.includes('users_employee_id_uniq'))
    expect(iIdx).toBeGreaterThan(iLink) // unicité posée APRÈS la reprise
  })
})
