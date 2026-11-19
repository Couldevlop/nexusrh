/**
 * Golden — un UUID malformé en paramètre de route répond 400, jamais 500.
 *
 * Constaté en test dynamique sur l'application réellement démarrée (rapport
 * d'audit du 19/11/2026, §5.4) :
 *
 *   GET /employees/pas-un-uuid      → HTTP 500
 *   GET /employees/1';DROP TABLE... → HTTP 500
 *
 * avec dans le journal API : `"file": "uuid.c", "routine": "string_to_uuid"`
 * — PostgreSQL levait `22P02` et l'erreur remontait non interceptée.
 *
 * Ce test verrouille les deux sens : les UUID valides passent (aucune route
 * légitime cassée), les non-UUID sont refusés avant d'atteindre la base.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'uuid-param-secret-minimum-32-characters!!'
  process.env.LOG_LEVEL    = 'silent'
})

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
}))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn(), connect: vi.fn() })),
}))
vi.mock('./services/redis.js', () => ({
  redis:              { quit: vi.fn(), disconnect: vi.fn() },
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch:      vi.fn().mockResolvedValue(0),
  setTokenEpoch:      vi.fn().mockResolvedValue(undefined),
  consumeTotpStep:    vi.fn().mockResolvedValue(true),
}))

import { buildApp } from './app.js'
import { findInvalidUuidParam, UUID_PARAM_NAMES } from './utils/uuid-params.js'

const VALID_UUID = '11111111-1111-4111-8111-111111111111'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => {
  await app?.close()
})

describe('findInvalidUuidParam', () => {
  it('accepte un UUID canonique', () => {
    expect(findInvalidUuidParam({ id: VALID_UUID })).toBeNull()
  })

  it('accepte un UUID en majuscules', () => {
    expect(findInvalidUuidParam({ id: VALID_UUID.toUpperCase() })).toBeNull()
  })

  it('désigne le paramètre fautif', () => {
    expect(findInvalidUuidParam({ id: 'pas-un-uuid' })).toBe('id')
    expect(findInvalidUuidParam({ employeeId: '42' })).toBe('employeeId')
  })

  it('ignore les paramètres qui ne portent légitimement pas d’UUID', () => {
    expect(findInvalidUuidParam({ month: '2026-01' })).toBeNull()
    expect(findInvalidUuidParam({ year: '2026' })).toBeNull()
    expect(findInvalidUuidParam({ tenantSlug: 'demo-tenant' })).toBeNull()
    expect(findInvalidUuidParam({ provider: 'wave' })).toBeNull()
    expect(findInvalidUuidParam({ token: 'aaaa.bbbb' })).toBeNull()
    expect(findInvalidUuidParam({ country: 'CIV' })).toBeNull()
    expect(findInvalidUuidParam({ quarter: 'Q1' })).toBeNull()
  })

  it('refuse une charge utile de type inattendu sans lever', () => {
    expect(findInvalidUuidParam(null)).toBeNull()
    expect(findInvalidUuidParam('pas un objet')).toBeNull()
    expect(findInvalidUuidParam({ id: 42 })).toBeNull()
  })

  it('n’oublie aucun nom de paramètre UUID connu', () => {
    for (const n of ['id', 'employeeId', 'jobId', 'docId', 'userId', 'tenantId']) {
      expect(UUID_PARAM_NAMES.has(n)).toBe(true)
    }
  })
})

describe('Route avec :id — UUID malformé', () => {
  // Le cas exact relevé en production locale. Sans le hook : 500.
  it.each([
    ['pas-un-uuid'],
    ["1';DROP TABLE users--"],
    ['42'],
    ['../../platform/tenants'],
    ['11111111-1111-4111-8111-11111111111'],   // un caractère de trop court
    ['11111111111141118111111111111111'],      // sans tirets
  ])('GET /employees/%s → 400, jamais 500', async (bad) => {
    const res = await app.inject({ method: 'GET', url: `/employees/${encodeURIComponent(bad)}` })
    expect(res.statusCode).toBe(400)
  })

  it('le corps nomme le paramètre fautif, sans trace d’exécution', async () => {
    const res = await app.inject({ method: 'GET', url: '/employees/pas-un-uuid' })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('id')
    expect(res.body).not.toMatch(/\.ts:|node_modules|string_to_uuid/)
  })

  it('un UUID valide n’est PAS intercepté (il part à l’authentification)', async () => {
    const res = await app.inject({ method: 'GET', url: `/employees/${VALID_UUID}` })
    expect(res.statusCode).not.toBe(400)
    expect(res.statusCode).toBe(401) // pas de jeton → 401, comportement inchangé
  })

  it('une route à paramètre non-UUID reste joignable', async () => {
    // :tenantSlug ne doit pas être traité comme un UUID.
    const res = await app.inject({ method: 'GET', url: '/recruitment/public/demo-tenant/jobs' })
    expect(res.statusCode).not.toBe(400)
  })
})
