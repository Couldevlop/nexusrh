/**
 * Continuité des congés BOUT EN BOUT, par la route d'approbation.
 *
 * `interim-continuity.test.ts` tient les règles de décision ; ce banc-ci tient
 * le CÂBLAGE : la route charge-t-elle vraiment le contexte de continuité, et
 * seulement quand elle en a besoin ? Un suppléant qui décide sans que la
 * suppléance ne soit lue n'existe pas, et une requête de continuité tirée à
 * chaque approbation ordinaire est un coût pour rien.
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
    ai: { apiKey: '', model: 'm', maxTokens: 10, temperature: 0 },
    mistral: { apiKey: '', model: 'm', apiUrl: 'https://x' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/paid-leave.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/paid-leave.service.js')>()
  return { ...actual, refreshPaidLeaveBalance: vi.fn(async () => null) }
})

import authPlugin from '../../plugins/auth.js'
import absencesRoutes from './absences.routes.js'

const SCHEMA = 'tenant_sotra'
let app: FastifyInstance

const token = (role: string, employeeId: string | null, sub = `u-${employeeId ?? role}`) =>
  app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId,
  })

/**
 * Base du scénario : deux niveaux hiérarchiques, une demande de `emp` à
 * l'étape N+1 (`n1`), et une hiérarchie emp → n1 → n2.
 *
 * `interims` et `absents` alimentent les deux requêtes de continuité ; par
 * défaut elles ne renvoient rien, donc rien ne change.
 */
function scenario(opts: {
  interims?: Array<Record<string, unknown>>
  absents?: Array<Record<string, unknown>>
  level?: number
} = {}) {
  queryMock.mockReset().mockImplementation(async (sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ')
    if (s.includes('workflow_configs')) return { rows: [{ levels_count: 2 }] }
    if (s.includes('FROM "tenant_sotra".absences a') && s.includes('users u')) {
      // Requête de continuité n° 1 : les absents du jour.
      return { rows: opts.absents ?? [] }
    }
    if (s.includes('approval_interims')) return { rows: opts.interims ?? [] }
    if (s.includes('FROM "tenant_sotra".absences') && s.includes('WHERE id')) {
      return { rows: [{
        id: 'abs-1', employee_id: 'emp', validation_level: opts.level ?? 0,
        status: 'submitted', days: 2, absence_type_id: 'at-1',
        created_at: '2026-11-01T08:00:00Z', approval_trail: [],
      }] }
    }
    if (s.includes('manager_id')) {
      return { rows: [
        { id: 'emp', manager_id: 'n1' }, { id: 'n1', manager_id: 'n2' }, { id: 'n2', manager_id: null },
      ] }
    }
    if (s.includes('UPDATE "tenant_sotra".absences')) {
      return { rows: [{ id: 'abs-1', status: 'submitted', validation_level: 1, approval_trail: [] }] }
    }
    if (s.includes('FROM "tenant_sotra".employees')) return { rows: [{ id: 'emp' }] }
    return { rows: [] }
  })
}

const approve = (role: string, employeeId: string | null) => app.inject({
  method: 'PATCH', url: '/absences/abs-1/approve',
  headers: { authorization: `Bearer ${token(role, employeeId)}` }, payload: {},
})

/** Requêtes de continuité réellement exécutées pendant l'appel. */
const continuityQueries = () =>
  queryMock.mock.calls.filter(([sql]) => String(sql).includes('approval_interims')).length

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(absencesRoutes, { prefix: '/absences' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => scenario())

describe('Approbation ordinaire', () => {
  it('le responsable de l’étape décide, et la continuité n’est même pas lue', async () => {
    const res = await approve('manager', 'n1')
    expect(res.statusCode, res.body).toBe(200)
    // Le coût de la continuité n'est payé que lorsqu'on dit non.
    expect(continuityQueries()).toBe(0)
  })

  it('un responsable étranger au circuit est refusé, continuité vérifiée', async () => {
    const res = await approve('manager', 'ailleurs')
    expect(res.statusCode).toBe(403)
    expect(continuityQueries()).toBe(1)
  })
})

describe('Responsable absent', () => {
  it('le N+2 reprend l’étape quand le N+1 est en congé', async () => {
    scenario({ absents: [{ employee_id: 'n1', user_id: 'u-n1' }] })
    expect((await approve('manager', 'n2')).statusCode).toBe(200)
  })

  it('mais pas tant que le N+1 est présent', async () => {
    expect((await approve('manager', 'n2')).statusCode).toBe(403)
  })

  it('et jamais un collègue sans rôle dans le circuit', async () => {
    scenario({ absents: [{ employee_id: 'n1', user_id: 'u-n1' }] })
    expect((await approve('employee', 'copain')).statusCode).toBe(403)
  })
})

describe('Suppléant déclaré', () => {
  const declared = [{
    absent_user_id: 'u-n1', interim_user_id: 'u-sup',
    absent_employee_id: 'n1', interim_employee_id: 'sup',
  }]

  it('décide à la place du responsable et laisse sa trace dans la piste', async () => {
    scenario({ interims: declared })
    const res = await approve('manager', 'sup')
    expect(res.statusCode, res.body).toBe(200)

    const update = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE "tenant_sotra".absences'))!
    const trail = JSON.parse(String((update[1] as unknown[]).find(
      (p) => typeof p === 'string' && p.startsWith('['))))
    // La piste dit QUI a été remplacé et POURQUOI : sans cela, la décision
    // serait inexplicable à la relecture.
    expect(trail.at(-1)).toMatchObject({
      override: true, interim: { replaced: 'n1', cause: 'declared' },
    })
  })

  it('ne vaut pas pour une autre personne', async () => {
    scenario({ interims: declared })
    expect((await approve('manager', 'autre')).statusCode).toBe(403)
  })
})
