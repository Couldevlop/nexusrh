/**
 * Intérims de validation — déclaration, lecture, révocation.
 *
 * L'intérim transmet un POUVOIR DE DÉCISION sur les congés et les notes de
 * frais : ses bornes sont vérifiées côté serveur, jamais seulement à l'écran.
 * Ce banc les tient toutes — durée, comptes réels, absence de chaîne, absence
 * de doublon actif, RBAC, audit.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
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
import interimsRoutes, { MAX_INTERIM_DAYS } from './interims.routes.js'

const SCHEMA = 'tenant_sotra'
const ABSENT  = '11111111-1111-1111-1111-111111111111'
const SUPPL   = '22222222-2222-2222-2222-222222222222'
const TIERS   = '33333333-3333-3333-3333-333333333333'
const INTERIM = '44444444-4444-4444-4444-444444444444'

let app: FastifyInstance

const token = (role: string) => app.jwt.sign({
  sub: 'u-actor', tenantId: 't1', schemaName: SCHEMA, role,
  email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
})

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()

const post = (payload: Record<string, unknown>, role = 'hr_manager') =>
  app.inject({ method: 'POST', url: '/settings/interims', headers: { authorization: `Bearer ${token(role)}` }, payload })
const get = (role = 'hr_manager') =>
  app.inject({ method: 'GET', url: '/settings/interims', headers: { authorization: `Bearer ${token(role)}` } })
const del = (id: string, role = 'hr_manager') =>
  app.inject({ method: 'DELETE', url: `/settings/interims/${id}`, headers: { authorization: `Bearer ${token(role)}` } })

/** Les deux comptes sont actifs, aucun conflit, insertion réussie. */
function happyPath() {
  queryMock.mockReset().mockImplementation(async (sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ')
    if (/FROM "tenant_sotra".users/.test(s)) return { rows: [{ id: ABSENT }, { id: SUPPL }], rowCount: 2 }
    if (/FROM "tenant_sotra".absences/.test(s)) return { rows: [], rowCount: 0 }
    if (/FROM "tenant_sotra".approval_interims/.test(s)) return { rows: [], rowCount: 0 }
    if (/INSERT INTO "tenant_sotra".approval_interims/.test(s)) return { rows: [{ id: INTERIM }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(interimsRoutes, { prefix: '/settings' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => happyPath())

describe('Déclarer un intérim', () => {
  it('enregistre la suppléance et la trace', async () => {
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(15), reason: 'Congés annuels' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().data.id).toBe(INTERIM)
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO/.test(String(sql)))!
    expect(insert[1]).toEqual(expect.arrayContaining([ABSENT, SUPPL, 'Congés annuels']))
    // L'écriture est auditée (OWASP A09) : un pouvoir de décision change de main.
    const audit = queryMock.mock.calls.find(([sql]) => /audit_log/i.test(String(sql)))
    expect(audit).toBeDefined()
  })

  it('refuse de se désigner soi-même suppléant', async () => {
    const res = await post({ absentUserId: ABSENT, interimUserId: ABSENT, endsAt: inDays(5) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/remplacée/i)
  })

  it('exige un terme, dans le futur et borné', async () => {
    const sansRien = await post({ absentUserId: ABSENT, interimUserId: SUPPL })
    expect(sansRien.statusCode).toBe(400)
    expect(sansRien.json().error).toMatch(/congé à couvrir/i)
    expect((await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(-1) })).statusCode).toBe(400)
    expect((await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: 'pas-une-date' })).statusCode).toBe(400)
    const trop = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(MAX_INTERIM_DAYS + 1) })
    expect(trop.statusCode).toBe(400)
    expect(trop.json().error).toMatch(String(MAX_INTERIM_DAYS))
  })

  it('refuse une période dont la fin précède le début', async () => {
    const res = await post({
      absentUserId: ABSENT, interimUserId: SUPPL,
      startsAt: inDays(20), endsAt: inDays(10),
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un compte inconnu ou désactivé', async () => {
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      if (/FROM "tenant_sotra".users/.test(String(sql))) return { rows: [{ id: ABSENT }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(5) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/actifs/i)
    // Rien n'est inséré.
    expect(queryMock.mock.calls.some(([sql]) => /INSERT INTO/.test(String(sql)))).toBe(false)
  })

  it('refuse un identifiant qui n’est pas un UUID', async () => {
    expect((await post({ absentUserId: 'abc', interimUserId: SUPPL, endsAt: inDays(5) })).statusCode).toBe(400)
  })

  it('refuse un second intérim actif pour la même personne', async () => {
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ')
      if (/FROM "tenant_sotra".users/.test(s)) return { rows: [{ id: ABSENT }, { id: SUPPL }], rowCount: 2 }
      if (/FROM "tenant_sotra".approval_interims/.test(s)) {
        return { rows: [{ absent_user_id: ABSENT, interim_user_id: TIERS }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(5) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/déjà un intérim/i)
  })

  it('refuse de désigner quelqu’un qui est lui-même remplacé', async () => {
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ')
      if (/FROM "tenant_sotra".users/.test(s)) return { rows: [{ id: ABSENT }, { id: SUPPL }], rowCount: 2 }
      if (/FROM "tenant_sotra".approval_interims/.test(s)) {
        return { rows: [{ absent_user_id: SUPPL, interim_user_id: TIERS }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(5) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/lui-même remplacé/i)
  })

  it('refuse la chaîne d’intérims', async () => {
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ')
      if (/FROM "tenant_sotra".users/.test(s)) return { rows: [{ id: ABSENT }, { id: SUPPL }], rowCount: 2 }
      if (/FROM "tenant_sotra".approval_interims/.test(s)) {
        // La personne qu'on veut remplacer assure déjà l'intérim d'un autre.
        return { rows: [{ absent_user_id: TIERS, interim_user_id: ABSENT }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(5) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/chaîne/i)
  })

  it('rejette tout champ inattendu', async () => {
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(5), role: 'admin' })
    expect(res.statusCode).toBe(400)
  })
})

describe('RBAC', () => {
  it('seuls l’admin et le DRH déclarent ou révoquent', async () => {
    for (const role of ['admin', 'hr_manager']) {
      expect((await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(5) }, role)).statusCode, role).toBe(201)
    }
    for (const role of ['hr_officer', 'manager', 'employee']) {
      expect((await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(5) }, role)).statusCode, role).toBe(403)
      expect((await del(INTERIM, role)).statusCode, role).toBe(403)
    }
  })

  it('la lecture est ouverte : un suppléant doit voir sa propre suppléance', async () => {
    for (const role of ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee']) {
      expect((await get(role)).statusCode, role).toBe(200)
    }
  })

  it('un non-RH ne lit que les intérims qui le concernent', async () => {
    await get('manager')
    const call = queryMock.mock.calls.find(([sql]) => /FROM "tenant_sotra".approval_interims/.test(String(sql)))!
    // Le drapeau « équipe RH » est faux : la clause ne garde que ses lignes.
    expect(call[1]).toEqual(['u-actor', false])
    queryMock.mockClear()
    await get('hr_officer')
    const rh = queryMock.mock.calls.find(([sql]) => /FROM "tenant_sotra".approval_interims/.test(String(sql)))!
    expect(rh[1]).toEqual(['u-actor', true])
  })
})

describe('Révoquer un intérim', () => {
  it('le termine immédiatement et le trace', async () => {
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      if (/UPDATE "tenant_sotra".approval_interims/.test(String(sql))) return { rows: [{ id: INTERIM }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const res = await del(INTERIM)
    expect(res.statusCode, res.body).toBe(200)
    const update = queryMock.mock.calls.find(([sql]) => /UPDATE "tenant_sotra".approval_interims/.test(String(sql)))!
    // La révocation est datée, la ligne est conservée : l'historique reste lisible.
    expect(String(update[0])).toMatch(/revoked_at = now\(\)/)
    expect(String(update[0])).toMatch(/revoked_at IS NULL/)
    expect(queryMock.mock.calls.some(([sql]) => /audit_log/i.test(String(sql)))).toBe(true)
  })

  it('404 sur un intérim inconnu ou déjà révoqué', async () => {
    queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 })
    expect((await del(INTERIM)).statusCode).toBe(404)
  })
})

describe('Tenant provisionné avant ce module', () => {
  it('la liste répond vide plutôt que de tomber', async () => {
    queryMock.mockReset().mockImplementation(async () => {
      const err = new Error('relation does not exist') as Error & { code: string }
      err.code = '42P01'
      throw err
    })
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([])
  })

  it('la déclaration répond indisponible, sans 500', async () => {
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      if (/FROM "tenant_sotra".users/.test(String(sql))) return { rows: [{ id: ABSENT }, { id: SUPPL }], rowCount: 2 }
      const err = new Error('relation does not exist') as Error & { code: string }
      err.code = '42P01'
      throw err
    })
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(5) })
    expect(res.statusCode).toBe(503)
  })
})

/**
 * Ce qui sépare l'intérim de la délégation d'habilitation : ses bornes
 * viennent du CONGÉ déjà saisi, pas d'une procuration que le titulaire signe.
 */
describe('Adossement au congé saisi', () => {
  const ABSENCE = '55555555-5555-5555-5555-555555555555'
  const leave = (over: Record<string, unknown> = {}) => ({
    id: ABSENCE, start_date: '2026-12-01', end_date: '2026-12-20', status: 'approved', ...over,
  })
  function withLeave(rows: Array<Record<string, unknown>>) {
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ')
      if (/FROM "tenant_sotra".absences a JOIN/.test(s)) return { rows, rowCount: rows.length }
      if (/FROM "tenant_sotra".users/.test(s)) return { rows: [{ id: ABSENT }, { id: SUPPL }], rowCount: 2 }
      if (/FROM "tenant_sotra".approval_interims/.test(s)) return { rows: [], rowCount: 0 }
      if (/INSERT INTO "tenant_sotra".approval_interims/.test(s)) return { rows: [{ id: INTERIM }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
  }

  it('déduit la période du congé, sans qu’aucune date soit saisie', async () => {
    withLeave([leave()])
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, absenceId: ABSENCE })
    expect(res.statusCode, res.body).toBe(201)
    const body = res.json().data
    expect(body.source).toBe('absence')
    expect(body.startsAt).toBe('2026-12-01T00:00:00.000Z')
    // Le dernier jour de congé est couvert en ENTIER.
    expect(body.endsAt).toBe('2026-12-20T23:59:59.999Z')
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO/.test(String(sql)))!
    expect(insert[1]).toEqual(expect.arrayContaining([ABSENCE]))
  })

  it('les dates du congé l’emportent sur celles qu’on tenterait d’imposer', async () => {
    withLeave([leave()])
    const res = await post({
      absentUserId: ABSENT, interimUserId: SUPPL, absenceId: ABSENCE,
      startsAt: inDays(1), endsAt: inDays(170),
    })
    expect(res.statusCode).toBe(201)
    // La suppléance ne déborde pas le congé qu'elle couvre.
    expect(res.json().data.endsAt).toBe('2026-12-20T23:59:59.999Z')
  })

  it('refuse le congé d’une autre personne', async () => {
    withLeave([])
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, absenceId: ABSENCE })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/pas celui de la personne remplacée/i)
  })

  it('refuse un congé refusé, annulé ou déjà terminé', async () => {
    withLeave([leave({ status: 'rejected' })])
    expect((await post({ absentUserId: ABSENT, interimUserId: SUPPL, absenceId: ABSENCE })).json().error)
      .toMatch(/refusé ou annulé/i)
    withLeave([leave({ start_date: '2026-01-05', end_date: '2026-01-10' })])
    expect((await post({ absentUserId: ABSENT, interimUserId: SUPPL, absenceId: ABSENCE })).json().error)
      .toMatch(/terminé/i)
  })

  it('sans congé désigné, la saisie manuelle reste possible et tracée comme telle', async () => {
    const res = await post({ absentUserId: ABSENT, interimUserId: SUPPL, endsAt: inDays(10) })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.source).toBe('manual')
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO/.test(String(sql)))!
    expect(insert[1]!.at(-1)).toBeNull()
  })
})

describe('Couverture des congés de valideurs', () => {
  it('liste les absences des porteurs d’étape, non couvertes d’abord', async () => {
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      if (/FROM "tenant_sotra".absences/.test(String(sql))) {
        return { rows: [{ userId: ABSENT, role: 'hr_manager', covered: false }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = await app.inject({
      method: 'GET', url: '/settings/interims/coverage',
      headers: { authorization: `Bearer ${token('hr_officer')}` },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data[0].covered).toBe(false)
    const call = queryMock.mock.calls.find(([sql]) => /FROM "tenant_sotra".absences/.test(String(sql)))!
    // Seuls les rôles qui portent une étape de validation sont surveillés.
    expect(call[1]![0]).toEqual(['admin', 'hr_manager', 'hr_officer', 'manager', 'dg'])
    // Les circuits qui vont s'arrêter remontent en tête.
    expect(String(call[0])).toMatch(/ORDER BY covered ASC/)
  })

  it('reste fermée à un employé', async () => {
    const res = await app.inject({
      method: 'GET', url: '/settings/interims/coverage',
      headers: { authorization: `Bearer ${token('employee')}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
