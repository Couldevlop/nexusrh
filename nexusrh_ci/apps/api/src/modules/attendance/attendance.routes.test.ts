import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
const { isSafeOutboundUrlMock } = vi.hoisted(() => ({ isSafeOutboundUrlMock: vi.fn() }))
const { fetchDevicePunchesMock } = vi.hoisted(() => ({ fetchDevicePunchesMock: vi.fn() }))
const { enqueuePollMock } = vi.hoisted(() => ({ enqueuePollMock: vi.fn() }))
const { encryptMock, decryptIfPresentMock } = vi.hoisted(() => ({
  // Renvoie un chiffré opaque SANS le texte clair en substring (comme l'AES-GCM
  // réel produirait) — permet d'asserter que le clair ne fuit jamais en base.
  encryptMock: vi.fn(() => 'ENC_CIPHERTEXT_PLACEHOLDER'),
  decryptIfPresentMock: vi.fn(() => 'decrypted-secret-value'),
}))

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/ssrf-guard.js', () => ({ isSafeOutboundUrl: isSafeOutboundUrlMock }))
vi.mock('./attendance.fetch.js', () => ({ fetchDevicePunches: fetchDevicePunchesMock }))
vi.mock('./attendance.queue.js', () => ({ enqueuePoll: enqueuePollMock }))
vi.mock('../../utils/crypto.js', () => ({ encrypt: encryptMock, decryptIfPresent: decryptIfPresentMock }))

import authPlugin from '../../plugins/auth.js'
import { attendanceRoutes } from './attendance.routes.js'

const SCHEMA = 'tenant_sotra'
const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(attendanceRoutes, { prefix: '/attendance' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
  isSafeOutboundUrlMock.mockReset()
  isSafeOutboundUrlMock.mockResolvedValue({ ok: true })
  fetchDevicePunchesMock.mockReset()
  fetchDevicePunchesMock.mockResolvedValue({ ok: true, punches: [] })
  enqueuePollMock.mockReset()
  enqueuePollMock.mockResolvedValue(undefined)
  encryptMock.mockClear()
  decryptIfPresentMock.mockClear()
})

function adminAuth(app: FastifyInstance) {
  return { authorization: `Bearer ${tokenFor(app, 'admin')}` }
}

const VALID_DEVICE = {
  name: 'Badgeuse Siège',
  base_url: 'https://badgeuse.exemple.ci/api/punches',
  auth_type: 'bearer' as const,
  auth_secret: 'topsecret123456',
}

const VALID_CONFIG = {
  lateMinutesTier1: 30,
  occurrencesTier1: 3,
  lateMinutesTier2: 60,
  occurrencesTier2: 3,
  unjustifiedAbsenceOccurrences: 1,
  warningsBeforeSanction: 2,
  windowMode: 'consecutive_or_month',
  defaultExpectedStart: '08:00',
  defaultToleranceMin: 10,
  defaultWorkdays: [1, 2, 3, 4, 5],
}

describe('OWASP A01 — GET /attendance/config réservé admin', () => {
  for (const role of ['manager', 'employee', 'readonly', 'hr_manager', 'hr_officer']) {
    it(`refuse le rôle ${role} (403)`, async () => {
      const res = await app.inject({
        method: 'GET', url: '/attendance/config',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/attendance/config' })
    expect(res.statusCode).toBe(401)
  })

  it('autorise admin (200) avec les défauts si aucune ligne', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.lateMinutesTier1).toBe(30)
    expect(body.data.defaultExpectedStart).toBe('08:00')
    expect(body.data.defaultWorkdays).toEqual([1, 2, 3, 4, 5])
  })
})

describe('PUT /attendance/config', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: VALID_CONFIG,
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejette un champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette occurrencesTier1 = 0 → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, occurrencesTier1: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un defaultExpectedStart malformé → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, defaultExpectedStart: '8h00' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un defaultWorkdays hors 1..7 → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, defaultWorkdays: [0, 1, 2] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un lateMinutesTier1 négatif → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, lateMinutesTier1: -1 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte une config valide → 200 (INSERT) + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT id existant → aucun
      .mockResolvedValueOnce({ rows: [{ id: 'c1', ...VALID_CONFIG }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: VALID_CONFIG,
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('attendance_config.updated')
  })

  it('met à jour la ligne existante (UPDATE) quand une config existe déjà', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'existing-id' }] }) // SELECT id existant
      .mockResolvedValueOnce({ rows: [{ id: 'existing-id', ...VALID_CONFIG }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: VALID_CONFIG,
    })
    expect(res.statusCode).toBe(200)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updateCall).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CRUD badgeuses (/attendance/devices) — SSRF, secret chiffré/masqué, test, sync
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /attendance/devices', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/attendance/devices',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('liste les badgeuses SANS jamais renvoyer le secret (has_secret seulement)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: DEVICE_ID, name: 'Badgeuse Siège', base_url: 'https://badgeuse.exemple.ci/api',
        auth_type: 'bearer', auth_header_name: null, default_headers: {}, field_mapping: {},
        poll_enabled: true, poll_interval_min: 15, last_sync_at: null, last_sync_status: null,
        is_active: true, created_at: '2026-01-01T00:00:00Z', has_secret: true,
      }],
    })
    const res = await app.inject({ method: 'GET', url: '/attendance/devices', headers: adminAuth(app) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].has_secret).toBe(true)
    expect(body.data[0]).not.toHaveProperty('auth_secret_enc')
    expect(body.data[0]).not.toHaveProperty('auth_secret')
    expect(JSON.stringify(body)).not.toContain('topsecret')
    const selectCall = queryMock.mock.calls.find((c) => String(c[0]).includes('attendance_devices'))
    expect(String(selectCall?.[0])).toContain('has_secret')
    expect(String(selectCall?.[0])).not.toContain('auth_secret_enc IS NOT NULL AS auth_secret_enc')
  })
})

describe('POST /attendance/devices', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/devices',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: VALID_DEVICE,
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejette un champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/devices',
      headers: adminAuth(app),
      payload: { ...VALID_DEVICE, extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('URL non sûre (SSRF) → 422, aucun INSERT exécuté', async () => {
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: 'Adresse IP privée/interne interdite' })
    const res = await app.inject({
      method: 'POST', url: '/attendance/devices',
      headers: adminAuth(app),
      payload: { ...VALID_DEVICE, base_url: 'http://169.254.169.254/latest/meta-data' },
    })
    expect(res.statusCode).toBe(422)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_devices'))
    expect(insertCall).toBeUndefined()
  })

  it('crée un device (201) et chiffre le secret avant stockage', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: DEVICE_ID }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/attendance/devices',
      headers: adminAuth(app),
      payload: VALID_DEVICE,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.id).toBe(DEVICE_ID)
    expect(encryptMock).toHaveBeenCalledWith(VALID_DEVICE.auth_secret)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_devices'))
    expect(insertCall).toBeDefined()
    expect(JSON.stringify(insertCall?.[1])).not.toContain(VALID_DEVICE.auth_secret)
    expect(JSON.stringify(insertCall?.[1])).toContain('ENC_CIPHERTEXT_PLACEHOLDER')
  })
})

describe('PATCH /attendance/devices/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/attendance/devices/not-a-uuid',
      headers: adminAuth(app), payload: { name: 'x' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/devices/${DEVICE_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { name: 'x' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('re-vérifie SSRF si base_url change → 422 si dangereuse', async () => {
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: 'Hôte interne interdit' })
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/devices/${DEVICE_ID}`,
      headers: adminAuth(app), payload: { base_url: 'http://localhost:9999/' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('ne re-chiffre PAS le secret si non fourni', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DEVICE_ID }] }) // UPDATE
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/devices/${DEVICE_ID}`,
      headers: adminAuth(app), payload: { name: 'Nouveau nom' },
    })
    expect(res.statusCode).toBe(200)
    expect(encryptMock).not.toHaveBeenCalled()
  })

  it('re-chiffre le secret quand fourni', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DEVICE_ID }] }) // UPDATE
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/devices/${DEVICE_ID}`,
      headers: adminAuth(app), payload: { auth_secret: 'nouveau-secret-999' },
    })
    expect(res.statusCode).toBe(200)
    expect(encryptMock).toHaveBeenCalledWith('nouveau-secret-999')
  })

  it('404 si introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/devices/${DEVICE_ID}`,
      headers: adminAuth(app), payload: { name: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('audite tous les champs modifiés fournis + secretChanged, jamais le secret en clair', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: DEVICE_ID }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/devices/${DEVICE_ID}`,
      headers: adminAuth(app),
      payload: {
        name: 'Badgeuse Renommée',
        auth_secret: 'nouveau-secret-999',
        is_active: false,
        poll_interval_min: 30,
      },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall).toBeDefined()
    const changesJson = String(auditCall?.[1]?.[4])
    expect(changesJson).toContain('"name":"Badgeuse Renommée"')
    expect(changesJson).toContain('"is_active":false')
    expect(changesJson).toContain('"poll_interval_min":30')
    expect(changesJson).toContain('"secretChanged":true')
    expect(changesJson).not.toContain('nouveau-secret-999')
    expect(changesJson).not.toContain('auth_secret')
  })

  it('audite default_headers_keys (clés seulement, jamais les valeurs) pour prévenir la fuite de secrets', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: DEVICE_ID }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const testHeaders = { 'X-Custom-Auth': 'test-value', 'X-Request-ID': 'req-123' }
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/devices/${DEVICE_ID}`,
      headers: adminAuth(app),
      payload: { default_headers: testHeaders },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall).toBeDefined()
    const changesJson = String(auditCall?.[1]?.[4])
    // La clé doit être logged, mais sous `default_headers_keys` (tableau de noms seulement)
    expect(changesJson).toContain('"default_headers_keys"')
    expect(changesJson).toContain('X-Custom-Auth')
    expect(changesJson).toContain('X-Request-ID')
    // Les VALEURS ne doivent JAMAIS être logées
    expect(changesJson).not.toContain('test-value')
    expect(changesJson).not.toContain('req-123')
  })
})

describe('DELETE /attendance/devices/:id', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/attendance/devices/${DEVICE_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('supprime (200) quand trouvé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DEVICE_ID }] })
    const res = await app.inject({
      method: 'DELETE', url: `/attendance/devices/${DEVICE_ID}`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.deleted).toBe(true)
  })

  it('404 si introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'DELETE', url: `/attendance/devices/${DEVICE_ID}`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /attendance/devices/:id/test', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/attendance/devices/${DEVICE_ID}/test`,
      headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404 si introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/attendance/devices/${DEVICE_ID}/test`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(404)
  })

  it('URL non sûre (SSRF) → 422, fetchDevicePunches JAMAIS appelé', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        base_url: 'http://169.254.169.254/latest/meta-data', auth_type: 'bearer',
        auth_secret_enc: 'enc(topsecret123456)', auth_header_name: null,
        default_headers: {}, field_mapping: {}, sync_cursor: null,
      }],
    })
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: 'blocked' })
    const res = await app.inject({
      method: 'POST', url: `/attendance/devices/${DEVICE_ID}/test`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(422)
    expect(fetchDevicePunchesMock).not.toHaveBeenCalled()
  })

  it('appelle fetchDevicePunches et renvoie un résumé SANS le secret ni le payload brut', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        base_url: 'https://badgeuse.exemple.ci/api', auth_type: 'bearer',
        auth_secret_enc: 'enc(topsecret123456)', auth_header_name: null,
        default_headers: {}, field_mapping: {}, sync_cursor: null,
      }],
    })
    fetchDevicePunchesMock.mockResolvedValueOnce({
      ok: true,
      punches: [
        { rawEmployeeRef: 'M001', punchedAt: new Date('2026-07-01T08:00:00Z'), direction: 'in', dedupKey: 'M001|x', raw: { secretField: 'donnee-brute-sensible' } },
      ],
    })
    const res = await app.inject({
      method: 'POST', url: `/attendance/devices/${DEVICE_ID}/test`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(fetchDevicePunchesMock).toHaveBeenCalledTimes(1)
    expect(decryptIfPresentMock).toHaveBeenCalledWith('enc(topsecret123456)')
    expect(body.data.ok).toBe(true)
    expect(body.data.count).toBe(1)
    expect(body.data.sample).toHaveLength(1)
    expect(body.data.sample[0]).not.toHaveProperty('raw')
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('topsecret123456')
    expect(raw).not.toContain('decrypted-secret-value')
    expect(raw).not.toContain('donnee-brute-sensible')
    expect(raw).not.toContain('enc(topsecret123456)')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CRUD horaires de référence (/attendance/schedules) — validation stricte
// (ferme le trou fail-open de `computeDay`/`thresholdInstant`, qui renvoie
// silencieusement `lateMinutes = 0` sur un `expected_start` malformé) +
// unicité logique (un seul horaire actif par scope+scope_id, 409 sinon).
// ═══════════════════════════════════════════════════════════════════════════

const EMP_SCOPE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const SCHEDULE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const VALID_SCHEDULE_TENANT = {
  scope: 'tenant' as const,
  expected_start: '08:00',
  tolerance_min: 10,
  expected_end: '17:00',
  workdays: [1, 2, 3, 4, 5],
  is_active: true,
}

const VALID_SCHEDULE_EMPLOYEE = {
  scope: 'employee' as const,
  scope_id: EMP_SCOPE_ID,
  expected_start: '09:00',
}

describe('GET /attendance/schedules', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/attendance/schedules',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('liste les horaires actifs (200)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: SCHEDULE_ID, scope: 'tenant', scope_id: null, expected_start: '08:00:00',
        tolerance_min: 10, expected_end: '17:00:00', workdays: [1, 2, 3, 4, 5],
        is_active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }],
    })
    const res = await app.inject({ method: 'GET', url: '/attendance/schedules', headers: adminAuth(app) })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })
})

describe('POST /attendance/schedules', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: VALID_SCHEDULE_TENANT,
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejette un champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un scope invalide → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, scope: 'company' },
    })
    expect(res.statusCode).toBe(400)
  })

  it("scope='employee' sans scope_id → 400", async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { scope: 'employee', expected_start: '08:00' },
    })
    expect(res.statusCode).toBe(400)
  })

  it("scope='department' sans scope_id → 400", async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { scope: 'department', expected_start: '08:00' },
    })
    expect(res.statusCode).toBe(400)
  })

  it("scope='tenant' avec un scope_id → 400", async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, scope_id: EMP_SCOPE_ID },
    })
    expect(res.statusCode).toBe(400)
  })

  it("rejette expected_start='8:00' (un seul chiffre) → 400", async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, expected_start: '8:00' },
    })
    expect(res.statusCode).toBe(400)
  })

  it("rejette expected_start='25:00' (heure hors bornes) → 400", async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, expected_start: '25:00' },
    })
    expect(res.statusCode).toBe(400)
  })

  it("rejette expected_start='08:60' (minute hors bornes) → 400", async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, expected_start: '08:60' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette workdays=[1,1,8] (doublon + hors 1..7) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, workdays: [1, 1, 8] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette workdays=[1,2,1] (doublon valide sinon) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, workdays: [1, 2, 1] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette tolerance_min=-1 → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: { ...VALID_SCHEDULE_TENANT, tolerance_min: -1 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('crée un horaire valide (201) + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT doublon → aucun
      .mockResolvedValueOnce({ rows: [{ id: SCHEDULE_ID }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: VALID_SCHEDULE_EMPLOYEE,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.id).toBe(SCHEDULE_ID)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('attendance.schedule.created')
  })

  it('doublon actif (même scope + scope_id) → 409, aucun INSERT exécuté', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'existing-schedule-id' }] }) // SELECT doublon → trouvé
    const res = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: VALID_SCHEDULE_EMPLOYEE,
    })
    expect(res.statusCode).toBe(409)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_schedules'))
    expect(insertCall).toBeUndefined()
  })
})

describe('PATCH /attendance/schedules/:id', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/attendance/schedules/not-a-uuid',
      headers: adminAuth(app), payload: { tolerance_min: 15 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { tolerance_min: 15 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejette un champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: adminAuth(app), payload: { extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un expected_start malformé → 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: adminAuth(app), payload: { expected_start: '25:00' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('modifie un horaire (200, champ simple sans re-vérif scope) + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SCHEDULE_ID }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: adminAuth(app), payload: { tolerance_min: 20 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.updated).toBe(true)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('attendance.schedule.updated')
  })

  it("re-vérifie la cohérence scope/scope_id quand l'un des deux change → 400 si incohérent", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ scope: 'employee', scope_id: EMP_SCOPE_ID }] }) // SELECT courant
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: adminAuth(app), payload: { scope: 'tenant' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: adminAuth(app), payload: { tolerance_min: 20 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('modifie un champ non-identitaire (tolerance_min) sans déclencher de re-vérif d’unicité → 200, aucun SELECT de doublon', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: SCHEDULE_ID }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: adminAuth(app), payload: { tolerance_min: 25 },
    })
    expect(res.statusCode).toBe(200)
    // Aucun SELECT de contrôle scope/doublon : seuls UPDATE + audit_log ont tourné.
    expect(queryMock.mock.calls).toHaveLength(2)
    const dupCheck = queryMock.mock.calls.find((c) => String(c[0]).includes('is_active = true') && String(c[0]).includes('id <>'))
    expect(dupCheck).toBeUndefined()
  })

  it('contournement par RÉACTIVATION : POST A actif → PATCH A inactif → POST B actif (même portée) → PATCH A actif → 409', async () => {
    const scheduleA = SCHEDULE_ID
    const scheduleB = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

    // 1) Création de A (actif) — aucun doublon existant.
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT doublon → aucun
      .mockResolvedValueOnce({ rows: [{ id: scheduleA }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit
    const createA = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: VALID_SCHEDULE_EMPLOYEE,
    })
    expect(createA.statusCode).toBe(201)

    // 2) PATCH A → is_active=false (désactivation, aucun risque de doublon).
    queryMock.mockReset()
    queryMock
      .mockResolvedValueOnce({ rows: [{ scope: 'employee', scope_id: EMP_SCOPE_ID, is_active: true }] }) // SELECT courant
      .mockResolvedValueOnce({ rows: [{ id: scheduleA }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const deactivateA = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${scheduleA}`,
      headers: adminAuth(app), payload: { is_active: false },
    })
    expect(deactivateA.statusCode).toBe(200)

    // 3) POST B — même portée, actif. Comme A est désormais inactif, le SELECT
    // de doublon ne trouve rien → 201.
    queryMock.mockReset()
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT doublon → aucun (A inactif)
      .mockResolvedValueOnce({ rows: [{ id: scheduleB }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit
    const createB = await app.inject({
      method: 'POST', url: '/attendance/schedules',
      headers: adminAuth(app),
      payload: VALID_SCHEDULE_EMPLOYEE,
    })
    expect(createB.statusCode).toBe(201)

    // 4) PATCH A → is_active=true (réactivation). B est déjà actif sur la même
    // portée → la re-vérification doit désormais bloquer avec 409 (avant le
    // fix, aucun contrôle ne tournait ici : A redevenait actif en silence,
    // créant deux horaires actifs sur le même scope+scope_id).
    queryMock.mockReset()
    queryMock
      .mockResolvedValueOnce({ rows: [{ scope: 'employee', scope_id: EMP_SCOPE_ID, is_active: false }] }) // SELECT courant (A)
      .mockResolvedValueOnce({ rows: [{ id: scheduleB }] }) // SELECT doublon → B trouvé
    const reactivateA = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${scheduleA}`,
      headers: adminAuth(app), payload: { is_active: true },
    })
    expect(reactivateA.statusCode).toBe(409)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('attendance_schedules'))
    expect(updateCall).toBeUndefined()
  })

  it('contournement par RE-SCOPING : PATCH scope+scope_id vers une portée déjà occupée par un autre horaire actif → 409', async () => {
    const scheduleX = SCHEDULE_ID // scope='department', scope_id=DEPT_ID, actif
    const scheduleY = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' // scope='employee', scope_id=EMP_SCOPE_ID, actif
    const DEPT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

    queryMock
      .mockResolvedValueOnce({ rows: [{ scope: 'department', scope_id: DEPT_ID, is_active: true }] }) // SELECT courant (X)
      .mockResolvedValueOnce({ rows: [{ id: scheduleY }] }) // SELECT doublon → Y trouvé sur la portée cible
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/schedules/${scheduleX}`,
      headers: adminAuth(app),
      payload: { scope: 'employee', scope_id: EMP_SCOPE_ID },
    })
    expect(res.statusCode).toBe(409)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('attendance_schedules'))
    expect(updateCall).toBeUndefined()
  })
})

describe('DELETE /attendance/schedules/:id', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('id invalide → 400', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/attendance/schedules/not-a-uuid',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(400)
  })

  it('supprime (200) quand trouvé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: SCHEDULE_ID }] })
    const res = await app.inject({
      method: 'DELETE', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.deleted).toBe(true)
  })

  it('404 si introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'DELETE', url: `/attendance/schedules/${SCHEDULE_ID}`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /attendance/devices/:id/sync', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/attendance/devices/${DEVICE_ID}/sync`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404 si introuvable — aucun job enfilé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/attendance/devices/${DEVICE_ID}/sync`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(404)
    expect(enqueuePollMock).not.toHaveBeenCalled()
  })

  it('enfile un job attendance-poll et renvoie enqueued:true (aucun fetch synchrone)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: DEVICE_ID }] })
    const res = await app.inject({
      method: 'POST', url: `/attendance/devices/${DEVICE_ID}/sync`,
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.enqueued).toBe(true)
    expect(enqueuePollMock).toHaveBeenCalledWith(SCHEMA, DEVICE_ID)
    expect(fetchDevicePunchesMock).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Task 13 — GET/POST /attendance/punches, GET /attendance/days,
// POST /attendance/recompute (RBAC-équipe, correction manuelle, idempotence).
// ═══════════════════════════════════════════════════════════════════════════

const EMPLOYEE_ID = '11111111-1111-1111-1111-111111111111'
const MANAGER_EMPLOYEE_ID = '22222222-2222-2222-2222-222222222222'

describe('GET /attendance/punches — RBAC-équipe', () => {
  for (const role of ['employee', 'readonly']) {
    it(`refuse le rôle ${role} (403) — self-service réservé à /attendance/me`, async () => {
      const res = await app.inject({
        method: 'GET', url: '/attendance/punches',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/attendance/punches' })
    expect(res.statusCode).toBe(401)
  })

  it('employeeId invalide → 400, aucune requête exécutée', async () => {
    const res = await app.inject({
      method: 'GET', url: '/attendance/punches?employeeId=not-a-uuid',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('from invalide → 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/attendance/punches?from=01-01-2026',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(400)
  })

  it('rôle RH (admin/hr_manager/hr_officer) voit tout le tenant — aucun filtre manager_id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'p1', employee_id: EMPLOYEE_ID }] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/punches',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1) // pas de lookup employé manager
    const call = queryMock.mock.calls[0]
    expect(String(call?.[0])).not.toContain('manager_id')
  })

  it("manager SANS dossier employé associé → liste VIDE (fail-closed), jamais tout le tenant", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup employé manager → aucun
    const res = await app.inject({
      method: 'GET', url: '/attendance/punches',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([])
  })

  it("manager AVEC dossier employé → filtre SQL 'e.manager_id = $n' avec son propre id, jamais côté UI", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: MANAGER_EMPLOYEE_ID }] }) // lookup employé manager
      .mockResolvedValueOnce({ rows: [] }) // SELECT pointages filtré
    const res = await app.inject({
      method: 'GET', url: '/attendance/punches',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const punchCall = queryMock.mock.calls.find((c) => String(c[0]).includes('attendance_punches') && String(c[0]).includes('manager_id'))
    expect(punchCall).toBeDefined()
    expect(String(punchCall?.[0])).toContain('e.manager_id = $')
    expect(punchCall?.[1]).toContain(MANAGER_EMPLOYEE_ID)
  })
})

describe('POST /attendance/punches — correction manuelle', () => {
  const VALID_PUNCH = { employeeId: EMPLOYEE_ID, direction: 'in' as const, punchedAt: '2026-07-15T08:00:00.000Z' }

  for (const role of ['manager', 'employee', 'readonly']) {
    it(`refuse le rôle ${role} (403)`, async () => {
      const res = await app.inject({
        method: 'POST', url: '/attendance/punches',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
        payload: VALID_PUNCH,
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('rejette un champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/punches',
      headers: adminAuth(app), payload: { ...VALID_PUNCH, extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette une direction invalide → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/punches',
      headers: adminAuth(app), payload: { ...VALID_PUNCH, direction: 'sideways' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un punchedAt malformé → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/punches',
      headers: adminAuth(app), payload: { ...VALID_PUNCH, punchedAt: 'pas-une-date' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('employé introuvable dans ce tenant → 404, aucun INSERT', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT employé → aucun
    const res = await app.inject({
      method: 'POST', url: '/attendance/punches',
      headers: adminAuth(app), payload: VALID_PUNCH,
    })
    expect(res.statusCode).toBe(404)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_punches'))
    expect(insertCall).toBeUndefined()
  })

  it("crée un pointage manuel → 201, source='manual', device_id NULL, dedup_key préfixé 'manual|'", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMPLOYEE_ID }] }) // SELECT employé → trouvé
      .mockResolvedValueOnce({ rows: [{ id: 'punch-1' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/attendance/punches',
      headers: adminAuth(app), payload: VALID_PUNCH,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.source).toBe('manual')
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_punches'))
    expect(insertCall).toBeDefined()
    expect(String(insertCall?.[0])).toContain("'manual'")
    expect(String(insertCall?.[0])).toContain('device_id')
    const params = insertCall?.[1] as unknown[]
    expect(params[0]).toBe(EMPLOYEE_ID) // employee_id
    expect(String(params[params.length - 1])).toMatch(new RegExp(`^manual\\|${EMPLOYEE_ID}\\|`)) // dedup_key
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('attendance.punch.manual_created')
  })
})

describe('GET /attendance/days — RBAC-équipe', () => {
  for (const role of ['employee', 'readonly']) {
    it(`refuse le rôle ${role} (403)`, async () => {
      const res = await app.inject({
        method: 'GET', url: '/attendance/days',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it("manager SANS dossier employé associé → liste VIDE (fail-closed)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/days',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([])
  })

  it("manager AVEC dossier employé → filtre SQL 'e.manager_id = $n'", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: MANAGER_EMPLOYEE_ID }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/days',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const dayCall = queryMock.mock.calls.find((c) => String(c[0]).includes('attendance_days') && String(c[0]).includes('manager_id'))
    expect(dayCall).toBeDefined()
    expect(dayCall?.[1]).toContain(MANAGER_EMPLOYEE_ID)
  })

  it('rôle RH voit tout le tenant — aucun lookup manager', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/days',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /attendance/recompute — intégration services purs + idempotence', () => {
  const RECOMPUTE_DAY = '2026-07-15' // mercredi, jour ouvré par défaut, non férié CI

  /**
   * Route chaque requête `pool.query` vers une réponse plausible en fonction
   * du SQL, plutôt qu'une séquence positionnelle fragile — le recalcul
   * enchaîne plusieurs requêtes par employé/jour (config, horaire, pointages,
   * congés, upsert) et ce test appelle la route DEUX FOIS (idempotence).
   */
  function mockRecomputeQueries(): void {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('attendance_config') && s.includes('default_expected_start')) {
        return Promise.resolve({ rows: [] }) // aucune config → défauts applicatifs
      }
      if (s.includes('.employees') && s.includes('department_id')) {
        return Promise.resolve({ rows: [{ department_id: null }] })
      }
      if (s.includes('attendance_schedules')) {
        return Promise.resolve({ rows: [] }) // aucune surcharge → repli tenant par défaut
      }
      if (s.includes('attendance_punches') && s.includes('raw_employee_ref')) {
        return Promise.resolve({ rows: [] }) // aucun pointage ce jour
      }
      if (s.includes('.absences') && s.includes("status = 'approved'")) {
        return Promise.resolve({ rows: [] }) // aucun congé approuvé
      }
      if (s.includes('INSERT INTO') && s.includes('attendance_days')) {
        return Promise.resolve({ rows: [] })
      }
      if (s.includes('audit_log')) {
        return Promise.resolve({ rows: [] })
      }
      return Promise.resolve({ rows: [] })
    })
  }

  for (const role of ['manager', 'employee', 'readonly']) {
    it(`refuse le rôle ${role} (403) — recalcul réservé RH`, async () => {
      const res = await app.inject({
        method: 'POST', url: '/attendance/recompute',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
        payload: { employeeIds: [EMPLOYEE_ID], from: RECOMPUTE_DAY, to: RECOMPUTE_DAY },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('employeeIds vide → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/recompute',
      headers: adminAuth(app),
      payload: { employeeIds: [], from: RECOMPUTE_DAY, to: RECOMPUTE_DAY },
    })
    expect(res.statusCode).toBe(400)
  })

  it('from > to → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/recompute',
      headers: adminAuth(app),
      payload: { employeeIds: [EMPLOYEE_ID], from: '2026-07-20', to: '2026-07-10' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/recompute',
      headers: adminAuth(app),
      payload: { employeeIds: [EMPLOYEE_ID], from: RECOMPUTE_DAY, to: RECOMPUTE_DAY, extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it("employé introuvable dans ce tenant → ignoré silencieusement, recomputed=0 (jamais d'erreur)", async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('.employees') && s.includes('department_id')) return Promise.resolve({ rows: [] }) // introuvable
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: '/attendance/recompute',
      headers: adminAuth(app),
      payload: { employeeIds: [EMPLOYEE_ID], from: RECOMPUTE_DAY, to: RECOMPUTE_DAY },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.recomputed).toBe(0)
  })

  it("employé sans AUCUN pointage → ne lève jamais, upsert un jour 'absent_unjustified'", async () => {
    mockRecomputeQueries()
    const res = await app.inject({
      method: 'POST', url: '/attendance/recompute',
      headers: adminAuth(app),
      payload: { employeeIds: [EMPLOYEE_ID], from: RECOMPUTE_DAY, to: RECOMPUTE_DAY },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.recomputed).toBe(1)
    const upsertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_days'))
    expect(upsertCall).toBeDefined()
    expect(String(upsertCall?.[0])).toContain('ON CONFLICT (employee_id, work_date) DO UPDATE')
    const params = upsertCall?.[1] as unknown[]
    // employeeId, workDate, firstIn, lastOut, expectedStart, lateMinutes, status, justifiedBy
    expect(params[0]).toBe(EMPLOYEE_ID)
    expect(params[1]).toBe(RECOMPUTE_DAY)
    expect(params[2]).toBeNull() // firstIn
    expect(params[5]).toBe(0)    // lateMinutes
    expect(params[6]).toBe('absent_unjustified')
  })

  it('deux appels identiques (mêmes employé+plage) → même upsert attendance_days (idempotent, ON CONFLICT DO UPDATE)', async () => {
    mockRecomputeQueries()
    const payload = { employeeIds: [EMPLOYEE_ID], from: RECOMPUTE_DAY, to: RECOMPUTE_DAY }

    const res1 = await app.inject({ method: 'POST', url: '/attendance/recompute', headers: adminAuth(app), payload })
    expect(res1.statusCode).toBe(200)
    expect(res1.json().data.recomputed).toBe(1)

    const res2 = await app.inject({ method: 'POST', url: '/attendance/recompute', headers: adminAuth(app), payload })
    expect(res2.statusCode).toBe(200)
    expect(res2.json().data.recomputed).toBe(1)

    const upsertCalls = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_days'))
    expect(upsertCalls).toHaveLength(2)
    // Même requête paramétrée (idempotence) — les deux appels envoient EXACTEMENT
    // les mêmes valeurs (employeeId, work_date, first_in, last_out, expected_start,
    // late_minutes, status, justified_by) puisque les entrées (aucun pointage,
    // même horaire, même jour) sont identiques.
    expect(upsertCalls[0]?.[1]).toEqual(upsertCalls[1]?.[1])
    expect(String(upsertCalls[0]?.[0])).toBe(String(upsertCalls[1]?.[0]))
  })

  it('plage > 366 jours → 400, aucune requête de recalcul exécutée', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/recompute',
      headers: adminAuth(app),
      payload: { employeeIds: [EMPLOYEE_ID], from: '2026-01-01', to: '2028-01-01' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Task 14 — GET/PATCH /attendance/warnings, GET /attendance/me(/warnings),
// POST /attendance/me/warnings/:id/respond, GET /attendance/dashboard.
// Crux sécurité : isolation self-service (IDOR, OWASP A01) — un employé ne
// doit jamais pouvoir lire/modifier les données d'un autre employé.
// ═══════════════════════════════════════════════════════════════════════════

const WARNING_ID = '33333333-3333-3333-3333-333333333333'
const OTHER_EMPLOYEE_ID = '44444444-4444-4444-4444-444444444444'

describe('GET /attendance/warnings — RBAC-équipe', () => {
  for (const role of ['employee', 'readonly']) {
    it(`refuse le rôle ${role} (403) — self-service réservé à /attendance/me/warnings`, async () => {
      const res = await app.inject({
        method: 'GET', url: '/attendance/warnings',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/attendance/warnings' })
    expect(res.statusCode).toBe(401)
  })

  it('employeeId invalide → 400, aucune requête exécutée', async () => {
    const res = await app.inject({
      method: 'GET', url: '/attendance/warnings?employeeId=not-a-uuid',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('status invalide (hors énumération) → 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/attendance/warnings?status=bogus',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(400)
  })

  it('rôle RH (admin/hr_manager/hr_officer) voit tout le tenant — aucun filtre manager_id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: WARNING_ID, employee_id: EMPLOYEE_ID }] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/warnings',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1) // pas de lookup employé manager
    expect(String(queryMock.mock.calls[0]?.[0])).not.toContain('manager_id')
  })

  it("manager SANS dossier employé associé → liste VIDE (fail-closed), jamais tout le tenant", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup employé manager → aucun
    const res = await app.inject({
      method: 'GET', url: '/attendance/warnings',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([])
  })

  it("manager AVEC dossier employé → filtre SQL 'e.manager_id = $n' avec son propre id", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: MANAGER_EMPLOYEE_ID }] }) // lookup employé manager
      .mockResolvedValueOnce({ rows: [] }) // SELECT avertissements filtré
    const res = await app.inject({
      method: 'GET', url: '/attendance/warnings',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls.find((c) => String(c[0]).includes('attendance_warnings') && String(c[0]).includes('manager_id'))
    expect(call).toBeDefined()
    expect(String(call?.[0])).toContain('e.manager_id = $')
    expect(call?.[1]).toContain(MANAGER_EMPLOYEE_ID)
  })
})

describe('PATCH /attendance/warnings/:id — RH uniquement', () => {
  for (const role of ['employee', 'readonly', 'manager']) {
    it(`refuse le rôle ${role} (403)`, async () => {
      const res = await app.inject({
        method: 'PATCH', url: `/attendance/warnings/${WARNING_ID}`,
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
        payload: { status: 'explained' },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('id invalide → 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/attendance/warnings/not-a-uuid',
      headers: adminAuth(app), payload: { status: 'explained' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/warnings/${WARNING_ID}`,
      headers: adminAuth(app), payload: { status: 'explained', extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it("status='active' (retour en arrière interdit, hors énumération PATCH) → 400", async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/warnings/${WARNING_ID}`,
      headers: adminAuth(app), payload: { status: 'active' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE → aucune ligne
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/warnings/${WARNING_ID}`,
      headers: adminAuth(app), payload: { status: 'closed' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('transitionne le statut (200) + audit + notifie l’employé concerné (userIdOfEmployee/notifyUser)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: WARNING_ID, employee_id: EMPLOYEE_ID }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-emp-1' }] }) // userIdOfEmployee
      .mockResolvedValueOnce({ rows: [] }) // notifyUser insert
    const res = await app.inject({
      method: 'PATCH', url: `/attendance/warnings/${WARNING_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { status: 'explained' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.status).toBe('explained')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('attendance.warning.status_updated')
    const notifCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('.notifications'))
    expect(notifCall).toBeDefined()
    expect(notifCall?.[1]).toContain('user-emp-1')
  })
})

describe('GET /attendance/me — self-service isolation (IDOR)', () => {
  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/attendance/me' })
    expect(res.statusCode).toBe(401)
  })

  it("aucun dossier employé associé au compte → 404, jamais les données d'un tiers", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup employé par email → aucun
    const res = await app.inject({
      method: 'GET', url: '/attendance/me',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it("résout l'employé depuis le TOKEN (email), ignore tout employeeId fourni en querystring", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMPLOYEE_ID }] }) // lookup employé par email
      .mockResolvedValueOnce({ rows: [{ id: 'p1', employee_id: EMPLOYEE_ID }] }) // punches
      .mockResolvedValueOnce({ rows: [{ id: 'd1', employee_id: EMPLOYEE_ID }] }) // days
    const res = await app.inject({
      // Tentative d'IDOR : employeeId d'un tiers glissé en querystring — doit être ignoré.
      method: 'GET', url: `/attendance/me?employeeId=${OTHER_EMPLOYEE_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.punches).toEqual([{ id: 'p1', employee_id: EMPLOYEE_ID }])
    expect(body.data.days).toEqual([{ id: 'd1', employee_id: EMPLOYEE_ID }])
    const punchCall = queryMock.mock.calls.find((c) => String(c[0]).includes('attendance_punches'))
    expect(punchCall?.[1]).toContain(EMPLOYEE_ID)
    expect(punchCall?.[1]).not.toContain(OTHER_EMPLOYEE_ID)
  })

  it('from invalide → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: EMPLOYEE_ID }] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/me?from=01-01-2026',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /attendance/me/warnings — self-service isolation (IDOR)', () => {
  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/attendance/me/warnings' })
    expect(res.statusCode).toBe(401)
  })

  it('aucun dossier employé associé → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/me/warnings',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('renvoie uniquement MES avertissements (filtre employee_id = mon id résolu par email)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMPLOYEE_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: WARNING_ID, employee_id: EMPLOYEE_ID }] })
    const res = await app.inject({
      method: 'GET', url: `/attendance/me/warnings?employeeId=${OTHER_EMPLOYEE_ID}`, // tentative IDOR ignorée
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(200)
    const warnCall = queryMock.mock.calls.find((c) => String(c[0]).includes('attendance_warnings'))
    expect(String(warnCall?.[0])).toContain('employee_id = $1')
    expect(warnCall?.[1]).toEqual([EMPLOYEE_ID])
  })
})

describe('POST /attendance/me/warnings/:id/respond — isolation IDOR (crux du module)', () => {
  const VALID_RESPONSE = { response: "J'étais bloqué dans les transports, voici un justificatif." }

  it('sans token → 401', async () => {
    const res = await app.inject({
      method: 'POST', url: `/attendance/me/warnings/${WARNING_ID}/respond`,
      payload: VALID_RESPONSE,
    })
    expect(res.statusCode).toBe(401)
  })

  it('id invalide → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/attendance/me/warnings/not-a-uuid/respond',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: VALID_RESPONSE,
    })
    expect(res.statusCode).toBe(400)
  })

  it('réponse vide → 400 (Zod)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/attendance/me/warnings/${WARNING_ID}/respond`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { response: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: `/attendance/me/warnings/${WARNING_ID}/respond`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { ...VALID_RESPONSE, extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('aucun dossier employé associé → 404 (même message générique)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: `/attendance/me/warnings/${WARNING_ID}/respond`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: VALID_RESPONSE,
    })
    expect(res.statusCode).toBe(404)
  })

  it('avertissement introuvable → 404, aucun UPDATE exécuté', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMPLOYEE_ID }] }) // lookup employé appelant
      .mockResolvedValueOnce({ rows: [] }) // SELECT avertissement → aucun
    const res = await app.inject({
      method: 'POST', url: `/attendance/me/warnings/${WARNING_ID}/respond`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: VALID_RESPONSE,
    })
    expect(res.statusCode).toBe(404)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('attendance_warnings'))
    expect(updateCall).toBeUndefined()
  })

  it("IDOR — avertissement d'un AUTRE employé → 404 (jamais 403, ne révèle pas l'existence), aucun UPDATE exécuté", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMPLOYEE_ID }] }) // lookup employé appelant
      .mockResolvedValueOnce({ rows: [{ id: WARNING_ID, employee_id: OTHER_EMPLOYEE_ID, tier: 'demande_explication' }] }) // avertissement d'un tiers
    const res = await app.inject({
      method: 'POST', url: `/attendance/me/warnings/${WARNING_ID}/respond`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: VALID_RESPONSE,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).not.toContain(OTHER_EMPLOYEE_ID)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('attendance_warnings'))
    expect(updateCall).toBeUndefined()
  })

  it('le propriétaire répond → 200, employee_response/responded_at renseignés, notifie les RH (notifyUser)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMPLOYEE_ID }] }) // lookup employé appelant
      .mockResolvedValueOnce({ rows: [{ id: WARNING_ID, employee_id: EMPLOYEE_ID, tier: 'demande_explication' }] }) // SELECT avertissement
      .mockResolvedValueOnce({ rows: [{ id: WARNING_ID, employee_response: VALID_RESPONSE.response, responded_at: '2026-07-16T10:00:00Z' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
      .mockResolvedValueOnce({ rows: [{ id: 'rh-user-1' }, { id: 'rh-user-2' }] }) // SELECT users RH
    const res = await app.inject({
      method: 'POST', url: `/attendance/me/warnings/${WARNING_ID}/respond`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: VALID_RESPONSE,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.employee_response).toBe(VALID_RESPONSE.response)
    expect(body.data.responded_at).toBeDefined()
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('attendance_warnings'))
    expect(updateCall).toBeDefined()
    expect(updateCall?.[1]).toEqual([VALID_RESPONSE.response, WARNING_ID])
    const notifCalls = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('.notifications'))
    expect(notifCalls).toHaveLength(2) // un par utilisateur RH
    expect(notifCalls[0]?.[1]).toContain('rh-user-1')
    expect(notifCalls[1]?.[1]).toContain('rh-user-2')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('attendance.warning.responded')
  })
})

describe('GET /attendance/dashboard — KPIs agrégés', () => {
  for (const role of ['employee', 'readonly']) {
    it(`refuse le rôle ${role} (403)`, async () => {
      const res = await app.inject({
        method: 'GET', url: '/attendance/dashboard',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/attendance/dashboard' })
    expect(res.statusCode).toBe(401)
  })

  it('from invalide → 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/attendance/dashboard?from=01-01-2026',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(400)
  })

  it('agrège les KPIs pour RH (une seule requête, aucun filtre manager_id)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ late_days: 5, absent_days: 2, active_warnings: 3, pending_explanations: 1, sanction_drafts: 1 }],
    })
    const res = await app.inject({
      method: 'GET', url: '/attendance/dashboard',
      headers: adminAuth(app),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      lateDays: 5, absentDays: 2, activeWarnings: 3, pendingExplanations: 1, sanctionDrafts: 1,
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(String(queryMock.mock.calls[0]?.[0])).not.toContain('manager_id')
  })

  it("manager SANS dossier employé associé → KPIs à zéro (fail-closed)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup employé manager → aucun
    const res = await app.inject({
      method: 'GET', url: '/attendance/dashboard',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      lateDays: 0, absentDays: 0, activeWarnings: 0, pendingExplanations: 0, sanctionDrafts: 0,
    })
  })

  it("manager AVEC dossier employé → filtre 'e.manager_id' dans les sous-requêtes", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: MANAGER_EMPLOYEE_ID }] }) // lookup employé manager
      .mockResolvedValueOnce({ rows: [{ late_days: 1, absent_days: 0, active_warnings: 0, pending_explanations: 0, sanction_drafts: 0 }] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/dashboard',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const kpiCall = queryMock.mock.calls.find((c) => String(c[0]).includes('sanction_drafts'))
    expect(kpiCall).toBeDefined()
    expect(String(kpiCall?.[0])).toContain('e.manager_id = $3')
    expect(kpiCall?.[1]).toContain(MANAGER_EMPLOYEE_ID)
  })
})
