/**
 * Simulateur de salaire — pays du tenant et champs qui changent le résultat.
 *
 * Constat du 07/11/2026 : le simulateur était figé sur `CIV_2024` en dur, et
 * ne proposait que cinq champs (brut, primes, situation familiale, enfants,
 * secteur AT). Quatre conséquences, toutes visibles sur le net :
 *
 *  1. Un tenant d'un autre pays — quinze packs existent — se voyait appliquer
 *     le barème, les cotisations et la devise ivoiriens.
 *  2. Le moteur sait compter le CONJOINT SANS EMPLOI dans la CMU
 *     (`cmu.spouseCovered`) ; la route ne le passait jamais : 500 F/mois
 *     manquants pour tout salarié marié.
 *  3. `childrenCount` servait à la fois aux parts fiscales (RICF) et aux
 *     bénéficiaires CMU, deux notions distinctes (la CMU ne couvre que les
 *     enfants de moins de 21 ans).
 *  4. La PRIME DE TRANSPORT était traitée comme une prime ordinaire, donc
 *     entièrement imposée, alors qu'elle est exonérée jusqu'à 30 000 F à
 *     Abidjan, 24 000 à Bouaké, 20 000 ailleurs : le simulateur sur-imposait.
 *
 * Chaque champ est ici vérifié par son EFFET sur le résultat, pas par sa
 * présence dans la réponse.
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
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3, defaultProvider: 'claude' },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import aiRoutes from './ai.routes.js'

const SCHEMA = 'tenant_sotra'
/** Pays par défaut du tenant, piloté par test. */
let tenantCountry: string | null = 'CIV'

interface SimResult {
  input: { countryCode: string; brut: number }
  currency: string
  cnps: { salarial: number; patronal: number }
  cmu?: { salarial: number; patronal: number }
  its: { base: number; brut: number; credit: number; parts: number; net: number }
  net: { payable: number; smigCompliant: boolean }
  employerCost: number
  lines: Array<{ code: string; label: string; type: string; base: number; amount: number }>
  pack: {
    code: string; countryCode: string; currency: string; smigMensuel: number
    usable: boolean; brackets: ReadonlyArray<{ min: number; max: number | null; taux: number }>
    hasCmu: boolean; hasSeniorityBonus: boolean
  }
}

let app: FastifyInstance

function token() {
  return app.jwt.sign({
    sub: 'u-hr', tenantId: 't1', schemaName: SCHEMA, role: 'hr_manager',
    email: 'rh@sotra.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
}

async function simulate(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST', url: '/ai/simulate-its',
    headers: { authorization: `Bearer ${token()}` }, payload,
  })
  return res
}

const ok = async (payload: Record<string, unknown>): Promise<SimResult> => {
  const res = await simulate(payload)
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as SimResult
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(aiRoutes, { prefix: '/ai' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  tenantCountry = 'CIV'
  queryMock.mockReset().mockImplementation(async (sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ')
    if (/FROM platform\.tenants/i.test(s)) {
      return { rows: [{ id: 't1', at_rate: '0.020', default_country_code: tenantCountry }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
})

describe('Pays', () => {
  it('à défaut, applique le pays du tenant', async () => {
    const r = await ok({ baseSalary: 250_000 })
    expect(r.input.countryCode).toBe('CIV')
    expect(r.currency).toBe('XOF')
  })

  it('suit le pays du tenant quand il change', async () => {
    tenantCountry = 'GHA'
    const r = await ok({ baseSalary: 250_000 })
    expect(r.input.countryCode).toBe('GHA')
    expect(r.currency).toBe('GHS')
  })

  it('un pays explicite prime sur celui du tenant', async () => {
    const r = await ok({ baseSalary: 250_000, countryCode: 'SEN' })
    expect(r.input.countryCode).toBe('SEN')
    expect(r.currency).toBe('XOF')
    // Le Sénégal n'a pas de CMU ivoirienne : aucune retenue de ce nom.
    expect(r.cmu?.salarial ?? 0).toBe(0)
  })

  it('refuse un pays non pris en charge', async () => {
    const res = await simulate({ baseSalary: 250_000, countryCode: 'FRA' })
    expect(res.statusCode).toBe(400)
  })

  it('deux pays ne donnent pas le même impôt sur le même brut', async () => {
    const ci = await ok({ baseSalary: 400_000, countryCode: 'CIV' })
    const sn = await ok({ baseSalary: 400_000, countryCode: 'SEN' })
    expect(ci.its.net).not.toBe(sn.its.net)
  })
})

describe('CMU — conjoint sans emploi et enfants couverts', () => {
  it('le conjoint sans emploi ajoute un bénéficiaire', async () => {
    const sans = await ok({ baseSalary: 300_000, maritalStatus: 'married', childrenCount: 0 })
    const avec = await ok({
      baseSalary: 300_000, maritalStatus: 'married', childrenCount: 0, cmuSpouseCovered: true,
    })
    // 1 000 F par bénéficiaire, partagés moitié-moitié : +500 pour le salarié.
    expect(avec.cmu!.salarial - sans.cmu!.salarial).toBe(500)
    expect(avec.cmu!.patronal - sans.cmu!.patronal).toBe(500)
  })

  it('les enfants couverts par la CMU sont distincts des enfants à charge', async () => {
    // 3 enfants à charge (parts fiscales) mais 1 seul de moins de 21 ans.
    const tous = await ok({ baseSalary: 300_000, maritalStatus: 'married', childrenCount: 3 })
    const unSeul = await ok({
      baseSalary: 300_000, maritalStatus: 'married', childrenCount: 3, cmuChildrenCovered: 1,
    })
    expect(tous.cmu!.salarial - unSeul.cmu!.salarial).toBe(1_000) // 2 enfants × 500
    // Les parts fiscales, elles, ne bougent pas : la RICF reste la même.
    expect(unSeul.its.parts).toBe(tous.its.parts)
    expect(unSeul.its.credit).toBe(tous.its.credit)
  })
})

describe('Prime de transport — exonérée dans la limite du plafond de la zone', () => {
  it('une prime de transport sous le plafond n’augmente pas l’impôt', async () => {
    const nu = await ok({ baseSalary: 300_000 })
    const avec = await ok({ baseSalary: 300_000, transportAllowance: 30_000, city: 'Abidjan' })
    expect(avec.its.net).toBe(nu.its.net)
    // …mais elle est bien versée : le net augmente d'autant.
    expect(avec.net.payable - nu.net.payable).toBe(30_000)
  })

  it('la fraction au-delà du plafond de la zone est imposée', async () => {
    const abidjan = await ok({ baseSalary: 300_000, transportAllowance: 30_000, city: 'Abidjan' })
    const bouake  = await ok({ baseSalary: 300_000, transportAllowance: 30_000, city: 'Bouaké' })
    // Plafond 24 000 à Bouaké : 6 000 deviennent imposables.
    expect(bouake.its.net).toBeGreaterThan(abidjan.its.net)
  })

  it('une prime ordinaire reste entièrement imposée', async () => {
    const nu = await ok({ baseSalary: 300_000 })
    const avec = await ok({ baseSalary: 300_000, primes: 30_000 })
    expect(avec.its.net).toBeGreaterThan(nu.its.net)
  })
})

describe('Ancienneté', () => {
  it('une date d’embauche ancienne augmente le brut via la prime d’ancienneté', async () => {
    const neuf = await ok({ baseSalary: 300_000, hireDate: '2026-01-01', payMonth: '2026-06' })
    const ancien = await ok({ baseSalary: 300_000, hireDate: '2006-01-01', payMonth: '2026-06' })
    expect(ancien.input.brut).toBeGreaterThan(neuf.input.brut)
    expect(ancien.net.payable).toBeGreaterThan(neuf.net.payable)
  })

  it('sans date d’embauche, aucune prime d’ancienneté', async () => {
    const sans = await ok({ baseSalary: 300_000 })
    expect(sans.input.brut).toBe(300_000)
  })
})

describe('Temps de travail', () => {
  it('un mois incomplet réduit le brut au prorata', async () => {
    const plein = await ok({ baseSalary: 300_000 })
    const demi  = await ok({ baseSalary: 300_000, workedDays: 13, workingDaysMonth: 26 })
    expect(demi.net.payable).toBeLessThan(plein.net.payable)
  })
})

describe('Références du pays renvoyées à l’écran', () => {
  it('le barème et le SMIG sont ceux du pays, pas des constantes ivoiriennes', async () => {
    const ci = await ok({ baseSalary: 300_000, countryCode: 'CIV' })
    expect(ci.pack.smigMensuel).toBe(75_000)
    expect(ci.pack.brackets[0]!.taux).toBe(0)
    expect(ci.pack.hasCmu).toBe(true)

    const sn = await ok({ baseSalary: 300_000, countryCode: 'SEN' })
    expect(sn.pack.smigMensuel).not.toBe(ci.pack.smigMensuel)
    expect(sn.pack.brackets).not.toEqual(ci.pack.brackets)
  })

  it('le détail des cotisations vient du moteur, ligne par ligne', async () => {
    const r = await ok({ baseSalary: 300_000, countryCode: 'CIV' })
    expect(r.lines.length).toBeGreaterThan(3)
    // Les plafonds sont appliqués par le moteur : la base AT/PF est plafonnée.
    const patronales = r.lines.filter((l) => l.type === 'employer_contribution')
    expect(patronales.length).toBeGreaterThan(0)
    expect(patronales.every((l) => l.base <= 300_000)).toBe(true)
  })
})
