/**
 * Golden test — Backward-compatibilité de la migration multi-pays sur les
 * JEUX DE DONNÉES DÉJÀ EXISTANTS (tenants provisionnés AVANT le module multi-pays).
 *
 * Contexte (cf. docs/MAINTENANCE.md §"Migration des schémas tenants") :
 *   `provisionTenantSchema()` porte à la fois la création initiale ET les
 *   évolutions de schéma tenant (colonnes multi-filiales, bascule de la clé
 *   d'unicité pay_periods). C'est exactement ce que rejoue `migrate-tenants.ts`
 *   sur CHAQUE tenant déjà en ligne (SOTRA, Cabinet, OpenLab, clients portail).
 *
 * La question à laquelle ce golden répond, sans DB :
 *   « En rejouant la migration sur un schéma qui contient déjà des données
 *     mono-pays, est-ce qu'on risque de perdre / casser ces données ? »
 *
 * Réponse prouvée ici par le CONTRAT SQL émis :
 *   1. NON-DESTRUCTIF  — aucun DROP TABLE / DROP COLUMN / TRUNCATE / DELETE /
 *                        DROP SCHEMA. La seule contrainte retirée est l'ancienne
 *                        UNIQUE(month) pleine (pay_periods_month_key), remplacée.
 *   2. ADDITIF         — toutes les colonnes multi-pays sont ADD COLUMN IF NOT
 *                        EXISTS (les lignes existantes sont rétro-remplies :
 *                        legal_entity_id = NULL, country_code = 'CIV').
 *   3. UNICITÉ PRÉSERVÉE — l'index (month, legal_entity_id) NULLS NOT DISTINCT
 *                        est, pour une ligne mono-pays (legal_entity_id NULL),
 *                        STRICTEMENT équivalent à l'ancien UNIQUE(month) : aucune
 *                        régression, tout en débloquant le parent + déclinaisons
 *                        site (multi-filiales) du même mois.
 *   4. IDEMPOTENT      — chaque CREATE/ALTER/INDEX est IF NOT EXISTS, le seul DROP
 *                        est IF EXISTS → rejouable autant de fois que nécessaire,
 *                        y compris sur un schéma déjà migré.
 *
 * Comme tout le reste de la suite, on mocke `pg` : on n'a pas besoin d'une vraie
 * base pour vérifier le contrat de migration (les statements DDL sont
 * data-indépendants). On capture les SQL émis et on les vérifie.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('pg', () => ({
  // provisionTenantSchema utilise désormais une transaction via pool.connect() :
  // le client transactionnel route ses query() vers le même queryMock pour que
  // les assertions sur le DDL exécuté restent valables (BEGIN/COMMIT inclus).
  Pool: vi.fn(() => ({
    query: queryMock,
    end: vi.fn(),
    connect: vi.fn().mockResolvedValue({ query: queryMock, release: vi.fn() }),
  })),
}))

vi.mock('../config.js', () => ({
  config: { env: 'test', database: { url: 'postgresql://test' } },
}))

import { provisionTenantSchema } from './provisioning.js'

const SCHEMA = 'tenant_legacy_monopays' // simule un tenant CIV pré-multi-pays

/** Toutes les requêtes SQL émises par un appel de migration, en texte brut. */
let sqls: string[] = []
/** Normalisé : espaces compactés, en majuscules — pour des regex robustes. */
let flat: string[] = []

async function runMigration(): Promise<string[]> {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
  await provisionTenantSchema(SCHEMA)
  return queryMock.mock.calls.map((c) => String(c[0]))
}

beforeAll(async () => {
  sqls = await runMigration()
  flat = sqls.map((s) => s.replace(/\s+/g, ' ').trim())
})

describe('Migration multi-pays — backward-compat sur données existantes', () => {
  it('émet bien des statements (la migration tourne)', () => {
    expect(sqls.length).toBeGreaterThan(20)
  })

  // ── 1. NON-DESTRUCTIF ──────────────────────────────────────────────────────
  it('ne contient AUCUN statement destructif de données', () => {
    const destructive = flat.filter((s) =>
      /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bDROP\s+SCHEMA\b/i.test(
        s,
      ),
    )
    expect(destructive).toEqual([])
  })

  it('le seul DROP est la bascule de clé : DROP CONSTRAINT IF EXISTS pay_periods_month_key', () => {
    const drops = flat.filter((s) => /\bDROP\s+CONSTRAINT\b/i.test(s))
    expect(drops.length).toBe(1)
    expect(drops[0]).toMatch(/DROP CONSTRAINT IF EXISTS pay_periods_month_key/i)
    // jamais un DROP "sec" sans IF EXISTS (sinon échec sur tenant sans la contrainte)
    expect(drops[0]).toMatch(/IF EXISTS/i)
  })

  // ── 2. ADDITIF (les lignes existantes sont rétro-remplies) ──────────────────
  it('ajoute les colonnes multi-pays en ADD COLUMN IF NOT EXISTS', () => {
    const expectedCols: Array<[string, string]> = [
      ['employees', 'legal_entity_id'],
      ['pay_slips', 'legal_entity_id'],
      ['pay_periods', 'legal_entity_id'],
      ['pay_periods', 'parent_period_id'],
      ['pay_periods', 'legislation_pack_code'],
      ['pay_periods', 'raf_user_id'],
      ['cnps_declarations', 'legal_entity_id'],
      ['disa_records', 'legal_entity_id'],
      ['legal_entities', 'country_code'],
      ['legal_entities', 'legislation_pack_code'],
    ]
    for (const [table, col] of expectedCols) {
      const re = new RegExp(
        `ALTER TABLE\\s+"?${SCHEMA}"?\\.${table}\\s+ADD COLUMN IF NOT EXISTS ${col}\\b`,
        'i',
      )
      expect(flat.some((s) => re.test(s)), `${table}.${col} doit être ajouté (idempotent)`).toBe(
        true,
      )
    }
  })

  it("country_code est rétro-rempli à 'CIV' pour les lignes existantes", () => {
    const re = new RegExp(
      `ALTER TABLE\\s+"?${SCHEMA}"?\\.legal_entities\\s+ADD COLUMN IF NOT EXISTS country_code varchar\\(3\\) NOT NULL DEFAULT 'CIV'`,
      'i',
    )
    expect(flat.some((s) => re.test(s))).toBe(true)
  })

  // ── 3. UNICITÉ PRÉSERVÉE (mono-pays) + multi-filiales débloqué ──────────────
  it('crée l’index unique (month, legal_entity_id) NULLS NOT DISTINCT', () => {
    const re = new RegExp(
      `CREATE UNIQUE INDEX IF NOT EXISTS \\S*pp_month_le\\S* ON\\s+"?${SCHEMA}"?\\.pay_periods \\(month, legal_entity_id\\) NULLS NOT DISTINCT`,
      'i',
    )
    expect(flat.some((s) => re.test(s))).toBe(true)
  })

  it('NULLS NOT DISTINCT ⇒ mono-pays (legal_entity_id NULL) reste unique par mois (≡ ancien UNIQUE(month))', () => {
    // Garde-fou sémantique : sans NULLS NOT DISTINCT, deux périodes mono-pays du
    // même mois (legal_entity_id NULL chacune) seraient autorisées → régression.
    const idx = flat.find((s) => /pp_month_le/i.test(s) && /CREATE UNIQUE INDEX/i.test(s))
    expect(idx).toBeDefined()
    expect(idx).toMatch(/NULLS NOT DISTINCT/i)
  })

  // ── 4. IDEMPOTENT (rejouable sur un schéma déjà existant / déjà migré) ──────
  it('toutes les créations de table sont IF NOT EXISTS', () => {
    const bad = flat.filter(
      (s) => /\bCREATE TABLE\b/i.test(s) && !/CREATE TABLE IF NOT EXISTS/i.test(s),
    )
    expect(bad).toEqual([])
  })

  it('tous les ADD COLUMN sont IF NOT EXISTS', () => {
    const bad = flat.filter(
      (s) => /\bADD COLUMN\b/i.test(s) && !/ADD COLUMN IF NOT EXISTS/i.test(s),
    )
    expect(bad).toEqual([])
  })

  it('toutes les créations d’index sont IF NOT EXISTS', () => {
    const bad = flat.filter(
      (s) => /\bCREATE\b.*\bINDEX\b/i.test(s) && !/CREATE (UNIQUE )?INDEX IF NOT EXISTS/i.test(s),
    )
    expect(bad).toEqual([])
  })

  it('rejouer la migration produit exactement le même contrat SQL (idempotence stricte)', async () => {
    const secondRun = (await runMigration()).map((s) => s.replace(/\s+/g, ' ').trim())
    expect(secondRun).toEqual(flat)
  })
})
