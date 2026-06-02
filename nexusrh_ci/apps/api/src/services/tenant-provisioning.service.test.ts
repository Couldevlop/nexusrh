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
