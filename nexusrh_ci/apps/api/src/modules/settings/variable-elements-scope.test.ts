/**
 * Périmètre filiale (habilitations RH) sur les ÉLÉMENTS VARIABLES de paie.
 *
 * Constat de la revue de sécurité du 07/11/2026 : `/settings/variable-elements`
 * est ouverte à `hr_manager`, un rôle qui PEUT être borné à une filiale par la
 * grille d'habilitations — or ni la liste, ni la création, ni la suppression
 * n'appliquaient le fragment de périmètre. Un RAF de site pouvait donc lire et
 * supprimer les primes d'un salarié d'une autre filiale (IDOR).
 *
 * Invariants protégés ici : la liste est filtrée en SQL, et une écriture hors
 * périmètre répond 404 (jamais 403 : le 403 révélerait que la ligne existe)
 * SANS aucune écriture métier.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  setTokenEpoch:      vi.fn().mockResolvedValue(undefined),
  getTokenEpoch:      vi.fn().mockResolvedValue(0),
}))
vi.mock('../../db/provisioning.js', () => ({ provisionTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: vi.fn().mockResolvedValue({ sent: true }),
  sendTestEmail:            vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@nexusrhci/shared/ssrf-guard', () => ({
  isSafeOutboundUrl:      vi.fn(async () => ({ ok: true as const })),
  assertSafeOutboundUrl:  vi.fn(async (raw: string) => new URL(raw)),
  assertSafeOutboundHost: vi.fn(async () => undefined),
  SsrfBlockedError:       class extends Error {},
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))
const { loadHabContextMock } = vi.hoisted(() => ({ loadHabContextMock: vi.fn() }))
vi.mock('../../services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})

import authPlugin from '../../plugins/auth.js'
import settingsRoutes from './settings.routes.js'
import { HAB_GRID } from '../habilitations/catalog.js'
import type { HabContext } from '../../services/habilitation.service.js'

const SCHEMA = 'tenant_sotra'
const A = 'aaaaaaaa-1111-4222-8333-444444444444'
const ELEM = 'bbbbbbbb-1111-4222-8333-444444444444'
const EMP = 'dddddddd-1111-4222-8333-444444444444'
const FRAGMENT = `legal_entity_id = '${A}'`

/** Vrai quand la lecture bornée par le périmètre renvoie une ligne. */
let inScope = false

function entityCtx(): HabContext {
  const perms = Object.entries(HAB_GRID).flatMap(([fn, actions]) => actions.map((a) => `${fn}:${a}`))
  return {
    userId: 'u-hab', subgroupId: 'sg-1', kind: 'entity', legalEntityId: A,
    permissions: new Set(perms), allEntities: false, sensitive: true,
    manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

const sqls = (): string[] => queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
/** Écritures MÉTIER : la trace d'audit des habilitations est volontaire, refus compris. */
const writes = (): string[] => sqls()
  .filter((s) => /^(UPDATE|DELETE|INSERT)/i.test(s.trim()))
  .filter((s) => !/INSERT INTO "[a-z0-9_]+"\.audit_log/i.test(s))

let app: FastifyInstance

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  const token = app.jwt.sign({
    sub: 'u-hab', tenantId: 't1', schemaName: SCHEMA, role: 'hr_manager',
    email: 'raf@sotra.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  inScope = false
  loadHabContextMock.mockReset().mockResolvedValue(entityCtx())
  queryMock.mockReset().mockImplementation(async (sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ')
    if (/INSERT INTO "[a-z0-9_]+"\.audit_log/i.test(s)) return { rows: [], rowCount: 1 }
    if (/FROM "[a-z0-9_]+"\.variable_elements/i.test(s)) {
      return inScope ? { rows: [{ id: ELEM, employee_id: EMP }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    // Garde d'existence « dans mon périmètre » sur employees.
    if (/^SELECT 1 FROM/i.test(s.trim())) {
      return inScope ? { rows: [{ '1': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/FROM "[a-z0-9_]+"\.pay_periods/i.test(s)) return { rows: [{ id: 'per-1' }], rowCount: 1 }
    if (/^DELETE/i.test(s)) return { rows: [], rowCount: 1 }
    if (/^INSERT/i.test(s)) return { rows: [{ id: 'new' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
})

describe('GET /settings/variable-elements — liste filtrée par filiale', () => {
  it('le fragment de périmètre figure dans le SQL de la liste', async () => {
    const res = await call('GET', '/settings/variable-elements')
    expect(res.statusCode).toBe(200)
    expect(sqls().filter((s) => /FROM "[a-z0-9_]+"\.variable_elements/i.test(s)).join('\n')).toContain(FRAGMENT)
  })
})

describe('DELETE /settings/variable-elements/:id — hors périmètre', () => {
  it('répond 404 et ne supprime rien', async () => {
    const res = await call('DELETE', `/settings/variable-elements/${ELEM}`)
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })

  it('supprime dans son périmètre', async () => {
    inScope = true
    const res = await call('DELETE', `/settings/variable-elements/${ELEM}`)
    expect(res.statusCode).toBe(200)
    expect(writes().some((s) => /^DELETE FROM "[a-z0-9_]+"\.variable_elements/i.test(s))).toBe(true)
  })
})

describe('POST /settings/variable-elements — salarié hors périmètre', () => {
  it('répond 404 et n\'insère rien', async () => {
    const res = await call('POST', '/settings/variable-elements', {
      employee_id: EMP, rule_code: 'PRIME', amount: 50_000, month: '2026-11',
    })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })

  it('accepte un salarié de sa filiale', async () => {
    inScope = true
    const res = await call('POST', '/settings/variable-elements', {
      employee_id: EMP, rule_code: 'PRIME', amount: 50_000, month: '2026-11',
    })
    expect(res.statusCode).toBe(201)
  })
})
