import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

// Borne d'attente email courte pour tester le comportement « SMTP qui pend »
// sans ralentir la suite (production : 8 s).
vi.hoisted(() => { process.env['EMAIL_WAIT_MS'] = '50' })
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

const { setTokenEpochMock } = vi.hoisted(() => ({
  setTokenEpochMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  setTokenEpoch:      setTokenEpochMock,
}))

vi.mock('../../db/provisioning.js', () => ({
  provisionTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: vi.fn().mockResolvedValue({ sent: true }),
  sendTestEmail:            vi.fn().mockResolvedValue(undefined),
}))

// Par défaut : hôte sortant/SMTP considéré sûr (pass-through). Les tests SSRF
// dédiés surchargent avec mockRejectedValueOnce(new SsrfBlockedError(...)).
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

import authPlugin from '../../plugins/auth.js'
import settingsRoutes from './settings.routes.js'
import { sendTestEmail, sendEmployeeWelcomeEmail } from '../../services/email.js'
import { assertSafeOutboundHost, SsrfBlockedError } from '@nexusrhci/shared/ssrf-guard'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'

function tokenFor(app: FastifyInstance, role: string, tenantId: string | null = 't1') {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId, schemaName: TENANT, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
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
  vi.mocked(assertSafeOutboundHost).mockReset().mockResolvedValue(undefined)
  setTokenEpochMock.mockClear()
})

// ── Lien EXPLICITE compte utilisateur ↔ fiche employé (users.employee_id) ────
const EMP = '33333333-3333-3333-3333-333333333333'
const USER = '44444444-4444-4444-4444-444444444444'

describe('POST /settings/users — rattachement à une fiche employé', () => {
  it('fiche inexistante dans le tenant → 404, aucun compte créé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT employees (schéma du token)
    const res = await app.inject({
      method: 'POST', url: '/settings/users',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { email: 'k@sotra.ci', first_name: 'K', last_name: 'C', role: 'employee', employee_id: EMP },
    })
    expect(res.statusCode).toBe(404)
    expect(String(queryMock.mock.calls[0]![0])).toContain(`"${TENANT}".employees`)
    expect(queryMock.mock.calls.some(c => String(c[0]).includes('INSERT INTO'))).toBe(false)
  })

  it('fiche déjà liée à un autre compte → 409 (1 compte ↔ 1 fiche)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP }] })    // fiche trouvée
      .mockResolvedValueOnce({ rows: [{ id: 'other' }] }) // déjà liée
    const res = await app.inject({
      method: 'POST', url: '/settings/users',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { email: 'k@sotra.ci', first_name: 'K', last_name: 'C', employee_id: EMP },
    })
    expect(res.statusCode).toBe(409)
  })

  it('fiche libre → compte créé avec employee_id renseigné', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP }] }) // fiche trouvée
      .mockResolvedValueOnce({ rows: [] })            // non liée
      .mockResolvedValueOnce({ rows: [{ id: USER, email: 'k@sotra.ci', role: 'manager' }] }) // INSERT users
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/settings/users',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { email: 'k@sotra.ci', first_name: 'K', last_name: 'C', role: 'manager', employee_id: EMP },
    })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO "tenant_sotra".users'))!
    expect((insert[1] as unknown[])[6]).toBe(EMP)
  })

  it('RBAC inchangé : un hr_officer ne peut pas créer de compte (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/settings/users',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { email: 'k@sotra.ci', first_name: 'K', last_name: 'C', employee_id: EMP },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('PATCH /settings/users/:id — changement de fiche liée', () => {
  it('employee_id non UUID → 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${USER}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employee_id: 'pas-un-uuid' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('lie une fiche libre, trace l’audit et invalide les sessions de la cible', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'employee', is_active: true, employee_id: null }] }) // before
      .mockResolvedValueOnce({ rows: [{ id: EMP }] }) // fiche trouvée
      .mockResolvedValueOnce({ rows: [] })            // non liée ailleurs
      .mockResolvedValueOnce({ rows: [{ id: USER, email: 'k@sotra.ci', role: 'employee', is_active: true, employee_id: EMP }] }) // UPDATE
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${USER}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employee_id: EMP },
    })
    expect(res.statusCode).toBe(200)
    const update = queryMock.mock.calls.find(c => String(c[0]).startsWith('UPDATE "tenant_sotra".users'))!
    expect(String(update[0])).toContain('employee_id = $1')
    expect(setTokenEpochMock).toHaveBeenCalledWith(USER)
    // Contrôle d'unicité : exclut le compte modifié lui-même.
    expect(queryMock.mock.calls[2]![1]).toEqual([EMP, USER])
  })

  it('délier (null) ne déclenche aucun contrôle de fiche', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'employee', is_active: true, employee_id: EMP }] })
      .mockResolvedValueOnce({ rows: [{ id: USER, employee_id: null }] })
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${USER}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employee_id: null },
    })
    expect(res.statusCode).toBe(200)
    expect(queryMock.mock.calls[1]![1]).toEqual([null, USER])
  })
})

describe('GET /settings/users — fiche liée (explicite ou repli email)', () => {
  it('expose le nom de la fiche et le type de lien', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: USER, employee_id: EMP, employee_first_name: 'Kouassi', employee_last_name: 'Coulibaly', employee_link: 'explicit' }] })
    const res = await app.inject({
      method: 'GET', url: '/settings/users',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data[0].employee_link).toBe('explicit')
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toContain('e.id = u.employee_id')
    expect(sql).toContain('u.employee_id IS NULL')
  })
})

describe('GET /settings/workflow/unlinked-managers — N+1 sans compte', () => {
  it('liste les responsables sans compte actif lié (lien explicite ou email)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: EMP, first_name: 'Yao', last_name: 'Kouadio', email: null, reports_count: 3 }] })
    const res = await app.inject({
      method: 'GET', url: '/settings/workflow/unlinked-managers',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data[0].reports_count).toBe(3)
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toContain('e.manager_id = m.id')
    expect(sql).toContain('NOT EXISTS')
    expect(sql).toContain('u.employee_id = m.id')
    expect(sql).toContain(`"${TENANT}".users`)
  })

  it('refusé à un manager (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/settings/workflow/unlinked-managers',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
