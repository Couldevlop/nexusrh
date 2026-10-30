/**
 * authorize() × grille d'habilitations.
 *
 * Le moteur (`loadHabContext`) est mocké : on pilote directement le contexte
 * d'habilitation renvoyé pour chaque utilisateur. `can` et `hrScopeSql` restent
 * les vrais (logique pure).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))
vi.mock('../services/redis.js', () => ({
  blacklistToken:      vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe:  vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted:  vi.fn().mockResolvedValue(false),
  redisLockoutStore:   {},
  setTokenEpoch:       vi.fn().mockResolvedValue(undefined),
  getTokenEpoch:       vi.fn().mockResolvedValue(0),
}))
vi.mock('../services/email.js', () => ({
  sendEmployeeWelcomeEmail:    vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:      vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:      vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail:  vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../services/breach-check.service.js', () => ({
  isPasswordBreached: vi.fn().mockResolvedValue(null),
}))

const { loadHabContextMock } = vi.hoisted(() => ({ loadHabContextMock: vi.fn() }))
vi.mock('../services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})

import authPlugin from './auth.js'
import authRoutes from '../modules/auth/auth.routes.js'
import type { HabContext } from '../services/habilitation.service.js'

const SCHEMA = 'tenant_test'
const ENTITY = '11111111-2222-4333-8444-555555555555'

function ctx(permissions: string[], over: Partial<HabContext> = {}): HabContext {
  return {
    userId: 'u-hab',
    subgroupId: 'sg-1',
    kind: 'siege',
    legalEntityId: null,
    permissions: new Set(permissions),
    allEntities: false,
    sensitive: false,
    manageHabilitations: false,
    selfEmployeeId: null,
    ...over,
  }
}

let app: FastifyInstance

function token(role: string, extra: Record<string, unknown> = {}): string {
  return app.jwt.sign({
    sub: 'u-hab', tenantId: null, schemaName: SCHEMA, role,
    email: 'x@t.ci', firstName: 'A', lastName: 'B', employeeId: null,
    ...extra,
  })
}

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, role: string, extra: Record<string, unknown> = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token(role, extra)}` } })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(async (f) => {
    f.post('/periods/:id/close', { preHandler: [f.authorize('admin', 'hr_manager')] }, async () => ({ ok: true }))
    f.get('/periods', { preHandler: [f.authorize('admin', 'hr_manager', 'hr_officer')] }, async () => ({ ok: true }))
  }, { prefix: '/payroll' })
  await app.register(async (f) => {
    f.get('/jobs', { preHandler: [f.authorize('admin', 'hr_manager', 'hr_officer')] }, async () => ({ ok: true }))
  }, { prefix: '/recruitment' })
  await app.register(async (f) => {
    f.get('/tenant', { preHandler: [f.authorize('admin')] }, async () => ({ ok: true }))
    f.get('/both', {
      preHandler: [f.authorize('admin', 'hr_manager'), f.authorize('admin', 'hr_manager')],
    }, async () => ({ ok: true }))
  }, { prefix: '/settings' })
  // Routes self-service (ouvertes aussi aux employés) : renvoient le rôle
  // effectif vu par le handler.
  await app.register(async (f) => {
    f.get('/my-contract', {
      preHandler: [f.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly')],
    }, async (req) => ({ role: req.user.role }))
  }, { prefix: '/contracts' })
  await app.register(async (f) => {
    f.patch('/:id', {
      preHandler: [f.authorize('admin', 'hr_manager', 'hr_officer', 'employee')],
    }, async (req) => ({ role: req.user.role }))
  }, { prefix: '/employees' })
  await app.register(async (f) => {
    f.get('/x', { preHandler: [f.authorize('admin', 'hr_manager')] }, async () => ({ ok: true }))
  }, { prefix: '/unmapped-module' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  loadHabContextMock.mockReset()
})

describe('authorize() consulte la grille', () => {
  it('hr_officer habilité SANS payroll:close → 403 sur la clôture', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['payroll:view', 'payroll:validate']))
    const res = await call('POST', '/payroll/periods/p1/close', 'hr_officer')
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('Accès interdit — habilitation insuffisante')
  })

  it('hr_officer habilité AVEC payroll:close → 200, même si son rôle n\'est pas listé', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['payroll:close']))
    const res = await call('POST', '/payroll/periods/p1/close', 'hr_officer')
    expect(res.statusCode).toBe(200)
  })

  it('hr_manager habilité sans la case, alors que son rôle est listé → 403', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['payroll:view']))
    const res = await call('POST', '/payroll/periods/p1/close', 'hr_manager')
    expect(res.statusCode).toBe(403)
  })

  it('sans affectation : comportement hérité (hr_officer refusé, hr_manager admis)', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const refused = await call('POST', '/payroll/periods/p1/close', 'hr_officer')
    expect(refused.statusCode).toBe(403)
    expect(JSON.parse(refused.body).error).toBe('Accès interdit — rôle insuffisant')
    const allowed = await call('POST', '/payroll/periods/p1/close', 'hr_manager')
    expect(allowed.statusCode).toBe(200)
  })

  it('admin passe toujours, sans consulter la grille', async () => {
    const res = await call('POST', '/payroll/periods/p1/close', 'admin')
    expect(res.statusCode).toBe(200)
    expect(loadHabContextMock).not.toHaveBeenCalled()
  })

  it('employee habilité recruitment:view → 200 sur GET /recruitment/jobs', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['recruitment:view']))
    const res = await call('GET', '/recruitment/jobs', 'employee')
    expect(res.statusCode).toBe(200)
  })

  it('employee habilité reste refusé sur une route authorize(\'admin\')', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['hr_settings:view', 'hr_settings:configure']))
    const res = await call('GET', '/settings/tenant', 'employee')
    expect(res.statusCode).toBe(403)
  })

  it('employee sans affectation : refusé avec le message hérité', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const res = await call('GET', '/recruitment/jobs', 'employee')
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('Accès interdit — rôle insuffisant')
  })

  it('affectation inactive (kind none) → 403 habilitation, jamais l\'accès hérité', async () => {
    loadHabContextMock.mockResolvedValue(ctx([], { kind: 'none' }))
    const res = await call('GET', '/payroll/periods', 'hr_manager')
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('Accès interdit — habilitation insuffisante')
  })

  it('route RH sans correspondance dans la table → 403 pour un habilité', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['payroll:view']))
    const res = await call('GET', '/unmapped-module/x', 'hr_manager')
    expect(res.statusCode).toBe(403)
  })

  it('erreur du moteur → 403 (fermé), jamais 500 ni accès hérité', async () => {
    loadHabContextMock.mockRejectedValue(new Error('db down'))
    const res = await call('GET', '/payroll/periods', 'hr_manager')
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('Accès interdit — habilitation insuffisante')
  })

  it('périmètre invalide (filiale sans entité légale) → 403', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['payroll:view'], { kind: 'entity', legalEntityId: null }))
    const res = await call('GET', '/payroll/periods', 'hr_manager')
    expect(res.statusCode).toBe(403)
  })

  it('jeton plateforme ou cabinet : pas de consultation de la grille', async () => {
    const platform = await call('GET', '/payroll/periods', 'hr_manager', { schemaName: 'platform' })
    expect(platform.statusCode).toBe(200)
    const agency = await call('GET', '/payroll/periods', 'hr_manager', { actorType: 'agency', agencyId: 'a1' })
    expect(agency.statusCode).toBe(200)
    expect(loadHabContextMock).not.toHaveBeenCalled()
  })

  it('contexte chargé une seule fois par requête', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['hr_settings:view']))
    const res = await call('GET', '/settings/both', 'hr_officer')
    expect(res.statusCode).toBe(200)
    expect(loadHabContextMock).toHaveBeenCalledTimes(1)
  })
})

describe('self-service préservé pour un rôle RH refusé par la grille', () => {
  it("hr_officer en affectation inactive (none) sur une route self-service → 200 en tant qu'employé", async () => {
    loadHabContextMock.mockResolvedValue(ctx([], { kind: 'none' }))
    const res = await call('GET', '/contracts/my-contract', 'hr_officer')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).role).toBe('employee')
  })

  it('hr_officer habilité sans employees:update sur PATCH /employees/:id → branche employé, pas RH', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['employees:view']))
    const res = await call('PATCH', '/employees/e1', 'hr_officer')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).role).toBe('employee')
  })

  it('hr_officer habilité AVEC employees:update → garde son rôle RH', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['employees:update']))
    const res = await call('PATCH', '/employees/e1', 'hr_officer')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).role).toBe('hr_officer')
  })

  it('hr_officer en affectation inactive sur une route RH seule (sans employee) → 403', async () => {
    loadHabContextMock.mockResolvedValue(ctx([], { kind: 'none' }))
    const res = await call('GET', '/payroll/periods', 'hr_officer')
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('Accès interdit — habilitation insuffisante')
  })

  it("le rôle du JWT n'est pas modifié : la requête suivante repart du rôle RH", async () => {
    loadHabContextMock.mockResolvedValue(ctx(['employees:update']))
    const tok = token('hr_officer')
    loadHabContextMock.mockResolvedValueOnce(ctx([], { kind: 'none' }))
    const first = await app.inject({ method: 'PATCH', url: '/employees/e1', headers: { authorization: `Bearer ${tok}` } })
    expect(JSON.parse(first.body).role).toBe('employee')
    const second = await app.inject({ method: 'PATCH', url: '/employees/e1', headers: { authorization: `Bearer ${tok}` } })
    expect(JSON.parse(second.body).role).toBe('hr_officer')
  })
})

describe('GET /auth/me — permissions et périmètre', () => {
  it('permissions null sans affectation', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const res = await call('GET', '/auth/me', 'hr_manager')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.permissions).toBeNull()
    expect(body.habScope).toBeNull()
    expect(body.user.role).toBe('hr_manager')
  })

  it('liste effective avec une affectation', async () => {
    loadHabContextMock.mockResolvedValue(ctx(['payroll:view', 'recruitment:view'], { kind: 'entity', legalEntityId: ENTITY }))
    const res = await call('GET', '/auth/me', 'employee')
    const body = JSON.parse(res.body)
    expect([...body.permissions].sort()).toEqual(['payroll:view', 'recruitment:view'])
    expect(body.habScope).toEqual({ kind: 'entity', legalEntityId: ENTITY, allEntities: false })
  })

  it('affectation inactive : liste vide', async () => {
    loadHabContextMock.mockResolvedValue(ctx([], { kind: 'none' }))
    const res = await call('GET', '/auth/me', 'hr_officer')
    const body = JSON.parse(res.body)
    expect(body.permissions).toEqual([])
    expect(body.habScope).toEqual({ kind: 'none', legalEntityId: null, allEntities: false })
  })

  it('erreur du moteur : liste vide et périmètre none (fermé)', async () => {
    loadHabContextMock.mockRejectedValue(new Error('db down'))
    const res = await call('GET', '/auth/me', 'hr_officer')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.permissions).toEqual([])
    expect(body.habScope).toEqual({ kind: 'none', legalEntityId: null, allEntities: false })
  })

  it('jeton plateforme : permissions null sans requête', async () => {
    const res = await call('GET', '/auth/me', 'super_admin', { schemaName: 'platform' })
    const body = JSON.parse(res.body)
    expect(body.permissions).toBeNull()
    expect(loadHabContextMock).not.toHaveBeenCalled()
  })
})
