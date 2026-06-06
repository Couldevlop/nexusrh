/**
 * Tests de couverture ciblée — tenant-provisioning.service.
 *
 * Complète tenant-provisioning.service.test.ts (parité refactor) en couvrant :
 *   - le constructeur TenantSlugConflictError (message + name)
 *   - la branche seedDemoData === true (seedDemoTenant lancé, non bloquant,
 *     son rejet est capté par .catch → logger.warn)
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

const seedDemoMock = vi.fn()
vi.mock('../db/seed-demo.js', () => ({ seedDemoTenant: (...a: unknown[]) => seedDemoMock(...a) }))

import { createTenantWithSchema, TenantSlugConflictError } from './tenant-provisioning.service.js'

function makePool() {
  const query = vi.fn()
  query.mockResolvedValueOnce({ rows: [] })                       // unicité slug (libre)
  query.mockResolvedValueOnce({ rows: [{ id: 'tenant-uuid-1' }] }) // INSERT tenant
  query.mockResolvedValueOnce({ rows: [] })                        // INSERT admin
  return { query } as never
}

const baseInput = {
  name: 'Démo CI', slug: 'demo', planType: 'business' as const, sector: 'services',
  adminEmail: 'admin@demo.ci', adminFirstName: 'Awa', adminLastName: 'Koné',
}

beforeEach(() => {
  provisionMock.mockClear(); seedRulesMock.mockClear(); seedAbsMock.mockClear()
  sendWelcomeMock.mockClear(); seedDemoMock.mockReset()
})

describe('TenantSlugConflictError', () => {
  it('expose le slug, un message explicite et le name de la classe', () => {
    const err = new TenantSlugConflictError('acme')
    expect(err).toBeInstanceOf(Error)
    expect(err.slug).toBe('acme')
    expect(err.name).toBe('TenantSlugConflictError')
    expect(err.message).toContain('acme')
  })
})

describe('createTenantWithSchema — seedDemoData', () => {
  it('seedDemoData=true → seedDemoTenant appelé (non bloquant)', async () => {
    seedDemoMock.mockResolvedValue(undefined)
    const pool = makePool()
    const res = await createTenantWithSchema(pool, { ...baseInput, seedDemoData: true })
    expect(res.id).toBe('tenant-uuid-1')
    expect(seedDemoMock).toHaveBeenCalledTimes(1)
    // schéma + taux AT services (0.020) passés au seed démo
    expect(seedDemoMock).toHaveBeenCalledWith(pool, 'tenant_demo', 0.02)
  })

  it('seedDemoData=true mais seedDemoTenant rejette → erreur captée par .catch (logger.warn)', async () => {
    seedDemoMock.mockRejectedValue(new Error('seed démo cassé'))
    const warn = vi.fn()
    const pool = makePool()
    // Ne doit PAS rejeter : la démo est best-effort.
    const res = await createTenantWithSchema(pool, { ...baseInput, seedDemoData: true }, { logger: { warn } })
    expect(res.id).toBe('tenant-uuid-1')
    // Laisse la microtask .catch se résoudre
    await new Promise(r => setImmediate(r))
    expect(warn).toHaveBeenCalledTimes(1)
    const arg = warn.mock.calls[0]![1]
    expect(arg).toContain('Seed démo')
  })

  it('seedDemoData absent → seedDemoTenant NON appelé', async () => {
    const pool = makePool()
    await createTenantWithSchema(pool, baseInput)
    expect(seedDemoMock).not.toHaveBeenCalled()
  })
})
