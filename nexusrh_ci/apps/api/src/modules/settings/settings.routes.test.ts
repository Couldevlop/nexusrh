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

vi.mock('../../db/provisioning.js', () => ({
  provisionTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: vi.fn().mockResolvedValue({ sent: true }),
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

beforeEach(() => { queryMock.mockReset() })

describe('PATCH /settings/tenant — Zod + audit (OWASP A03 + A09)', () => {
  it('refuse champs inconnus (.strict)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'OK', isAdmin: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse primary_color au format libre (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { primary_color: 'red' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse at_rate hors plage CNPS CI (0.02-0.05) — 400', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { at_rate: 0.5 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un hr_manager NE PEUT PAS modifier le tenant (403)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Hack' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('admin modifie + trace audit settings.tenant_updated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 't1', name: 'Sotra v2', at_rate: '0.03' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/tenant',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Sotra v2', at_rate: 0.03, primary_color: '#E85D04' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.tenant_updated')
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.modifiedFields).toEqual(expect.arrayContaining(['name', 'at_rate', 'primary_color']))
  })
})

describe('POST /settings/legal-entities — Zod + audit + bornes AT (OWASP A03 + A04 + A09)', () => {
  it('refuse name vide (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse at_rate hors plage 0.02-0.05 (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Filiale Plateau', at_rate: 0.1 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse legal_form hors énum (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'F', legal_form: 'INC' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('création OK + audit settings.legal_entity_created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'le-1', name: 'Filiale Cocody', at_rate: '0.03' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE platform.tenants (active has_subsidiaries)
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Filiale Cocody', at_rate: 0.03, cnps_number: 'CI-123-X' },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.legal_entity_created')
  })

  it('accepte legal_form « SASU » + at_rate en chaîne (régression mismatch front↔back)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'le-2', name: 'Filiale SASU', at_rate: '0.03' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/legal-entities',
      headers: { authorization: `Bearer ${token}` },
      // legal_form proposé par l'UI + at_rate envoyé en chaîne (coerce)
      payload: { name: 'Filiale SASU', legal_form: 'SASU', at_rate: '0.03' },
    })
    expect(res.statusCode).toBe(201)
  })
})

describe('PATCH /settings/legal-entities/:id — UUID + audit', () => {
  it('refuse id non-UUID (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/settings/legal-entities/not-uuid',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('update OK + audit settings.legal_entity_updated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, at_rate: '0.04' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: `/settings/legal-entities/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { at_rate: 0.04 },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.legal_entity_updated')
  })
})

describe('POST /settings/payroll-rules — Zod + audit (taux cotisation critique)', () => {
  it('refuse type hors énum (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/payroll-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '9999', name: 'Bonus', type: 'magic' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('création OK + audit settings.payroll_rule_created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'rule-1', code: '4500', name: 'CNPS RB' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/payroll-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '4500', name: 'CNPS Retraite Bonifié', type: 'employee_contribution', rate: 0.065 },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.payroll_rule_created')
  })
})

describe('POST /settings/import/:type — cap CSV + whitelist + audit (OWASP A03 + A04 + A09)', () => {
  it('refuse type hors whitelist (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { headers: ['email'], rows: [['a@b.ci']] },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Type d\'import invalide')
  })

  it('refuse > 10 000 lignes (413)', async () => {
    const token = tokenFor(app, 'admin')
    const tooManyRows = Array.from({ length: 10_001 }, (_, i) => [`emp${i}@sotra.ci`])
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees',
      headers: { authorization: `Bearer ${token}` },
      payload: { headers: ['email'], rows: tooManyRows },
    })
    expect(res.statusCode).toBe(413)
  })

  it('refuse > 50 colonnes (413)', async () => {
    const token = tokenFor(app, 'admin')
    const tooManyHeaders = Array.from({ length: 51 }, (_, i) => `col${i}`)
    const res = await app.inject({
      method: 'POST', url: '/settings/import/employees',
      headers: { authorization: `Bearer ${token}` },
      payload: { headers: tooManyHeaders, rows: [['x']] },
    })
    expect(res.statusCode).toBe(413)
  })

  it('import departments OK + audit settings.import_completed', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing department
      .mockResolvedValueOnce({ rows: [] }) // INSERT department
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/departments',
      headers: { authorization: `Bearer ${token}` },
      payload: { headers: ['nom', 'code'], rows: [['Logistique', 'LOG']] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.inserted).toBe(1)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('settings.import_completed')
  })

  it('import departments avec responsable_email → lookup manager_id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                       // SELECT existing department
      .mockResolvedValueOnce({ rows: [{ id: 'usr-mgr-1' }] })    // SELECT users by email
      .mockResolvedValueOnce({ rows: [] })                       // INSERT department
      .mockResolvedValueOnce({ rows: [] })                       // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/departments',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['nom', 'code', 'responsable_email'],
        rows: [['Logistique', 'LOG', 'manager@sotra.ci']],
      },
    })
    expect(res.statusCode).toBe(200)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('departments'))
    expect(insertCall?.[1]?.[2]).toBe('usr-mgr-1')  // manager_id résolu
  })
})

describe('POST /settings/import/:type — nouveaux types (whitelist élargie)', () => {
  it('accepte type pay-slips (auparavant rejeté par whitelist)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })   // SELECT employees
      .mockResolvedValueOnce({ rows: [] })                   // SELECT existing pay_slip
      .mockResolvedValueOnce({ rows: [{ id: 'per-1' }] })   // SELECT pay_periods
      .mockResolvedValueOnce({ rows: [] })                   // INSERT pay_slips
      .mockResolvedValueOnce({ rows: [] })                   // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/pay-slips',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'periode', 'salaire_brut', 'cotis_cnps_sal', 'its', 'net_paye', 'cout_employeur'],
        rows: [['a@b.ci', '2024-06', '300000', '18900', '500', '280600', '342000']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).inserted).toBe(1)
  })

  it('accepte type mobile-money + valide opérateur whitelist', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })   // SELECT employees
      .mockResolvedValueOnce({ rows: [] })                   // UPDATE employees mobile_money
      .mockResolvedValueOnce({ rows: [] })                   // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/mobile-money',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'operateur', 'numero_telephone'],
        rows: [['a@b.ci', 'wave', '+225 07 12 34 56']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).inserted).toBe(1)
  })

  it('mobile-money refuse opérateur hors whitelist', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })   // SELECT employees
      .mockResolvedValueOnce({ rows: [] })                   // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/mobile-money',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'operateur', 'numero_telephone'],
        rows: [['a@b.ci', 'bitcoin', '+225 07 12 34 56']],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.inserted).toBe(0)
    expect(body.errors[0]).toContain('bitcoin')
  })

  it('import contracts OK (handler nouveau)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })   // SELECT employees
      .mockResolvedValueOnce({ rows: [] })                   // INSERT contracts
      .mockResolvedValueOnce({ rows: [] })                   // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'type_contrat', 'date_debut', 'date_fin', 'salaire_base', 'periode_essai_jours', 'convention_collective', 'lieu_travail'],
        rows: [['a@b.ci', 'cdi', '2024-01-15', '', '450000', '60', 'Transport CI', 'Abidjan Plateau']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).inserted).toBe(1)
  })

  it('contracts refuse type hors whitelist (OWASP A03)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })
      .mockResolvedValueOnce({ rows: [] })

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'type_contrat', 'date_debut', 'salaire_base'],
        rows: [['a@b.ci', 'esclavage', '2024-01-15', '450000']],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.inserted).toBe(0)
    expect(body.errors[0]).toContain('esclavage')
  })

  it('contracts refuse salaire hors borne (OWASP A04)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })
      .mockResolvedValueOnce({ rows: [] })

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'type_contrat', 'date_debut', 'salaire_base'],
        rows: [['a@b.ci', 'cdi', '2024-01-15', '999999999']],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.inserted).toBe(0)
    expect(body.errors[0]).toContain('hors borne')
  })

  it('import expenses OK (handler nouveau)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })   // SELECT employees
      .mockResolvedValueOnce({ rows: [] })                   // INSERT expense_reports
      .mockResolvedValueOnce({ rows: [] })                   // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'titre', 'mois', 'montant_total', 'statut'],
        rows: [['a@b.ci', 'Mission Yamoussoukro', '2024-06', '25000', 'approved']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).inserted).toBe(1)
  })

  it('expenses refuse mois mal formé (anti SQL injection)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })   // SELECT employees
      .mockResolvedValueOnce({ rows: [] })                   // audit_log (auditLogSettings)

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'titre', 'mois', 'montant_total', 'statut'],
        rows: [['a@b.ci', 'X', '06/2024', '25000', 'approved']],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.inserted).toBe(0)
    expect(body.errors[0]).toContain('06/2024')
  })

  it('expenses refuse statut hors énum (OWASP A03)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })   // SELECT employees
      .mockResolvedValueOnce({ rows: [] })                   // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/settings/import/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        headers: ['email_employe', 'titre', 'mois', 'montant_total', 'statut'],
        rows: [['a@b.ci', 'X', '2024-06', '25000', 'magic_status']],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).errors[0]).toContain('magic_status')
  })

  it('refuse encore les types non whitelistés (defense in depth)', async () => {
    const token = tokenFor(app, 'admin')
    for (const badType of ['users', 'tokens', 'audit_log', 'platform_users']) {
      const res = await app.inject({
        method: 'POST', url: `/settings/import/${badType}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { headers: ['x'], rows: [['y']] },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('Type d\'import invalide')
    }
  })
})

describe('GET/PUT /settings/email — SMTP tenant (option C)', () => {
  it('GET refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/settings/email',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('GET renvoie la config SMTP sans le mot de passe (hasPassword masqué)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      sender_email: 'rh@sotra.ci', sender_name: 'RH SOTRA',
      smtp_host: 'smtp.sotra.ci', smtp_port: 587, smtp_secure: false,
      smtp_user: 'rh@sotra.ci', smtp_pass_enc: 'iv:tag:cipher',
    }] })
    const res = await app.inject({
      method: 'GET', url: '/settings/email',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: Record<string, unknown> }
    expect(body.data.smtpHost).toBe('smtp.sotra.ci')
    expect(body.data.hasPassword).toBe(true)
    expect(body.data.smtpConfigured).toBe(true)
    // le secret chiffré ne doit JAMAIS sortir
    expect(JSON.stringify(body.data)).not.toContain('cipher')
    expect(JSON.stringify(body.data)).not.toContain('smtp_pass_enc')
  })

  it('PUT refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/settings/email',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { smtpHost: 'smtp.x.ci' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('PUT enregistre host/port/user/secure (sans mot de passe → pas de chiffrement requis)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE platform.tenants
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log
    const res = await app.inject({
      method: 'PUT', url: '/settings/email',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { smtpHost: 'smtp.sotra.ci', smtpPort: 587, smtpUser: 'rh@sotra.ci', smtpSecure: false },
    })
    expect(res.statusCode).toBe(200)
    const upd = queryMock.mock.calls.find((c) => /UPDATE platform\.tenants SET/.test(String(c[0])))
    expect(upd).toBeDefined()
    expect(String(upd?.[0])).toContain('smtp_host')
  })

  it('PUT refuse un port hors bornes (400)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/settings/email',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { smtpPort: 99999 },
    })
    expect(res.statusCode).toBe(400)
  })
})
