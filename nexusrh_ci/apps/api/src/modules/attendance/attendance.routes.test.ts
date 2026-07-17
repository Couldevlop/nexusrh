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
