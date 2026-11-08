/**
 * Application effective de la grille de classification.
 *
 * Le module existait déjà et savait tout dire : niveaux, catégories, décision
 * d'accès. Il ne décidait rien. Un client pouvait régler « Bulletins de paie =
 * Confidentiel, export interdit » et l'export CSV continuait de s'ouvrir — la
 * grille était un document, pas une règle, et un client l'ayant paramétrée
 * pouvait soutenir de bonne foi une protection qui n'existait pas.
 *
 * Ce banc tient les deux bords du branchement :
 *   - la grille paramétrée JOUE (refus d'export, masquage forcé) ;
 *   - un tenant qui n'a rien paramétré ne voit RIEN changer.
 *
 * Le second est le plus important : une fonctionnalité de conformité qui
 * ferme un export en production le jour de sa mise à jour est une panne.
 */
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
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))

import authPlugin from '../../plugins/auth.js'
import sageRoutes from '../sage/sage.routes.js'
import disciplineRoutes from '../discipline/discipline.routes.js'
import { invalidateClassificationPolicy } from '../../services/classification-policy.service.js'

/** Vide la politique en cache des schémas que ce banc utilise. */
function videCache(): void {
  for (const s of ['tenant_sotra']) invalidateClassificationPolicy(s)
}


const SCHEMA = 'tenant_sotra'
function token(app: FastifyInstance, role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}

/** Grille standard du provisioning : niveau 3 exportable, niveau 4 non. */
const NIVEAUX = [
  { level: 3, allowed_roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'dg', 'readonly'], export_allowed: true, encryption_required: true, audit_required: true },
  { level: 4, allowed_roles: ['admin', 'hr_manager', 'hr_officer'], export_allowed: false, encryption_required: true, audit_required: true },
]
const CATEGORIES = [
  { category_key: 'remuneration', level: 3 },
  { category_key: 'payslips', level: 3 },
]
const CFG = { id: 1, enabled: true, separator: 'semicolon', include_header: true, matricule_source: 'employee_number' }

/**
 * Répond à chaque requête selon la table visée — la route enchaîne grille,
 * config SAGE et données, et un enchaînement de `mockResolvedValueOnce`
 * casserait au premier changement d'ordre.
 */
function parTable(grille: { niveaux: unknown[]; categories: unknown[] } | 'absente') {
  queryMock.mockImplementation(async (sql: string) => {
    const s = String(sql)
    if (s.includes('classification_levels')) {
      if (grille === 'absente') throw Object.assign(new Error('relation absente'), { code: '42P01' })
      return { rows: grille.niveaux }
    }
    if (s.includes('data_classification_categories')) {
      if (grille === 'absente') throw Object.assign(new Error('relation absente'), { code: '42P01' })
      return { rows: grille.categories }
    }
    if (s.includes('sage_config')) return { rows: [CFG] }
    return { rows: [] }
  })
}

const GRILLE_STANDARD = { niveaux: NIVEAUX, categories: CATEGORIES }

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(sageRoutes, { prefix: '/sage' })
  await app.register(disciplineRoutes, { prefix: '/discipline' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
  // La politique est mise en cache 30 s : sans remise à zéro, un test hérite
  // de la grille du précédent.
  videCache()
})

const exporter = (role: string) => app.inject({
  method: 'GET', url: '/sage/export/employees.csv',
  headers: { authorization: `Bearer ${token(app, role)}` },
})

describe('Refus d’export piloté par la grille', () => {
  it('rôle autorisé par la grille : l’export se produit', async () => {
    parTable(GRILLE_STANDARD)
    const res = await exporter('hr_manager')
    expect(res.statusCode).toBe(200)
  })

  it('export FERMÉ au niveau du tenant : 403, et aucune donnée lue', async () => {
    parTable({
      niveaux: [{ ...NIVEAUX[0]!, export_allowed: false }],
      categories: CATEGORIES,
    })
    const res = await exporter('hr_manager')
    expect(res.statusCode).toBe(403)
    // Le refus vient AVANT la lecture : on ne sort pas les données du tenant
    // pour les jeter ensuite. On vise la requête d'export elle-même — le
    // préchargement des habilitations interroge aussi `employees`, et un
    // simple « aucune requête sur employees » serait faux pour cette raison.
    const requeteExport = queryMock.mock.calls.filter(c => String(c[0]).includes('matricule'))
    expect(requeteExport).toHaveLength(0)
    expect(queryMock.mock.calls.some(c => String(c[0]).includes('sage_config'))).toBe(false)
  })

  it('rôle retiré des rôles autorisés : 403', async () => {
    parTable({
      niveaux: [{ ...NIVEAUX[0]!, allowed_roles: ['admin'] }],
      categories: CATEGORIES,
    })
    expect((await exporter('hr_manager')).statusCode).toBe(403)
    // …et la décision du client vaut aussi pour l'administrateur : s'il s'est
    // laissé dans la liste, il passe.
    expect((await exporter('admin')).statusCode).toBe(200)
  })

  it('l’ADMIN n’est pas exempté quand le client l’a exclu', async () => {
    // C'est ce qui fait la différence entre une grille et un affichage : le
    // client doit pouvoir fermer une donnée à tout le monde, y compris à
    // l'administrateur de son propre tenant.
    parTable({
      niveaux: [{ ...NIVEAUX[0]!, allowed_roles: ['hr_manager'], export_allowed: true }],
      categories: CATEGORIES,
    })
    expect((await exporter('admin')).statusCode).toBe(403)
  })

  it('le message NOMME la catégorie et le niveau', async () => {
    parTable({ niveaux: [{ ...NIVEAUX[0]!, export_allowed: false }], categories: CATEGORIES })
    const res = await exporter('hr_manager')
    const body = JSON.parse(res.body) as { error: string; details: { category: string; level: number; levelKey: string } }
    // Sans cela, l'utilisateur ne peut ni comprendre le refus ni savoir à qui
    // demander la levée.
    expect(body.details).toMatchObject({ category: 'remuneration', level: 3, levelKey: 'confidential' })
    expect(body.error).toMatch(/classification/i)
  })

  it('le refus est CONSIGNÉ dans la piste d’audit', async () => {
    parTable({ niveaux: [{ ...NIVEAUX[0]!, export_allowed: false }], categories: CATEGORIES })
    await exporter('hr_manager')
    await new Promise(r => setImmediate(r))
    // Un export empêché est une information de conformité : sans trace, le
    // client n'a aucune preuve que sa grille a joué.
    const insert = queryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO "tenant_sotra".audit_log'))
    expect(insert).toBeDefined()
    expect(JSON.stringify(insert?.[1])).toContain('classification.export_refused')
    expect(JSON.stringify(insert?.[1])).toContain('remuneration')
  })
})

describe('Non-régression sur les tenants non paramétrés', () => {
  it('module non provisionné : l’export se produit comme avant', async () => {
    parTable('absente')
    expect((await exporter('hr_manager')).statusCode).toBe(200)
  })

  it('grille présente mais catégorie non cartographiée : export inchangé', async () => {
    parTable({ niveaux: NIVEAUX, categories: [{ category_key: 'organigramme', level: 1 }] })
    expect((await exporter('hr_manager')).statusCode).toBe(200)
  })

  it('grille vide : export inchangé, et surtout pas tout fermé', async () => {
    parTable({ niveaux: [], categories: [] })
    expect((await exporter('hr_manager')).statusCode).toBe(200)
  })

  it('base en erreur passagère : l’export n’est pas refusé à tort', async () => {
    // Refuser sur panne transformerait un incident d'infrastructure en
    // suspicion de non-conformité pour l'utilisateur.
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (s.includes('classification_')) throw Object.assign(new Error('coupure'), { code: '57P01' })
      if (s.includes('sage_config')) return { rows: [CFG] }
      return { rows: [] }
    })
    expect((await exporter('hr_manager')).statusCode).toBe(200)
  })
})

describe('Niveau 4 (Restreint) appliqué au disciplinaire', () => {
  /** Grille où le niveau 4 est cartographié sur les sanctions. */
  function grilleNiveau4(rolesAutorises: string[]) {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (s.includes('classification_levels')) {
        return { rows: [{ level: 4, allowed_roles: rolesAutorises, export_allowed: false, encryption_required: true, audit_required: true }] }
      }
      if (s.includes('data_classification_categories')) {
        return { rows: [{ category_key: 'disciplinary', level: 4 }] }
      }
      return { rows: [] }
    })
  }

  const lister = (role: string) => app.inject({
    method: 'GET', url: '/discipline',
    headers: { authorization: `Bearer ${token(app, role)}` },
  })

  it('rôle autorisé : la liste s’ouvre', async () => {
    grilleNiveau4(['admin', 'hr_manager', 'hr_officer'])
    expect((await lister('hr_officer')).statusCode).toBe(200)
  })

  it('rôle exclu par la grille : 404, et non 403', async () => {
    // Répondre « interdit » sur une donnée restreinte confirmerait qu'il
    // existe une sanction — précisément l'information à protéger.
    grilleNiveau4(['admin', 'hr_manager'])
    const res = await lister('hr_officer')
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toMatch(/classification|restreint|interdit/i)
  })

  it('le détail est fermé aussi, pas seulement la liste', async () => {
    grilleNiveau4(['admin'])
    const res = await app.inject({
      method: 'GET', url: '/discipline/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${token(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('l’ENREGISTREMENT d’une sanction est fermé aussi', async () => {
    // Fermer la lecture en laissant l'écriture ouverte permettrait de créer
    // des sanctions qu'on ne pourrait plus relire.
    grilleNiveau4(['admin'])
    const res = await app.inject({
      method: 'POST', url: '/discipline',
      headers: { authorization: `Bearer ${token(app, 'hr_manager')}` },
      payload: { employeeId: '11111111-1111-1111-1111-111111111111', type: 'warning', actionDate: '2026-11-08', reason: 'motif' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('le refus d’accès est CONSIGNÉ', async () => {
    grilleNiveau4(['admin'])
    await lister('hr_manager')
    await new Promise(r => setImmediate(r))
    const insert = queryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO "tenant_sotra".audit_log'))
    expect(JSON.stringify(insert?.[1])).toContain('classification.access_refused')
  })

  it('la consultation AUTORISÉE est journalisée quand le niveau l’exige', async () => {
    // `audit_required` du niveau 4 était un affichage : sans cet appel, le
    // réglage ne produisait aucune trace.
    grilleNiveau4(['admin', 'hr_manager'])
    await lister('hr_manager')
    await new Promise(r => setImmediate(r))
    const inserts = queryMock.mock.calls.filter(c => String(c[0]).includes('INSERT INTO "tenant_sotra".audit_log'))
    expect(JSON.stringify(inserts.map(c => c[1]))).toContain('classification.sensitive_access')
  })

  it('module non provisionné : le disciplinaire reste accessible comme avant', async () => {
    parTable('absente')
    expect((await lister('hr_officer')).statusCode).toBe(200)
  })
})
