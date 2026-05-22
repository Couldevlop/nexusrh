#!/usr/bin/env tsx
/**
 * Bascule le tenant SOTRA en multi-filiales et prépare un environnement
 * de test du workflow parent/enfant (Palier 3).
 *
 * Crée :
 *   - SOTRA: has_subsidiaries=true, default_country_code='CIV'
 *   - 2 filiales actives :
 *       a. SOTRA Plateau   (Abidjan, CNPS CI-PLAT-001, at_rate 3% BTP)
 *       b. SOTRA Yamoussoukro (CNPS CI-YAM-002, at_rate 2% services)
 *   - 2 users RAF :
 *       raf.plateau@sotra.ci / Admin1234! (raf_site)
 *       raf.yamoussoukro@sotra.ci / Admin1234! (raf_site)
 *   - Assigne `legal_entities.raf_user_id` à chaque RAF
 *   - Distribue les employés actifs ~50/50 entre les 2 filiales
 *
 * Idempotent : à relancer sans risque.
 *
 * Usage : `pnpm --filter api run demo:multi-filiales`
 */
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'
import { ensureTenantSchema } from '../utils/schema-migrations.js'

const pool = new Pool({ connectionString: config.database.url })
const SCHEMA = 'tenant_sotra'
const RAF_PASSWORD = 'Admin1234!'

async function main(): Promise<void> {
  console.log('▶ Activation multi-filiales SOTRA...\n')

  // S'assurer que les colonnes multi-filiales existent (migration lazy)
  await ensureTenantSchema(SCHEMA)

  // 1) Bascule du tenant
  const t = await pool.query<{ id: string }>(
    `UPDATE platform.tenants
     SET has_subsidiaries = true,
         default_country_code = COALESCE(default_country_code, 'CIV'),
         payroll_mode = 'multi_country'
     WHERE schema_name = $1
     RETURNING id`,
    [SCHEMA],
  )
  if (!t.rows[0]) {
    console.error(`✗ Tenant ${SCHEMA} introuvable. Avez-vous lancé db:seed ?`)
    process.exit(1)
  }
  console.log(`  ✓ Tenant SOTRA basculé en has_subsidiaries=true`)

  // 2) Création / mise à jour des 2 RAF
  const passwordHash = await bcrypt.hash(RAF_PASSWORD, 12)
  const rafs = [
    { email: 'raf.plateau@sotra.ci',      firstName: 'Aïcha',   lastName: 'Diallo'  },
    { email: 'raf.yamoussoukro@sotra.ci', firstName: 'Kouassi', lastName: 'N\'Guessan' },
  ]
  const rafIds: string[] = []
  for (const r of rafs) {
    const u = await pool.query<{ id: string }>(
      `INSERT INTO "${SCHEMA}".users (email, password_hash, role, first_name, last_name, is_active)
       VALUES ($1, $2, 'raf_site', $3, $4, true)
       ON CONFLICT (email) DO UPDATE SET role = 'raf_site', is_active = true, password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [r.email, passwordHash, r.firstName, r.lastName],
    )
    rafIds.push(u.rows[0]!.id)
    console.log(`  ✓ RAF ${r.email} (${r.firstName} ${r.lastName}) ${u.rows[0]!.id.slice(0, 8)}…`)
  }

  // 3) Création des 2 filiales (avec raf_user_id auto-assigné)
  const filiales = [
    {
      name: 'SOTRA Plateau', city: 'Abidjan', rccm: 'CI-ABJ-2010-B-001',
      cnpsNumber: 'CI-PLAT-001-X', dgiNumber: 'CI-DGI-PLAT-001',
      atRate: 0.03, packCode: 'CIV-2024', countryCode: 'CIV',
      rafUserId: rafIds[0]!,
    },
    {
      name: 'SOTRA Yamoussoukro', city: 'Yamoussoukro', rccm: 'CI-YAM-2012-B-002',
      cnpsNumber: 'CI-YAM-002-Y', dgiNumber: 'CI-DGI-YAM-002',
      atRate: 0.02, packCode: 'CIV-2024', countryCode: 'CIV',
      rafUserId: rafIds[1]!,
    },
  ]
  const filialesIds: string[] = []
  for (const f of filiales) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO "${SCHEMA}".legal_entities
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
       RETURNING id`,
      [f.name, f.city, f.rccm, f.cnpsNumber, f.dgiNumber, f.atRate, f.packCode, f.countryCode, f.rafUserId],
    ).catch(async () => {
      // Fallback si UNIQUE sur (name) absent : INSERT sans ON CONFLICT
      return pool.query<{ id: string }>(
        `INSERT INTO "${SCHEMA}".legal_entities
           (name, city, rccm, cnps_number, dgi_number, at_rate, legislation_pack_code,
            country_code, raf_user_id, legal_form, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SA', true)
         RETURNING id`,
        [f.name, f.city, f.rccm, f.cnpsNumber, f.dgiNumber, f.atRate, f.packCode, f.countryCode, f.rafUserId],
      )
    })
    filialesIds.push(r.rows[0]!.id)
    console.log(`  ✓ Filiale "${f.name}" (CNPS ${f.cnpsNumber}, AT ${(f.atRate * 100).toFixed(1)}%) → RAF ${rafs[filiales.indexOf(f)]!.email}`)
  }

  // 4) Distribution des employés actifs ~50/50
  const emps = await pool.query<{ id: string }>(
    `SELECT id FROM "${SCHEMA}".employees WHERE is_active = true ORDER BY id`,
  )
  let idxPlateau = 0
  let idxYam = 0
  for (let i = 0; i < emps.rows.length; i++) {
    const targetId = i % 2 === 0 ? filialesIds[0] : filialesIds[1]
    await pool.query(
      `UPDATE "${SCHEMA}".employees SET legal_entity_id = $1 WHERE id = $2`,
      [targetId, emps.rows[i]!.id],
    )
    if (i % 2 === 0) idxPlateau++; else idxYam++
  }
  console.log(`  ✓ Employés distribués : ${idxPlateau} → Plateau, ${idxYam} → Yamoussoukro`)

  console.log(`\n✅ Multi-filiales SOTRA prêt.\n`)
  console.log(`Connectez-vous avec :`)
  console.log(`  ▸ admin@sotra.ci / Admin1234!                  → RH centrale (sélecteur filiale + workflow)`)
  console.log(`  ▸ raf.plateau@sotra.ci / Admin1234!            → RAF Plateau (voit uniquement sa filiale)`)
  console.log(`  ▸ raf.yamoussoukro@sotra.ci / Admin1234!       → RAF Yamoussoukro`)
  console.log(`\nWorkflow attendu :`)
  console.log(`  1. admin@sotra → /payroll → "Initier clôture" filiale Plateau (ou utiliser /payroll-workflow)`)
  console.log(`  2. POST /payroll-workflow/periods + /send-to-sites (auto-pop des 2 RAF)`)
  console.log(`  3. raf.plateau → /raf/periods → "Soumettre"`)
  console.log(`  4. raf.yamoussoukro → /raf/periods → "Soumettre"`)
  console.log(`  5. admin@sotra → /payroll-workflow/periods/:id/validate-central → totaux consolidés`)

  await pool.end()
}

main().catch((err: unknown) => {
  console.error('Échec activation multi-filiales :', err)
  process.exit(1)
})
