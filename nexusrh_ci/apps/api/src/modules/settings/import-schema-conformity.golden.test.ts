/**
 * Reprise de données — INVARIANT : toute colonne écrite par un import existe
 * réellement dans le schéma d'un tenant.
 *
 * ── Le défaut qui motive ce banc ────────────────────────────────────────────
 * L'import « Bulletins de paie » écrivait dans `pay_slips (…
 * employee_contributions, net_before_tax, income_tax …)`. Aucune de ces trois
 * colonnes n'a jamais existé : la table porte `total_cnps_sal`,
 * `total_deductions` et `its`. Chaque ligne importée échouait donc, et le
 * module entier était mort — sans qu'aucun test ne le voie, parce que les bancs
 * d'import existants simulent la base et acceptent n'importe quel INSERT.
 *
 * ── La parade ───────────────────────────────────────────────────────────────
 * On ne simule plus le schéma : on le LIT. `provisionTenantSchema` est exécuté
 * sur une base factice qui enregistre son DDL, d'où l'on extrait la liste
 * réelle des colonnes de chaque table. Chaque type d'import est ensuite joué,
 * et toute colonne citée par un INSERT ou un UPDATE est confrontée à cette
 * liste. Un renommage de colonne, ou une faute de frappe dans un import, casse
 * ce banc — pas la production.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// Le RIB importé est chiffré (AES-256) : la clé est lue à l'import du module
// de chiffrement, donc elle doit exister AVANT lui.
vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'a1b2c3d4'.repeat(8) })

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
    end: vi.fn(),
    connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
  })),
}))
vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  setTokenEpoch:      vi.fn().mockResolvedValue(undefined),
  getTokenEpoch:      vi.fn().mockResolvedValue(0),
}))
vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail: vi.fn().mockResolvedValue({ sent: true }),
  sendTestEmail:            vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@nexusrhci/shared/ssrf-guard', () => ({
  isSafeOutboundUrl:      vi.fn(async () => ({ ok: true as const })),
  assertSafeOutboundUrl:  vi.fn(async (raw: string) => new URL(raw)),
  assertSafeOutboundHost: vi.fn(async () => undefined),
  SsrfBlockedError:       class extends Error {},
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))
const { loadHabContextMock } = vi.hoisted(() => ({ loadHabContextMock: vi.fn() }))
vi.mock('../../services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})

import authPlugin from '../../plugins/auth.js'
import settingsRoutes from './settings.routes.js'
import { provisionTenantSchema } from '../../db/provisioning.js'

const SCHEMA = 'tenant_sotra'
const EMP = 'dddddddd-1111-4222-8333-444444444444'

// ── Lecture du schéma réel ──────────────────────────────────────────────────

/** Mots-clés d'une contrainte de table : ce n'est pas une colonne. */
const CONSTRAINT_RE = /^(primary|unique|foreign|constraint|check|exclude)\b/i

/** Colonnes déclarées par un `CREATE TABLE` (hors contraintes de table). */
function columnsOfCreate(body: string): string[] {
  const cols: string[] = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { cols.push(current); current = ''; continue }
    current += ch
  }
  cols.push(current)
  return cols
    .map((c) => c.trim())
    .filter((c) => c && !CONSTRAINT_RE.test(c))
    .map((c) => c.split(/\s+/)[0]!.replace(/"/g, ''))
}

/** table → colonnes, reconstruit depuis le DDL de provisionnement. */
function schemaFromDdl(statements: readonly string[]): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  const add = (table: string, cols: readonly string[]) => {
    const set = tables.get(table) ?? new Set<string>()
    for (const c of cols) set.add(c)
    tables.set(table, set)
  }
  for (const sql of statements) {
    const create = /CREATE TABLE (?:IF NOT EXISTS )?"?[a-z0-9_]+"?\.([a-z_]+)\s*\(([\s\S]*)\)/i.exec(sql)
    if (create) { add(create[1]!, columnsOfCreate(create[2]!)); continue }
    const alter = /ALTER TABLE "?[a-z0-9_]+"?\.([a-z_]+)\s+ADD COLUMN (?:IF NOT EXISTS )?"?([a-z_]+)"?/i.exec(sql)
    if (alter) add(alter[1]!, [alter[2]!])
  }
  return tables
}

// ── Lecture des colonnes écrites par un import ──────────────────────────────

const sqls = (): string[] => queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))

/** Colonnes citées par les INSERT / UPDATE joués, par table. */
function writtenColumns(): Map<string, Set<string>> {
  const written = new Map<string, Set<string>>()
  const add = (table: string, col: string) => {
    const set = written.get(table) ?? new Set<string>()
    set.add(col.replace(/"/g, '').trim())
    written.set(table, set)
  }
  for (const sql of sqls()) {
    const ins = /INSERT INTO "?[a-z0-9_]+"?\.([a-z_]+)\s*\(([^)]*)\)/i.exec(sql)
    if (ins) {
      for (const col of ins[2]!.split(',')) add(ins[1]!, col)
      // `ON CONFLICT … DO UPDATE SET col = …` cite les mêmes colonnes.
      const upsert = /DO UPDATE SET ([\s\S]*?)(?: WHERE | RETURNING |$)/i.exec(sql)
      if (upsert) {
        for (const assign of upsert[1]!.split(/,(?![^(]*\))/)) {
          const name = assign.split('=')[0]
          if (name?.trim()) add(ins[1]!, name)
        }
      }
      continue
    }
    const upd = /UPDATE "?[a-z0-9_]+"?\.([a-z_]+) SET ([\s\S]*?)(?: WHERE | RETURNING |$)/i.exec(sql)
    if (upd) {
      for (const assign of upd[2]!.split(/,(?![^(]*\))/)) {
        const name = assign.split('=')[0]
        if (name?.trim()) add(upd[1]!, name)
      }
    }
  }
  return written
}

/**
 * Les modèles CSV téléchargeables (SettingsPage.tsx → IMPORT_TEMPLATES) et une
 * ligne d'exemple par type. Le banc joue l'import tel qu'un client le ferait
 * avec le modèle fourni : un modèle incomplet ne produit pas d'écriture, un
 * modèle incorrect produit une écriture hors schéma.
 */
const IMPORTS: ReadonlyArray<{ type: string; headers: string[]; row: string[] }> = [
  {
    type: 'employees',
    headers: ['prenom','nom','email','date_naissance','telephone','poste','departement','date_embauche','salaire_brut','type_contrat','statut','sexe','numero_cnps','ville','matricule','heures_hebdo','categorie','iban','banque'],
    row: ['Kouamé','Konan','k.konan@entreprise.ci','1985-03-15','+225 07 12 34 56','Développeur','Engineering','2022-01-10','450000','CDI','active','M','CI-123456','Abidjan','MAT00101','40','C5','CI05 0000 1234','SGBCI'],
  },
  {
    type: 'departments',
    headers: ['nom','code','responsable_email'],
    row: ['Engineering','ENG','manager@entreprise.ci'],
  },
  {
    type: 'absences',
    headers: ['email_employe','type_absence','date_debut','date_fin','statut','motif'],
    row: ['k.konan@entreprise.ci','CP','2024-07-15','2024-07-26','approved','Congés annuels'],
  },
  {
    type: 'pay-slips',
    headers: ['email_employe','periode','salaire_brut','cotis_cnps_sal','its','net_paye','cout_employeur'],
    row: ['k.konan@entreprise.ci','2024-06','450000','28350','14700','407000','521400'],
  },
  {
    type: 'contracts',
    headers: ['email_employe','type_contrat','date_debut','date_fin','salaire_base','periode_essai_jours','convention_collective','lieu_travail'],
    row: ['k.konan@entreprise.ci','cdd','2022-01-10','2023-01-09','450000','60','Transport CI','Abidjan'],
  },
  {
    type: 'mobile-money',
    headers: ['email_employe','operateur','numero_telephone'],
    row: ['k.konan@entreprise.ci','wave','+225 07 12 34 56'],
  },
  {
    type: 'expenses',
    headers: ['email_employe','titre','mois','montant_total','statut'],
    row: ['k.konan@entreprise.ci','Déplacement client','2024-06','25000','approved'],
  },
]

let app: FastifyInstance
let tenantSchema: Map<string, Set<string>>

/** Base factice : chaque recherche trouve, sauf l'anti-doublon des bulletins. */
function stubDatabase(): void {
  queryMock.mockReset().mockImplementation(async (sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ')
    // Anti-doublons : bulletin du mois et département du même nom absents,
    // sinon les lignes seraient ignorées avant toute écriture.
    if (/SELECT id FROM "[a-z0-9_]+"\.pay_slips/i.test(s)) return { rows: [], rowCount: 0 }
    if (/SELECT id FROM "[a-z0-9_]+"\.departments WHERE name ILIKE/i.test(s)) return { rows: [], rowCount: 0 }
    if (/^SELECT/i.test(s.trim())) return { rows: [{ id: EMP }], rowCount: 1 }
    return { rows: [{ id: EMP }], rowCount: 1 }
  })
}

beforeAll(async () => {
  // 1. Le DDL réel d'un tenant, capté à travers la base factice.
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 })
  await provisionTenantSchema('tenant_conformity')
  tenantSchema = schemaFromDdl(sqls())

  app = Fastify()
  await app.register(authPlugin)
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  loadHabContextMock.mockReset().mockResolvedValue(null)
  stubDatabase()
})

function call(type: string, headers: string[], rows: string[][]) {
  const token = app.jwt.sign({
    sub: 'u-admin', tenantId: 't1', schemaName: SCHEMA, role: 'admin',
    email: 'admin@sotra.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
  return app.inject({
    method: 'POST', url: `/settings/import/${type}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { headers, rows },
  })
}

describe('Le DDL du tenant est bien lu', () => {
  it('les tables visées par les imports sont connues avec leurs colonnes', () => {
    for (const table of ['employees', 'departments', 'absences', 'pay_slips', 'pay_periods', 'contracts', 'expense_reports']) {
      expect(tenantSchema.get(table), `table ${table} absente du DDL`).toBeDefined()
      expect(tenantSchema.get(table)!.size).toBeGreaterThan(3)
    }
    // Garde-fou du banc : les colonnes fautives de l'ancien import n'existent pas.
    for (const ghost of ['employee_contributions', 'net_before_tax', 'income_tax']) {
      expect(tenantSchema.get('pay_slips')!.has(ghost)).toBe(false)
    }
  })
})

describe('Chaque import n’écrit que des colonnes existantes', () => {
  for (const { type, headers, row } of IMPORTS) {
    it(`${type} — colonnes conformes au schéma tenant`, async () => {
      const res = await call(type, headers, [row])
      expect(res.statusCode).toBe(200)
      // Le modèle doit mener à une écriture : sinon le banc ne prouve rien.
      const written = writtenColumns()
      const business = [...written.entries()].filter(([t]) => t !== 'audit_log')
      expect(business.length, `aucune écriture métier pour ${type}`).toBeGreaterThan(0)

      for (const [table, cols] of business) {
        const known = tenantSchema.get(table)
        expect(known, `table inconnue du schéma tenant : ${table}`).toBeDefined()
        const unknown = [...cols].filter((c) => !known!.has(c))
        expect(unknown, `colonnes absentes de ${table} : ${unknown.join(', ')}`).toEqual([])
      }
    })
  }
})

describe('Le modèle CSV des employés couvre les colonnes lues par le serveur', () => {
  it('RIB, banque, heures hebdomadaires et catégorie sont pris en compte', async () => {
    const emp = IMPORTS.find((i) => i.type === 'employees')!
    const res = await call(emp.type, emp.headers, [emp.row])
    expect(res.statusCode).toBe(200)
    const body = res.json() as { inserted: number; skipped: number; errors: string[] }
    expect(body.errors).toEqual([])
    expect(body.inserted).toBe(1)
    const cols = writtenColumns().get('employees')!
    for (const col of ['weekly_hours', 'professional_category', 'iban', 'bank_name']) {
      expect(cols.has(col), `colonne ${col} jamais écrite`).toBe(true)
    }
  })
})
