import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, connectMock, clientQueryMock, releaseMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn().mockResolvedValue({ rows: [] })
  const releaseMock = vi.fn()
  return {
    queryMock: vi.fn(),
    clientQueryMock,
    releaseMock,
    connectMock: vi.fn().mockResolvedValue({ query: clientQueryMock, release: releaseMock }),
  }
})
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, connect: connectMock, end: vi.fn() })) }))

vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: 'NexusRH <no@reply>' },
  },
}))

vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../utils/crypto.js', () => ({
  decryptIfPresent: (v: string | null) => (v ? v.replace('enc:', '') : null),
  encryptIfPresent: (v: string | null) => (v ? `enc:${v}` : null),
}))

const { sendBankTransferEmailMock } = vi.hoisted(() => ({ sendBankTransferEmailMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/email.js', () => ({ sendBankTransferEmail: sendBankTransferEmailMock }))

import authPlugin from '../../plugins/auth.js'
import bankTransferRoutes from './bank-transfer.routes.js'
import { STARTER_PRESETS } from './bank-file.service.js'

const TENANT = 'tenant_sotra'
const TPL_ID = '11111111-1111-4111-8111-111111111111'
const CSV_SPEC = STARTER_PRESETS.find((p) => p.key === 'csv_delimite')!.spec
let app: FastifyInstance

function tokenFor(role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: TENANT, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}
const auth = (role: string) => ({ authorization: `Bearer ${tokenFor(role)}` })

/** Une ligne de paie telle que la renvoie fetchTransfers. */
const payRow = { first_name: 'Awa', last_name: 'Koné', employee_number: 'EMP-1', job_title: 'Agent', department: 'Finance', nni: 'enc:CI123', iban: 'enc:CI0710', bank_name: 'SGCI', net_payable: '300000', gross_salary: '420000' }

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(bankTransferRoutes, { prefix: '/bank-transfer' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  clientQueryMock.mockClear().mockResolvedValue({ rows: [] })
  connectMock.mockClear()
  releaseMock.mockClear()
  sendBankTransferEmailMock.mockClear()
})

describe('GET /bank-transfer/preview', () => {
  it('refuse un employee (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/preview?month=2025-01', headers: auth('employee') })
    expect(res.statusCode).toBe(403)
  })
  it('refuse un month invalide (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/preview?month=2025', headers: auth('hr_manager') })
    expect(res.statusCode).toBe(400)
  })
  it('renvoie les banques agrégées et le format actif (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', count: 3, total: '900000', email: 'paie@sgci.ci', template_version: 2, output_kind: 'fixed' }] })
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/preview?month=2025-01', headers: auth('admin') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data[0]).toMatchObject({ bank: 'SGCI', count: 3, total: 900000, email: 'paie@sgci.ci', templateVersion: 2, outputKind: 'fixed' })
  })
})

describe('GET /bank-transfer/file', () => {
  it('retombe sur le gabarit Excel historique quand la banque n\'a pas de profil actif', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [payRow] })            // fetchTransfers
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA' }] }) // tenant
      .mockResolvedValueOnce({ rows: [] })                  // bank_directory
      .mockResolvedValueOnce({ rows: [] })                  // profil actif : aucun
      .mockResolvedValueOnce({ rows: [] })                  // audit
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/file?month=2025-01&bank=SGCI', headers: auth('admin') })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('Virements_SGCI_2025-01.xlsx')
    expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('applique le profil actif du tenant quand il existe', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [payRow] })
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA' }] })
      .mockResolvedValueOnce({ rows: [{ email: null, ordering_account: 'enc:CI0080100000', ordering_label: 'SALAIRES' }] })
      .mockResolvedValueOnce({ rows: [{ id: TPL_ID, version: 3, spec: CSV_SPEC }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/file?month=2025-01&bank=SGCI', headers: auth('admin') })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('VIR_SGCI_2025-01.csv')
    const text = res.rawPayload.toString('utf8')
    expect(text.split('\r\n')[0]).toBe('COMPTE_BENEF;NOM_BENEF;MONTANT;LIBELLE')
    expect(text).toContain('CI0710;KONE AWA;300000;SALAIRE 2025-01')
  })

  it('refuse un employee (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/file?month=2025-01&bank=SGCI', headers: auth('employee') })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /bank-transfer/send', () => {
  it('refuse un body sans banques (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/send', headers: auth('admin'), payload: { month: '2025-01', banks: [] } })
    expect(res.statusCode).toBe(400)
  })
  it('refuse un email banque invalide (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/send', headers: auth('admin'), payload: { month: '2025-01', banks: [{ name: 'SGCI', email: 'pas-un-email' }] } })
    expect(res.statusCode).toBe(400)
  })
  it('génère, envoie l\'email (expéditeur tenant) et confirme (200)', async () => {
    queryMock
      // config email du tenant (AVANT la boucle)
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: '#E85D04', sender_email: 'paie@sotra.ci', sender_name: 'SOTRA Paie', smtp_host: null, smtp_port: null, smtp_secure: null, smtp_user: null, smtp_pass_enc: null }] })
      .mockResolvedValueOnce({ rows: [payRow] }) // fetchTransfers
      .mockResolvedValueOnce({ rows: [] })       // bank_directory
      .mockResolvedValueOnce({ rows: [] })       // profil actif : aucun
      .mockResolvedValueOnce({ rows: [] })       // upsert bank_directory
      .mockResolvedValueOnce({ rows: [] })       // audit
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/send', headers: auth('admin'), payload: { month: '2025-01', banks: [{ name: 'SGCI', email: 'paie@sgci.ci' }] } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.success).toBe(true)
    expect(body.results[0]).toMatchObject({ bank: 'SGCI', count: 1, total: 300000, sent: true, templateVersion: null })
    expect(sendBankTransferEmailMock).toHaveBeenCalledTimes(1)
    const arg = sendBankTransferEmailMock.mock.calls[0]![0]
    expect(arg.from).toBe('SOTRA Paie <paie@sotra.ci>')
    expect(arg.attachment.filename).toContain('.xlsx')
  })

  it('joint le fichier au format de la banque quand un profil est actif', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA', primary_color: null, sender_email: null, sender_name: null, smtp_host: null, smtp_port: null, smtp_secure: null, smtp_user: null, smtp_pass_enc: null }] })
      .mockResolvedValueOnce({ rows: [payRow] })
      .mockResolvedValueOnce({ rows: [{ email: null, ordering_account: null, ordering_label: null }] })
      .mockResolvedValueOnce({ rows: [{ id: TPL_ID, version: 4, spec: CSV_SPEC }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/send', headers: auth('admin'), payload: { month: '2025-01', banks: [{ name: 'SGCI', email: 'paie@sgci.ci' }] } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).results[0]).toMatchObject({ sent: true, templateVersion: 4 })
    expect(sendBankTransferEmailMock.mock.calls[0]![0].attachment.filename).toBe('VIR_SGCI_2025-01.csv')
  })
})

describe('PUT /bank-transfer/directory', () => {
  it('est réservé à l\'admin — un hr_manager est refusé (403)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/bank-transfer/directory', headers: auth('hr_manager'), payload: { bank: 'SGCI', email: 'a@b.ci' } })
    expect(res.statusCode).toBe(403)
  })

  it('chiffre le compte donneur d\'ordre et ne le renvoie que masqué', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // upsert
      .mockResolvedValueOnce({ rows: [] }) // audit (non bloquant, émis avant la relecture)
      .mockResolvedValueOnce({ rows: [{ email: 'paie@sgci.ci', ordering_account: 'enc:CI93CI00801000000001234', ordering_label: 'SALAIRES' }] })
    const res = await app.inject({ method: 'PUT', url: '/bank-transfer/directory', headers: auth('admin'), payload: { bank: 'SGCI', email: 'paie@sgci.ci', orderingAccount: 'CI93CI00801000000001234' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.orderingAccount).toBe('****1234')
    expect(res.body).not.toContain('CI93CI00801000000001234')
    // La valeur écrite en base est chiffrée
    expect(queryMock.mock.calls[0]![1]).toContain('enc:CI93CI00801000000001234')
  })

  it('refuse un champ inconnu (Zod strict)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/bank-transfer/directory', headers: auth('admin'), payload: { bank: 'SGCI', role: 'super_admin' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /bank-transfer/templates', () => {
  it('est réservé à l\'admin (paramétrage tenant)', async () => {
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/templates', headers: auth('hr_manager') })
    expect(res.statusCode).toBe(403)
  })

  it('renvoie les profils, l\'annuaire masqué et le référentiel de l\'éditeur', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: TPL_ID, bank_name: 'SGCI', version: 1, status: 'active', label: 'SGCI v1', output_kind: 'csv', sample_filename: 'modele.csv', created_at: null, updated_at: null, activated_at: null }] })
      .mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', email: 'paie@sgci.ci', ordering_account: 'enc:CI0080100000009999', ordering_label: 'SALAIRES' }] })
      .mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI' }] })
    const res = await app.inject({ method: 'GET', url: '/bank-transfer/templates', headers: auth('admin') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data[0]).toMatchObject({ bank: 'SGCI', version: 1, status: 'active', outputKind: 'csv' })
    expect(body.directory[0].orderingAccount).toBe('****9999')
    expect(body.referential.sources.length).toBeGreaterThan(10)
    expect(body.referential.presets.map((p: { key: string }) => p.key)).toContain('txt_fixe')
    // Les banques réellement portées par des fiches salariés : sans cette liste,
    // rien ne signale un profil rattaché à une banque que personne n'a.
    expect(body.employeeBanks).toEqual(['SGCI'])
  })
})

describe('POST /bank-transfer/templates', () => {
  it('crée une v1 en brouillon depuis un modèle de départ (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ n: '0' }] })
      .mockResolvedValueOnce({ rows: [{ id: TPL_ID, version: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/templates', headers: auth('admin'), payload: { bank: 'SGCI', presetKey: 'txt_fixe' } })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data).toMatchObject({ id: TPL_ID, bank: 'SGCI', version: 1, status: 'draft', issues: [] })
    // 42P08 vécu en prod : $1 servait de valeur insérée ET de terme de
    // comparaison, avec des types déduits différents. Le cast lève l'ambiguïté.
    // Les tests simulent pg et ne verraient pas l'erreur — d'où ce garde-fou.
    expect(String(queryMock.mock.calls[1]![0])).toContain('$1::varchar')
  })

  it('refuse un modèle de départ inconnu (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/templates', headers: auth('admin'), payload: { bank: 'SGCI', presetKey: 'inconnu' } })
    expect(res.statusCode).toBe(400)
  })

  it('refuse une source hors catalogue (400) — aucune expression n\'est évaluable', async () => {
    const spec = { ...CSV_SPEC, columns: [{ label: 'X', source: 'process.env.ENCRYPTION_KEY' }] }
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/templates', headers: auth('admin'), payload: { bank: 'SGCI', spec } })
    expect(res.statusCode).toBe(400)
  })

  it('refuse au-delà de la limite de versions par banque (400)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ n: '50' }] })
    const res = await app.inject({ method: 'POST', url: '/bank-transfer/templates', headers: auth('admin'), payload: { bank: 'SGCI', presetKey: 'csv_delimite' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('PUT /bank-transfer/templates/:id', () => {
  it('modifie un brouillon sur place', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'draft', version: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'PUT', url: `/bank-transfer/templates/${TPL_ID}`, headers: auth('admin'), payload: { spec: CSV_SPEC } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ version: 2, status: 'draft', createdNewVersion: false })
  })

  it('engendre une nouvelle version en brouillon si le profil est ACTIF', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'active', version: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: TPL_ID, version: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'PUT', url: `/bank-transfer/templates/${TPL_ID}`, headers: auth('admin'), payload: { spec: CSV_SPEC } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ version: 3, status: 'draft', createdNewVersion: true })
    expect(String(queryMock.mock.calls[1]![0])).toContain('$1::varchar')
  })

  it('refuse de modifier une version archivée (400)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'archived', version: 1 }] })
    const res = await app.inject({ method: 'PUT', url: `/bank-transfer/templates/${TPL_ID}`, headers: auth('admin'), payload: { spec: CSV_SPEC } })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un id qui n\'est pas un UUID (400)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/bank-transfer/templates/pas-un-uuid', headers: auth('admin'), payload: { spec: CSV_SPEC } })
    expect(res.statusCode).toBe(400)
  })

  // Le nom de la banque est saisi à la main à la création et décide seul à quels
  // salariés le format s'applique : une faute de frappe rendait le profil
  // définitivement inutilisable. Elle se corrige désormais sur un brouillon.
  it('corrige la banque d un brouillon et le renumérote sur la banque cible', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ bank_name: 'DISQUETTE EXEMPLE', status: 'draft', version: 1 }] })
      .mockResolvedValueOnce({ rows: [{ n: '2' }] })
      .mockResolvedValueOnce({ rows: [{ version: 3 }] })
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'PUT', url: `/bank-transfer/templates/${TPL_ID}`, headers: auth('admin'),
      payload: { bank: 'BNI', spec: CSV_SPEC },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ bank: 'BNI', version: 3, createdNewVersion: false })
    // Le numéro de version est unique PAR banque : sans renumérotation, l'index
    // unique rejetterait le déplacement. Et le paramètre sert de valeur ET de
    // comparaison — sans cast explicite, PostgreSQL répond 42P08.
    const sql = String(queryMock.mock.calls[2]![0])
    expect(sql).toContain('$5::varchar')
    expect(sql).toContain('max(t.version)')
  })

  it('refuse de changer la banque d un format ACTIF (400)', async () => {
    // Rebasculer un format actif d'une banque à une autre enverrait à la banque
    // cible un fichier bâti pour la structure d'une autre.
    queryMock.mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'active', version: 2 }] })
    const res = await app.inject({
      method: 'PUT', url: `/bank-transfer/templates/${TPL_ID}`, headers: auth('admin'),
      payload: { bank: 'BNI', spec: CSV_SPEC },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('brouillon')
  })

  it('laisse la banque inchangée quand elle n est pas fournie', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'draft', version: 2 }] })
      .mockResolvedValueOnce({ rows: [{ version: 2 }] })
      .mockResolvedValue({ rows: [] })
    const res = await app.inject({ method: 'PUT', url: `/bank-transfer/templates/${TPL_ID}`, headers: auth('admin'), payload: { spec: CSV_SPEC } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ bank: 'SGCI', version: 2 })
  })
})

describe('POST /bank-transfer/templates/:id/preview', () => {
  it('rend le profil sur la paie réelle, sans mise en cache', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', spec: CSV_SPEC, version: 1 }] })
      .mockResolvedValueOnce({ rows: [payRow] })            // fetchTransfers
      .mockResolvedValueOnce({ rows: [{ name: 'SOTRA' }] }) // tenant
      .mockResolvedValueOnce({ rows: [] })                  // bank_directory
      .mockResolvedValueOnce({ rows: [] })                  // audit
    const res = await app.inject({ method: 'POST', url: `/bank-transfer/templates/${TPL_ID}/preview`, headers: auth('admin'), payload: { month: '2025-01' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const d = JSON.parse(res.body).data
    expect(d.filename).toBe('VIR_SGCI_2025-01.csv')
    expect(d.issues).toEqual([])
    expect(d.table[0]).toEqual(['COMPTE_BENEF', 'NOM_BENEF', 'MONTANT', 'LIBELLE'])
    expect(d.table[1]).toEqual(['CI0710', 'KONE AWA', '300000', 'SALAIRE 2025-01'])
    expect(d.rowCount).toBe(1)
  })

  it('404 sur un profil inexistant', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: `/bank-transfer/templates/${TPL_ID}/preview`, headers: auth('admin'), payload: { month: '2025-01' } })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /bank-transfer/templates/:id/activate', () => {
  it('refuse d\'activer un profil au mapping incomplet (400)', async () => {
    const incomplet = { ...CSV_SPEC, columns: [{ label: 'REF', source: 'unmapped' }] }
    queryMock.mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'draft', version: 2, spec: incomplet }] })
    const res = await app.inject({ method: 'POST', url: `/bank-transfer/templates/${TPL_ID}/activate`, headers: auth('admin') })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).issues.some((i: string) => i.startsWith('columns.unmapped'))).toBe(true)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('archive l\'ancienne version et active la nouvelle, dans une transaction', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'draft', version: 2, spec: CSV_SPEC }] })
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: `/bank-transfer/templates/${TPL_ID}/activate`, headers: auth('admin') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ bank: 'SGCI', version: 2, status: 'active' })
    const statements = clientQueryMock.mock.calls.map((c) => String(c[0]))
    expect(statements[0]).toBe('BEGIN')
    expect(statements[1]).toContain("status = 'archived'")
    expect(statements[2]).toContain("status = 'active'")
    expect(statements[3]).toBe('COMMIT')
    expect(releaseMock).toHaveBeenCalled()
  })

  it('refuse d\'activer un profil déjà actif (400)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'active', version: 2, spec: CSV_SPEC }] })
    const res = await app.inject({ method: 'POST', url: `/bank-transfer/templates/${TPL_ID}/activate`, headers: auth('admin') })
    expect(res.statusCode).toBe(400)
  })

  it('annule la transaction si la bascule échoue (500)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ bank_name: 'SGCI', status: 'draft', version: 2, spec: CSV_SPEC }] })
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })                       // BEGIN
      .mockRejectedValueOnce(new Error('conflit unique'))        // archive
      .mockResolvedValueOnce({ rows: [] })                       // ROLLBACK
    const res = await app.inject({ method: 'POST', url: `/bank-transfer/templates/${TPL_ID}/activate`, headers: auth('admin') })
    expect(res.statusCode).toBe(500)
    expect(clientQueryMock.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK')
    expect(releaseMock).toHaveBeenCalled()
  })
})
