/**
 * Migration: Add `parameters` table to all existing tenant schemas.
 * Safe to run multiple times (idempotent).
 *
 * Run: pnpm --filter api run db:migrate-parameters
 */

import { Pool } from 'pg'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

dotenvConfig({ path: resolve(process.cwd(), '../../.env') })

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://nexusrh:nexusrh@localhost:5432/nexusrh'

const DEFAULT_PARAMETERS = [
  // ── Types de contrat ────────────────────────────────────────────────────────
  { category: 'contract_type', code: 'CDI',           label: 'CDI — Contrat à durée indéterminée',         sort_order:  1 },
  { category: 'contract_type', code: 'CDI_CHANTIER',  label: 'CDI de chantier ou d\'opération',            sort_order:  2 },
  { category: 'contract_type', code: 'CDD',           label: 'CDD — Contrat à durée déterminée',            sort_order:  3 },
  { category: 'contract_type', code: 'CDII',          label: 'CDII — Contrat à durée indéterminée intérimaire', sort_order: 4 },
  { category: 'contract_type', code: 'CTT',           label: 'CTT — Contrat de travail temporaire',        sort_order:  5 },
  { category: 'contract_type', code: 'APPRENTISSAGE', label: 'Contrat d\'apprentissage',                   sort_order:  6 },
  { category: 'contract_type', code: 'PROFESSIONNALISATION', label: 'Contrat de professionnalisation',     sort_order:  7 },
  { category: 'contract_type', code: 'STAGE',         label: 'Convention de stage',                        sort_order:  8 },
  { category: 'contract_type', code: 'PORTAGE',       label: 'Portage salarial',                           sort_order:  9 },
  { category: 'contract_type', code: 'FREELANCE',     label: 'Prestation freelance',                       sort_order: 10 },
  { category: 'contract_type', code: 'VIE',           label: 'VIE — Volontariat International en Entreprise', sort_order: 11 },
  { category: 'contract_type', code: 'MANDAT',        label: 'Mandat social (dirigeant)',                  sort_order: 12 },

  // ── Catégories de frais ─────────────────────────────────────────────────────
  { category: 'expense_category', code: 'TRAIN',        label: 'Train / Transports en commun longue distance', color: '#3B82F6', sort_order: 1 },
  { category: 'expense_category', code: 'AVION',        label: 'Billet d\'avion',                              color: '#6366F1', sort_order: 2 },
  { category: 'expense_category', code: 'TAXI_VTC',     label: 'Taxi / VTC (Uber, Bolt…)',                     color: '#8B5CF6', sort_order: 3 },
  { category: 'expense_category', code: 'TC',           label: 'Transports en commun (métro, bus…)',           color: '#A78BFA', sort_order: 4 },
  { category: 'expense_category', code: 'IK',           label: 'Indemnités kilométriques (véhicule perso)',    color: '#10B981', sort_order: 5 },
  { category: 'expense_category', code: 'PARKING',      label: 'Parking / Péage / Location voiture',           color: '#059669', sort_order: 6 },
  { category: 'expense_category', code: 'REPAS',        label: 'Repas déjeuner (salarié seul)',                color: '#F59E0B', sort_order: 7 },
  { category: 'expense_category', code: 'REPAS_CLIENT', label: 'Repas / dîner client (représentation)',        color: '#D97706', sort_order: 8 },
  { category: 'expense_category', code: 'HEBERGEMENT',  label: 'Hôtel / Hébergement',                         color: '#EF4444', sort_order: 9 },
  { category: 'expense_category', code: 'CADEAU',       label: 'Cadeaux clients / Relations publiques',        color: '#EC4899', sort_order: 10 },
  { category: 'expense_category', code: 'CONFERENCE',   label: 'Conférence / Salon professionnel',             color: '#14B8A6', sort_order: 11 },
  { category: 'expense_category', code: 'FORMATION',    label: 'Formation externe',                            color: '#06B6D4', sort_order: 12 },
  { category: 'expense_category', code: 'MATERIEL',     label: 'Matériel informatique / Équipement',          color: '#64748B', sort_order: 13 },
  { category: 'expense_category', code: 'LOGICIEL',     label: 'Logiciels / SaaS / Licences',                 color: '#475569', sort_order: 14 },
  { category: 'expense_category', code: 'FOURNITURES',  label: 'Fournitures de bureau / Papeterie',           color: '#94A3B8', sort_order: 15 },
  { category: 'expense_category', code: 'TEL',          label: 'Téléphonie / Internet',                       color: '#0EA5E9', sort_order: 16 },
  { category: 'expense_category', code: 'SANTE',        label: 'Santé / Médical (hors mutuelle)',              color: '#F43F5E', sort_order: 17 },
  { category: 'expense_category', code: 'AUTRE',        label: 'Autre frais professionnel',                   color: '#9CA3AF', sort_order: 18 },

  // ── Niveaux de poste ────────────────────────────────────────────────────────
  { category: 'job_level', code: 'IC1', label: 'IC1 — Stagiaire / Alternant',           sort_order:  1 },
  { category: 'job_level', code: 'IC2', label: 'IC2 — Junior (0–2 ans)',                sort_order:  2 },
  { category: 'job_level', code: 'IC3', label: 'IC3 — Confirmé (2–5 ans)',              sort_order:  3 },
  { category: 'job_level', code: 'IC4', label: 'IC4 — Sénior (5–8 ans)',               sort_order:  4 },
  { category: 'job_level', code: 'IC5', label: 'IC5 — Expert / Staff (8–12 ans)',       sort_order:  5 },
  { category: 'job_level', code: 'IC6', label: 'IC6 — Principal / Senior Staff (12+ ans)', sort_order: 6 },
  { category: 'job_level', code: 'IC7', label: 'IC7 — Distinguished / Fellow',          sort_order:  7 },
  { category: 'job_level', code: 'M1',  label: 'M1 — Team Lead',                        sort_order:  8 },
  { category: 'job_level', code: 'M2',  label: 'M2 — Manager',                          sort_order:  9 },
  { category: 'job_level', code: 'M3',  label: 'M3 — Senior Manager',                   sort_order: 10 },
  { category: 'job_level', code: 'M4',  label: 'M4 — Directeur',                        sort_order: 11 },
  { category: 'job_level', code: 'M5',  label: 'M5 — Directeur Senior / VP',            sort_order: 12 },
  { category: 'job_level', code: 'M6',  label: 'M6 — DG / SVP',                        sort_order: 13 },
  { category: 'job_level', code: 'M7',  label: 'M7 — C-Level (PDG, DRH, DAF…)',        sort_order: 14 },

  // ── Catégories de formation ─────────────────────────────────────────────────
  { category: 'training_category', code: 'DEV_LOGICIEL',  label: 'Développement logiciel & Web',        sort_order:  1 },
  { category: 'training_category', code: 'INFRA_CLOUD',   label: 'Infrastructure, Cloud & DevOps',      sort_order:  2 },
  { category: 'training_category', code: 'DATA_AI',       label: 'Data, IA & Machine Learning',         sort_order:  3 },
  { category: 'training_category', code: 'MANAGEMENT',    label: 'Management & Leadership',              sort_order:  4 },
  { category: 'training_category', code: 'AGILE',         label: 'Méthodes Agile & Gestion de projet',  sort_order:  5 },
  { category: 'training_category', code: 'COMMERCIAL',    label: 'Vente, Commercial & Négociation',     sort_order:  6 },
  { category: 'training_category', code: 'MARKETING',     label: 'Marketing, Communication & Digital',  sort_order:  7 },
  { category: 'training_category', code: 'FINANCE',       label: 'Finance, Comptabilité & Fiscalité',   sort_order:  8 },
  { category: 'training_category', code: 'RH_DROIT',      label: 'Ressources Humaines & Droit social',  sort_order:  9 },
  { category: 'training_category', code: 'JURIDIQUE',     label: 'Juridique, RGPD & Conformité',        sort_order: 10 },
  { category: 'training_category', code: 'BUREAUTIQUE',   label: 'Bureautique & Outils collaboratifs',  sort_order: 11 },
  { category: 'training_category', code: 'LANGUES',       label: 'Langues étrangères',                  sort_order: 12 },
  { category: 'training_category', code: 'SECURITE',      label: 'Sécurité, QHSE & Prévention des risques', sort_order: 13 },
  { category: 'training_category', code: 'DEV_PERSO',     label: 'Développement personnel & Soft skills', sort_order: 14 },
  { category: 'training_category', code: 'QUALITE',       label: 'Qualité, ISO & Certification',        sort_order: 15 },
  { category: 'training_category', code: 'RSE',           label: 'RSE & Développement durable',         sort_order: 16 },
  { category: 'training_category', code: 'SANTE_WORK',    label: 'Santé au travail & Bien-être',        sort_order: 17 },
  { category: 'training_category', code: 'AUTRE_FORM',    label: 'Autre',                               sort_order: 99 },

  // ── Conventions collectives ─────────────────────────────────────────────────
  { category: 'collective_agreement', code: 'CCN1486',  label: 'CCN 1486 — SYNTEC (Bureaux d\'études techniques)',                           sort_order:  1 },
  { category: 'collective_agreement', code: 'CCN1596',  label: 'CCN 1596 — Bâtiment (Ouvriers, ≥10 salariés)',                              sort_order:  2 },
  { category: 'collective_agreement', code: 'CCN1597',  label: 'CCN 1597 — Bâtiment (ETAM, ≥10 salariés)',                                 sort_order:  3 },
  { category: 'collective_agreement', code: 'CCN1702',  label: 'CCN 1702 — Bâtiment (Ouvriers, <10 salariés)',                             sort_order:  4 },
  { category: 'collective_agreement', code: 'CCN2609',  label: 'CCN 2609 — Bâtiment (Cadres)',                                             sort_order:  5 },
  { category: 'collective_agreement', code: 'CCN1492',  label: 'CCN 1492 — Commerce de détail alimentaire',                                sort_order:  6 },
  { category: 'collective_agreement', code: 'CCN1850',  label: 'CCN 1850 — Métallurgie (Accord national)',                                 sort_order:  7 },
  { category: 'collective_agreement', code: 'CCN16',    label: 'CCN 16 — Transports routiers et activités auxiliaires',                   sort_order:  8 },
  { category: 'collective_agreement', code: 'CCN1979',  label: 'CCN 1979 — HCR (Hôtels, cafés, restaurants)',                             sort_order:  9 },
  { category: 'collective_agreement', code: 'CCN3293',  label: 'CCN 3293 — Hospitalisation privée',                                        sort_order: 10 },
  { category: 'collective_agreement', code: 'CCN2120',  label: 'CCN 2120 — Banque (AFB)',                                                  sort_order: 11 },
  { category: 'collective_agreement', code: 'CCN1516',  label: 'CCN 1516 — Assurance',                                                    sort_order: 12 },
  { category: 'collective_agreement', code: 'CCN1527',  label: 'CCN 1527 — Immobilier',                                                   sort_order: 13 },
  { category: 'collective_agreement', code: 'CCN3043',  label: 'CCN 3043 — Propreté & services associés',                                 sort_order: 14 },
  { category: 'collective_agreement', code: 'CCN1351',  label: 'CCN 1351 — Pharmacie d\'officine',                                        sort_order: 15 },
  { category: 'collective_agreement', code: 'CCN1090',  label: 'CCN 1090 — Commerce de gros',                                             sort_order: 16 },
  { category: 'collective_agreement', code: 'CCN1710',  label: 'CCN 1710 — Grande distribution (grande surface)',                         sort_order: 17 },
  { category: 'collective_agreement', code: 'CCN3248',  label: 'CCN 3248 — Aide à domicile',                                              sort_order: 18 },
  { category: 'collective_agreement', code: 'CCN_NA',   label: 'Pas de convention collective applicable',                                 sort_order: 99 },
]

async function migrateParameters(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL })
  const client = await pool.connect()

  try {
    console.log('\n🔧 Migration: ajout de la table parameters aux schemas tenant...\n')

    // Get all existing tenant schemas
    const tenantsResult = await client.query<{ schema_name: string; name: string }>(
      `SELECT schema_name, name FROM platform.tenants WHERE status != 'deleted' ORDER BY name`
    )

    if (tenantsResult.rows.length === 0) {
      console.log('⚠️  Aucun tenant trouvé dans platform.tenants')
      return
    }

    console.log(`📋 ${tenantsResult.rows.length} tenant(s) trouvé(s)`)

    for (const tenant of tenantsResult.rows) {
      const s = tenant.schema_name
      console.log(`\n🏢 Migration du schema "${s}" (${tenant.name})...`)

      try {
        // 1. Create the parameters table (IF NOT EXISTS — safe if already there)
        await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
        await client.query(`
          CREATE TABLE IF NOT EXISTS "${s}".parameters (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            category VARCHAR(50) NOT NULL,
            code VARCHAR(100) NOT NULL,
            label VARCHAR(255) NOT NULL,
            color VARCHAR(20),
            metadata JSONB NOT NULL DEFAULT '{}',
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(category, code)
          )
        `)
        console.log(`  ✅ Table parameters créée / vérifiée`)

        // 2. Insert default parameters (ON CONFLICT DO NOTHING — idempotent)
        let inserted = 0
        for (const p of DEFAULT_PARAMETERS) {
          const result = await client.query(`
            INSERT INTO "${s}".parameters (category, code, label, color, sort_order)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (category, code) DO NOTHING
          `, [p.category, p.code, p.label, (p as Record<string, unknown>)['color'] ?? null, p.sort_order])
          inserted += result.rowCount ?? 0
        }
        console.log(`  ✅ ${inserted} paramètre(s) inséré(s) (${DEFAULT_PARAMETERS.length - inserted} déjà présents)`)

      } catch (err) {
        console.error(`  ❌ Erreur sur le schema "${s}":`, err)
      }
    }

    console.log('\n✅ Migration terminée avec succès !')
    console.log('💡 Rechargez l\'application dans le navigateur pour voir les listes déroulantes.\n')

  } finally {
    client.release()
    await pool.end()
  }
}

migrateParameters().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
