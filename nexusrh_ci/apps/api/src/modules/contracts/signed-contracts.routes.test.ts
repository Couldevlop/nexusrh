/**
 * Contrat signé — dépôt RH/manager + « Mon contrat » (self-service).
 * Couvre : RBAC, IDOR (un employé ne lit que SES documents), option tenant
 * désactivée (403), validation d'upload (PDF / octets magiques / taille),
 * audit_log au dépôt et au téléchargement, notification de l'employé.
 *
 * Le mock pg ROUTE par texte SQL (et non par ordre d'appel) : l'ajout d'une
 * requête dans la route ne décale pas les réponses.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, emailMock } = vi.hoisted(() => ({ queryMock: vi.fn(), emailMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    appUrl: 'https://app.test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
    smtp: { from: 'noreply@test' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/antivirus.service.js', () => ({
  scanBuffer: vi.fn().mockResolvedValue({ clean: true }),
  scanRejectionMessage: vi.fn(() => 'Fichier infecté'),
}))
vi.mock('../../services/email.js', () => ({ sendSignedContractAvailableEmail: emailMock }))
vi.mock('../../services/tenant-mail.service.js', () => ({
  loadTenantMailBySchema: vi.fn().mockResolvedValue({ name: 'SOTRA', primaryColor: '#E85D04', from: undefined, smtp: null }),
}))

import authPlugin from '../../plugins/auth.js'
import signedContractsRoutes from './signed-contracts.routes.js'

const SCHEMA = 'tenant_sotra'
const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const MGR = '33333333-3333-4333-8333-333333333333'
const DOC = '44444444-4444-4444-8444-444444444444'
const CONTRACT = '55555555-5555-4555-8555-555555555555'
const PDF = Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\ntrailer\n%%EOF')

interface Db {
  employeeAccess: boolean
  managerUpload: boolean
  inScope: boolean
  employeeExists: boolean
  contractOwned: boolean
  /** Document renvoyé par le SELECT de téléchargement self-service (filtré par employee_id). */
  ownDocFor: string | null
}
let db: Db

function route(sql: string, params: unknown[] = []): { rows: unknown[] } {
  // Périmètre manager (manager-scope.service) — testé AVANT platform.tenants,
  // que le fragment SQL de périmètre interroge aussi (réglage direct|hierarchy).
  if (sql.includes('WITH RECURSIVE')) return { rows: db.inScope ? [{ id: OTHER }] : [] }
  if (sql.includes('FROM platform.tenants')) {
    return { rows: [{ employee_contract_access: db.employeeAccess, manager_contract_upload: db.managerUpload }] }
  }
  if (sql.includes('INSERT INTO "tenant_sotra".employee_documents')) {
    return { rows: [{ id: DOC, version: 2, created_at: '2026-10-29T10:00:00Z' }] }
  }
  if (sql.includes('SELECT id, mime, bytes, file_name FROM')) {
    // Le WHERE porte employee_id = $2 : on ne renvoie le document que si
    // l'appelant en est le titulaire (reproduit le filtre SQL).
    return { rows: params[1] === db.ownDocFor ? [{ id: DOC, mime: 'application/pdf', bytes: PDF, file_name: 'contrat.pdf' }] : [] }
  }
  if (sql.includes('SELECT id, employee_id, mime, bytes, file_name')) {
    return { rows: [{ id: DOC, employee_id: OTHER, mime: 'application/pdf', bytes: PDF, file_name: 'contrat.pdf' }] }
  }
  if (sql.includes('FROM "tenant_sotra".employee_documents d')) {
    return {
      rows: [{
        id: DOC, contract_id: CONTRACT, title: 'CDI', file_name: 'contrat.pdf', size_bytes: PDF.length,
        version: 1, is_current: true, created_at: '2026-10-01', contract_type: 'cdi', contract_start_date: '2026-01-01',
      }],
    }
  }
  if (sql.includes('signature_requests')) {
    return { rows: [{ id: 'sig-1', title: 'CDI signé', document_type: 'contract', document_id: CONTRACT, completed_at: '2026-10-02' }] }
  }
  if (sql.includes('FROM "tenant_sotra".employees e') && sql.includes('deleted_at IS NULL')) {
    return { rows: db.employeeExists ? [{ id: OTHER, first_name: 'Awa', email: 'awa@sotra.ci', user_id: 'user-awa' }] : [] }
  }
  if (sql.includes('FROM "tenant_sotra".contracts WHERE id = $1 AND employee_id = $2')) {
    return { rows: db.contractOwned ? [{ id: CONTRACT }] : [] }
  }
  return { rows: [] }
}

function token(app: FastifyInstance, role: string, employeeId: string | null) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId })
}
const auth = (app: FastifyInstance, role: string, employeeId: string | null = null) => ({ authorization: `Bearer ${token(app, role, employeeId)}` })

function multipart(filename: string, mime: string, content: Buffer) {
  const boundary = '----nexusrhTestBoundary'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

function upload(app: FastifyInstance, headers: Record<string, string>, opts: { filename?: string; mime?: string; content?: Buffer; query?: string } = {}) {
  const body = multipart(opts.filename ?? 'contrat.pdf', opts.mime ?? 'application/pdf', opts.content ?? PDF)
  return app.inject({
    method: 'POST',
    url: `/contracts/signed/employee/${OTHER}${opts.query ?? ''}`,
    headers: { ...headers, 'content-type': body.contentType },
    payload: body.payload,
  })
}

const sqlCalls = () => queryMock.mock.calls.map((c) => String(c[0]))
const auditActions = () => queryMock.mock.calls
  .filter((c) => String(c[0]).includes('audit_log'))
  .map((c) => (c[1] as unknown[]).find((v) => typeof v === 'string' && v.startsWith('contract.')))

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 10 * 1024 * 1024 } })
  await app.register(signedContractsRoutes, { prefix: '/contracts/signed' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  db = { employeeAccess: true, managerUpload: false, inScope: true, employeeExists: true, contractOwned: true, ownDocFor: ME }
  queryMock.mockReset()
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => route(sql, params ?? []))
  emailMock.mockReset().mockResolvedValue(undefined)
})

describe('Options tenant', () => {
  it('GET /settings renvoie les deux options à tout rôle authentifié', async () => {
    db.managerUpload = true
    const res = await app.inject({ method: 'GET', url: '/contracts/signed/settings', headers: auth(app, 'employee', ME) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual({ employeeContractAccess: true, managerContractUpload: true })
  })
  it('sans authentification → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/contracts/signed/settings' })
    expect(res.statusCode).toBe(401)
  })
})

describe('Self-service « Mon contrat »', () => {
  it('option désactivée → 403 featureDisabled sur la liste ET le téléchargement', async () => {
    db.employeeAccess = false
    const list = await app.inject({ method: 'GET', url: '/contracts/signed/me', headers: auth(app, 'employee', ME) })
    expect(list.statusCode).toBe(403)
    expect(JSON.parse(list.body).featureDisabled).toBe(true)
    const file = await app.inject({ method: 'GET', url: `/contracts/signed/me/${DOC}/file`, headers: auth(app, 'employee', ME) })
    expect(file.statusCode).toBe(403)
    expect(sqlCalls().some((s) => s.includes('employee_documents'))).toBe(false)
  })

  it('liste : dépôts filtrés par la fiche du JWT + signature électronique rattachée au contrat', async () => {
    const res = await app.inject({ method: 'GET', url: '/contracts/signed/me', headers: auth(app, 'employee', ME) })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data as Array<{ id: string; signedElectronicallyAt: string | null; fileDocumentId: string | null }>
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ id: DOC, fileDocumentId: DOC, signedElectronicallyAt: '2026-10-02' })
    const listCall = queryMock.mock.calls.find((c) => String(c[0]).includes('employee_documents d'))
    expect(listCall?.[1]).toEqual([ME, 'signed_contract'])
  })

  it('le paramètre employeeId de la requête est ignoré (aucune liste d\'autrui)', async () => {
    await app.inject({ method: 'GET', url: `/contracts/signed/me?employeeId=${OTHER}`, headers: auth(app, 'employee', ME) })
    const listCall = queryMock.mock.calls.find((c) => String(c[0]).includes('employee_documents d'))
    expect(listCall?.[1]?.[0]).toBe(ME)
  })

  it('sans fiche employé rattachée → liste vide', async () => {
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('u.employee_id IS NOT NULL')) return { rows: [{ id: null }] } // actorEmployeeSql
      return route(sql, params ?? [])
    })
    const res = await app.inject({ method: 'GET', url: '/contracts/signed/me', headers: auth(app, 'employee', null) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })

  it('téléchargement de SON document → 200 PDF no-store + audit', async () => {
    const res = await app.inject({ method: 'GET', url: `/contracts/signed/me/${DOC}/file`, headers: auth(app, 'employee', ME) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(String(res.headers['cache-control'])).toContain('no-store')
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect(auditActions()).toContain('contract.signed_document_downloaded')
  })

  it('IDOR : le document d\'un collègue → 404 (pas d\'oracle d\'existence), sans audit de téléchargement', async () => {
    db.ownDocFor = OTHER
    const res = await app.inject({ method: 'GET', url: `/contracts/signed/me/${DOC}/file`, headers: auth(app, 'employee', ME) })
    expect(res.statusCode).toBe(404)
    const call = queryMock.mock.calls.find((c) => String(c[0]).includes('SELECT id, mime, bytes, file_name'))
    expect(String(call?.[0])).toContain('employee_id = $2')
    expect(call?.[1]?.[1]).toBe(ME)
    expect(auditActions()).not.toContain('contract.signed_document_downloaded')
  })

  it('identifiant non UUID → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/contracts/signed/me/abc/file', headers: auth(app, 'employee', ME) })
    expect(res.statusCode).toBe(400)
  })
})

describe('RBAC côté RH', () => {
  it('un employé ne peut ni lister la fiche d\'un autre, ni télécharger côté RH, ni déposer', async () => {
    const list = await app.inject({ method: 'GET', url: `/contracts/signed/employee/${OTHER}`, headers: auth(app, 'employee', ME) })
    expect(list.statusCode).toBe(403)
    const file = await app.inject({ method: 'GET', url: `/contracts/signed/documents/${DOC}/file`, headers: auth(app, 'employee', ME) })
    expect(file.statusCode).toBe(403)
    const up = await upload(app, auth(app, 'employee', ME))
    expect(up.statusCode).toBe(403)
  })
  it('readonly lit mais ne dépose pas', async () => {
    const list = await app.inject({ method: 'GET', url: `/contracts/signed/employee/${OTHER}`, headers: auth(app, 'readonly') })
    expect(list.statusCode).toBe(200)
    const up = await upload(app, auth(app, 'readonly'))
    expect(up.statusCode).toBe(403)
  })
  it('hr_officer télécharge côté RH → 200 + audit (self=false)', async () => {
    const res = await app.inject({ method: 'GET', url: `/contracts/signed/documents/${DOC}/file?download=1`, headers: auth(app, 'hr_officer') })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-disposition'])).toContain('attachment')
    expect(auditActions()).toContain('contract.signed_document_downloaded')
  })
  it('le manager n\'a jamais accès au téléchargement côté RH', async () => {
    db.managerUpload = true
    const res = await app.inject({ method: 'GET', url: `/contracts/signed/documents/${DOC}/file`, headers: auth(app, 'manager', MGR) })
    expect(res.statusCode).toBe(403)
  })
})

describe('Dépôt du contrat signé', () => {
  it('hr_manager dépose un PDF → 201, nouvelle version, historique conservé, contrat marqué signé, audit + notification + email', async () => {
    const res = await upload(app, auth(app, 'hr_manager'), { query: `?contractId=${CONTRACT}&title=CDI%202026` })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data).toMatchObject({ id: DOC, version: 2, contractId: CONTRACT, notified: true })
    const sqls = sqlCalls()
    expect(sqls.some((s) => s.includes('SET is_current = false, replaced_by = $1'))).toBe(true)
    expect(sqls.some((s) => s.includes("SET signature_status = 'signed'"))).toBe(true)
    expect(sqls.some((s) => s.includes('DELETE'))).toBe(false)
    expect(auditActions()).toContain('contract.signed_document_uploaded')
    const notif = queryMock.mock.calls.find((c) => String(c[0]).includes('notifications'))
    expect(notif?.[1]?.[0]).toBe('user-awa')
    await vi.waitFor(() => expect(emailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'awa@sotra.ci', actionUrl: 'https://app.test/mon-espace/contrat',
    })))
  })

  it('option employé désactivée : le dépôt RH reste possible mais sans notification ni email', async () => {
    db.employeeAccess = false
    const res = await upload(app, auth(app, 'admin'))
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.notified).toBe(false)
    expect(sqlCalls().some((s) => s.includes('notifications'))).toBe(false)
    expect(emailMock).not.toHaveBeenCalled()
  })

  it('refuse un fichier non PDF (MIME)', async () => {
    const res = await upload(app, auth(app, 'admin'), { filename: 'contrat.png', mime: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]) })
    expect(res.statusCode).toBe(400)
    expect(sqlCalls().some((s) => s.includes('INSERT INTO "tenant_sotra".employee_documents'))).toBe(false)
  })

  it('refuse un faux PDF (octets magiques incohérents)', async () => {
    const res = await upload(app, auth(app, 'admin'), { content: Buffer.from('MZ\x90\x00 exécutable renommé') })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/PDF valide/)
  })

  it('refuse un PDF de plus de 10 Mo (413)', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 10, 0x20)])
    const res = await upload(app, auth(app, 'admin'), { content: big })
    expect(res.statusCode).toBe(413)
  })

  it('refuse une requête sans multipart (400)', async () => {
    const res = await app.inject({ method: 'POST', url: `/contracts/signed/employee/${OTHER}`, headers: auth(app, 'admin'), payload: { a: 1 } })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un contrat qui n\'appartient pas à l\'employé (400)', async () => {
    db.contractOwned = false
    const res = await upload(app, auth(app, 'admin'), { query: `?contractId=${CONTRACT}` })
    expect(res.statusCode).toBe(400)
  })

  it('employé inexistant ou archivé (autre tenant inclus) → 404', async () => {
    db.employeeExists = false
    const res = await upload(app, auth(app, 'admin'))
    expect(res.statusCode).toBe(404)
  })

  it('paramètre de requête inconnu ou contractId non UUID → 400', async () => {
    const res = await upload(app, auth(app, 'admin'), { query: '?contractId=1;DROP' })
    expect(res.statusCode).toBe(400)
  })
})

describe('Dépôt par le manager (option distincte + périmètre)', () => {
  it('option manager désactivée (défaut) → 403', async () => {
    const res = await upload(app, auth(app, 'manager', MGR))
    expect(res.statusCode).toBe(403)
    expect(sqlCalls().some((s) => s.includes('INSERT INTO "tenant_sotra".employee_documents'))).toBe(false)
  })
  it('option active mais employé hors de son équipe → 403', async () => {
    db.managerUpload = true
    db.inScope = false
    const res = await upload(app, auth(app, 'manager', MGR))
    expect(res.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: `/contracts/signed/employee/${OTHER}`, headers: auth(app, 'manager', MGR) })
    expect(list.statusCode).toBe(403)
  })
  it('option active et employé de son équipe → 201', async () => {
    db.managerUpload = true
    const res = await upload(app, auth(app, 'manager', MGR))
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO "tenant_sotra".employee_documents'))
    expect(insert?.[1]).toContain('manager')
  })
})
