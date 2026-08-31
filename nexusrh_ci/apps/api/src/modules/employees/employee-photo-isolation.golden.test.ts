/**
 * Golden — A08-2 : les photos de profil (PII) sont TENANT-SCOPÉES.
 *
 * Risque couvert : les photos étaient stockées dans `platform.brand_assets`
 * (table GLOBALE cross-tenant prévue pour les logos publics) et servies par
 * `GET /public/brand/:id` SANS auth, SANS ownership, SANS scoping tenant →
 * toute fuite d'URL (Referer, historique, capture, log) donnait un accès
 * permanent, non révocable et inter-tenant à la photo d'un salarié.
 *
 * Invariants prouvés ici :
 *  1. l'upload n'écrit JAMAIS dans platform.brand_assets (mais dans
 *     "<schema>".employee_photos) ;
 *  2. le service de la photo exige une authentification (401 sans token) ;
 *  3. le schéma interrogé vient TOUJOURS du JWT (jamais du body/query/params)
 *     → un token du tenant B ne peut pas lire le schéma du tenant A ;
 *  4. RBAC : un `employee` ne voit/modifie que SA photo ;
 *  5. A08-6 : un ré-upload REMPLACE l'ancienne ligne (pas d'accumulation).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    apiUrl: 'http://localhost:4001',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))

// PIÈGE CONNU : le hook ensureTenantSchema tape la vraie base → toujours mocker.
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@nexusrhci/shared/crypto', () => ({
  encryptIfPresent: vi.fn((v) => v),
  decryptIfPresent: vi.fn((v) => v),
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

const SCHEMA_A = 'tenant_sotra'
const SCHEMA_B = 'tenant_cabinet'
const EMP_A = '11111111-1111-4111-8111-111111111111'
const EMP_OTHER = '22222222-2222-4222-8222-222222222222'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

let app: FastifyInstance

function tokenFor(role: string, opts: Partial<{
  schemaName: string; email: string; employeeId: string | null
}> = {}) {
  return app.jwt.sign({
    sub: 'u-' + role,
    tenantId: 't1',
    schemaName: opts.schemaName ?? SCHEMA_A,
    role,
    email: opts.email ?? `${role}@sotra.ci`,
    firstName: 'Test',
    lastName: 'User',
    employeeId: opts.employeeId ?? null,
  })
}

/** Corps multipart minimal (une seule part fichier). */
function multipart(filename: string, mime: string, body: Buffer) {
  const b = '----nexusrhtest'
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${b}--\r\n`)
  return { payload: Buffer.concat([head, body, tail]), boundary: b }
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(import('@fastify/multipart'))
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

/** Toutes les requêtes SQL émises, concaténées. */
const allSql = () => queryMock.mock.calls.map((c) => String(c[0])).join('\n---\n')

describe('A08-2 — upload photo : stockage TENANT-SCOPÉ (pas le bucket public des logos)', () => {
  it("n'écrit JAMAIS dans platform.brand_assets et cible le schéma du JWT", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: EMP_A }], rowCount: 1 })
    const { payload, boundary } = multipart('moi.png', 'image/png', PNG)

    const res = await app.inject({
      method: 'POST',
      url: `/employees/${EMP_A}/photo`,
      headers: {
        authorization: `Bearer ${tokenFor('hr_manager')}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })

    expect(res.statusCode).toBe(201)
    const sql = allSql()
    expect(sql).not.toMatch(/platform\.brand_assets/)
    expect(sql).toMatch(new RegExp(`"${SCHEMA_A}"\\.employee_photos`))
    // L'URL rendue n'est plus une URL publique non révocable.
    expect(JSON.stringify(res.json())).not.toMatch(/public\/brand/)
  })

  it('A08-6 — un ré-upload REMPLACE la ligne précédente (pas d’accumulation)', async () => {
    // Une seule photo par employé : l’écriture est un UPSERT sur employee_id
    // (contrainte d’unicité), l’ancienne image est donc écrasée, jamais empilée.
    queryMock.mockResolvedValue({ rows: [{ id: EMP_A }], rowCount: 1 })
    const { payload, boundary } = multipart('moi.png', 'image/png', PNG)

    await app.inject({
      method: 'POST',
      url: `/employees/${EMP_A}/photo`,
      headers: {
        authorization: `Bearer ${tokenFor('hr_manager')}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })

    const sql = allSql()
    expect(sql).toMatch(/ON CONFLICT \(employee_id\) DO UPDATE/i)
  })

  it("un employee ne peut pas uploader la photo d'un autre (403)", async () => {
    const { payload, boundary } = multipart('moi.png', 'image/png', PNG)
    const res = await app.inject({
      method: 'POST',
      url: `/employees/${EMP_OTHER}/photo`,
      headers: {
        authorization: `Bearer ${tokenFor('employee', { employeeId: EMP_A })}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('A08-2 — service de la photo : endpoint AUTHENTIFIÉ tenant-scopé', () => {
  it('refuse une requête SANS authentification (401) — plus de lecture anonyme', async () => {
    const res = await app.inject({ method: 'GET', url: `/employees/${EMP_A}/photo` })
    expect(res.statusCode).toBe(401)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('lit UNIQUEMENT le schéma porté par le JWT (isolation cross-tenant)', async () => {
    queryMock.mockResolvedValue({
      rows: [{ mime: 'image/png', bytes: PNG, email: 'hr_manager@sotra.ci' }], rowCount: 1,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/employees/${EMP_A}/photo`,
      headers: { authorization: `Bearer ${tokenFor('hr_manager', { schemaName: SCHEMA_B })}` },
    })
    expect(res.statusCode).toBe(200)
    const sql = allSql()
    expect(sql).toMatch(new RegExp(`"${SCHEMA_B}"\\.employee_photos`))
    expect(sql).not.toMatch(new RegExp(`"${SCHEMA_A}"\\.`))
    expect(sql).not.toMatch(/platform\.brand_assets/)
  })

  it('sert l’image avec Content-Type d’origine, nosniff et Cache-Control privé', async () => {
    queryMock.mockResolvedValue({
      rows: [{ mime: 'image/png', bytes: PNG, email: 'hr_manager@sotra.ci' }], rowCount: 1,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/employees/${EMP_A}/photo`,
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(String(res.headers['cache-control'])).toMatch(/no-store/)
    expect(String(res.headers['cache-control'])).not.toMatch(/public/)
  })

  it('404 si la photo n’existe pas dans CE tenant', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    const res = await app.inject({
      method: 'GET',
      url: `/employees/${EMP_A}/photo`,
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('400 sur un id non-UUID (pas d’injection dans la requête)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/employees/not-a-uuid/photo',
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
    })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('RBAC — un employee accède à SA photo', async () => {
    queryMock.mockResolvedValue({
      rows: [{ mime: 'image/png', bytes: PNG, email: 'employe@sotra.ci' }], rowCount: 1,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/employees/${EMP_A}/photo`,
      headers: {
        authorization: `Bearer ${tokenFor('employee', {
          employeeId: EMP_A, email: 'employe@sotra.ci',
        })}`,
      },
    })
    expect(res.statusCode).toBe(200)
  })

  it("RBAC — un employee n'accède PAS à la photo d'un collègue (403)", async () => {
    queryMock.mockResolvedValue({
      rows: [{ mime: 'image/png', bytes: PNG, email: 'autre@sotra.ci' }], rowCount: 1,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/employees/${EMP_OTHER}/photo`,
      headers: {
        authorization: `Bearer ${tokenFor('employee', {
          employeeId: EMP_A, email: 'employe@sotra.ci',
        })}`,
      },
    })
    expect(res.statusCode).toBe(403)
  })
})
