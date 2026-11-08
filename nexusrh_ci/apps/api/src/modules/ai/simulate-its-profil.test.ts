/**
 * Simulateur de salaire — champs de PROFIL : catégorie et son minimum
 * conventionnel, ancienneté, niveau de qualification, heures supplémentaires,
 * avantages en nature.
 *
 * Ce qui manquait, et pourquoi chacun compte :
 *
 *  - **Minimum catégoriel.** L'assiette de la prime d'ancienneté est, en CI,
 *    le minimum de la catégorie (CCI art. 55). Faute de champ, le simulateur
 *    prenait le salaire minimum LÉGAL pour tout le monde : la prime d'un 6e
 *    catégorie était calculée sur 75 000 F au lieu de son minimum réel.
 *  - **Ancienneté en années.** On connaît souvent « 12 ans de maison » sans
 *    avoir la date exacte sous la main.
 *  - **Heures supplémentaires.** Les majorations sont dans le pack (CI :
 *    décret n° 2024-898, art. 25) ; le simulateur ne les utilisait pas.
 *  - **Avantages en nature.** Soumis aux cotisations et à l'impôt (CGI art.
 *    116) : les ignorer sous-estime l'impôt et le coût employeur.
 *  - **Niveau de qualification.** Il ne change AUCUN montant : aucun texte ne
 *    fait dépendre un taux d'un diplôme. Il positionne une catégorie, et le
 *    banc vérifie précisément qu'il reste sans effet sur le calcul.
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

interface SimResult {
  input: {
    brut: number; seniorityAmount: number; categoryMinimum: number
    categoryMinimumProvided: boolean; categoryLevel: number | null
    professionalCategory: string | null; qualificationLevel: string | null
    weeklyHours: number; benefitsInKind: number; hireDate: string | null
  }
  seniority: { years: number; rate: number | null; base: number; amount: number; source: string | null }
  overtime: {
    total: number; hourlyRate: number
    lines: Array<{ category: string; label: string; hours: number; majoration: number; amount: number }>
  }
  compliance: { smig: boolean; smigMinimum: number; categoryMinimum: boolean | null }
  positioning: { usualJobLevel: string | null; salaryJobLevel: string; aligned: boolean; note: string }
  its: { base: number; net: number }
  net: { payable: number }
  employerCost: number
  lines: Array<{ code: string; label: string; type: string; amount: number }>
  pack: { overtimeRates: Record<string, number> | null }
  comparison: {
    input: { baseSalary: number; primes: number; brut: number; seniorityAmount: number }
    net: { payable: number; smigCompliant: boolean }
    its: { net: number }
    employerCost: number
    delta: {
      baseSalary: number; brut: number; netPayable: number; its: number
      cnpsSal: number; employerCost: number; brutPct: number; netSharePct: number | null
    }
  } | null
}

let app: FastifyInstance

const token = () => app.jwt.sign({
  sub: 'u-hr', tenantId: 't1', schemaName: SCHEMA, role: 'hr_manager',
  email: 'rh@sotra.ci', firstName: 'A', lastName: 'B', employeeId: null,
})

async function simulate(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/ai/simulate-its',
    headers: { authorization: `Bearer ${token()}` }, payload,
  })
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
  queryMock.mockReset().mockImplementation(async (sql: string) => {
    if (/FROM platform\.tenants/i.test(String(sql).replace(/\s+/g, ' '))) {
      return { rows: [{ id: 't1', at_rate: '0.020', default_country_code: 'CIV' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
})

describe('Catégorie professionnelle et son minimum conventionnel', () => {
  it('le minimum catégoriel sert d’assiette à la prime d’ancienneté', async () => {
    const common = { baseSalary: 400_000, hireDate: '2010-01-01', payMonth: '2026-06' }
    const sansMinimum = await ok(common)
    const avecMinimum = await ok({ ...common, categoryMinimum: 200_000 })
    // Même taux d'ancienneté, assiette plus large : prime plus élevée.
    expect(avecMinimum.seniority.rate).toBe(sansMinimum.seniority.rate)
    expect(avecMinimum.seniority.base).toBe(200_000)
    expect(sansMinimum.seniority.base).toBe(75_000) // repli : minimum légal
    expect(avecMinimum.seniority.amount).toBeGreaterThan(sansMinimum.seniority.amount)
    // …et le brut, donc le net, suivent.
    expect(avecMinimum.input.brut).toBeGreaterThan(sansMinimum.input.brut)
  })

  it('signale un salaire sous le minimum de la catégorie, sans bloquer', async () => {
    const r = await ok({ baseSalary: 150_000, categoryMinimum: 200_000 })
    expect(r.compliance.categoryMinimum).toBe(false)
    // Le minimum LÉGAL, lui, est respecté : les deux contrôles sont distincts.
    expect(r.compliance.smig).toBe(true)
    expect(r.compliance.smigMinimum).toBe(75_000)
  })

  it('sans minimum saisi, aucun verdict conventionnel n’est inventé', async () => {
    const r = await ok({ baseSalary: 150_000 })
    expect(r.compliance.categoryMinimum).toBeNull()
    expect(r.input.categoryMinimumProvided).toBe(false)
  })

  it('le libellé de catégorie est renvoyé avec son niveau exploitable', async () => {
    const r = await ok({ baseSalary: 300_000, professionalCategory: '6e catégorie' })
    expect(r.input.professionalCategory).toBe('6e catégorie')
    expect(r.input.categoryLevel).toBe(6)
    const cadre = await ok({ baseSalary: 300_000, professionalCategory: 'Cadre' })
    expect(cadre.input.categoryLevel).toBe(8)
  })
})

describe('Ancienneté', () => {
  it('les années saisies valent la date d’embauche correspondante', async () => {
    const parDate   = await ok({ baseSalary: 300_000, hireDate: '2010-06-01', payMonth: '2026-06' })
    const parAnnees = await ok({ baseSalary: 300_000, seniorityYears: 16, payMonth: '2026-06' })
    expect(parAnnees.seniority.years).toBe(parDate.seniority.years)
    expect(parAnnees.seniority.amount).toBe(parDate.seniority.amount)
  })

  it('la date d’embauche l’emporte si les deux sont fournies', async () => {
    const r = await ok({ baseSalary: 300_000, hireDate: '2024-06-01', seniorityYears: 30, payMonth: '2026-06' })
    expect(r.input.hireDate).toBe('2024-06-01')
    expect(r.seniority.years).toBe(2)
  })

  it('renvoie le taux et la source légale du pack, pas un montant orphelin', async () => {
    const r = await ok({ baseSalary: 300_000, seniorityYears: 10, payMonth: '2026-06' })
    expect(r.seniority.rate).toBeGreaterThan(0)
    expect(r.seniority.source).toMatch(/CCI/)
  })

  it('aucune ancienneté renseignée : aucune prime', async () => {
    const r = await ok({ baseSalary: 300_000 })
    expect(r.seniority.amount).toBe(0)
    expect(r.input.brut).toBe(300_000)
  })
})

describe('Heures supplémentaires', () => {
  it('chaque nature produit sa ligne, à la majoration du pack', async () => {
    const r = await ok({
      baseSalary: 300_000, weeklyHours: 40,
      overtimeHours: { weekly: 4, weeklyBeyond: 2, night: 3 },
    })
    expect(r.overtime.lines.map((l) => l.category).sort()).toEqual(['night', 'weekly', 'weeklyBeyond'])
    const weekly = r.overtime.lines.find((l) => l.category === 'weekly')!
    expect(weekly.majoration).toBe(0.15)      // 41e à 46e heure
    expect(r.overtime.lines.find((l) => l.category === 'weeklyBeyond')!.majoration).toBe(0.5)
    expect(r.overtime.lines.find((l) => l.category === 'night')!.majoration).toBe(0.75)
    // Taux horaire = base ÷ (40 × 52 ÷ 12)
    expect(r.overtime.hourlyRate).toBe(Math.round(300_000 / ((40 * 52) / 12)))
    expect(r.overtime.total).toBe(r.overtime.lines.reduce((s, l) => s + l.amount, 0))
  })

  it('les heures supplémentaires sont soumises : elles augmentent l’impôt et le net', async () => {
    const nu   = await ok({ baseSalary: 300_000 })
    const avec = await ok({ baseSalary: 300_000, overtimeHours: { weekly: 10 } })
    expect(avec.its.net).toBeGreaterThan(nu.its.net)
    expect(avec.net.payable).toBeGreaterThan(nu.net.payable)
    expect(avec.employerCost).toBeGreaterThan(nu.employerCost)
    expect(avec.lines.some((l) => /Heures supp/.test(l.label))).toBe(true)
  })

  it('une durée hebdomadaire plus longue abaisse le taux horaire', async () => {
    const h40 = await ok({ baseSalary: 300_000, weeklyHours: 40, overtimeHours: { weekly: 5 } })
    const h48 = await ok({ baseSalary: 300_000, weeklyHours: 48, overtimeHours: { weekly: 5 } })
    expect(h48.overtime.total).toBeLessThan(h40.overtime.total)
  })

  it('refuse une nature que le pays ne paramètre pas, au lieu d’inventer un taux', async () => {
    // Le Sénégal ne déclare pas de nuit de dimanche/férié distincte.
    const res = await simulate({
      baseSalary: 300_000, countryCode: 'SEN', overtimeHours: { sundayHolidayNight: 4 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('OVERTIME_NOT_CONFIGURED')
  })

  it('expose les natures paramétrées du pays, pour que l’écran n’en propose pas d’autres', async () => {
    const ci = await ok({ baseSalary: 300_000, countryCode: 'CIV' })
    expect(ci.pack.overtimeRates).toMatchObject({ weekly: 0.15, night: 0.75 })
    const sn = await ok({ baseSalary: 300_000, countryCode: 'SEN' })
    expect(sn.pack.overtimeRates?.sundayHolidayNight).toBeUndefined()
  })

  it('zéro heure saisie ne crée aucune ligne', async () => {
    const r = await ok({ baseSalary: 300_000, overtimeHours: { weekly: 0, night: 0 } })
    expect(r.overtime.lines).toEqual([])
    expect(r.overtime.total).toBe(0)
  })
})

describe('Avantages en nature', () => {
  it('sont soumis aux cotisations et à l’impôt', async () => {
    const nu   = await ok({ baseSalary: 300_000 })
    const avec = await ok({ baseSalary: 300_000, benefitsInKind: 50_000 })
    expect(avec.its.base).toBeGreaterThan(nu.its.base)
    expect(avec.its.net).toBeGreaterThan(nu.its.net)
    expect(avec.lines.some((l) => /nature/i.test(l.label))).toBe(true)
  })
})

describe('Niveau de qualification — repère, jamais un montant', () => {
  it('ne change aucun montant du calcul', async () => {
    const sans = await ok({ baseSalary: 300_000 })
    const bac8 = await ok({ baseSalary: 300_000, qualificationLevel: 'bac8' })
    expect(bac8.net.payable).toBe(sans.net.payable)
    expect(bac8.its.net).toBe(sans.its.net)
    expect(bac8.employerCost).toBe(sans.employerCost)
  })

  it('positionne le profil et le dit indicatif', async () => {
    const r = await ok({ baseSalary: 300_000, qualificationLevel: 'bac5' })
    expect(r.positioning.usualJobLevel).toBe('cadre')
    expect(r.positioning.note).toMatch(/aucun montant n'en dépend/i)
  })

  it('signale l’écart entre le diplôme et le salaire, sans le corriger', async () => {
    const r = await ok({ baseSalary: 120_000, qualificationLevel: 'bac5' })
    expect(r.positioning.aligned).toBe(false)
    expect(r.positioning.usualJobLevel).toBe('cadre')
    expect(r.positioning.salaryJobLevel).toBe('employe')
  })

  it('refuse un niveau inconnu', async () => {
    const res = await simulate({ baseSalary: 300_000, qualificationLevel: 'bac12' })
    expect(res.statusCode).toBe(400)
  })
})

describe('Deux usages : embauche projetée et revalorisation', () => {
  it('compare deux salaires à profil identique et chiffre l’écart', async () => {
    const r = await ok({ baseSalary: 300_000, comparison: { baseSalary: 360_000 } })
    const c = r.comparison!
    expect(c.input.baseSalary).toBe(360_000)
    expect(c.delta.baseSalary).toBe(60_000)
    expect(c.delta.brut).toBe(60_000)
    expect(c.delta.brutPct).toBe(20)
    // Une augmentation de 60 000 brut ne donne pas 60 000 net : impôt et
    // cotisations en prennent une part, et le coût employeur monte plus vite.
    expect(c.delta.netPayable).toBeGreaterThan(0)
    expect(c.delta.netPayable).toBeLessThan(60_000)
    expect(c.delta.its).toBeGreaterThan(0)
    expect(c.delta.employerCost).toBeGreaterThan(c.delta.netPayable)
    expect(c.delta.netSharePct).toBeGreaterThan(0)
    expect(c.delta.netSharePct).toBeLessThan(100)
  })

  it('n’invente aucun second scénario quand on n’en demande pas', async () => {
    expect((await ok({ baseSalary: 300_000 })).comparison).toBeNull()
  })

  it('le profil (famille, ville, santé) reste commun : l’écart vient du salaire seul', async () => {
    const r = await ok({
      baseSalary: 300_000, maritalStatus: 'married', childrenCount: 3,
      transportAllowance: 30_000, city: 'Abidjan', cmuSpouseCovered: true,
      comparison: { baseSalary: 300_000 },
    })
    // Même salaire des deux côtés : écart nul partout.
    expect(r.comparison!.delta).toMatchObject({ brut: 0, netPayable: 0, its: 0, employerCost: 0 })
    expect(r.comparison!.delta.netSharePct).toBeNull()
  })

  it('emporte la prime d’ancienneté quand le pack l’assoit sur le salaire réel', async () => {
    // Le pack burkinabè assoit la prime sur le salaire de base réel : une
    // revalorisation augmente donc aussi la prime. (En CI l'assiette est le
    // minimum catégoriel : la prime ne bouge pas, et c'est voulu.)
    const r = await ok({
      baseSalary: 300_000, countryCode: 'BFA', seniorityYears: 10, payMonth: '2026-06',
      comparison: { baseSalary: 400_000 },
    })
    expect(r.comparison!.delta.brut).toBeGreaterThan(100_000)
  })

  it('accepte des primes différentes dans le second scénario', async () => {
    const r = await ok({
      baseSalary: 300_000, primes: 0, comparison: { baseSalary: 300_000, primes: 50_000 },
    })
    expect(r.comparison!.delta.baseSalary).toBe(0)
    expect(r.comparison!.delta.brut).toBe(50_000)
  })

  it('un salaire d’embauche sous le minimum légal est signalé des deux côtés', async () => {
    const r = await ok({ baseSalary: 300_000, comparison: { baseSalary: 60_000 } })
    expect(r.compliance.smig).toBe(true)
    expect(r.comparison!.net.smigCompliant).toBe(false)
  })
})
