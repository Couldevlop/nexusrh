// Périmètre filiale — signature fermée par défaut et recrutement cloisonné par la
// filiale de l'offre. Pool mocké par routeur SQL, contexte « entity A », vrai authPlugin.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
    connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
    end: vi.fn(),
  })),
}))
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
vi.mock('./db/provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/provisioning.js')>()
  return { ...actual, ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined) }
})
const { loadHabContextMock } = vi.hoisted(() => ({ loadHabContextMock: vi.fn() }))
vi.mock('./services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})

import authPlugin from './plugins/auth.js'
import signatureRoutes from './modules/signature/signature.routes.js'
import recruitmentRoutes from './modules/recruitment/recruitment.routes.js'
import { HAB_GRID } from './modules/habilitations/catalog.js'
import type { HabContext } from './services/habilitation.service.js'

const SCHEMA = 'tenant_scope'
const A = 'aaaaaaaa-1111-4222-8333-444444444444'
const ID = 'bbbbbbbb-1111-4222-8333-444444444444'
const EMP_IN = 'dddddddd-1111-4222-8333-444444444444'
const EMP_OUT = 'eeeeeeee-1111-4222-8333-444444444444'
const U1 = '11111111-1111-4222-8333-444444444444'
const U2 = '22222222-1111-4222-8333-444444444444'

let app: FastifyInstance
const db = { inScopeEmployees: new Set<string>() }

function entityCtx(): HabContext {
  const perms = Object.entries(HAB_GRID).flatMap(([fn, actions]) => actions.map((a) => `${fn}:${a}`))
  return {
    userId: U1, subgroupId: 'sg-1', kind: 'entity', legalEntityId: A,
    permissions: new Set(perms), allEntities: false, sensitive: true,
    manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

const sqls = (): string[] => queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
const writes = (): string[] => sqls().filter((s) => /^(UPDATE|DELETE|INSERT)/i.test(s.trim()))

async function call(
  method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, sub = U1,
) {
  const token = app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role: 'hr_manager',
    email: 'rh@t.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(signatureRoutes, { prefix: '/signature' })
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  db.inScopeEmployees = new Set([EMP_IN])
  loadHabContextMock.mockResolvedValue(entityCtx())
  queryMock.mockReset()
  queryMock.mockImplementation(async (rawSql: string, params: unknown[] = []) => {
    const sql = String(rawSql).replace(/\s+/g, ' ')
    // Garde employé : e.id = $1 AND <scope>
    if (/^SELECT 1 FROM "tenant_scope"\.employees e WHERE e\.id = \$1/.test(sql)) {
      return db.inScopeEmployees.has(String(params[0])) ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    // Garde candidature : offre hors périmètre
    if (sql.includes('LEFT JOIN LATERAL') && sql.includes('jsc')) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  })
})

describe('signature fermée par défaut', () => {
  it('création avec un signataire dans le périmètre et un hors périmètre : 404, aucune écriture', async () => {
    const res = await call('POST', '/signature/requests', {
      title: 'Avenant',
      signatories: [
        { name: 'Dans', employeeId: EMP_IN },
        { name: 'Hors', employeeId: EMP_OUT },
      ],
    })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })

  it('liste : masque une demande dont un signataire salarié est hors périmètre (NOT EXISTS ... NOT COALESCE)', async () => {
    await call('GET', '/signature/requests')
    const sql = sqls().find((s) => s.includes('signature_requests r')) ?? ''
    expect(sql).toContain('NOT EXISTS')
    expect(sql).toContain('hss.employee_id IS NOT NULL')
    expect(sql).toContain('NOT COALESCE')
    expect(sql).toContain(`legal_entity_id = '${A}'`)
  })

  it("demande à signataires externes seuls : réservée à son créateur (created_by = utilisateur courant)", async () => {
    await call('GET', '/signature/requests', undefined, U1)
    const sql1 = sqls().find((s) => s.includes('signature_requests r')) ?? ''
    expect(sql1).toContain(`r.created_by::text = '${U1}'`)
    queryMock.mockClear()
    await call('GET', '/signature/requests', undefined, U2)
    const sql2 = sqls().find((s) => s.includes('signature_requests r')) ?? ''
    expect(sql2).toContain(`r.created_by::text = '${U2}'`)
    expect(sql2).not.toContain(U1)
  })
})

describe('recrutement : routes candidature cloisonnées par la filiale de l\'offre', () => {
  const routes: Array<['GET' | 'POST', string]> = [
    ['GET', `/recruitment/applications/${ID}/cv-file`],
    ['POST', `/recruitment/applications/${ID}/upload-cv`],
    ['POST', `/recruitment/applications/${ID}/analyze-cv`],
    ['POST', `/recruitment/applications/${ID}/contract`],
  ]
  for (const [method, url] of routes) {
    it(`${method} ${url.replace(ID, ':id')} hors périmètre : 404 'Candidature introuvable', rien lu ni écrit`, async () => {
      const res = await call(method, url, method === 'POST' ? { type: 'cdi_ci' } : undefined)
      expect(res.statusCode).toBe(404)
      expect(res.json().error).toBe('Candidature introuvable')
      expect(writes()).toEqual([])
      expect(sqls().some((s) => s.includes('cv_blob') || s.includes('cv_text'))).toBe(false)
    })
  }
})
