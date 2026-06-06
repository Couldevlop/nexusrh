import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks d'infrastructure ──────────────────────────────────────────────────
// Pool pg : mock séquentiel partagé (queryMock). Le défaut après les *Once()
// renvoie { rows: [] } pour absorber les requêtes best-effort (audit_log…).
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

// PIÈGE PROJET : toujours mocker schema-migrations / provisioning, sinon ~200
// requêtes DDL de provisionTenantSchema consomment les mocks pg séquentiels.
vi.mock('../../db/provisioning.js', () => ({
  provisionTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

const { sendEmployeeWelcomeEmailMock } = vi.hoisted(() => ({
  sendEmployeeWelcomeEmailMock: vi.fn().mockResolvedValue({ sent: true }),
}))
vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: sendEmployeeWelcomeEmailMock,
}))

// crypto : on contrôle encrypt/encryptIfPresent pour rester déterministe et
// éviter la dépendance à ENCRYPTION_KEY.
vi.mock('../../utils/crypto.js', () => ({
  encrypt:          (v: string) => `enc(${v})`,
  encryptIfPresent: (v: string | null | undefined) => (v ? `enc(${v})` : null),
  decryptIfPresent: (v: string | null | undefined) => (v ? `dec(${v})` : null),
}))

// ai-credentials : maskKey / isEncryptionAvailable pilotables par test.
const { isEncryptionAvailableMock } = vi.hoisted(() => ({
  isEncryptionAvailableMock: vi.fn(() => true),
}))
vi.mock('../../services/ai-credentials.service.js', () => ({
  maskKey: (k: string | null | undefined) => (k ? `••••${k.slice(-4)}` : null),
  isEncryptionAvailable: isEncryptionAvailableMock,
}))

// sourcing-config : loadAiModels pilotable (catalogue de modèles IA).
const { loadAiModelsMock } = vi.hoisted(() => ({
  loadAiModelsMock: vi.fn().mockResolvedValue([
    { provider: 'claude',  model_id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
    { provider: 'mistral', model_id: 'mistral-large-latest',     display_name: 'Mistral Large' },
  ]),
}))
vi.mock('../../services/sourcing-config.service.js', () => ({
  loadAiModels: loadAiModelsMock,
}))

// config : doit exposer ai/mistral/appUrl utilisés par settings.routes.ts.
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    appUrl: 'http://localhost:3001',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-platform-claude', model: 'claude-sonnet-4-20250514' },
    mistral: { apiKey: 'sk-platform-mistral', model: 'mistral-large-latest' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import settingsRoutes from './settings.routes.js'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

function tokenFor(app: FastifyInstance, role: string, tenantId: string | null = 't1') {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId, schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  // Défaut absorbant pour les requêtes best-effort non explicitement mockées.
  queryMock.mockResolvedValue({ rows: [] })
  sendEmployeeWelcomeEmailMock.mockReset().mockResolvedValue({ sent: true })
  isEncryptionAvailableMock.mockReturnValue(true)
  loadAiModelsMock.mockReset().mockResolvedValue([
    { provider: 'claude',  model_id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
    { provider: 'mistral', model_id: 'mistral-large-latest',     display_name: 'Mistral Large' },
  ])
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/tenant
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/tenant', () => {
  it('renvoie le tenant (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 't1', name: 'SOTRA', mfa_required: false }] })
    const res = await app.inject({ method: 'GET', url: '/settings/tenant', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.id).toBe('t1')
  })

  it('403 si pas de tenantId dans le token', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/tenant', headers: auth(tokenFor(app, 'admin', null)) })
    expect(res.statusCode).toBe(403)
  })

  it('404 si tenant introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/settings/tenant', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(404)
  })

  it('500 si la DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({ method: 'GET', url: '/settings/tenant', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })

  it('403 si rôle hr_officer (RBAC admin requis)', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/tenant', headers: auth(tokenFor(app, 'hr_officer')) })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PATCH /settings/tenant — branches restantes
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /settings/tenant — branches complémentaires', () => {
  it('403 si pas de tenantId', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant', headers: auth(tokenFor(app, 'admin', null)),
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('400 si aucun champ modifiable fourni', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant', headers: auth(tokenFor(app, 'admin')),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('Aucun champ modifiable')
  })

  it('500 si UPDATE échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant', headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/ai
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/ai', () => {
  it('renvoie la config IA masquée (200)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ claude_api_key_enc: 'abc', claude_model: 'claude-sonnet-4-20250514',
               mistral_api_key_enc: null, mistral_model: null, preferred_provider: 'mistral' }],
    })
    const res = await app.inject({ method: 'GET', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.claude.hasKey).toBe(true)
    expect(data.mistral.hasKey).toBe(false)
    expect(data.preferredProvider).toBe('mistral')
    expect(data.models.length).toBe(2)
  })

  it('valeurs par défaut quand aucune ligne ai_settings', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.claude.hasKey).toBe(false)
    expect(data.preferredProvider).toBe('claude')
  })

  it('loadAiModels qui échoue → models = [] (catch interne)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ claude_api_key_enc: null, claude_model: null,
      mistral_api_key_enc: null, mistral_model: null, preferred_provider: 'claude' }] })
    loadAiModelsMock.mockRejectedValueOnce(new Error('catalogue down'))
    const res = await app.inject({ method: 'GET', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.models).toEqual([])
  })

  it('500 si la requête ai_settings échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({ method: 'GET', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })

  it('403 si rôle non admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/ai', headers: auth(tokenFor(app, 'hr_manager')) })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PUT /settings/ai
// ════════════════════════════════════════════════════════════════════════════
describe('PUT /settings/ai', () => {
  it('400 si validation Zod échoue (champ inconnu)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')),
      payload: { unknownField: 'x' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 si clé fournie mais chiffrement indisponible', async () => {
    isEncryptionAvailableMock.mockReturnValue(false)
    const res = await app.inject({
      method: 'PUT', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')),
      payload: { claudeApiKey: 'sk-test' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Chiffrement')
  })

  it('400 si modèle hors catalogue', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')),
      payload: { claudeModel: 'modele-inexistant' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Modèle inconnu')
  })

  it('INSERT quand aucune ligne existante (clé + modèle) → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })   // SELECT id ai_settings (vide)
      .mockResolvedValueOnce({ rows: [] })   // INSERT
      .mockResolvedValueOnce({ rows: [] })   // audit_log
    const res = await app.inject({
      method: 'PUT', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')),
      payload: { claudeApiKey: 'sk-claude', claudeModel: 'claude-sonnet-4-20250514', preferredProvider: 'claude' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).success).toBe(true)
    const insertCall = queryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('ai_settings'))
    expect(insertCall?.[1]?.[0]).toBe('enc(sk-claude)')
  })

  it('UPDATE quand ligne existante avec champs modifiés → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'ai-1' }] }) // SELECT id
      .mockResolvedValueOnce({ rows: [] })               // UPDATE
      .mockResolvedValueOnce({ rows: [] })               // audit_log
    const res = await app.inject({
      method: 'PUT', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')),
      payload: { mistralApiKey: '', claudeModel: '', preferredProvider: 'mistral' },
    })
    expect(res.statusCode).toBe(200)
    const updateCall = queryMock.mock.calls.find(c => String(c[0]).includes('UPDATE') && String(c[0]).includes('ai_settings'))
    expect(updateCall).toBeTruthy()
  })

  it('UPDATE no-op quand corps vide (aucun champ → pas de SET) → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'ai-1' }] }) // SELECT id
      .mockResolvedValueOnce({ rows: [] })               // audit_log
    const res = await app.inject({
      method: 'PUT', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')),
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    // aucun UPDATE ne doit avoir été émis
    const updateCall = queryMock.mock.calls.find(c => String(c[0]).includes('UPDATE') && String(c[0]).includes('ai_settings'))
    expect(updateCall).toBeFalsy()
  })

  it('500 si la requête échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const res = await app.inject({
      method: 'PUT', url: '/settings/ai', headers: auth(tokenFor(app, 'admin')),
      payload: { preferredProvider: 'claude' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/users
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/users', () => {
  it('liste les utilisateurs (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'a@b.ci' }] })
    const res = await app.inject({ method: 'GET', url: '/settings/users', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.length).toBe(1)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({ method: 'GET', url: '/settings/users', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/users
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/users', () => {
  it('crée un utilisateur simple sans département (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'a@b.ci', role: 'employee' }] }) // INSERT users
    const res = await app.inject({
      method: 'POST', url: '/settings/users', headers: auth(tokenFor(app, 'admin')),
      payload: { email: 'a@b.ci', first_name: 'A', last_name: 'B' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).tempPassword).toBeTruthy()
  })

  it('crée + lie un employé existant si department_id fourni (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee existant
      .mockResolvedValueOnce({ rows: [] })                 // UPDATE employee department
      .mockResolvedValueOnce({ rows: [{ id: 'u2' }] })     // INSERT users
      .mockResolvedValueOnce({ rows: [] })                 // UPDATE users employee_id
    const res = await app.inject({
      method: 'POST', url: '/settings/users', headers: auth(tokenFor(app, 'admin')),
      payload: { email: 'a@b.ci', first_name: 'A', last_name: 'B', department_id: 'd1', role: 'manager', is_active: false },
    })
    expect(res.statusCode).toBe(201)
  })

  it('crée un nouvel employé squelette si department_id et pas d\'employé existant (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                  // SELECT employee (aucun)
      .mockResolvedValueOnce({ rows: [{ id: 'emp-new' }] }) // INSERT employee
      .mockResolvedValueOnce({ rows: [{ id: 'u3' }] })      // INSERT users
      .mockResolvedValueOnce({ rows: [] })                  // UPDATE users employee_id
    const res = await app.inject({
      method: 'POST', url: '/settings/users', headers: auth(tokenFor(app, 'admin')),
      payload: { email: 'c@d.ci', first_name: 'C', last_name: 'D', department_id: 'd1' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('500 si l\'insertion échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('dup'))
    const res = await app.inject({
      method: 'POST', url: '/settings/users', headers: auth(tokenFor(app, 'admin')),
      payload: { email: 'a@b.ci', first_name: 'A', last_name: 'B' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PATCH /settings/users/:id
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /settings/users/:id', () => {
  it('400 si rôle non tenant (anti escalade super_admin)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { role: 'super_admin' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Rôle invalide')
  })

  it('400 si aucun champ', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si utilisateur introuvable (snapshot avant absent)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT before (vide)
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { is_active: false },
    })
    expect(res.statusCode).toBe(404)
  })

  it('change le rôle → audit user.role_changed (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'employee', is_active: true }] })       // before
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, email: 'x@y.ci', role: 'manager', is_active: true }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] })                                            // audit_log
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { role: 'manager' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('user.role_changed')
  })

  it('change is_active seul (même rôle) → audit user.updated (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'employee', is_active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, role: 'employee', is_active: false }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { is_active: false },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('user.updated')
  })

  it('404 si UPDATE ne renvoie aucune ligne', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'employee', is_active: true }] }) // before
      .mockResolvedValueOnce({ rows: [] })                                       // UPDATE vide
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { is_active: false },
    })
    expect(res.statusCode).toBe(404)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { is_active: true },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/absence-types
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/absence-types', () => {
  it('liste (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'at1', code: 'CP' }] })
    const res = await app.inject({ method: 'GET', url: '/settings/absence-types', headers: auth(tokenFor(app, 'hr_manager')) })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({ method: 'GET', url: '/settings/absence-types', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })

  it('403 si rôle hr_officer', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/absence-types', headers: auth(tokenFor(app, 'hr_officer')) })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/departments
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/departments', () => {
  it('liste avec compteur (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'd1', name: 'RH', employees_count: 3 }] })
    const res = await app.inject({ method: 'GET', url: '/settings/departments', headers: auth(tokenFor(app, 'hr_officer')) })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({ method: 'GET', url: '/settings/departments', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/departments
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/departments', () => {
  it('crée (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'd1', name: 'RH' }] })
    const res = await app.inject({
      method: 'POST', url: '/settings/departments', headers: auth(tokenFor(app, 'hr_manager')),
      payload: { name: 'RH' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('crée avec code et manager_id (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'd1', name: 'RH', code: 'RH', manager_id: 'm1' }] })
    const res = await app.inject({
      method: 'POST', url: '/settings/departments', headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'RH', code: 'RH', manager_id: 'm1' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'POST', url: '/settings/departments', headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'RH' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PATCH /settings/departments/:id
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /settings/departments/:id', () => {
  it('400 si aucun champ', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/departments/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('update tous les champs (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A, name: 'RH2' }] })
    const res = await app.inject({
      method: 'PATCH', url: `/settings/departments/${UUID_A}`, headers: auth(tokenFor(app, 'hr_manager')),
      payload: { name: 'RH2', code: 'RH2', manager_id: 'm9' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'PATCH', url: `/settings/departments/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'RH2' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DELETE /settings/departments/:id
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /settings/departments/:id', () => {
  it('409 si employés actifs', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ cnt: 2 }] })
    const res = await app.inject({
      method: 'DELETE', url: `/settings/departments/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(409)
  })

  it('supprime si vide (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] }) // count
      .mockResolvedValueOnce({ rows: [] })            // DELETE
    const res = await app.inject({
      method: 'DELETE', url: `/settings/departments/${UUID_A}`, headers: auth(tokenFor(app, 'hr_manager')),
    })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'DELETE', url: `/settings/departments/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/absence-types
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/absence-types', () => {
  it('crée avec valeurs par défaut (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'at1', code: 'CP' }] })
    const res = await app.inject({
      method: 'POST', url: '/settings/absence-types', headers: auth(tokenFor(app, 'hr_manager')),
      payload: { code: 'CP', label: 'Congés payés' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('crée avec tous les champs (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'at2', code: 'MAL' }] })
    const res = await app.inject({
      method: 'POST', url: '/settings/absence-types', headers: auth(tokenFor(app, 'admin')),
      payload: { code: 'MAL', label: 'Maladie', color: '#FF0000', requires_approval: false,
        max_days_per_year: 30, is_paid: false, calculation_mode: 'calendar_days' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'POST', url: '/settings/absence-types', headers: auth(tokenFor(app, 'admin')),
      payload: { code: 'CP', label: 'CP' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PATCH /settings/absence-types/:id
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /settings/absence-types/:id', () => {
  it('400 si aucun champ autorisé', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/absence-types/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { code: 'NOPE' }, // 'code' n'est pas dans la liste allowed
    })
    expect(res.statusCode).toBe(400)
  })

  it('update (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A, label: 'Maj' }] })
    const res = await app.inject({
      method: 'PATCH', url: `/settings/absence-types/${UUID_A}`, headers: auth(tokenFor(app, 'hr_manager')),
      payload: { label: 'Maj', color: '#00FF00', is_active: false },
    })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'PATCH', url: `/settings/absence-types/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { label: 'X' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DELETE /settings/absence-types/:id
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /settings/absence-types/:id', () => {
  it('409 si type utilisé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ cnt: 5 }] })
    const res = await app.inject({
      method: 'DELETE', url: `/settings/absence-types/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(409)
  })

  it('supprime si inutilisé (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'DELETE', url: `/settings/absence-types/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
  })

  it('403 si rôle hr_manager (admin requis)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/settings/absence-types/${UUID_A}`, headers: auth(tokenFor(app, 'hr_manager')),
    })
    expect(res.statusCode).toBe(403)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'DELETE', url: `/settings/absence-types/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/payroll-rules
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/payroll-rules', () => {
  it('liste (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1', code: '1000' }] })
    const res = await app.inject({ method: 'GET', url: '/settings/payroll-rules', headers: auth(tokenFor(app, 'hr_manager')) })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({ method: 'GET', url: '/settings/payroll-rules', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/payroll-rules — branches restantes
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/payroll-rules — branches complémentaires', () => {
  it('500 si INSERT échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'POST', url: '/settings/payroll-rules', headers: auth(tokenFor(app, 'admin')),
      payload: { code: '1000', name: 'Base', type: 'earning' },
    })
    expect(res.statusCode).toBe(500)
  })

  it('403 si rôle hr_manager', async () => {
    const res = await app.inject({
      method: 'POST', url: '/settings/payroll-rules', headers: auth(tokenFor(app, 'hr_manager')),
      payload: { code: '1000', name: 'Base', type: 'earning' },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PATCH /settings/payroll-rules/:id
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /settings/payroll-rules/:id', () => {
  it('400 si id non-UUID', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/settings/payroll-rules/not-uuid', headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('UUID')
  })

  it('400 si validation Zod échoue (rate hors borne)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/payroll-rules/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { rate: 99 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 si aucun champ autorisé', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/payroll-rules/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('update + audit (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, name: 'Maj' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] })                            // audit_log
    const res = await app.inject({
      method: 'PATCH', url: `/settings/payroll-rules/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'Maj', rate: 0.05, order: 10 },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.payroll_rule_updated')
  })

  it('500 si UPDATE échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'PATCH', url: `/settings/payroll-rules/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DELETE /settings/payroll-rules/:id
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /settings/payroll-rules/:id', () => {
  it('supprime (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'DELETE', url: `/settings/payroll-rules/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'DELETE', url: `/settings/payroll-rules/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/legal-entities
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/legal-entities', () => {
  it('liste (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'le1', name: 'Filiale' }] })
    const res = await app.inject({ method: 'GET', url: '/settings/legal-entities', headers: auth(tokenFor(app, 'hr_officer')) })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({ method: 'GET', url: '/settings/legal-entities', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/legal-entities — branches restantes
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/legal-entities — branches complémentaires', () => {
  it('500 si INSERT échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities', headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'Filiale' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PATCH /settings/legal-entities/:id — branches restantes
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /settings/legal-entities/:id — branches complémentaires', () => {
  it('400 si validation Zod échoue', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/legal-entities/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { at_rate: 0.99 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 si aucun champ', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/legal-entities/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('500 si UPDATE échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'PATCH', url: `/settings/legal-entities/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DELETE /settings/legal-entities/:id
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /settings/legal-entities/:id', () => {
  it('409 si employés actifs', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ cnt: 1 }] })
    const res = await app.inject({
      method: 'DELETE', url: `/settings/legal-entities/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(409)
  })

  it('supprime si vide (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'DELETE', url: `/settings/legal-entities/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'DELETE', url: `/settings/legal-entities/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/workflow
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/workflow', () => {
  it('liste (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ module: 'absences', levels_count: 2 }] })
    const res = await app.inject({ method: 'GET', url: '/settings/workflow', headers: auth(tokenFor(app, 'hr_manager')) })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({ method: 'GET', url: '/settings/workflow', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PATCH /settings/workflow
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /settings/workflow', () => {
  it('400 si corps non-tableau (OWASP A03)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/settings/workflow', headers: auth(tokenFor(app, 'admin')),
      payload: { module: 'absences', levels_count: 2 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 si levels_count hors borne', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/settings/workflow', headers: auth(tokenFor(app, 'admin')),
      payload: [{ module: 'absences', levels_count: 99 }],
    })
    expect(res.statusCode).toBe(400)
  })

  it('upsert configs (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                                       // INSERT/UPSERT cfg1
      .mockResolvedValueOnce({ rows: [{ module: 'absences', levels_count: 2 }] }) // SELECT final
    const res = await app.inject({
      method: 'PATCH', url: '/settings/workflow', headers: auth(tokenFor(app, 'admin')),
      payload: [{ module: 'absences', levels_count: 2 }],
    })
    expect(res.statusCode).toBe(200)
  })

  it('500 si la requête échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'PATCH', url: '/settings/workflow', headers: auth(tokenFor(app, 'admin')),
      payload: [{ module: 'absences', levels_count: 2 }],
    })
    expect(res.statusCode).toBe(500)
  })

  it('403 si rôle hr_manager', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/settings/workflow', headers: auth(tokenFor(app, 'hr_manager')),
      payload: [{ module: 'absences', levels_count: 2 }],
    })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/variable-elements
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/variable-elements', () => {
  it('liste sans filtre mois (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 've1' }] })
    const res = await app.inject({ method: 'GET', url: '/settings/variable-elements', headers: auth(tokenFor(app, 'hr_officer')) })
    expect(res.statusCode).toBe(200)
  })

  it('liste avec filtre mois (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 've1' }] })
    const res = await app.inject({ method: 'GET', url: '/settings/variable-elements?month=2024-06', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({ method: 'GET', url: '/settings/variable-elements', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/variable-elements
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/variable-elements', () => {
  it('400 si aucune période pour le mois', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT pay_periods vide
    const res = await app.inject({
      method: 'POST', url: '/settings/variable-elements', headers: auth(tokenFor(app, 'hr_officer')),
      payload: { employee_id: 'e1', rule_code: 'PRIME', amount: 10000, month: '2024-06' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Aucune période')
  })

  it('upsert (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'per-1' }] }) // SELECT pay_periods
      .mockResolvedValueOnce({ rows: [{ id: 've-1' }] })  // INSERT/UPSERT
    const res = await app.inject({
      method: 'POST', url: '/settings/variable-elements', headers: auth(tokenFor(app, 'admin')),
      payload: { employee_id: 'e1', rule_code: 'PRIME', amount: 10000, month: '2024-06', description: 'Prime' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'POST', url: '/settings/variable-elements', headers: auth(tokenFor(app, 'admin')),
      payload: { employee_id: 'e1', rule_code: 'PRIME', amount: 10000, month: '2024-06' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DELETE /settings/variable-elements/:id
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /settings/variable-elements/:id', () => {
  it('supprime (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'DELETE', url: `/settings/variable-elements/${UUID_A}`, headers: auth(tokenFor(app, 'hr_manager')),
    })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'DELETE', url: `/settings/variable-elements/${UUID_A}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DELETE /settings/users/:id
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /settings/users/:id', () => {
  it('400 si suppression de son propre compte', async () => {
    const token = tokenFor(app, 'admin')
    // le sub du token = 'u-admin'
    const res = await app.inject({
      method: 'DELETE', url: '/settings/users/u-admin', headers: auth(token),
    })
    expect(res.statusCode).toBe(400)
  })

  it('supprime un autre compte (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'DELETE', url: `/settings/users/${UUID_B}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'DELETE', url: `/settings/users/${UUID_B}`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/users/:id/reset-password
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/users/:id/reset-password', () => {
  it('404 si utilisateur introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT user vide
    const res = await app.inject({
      method: 'POST', url: `/settings/users/${UUID_A}/reset-password`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(404)
  })

  it('reset + email envoyé (200, emailSent=true)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'x@y.ci', first_name: 'X', last_name: 'Y' }] }) // SELECT user
      .mockResolvedValueOnce({ rows: [] })                                                      // UPDATE password
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: '#E85D04' }] })          // SELECT tenant
    sendEmployeeWelcomeEmailMock.mockResolvedValueOnce({ sent: true })
    const res = await app.inject({
      method: 'POST', url: `/settings/users/${UUID_A}/reset-password`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.emailSent).toBe(true)
    expect(body.tempPassword).toBeTruthy()
  })

  it('reset mais email en échec (200, emailSent=false)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'x@y.ci', first_name: 'X', last_name: 'Y' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: '#E85D04' }] })
    sendEmployeeWelcomeEmailMock.mockRejectedValueOnce(new Error('smtp down'))
    const res = await app.inject({
      method: 'POST', url: `/settings/users/${UUID_A}/reset-password`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).emailSent).toBe(false)
  })

  it('reset sans tenantId → pas d\'email (200, emailSent=false)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'x@y.ci', first_name: 'X', last_name: 'Y' }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/settings/users/${UUID_A}/reset-password`, headers: auth(tokenFor(app, 'admin', null)),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).emailSent).toBe(false)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'POST', url: `/settings/users/${UUID_A}/reset-password`, headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /settings/import/users-status
// ════════════════════════════════════════════════════════════════════════════
describe('GET /settings/import/users-status', () => {
  it('renvoie les compteurs (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total_employees: '10', total_users: '4' }] })
    const res = await app.inject({ method: 'GET', url: '/settings/import/users-status', headers: auth(tokenFor(app, 'hr_manager')) })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.totalEmployees).toBe(10)
    expect(data.withoutAccount).toBe(6)
  })

  it('500 si DB échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({ method: 'GET', url: '/settings/import/users-status', headers: auth(tokenFor(app, 'admin')) })
    expect(res.statusCode).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/import/generate-users
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/import/generate-users', () => {
  it('403 si pas de tenantId', async () => {
    const res = await app.inject({
      method: 'POST', url: '/settings/import/generate-users', headers: auth(tokenFor(app, 'admin', null)),
    })
    expect(res.statusCode).toBe(403)
  })

  it('aucun employé sans compte → message (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: '#E85D04' }] }) // tenant
      .mockResolvedValueOnce({ rows: [] })                                            // employés (aucun)
    const res = await app.inject({
      method: 'POST', url: '/settings/import/generate-users', headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).created).toBe(0)
    expect(JSON.parse(res.body).message).toContain('déjà un compte')
  })

  it('génère des comptes + emails (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: '#E85D04' }] }) // tenant
      .mockResolvedValueOnce({ rows: [
        { id: 'e1', first_name: 'A', last_name: 'B', email: 'a@b.ci' },
        { id: 'e2', first_name: 'C', last_name: 'D', email: 'c@d.ci' },
      ] }) // employés
      .mockResolvedValueOnce({ rows: [] }) // INSERT user e1
      .mockResolvedValueOnce({ rows: [] }) // INSERT user e2
    sendEmployeeWelcomeEmailMock
      .mockResolvedValueOnce({ sent: true })
      .mockRejectedValueOnce(new Error('smtp fail e2'))
    const res = await app.inject({
      method: 'POST', url: '/settings/import/generate-users', headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.created).toBe(2)
    expect(body.emailSent).toBe(1)
    expect(body.emailFailed).toBe(1)
    expect(body.emailError).toContain('smtp fail e2')
  })

  it('compte un échec d\'INSERT comme skip (created < total)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: '#E85D04' }] }) // tenant
      .mockResolvedValueOnce({ rows: [
        { id: 'e1', first_name: 'A', last_name: 'B', email: 'a@b.ci' },
      ] }) // employés
      .mockRejectedValueOnce(new Error('dup')) // INSERT user échoue
    const res = await app.inject({
      method: 'POST', url: '/settings/import/generate-users', headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.created).toBe(0)
    expect(body.skipped).toBe(1)
  })

  it('génère sur plusieurs batches (>20 employés → pause inter-batch)', async () => {
    const employees = Array.from({ length: 21 }, (_, i) => ({
      id: `e${i}`, first_name: `F${i}`, last_name: `L${i}`, email: `e${i}@sotra.ci`,
    }))
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: '#E85D04' }] }) // tenant
      .mockResolvedValueOnce({ rows: employees })                                      // employés
    // les 21 INSERT users + l'audit_log final retombent sur le défaut { rows: [] }
    const res = await app.inject({
      method: 'POST', url: '/settings/import/generate-users', headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).created).toBe(21)
  }, 120_000)  // 21 hashes bcrypt 12 rounds — très lent sous instrumentation coverage

  it('500 si requête tenant échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('x'))
    const res = await app.inject({
      method: 'POST', url: '/settings/import/generate-users', headers: auth(tokenFor(app, 'admin')),
    })
    expect(res.statusCode).toBe(500)
  })

  it('403 si rôle hr_manager (admin requis)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/settings/import/generate-users', headers: auth(tokenFor(app, 'hr_manager')),
    })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /settings/import/:type — branches non couvertes par le test existant
// ════════════════════════════════════════════════════════════════════════════
describe('POST /settings/import/:type — branches complémentaires', () => {
  it('employees : insère une ligne complète avec lookup département (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'dept-1' }] }) // SELECT department par nom
      .mockResolvedValueOnce({ rows: [] })                  // INSERT/UPSERT employee
      .mockResolvedValueOnce({ rows: [] })                  // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email', 'prenom', 'nom', 'departement', 'date_naissance', 'telephone',
          'poste', 'date_embauche', 'salaire_brut', 'type_contrat', 'statut', 'sexe',
          'numero_cnps', 'ville', 'heures_hebdo', 'categorie', 'iban', 'banque'],
        rows: [['a@b.ci', 'Alice', 'Martin', 'RH', '15/05/1990', '+22507000000',
          'Dev', '01/01/2024', '350000', 'CDI', 'active', 'F',
          'CNPS-1', 'Abidjan', '40', 'Cadre', 'CI001', 'SGBCI']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).inserted).toBe(1)
  })

  it('employees : email manquant → erreur ligne (skip)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email', 'prenom'], rows: [['', 'Alice']] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.inserted).toBe(0)
    expect(body.errors[0]).toContain('email manquant')
  })

  it('employees : INSERT échoue → erreur ligne capturée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })            // SELECT department (vide, deptName fourni)
      .mockRejectedValueOnce(new Error('constraint')) // INSERT employee échoue
      .mockResolvedValueOnce({ rows: [] })            // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email', 'prenom', 'departement'], rows: [['a@b.ci', 'Alice', 'RH']] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.skipped).toBe(1)
    expect(body.errors[0]).toContain('a@b.ci')
  })

  it('departments : nom manquant → skip', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/departments', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['nom'], rows: [['']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('departments : déjà existant → skip', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'd-exist' }] }) // SELECT existant
      .mockResolvedValueOnce({ rows: [] })                   // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/departments', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['nom'], rows: [['RH']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('departments : responsable_email introuvable → erreur mais création', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT existant (aucun)
      .mockResolvedValueOnce({ rows: [] }) // SELECT users by email (aucun → managerId null)
      .mockResolvedValueOnce({ rows: [] }) // INSERT department
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/departments', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['nom', 'responsable_email'], rows: [['Log', 'ghost@x.ci']] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.inserted).toBe(1)
    expect(body.errors[0]).toContain('introuvable')
  })

  it('departments : INSERT échoue → erreur capturée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })            // SELECT existant
      .mockRejectedValueOnce(new Error('constraint')) // INSERT échoue
      .mockResolvedValueOnce({ rows: [] })            // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/departments', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['nom'], rows: [['Log']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('absences : OK (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [{ id: 'at-1' }] })  // SELECT absence_type
      .mockResolvedValueOnce({ rows: [] })                 // INSERT absence
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/absences', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email_employe', 'type_absence', 'date_debut', 'date_fin', 'statut', 'motif'],
        rows: [['a@b.ci', 'Congés payés', '01/06/2024', '05/06/2024', 'approved', 'Vacances']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).inserted).toBe(1)
  })

  it('absences : email manquant → skip', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/absences', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'type_absence'], rows: [['', 'CP']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('absences : employé introuvable → erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT employee (aucun)
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/absences', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'type_absence'], rows: [['ghost@x.ci', 'CP']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('introuvable')
  })

  it('absences : type inconnu → erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [] })                 // SELECT absence_type (aucun)
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/absences', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email_employe', 'type_absence', 'date_debut', 'date_fin'],
        rows: [['a@b.ci', 'Inconnu', '01/06/2024', '02/06/2024']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('inconnu')
  })

  it('absences : INSERT échoue → erreur capturée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [{ id: 'at-1' }] })  // SELECT absence_type
      .mockRejectedValueOnce(new Error('boom'))            // INSERT échoue
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/absences', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email_employe', 'type_absence', 'date_debut', 'date_fin'],
        rows: [['a@b.ci', 'CP', '01/06/2024', '02/06/2024']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('pay-slips : crée la période si absente (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [] })                 // SELECT existing pay_slip
      .mockResolvedValueOnce({ rows: [] })                 // SELECT pay_periods (aucune)
      .mockResolvedValueOnce({ rows: [{ id: 'per-new' }] }) // INSERT pay_periods
      .mockResolvedValueOnce({ rows: [] })                 // INSERT pay_slip
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/pay-slips', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email_employe', 'periode', 'salaire_brut', 'cotis_cnps_sal', 'its', 'net_paye', 'cout_employeur'],
        rows: [['a@b.ci', '2024-07', '300000', '18900', '500', '280600', '342000']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).inserted).toBe(1)
  })

  it('pay-slips : email ou periode manquant → skip', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/pay-slips', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'periode'], rows: [['', '']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('pay-slips : employé introuvable → erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT employee (aucun)
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/pay-slips', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'periode'], rows: [['ghost@x.ci', '2024-07']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('introuvable')
  })

  it('pay-slips : bulletin déjà existant → skip', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })   // SELECT employee
      .mockResolvedValueOnce({ rows: [{ id: 'ps-exist' }] }) // SELECT existing pay_slip
      .mockResolvedValueOnce({ rows: [] })                   // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/pay-slips', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'periode'], rows: [['a@b.ci', '2024-07']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('pay-slips : INSERT échoue → erreur capturée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [] })                 // SELECT existing pay_slip
      .mockResolvedValueOnce({ rows: [{ id: 'per-1' }] }) // SELECT pay_periods
      .mockRejectedValueOnce(new Error('boom'))            // INSERT pay_slip échoue
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/pay-slips', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email_employe', 'periode', 'salaire_brut'],
        rows: [['a@b.ci', '2024-07', '300000']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('mobile-money : email manquant → skip', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/mobile-money', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'operateur'], rows: [['', 'wave']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('mobile-money : employé introuvable → erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/mobile-money', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'operateur', 'numero_telephone'], rows: [['ghost@x.ci', 'wave', '+225']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('introuvable')
  })

  it('mobile-money : UPDATE échoue → erreur capturée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockRejectedValueOnce(new Error('boom'))            // UPDATE échoue
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/mobile-money', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'operateur', 'numero_telephone'], rows: [['a@b.ci', 'wave', '+225']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('contracts : email manquant → skip', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/contracts', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'type_contrat'], rows: [['', 'cdi']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('contracts : employé introuvable → erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/contracts', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'type_contrat', 'salaire_base'], rows: [['ghost@x.ci', 'cdi', '450000']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('introuvable')
  })

  it('contracts : INSERT échoue → erreur capturée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockRejectedValueOnce(new Error('boom'))            // INSERT échoue
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/contracts', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email_employe', 'type_contrat', 'date_debut', 'salaire_base', 'periode_essai_jours'],
        rows: [['a@b.ci', 'cdi', '2024-01-15', '450000', '60']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('expenses : email manquant → skip', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/expenses', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'titre'], rows: [['', 'Mission']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('expenses : employé introuvable → erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/expenses', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'titre'], rows: [['ghost@x.ci', 'Mission']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('introuvable')
  })

  it('expenses : titre manquant → erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/expenses', headers: auth(tokenFor(app, 'admin')),
      payload: { headers: ['email_employe', 'titre', 'mois', 'montant_total'], rows: [['a@b.ci', '', '2024-06', '25000']] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('titre')
  })

  it('expenses : montant hors borne → erreur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/expenses', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email_employe', 'titre', 'mois', 'montant_total', 'statut'],
        rows: [['a@b.ci', 'X', '2024-06', '99999999', 'approved']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('hors borne')
  })

  it('expenses : INSERT échoue → erreur capturée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT employee
      .mockRejectedValueOnce(new Error('boom'))            // INSERT échoue
      .mockResolvedValueOnce({ rows: [] })                 // audit_log
    const res = await app.inject({
      method: 'POST', url: '/settings/import/expenses', headers: auth(tokenFor(app, 'admin')),
      payload: {
        headers: ['email_employe', 'titre', 'mois', 'montant_total', 'statut'],
        rows: [['a@b.ci', 'X', '2024-06', '25000', 'approved']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).skipped).toBe(1)
  })

  it('500 si erreur globale pendant l\'import (DB down avant la boucle)', async () => {
    // type employees → premier query = SELECT department ; on le fait planter de
    // façon non rattrapée en rejetant AVANT le try interne par ligne... ici on
    // rejette le SELECT department (rattrapé) ; pour le 500 global on cible un
    // type sans try interne : on force le rejet de l'audit ne suffit pas.
    // On utilise le default mock rejeté pour faire planter la 1re requête.
    queryMock.mockReset()
    queryMock.mockRejectedValue(new Error('db totally down'))
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees', headers: auth(tokenFor(app, 'admin')),
      // ligne sans email → court-circuite avant toute requête DB par ligne,
      // donc la seule requête possible est auditLogSettings (non bloquante).
      // Pour réellement déclencher le catch global, on met un email + departement
      // mais comme le SELECT department est hors du try interne, son rejet
      // remonte au catch global → 500.
      payload: { headers: ['email', 'departement'], rows: [['a@b.ci', 'RH']] },
    })
    expect(res.statusCode).toBe(500)
  })

  it('403 si rôle employee (RBAC admin/hr_manager)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees', headers: auth(tokenFor(app, 'employee')),
      payload: { headers: ['email'], rows: [['a@b.ci']] },
    })
    expect(res.statusCode).toBe(403)
  })
})
