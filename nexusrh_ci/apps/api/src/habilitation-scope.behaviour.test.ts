// Comportement du périmètre filiale (habilitations) sur les écritures : hors
// périmètre = 404 sans écriture, déplacement vers une filiale étrangère = 403,
// conteneurs partagés (calibrage, succession) = 409. Pool mocké par routeur SQL,
// contexte « entity A », vrai authPlugin.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('./services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  setTokenEpoch: vi.fn().mockResolvedValue(undefined),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('./config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))
vi.mock('./utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
const { loadHabContextMock } = vi.hoisted(() => ({ loadHabContextMock: vi.fn() }))
vi.mock('./services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})

import authPlugin from './plugins/auth.js'
import employeesRoutes from './modules/employees/employees.routes.js'
import contractsRoutes from './modules/contracts/contracts.routes.js'
import absencesRoutes from './modules/absences/absences.routes.js'
import offboardingRoutes from './modules/offboarding/offboarding.routes.js'
import disciplineRoutes from './modules/discipline/discipline.routes.js'
import calibrationRoutes from './modules/calibration/calibration.routes.js'
import successionRoutes from './modules/succession/succession.routes.js'
import { HAB_GRID } from './modules/habilitations/catalog.js'
import type { HabContext } from './services/habilitation.service.js'

const SCHEMA = 'tenant_scope'
const A = 'aaaaaaaa-1111-4222-8333-444444444444'
const OTHER = 'cccccccc-1111-4222-8333-444444444444'
const ID = 'bbbbbbbb-1111-4222-8333-444444444444'
const FRAGMENT = `legal_entity_id = '${A}'`

// État simulé de la base pour le routeur de requêtes.
const db = { employeeInScope: false, foreignRows: false, planVisible: true }

let app: FastifyInstance

function entityCtx(): HabContext {
  const perms = Object.entries(HAB_GRID).flatMap(([fn, actions]) => actions.map((a) => `${fn}:${a}`))
  return {
    userId: 'u-hab', subgroupId: 'sg-1', kind: 'entity', legalEntityId: A,
    permissions: new Set(perms), allEntities: false, sensitive: true,
    manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

function sqls(): string[] {
  return queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
}
// Écritures MÉTIER : la trace d'audit des habilitations (tâche 13) est une
// écriture volontaire sur chaque requête d'un habilité, refus compris — elle
// n'entre pas dans l'invariant « aucune écriture » d'un accès refusé.
const writes = (): string[] => sqls()
  .filter((s) => /^(UPDATE|DELETE|INSERT)/i.test(s.trim()))
  .filter((s) => !/INSERT INTO "[a-z0-9_]+"\.audit_log/i.test(s))

async function call(method: 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  const token = app.jwt.sign({
    sub: 'u-hab', tenantId: 't1', schemaName: SCHEMA, role: 'hr_manager',
    email: 'rh@t.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.register(absencesRoutes, { prefix: '/absences' })
  await app.register(offboardingRoutes, { prefix: '/offboarding' })
  await app.register(disciplineRoutes, { prefix: '/discipline' })
  await app.register(calibrationRoutes, { prefix: '/calibration' })
  await app.register(successionRoutes, { prefix: '/succession' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  db.employeeInScope = false
  db.foreignRows = false
  db.planVisible = true
  loadHabContextMock.mockResolvedValue(entityCtx())
  queryMock.mockReset()
  queryMock.mockImplementation(async (rawSql: string) => {
    const sql = String(rawSql).replace(/\s+/g, ' ')
    // Visibilité d'un plan de succession (contrôlée AVANT le 409 des vivier étrangers)
    if (/FROM "tenant_scope"\.succession_plans WHERE id = \$1 AND /.test(sql) && sql.startsWith('SELECT 1')) {
      return db.planVisible ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    // Conteneurs partagés : y a-t-il des entrées/candidats hors périmètre ?
    if (sql.includes('NOT COALESCE')) return { rows: db.foreignRows ? [{ x: 1 }] : [], rowCount: db.foreignRows ? 1 : 0 }
    // Filiale cible (ligne virtuelle) : toujours hors périmètre dans ces tests
    if (sql.includes('FROM (SELECT $1::uuid')) return { rows: [], rowCount: 0 }
    // Garde d'existence « employé dans mon périmètre »
    if (/^SELECT 1 FROM "tenant_scope"\.employees e WHERE e\.id = \$1/.test(sql)) {
      return db.employeeInScope ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  })
})

describe('dossiers et contrats', () => {
  it('PATCH /employees/:id hors périmètre : 404, aucune écriture', async () => {
    const res = await call('PATCH', `/employees/${ID}`, { jobTitle: 'Comptable' })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })

  it('PATCH /employees/:id : déplacement vers une filiale hors périmètre = 403, aucune écriture', async () => {
    db.employeeInScope = true
    const res = await call('PATCH', `/employees/${ID}`, { legalEntityId: OTHER })
    expect(res.statusCode).toBe(403)
    expect(writes()).toEqual([])
  })

  it('PATCH /contracts/:id hors périmètre : 404, UPDATE borné par le périmètre', async () => {
    const res = await call('PATCH', `/contracts/${ID}`, { job_title: 'X' })
    expect(res.statusCode).toBe(404)
    const upd = writes().filter((s) => s.startsWith('UPDATE'))
    expect(upd.every((s) => s.includes(FRAGMENT))).toBe(true)
  })
})

describe('temps et absences', () => {
  it('PATCH /absences/:id/approve hors périmètre : 404, aucune écriture', async () => {
    const res = await call('PATCH', `/absences/${ID}/approve`)
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })
})

describe('talents', () => {
  it('PATCH /offboarding/:id hors périmètre : 404, aucune écriture', async () => {
    const res = await call('PATCH', `/offboarding/${ID}`, { reason: 'x' })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })

  it('DELETE /discipline/:id hors périmètre : 404, DELETE borné par le périmètre', async () => {
    const res = await call('DELETE', `/discipline/${ID}`)
    expect(res.statusCode).toBe(404)
    const del = writes().filter((s) => s.startsWith('DELETE'))
    expect(del.length).toBe(1)
    expect(del[0]).toContain(FRAGMENT)
  })

  it("DELETE /calibration/sessions/:id avec entrées d'une autre filiale : 409, rien supprimé", async () => {
    db.foreignRows = true
    const res = await call('DELETE', `/calibration/sessions/${ID}`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('Session partagée avec une autre filiale')
    expect(writes()).toEqual([])
  })

  it("PATCH /calibration/sessions/:id (clôture) avec entrées d'une autre filiale : 409", async () => {
    db.foreignRows = true
    const res = await call('PATCH', `/calibration/sessions/${ID}`, { status: 'closed' })
    expect(res.statusCode).toBe(409)
    expect(writes()).toEqual([])
  })

  it('DELETE /calibration/sessions/:id sans entrée étrangère : le DELETE est émis', async () => {
    const res = await call('DELETE', `/calibration/sessions/${ID}`)
    expect(res.statusCode).toBe(404)
    expect(writes().some((s) => s.startsWith('DELETE FROM "tenant_scope".calibration_sessions'))).toBe(true)
  })

  it("DELETE /succession/plans/:id avec successeurs d'une autre filiale : 409, rien supprimé", async () => {
    db.foreignRows = true
    const res = await call('DELETE', `/succession/plans/${ID}`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('Plan partagé avec une autre filiale')
    expect(writes()).toEqual([])
  })

  it('DELETE /succession/plans/:id masqué (hors périmètre) : 404 avant tout contrôle 409, rien supprimé', async () => {
    db.planVisible = false
    db.foreignRows = true
    const res = await call('DELETE', `/succession/plans/${ID}`)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Plan introuvable')
    expect(writes()).toEqual([])
  })
})
