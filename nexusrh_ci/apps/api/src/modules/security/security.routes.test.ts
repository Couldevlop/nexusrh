import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
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
    // Clé de scellement des exports : sans elle, l'export se produit
    // quand même mais se déclare non scellé (cf. describe « Export »).
    audit: { signingKey: 'cle-de-scellement-de-test' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@nexusrhci/shared/crypto', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decryptIfPresent: (s: string | null | undefined) => (s ? s.replace(/^enc\(|\)$/g, '') : null),
}))
// Évite toute résolution DNS réelle (le vrai guard fait un lookup).
vi.mock('@nexusrhci/shared/ssrf-guard', () => ({
  assertSafeOutboundUrl: vi.fn(async (raw: string) => new URL(raw)),
  resolveSafeOutbound: vi.fn(async (raw: string) => ({
    url: new URL(raw),
    ip: '93.184.216.34',
    family: 4,
    dispatcher: { close: vi.fn().mockResolvedValue(undefined) },
  })),
  SsrfBlockedError: class extends Error {},
}))

import authPlugin from '../../plugins/auth.js'
import securityRoutes from './security.routes.js'
import { entryDigest } from '../../services/audit-integrity.service.js'

const SCHEMA = 'tenant_sotra'
function token(app: FastifyInstance, role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}

let app: FastifyInstance
const fetchMock = vi.fn()
beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock)
  app = Fastify()
  await app.register(authPlugin)
  await app.register(securityRoutes, { prefix: '/security' })
  await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllGlobals() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }); fetchMock.mockReset() })

describe('OWASP A01 — réservé admin du tenant', () => {
  it('hr_manager ne peut pas lire la config SSO (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/security/sso-config', headers: { authorization: `Bearer ${token(app, 'hr_manager')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('admin lit la config SSO (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/security/sso-config', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
  })
})

describe('OWASP A02 — secrets jamais renvoyés en clair', () => {
  it('GET /sso-config expose secretSet mais pas le secret', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, provider: 'oidc', client_id: 'cid', client_secret_enc: 'enc(shh)', domains: ['sotra.ci'], default_role: 'employee', group_mappings: [] }] })
    const res = await app.inject({ method: 'GET', url: '/security/sso-config', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    const body = JSON.parse(res.body) as { data: Record<string, unknown> }
    expect(body.data.secretSet).toBe(true)
    expect(body.data).not.toHaveProperty('client_secret_enc')
    expect(JSON.stringify(body.data)).not.toContain('shh')
    // Réponse en camelCase cohérente (sinon le front plantait sur la config par défaut)
    expect(body.data).toHaveProperty('defaultRole', 'employee')
    expect(body.data).toHaveProperty('clientId', 'cid')
    expect(body.data).toHaveProperty('groupMappings')
    expect(body.data).not.toHaveProperty('default_role')
    expect(body.data).not.toHaveProperty('group_mappings')
    expect(body.data).not.toHaveProperty('id') // pas de colonnes DB brutes exposées
  })
})

describe('OWASP A03 — validation bornée', () => {
  it('PUT /sso-config rejette un provider inconnu (400)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/security/sso-config',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { enabled: true, provider: 'telnet', defaultRole: 'employee' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('PUT /sso-config valide → upsert + audit (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) // upsert + audit
    const res = await app.inject({
      method: 'PUT', url: '/security/sso-config',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { enabled: true, provider: 'oidc', issuer: 'https://idp.example.com', clientId: 'cid', clientSecret: 'shh', domains: ['SOTRA.CI'], defaultRole: 'employee', jitProvisioning: true, groupMappings: [{ group: 'RH', role: 'hr_manager' }] },
    })
    expect(res.statusCode).toBe(200)
    const upsert = queryMock.mock.calls.find((c) => String(c[0]).includes('sso_config'))
    expect(upsert?.[1]).toContain('enc(shh)')        // secret chiffré
    expect(upsert?.[1]?.find((p: unknown) => Array.isArray(p) && (p as string[]).includes('sotra.ci'))).toBeTruthy() // domaine normalisé
  })
  it('PUT /siem-config rejette un format inconnu (400)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/security/siem-config',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { enabled: true, transport: 'webhook', format: 'xml' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('SIEM — test & forward (A10 SSRF + A09 audit)', () => {
  it('test sans collecteur configuré → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, endpoint: null }] })
    const res = await app.inject({ method: 'POST', url: '/security/siem-config/test', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })
  it('test envoie un événement signé et renvoie le statut HTTP', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, transport: 'webhook', endpoint: 'https://siem.example.com/in', format: 'json', secret_enc: 'enc(k)', categories: ['auth'] }] })
    fetchMock.mockResolvedValueOnce({ status: 202 })
    const res = await app.inject({ method: 'POST', url: '/security/siem-config/test', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ ok: true, status: 202 })
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string>; dispatcher?: unknown }
    expect(init.headers['X-NexusRH-Signature']).toMatch(/^sha256=/)
    // Anti DNS-rebinding : la connexion sortante est épinglée (dispatcher undici).
    expect(init.dispatcher).toBeDefined()
  })
  it('forward désactivé → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, enabled: false, endpoint: 'https://siem.example.com/in' }] })
    const res = await app.inject({ method: 'POST', url: '/security/siem/forward', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })
})

describe('Événements de sécurité (audit annoté)', () => {
  it('GET /events annote catégorie + indicateur de transmission SIEM', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ enabled: true, categories: ['auth'] }] }) // siem_config
      .mockResolvedValueOnce({ rows: [
        { id: 'e1', action: 'auth.login_failed', entity: 'user', user_id: 'u1', ip_address: '1.2.3.4', created_at: new Date('2024-12-01') },
        { id: 'e2', action: 'tenant.modules_updated', entity: 'tenant', user_id: 'u2', ip_address: null, created_at: new Date('2024-12-02') },
      ] })
    const res = await app.inject({ method: 'GET', url: '/security/events', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: Array<{ category: string; forwarded: boolean }> }
    expect(body.data[0]).toMatchObject({ category: 'auth', forwarded: true })
    expect(body.data[1]).toMatchObject({ category: 'config', forwarded: false })
  })
})

/**
 * Piste d'audit opposable — les trois gestes exposés par le module.
 *
 * Ce qui est vérifié ici n'est pas le calcul de la chaîne (c'est le rôle de
 * `services/audit-integrity.test.ts`) mais ce que les routes GARANTISSENT :
 * qui peut les appeler, ce qui est journalisé, et surtout qu'un tenant
 * provisionné avant le chaînage ne reçoive ni fausse alerte d'altération ni
 * erreur 500.
 */
/**
 * Les colonnes d'une entrée, hors empreinte.
 *
 * Type local et non `Omit<AuditRow, …>` : `AuditRow` étend
 * `Record<string, unknown>`, et `Omit` sur un type à index signature écrase ses
 * champs nommés — le type obtenu n'aurait plus garanti aucune colonne.
 */
interface LigneAudit {
  seq: string; id: string; user_id: string | null
  action: string; entity: string; entity_id: string | null
  changes: unknown; ip_address: string | null; user_agent: string | null
  created_at: string; prev_hash: string | null
}

describe("Piste d'audit — contrôle d'intégrité", () => {
  /** Construit n entrées correctement chaînées, comme le trigger les écrit. */
  function chainedRows(n: number) {
    const rows: Array<Record<string, unknown>> = []
    let prev: string | null = null
    for (let i = 1; i <= n; i++) {
      const base: LigneAudit = {
        seq: String(i), id: `aaaaaaa${i}-1111-1111-1111-111111111111`, user_id: 'u1',
        action: 'employee.updated', entity: 'employee', entity_id: null,
        changes: '{"a": 1}', ip_address: '41.207.1.2', user_agent: null,
        created_at: '2026-11-08T09:30:00.123456Z', prev_hash: prev,
      }
      const empreinte = entryDigest(base, prev)
      prev = empreinte
      rows.push({ ...base, entry_hash: empreinte })
    }
    return rows
  }

  it('reserve a l administrateur du tenant (A01)', async () => {
    for (const role of ['hr_manager', 'manager', 'employee']) {
      const res = await app.inject({ method: 'GET', url: '/security/audit/verify', headers: { authorization: `Bearer ${token(app, role)}` } })
      expect(res.statusCode, role).toBe(403)
    }
  })

  it('declare intacte une piste correctement chainee', async () => {
    queryMock.mockResolvedValueOnce({ rows: chainedRows(4) })
    const res = await app.inject({ method: 'GET', url: '/security/audit/verify', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ intact: true, checked: 4, brokenAt: null })
  })

  it('signale une entree retouchee, avec le rang de la rupture', async () => {
    const rows = chainedRows(4)
    rows[2]!.action = 'payroll.closed'
    queryMock.mockResolvedValueOnce({ rows })
    const res = await app.inject({ method: 'GET', url: '/security/audit/verify', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    const body = JSON.parse(res.body) as { data: { intact: boolean; brokenAt: { seq: string; reason: string } } }
    expect(body.data.intact).toBe(false)
    expect(body.data.brokenAt).toMatchObject({ seq: '3', reason: 'hash_mismatch' })
  })

  it('journalise le controle lui-meme (qui a verifie, et le verdict)', async () => {
    queryMock.mockResolvedValueOnce({ rows: chainedRows(2) })
    await app.inject({ method: 'GET', url: '/security/audit/verify', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    // L'écriture d'audit est « au mieux » et n'est pas attendue par le handler.
    await new Promise(r => setImmediate(r))
    const inserts = queryMock.mock.calls.filter(c => String(c[0]).includes('INSERT INTO'))
    expect(inserts.length).toBeGreaterThan(0)
    expect(JSON.stringify(inserts[0]?.[1])).toContain('audit.verified')
  })

  it('tenant provisionne AVANT le chainage : repond non chainee, pas 500', async () => {
    // Un faux positif ici serait le pire des résultats : il ferait croire à une
    // altération sur un tenant simplement plus ancien que la fonctionnalité.
    const err = Object.assign(new Error('column entry_hash does not exist'), { code: '42703' })
    queryMock.mockRejectedValueOnce(err)
    const res = await app.inject({ method: 'GET', url: '/security/audit/verify', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ intact: true, checked: 0, chained: false })
  })
})

describe("Piste d'audit — export probant", () => {
  it('reserve a l administrateur du tenant (A01)', async () => {
    const res = await app.inject({ method: 'GET', url: '/security/audit/export', headers: { authorization: `Bearer ${token(app, 'hr_manager')}` } })
    expect(res.statusCode).toBe(403)
  })

  it('rend le CSV, le manifeste et son sceau', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/security/audit/export', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { csv: string; manifest: { sealed: boolean; seal: string; sha256: string } } }
    expect(body.data.manifest.sealed).toBe(true)
    expect(body.data.manifest.seal).toMatch(/^[0-9a-f]{64}$/)
    expect(body.data.manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('en telechargement : fichier CSV, BOM, et manifeste en en-tetes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/security/audit/export?format=csv', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(String(res.headers['content-disposition'])).toContain('attachment; filename="audit-tenant_sotra-')
    // Sans BOM, Excel — l'outil du destinataire — abîme les accents.
    expect(res.body.startsWith('﻿')).toBe(true)
    // Le destinataire reçoit le fichier ET de quoi le vérifier.
    expect(String(res.headers['x-audit-sha256'])).toMatch(/^[0-9a-f]{64}$/)
    expect(res.headers['x-audit-seal']).not.toBe('none')
    expect(res.headers['x-audit-chain-intact']).toBe('true')
  })

  it('journalise l export : il sort des donnees nominatives', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await app.inject({ method: 'GET', url: '/security/audit/export', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    await new Promise(r => setImmediate(r))
    const inserts = queryMock.mock.calls.filter(c => String(c[0]).includes('INSERT INTO'))
    expect(JSON.stringify(inserts[0]?.[1])).toContain('audit.exported')
  })

  it('refuse une date mal formee au lieu de l ignorer en silence', async () => {
    const res = await app.inject({ method: 'GET', url: '/security/audit/export?from=01/2026', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })

  it('transmet la periode au SQL quand elle est valide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await app.inject({ method: 'GET', url: '/security/audit/export?from=2026-01-01&to=2026-06-30', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(queryMock.mock.calls[0]?.[1]).toEqual(['2026-01-01', '2026-06-30', 100_000])
  })

  it('piste non initialisee : 503 explicite, jamais un fichier vide trompeur', async () => {
    const err = Object.assign(new Error('relation does not exist'), { code: '42P01' })
    queryMock.mockRejectedValueOnce(err)
    const res = await app.inject({ method: 'GET', url: '/security/audit/export', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(503)
  })
})

describe("Piste d'audit — purge de retention", () => {
  it('reserve a l administrateur du tenant (A01)', async () => {
    const res = await app.inject({ method: 'POST', url: '/security/audit/purge', headers: { authorization: `Bearer ${token(app, 'hr_manager')}` } })
    expect(res.statusCode).toBe(403)
  })

  it('aucune duree definie, donc refus, et rien n est supprime', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ audit_retention_days: 0 }] })
    const res = await app.inject({ method: 'POST', url: '/security/audit/purge', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
    expect(queryMock.mock.calls.some(c => String(c[0]).includes('audit_log_purge'))).toBe(false)
  })

  it('applique la duree des reglages PLATEFORME, pas celle du corps de requete', async () => {
    // Un administrateur de tenant ne doit pas pouvoir raccourcir la
    // conservation à la demande pour faire disparaître une période gênante.
    queryMock
      .mockResolvedValueOnce({ rows: [{ audit_retention_days: 365 }] })
      .mockResolvedValueOnce({ rows: [{ purged: '12', boundary: '2025-11-08T00:00:00Z' }] })
    const res = await app.inject({
      method: 'POST', url: '/security/audit/purge',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { keepDays: 1 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ purged: 12, keepDays: 365 })
    const appel = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log_purge'))
    expect(appel?.[1]).toEqual([365])
  })

  it('reglages illisibles : traite comme sans limite, donc refus', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('no column'), { code: '42703' }))
    const res = await app.inject({ method: 'POST', url: '/security/audit/purge', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })

  it('piste non initialisee, donc 503', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ audit_retention_days: 90 }] })
      .mockRejectedValueOnce(Object.assign(new Error('no function'), { code: '42883' }))
    const res = await app.inject({ method: 'POST', url: '/security/audit/purge', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(503)
  })
})
