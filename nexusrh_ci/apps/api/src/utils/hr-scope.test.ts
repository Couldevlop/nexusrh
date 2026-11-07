/**
 * hr-scope : court-circuits sans requête, refus des colonnes non qualifiées,
 * filiale cible inconnue (null) hors périmètre d'une filiale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyRequest } from 'fastify'

const { queryMock, loadHab } = vi.hoisted(() => ({ queryMock: vi.fn(), loadHab: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../config.js', () => ({
  config: { env: 'test', database: { url: 'postgresql://test' }, jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' }, redis: { url: 'redis://localhost:6380' } },
}))
vi.mock('../services/redis.js', () => ({
  blacklistToken: vi.fn(), blacklistTokenSafe: vi.fn(), isTokenBlacklisted: vi.fn(),
  redisLockoutStore: {}, setTokenEpoch: vi.fn(), getTokenEpoch: vi.fn(),
}))
vi.mock('../services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHab }
})

import {
  requestHrScope, requestHrScopeUnlessSelf, requestEmployeeScope, employeeInHrScope, legalEntityInHrScope,
} from './hr-scope.js'
import type { HabContext } from '../services/habilitation.service.js'

const SCHEMA = 'tenant_x'
const A = 'aaaaaaaa-1111-4222-8333-444444444444'

function req(role: string): FastifyRequest {
  return { user: { schemaName: SCHEMA, role, sub: 'u1', actorType: undefined } } as unknown as FastifyRequest
}
function entityCtx(): HabContext {
  return {
    userId: 'u1', subgroupId: 's', kind: 'entity', legalEntityId: A, permissions: new Set(),
    allEntities: false, sensitive: false, manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

beforeEach(() => { queryMock.mockReset(); loadHab.mockReset() })

describe('requestHrScope', () => {
  it("admin : 'TRUE' sans consulter le moteur", async () => {
    expect(await requestHrScope(req('admin'), 'e')).toBe('TRUE')
    expect(loadHab).not.toHaveBeenCalled()
  })
  it("sans affectation (null) : 'TRUE'", async () => {
    loadHab.mockResolvedValue(null)
    expect(await requestHrScope(req('hr_manager'), 'e')).toBe('TRUE')
  })
  it('filiale : fragment legal_entity_id', async () => {
    loadHab.mockResolvedValue(entityCtx())
    expect(await requestHrScope(req('hr_manager'), 'e')).toBe(`e.legal_entity_id = '${A}'`)
  })
  it("UnlessSelf : rôle employee => 'TRUE' sans moteur", async () => {
    expect(await requestHrScopeUnlessSelf(req('employee'), 'e')).toBe('TRUE')
    expect(loadHab).not.toHaveBeenCalled()
  })
})

describe('requestEmployeeScope', () => {
  it("'TRUE' reste 'TRUE' (aucune sous-requête)", async () => {
    loadHab.mockResolvedValue(null)
    expect(await requestEmployeeScope(req('hr_manager'), 'contracts.employee_id')).toBe('TRUE')
  })
  it('enveloppe en EXISTS avec une colonne qualifiée', async () => {
    loadHab.mockResolvedValue(entityCtx())
    const sql = await requestEmployeeScope(req('hr_manager'), 'contracts.employee_id')
    expect(sql).toContain('EXISTS (SELECT 1 FROM "tenant_x".employees hs WHERE hs.id = contracts.employee_id')
    expect(sql).toContain(`hs.legal_entity_id = '${A}'`)
  })
  it('refuse une colonne non qualifiée ou suspecte', async () => {
    loadHab.mockResolvedValue(entityCtx())
    await expect(requestEmployeeScope(req('hr_manager'), 'employee_id')).rejects.toThrow()
    await expect(requestEmployeeScope(req('hr_manager'), 'a.employee_id; DROP TABLE x')).rejects.toThrow()
  })
})

describe('employeeInHrScope / legalEntityInHrScope', () => {
  it("scope 'TRUE' : vrai sans requête", async () => {
    expect(await employeeInHrScope(SCHEMA, 'x', 'TRUE')).toBe(true)
    expect(await legalEntityInHrScope(SCHEMA, null, 'TRUE')).toBe(true)
    expect(queryMock).not.toHaveBeenCalled()
  })
  it('employé : interroge avec le fragment', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await employeeInHrScope(SCHEMA, 'x', `e.legal_entity_id = '${A}'`)).toBe(false)
    expect(String(queryMock.mock.calls[0]![0])).toContain(`e.legal_entity_id = '${A}'`)
  })
  it('filiale cible null avec un périmètre filiale : faux (ligne virtuelle)', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await legalEntityInHrScope(SCHEMA, null, `e.legal_entity_id = '${A}'`)).toBe(false)
    expect(queryMock.mock.calls[0]![1]).toEqual([null])
  })
  it('nom de schéma invalide rejeté avant toute requête', async () => {
    await expect(employeeInHrScope('bad;schema', 'x', `e.legal_entity_id = '${A}'`)).rejects.toThrow()
    expect(queryMock).not.toHaveBeenCalled()
  })
})
