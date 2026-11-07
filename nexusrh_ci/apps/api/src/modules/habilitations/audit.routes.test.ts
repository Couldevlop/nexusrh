/**
 * Piste d'audit des habilitations — lecture filtrable (tâche 13).
 *
 * Ce que ce banc protège : la piste n'a de valeur que si un contrôleur peut y
 * retrouver « ce qu'a fait cette personne », et la question se pose par rôle,
 * par groupe, par sous-groupe, par matricule ou par cause de refus. Chaque
 * filtre est donc vérifié dans le SQL produit — un filtre ignoré en silence
 * rendrait la réponse fausse sans rien signaler.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
  setTokenEpoch: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))

import authPlugin from '../../plugins/auth.js'
import auditRoutes from './audit.routes.js'

const SCHEMA = 'tenant_sotra'
const SUBGROUP = '33333333-3333-4333-8333-333333333333'
const GROUP = '11111111-1111-4111-8111-111111111111'
const USER = '66666666-6666-4666-8666-666666666666'

let app: FastifyInstance
let lastSelect: { sql: string; params: unknown[] }

function headers(role: string): Record<string, string> {
  const t = app.jwt.sign({
    sub: USER, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
  return { authorization: `Bearer ${t}` }
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(auditRoutes, { prefix: '/habilitations' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  lastSelect = { sql: '', params: [] }
  queryMock.mockReset()
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const q = String(sql).replace(/\s+/g, ' ')
    if (q.includes('platform.tenants')) return { rows: [{ enforced: true }] }
    if (q.includes('INTERSECT')) return { rows: [] }
    if (q.includes('audit_log')) {
      lastSelect = { sql: q, params }
      return {
        rows: [{
          id: 'a-1', created_at: '2026-11-04T09:00:00.000Z', user_id: USER, action: 'hr.employees.view',
          entity: 'employees', entity_id: null, changes: { result: 'denied_scope', route: '/employees' },
          ip_address: '41.66.0.1', email: 'rh@sotra.ci', first_name: 'A', last_name: 'B',
          role: 'hr_officer', subgroup_id: SUBGROUP, subgroup_name: 'Filiale Nord', group_id: GROUP,
          employee_number: 'MAT00084',
        }],
      }
    }
    return { rows: [] }
  })
})

describe('GET /habilitations/audit — accès', () => {
  it('sans jeton : 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/audit' })
    expect(res.statusCode).toBe(401)
  })

  it('un rôle RH non admin : 403 (la distribution des droits appartient à l\'admin)', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/audit', headers: headers('hr_manager') })
    expect(res.statusCode).toBe(403)
  })

  it('l\'admin du tenant : 200, lignes enrichies du rôle, du sous-groupe et du matricule', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/audit', headers: headers('admin') })
    expect(res.statusCode).toBe(200)
    const row = res.json().data[0]
    expect(row).toMatchObject({ role: 'hr_officer', subgroup_name: 'Filiale Nord', employee_number: 'MAT00084' })
    expect(lastSelect.sql).toContain('LIMIT')
  })
})

describe('GET /habilitations/audit — filtres', () => {
  const get = (qs: string) => app.inject({ method: 'GET', url: `/habilitations/audit${qs}`, headers: headers('admin') })

  it('matricule : clause sur employees.employee_number, valeur en paramètre', async () => {
    await get('?matricule=MAT00084')
    expect(lastSelect.sql).toContain('employee_number')
    expect(lastSelect.params).toContain('MAT00084')
  })

  it('sous-groupe, groupe, utilisateur et rôle : chacun sa clause paramétrée', async () => {
    await get(`?subgroupId=${SUBGROUP}`)
    expect(lastSelect.sql).toContain('subgroup_id')
    expect(lastSelect.params).toContain(SUBGROUP)

    await get(`?groupId=${GROUP}`)
    expect(lastSelect.sql).toContain('group_id')
    expect(lastSelect.params).toContain(GROUP)

    await get(`?userId=${USER}`)
    expect(lastSelect.params).toContain(USER)

    await get('?role=hr_officer')
    expect(lastSelect.params).toContain('hr_officer')
  })

  it('result : filtre sur la cause enregistrée dans changes', async () => {
    await get('?result=denied_scope')
    expect(lastSelect.sql).toContain("changes->>'result'")
    expect(lastSelect.params).toContain('denied_scope')
  })

  it('« accès refusés » : les trois causes de refus d\'un coup', async () => {
    await get('?result=denied')
    expect(lastSelect.params.some((p) => Array.isArray(p) && p.includes('denied_permission') && p.includes('denied_scope') && p.includes('denied_self'))).toBe(true)
  })

  it('dates : bornes paramétrées', async () => {
    await get('?from=2026-11-01&to=2026-11-04')
    expect(lastSelect.sql).toContain('created_at')
    expect(lastSelect.params).toContain('2026-11-01')
    expect(lastSelect.params).toContain('2026-11-04')
  })

  it('un identifiant mal formé : 400, aucune requête d\'audit', async () => {
    const res = await get('?subgroupId=pas-un-uuid')
    expect(res.statusCode).toBe(400)
    expect(lastSelect.sql).toBe('')
  })

  it('un result inconnu : 400', async () => {
    expect((await get('?result=peut-etre')).statusCode).toBe(400)
  })

  it('pagination bornée à 100 lignes par page', async () => {
    await get('?page=3')
    expect(lastSelect.params).toContain(100)
    expect(lastSelect.params).toContain(200)
  })

  it('une page absurde : 400', async () => {
    expect((await get('?page=0')).statusCode).toBe(400)
  })
})

describe('GET /habilitations/audit — export CSV', () => {
  it('CSV en UTF-8 avec BOM, en-têtes français', async () => {
    const res = await app.inject({ method: 'GET', url: '/habilitations/audit?format=csv', headers: headers('admin') })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('.csv')
    expect(res.body.startsWith('﻿')).toBe(true)
    expect(res.body).toContain('Matricule')
    expect(res.body).toContain('MAT00084')
    expect(res.body).toContain('denied_scope')
  })

  it('une valeur commençant par = est neutralisée (injection de formule)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const q = String(sql).replace(/\s+/g, ' ')
      if (q.includes('platform.tenants')) return { rows: [{ enforced: true }] }
      if (q.includes('INTERSECT')) return { rows: [] }
      if (q.includes('audit_log')) {
        return {
          rows: [{
            id: 'a-1', created_at: '2026-11-04T09:00:00.000Z', user_id: USER, action: 'hr.employees.view',
            entity: 'employees', entity_id: null, changes: {}, ip_address: null,
            email: '=cmd|\' /C calc\'!A0', first_name: 'A', last_name: 'B', role: 'hr_officer',
            subgroup_id: null, subgroup_name: null, group_id: null, employee_number: null,
          }],
        }
      }
      return { rows: [] }
    })
    const res = await app.inject({ method: 'GET', url: '/habilitations/audit?format=csv', headers: headers('admin') })
    expect(res.body).not.toMatch(/(^|[;\n"])=cmd/)
  })
})
