/**
 * Parité du refactor : createTenantWithSchema doit reproduire EXACTEMENT le
 * pipeline de l'ancien handler POST /platform/tenants (INSERT tenant + provision
 * + seeds CI + admin), plus le support de l'expéditeur cabinet (From/Reply-To).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  config: { appUrl: 'http://localhost:3001', smtp: { from: 'NexusRH CI <noreply@nexusrh-ci.com>' } },
}))

const provisionMock = vi.fn().mockResolvedValue(undefined)
const seedRulesMock = vi.fn().mockResolvedValue(undefined)
const seedAbsMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../db/provisioning.js', () => ({
  provisionTenantSchema: (...a: unknown[]) => provisionMock(...a),
  seedPayrollRulesCI: (...a: unknown[]) => seedRulesMock(...a),
  seedAbsenceTypesCI: (...a: unknown[]) => seedAbsMock(...a),
}))

const sendWelcomeMock = vi.fn().mockResolvedValue(undefined)
vi.mock('./email.js', () => ({ sendWelcomeTenantEmail: (...a: unknown[]) => sendWelcomeMock(...a) }))

const seedDemoMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../db/seed-demo.js', () => ({ seedDemoTenant: (...a: unknown[]) => seedDemoMock(...a) }))

import { createTenantWithSchema, TenantSlugConflictError, PLAN_DEFAULTS, AT_RATE_BY_SECTOR } from './tenant-provisioning.service.js'

function makePool(slugExists: boolean) {
  const query = vi.fn()
  // 1er appel : vérif unicité slug
  query.mockResolvedValueOnce({ rows: slugExists ? [{ id: 'dup' }] : [] })
  // 2e appel : INSERT tenant RETURNING id
  query.mockResolvedValueOnce({ rows: [{ id: 'tenant-uuid-1' }] })
  // 3e appel : INSERT admin user
  query.mockResolvedValueOnce({ rows: [] })
  return { query } as never
}

const baseInput = {
  name: 'ACME CI', slug: 'acme', planType: 'business' as const, sector: 'btp',
  adminEmail: 'admin@acme.ci', adminFirstName: 'Awa', adminLastName: 'Koné',
}

beforeEach(() => {
  provisionMock.mockClear(); seedRulesMock.mockClear(); seedAbsMock.mockClear()
  sendWelcomeMock.mockClear(); seedDemoMock.mockClear()
})

describe('createTenantWithSchema', () => {
  it('rejette un slug déjà pris (TenantSlugConflictError)', async () => {
    const pool = makePool(true)
    await expect(createTenantWithSchema(pool, baseInput)).rejects.toBeInstanceOf(TenantSlugConflictError)
  })

  it('happy path : INSERT tenant + provision + seeds CI + admin + retour', async () => {
    const pool = makePool(false)
    const res = await createTenantWithSchema(pool, baseInput, { logger: { warn: vi.fn() } })

    expect(res).toMatchObject({
      id: 'tenant-uuid-1', slug: 'acme', schemaName: 'tenant_acme',
      name: 'ACME CI', planType: 'business', adminEmail: 'admin@acme.ci',
    })
    expect(res.tempPassword).toMatch(/^CI_.+!$/)

    // provision + seeds appelés sur le bon schéma, AT rate BTP = 0.030
    expect(provisionMock).toHaveBeenCalledWith('tenant_acme')
    expect(seedRulesMock).toHaveBeenCalledWith('tenant_acme', AT_RATE_BY_SECTOR['btp'])
    expect(seedAbsMock).toHaveBeenCalledWith('tenant_acme')

    // INSERT tenant : limites du plan business
    const insertCall = (pool as unknown as { query: ReturnType<typeof vi.fn> }).query.mock.calls[1]!
    const params = insertCall[1] as unknown[]
    expect(params).toContain('tenant_acme')
    expect(params).toContain(PLAN_DEFAULTS['business']!.maxUsers)
    expect(params).toContain(PLAN_DEFAULTS['business']!.maxEmployees)
  })

  it('expéditeur cabinet : from + replyTo passés à l\'email', async () => {
    const pool = makePool(false)
    await createTenantWithSchema(pool, baseInput, {
      sender: { email: 'recrut@cabinet.ci', name: 'Cabinet RH' },
      logoUrl: 'http://api/public/brand/xyz',
    })
    expect(sendWelcomeMock).toHaveBeenCalledTimes(1)
    const arg = sendWelcomeMock.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.from).toBe('Cabinet RH <recrut@cabinet.ci>')
    expect(arg.replyTo).toBe('recrut@cabinet.ci')
    expect(arg.logoUrl).toBe('http://api/public/brand/xyz')
  })

  it('sans expéditeur cabinet : from/replyTo null (défaut OpenLab)', async () => {
    const pool = makePool(false)
    await createTenantWithSchema(pool, baseInput)
    const arg = sendWelcomeMock.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.from).toBeNull()
    expect(arg.replyTo).toBeNull()
  })
})

describe('createTenantWithSchema — slug avec tiret et échec de provisionnement', () => {
  function routedPool(opts: { schemaExists?: boolean } = {}) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM platform.tenants WHERE slug')) return { rows: [] }
      if (sql.includes('INSERT INTO platform.tenants')) return { rows: [{ id: 'tenant-uuid-2' }] }
      if (sql.includes('information_schema.schemata')) return { rows: opts.schemaExists ? [{ '?column?': 1 }] : [] }
      return { rows: [] }
    })
    return { pool: { query } as never, query }
  }

  it('slug « test-solde » → schéma tenant_test_solde (le tiret est refusé dans un nom de schéma)', async () => {
    const { pool } = routedPool()
    const res = await createTenantWithSchema(pool, { ...baseInput, slug: 'test-solde' })
    expect(res.slug).toBe('test-solde')
    expect(res.schemaName).toBe('tenant_test_solde')
    expect(provisionMock).toHaveBeenCalledWith('tenant_test_solde')
  })

  it('échec du provisionnement : tenant retiré du registre et schéma créé supprimé, erreur relancée', async () => {
    const { pool, query } = routedPool()
    provisionMock.mockRejectedValueOnce(new Error('boom'))
    await expect(createTenantWithSchema(pool, baseInput)).rejects.toThrow('boom')
    const sqls = query.mock.calls.map(c => String(c[0]))
    expect(sqls.some(s => s.includes('DROP SCHEMA IF EXISTS "tenant_acme" CASCADE'))).toBe(true)
    expect(query.mock.calls.some(c => String(c[0]).includes('DELETE FROM platform.tenants')
      && (c[1] as unknown[])[0] === 'tenant-uuid-2')).toBe(true)
    expect(sendWelcomeMock).not.toHaveBeenCalled()
  })

  it('échec avec un schéma qui existait déjà : le schéma n\'est jamais supprimé', async () => {
    const { pool, query } = routedPool({ schemaExists: true })
    seedAbsMock.mockRejectedValueOnce(new Error('seed KO'))
    await expect(createTenantWithSchema(pool, baseInput)).rejects.toThrow('seed KO')
    expect(query.mock.calls.some(c => String(c[0]).includes('DROP SCHEMA'))).toBe(false)
    expect(query.mock.calls.some(c => String(c[0]).includes('DELETE FROM platform.tenants'))).toBe(true)
  })
})

describe('createTenantWithSchema — fiche employé « à compléter » de l\'admin', () => {
  function routedPool(failOnEmployee = false) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM platform.tenants WHERE slug')) return { rows: [] }
      if (sql.includes('INSERT INTO platform.tenants')) return { rows: [{ id: 'tenant-uuid-3' }] }
      if (failOnEmployee && sql.includes('INSERT INTO "tenant_acme".employees')) throw new Error('employees KO')
      return { rows: [] }
    })
    return { pool: { query } as never, query }
  }
  const norm = (s: string) => s.replace(/\s+/g, ' ')

  it('crée la fiche (salaire 0, poste Administrateur RH) et la lie au compte admin, après l\'INSERT users', async () => {
    const { pool, query } = routedPool()
    await createTenantWithSchema(pool, baseInput)
    const sqls = query.mock.calls.map(c => norm(String(c[0])))
    const userIdx = sqls.findIndex(s => s.includes('INSERT INTO "tenant_acme".users'))
    const linkIdx = sqls.findIndex(s => s.includes('UPDATE "tenant_acme".users u SET employee_id = e.id'))
    const createIdx = sqls.findIndex(s => s.includes('INSERT INTO "tenant_acme".employees'))
    expect(userIdx).toBeGreaterThanOrEqual(0)
    expect(linkIdx).toBeGreaterThan(userIdx)
    expect(createIdx).toBeGreaterThan(linkIdx)
    expect(sqls[createIdx]).toContain("'Administrateur RH', CURRENT_DATE, 0, true")
    expect(sqls[createIdx]).toContain('SET employee_id = ins.id')
    // Scopé à l'admin créé (email), schéma du tenant — jamais en dur.
    expect(query.mock.calls[createIdx]![1]).toEqual(['admin@acme.ci'])
  })

  it('échec de création de la fiche : tenant annulé (atomicité), erreur relancée', async () => {
    const { pool, query } = routedPool(true)
    await expect(createTenantWithSchema(pool, baseInput)).rejects.toThrow('employees KO')
    expect(query.mock.calls.some(c => String(c[0]).includes('DELETE FROM platform.tenants'))).toBe(true)
    expect(sendWelcomeMock).not.toHaveBeenCalled()
  })
})
