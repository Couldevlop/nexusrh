/**
 * CDD — le terme, la durée maximale et le nombre de renouvellements sont des
 * règles de FOND, pas un rappel décoratif.
 *
 * Constat du 07/11/2026 : l'écran Contrats OHADA affiche « CDD : durée max
 * 2 ans, 2 renouvellements » et le serveur n'appliquait aucune des deux.
 *   - `end_date` était simplement `optional()` : un CDD sans terme était
 *     accepté, alors qu'un contrat à durée déterminée sans terme est irrégulier
 *     (art. 15.4 du Code du travail ivoirien). En base de production, tous les
 *     CDD ont ainsi une date de fin nulle, et la colonne « Fin / Essai » de la
 *     liste affiche la fin d'essai à la place du terme.
 *   - `POST /:id/renew` lisait son corps en `request.body as {…}` : aucun Zod,
 *     aucune borne de salaire (la création plafonne à 100 M, pas le
 *     renouvellement), aucun format de date, aucun compteur de renouvellement.
 *     On pouvait renouveler indéfiniment, et une date invalide partait
 *     directement en base.
 *
 * Les bornes sont ici vérifiées côté SERVEUR : une règle affichée que seul
 * l'écran applique n'est pas une règle.
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
import contractsRoutes from './contracts.routes.js'

const SCHEMA = 'tenant_sotra'
const EMP = 'dddddddd-1111-4222-8333-444444444444'
const CONTRACT = 'cccccccc-1111-4222-8333-444444444444'

/** Le CDD en base que `renew` relit, paramétrable par test. */
let existing: Record<string, unknown> = {}
/** Pays par défaut du tenant : pilote le pack (essai, bornes du CDD). */
let country: string | null = 'CIV'

const sqls = (): string[] => queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
/** Écritures métier : la trace d'audit est volontaire, refus compris. */
const writes = (): string[] => sqls()
  .map((s) => s.trim())
  .filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s))
  .filter((s) => !/INSERT INTO "[a-z0-9_]+"\.audit_log/i.test(s))

let app: FastifyInstance

function token() {
  return app.jwt.sign({
    sub: 'u-admin', tenantId: 't1', schemaName: SCHEMA, role: 'admin',
    email: 'admin@sotra.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
}

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token()}` }, payload })

const newCdd = (over: Record<string, unknown> = {}) => ({
  employee_id: EMP, type: 'cdd', start_date: '2026-01-01', end_date: '2026-12-31',
  base_salary: 450_000, ...over,
})

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  country = 'CIV'
  existing = {
    id: CONTRACT, employee_id: EMP, type: 'cdd',
    start_date: '2026-01-01', end_date: '2026-06-30', renewal_count: 0,
    base_salary: 450_000,
  }
  queryMock.mockReset().mockImplementation(async (sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ')
    if (/INSERT INTO "[a-z0-9_]+"\.audit_log/i.test(s)) return { rows: [], rowCount: 1 }
    if (/^SELECT \* FROM "[a-z0-9_]+"\.contracts/i.test(s.trim())) return { rows: [existing], rowCount: 1 }
    if (/FROM platform\.tenants/i.test(s)) {
      return { rows: [{ id: 't1', at_rate: '0.020', default_country_code: country }], rowCount: 1 }
    }
    if (/^SELECT/i.test(s.trim())) return { rows: [{ id: EMP, '1': 1 }], rowCount: 1 }
    if (/^INSERT|^UPDATE/i.test(s.trim())) return { rows: [{ id: CONTRACT, ...existing }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
})

describe('POST /contracts — un CDD a toujours un terme', () => {
  it('refuse un CDD sans date de fin, sans rien écrire', async () => {
    const { end_date: _omit, ...sansTerme } = newCdd()
    const res = await post('/contracts', sansTerme)
    expect(res.statusCode).toBe(400)
    // Message porté par le champ : c'est ce que le formulaire affiche en regard
    // de la date de fin (cf. gestion d'erreurs personnalisée des formulaires).
    const details = res.json().details as Array<{ path: string; message: string }>
    expect(details.some((d) => d.path === 'end_date' && /terme|date de fin/i.test(d.message))).toBe(true)
    expect(writes()).toEqual([])
  })

  it('accepte un CDI sans date de fin', async () => {
    const { end_date: _omit, ...cdi } = newCdd({ type: 'cdi' })
    const res = await post('/contracts', cdi)
    expect(res.statusCode).toBe(201)
  })

  it('refuse un terme antérieur au début', async () => {
    const res = await post('/contracts', newCdd({ end_date: '2025-12-31' }))
    expect(res.statusCode).toBe(400)
    expect(writes()).toEqual([])
  })

  it('refuse un CDD de plus de 2 ans', async () => {
    const res = await post('/contracts', newCdd({ end_date: '2028-06-30' }))
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/2 ans|24 mois/i)
    expect(writes()).toEqual([])
  })

  it('accepte un CDD de 2 ans pile', async () => {
    const res = await post('/contracts', newCdd({ end_date: '2027-12-31' }))
    expect(res.statusCode).toBe(201)
  })
})

describe('POST /contracts/:id/renew — bornes du renouvellement', () => {
  it('refuse une date de fin mal formée', async () => {
    const res = await post(`/contracts/${CONTRACT}/renew`, { new_end_date: '31/12/2027' })
    expect(res.statusCode).toBe(400)
    expect(writes()).toEqual([])
  })

  it('refuse un salaire hors borne', async () => {
    const res = await post(`/contracts/${CONTRACT}/renew`, {
      new_end_date: '2026-12-31', base_salary: 900_000_000,
    })
    expect(res.statusCode).toBe(400)
    expect(writes()).toEqual([])
  })

  it('refuse un renouvellement qui porte le CDD au-delà de 2 ans', async () => {
    const res = await post(`/contracts/${CONTRACT}/renew`, { new_end_date: '2028-03-31' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/2 ans|24 mois/i)
    expect(writes()).toEqual([])
  })

  it('refuse un 3e renouvellement', async () => {
    existing.renewal_count = 2
    const res = await post(`/contracts/${CONTRACT}/renew`, { new_end_date: '2027-06-30' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/renouvell/i)
    expect(writes()).toEqual([])
  })

  it('refuse une date de fin antérieure au terme en cours', async () => {
    const res = await post(`/contracts/${CONTRACT}/renew`, { new_end_date: '2026-03-31' })
    expect(res.statusCode).toBe(400)
    expect(writes()).toEqual([])
  })

  it('renouvelle dans les bornes et incrémente le compteur', async () => {
    const res = await post(`/contracts/${CONTRACT}/renew`, { new_end_date: '2027-06-30' })
    expect(res.statusCode).toBe(200)
    const update = writes().find((s) => /^UPDATE "[a-z0-9_]+"\.contracts/i.test(s))
    expect(update, 'aucun UPDATE du contrat').toBeDefined()
    expect(update).toMatch(/renewal_count/)
  })

  it('un 2e renouvellement reste possible', async () => {
    existing.renewal_count = 1
    const res = await post(`/contracts/${CONTRACT}/renew`, { new_end_date: '2027-06-30' })
    expect(res.statusCode).toBe(200)
  })
})

describe('Période d’essai — règle du pays, jamais en dur', () => {
  /** Date de fin d'essai réellement envoyée en base (5e paramètre de l'INSERT). */
  const insertedTrialEnd = (): unknown => {
    const call = queryMock.mock.calls.find((c) => /INSERT INTO "[a-z0-9_]+"\.contracts/i.test(String(c[0])))
    return (call?.[1] as unknown[] | undefined)?.[4]
  }

  it('Côte d’Ivoire : 15 jours pour un employé', async () => {
    const res = await post('/contracts', newCdd({ job_level: 'employe' }))
    expect(res.statusCode).toBe(201)
    expect(insertedTrialEnd()).toBe('2026-01-16')
  })

  it('Côte d’Ivoire : 1 mois pour un cadre', async () => {
    const res = await post('/contracts', newCdd({ job_level: 'Cadre supérieur' }))
    expect(res.statusCode).toBe(201)
    expect(insertedTrialEnd()).toBe('2026-01-31')
  })

  it('un pays sans règle d’essai dans son pack ne calcule rien', async () => {
    // Le Ghana ne déclare pas de `trialPeriodDays` : imposer 15 jours
    // ivoiriens à un tenant ghanéen serait inventer du droit.
    country = 'GHA'
    const res = await post('/contracts', newCdd())
    expect(res.statusCode).toBe(201)
    expect(insertedTrialEnd()).toBeNull()
  })

  it('la valeur saisie n’est jamais écrasée', async () => {
    const res = await post('/contracts', newCdd({ trial_end_date: '2026-02-28' }))
    expect(res.statusCode).toBe(201)
    expect(insertedTrialEnd()).toBe('2026-02-28')
  })
})
