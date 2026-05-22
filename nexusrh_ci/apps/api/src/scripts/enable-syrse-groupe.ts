#!/usr/bin/env tsx
/**
 * Crée le tenant "Syrse Groupe" pour démontrer le workflow paie multi-pays.
 *
 * Scénario réel décrit par le user :
 *   « Le groupe Syrse a son siège à Abidjan. Le service paie initie le draft
 *     et le partage aux filiales (Tchad, Bénin, Congo). Chaque RAF y ajoute
 *     les inputs réglementaires propres à son pays. Le siège consolide
 *     puis lance la paie sur la base du draft consolidé. »
 *
 * Création :
 *   - Tenant `syrse-groupe` (schéma tenant_syrse_groupe) — has_subsidiaries=true
 *   - 1 admin RH siège  : admin@syrse-groupe.ci         / Admin1234!
 *   - 4 filiales :
 *       a. Siège Abidjan (CIV)          AT 2% services
 *       b. Filiale Tchad (TCD)          AT 3% (BTP/services)
 *       c. Filiale Bénin (BEN)          AT 2.5%
 *       d. Filiale Congo (COD)          AT 4% (industrie)
 *   - 4 RAF :
 *       raf.abidjan@syrse-groupe.ci      / Admin1234!
 *       raf.tchad@syrse-groupe.ci        / Admin1234!
 *       raf.benin@syrse-groupe.ci        / Admin1234!
 *       raf.congo@syrse-groupe.ci        / Admin1234!
 *   - 4 employés de test, 1 par filiale, salaire 500 000 FCFA
 *
 * Note packs législatifs :
 *   Pour la démo, TOUTES les filiales utilisent CIV-2024 (seul pack actif).
 *   En production, activer TCD-2024 / BEN-2024 / COD-2024 dans
 *   apps/api/src/services/legislation-packs.ts après validation par un
 *   expert paie local de chaque pays (status: 'stub' → 'active').
 *   La filiale conserve son `country_code` pour signaler à l'admin
 *   quel pack devra être activé.
 *
 * Idempotent : peut être relancé sans risque.
 *
 * Usage : pnpm --filter api run demo:syrse-groupe
 */
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'
import { provisionTenantSchema } from '../db/provisioning.js'
import { ensureTenantSchema } from '../utils/schema-migrations.js'

const pool = new Pool({ connectionString: config.database.url })
const SCHEMA  = 'tenant_syrse_groupe'
const SLUG    = 'syrse-groupe'
const NAME    = 'Syrse Groupe'
const COMMON_PW = 'Admin1234!'

async function main(): Promise<void> {
  console.log(`▶ Création tenant ${NAME} (multi-pays)...\n`)

  // 1) Crée le tenant platform (UPSERT)
  await pool.query(`
    INSERT INTO platform.tenants
      (slug, name, schema_name, plan_type, status,
       primary_color, secondary_color, city,
       has_subsidiaries, default_country_code, payroll_mode)
    VALUES ($1, $2, $3, 'business', 'active',
            '#1E3A8A', '#3B82F6', 'Abidjan',
            true, 'CIV', 'multi_country')
    ON CONFLICT (slug) DO UPDATE SET
      has_subsidiaries = true,
      default_country_code = 'CIV',
      payroll_mode = 'multi_country',
      status = 'active'
  `, [SLUG, NAME, SCHEMA])
  console.log(`  ✓ Tenant platform inscrit (slug=${SLUG}, multi-pays activé)`)

  // 2) Provisionne le schéma + migrations lazy
  await provisionTenantSchema(SCHEMA)
  await ensureTenantSchema(SCHEMA)
  console.log(`  ✓ Schéma ${SCHEMA} provisionné`)

  // 3) Admin siège
  const adminPwHash = await bcrypt.hash(COMMON_PW, 12)
  await pool.query(`
    INSERT INTO "${SCHEMA}".users (email, password_hash, role, first_name, last_name, is_active, last_login_at)
    VALUES ('admin@syrse-groupe.ci', $1, 'admin', 'Salif', 'Touré', true, now())
    ON CONFLICT (email) DO UPDATE SET
      role = 'admin', is_active = true, password_hash = EXCLUDED.password_hash,
      last_login_at = COALESCE("${SCHEMA}".users.last_login_at, now())
  `, [adminPwHash])
  console.log(`  ✓ admin@syrse-groupe.ci (Salif Touré) → admin RH siège`)

  // 4) 4 RAF (un par filiale)
  const rafs = [
    { key: 'abidjan', email: 'raf.abidjan@syrse-groupe.ci',  firstName: 'Aïcha',    lastName: 'Diallo' },
    { key: 'tchad',   email: 'raf.tchad@syrse-groupe.ci',    firstName: 'Mahamat',  lastName: 'Idriss' },
    { key: 'benin',   email: 'raf.benin@syrse-groupe.ci',    firstName: 'Adèle',    lastName: 'Houngbo' },
    { key: 'congo',   email: 'raf.congo@syrse-groupe.ci',    firstName: 'Pascal',   lastName: 'Mboungou' },
  ]
  const rafIds = new Map<string, string>()
  for (const r of rafs) {
    const u = await pool.query<{ id: string }>(`
      INSERT INTO "${SCHEMA}".users (email, password_hash, role, first_name, last_name, is_active, last_login_at)
      VALUES ($1, $2, 'raf_site', $3, $4, true, now())
      ON CONFLICT (email) DO UPDATE SET
        role = 'raf_site', is_active = true,
        password_hash = EXCLUDED.password_hash,
        last_login_at = COALESCE("${SCHEMA}".users.last_login_at, now())
      RETURNING id
    `, [r.email, adminPwHash, r.firstName, r.lastName])
    rafIds.set(r.key, u.rows[0]!.id)
    console.log(`  ✓ ${r.email} (${r.firstName} ${r.lastName}) → RAF ${r.key}`)
  }

  // 5) 4 filiales (note : pack CIV-2024 partout pour la démo — voir entête)
  const filiales = [
    { key: 'abidjan', name: 'Syrse Siège Abidjan', city: 'Abidjan',     rccm: 'CI-ABJ-2018-B-001',
      cnpsNumber: 'CI-SIEGE-001', dgiNumber: 'CI-DGI-SIEGE',
      atRate: 0.02, packCode: 'CIV-2024', countryCode: 'CIV' },
    { key: 'tchad',   name: 'Syrse Tchad',         city: 'N\'Djamena',  rccm: 'TCD-NDJ-2020-1',
      cnpsNumber: 'TCD-CNPS-2024-A', dgiNumber: 'TCD-DGI-A',
      atRate: 0.03, packCode: 'CIV-2024', countryCode: 'TCD' },
    { key: 'benin',   name: 'Syrse Bénin',         city: 'Cotonou',     rccm: 'BEN-COT-2019-2',
      cnpsNumber: 'BEN-CNSS-2024-B', dgiNumber: 'BEN-DGI-B',
      atRate: 0.025, packCode: 'CIV-2024', countryCode: 'BEN' },
    { key: 'congo',   name: 'Syrse Congo',         city: 'Brazzaville', rccm: 'COD-BZV-2021-3',
      cnpsNumber: 'COD-CNSS-2024-C', dgiNumber: 'COD-DGI-C',
      atRate: 0.04, packCode: 'CIV-2024', countryCode: 'COD' },
  ]
  const leIds = new Map<string, string>()
  for (const f of filiales) {
    const rafId = rafIds.get(f.key)!
    // ON CONFLICT (name) si UNIQUE existe sinon plain INSERT (idempotence)
    const r = await pool.query<{ id: string }>(`
      INSERT INTO "${SCHEMA}".legal_entities
        (name, city, rccm, cnps_number, dgi_number, at_rate, legislation_pack_code,
         country_code, raf_user_id, legal_form, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SA', true)
      ON CONFLICT (name) DO UPDATE SET
        city = EXCLUDED.city,
        rccm = EXCLUDED.rccm,
        cnps_number = EXCLUDED.cnps_number,
        dgi_number = EXCLUDED.dgi_number,
        at_rate = EXCLUDED.at_rate,
        legislation_pack_code = EXCLUDED.legislation_pack_code,
        country_code = EXCLUDED.country_code,
        raf_user_id = EXCLUDED.raf_user_id,
        is_active = true
      RETURNING id
    `, [f.name, f.city, f.rccm, f.cnpsNumber, f.dgiNumber, f.atRate, f.packCode, f.countryCode, rafId])
      .catch(async () => pool.query<{ id: string }>(`
        INSERT INTO "${SCHEMA}".legal_entities
          (name, city, rccm, cnps_number, dgi_number, at_rate, legislation_pack_code,
           country_code, raf_user_id, legal_form, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SA', true)
        RETURNING id
      `, [f.name, f.city, f.rccm, f.cnpsNumber, f.dgiNumber, f.atRate, f.packCode, f.countryCode, rafId]))
    leIds.set(f.key, r.rows[0]!.id)
    console.log(`  ✓ Filiale "${f.name}" (${f.city}, ${f.countryCode}, CNPS ${f.cnpsNumber}, AT ${(f.atRate * 100).toFixed(1)}%)`)
  }

  // 6) 4 employés de test (1 par filiale), salaire 500 000 FCFA, marié 2 enfants
  const emps = [
    { key: 'abidjan', firstName: 'Yao',    lastName: 'Kouassi',  email: 'yao.kouassi@syrse.ci',     job: 'Directeur Adjoint' },
    { key: 'tchad',   firstName: 'Hassan', lastName: 'Mahamat',  email: 'hassan.mahamat@syrse.td',  job: 'Responsable Site' },
    { key: 'benin',   firstName: 'Marie',  lastName: 'Adjovi',   email: 'marie.adjovi@syrse.bj',    job: 'Chef Comptable' },
    { key: 'congo',   firstName: 'Patrice',lastName: 'Loemba',   email: 'patrice.loemba@syrse.cg',  job: 'Ingénieur' },
  ]
  for (const e of emps) {
    const leId = leIds.get(e.key)!
    await pool.query(`
      INSERT INTO "${SCHEMA}".employees
        (first_name, last_name, email, job_title, hire_date, base_salary,
         contract_type, is_active, marital_status, children_count,
         legal_entity_id, city)
      VALUES ($1, $2, $3, $4, '2022-01-15', 500000, 'cdi', true, 'married', 2, $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        legal_entity_id = EXCLUDED.legal_entity_id,
        base_salary = EXCLUDED.base_salary,
        is_active = true
    `, [e.firstName, e.lastName, e.email, e.job, leId, filiales.find(f => f.key === e.key)!.city])
    console.log(`  ✓ Employé ${e.firstName} ${e.lastName} → ${e.key}`)
  }

  console.log(`\n✅ Tenant Syrse Groupe prêt.\n`)
  console.log(`Connexion :`)
  console.log(`  ▸ admin@syrse-groupe.ci / ${COMMON_PW}      → RH siège (workflow + consolidation)`)
  console.log(`  ▸ raf.abidjan@syrse-groupe.ci               → RAF Siège Abidjan`)
  console.log(`  ▸ raf.tchad@syrse-groupe.ci                 → RAF Tchad`)
  console.log(`  ▸ raf.benin@syrse-groupe.ci                 → RAF Bénin`)
  console.log(`  ▸ raf.congo@syrse-groupe.ci                 → RAF Congo`)
  console.log(`  (mot de passe identique : ${COMMON_PW})\n`)
  console.log(`Workflow démo :`)
  console.log(`  1. admin@syrse-groupe → API POST /payroll-workflow/periods {month:"2024-12"}`)
  console.log(`  2. API POST /payroll-workflow/periods/:id/send-to-sites (auto-pop 4 filiales)`)
  console.log(`  3. Chaque RAF login → sidebar "Paie multi-pays" → /raf/periods → Soumettre`)
  console.log(`  4. admin → /payroll-workflow/periods/:id/validate-central → totaux consolidés`)
  console.log(`\n⚠️ IMPORTANT : un user déjà connecté avant ce script doit se DÉCONNECTER puis`)
  console.log(`   se reconnecter pour que tenantConfig.hasSubsidiaries=true soit pris en compte`)
  console.log(`   dans le JWT (la sidebar n'affiche "Paie multi-pays" qu'avec le nouveau JWT).`)

  await pool.end()
}

main().catch((err: unknown) => {
  console.error('Échec création tenant Syrse Groupe :', err)
  process.exit(1)
})
