/**
 * Seed NexusRH CI — Données complètes et fonctionnelles
 * Tenant 1 : SOTRA (80 employés, transport Abidjan)
 * Tenant 2 : Cabinet Expertise CI (25 employés, cabinet conseil)
 */
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'
import {
  createPlatformSchema,
  createDroitCiSchema,
  provisionTenantSchema,
  seedPayrollRulesCI,
  seedAbsenceTypesCI,
} from './provisioning.js'
import { calculatePayrollCI } from '../services/payroll-engine-ci.js'
import { captureExistingCredentials, restorePreservedCredentials } from './seed-credentials.js'
import {
  monthOffsetStr,
  lastClosedMonths,
  dateOffsetStr,
  seedAbsencesBulk,
  recomputeAbsenceBalances,
  seedExpensesBulk,
  seedEnrollmentsBulk,
  seedSkillsEvaluationsBulk,
  seedHrEventsBulk,
  seedNotificationsBulk,
  seedMobileMoneyCampaign,
  seedCnpsDeclarationsFromPayslips,
  seedDisaFromPayslips,
  seedApplicationsForJob,
} from './seed-demo-data.js'

const pool = new Pool({ connectionString: config.database.url })

// ── Helpers ───────────────────────────────────────────────────────────────────
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T
}

function roundFCFA(n: number): number {
  return Math.floor(n / 100) * 100
}

function pastDate(monthsAgo: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - monthsAgo)
  return d.toISOString().split('T')[0] as string
}

function getWorkingDays(year: number, month: number): number {
  const days = new Date(year, month, 0).getDate()
  let working = 0
  for (let d = 1; d <= days; d++) {
    if (new Date(year, month - 1, d).getDay() !== 0) working++
  }
  return working
}

// ── Données Ivoiriennes ───────────────────────────────────────────────────────
const PRENOMS_H = ['Kouassi', 'Konan', 'Koffi', 'Yao', 'Yves', 'Mamadou', 'Ibrahim',
  'Abdoulaye', 'Sékou', 'Moussa', 'Jean-Baptiste', 'Paul', 'Eric', 'Serge', 'Thierry',
  'Marcel', 'Augustin', 'Raphaël', 'François', 'Emmanuel', 'Gilles', 'Patrick', 'Laurent',
  'Stéphane', 'Didier', 'Alain', 'Bruno', 'Christophe', 'Olivier', 'Nicolas']

const PRENOMS_F = ['Adjoua', 'Affoué', 'Akissi', 'Amenan', 'Assi', 'Fanta', 'Mariame',
  'Fatou', 'Aminata', 'Kadiatou', 'Marie-Claire', 'Sylvie', 'Christine', 'Isabelle',
  'Véronique', 'Nathalie', 'Sandrine', 'Carine', 'Delphine', 'Audrey', 'Carole',
  'Patricia', 'Florence', 'Monique', 'Evelyne', 'Nadège', 'Raïssa', 'Hortense']

const NOMS = ['Coulibaly', 'Diallo', 'Traoré', 'Koné', 'Bamba', 'Ouattara', 'Camara',
  'Kouyaté', 'Dembélé', 'Touré', 'Soro', 'Doumbia', 'Diabaté', 'N\'Goran', 'Ble',
  'Koffi', 'Kouamé', 'Assi', 'Yao', 'Konan', 'Aké', 'Kassi', 'Kouadio', 'Atta',
  'Ehui', 'Akré', 'Guédé', 'Zouhoula', 'Bah', 'Fadiga']

const MOBILE_PROVIDERS = ['wave', 'mtn_momo', 'orange_money'] as const
const MARITAL_STATUSES  = ['single', 'married', 'divorced', 'widowed'] as const
const CONTRACT_TYPES    = ['cdi', 'cdd', 'stage', 'intermittent'] as const

function ciPhone(operator: string): string {
  const prefix = operator === 'mtn_momo' ? '07' : operator === 'orange_money' ? '05' : '07'
  const num = String(randInt(10000000, 99999999))
  return `+225${prefix}${num}`
}

function nni(): string {
  return `CI${randInt(100000000, 999999999)}`
}

function cnpsNum(): string {
  return `CI${randInt(10000000, 99999999)}A`
}

// ── SOTRA départements & postes ───────────────────────────────────────────────
const SOTRA_DEPTS = [
  { name: 'Direction Générale',      code: 'DG',  size: 5,  baseSalaryRange: [300_000, 600_000] as [number, number] },
  { name: 'Exploitation',            code: 'EXP', size: 30, baseSalaryRange: [80_000, 180_000]  as [number, number] },
  { name: 'Maintenance',             code: 'MTN', size: 15, baseSalaryRange: [90_000, 200_000]  as [number, number] },
  { name: 'Finance & Comptabilité',  code: 'FIN', size: 8,  baseSalaryRange: [120_000, 280_000] as [number, number] },
  { name: 'Ressources Humaines',     code: 'RH',  size: 5,  baseSalaryRange: [120_000, 250_000] as [number, number] },
  { name: 'Commercial & Marketing',  code: 'COM', size: 6,  baseSalaryRange: [100_000, 220_000] as [number, number] },
  { name: 'Informatique',            code: 'IT',  size: 6,  baseSalaryRange: [150_000, 350_000] as [number, number] },
  { name: 'Sécurité',               code: 'SEC', size: 5,  baseSalaryRange: [75_000, 130_000]  as [number, number] },
]

const SOTRA_JOBS = {
  DG:  ['Directeur Général', 'DGA', 'Secrétaire de Direction', 'Conseiller Juridique', 'Assistante DG'],
  EXP: ['Conducteur de bus', 'Receveur', 'Chef de dépôt', 'Contrôleur', 'Régulateur', 'Dispatcher'],
  MTN: ['Mécanicien', 'Chef atelier', 'Carrossier', 'Électricien auto', 'Magasinier', 'Technicien'],
  FIN: ['Comptable', 'Contrôleur de gestion', 'Trésorier', 'DAF', 'Analyste financier', 'Auditeur interne'],
  RH:  ['Chargé RH', 'Gestionnaire paie', 'Responsable formation', 'DRH', 'Chargé recrutement'],
  COM: ['Commercial', 'Chef produit', 'Responsable marketing', 'Community manager', 'Chargé communication'],
  IT:  ['Développeur', 'Administrateur système', 'Chef de projet IT', 'DSI', 'Analyste', 'Technicien support'],
  SEC: ['Agent de sécurité', 'Chef sécurité', 'Rondier', 'Superviseur sécurité'],
}

// ── Cabinet Expertise CI départements ────────────────────────────────────────
const CABINET_DEPTS = [
  { name: 'Direction',        size: 3,  baseSalaryRange: [400_000, 800_000] as [number, number] },
  { name: 'Audit & Conseil',  size: 10, baseSalaryRange: [180_000, 450_000] as [number, number] },
  { name: 'Juridique',        size: 5,  baseSalaryRange: [200_000, 500_000] as [number, number] },
  { name: 'Administration',   size: 4,  baseSalaryRange: [100_000, 200_000] as [number, number] },
  { name: 'Finance',          size: 3,  baseSalaryRange: [150_000, 300_000] as [number, number] },
]

// ── Parcours d'intégration : modèles + parcours de démo ──────────────────────
interface SeedOnbStep {
  title: string; description: string; phase: string; owner: string; offset: number
  resources?: Array<{ type: string; title: string; url: string }>
}

const ONB_STEPS_STANDARD: SeedOnbStep[] = [
  { title: 'Signature du contrat et collecte des pièces', description: 'Contrat signé, CNI/NNI, RIB ou numéro Mobile Money, photo d\'identité.', phase: 'before_start', owner: 'hr', offset: -7,
    resources: [{ type: 'document', title: 'Liste des pièces à fournir', url: '' }] },
  { title: 'Préparation du poste de travail et des accès', description: 'Badge, uniforme le cas échéant, comptes informatiques, téléphone.', phase: 'before_start', owner: 'it', offset: -3 },
  { title: 'Annonce de l\'arrivée à l\'équipe', description: 'Message du manager à l\'équipe : rôle, parcours, date d\'arrivée.', phase: 'before_start', owner: 'manager', offset: -2 },
  { title: 'Désignation du parrain / de la marraine', description: 'Un pair expérimenté accompagne le nouveau collaborateur pendant 3 mois.', phase: 'before_start', owner: 'manager', offset: -2 },
  { title: 'Accueil et visite du site', description: 'Accueil RH, tour des locaux/dépôt, présentation des consignes de sécurité.', phase: 'day_one', owner: 'hr', offset: 0,
    resources: [{ type: 'document', title: 'Livret d\'accueil', url: '' }, { type: 'link', title: 'Site SOTRA', url: 'https://www.sotra.ci' }] },
  { title: 'Remise du matériel et des équipements', description: 'Matériel de travail, EPI, badge d\'accès, signature de la décharge.', phase: 'day_one', owner: 'it', offset: 0 },
  { title: 'Déjeuner d\'équipe', description: 'Premier déjeuner avec l\'équipe et le parrain.', phase: 'day_one', owner: 'buddy', offset: 0 },
  { title: 'Lire le règlement intérieur et le livret d\'accueil', description: 'Prendre connaissance des règles internes et confirmer la lecture.', phase: 'first_week', owner: 'employee', offset: 3,
    resources: [{ type: 'document', title: 'Règlement intérieur', url: '' }] },
  { title: 'Formation sécurité obligatoire', description: 'Module sécurité (consignes générales + spécifiques au poste).', phase: 'first_week', owner: 'hr', offset: 4,
    resources: [{ type: 'video', title: 'Vidéo consignes de sécurité', url: '' }] },
  { title: 'Point objectifs avec le manager', description: 'Définition des objectifs de la période d\'essai et des attendus du poste.', phase: 'first_week', owner: 'manager', offset: 5 },
  { title: 'Vérifier l\'immatriculation CNPS', description: 'S\'assurer que la déclaration CNPS du salarié est effective.', phase: 'first_week', owner: 'hr', offset: 5,
    resources: [{ type: 'link', title: 'Portail CNPS', url: 'https://www.cnps.ci' }] },
  { title: 'Compléter son profil dans NexusRH', description: 'Photo, téléphone, personne à prévenir, numéro Mobile Money.', phase: 'first_week', owner: 'employee', offset: 5 },
  { title: 'Rencontres des interlocuteurs clés', description: 'RH, paie, sécurité, représentants du personnel.', phase: 'first_month', owner: 'buddy', offset: 15 },
  { title: 'Point d\'étape à 30 jours', description: 'Feedback mutuel manager/collaborateur : intégration, charge, besoins de formation.', phase: 'first_month', owner: 'manager', offset: 30 },
  { title: 'Auto-évaluation de l\'intégration', description: 'Questionnaire de ressenti : accueil, clarté du rôle, outils, ambiance.', phase: 'first_month', owner: 'employee', offset: 30 },
  { title: 'Bilan de période d\'essai', description: 'Entretien de confirmation, décision et plan de développement.', phase: 'probation_end', owner: 'hr', offset: 85 },
]

const ONB_STEPS_CONDUCTEUR: SeedOnbStep[] = [
  { title: 'Vérification du permis et visite médicale', description: 'Permis D en cours de validité + aptitude médicale à la conduite.', phase: 'before_start', owner: 'hr', offset: -5 },
  { title: 'Dotation uniforme et carte professionnelle', description: 'Uniforme SOTRA, carte pro, badge dépôt.', phase: 'day_one', owner: 'hr', offset: 0 },
  { title: 'Formation conduite réseau et billettique', description: 'Prise en main des lignes, procédure billettique, gestes métiers.', phase: 'first_week', owner: 'manager', offset: 2,
    resources: [{ type: 'video', title: 'Procédures billettique', url: '' }] },
  { title: 'Conduite en double avec un titulaire', description: '3 jours de doublon avec un conducteur expérimenté (parrain).', phase: 'first_week', owner: 'buddy', offset: 3 },
  { title: 'Évaluation de conduite', description: 'Validation par le chef de dépôt avant affectation de ligne.', phase: 'first_month', owner: 'manager', offset: 12 },
  { title: 'Bilan de période d\'essai', description: 'Entretien de confirmation avec le chef de dépôt et les RH.', phase: 'probation_end', owner: 'hr', offset: 85 },
]

const ONB_STEPS_CADRE: SeedOnbStep[] = [
  { title: 'Préparation du dossier cadre', description: 'Contrat cadre, clauses spécifiques, véhicule/téléphone de fonction.', phase: 'before_start', owner: 'hr', offset: -7 },
  { title: 'Rendez-vous avec la Direction Générale', description: 'Présentation de la stratégie et des priorités de la direction.', phase: 'day_one', owner: 'manager', offset: 0 },
  { title: 'Tour des directions', description: 'Rencontre de chaque directeur : enjeux, attentes mutuelles.', phase: 'first_week', owner: 'manager', offset: 4 },
  { title: 'Lecture du plan stratégique', description: 'S\'approprier le plan stratégique et les indicateurs clés.', phase: 'first_week', owner: 'employee', offset: 5,
    resources: [{ type: 'document', title: 'Plan stratégique (interne)', url: '' }] },
  { title: 'Feuille de route à 90 jours', description: 'Construire et présenter sa feuille de route 30/60/90 jours.', phase: 'first_month', owner: 'employee', offset: 21 },
  { title: 'Point d\'étape à 45 jours', description: 'Revue de la feuille de route avec le N+1.', phase: 'first_month', owner: 'manager', offset: 45 },
  { title: 'Bilan de période d\'essai cadre', description: 'Entretien de confirmation (3 mois, renouvelable).', phase: 'probation_end', owner: 'hr', offset: 85 },
]

async function seedOnboarding(
  schema: string,
  employeeIds: string[],
  includeTransportTemplate = true,
): Promise<void> {
  const insertTemplate = async (
    name: string, description: string, seniority: string, keywords: string | null,
    isDefault: boolean, steps: SeedOnbStep[],
  ): Promise<string> => {
    const tpl = await pool.query<{ id: string }>(`
      INSERT INTO "${schema}".onboarding_templates (name, description, seniority, job_keywords, is_default, is_active)
      VALUES ($1, $2, $3, $4, $5, true) RETURNING id
    `, [name, description, seniority, keywords, isDefault])
    let order = 0
    for (const s of steps) {
      await pool.query(`
        INSERT INTO "${schema}".onboarding_template_steps
          (template_id, title, description, phase, owner_role, due_offset_days, sort_order, resources)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [tpl.rows[0]!.id, s.title, s.description, s.phase, s.owner, s.offset, order++, JSON.stringify(s.resources ?? [])])
    }
    return tpl.rows[0]!.id
  }

  const tplStandardId = await insertTemplate(
    'Parcours d\'intégration standard',
    'Parcours générique : pré-boarding, jour J, première semaine, premier mois, fin de période d\'essai.',
    'any', null, true, ONB_STEPS_STANDARD)
  if (includeTransportTemplate) {
    await insertTemplate(
      'Intégration Conducteur & Agents terrain',
      'Parcours métier transport : permis, doublon avec un titulaire, évaluation de conduite.',
      'any', 'conducteur, chauffeur, receveur, contrôleur, régulateur', false, ONB_STEPS_CONDUCTEUR)
  }
  await insertTemplate(
    'Intégration Cadre & Management',
    'Parcours cadre : immersion direction, feuille de route 30/60/90, bilan d\'essai renforcé.',
    'cadre', 'chef, responsable, directeur, drh, daf, dsi, manager', false, ONB_STEPS_CADRE)

  // Parcours de démo : instanciation manuelle (dates relatives à AUJOURD'HUI
  // pour une démo réaliste : étapes faites, en cours, et une en retard).
  const dayOffset = (n: number): string => {
    const d = new Date(); d.setDate(d.getDate() + n)
    return d.toISOString().slice(0, 10)
  }
  const createJourney = async (employeeId: string, startedDaysAgo: number, doneRatio: number): Promise<void> => {
    const j = await pool.query<{ id: string }>(`
      INSERT INTO "${schema}".onboarding_journeys (employee_id, template_id, template_name, status, started_at)
      VALUES ($1, $2, 'Parcours d''intégration standard', 'in_progress', now() - interval '${startedDaysAgo} days')
      RETURNING id
    `, [employeeId, tplStandardId])
    const total = ONB_STEPS_STANDARD.length
    const doneCount = Math.floor(total * doneRatio)
    for (let i = 0; i < total; i++) {
      const s = ONB_STEPS_STANDARD[i]!
      const status = i < doneCount ? 'done' : i === doneCount ? 'in_progress' : 'todo'
      await pool.query(`
        INSERT INTO "${schema}".onboarding_steps
          (journey_id, title, description, phase, owner_role, status, due_date, sort_order, resources, completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10 THEN now() ELSE NULL END)
      `, [j.rows[0]!.id, s.title, s.description, s.phase, s.owner, status,
          dayOffset(s.offset - startedDaysAgo), i, JSON.stringify(s.resources ?? []),
          status === 'done'])
    }
    // Statut du parcours recalculé si tout est terminé
    if (doneRatio >= 1) {
      await pool.query(
        `UPDATE "${schema}".onboarding_journeys SET status = 'completed', completed_at = now() WHERE id = $1`,
        [j.rows[0]!.id])
    }
  }

  // Kouassi (employe@sotra.ci) : parcours bien entamé, avec une étape en retard
  if (employeeIds[0]) await createJourney(employeeIds[0], 10, 0.45)
  // Deux autres recrues : un parcours qui démarre + un parcours terminé
  if (employeeIds[1]) await createJourney(employeeIds[1], 1, 0)
  if (employeeIds[2]) await createJourney(employeeIds[2], 95, 1)
}

// ── Main seed ─────────────────────────────────────────────────────────────────
const TENANT_SCHEMAS = ['tenant_sotra', 'tenant_cabinet_expertise_ci', 'tenant_openlab_consulting']

async function runSeed(): Promise<void> {
  console.log('NexusRH CI — Initialisation du seed...')

  // Nettoyage idempotent : drop des schémas tenant pour repartir propre
  for (const schema of TENANT_SCHEMAS) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    console.log(`[0] Schéma ${schema} supprimé (reset)`)
  }

  await createPlatformSchema()
  await createDroitCiSchema()
  console.log('[1/10] Schémas platform + droit_ci créés')

  // Seed référentiel juridique (PostgreSQL → Elasticsearch)
  try {
    const { seedReferentiel } = await import('../modules/referentiels/referentiels.service.js')
    const { persisted, indexed } = await seedReferentiel()
    console.log(`[1b] Référentiel juridique : ${persisted} articles PG, ${indexed} indexés ES`)
  } catch (e: any) {
    console.warn('[1b] Référentiel ES indisponible (non bloquant):', e.message)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SUPER ADMIN
  // ─────────────────────────────────────────────────────────────────────────────
  const superAdminHash = await bcrypt.hash('SuperAdmin1234!', 12)
  await pool.query(`
    INSERT INTO platform.platform_users (email, password_hash, first_name, last_name, role, is_active)
    VALUES ('superadmin@nexusrh-ci.com', $1, 'Super', 'Admin', 'super_admin', true)
    ON CONFLICT (email) DO NOTHING
  `, [superAdminHash])
  // (DO NOTHING : un mot de passe super_admin changé survit au re-seed)
  console.log('[2/10] Super admin créé: superadmin@nexusrh-ci.com / SuperAdmin1234!')

  // ─────────────────────────────────────────────────────────────────────────────
  // Sourcing IA — Configuration paramétrable initiale
  // (idempotent, DO UPDATE pour permettre rafraîchissement après modif tarifs)
  // ─────────────────────────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO platform.ai_models
      (provider, model_id, display_name, max_tokens,
       input_cost_per_1m_eur, output_cost_per_1m_eur, is_active, sort_order)
    VALUES
      ('claude',  'claude-sonnet-4-20250514', 'Claude Sonnet 4',  4000, 2.76, 13.80, true, 10),
      ('claude',  'claude-opus-4-20250514',   'Claude Opus 4',    4000, 13.80, 69.00, false, 11),
      ('claude',  'claude-haiku-4-5-20251001','Claude Haiku 4.5', 4000, 0.74, 3.68, false, 12),
      ('mistral', 'mistral-large-latest',     'Mistral Large',    4000, 1.84, 5.52,  true, 20),
      ('mistral', 'mistral-small-latest',     'Mistral Small',    4000, 0.18, 0.55,  false, 21)
    ON CONFLICT (provider, model_id) DO UPDATE SET
      display_name           = EXCLUDED.display_name,
      max_tokens             = EXCLUDED.max_tokens,
      input_cost_per_1m_eur  = EXCLUDED.input_cost_per_1m_eur,
      output_cost_per_1m_eur = EXCLUDED.output_cost_per_1m_eur,
      sort_order             = EXCLUDED.sort_order,
      updated_at             = now()
  `)

  await pool.query(`
    INSERT INTO platform.sourcing_platforms
      (code, name, country_code, url, est_pool, is_active, is_panafrican, sort_order)
    VALUES
      ('linkedin',      'LinkedIn',      NULL, 'https://linkedin.com', 50000, true, true, 1),
      ('africawork',    'Africawork',    NULL, 'https://africawork.com', 8000, true, true, 2),
      ('jobnetafrica',  'JobnetAfrica',  NULL, 'https://jobnetafrica.com', 3000, true, true, 3),
      ('indeed',        'Indeed',        NULL, 'https://indeed.com', 20000, true, true, 4),
      ('glassdoor',     'Glassdoor',     NULL, 'https://glassdoor.com', 5000, true, true, 5),
      ('emploi_ci',     'Emploi.ci',     'CI', 'https://www.emploi.ci', 1500, true, false, 10),
      ('rmo_ci',        'RMO Côte d''Ivoire', 'CI', NULL, 800, true, false, 11),
      ('novojob',       'Novojob',       'CI', 'https://www.novojob.com', 600, true, false, 12),
      ('emploi_sn',     'Emploi.sn',     'SN', 'https://www.emploi.sn', 1200, true, false, 20),
      ('senjob',        'Senjob',        'SN', 'https://www.senjob.com', 700, true, false, 21),
      ('emploi_bj',     'EmploiBénin',   'BJ', NULL, 400, true, false, 30),
      ('emploi_tg',     'Emploi-Togo',   'TG', NULL, 300, true, false, 40),
      ('minajobs',      'MinaJobs',      'CM', NULL, 900, true, false, 50),
      ('jobberman',     'Jobberman',     'NG', 'https://www.jobberman.com', 4000, true, false, 60),
      ('myjobmag',      'MyJobMag',      'NG', 'https://www.myjobmag.com', 2500, true, false, 61),
      ('jobberman_gh',  'Jobberman Ghana', 'GH', NULL, 1200, true, false, 70),
      ('wttj',          'Welcome to the Jungle', 'FR', 'https://welcometothejungle.com', 8000, true, false, 99),
      ('apec',          'Apec',          'FR', 'https://www.apec.fr', 4000, true, false, 98)
    ON CONFLICT (code) DO UPDATE SET
      name          = EXCLUDED.name,
      country_code  = EXCLUDED.country_code,
      url           = EXCLUDED.url,
      est_pool      = EXCLUDED.est_pool,
      is_active     = EXCLUDED.is_active,
      is_panafrican = EXCLUDED.is_panafrican,
      sort_order    = EXCLUDED.sort_order,
      updated_at    = now()
  `)

  // Settings clé/valeur — valeurs initiales (slider, budget, pondérations)
  const sourcingSettings: Array<[string, unknown, string]> = [
    ['max_profiles_min',          { value: 1 },   'Slider min de profils par requête'],
    ['max_profiles_max',          { value: 20 },  'Slider max de profils par requête'],
    ['max_profiles_default',      { value: 8 },   'Valeur par défaut du slider'],
    ['max_cost_eur_per_request',  { value: 0.50 }, 'Budget max IA par requête (EUR, 0 = pas de limite)'],
    ['claude_system_prompt',      { value: '' },  'Prompt système Claude (vide = défaut)'],
    ['mistral_system_prompt',     { value: '' },  'Prompt système Mistral (vide = défaut)'],
    ['richness_weights', {
      hasProfiles: 20, fiveProfiles: 10, perProfile: 2,
      hasBooleanSearch: 10, hasKeywords: 10, hasSalaryBenchmark: 10,
      hasBestPlatforms: 10, hasTips: 5,
      firstProfileLinkedin: 5, firstProfileApproach: 5, firstProfileSkills: 5,
    }, 'Pondérations du score de richesse Claude vs Mistral'],
  ]
  for (const [key, value, description] of sourcingSettings) {
    await pool.query(
      `INSERT INTO platform.sourcing_settings (key, value, description, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         description = EXCLUDED.description,
         updated_at = now()`,
      [key, JSON.stringify(value), description],
    )
  }
  console.log('[2b] Sourcing IA seedé : 5 modèles, 18 plateformes, 7 settings')

  // ─────────────────────────────────────────────────────────────────────────────
  // TENANT 1 — SOTRA (Société des Transports Abidjanais)
  // ─────────────────────────────────────────────────────────────────────────────
  const sotraSlug   = 'sotra'
  const sotraSchema = 'tenant_sotra'
  const sotraAtRate = 0.030 // BTP/Transport

  const sotraTenantRes = await pool.query<{ id: string }>(`
    INSERT INTO platform.tenants
      (name, slug, schema_name, plan_type, status, sector, city,
       cnps_number, dgi_number, rccm, at_rate,
       max_users, max_employees, primary_color, secondary_color, trial_ends_at)
    VALUES
      ('SOTRA — Transports Abidjanais', $1, $2, 'business', 'active', 'transport', 'Abidjan',
       'CI000123456', 'DGI-ABJ-2024-0089', 'CI-ABJ-2010-B-0045', $3,
       100, 150, '#E85D04', '#F48C06', null)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [sotraSlug, sotraSchema, sotraAtRate.toString()])

  // SOTRA = groupe multi-filiales : active le workflow paie centralisé (le lien
  // « Paie multi-filiales » de la sidebar + l'initiation du draft en dépendent).
  await pool.query(
    `UPDATE platform.tenants
        SET has_subsidiaries = true, payroll_mode = 'multi_country', default_country_code = 'CIV'
      WHERE slug = $1`,
    [sotraSlug],
  )

  const sotraTenantId = sotraTenantRes.rows[0]?.id ?? ''
  console.log('[3/10] Tenant SOTRA créé')

  await provisionTenantSchema(sotraSchema)
  await seedPayrollRulesCI(sotraSchema, sotraAtRate)
  await seedAbsenceTypesCI(sotraSchema)
  console.log('[4/10] Schema SOTRA provisionné + rubriques CI seedées')

  // Utilisateurs SOTRA
  const adminHash    = await bcrypt.hash('Admin1234!', 12)
  const managerHash  = await bcrypt.hash('Admin1234!', 12)
  const employeeHash = await bcrypt.hash('Admin1234!', 12)

  await pool.query(`
    INSERT INTO "${sotraSchema}".users (email, password_hash, first_name, last_name, role, is_active, last_login_at)
    VALUES
      ('admin@sotra.ci',    $1, 'Directeur', 'RH SOTRA',   'admin',      true, now()),
      ('rh@sotra.ci',       $1, 'Responsable', 'Paie',      'hr_manager', true, now()),
      ('chef.perso@sotra.ci', $1, 'Chef',    'Personnel',   'hr_officer', true, now()),
      ('manager@sotra.ci',  $2, 'Chef',      'Dépôt',       'manager',    true, now()),
      ('employe@sotra.ci',  $3, 'Kouassi',   'Coulibaly',   'employee',   true, now()),
      ('raf.abidjan@sotra.ci', $1, 'RAF', 'Abidjan', 'raf_site', true, now()),
      ('raf.bouake@sotra.ci',  $1, 'RAF', 'Bouaké',  'raf_site', true, now())
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
  `, [adminHash, managerHash, employeeHash])

  // ── Filiales SOTRA (legal_entities) + RAF affectés ──────────────────────────
  // Deux filiales pour démontrer le workflow paie centralisé : la RH groupe
  // initie le draft global, décline aux filiales, chaque RAF soumet sa filiale,
  // la RH consolide puis clôture (validation 2-yeux SoD).
  const sotraRafAbj = await pool.query<{ id: string }>(
    `SELECT id FROM "${sotraSchema}".users WHERE email = 'raf.abidjan@sotra.ci' LIMIT 1`,
  )
  const sotraRafBke = await pool.query<{ id: string }>(
    `SELECT id FROM "${sotraSchema}".users WHERE email = 'raf.bouake@sotra.ci' LIMIT 1`,
  )
  const sotraEntitiesDef = [
    { name: 'SOTRA Abidjan (siège)', city: 'Abidjan', rccm: 'CI-ABJ-2010-B-0045', raf: sotraRafAbj.rows[0]?.id ?? null },
    { name: 'SOTRA Bouaké',          city: 'Bouaké',  rccm: 'CI-BKE-2015-B-0102', raf: sotraRafBke.rows[0]?.id ?? null },
  ]
  const sotraEntityIds: string[] = []
  for (const le of sotraEntitiesDef) {
    const r = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".legal_entities
        (name, rccm, cnps_number, dgi_number, city, legal_form, at_rate,
         country_code, legislation_pack_code, raf_user_id, is_active)
      VALUES ($1,$2,$3,$4,$5,'SA',$6,'CIV','CIV-2024',$7,true)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [le.name, le.rccm, 'CI000123456', 'DGI-ABJ-2024-0089', le.city, sotraAtRate.toString(), le.raf])
    if (r.rows[0]) {
      sotraEntityIds.push(r.rows[0].id)
    } else {
      const ex = await pool.query<{ id: string }>(
        `SELECT id FROM "${sotraSchema}".legal_entities WHERE name = $1 LIMIT 1`, [le.name],
      )
      if (ex.rows[0]) sotraEntityIds.push(ex.rows[0].id)
    }
  }
  console.log(`[4b/10] ${sotraEntityIds.length} filiales SOTRA créées + 2 RAF`)

  // Workflow config
  await pool.query(`
    INSERT INTO "${sotraSchema}".workflow_configs (module, levels_count)
    VALUES ('absences', 2), ('expenses', 2)
    ON CONFLICT DO NOTHING
  `)

  // Départements SOTRA
  const sotraDeptIds: Record<string, string> = {}
  for (const dept of SOTRA_DEPTS) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".departments (name, code)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [dept.name, dept.code])
    if (res.rows[0]) {
      sotraDeptIds[dept.code] = res.rows[0].id
    } else {
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM "${sotraSchema}".departments WHERE code = $1`, [dept.code]
      )
      sotraDeptIds[dept.code] = existing.rows[0]?.id ?? ''
    }
  }
  console.log('[5/10] Départements SOTRA créés')

  // Employés SOTRA (80 employés)
  const sotraEmployees: Array<{
    id: string; baseSalary: number; maritalStatus: string; childrenCount: number
    provider: string; phone: string
  }> = []

  let empIdx = 0
  for (const dept of SOTRA_DEPTS) {
    const jobs = SOTRA_JOBS[dept.code as keyof typeof SOTRA_JOBS] ?? ['Employé']
    const deptId = sotraDeptIds[dept.code] ?? ''

    for (let i = 0; i < dept.size; i++) {
      const isFemale     = Math.random() > 0.65
      const firstName    = randItem(isFemale ? PRENOMS_F : PRENOMS_H)
      const lastName     = randItem(NOMS)
      const email        = `${firstName.toLowerCase().replace(/[^a-z]/g, '')}.${lastName.toLowerCase().replace(/[^a-z]/g, '')}${empIdx}@sotra.ci`
      const provider     = randItem(MOBILE_PROVIDERS)
      const phone        = ciPhone(provider)
      const maritalStatus = randItem(MARITAL_STATUSES)
      const childrenCount = maritalStatus === 'single' ? 0 : randInt(0, 4)
      const baseSalary   = roundFCFA(randInt(dept.baseSalaryRange[0], dept.baseSalaryRange[1]))
      const jobTitle     = randItem(jobs)
      const hireDate     = pastDate(randInt(6, 84))
      const contractType = baseSalary < 100_000 ? 'cdd' : 'cdi'

      const isKouassi = empIdx === 0 // Lier le premier employé au compte employe@sotra.ci
      const empEmail  = isKouassi ? 'employe@sotra.ci' : email

      const res = await pool.query<{ id: string }>(`
        INSERT INTO "${sotraSchema}".employees
          (first_name, last_name, email, gender, nni, cnps_number,
           mobile_money_provider, mobile_money_phone,
           department_id, job_title, contract_type,
           hire_date, base_salary, city, marital_status, children_count, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `, [
        firstName, lastName, empEmail, isFemale ? 'F' : 'M',
        nni(), cnpsNum(), provider, phone,
        deptId, jobTitle, contractType,
        hireDate, baseSalary, 'Abidjan', maritalStatus, childrenCount,
      ])

      if (res.rows[0]) {
        sotraEmployees.push({
          id: res.rows[0].id, baseSalary, maritalStatus, childrenCount, provider, phone,
        })
      }
      empIdx++
    }
  }
  console.log(`[6/10] ${sotraEmployees.length} employés SOTRA créés`)

  // Lier employe@sotra.ci à l'employé Kouassi
  if (sotraEmployees[0]) {
    await pool.query(
      `UPDATE "${sotraSchema}".users SET employee_id = $1 WHERE email = 'employe@sotra.ci'`,
      [sotraEmployees[0].id]
    )
  }

  // ── Manager d'équipe : le compte manager@sotra.ci devient un employé réel ──
  // (chef de dépôt Exploitation) et TOUTE l'Exploitation devient son équipe :
  // le dashboard manager (équipe, demandes à valider) n'est jamais vide.
  // Le scoping API passe par employees.manager_id + users.email (cf. absences.routes).
  const managerPhone = ciPhone('wave')
  const managerEmpRes = await pool.query<{ id: string }>(`
    INSERT INTO "${sotraSchema}".employees
      (first_name, last_name, email, gender, nni, cnps_number,
       mobile_money_provider, mobile_money_phone,
       department_id, job_title, contract_type,
       hire_date, base_salary, city, marital_status, children_count, is_active)
    VALUES ('Chef','Dépôt','manager@sotra.ci','M',$1,$2,'wave',$3,$4,
            'Chef de dépôt','cdi',$5,380000,'Abidjan','married',2,true)
    ON CONFLICT (email) DO NOTHING
    RETURNING id
  `, [nni(), cnpsNum(), managerPhone, sotraDeptIds['EXP'] ?? null, pastDate(60)])
  const managerEmpId = managerEmpRes.rows[0]?.id
  if (managerEmpId) {
    sotraEmployees.push({
      id: managerEmpId, baseSalary: 380_000, maritalStatus: 'married',
      childrenCount: 2, provider: 'wave', phone: managerPhone,
    })
    await pool.query(
      `UPDATE "${sotraSchema}".users SET employee_id = $1 WHERE email = 'manager@sotra.ci'`,
      [managerEmpId],
    )
    await pool.query(
      `UPDATE "${sotraSchema}".employees SET manager_id = $1
        WHERE department_id = $2 AND id <> $1`,
      [managerEmpId, sotraDeptIds['EXP'] ?? null],
    )
    console.log('[6a] manager@sotra.ci lié à un employé — équipe Exploitation rattachée')
  }

  // Répartir les employés sur les filiales (alternance) pour que la paie par
  // filiale produise des bulletins réels lors du workflow centralisé.
  if (sotraEntityIds.length > 0) {
    for (let i = 0; i < sotraEmployees.length; i++) {
      const entityId = sotraEntityIds[i % sotraEntityIds.length]
      await pool.query(
        `UPDATE "${sotraSchema}".employees SET legal_entity_id = $1 WHERE id = $2`,
        [entityId, sotraEmployees[i]!.id],
      )
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PARCOURS D'INTÉGRATION (ONBOARDING) — modèles + parcours de démo
  // ─────────────────────────────────────────────────────────────────────────────
  // Non bloquant : un échec du seed de démo onboarding ne doit jamais empêcher
  // la création des tenants suivants ni la restauration des credentials.
  await seedOnboarding(sotraSchema, sotraEmployees.map((e) => e.id))
    .catch((e: unknown) => console.warn('[!] Onboarding SOTRA (non bloquant):', (e as Error).message))
  console.log('[6b] Onboarding : 3 modèles + 3 parcours de démo (SOTRA)')

  // Types d'absence (récupérer les IDs)
  const absTypeRes = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM "${sotraSchema}".absence_types`
  )
  const absTypeMap: Record<string, string> = {}
  for (const t of absTypeRes.rows) { absTypeMap[t.code] = t.id }

  // Soldes congés pour tous les employés
  for (const emp of sotraEmployees) {
    for (const [code, typeId] of Object.entries(absTypeMap)) {
      const isCP = code === 'CP'
      await pool.query(`
        INSERT INTO "${sotraSchema}".absence_balances
          (employee_id, absence_type_id, year, acquired, taken, pending, remaining)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT DO NOTHING
      `, [
        emp.id, typeId, new Date().getFullYear(),
        isCP ? 26 : 5,     // acquired
        isCP ? randInt(0, 10) : 0,  // taken
        0,                  // pending
        isCP ? randInt(10, 26) : 5, // remaining
      ])
    }
  }

  // Bulletins de paie — les 6 derniers mois révolus (dates RELATIVES : la démo
  // reste actuelle quel que soit le jour du déploiement — reporting de l'année
  // courante, dashboard « 6 derniers mois », CNPS du trimestre en cours…)
  const sotraPeriods = lastClosedMonths(6)
  for (const month of sotraPeriods) {
    const [yr, mo] = month.split('-').map(Number)
    const workingDays = getWorkingDays(yr!, mo!)

    // Créer la période
    const periodRes = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".pay_periods (month, status, closed_at, closed_by)
      VALUES ($1, 'closed', now(), 'seed')
      ON CONFLICT (month, legal_entity_id) DO UPDATE SET status = 'closed'
      RETURNING id
    `, [month])
    const periodId = periodRes.rows[0]?.id ?? ''

    // Récupérer taux AT
    const tenantRes = await pool.query<{ at_rate: string }>(
      `SELECT at_rate FROM platform.tenants WHERE schema_name = $1`, [sotraSchema]
    )
    const atRate = parseFloat(tenantRes.rows[0]?.at_rate ?? '0.030')

    let totalGross = 0, totalNet = 0, totalCnps = 0, totalIts = 0

    for (const emp of sotraEmployees) {
      const result = calculatePayrollCI({
        baseSalary:       emp.baseSalary,
        workedDays:       workingDays,
        workingDaysMonth: workingDays,
        atRate,
        maritalStatus:    emp.maritalStatus,
        childrenCount:    emp.childrenCount,
        variableElements: { PRIME_TRANSPORT: 30_000 },
      })

      totalGross += result.grossSalary
      totalNet   += result.netPayable
      totalCnps  += result.totalCnpsSal + result.totalCnpsPat
      totalIts   += result.its

      await pool.query(`
        INSERT INTO "${sotraSchema}".pay_slips
          (employee_id, period_id, month, base_salary, gross_salary,
           cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
           total_cnps_sal, total_cnps_pat, its, total_deductions,
           net_payable, employer_cost, lines, status, generated_at,
           payment_method, payment_status, payment_reference, paid_at, currency)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                'generated',now(),$17,'paid',$18,now(),'XOF')
        ON CONFLICT DO NOTHING
      `, [
        emp.id, periodId, month, emp.baseSalary, result.grossSalary,
        result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
        result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
        result.netPayable, result.employerCost, JSON.stringify(result.lines),
        emp.provider,
        `TXN_${month.replace('-', '')}_${emp.id.slice(0, 8).toUpperCase()}`,
      ])
    }

    await pool.query(`
      UPDATE "${sotraSchema}".pay_periods
      SET total_gross = $1, total_net = $2, total_cnps = $3, total_its = $4
      WHERE id = $5
    `, [totalGross, totalNet, totalCnps, totalIts, periodId])
  }
  console.log(`[7/10] ${sotraEmployees.length * sotraPeriods.length} bulletins SOTRA générés (6 mois)`)

  // ─── Paie multi-filiales : workflow centralisé d'exemple (page « Paie multi-filiales ») ──
  // SOTRA est un groupe à filiales : on matérialise le workflow paie centralisé pour que
  // la page ne soit PAS vide au premier lancement et illustre TOUS les états — mois
  // clôturés + consolidés (avec totaux réels par filiale et chronologie nominative), et un
  // mois EN COURS montrant la progression des soumissions filiale par filiale.
  {
    const lesRes = await pool.query<{
      id: string; raf_user_id: string | null; legislation_pack_code: string | null; name: string
    }>(
      `SELECT id, raf_user_id, legislation_pack_code, name
         FROM "${sotraSchema}".legal_entities WHERE is_active = true ORDER BY name`,
    )
    const filiales = lesRes.rows.filter((f) => f.raf_user_id)
    const centralRes = await pool.query<{ id: string }>(
      `SELECT id FROM "${sotraSchema}".users WHERE role IN ('admin','hr_manager') ORDER BY role LIMIT 1`,
    )
    const centralUserId = centralRes.rows[0]?.id ?? null

    if (filiales.length > 0 && centralUserId) {
      // Idempotent en reseed local (en prod le schéma tenant est DROP au préalable).
      await pool.query(
        `DELETE FROM "${sotraSchema}".audit_log WHERE entity = 'pay_period' AND action LIKE 'workflow.%'`,
      ).catch(() => undefined)
      await pool.query(
        `DELETE FROM "${sotraSchema}".pay_periods WHERE parent_period_id IS NOT NULL`,
      ).catch(() => undefined)
      await pool.query(
        `DELETE FROM "${sotraSchema}".pay_periods WHERE month = $1 AND legal_entity_id IS NULL`,
        [monthOffsetStr(0)],
      ).catch(() => undefined)

      // Totaux par filiale d'un mois (sommés depuis les bulletins réels déjà générés).
      const totalsByMonth = async (month: string) => {
        const r = await pool.query<{ le: string; g: string; n: string; c: string; i: string }>(
          `SELECT e.legal_entity_id AS le,
                  COALESCE(SUM(ps.gross_salary),0)                       AS g,
                  COALESCE(SUM(ps.net_payable),0)                        AS n,
                  COALESCE(SUM(ps.total_cnps_sal + ps.total_cnps_pat),0) AS c,
                  COALESCE(SUM(ps.its),0)                                AS i
             FROM "${sotraSchema}".pay_slips ps
             JOIN "${sotraSchema}".employees e ON e.id = ps.employee_id
            WHERE ps.month = $1 AND e.legal_entity_id IS NOT NULL
            GROUP BY e.legal_entity_id`,
          [month],
        )
        const m = new Map<string, { g: number; n: number; c: number; i: number }>()
        for (const row of r.rows) m.set(row.le, { g: +row.g, n: +row.n, c: +row.c, i: +row.i })
        return m
      }

      // Chronologie : created_at décalé (jours + minutes croissantes) pour un ordre stable.
      let tick = 0
      const insertEvent = async (
        entityId: string, action: string, changes: Record<string, unknown>, daysAgo: number,
      ) => {
        await pool.query(
          `INSERT INTO "${sotraSchema}".audit_log (user_id, action, entity, entity_id, changes, created_at)
           VALUES ($1,$2,'pay_period',$3,$4,
                   now() - ($5 || ' days')::interval + ($6 || ' minutes')::interval)`,
          [centralUserId, action, entityId, JSON.stringify(changes), daysAgo, tick++],
        ).catch(() => undefined)
      }

      // 1) Mois CLÔTURÉS : on décline chaque période parente existante vers ses filiales.
      const closedMonths = sotraPeriods // les 6 derniers mois révolus
      for (let mi = 0; mi < closedMonths.length; mi++) {
        const month = closedMonths[mi]!
        const daysAgo = (closedMonths.length - mi) * 25
        const parentRes = await pool.query<{ id: string }>(
          `SELECT id FROM "${sotraSchema}".pay_periods
            WHERE month = $1 AND parent_period_id IS NULL AND legal_entity_id IS NULL LIMIT 1`,
          [month],
        )
        const parentId = parentRes.rows[0]?.id
        if (!parentId) continue
        const totals = await totalsByMonth(month)

        await insertEvent(parentId, 'workflow.create_draft', { month }, daysAgo)
        await insertEvent(parentId, 'workflow.send_to_sites', { sitesCount: filiales.length }, daysAgo)

        let sg = 0, sn = 0, sc = 0, si = 0
        for (const f of filiales) {
          const t = totals.get(f.id) ?? { g: 0, n: 0, c: 0, i: 0 }
          sg += t.g; sn += t.n; sc += t.c; si += t.i
          const childRes = await pool.query<{ id: string }>(
            `INSERT INTO "${sotraSchema}".pay_periods
               (month, status, parent_period_id, legal_entity_id, legislation_pack_code, raf_user_id,
                total_gross, total_net, total_cnps, total_its,
                sent_to_sites_at, completed_by_site_at, validated_central_at, closed_at, validated_by, closed_by)
             VALUES ($1,'closed',$2,$3,$4,$5,$6,$7,$8,$9, now(),now(),now(),now(),$10::uuid,$10::text)
             ON CONFLICT (month, legal_entity_id) DO NOTHING
             RETURNING id`,
            [month, parentId, f.id, f.legislation_pack_code ?? 'CIV-2024', f.raf_user_id,
             t.g, t.n, t.c, t.i, centralUserId],
          )
          const childId = childRes.rows[0]?.id
          if (childId) {
            await insertEvent(childId, 'workflow.submit_by_raf',
              { inserted: 0, totalGross: t.g, totalNet: t.n, legalEntityName: f.name }, daysAgo)
          }
        }

        // Parent déjà 'closed' avec totaux (= somme employés = somme filiales) ; on
        // renseigne les jalons workflow manquants pour la cohérence d'affichage.
        await pool.query(
          `UPDATE "${sotraSchema}".pay_periods
              SET sent_to_sites_at     = COALESCE(sent_to_sites_at, now()),
                  validated_central_at = COALESCE(validated_central_at, now()),
                  validated_by         = COALESCE(validated_by, $2)
            WHERE id = $1`,
          [parentId, centralUserId],
        )
        await insertEvent(parentId, 'workflow.validate_central',
          { sitesCount: filiales.length, sumGross: sg, sumNet: sn }, daysAgo)
        await insertEvent(parentId, 'workflow.close', {}, daysAgo)
      }

      // 2) Mois EN COURS (démo « live ») : décliné, 1re filiale soumise, le reste en attente.
      const liveMonth = monthOffsetStr(0)
      const refTotals = await totalsByMonth(sotraPeriods[sotraPeriods.length - 1]!)
      const liveParentRes = await pool.query<{ id: string }>(
        `INSERT INTO "${sotraSchema}".pay_periods
           (month, status, parent_period_id, legal_entity_id, sent_to_sites_at)
         VALUES ($1,'sent_to_sites',NULL,NULL, now())
         RETURNING id`,
        [liveMonth],
      )
      const liveParentId = liveParentRes.rows[0]?.id
      if (liveParentId) {
        await insertEvent(liveParentId, 'workflow.create_draft', { month: liveMonth }, 2)
        await insertEvent(liveParentId, 'workflow.send_to_sites', { sitesCount: filiales.length }, 1)
        for (let fi = 0; fi < filiales.length; fi++) {
          const f = filiales[fi]!
          const submitted = fi === 0 // la 1re filiale a soumis ; les suivantes restent en attente
          const t = refTotals.get(f.id) ?? { g: 0, n: 0, c: 0, i: 0 }
          const childRes = await pool.query<{ id: string }>(
            `INSERT INTO "${sotraSchema}".pay_periods
               (month, status, parent_period_id, legal_entity_id, legislation_pack_code, raf_user_id,
                total_gross, total_net, total_cnps, total_its, sent_to_sites_at, completed_by_site_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), CASE WHEN $11 THEN now() ELSE NULL END)
             ON CONFLICT (month, legal_entity_id) DO NOTHING
             RETURNING id`,
            [liveMonth, submitted ? 'completed_by_site' : 'sent_to_sites', liveParentId, f.id,
             f.legislation_pack_code ?? 'CIV-2024', f.raf_user_id,
             submitted ? t.g : null, submitted ? t.n : null, submitted ? t.c : null, submitted ? t.i : null,
             submitted],
          )
          const childId = childRes.rows[0]?.id
          if (childId && submitted) {
            await insertEvent(childId, 'workflow.submit_by_raf',
              { inserted: 0, totalGross: t.g, totalNet: t.n, legalEntityName: f.name }, 1)
          }
        }
      }

      console.log(`[7c/10] Workflow paie multi-filiales SOTRA : ${closedMonths.length} mois clôturés + 1 mois en cours, ${filiales.length} filiales`)
    }
  }

  // ─── Contrats OHADA pour tous les employés SOTRA ─────────────────────────────
  const contractTypes = ['cdi','cdi','cdi','cdi','cdd'] // 80% CDI, 20% CDD
  for (let ci = 0; ci < sotraEmployees.length; ci++) {
    const emp = sotraEmployees[ci]!
    const ctype = contractTypes[ci % contractTypes.length]!
    const startDate = new Date(2020 + Math.floor(ci / 20), ci % 12, 1)
    const endDate   = ctype === 'cdd'
      ? new Date(startDate.getFullYear() + 1, startDate.getMonth(), startDate.getDate())
      : null
    const isManager = ci < 5
    const trialDays = isManager ? 30 : 15
    const trialEnd  = new Date(startDate)
    trialEnd.setDate(trialEnd.getDate() + trialDays)
    await pool.query(`
      INSERT INTO "${sotraSchema}".contracts
        (employee_id, type, start_date, end_date, trial_end_date, base_salary,
         working_hours, convention, job_title, job_level,
         cnps_affiliation, ohada_clause, non_competition_clause,
         telecommuting_days, status)
      VALUES ($1,$2,$3,$4,$5,$6,40,'Transport urbain CI',
              $7,$8,true,true,false,0,'active')
      ON CONFLICT DO NOTHING
    `, [
      emp.id, ctype,
      startDate.toISOString().split('T')[0],
      endDate ? endDate.toISOString().split('T')[0] : null,
      trialEnd.toISOString().split('T')[0],
      emp.baseSalary,
      isManager ? 'Chef de service' : ci % 3 === 0 ? 'Technicien' : 'Agent',
      isManager ? 'Cadre' : 'Agent de maîtrise',
    ])
  }
  console.log(`[7b/10] ${sotraEmployees.length} contrats OHADA SOTRA créés`)

  // Absences pour l'employé Kouassi (employe@sotra.ci) — dates relatives
  if (sotraEmployees[0] && absTypeMap['CP']) {
    const empId = sotraEmployees[0].id
    await pool.query(`
      INSERT INTO "${sotraSchema}".absences
        (employee_id, absence_type_id, start_date, end_date, days, half_day, reason, status, approved_by, approved_at)
      VALUES
        ($1,$2,$3,$4,5,false,'Congés annuels','approved',null,now()),
        ($1,$2,$5,$6,5,false,'Congés de détente','approved',null,now()),
        ($1,$2,$7,$8,2,false,'Événement familial','pending',null,null)
      ON CONFLICT DO NOTHING
    `, [empId, absTypeMap['CP'],
        dateOffsetStr(-140), dateOffsetStr(-136),
        dateOffsetStr(-75), dateOffsetStr(-71),
        dateOffsetStr(4), dateOffsetStr(5)])
  }

  // ─── Expense reports pour Kouassi (mois relatifs) ────────────────────────────
  if (sotraEmployees[0]) {
    const kouassiId = sotraEmployees[0].id
    const erMonth1 = monthOffsetStr(3)
    const erMonth2 = monthOffsetStr(2)
    const erMonth3 = monthOffsetStr(1)
    const erRes1 = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".expense_reports
        (employee_id, title, month, status, submitted_at, total_amount, currency)
      VALUES ($1,'Mission terrain Bouaké',$2,'approved',now()-interval'15 days',34500,'XOF')
      ON CONFLICT DO NOTHING RETURNING id
    `, [kouassiId, erMonth1])
    await pool.query(`
      INSERT INTO "${sotraSchema}".expense_reports
        (employee_id, title, month, status, submitted_at, total_amount, currency)
      VALUES ($1,'Déplacement Yopougon',$2,'submitted',now()-interval'3 days',12000,'XOF')
      ON CONFLICT DO NOTHING
    `, [kouassiId, erMonth2])
    const erRes3 = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".expense_reports
        (employee_id, title, month, status, total_amount, currency)
      VALUES ($1,'Frais repas formation',$2,'draft',11500,'XOF')
      ON CONFLICT DO NOTHING RETURNING id
    `, [kouassiId, erMonth3])
    if (erRes1.rows[0]) {
      await pool.query(`
        INSERT INTO "${sotraSchema}".expense_lines
          (report_id, description, category, date, amount, currency)
        VALUES
          ($1,'Taxi Abidjan-Bouaké','transport',$2,15000,'XOF'),
          ($1,'Repas déjeuner','meals',$2,8500,'XOF'),
          ($1,'Hébergement 1 nuit','accommodation',$2,11000,'XOF')
        ON CONFLICT DO NOTHING
      `, [erRes1.rows[0].id, `${erMonth1}-10`])
    }
    if (erRes3.rows[0]) {
      await pool.query(`
        INSERT INTO "${sotraSchema}".expense_lines
          (report_id, description, category, date, amount, currency)
        VALUES
          ($1,'Repas midi formation','meals',$2,8500,'XOF'),
          ($1,'Taxi retour','transport',$2,3000,'XOF')
        ON CONFLICT DO NOTHING
      `, [erRes3.rows[0].id, `${erMonth3}-15`])
    }
  }

  // ─── Recrutement ─────────────────────────────────────────────────────────────
  // Récupération d'un département "Administration" pour cibler des offres internes
  const adminDeptRes = await pool.query<{ id: string }>(
    `SELECT id FROM "${sotraSchema}".departments
       WHERE name ILIKE '%administration%' OR name ILIKE '%direction%'
       ORDER BY name LIMIT 1`,
  )
  const adminDeptId = adminDeptRes.rows[0]?.id ?? null
  const explDeptRes = await pool.query<{ id: string }>(
    `SELECT id FROM "${sotraSchema}".departments
       WHERE name ILIKE '%exploitation%' OR name ILIKE '%maintenance%'
       ORDER BY name LIMIT 1`,
  )
  const explDeptId = explDeptRes.rows[0]?.id ?? null

  const jobIds: string[] = []
  const jobsData = [
    {
      title: 'Chauffeur Bus Senior', location: 'Abidjan',
      contract_type: 'cdi', salary_min: 220000, salary_max: 280000,
      description: 'Recherchons chauffeur expérimenté pour ligne C8 Abobo-Plateau. Permis D obligatoire, 5 ans minimum.',
      requirements: 'Permis D, 5 ans d\'expérience minimum, casier judiciaire vierge.',
      status: 'open', visibility: 'external',
      target_departments: [] as string[], target_job_levels: [] as string[],
      target_min_seniority_months: null as number | null,
    },
    {
      title: 'Technicien Mécanique Auto', location: 'Abidjan (Garage principal)',
      contract_type: 'cdi', salary_min: 250000, salary_max: 350000,
      description: 'Maintenance préventive et corrective de la flotte SOTRA. BEP/CAP mécanique auto exigé.',
      requirements: 'BEP/CAP mécanique automobile, expérience véhicules lourds appréciée.',
      status: 'open', visibility: 'both',
      target_departments: explDeptId ? [explDeptId] : [],
      target_job_levels: ['agent_maitrise', 'ouvrier'],
      target_min_seniority_months: 12,
    },
    {
      title: 'Chargé(e) RH', location: 'Abidjan (Siège Treichville)',
      contract_type: 'cdi', salary_min: 400000, salary_max: 600000,
      description: 'Gestion administration du personnel, CNPS, paie. Licence RH ou gestion.',
      requirements: 'Licence RH ou gestion, maîtrise CNPS et ITS, Excel avancé.',
      status: 'open', visibility: 'external',
      target_departments: [], target_job_levels: [], target_min_seniority_months: null,
    },
    {
      title: 'Chef d\'équipe Exploitation (mobilité interne)',
      location: 'Abidjan (Treichville)',
      contract_type: 'cdi', salary_min: 350000, salary_max: 500000,
      description: 'Poste de promotion interne : encadrement d\'une équipe de 8 chauffeurs sur la ligne Plateau-Abobo. Réservé aux collaborateurs SOTRA.',
      requirements: 'Minimum 24 mois d\'ancienneté, expérience terrain en exploitation.',
      status: 'open', visibility: 'internal',
      target_departments: explDeptId ? [explDeptId] : [],
      target_job_levels: ['agent_maitrise', 'employe'],
      target_min_seniority_months: 24,
    },
    {
      title: 'Responsable Administratif (mobilité cadre)',
      location: 'Abidjan (Siège)',
      contract_type: 'cdi', salary_min: 800000, salary_max: 1200000,
      description: 'Poste de cadre ouvert en mobilité interne pour préparer la relève. Conduite de projets transverses.',
      requirements: 'Cadre SOTRA, minimum 36 mois d\'ancienneté, profil RH/finance/juridique.',
      status: 'open', visibility: 'internal',
      target_departments: adminDeptId ? [adminDeptId] : [],
      target_job_levels: ['cadre'],
      target_min_seniority_months: 36,
    },
  ]
  for (const job of jobsData) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".recruitment_jobs
        (title, location, contract_type, salary_min, salary_max,
         description, requirements, status, visibility,
         target_departments, target_job_levels, target_min_seniority_months,
         published_at, public_slug)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13)
      ON CONFLICT DO NOTHING RETURNING id
    `, [
      job.title, job.location, job.contract_type,
      job.salary_min, job.salary_max,
      job.description, job.requirements, job.status, job.visibility,
      job.target_departments, job.target_job_levels, job.target_min_seniority_months,
      job.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80),
    ])
    if (res.rows[0]) jobIds.push(res.rows[0].id)
  }

  // Applications pour les offres externes
  const stages = ['new', 'screening', 'interview', 'offer', 'hired']
  const candidateNames = [
    ['Konan', 'Yves'], ['Bah', 'Fatoumata'], ['Kouamé', 'Eric'], ['Diallo', 'Moussa'],
    ['Abe', 'Céleste'], ['Touré', 'Ibrahima'], ['Kra', 'Hermann'], ['Soro', 'Mariam'],
    ['Dème', 'Serge'], ['Assouman', 'Laure'],
  ]
  // Seul les 3 premiers jobs (externe + mixte + externe) reçoivent les candidatures externes
  const externalJobIds = jobIds.slice(0, 3)
  for (let i = 0; i < candidateNames.length; i++) {
    const jobId = externalJobIds[i % Math.max(externalJobIds.length, 1)]
    if (!jobId) continue
    const [ln, fn] = candidateNames[i]!
    const stage = stages[i % stages.length]!
    // Quelques candidats ont déjà un scoring IA pré-rempli (illustration)
    const hasAi = i < 4
    const aiScore = hasAi ? randInt(55, 92) : null
    const aiRec = hasAi
      ? (aiScore! >= 85 ? 'strong_yes' : aiScore! >= 70 ? 'yes' : aiScore! >= 55 ? 'maybe' : 'no')
      : null
    await pool.query(`
      INSERT INTO "${sotraSchema}".applications
        (job_id, first_name, last_name, email, phone, stage,
         source, ai_score, ai_recommendation, ai_match_percentage,
         ai_summary, ai_strengths, ai_gaps, ai_model_used, ai_analyzed_at)
      VALUES ($1,$2,$3,$4,$5,$6,'careers_page',$7,$8,$9,$10,$11,$12,$13,
              CASE WHEN $7::int IS NULL THEN NULL ELSE now() END)
      ON CONFLICT DO NOTHING
    `, [
      jobId, fn, ln, `${fn?.toLowerCase()}.${ln?.toLowerCase()}@email.com`,
      ciPhone('wave'), stage,
      aiScore, aiRec, aiScore,
      hasAi ? `Profil ${aiRec === 'strong_yes' ? 'très aligné' : aiRec === 'yes' ? 'aligné' : 'à étudier'} avec les prérequis du poste.` : null,
      hasAi ? JSON.stringify(['Expérience locale CI', 'Maîtrise CNPS/ITS', 'Anglais courant']) : JSON.stringify([]),
      hasAi ? JSON.stringify(['Pas d\'expérience secteur transport']) : JSON.stringify([]),
      hasAi ? 'claude' : null,
    ])
  }

  // ─── Profils sourcés (cache de visualisation pour l'onglet Sourcing IA) ─────
  // Pré-remplit la table sourced_profiles pour permettre de visualiser le rendu
  // visuel sans avoir besoin d'appeler l'IA. L'utilisateur peut les transférer
  // vers le pipeline Kanban en un clic (1 par 1 ou tous d'un coup).
  type SourcedSeed = {
    fn: string; ln: string; pos: string; company: string; loc: string
    yrs: number; skills: string[]; score: number
    avail: 'immediate' | '1month' | '3months' | 'passive'
    platform: string; salary: number; phone?: string
    approach: string
  }
  async function seedSourced(schema: string, jobId: string, profiles: SourcedSeed[], countries: string[]) {
    for (const p of profiles) {
      const email = `${p.fn.toLowerCase().replace(/[^a-z]/g, '')}.${p.ln.toLowerCase().replace(/[^a-z]/g, '')}@sourcing.example`
      const linkedinSearch = `${p.fn} ${p.ln} ${p.company} ${p.pos}`
      await pool.query(`
        INSERT INTO "${schema}".sourced_profiles
          (job_id, first_name, last_name, current_position, current_company,
           location, experience_years, key_skills, match_score,
           availability_estimate, suggested_platform, linkedin_search,
           approach_strategy, estimated_salary, estimated_salary_currency,
           email, phone, source_provider, source_model, countries)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'XOF',$15,$16,'seed','demo-seed',$17::varchar[])
        ON CONFLICT DO NOTHING
      `, [
        jobId, p.fn, p.ln, p.pos, p.company, p.loc, p.yrs,
        JSON.stringify(p.skills), p.score, p.avail, p.platform,
        linkedinSearch, p.approach, p.salary, email, p.phone ?? null,
        countries,
      ])
    }
  }

  // 8 profils pour "Chauffeur Bus Senior" (jobIds[0], externe)
  if (jobIds[0]) {
    await seedSourced(sotraSchema, jobIds[0], [
      { fn: 'Yao',       ln: 'Kouassi',   pos: 'Chauffeur Bus longue distance', company: 'UTB Côte d\'Ivoire', loc: 'Abidjan, CI', yrs: 12, skills: ['Permis D', 'Conduite défensive', 'Mécanique de base'], score: 92, avail: 'immediate', platform: 'Emploi.ci',    salary: 280000, phone: '+225 0707111201', approach: 'Forte expérience longue distance, recommandé par un ancien collègue SOTRA.' },
      { fn: 'Adama',     ln: 'Diabaté',   pos: 'Chauffeur Bus urbain',           company: 'STL Bouaké',         loc: 'Bouaké, CI',  yrs: 8,  skills: ['Permis D', 'Connaissance Abidjan', 'Service client'],     score: 86, avail: '1month',    platform: 'RMO Côte d\'Ivoire', salary: 240000, phone: '+225 0505222302', approach: 'Veut revenir à Abidjan, parfaitement bilingue dioula/français.' },
      { fn: 'Salif',     ln: 'Traoré',    pos: 'Chauffeur PL international',     company: 'Transrail',          loc: 'Yamoussoukro, CI', yrs: 15, skills: ['Permis D', 'Permis EC', 'Sécurité routière'], score: 88, avail: 'passive', platform: 'LinkedIn', salary: 260000, phone: '+225 0102333403', approach: 'Profil senior, ouvert à un changement pour un poste plus stable.' },
      { fn: 'Bakary',    ln: 'Coulibaly', pos: 'Chauffeur Bus de tourisme',      company: 'TCA Abidjan',         loc: 'Abidjan, CI', yrs: 7,  skills: ['Permis D', 'Anglais professionnel', 'Premiers secours'], score: 82, avail: 'immediate', platform: 'Emploi.ci',    salary: 230000, phone: '+225 0707444504', approach: 'Cherche poste avec horaires fixes pour raisons familiales.' },
      { fn: 'Issa',      ln: 'Konaté',    pos: 'Conducteur SOTRA (ex)',          company: 'Indépendant',         loc: 'Abidjan, CI', yrs: 10, skills: ['Permis D', 'Connaissance réseau SOTRA', 'Maintenance niveau 1'], score: 90, avail: 'immediate', platform: 'RMO Côte d\'Ivoire', salary: 250000, phone: '+225 0505555605', approach: 'Ancien chauffeur SOTRA, souhaite réintégrer après période indépendante.' },
      { fn: 'Mamadou',   ln: 'Bamba',     pos: 'Chauffeur véhicules lourds',     company: 'Bolloré Transport',   loc: 'San-Pédro, CI', yrs: 9, skills: ['Permis D', 'Permis EC', 'Logistique'],                  score: 78, avail: '3months',   platform: 'LinkedIn', salary: 270000, phone: '+225 0102666706', approach: 'Profil polyvalent, accepterait poste basé Abidjan avec déplacements.' },
      { fn: 'Hamed',     ln: 'Touré',     pos: 'Chauffeur taxi-bus',             company: 'Indépendant',         loc: 'Abidjan, CI', yrs: 6,  skills: ['Permis D', 'Connaissance Abidjan', 'Service client'], score: 74, avail: 'immediate', platform: 'Emploi.ci',    salary: 200000, phone: '+225 0707777807', approach: 'Veut un statut salarié après plusieurs années en auto-entrepreneur.' },
      { fn: 'Souleymane', ln: 'Cissé',    pos: 'Chauffeur Bus scolaire',          company: 'Lycée français Jean Mermoz', loc: 'Abidjan, CI', yrs: 11, skills: ['Permis D', 'Sécurité enfants', 'Bilingue FR/EN'], score: 85, avail: '1month',    platform: 'LinkedIn', salary: 245000, phone: '+225 0505888908', approach: 'Cherche évolution salariale, références employeur disponibles.' },
    ], ['CI'])
  }

  // 6 profils pour "Chargé(e) RH" (jobIds[2], externe)
  if (jobIds[2]) {
    await seedSourced(sotraSchema, jobIds[2], [
      { fn: 'Aminata',   ln: 'Sangaré', pos: 'Chargée RH & Paie',          company: 'Orange CI',          loc: 'Abidjan, CI', yrs: 6, skills: ['Sage Paie', 'CNPS', 'ITS/DGI', 'Excel avancé'],          score: 94, avail: '1month',    platform: 'LinkedIn',     salary: 520000, phone: '+225 0707101201', approach: 'Profil très aligné, expérience CNPS et ITS confirmée. Ouvre à offre.' },
      { fn: 'Patrick',   ln: 'N\'Guessan', pos: 'Responsable Administration RH', company: 'Cabinet Audit ECC', loc: 'Abidjan, CI', yrs: 8, skills: ['Contrats OHADA', 'DISA', 'Gestion conflits', 'Sage Paie'], score: 91, avail: 'passive',   platform: 'LinkedIn',     salary: 580000, phone: '+225 0505202302', approach: 'Senior, intéressé par poste opérationnel terrain plutôt que conseil.' },
      { fn: 'Fatou',     ln: 'Bamba',     pos: 'HR Officer',                  company: 'PwC Côte d\'Ivoire', loc: 'Abidjan, CI', yrs: 4, skills: ['HRIS', 'Recrutement', 'Anglais professionnel'],     score: 78, avail: 'immediate', platform: 'Africawork',  salary: 460000, phone: '+225 0102303403', approach: 'Veut quitter cabinet conseil pour entreprise. Profil junior+ qualifié.' },
      { fn: 'Christelle', ln: 'Diallo',    pos: 'Assistante RH polyvalente',   company: 'NSIA Banque',         loc: 'Abidjan, CI', yrs: 5, skills: ['Paie', 'Onboarding', 'Excel', 'Communication'],     score: 81, avail: '1month',    platform: 'RMO Côte d\'Ivoire', salary: 480000, phone: '+225 0707404504', approach: 'Profil très organisé, recommandée pour la gestion administrative.' },
      { fn: 'Hermann',   ln: 'Kra',       pos: 'Consultant RH freelance',     company: 'Indépendant',         loc: 'Abidjan, CI', yrs: 9, skills: ['Audit social', 'Formations', 'CNPS', 'OHADA'],       score: 76, avail: 'immediate', platform: 'LinkedIn',     salary: 550000, phone: '+225 0505505605', approach: 'Profil senior cherchant à se sédentariser. Bonne expérience secteur transport.' },
      { fn: 'Sylvie',    ln: 'Anoh',      pos: 'Chargée Paie & Reporting',    company: 'SIFCA',               loc: 'Abidjan, CI', yrs: 7, skills: ['Sage Paie', 'Power BI', 'CNPS', 'Comptabilité'],     score: 87, avail: '3months',  platform: 'LinkedIn',     salary: 530000, phone: '+225 0102606706', approach: 'Profil paie technique très solide, expérience agro-industrie.' },
    ], ['CI'])
  }

  // 2 candidatures internes pré-seedées sur l'offre "Chef d'équipe" (4e offre = index 3)
  if (jobIds[3]) {
    const internalEmps = await pool.query<{ id: string; first_name: string; last_name: string; email: string | null; phone: string | null }>(
      `SELECT id, first_name, last_name, email, phone
         FROM "${sotraSchema}".employees
         WHERE department_id = $1 AND is_active = true
         ORDER BY hire_date NULLS LAST
         LIMIT 2`,
      [explDeptId],
    )
    for (const emp of internalEmps.rows) {
      await pool.query(`
        INSERT INTO "${sotraSchema}".applications
          (job_id, first_name, last_name, email, phone, cover_letter,
           stage, source, internal_employee_id)
        VALUES ($1,$2,$3,$4,$5,$6,'screening','internal',$7)
        ON CONFLICT DO NOTHING
      `, [
        jobIds[3], emp.first_name, emp.last_name,
        emp.email ?? `${emp.first_name.toLowerCase()}@sotra-ci.com`,
        emp.phone ?? null,
        `Bonjour, je souhaite postuler à ce poste de promotion interne. Mon expérience terrain en exploitation me permet de prendre la relève.`,
        emp.id,
      ])
    }
  }

  // ─── Formations ──────────────────────────────────────────────────────────────
  const trainingData = [
    { title: 'Sécurité Routière Professionnelle', description: 'Formation obligatoire pour chauffeurs. Code de la route CI + conduite défensive.', duration: 8, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Gestion RH & Paie CI', description: 'CNPS, ITS/DGI, contrats OHADA, DISA. Adapté au droit ivoirien.', duration: 16, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Leadership & Management', description: 'Encadrement, motivation, gestion des conflits en contexte ivoirien.', duration: 12, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Excel Avancé & Tableaux de bord', description: 'Maîtrise Excel pour le reporting RH et financier.', duration: 8, format: 'e-learning', is_fdfp_eligible: false },
    { title: 'RGPD & Protection des données (ARTCI)', description: 'Conformité ARTCI, protection données personnelles en CI.', duration: 6, format: 'e-learning', is_fdfp_eligible: false },
    { title: 'Mécanique et Maintenance Bus', description: 'Diagnostic panne, entretien préventif, outils.', duration: 16, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Gestion des conflits & relation client', description: 'Techniques de médiation, communication bienveillante.', duration: 8, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Secourisme & Premiers Secours', description: 'PSC1 — Prévention et Secours Civiques niveau 1.', duration: 7, format: 'presentiel', is_fdfp_eligible: false },
    { title: 'Informatique & Outils bureautiques', description: 'Word, Excel, email, gestion documentaire.', duration: 6, format: 'e-learning', is_fdfp_eligible: false },
    { title: 'Sensibilisation à la Sécurité au travail', description: 'Risques professionnels, EPI, procédures d\'urgence.', duration: 4, format: 'presentiel', is_fdfp_eligible: true },
  ]
  const trainingIds: string[] = []
  for (const tr of trainingData) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".trainings
        (title, description, duration, format, is_fdfp_eligible)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING RETURNING id
    `, [tr.title, tr.description, tr.duration, tr.format, tr.is_fdfp_eligible])
    if (res.rows[0]) trainingIds.push(res.rows[0].id)
  }

  // Sessions de formation
  const sessionIds: string[] = []
  const futureDate = (daysFromNow: number) => {
    const d = new Date(); d.setDate(d.getDate() + daysFromNow); return d.toISOString().split('T')[0]
  }
  for (let i = 0; i < Math.min(trainingIds.length, 3); i++) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".training_sessions
        (training_id, start_date, end_date, location, trainer, max_places)
      VALUES ($1,$2,$3,$4,$5,20)
      ON CONFLICT DO NOTHING RETURNING id
    `, [trainingIds[i]!, futureDate(15 + i * 10), futureDate(16 + i * 10), 'Siège SOTRA — Salle de formation', 'Formateur FDFP'])
    if (res.rows[0]) sessionIds.push(res.rows[0].id)
  }

  // Inscription de Kouassi à 2 formations
  if (sotraEmployees[0] && sessionIds.length >= 2) {
    for (let i = 0; i < 2; i++) {
      await pool.query(`
        INSERT INTO "${sotraSchema}".training_enrollments
          (employee_id, session_id, status)
        VALUES ($1,$2,'enrolled')
        ON CONFLICT DO NOTHING
      `, [sotraEmployees[0].id, sessionIds[i]!])
    }
  }

  // ─── Compétences et évaluations ──────────────────────────────────────────────
  const skillsData = [
    { name: 'Conduite sécurisée', category: 'technique' },
    { name: 'Connaissance Code de la Route CI', category: 'technique' },
    { name: 'Mécanique automobile', category: 'technique' },
    { name: 'Service client', category: 'comportemental' },
    { name: 'Gestion d\'équipe', category: 'managérial' },
    { name: 'Informatique bureautique', category: 'transversal' },
    { name: 'Communication professionnelle', category: 'comportemental' },
    { name: 'Sécurité & prévention des risques', category: 'technique' },
    { name: 'Gestion administrative RH', category: 'technique' },
    { name: 'Gestion du stress', category: 'comportemental' },
  ]
  const skillIds: string[] = []
  for (const sk of skillsData) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".career_skills (name, category)
      VALUES ($1,$2)
      ON CONFLICT DO NOTHING RETURNING id
    `, [sk.name, sk.category])
    if (res.rows[0]) skillIds.push(res.rows[0].id)
    else {
      const ex = await pool.query<{ id: string }>(
        `SELECT id FROM "${sotraSchema}".career_skills WHERE name = $1`, [sk.name]
      )
      if (ex.rows[0]) skillIds.push(ex.rows[0].id)
    }
  }

  // ─── Enrichissement « zéro écran vide » SOTRA ────────────────────────────────
  // Toutes les visualisations (graphes, tableaux, kanbans, KPI) remplies pour
  // TOUS les rôles : absences/frais pour la masse des employés (manager et RH
  // ont toujours des demandes à valider), 9-box complet, sessions remplies,
  // campagne Mobile Money, déclarations CNPS, DISA, notifications, événements RH.
  const sotraIds = sotraEmployees.map((e) => e.id)
  const nbAbs = await seedAbsencesBulk(pool, sotraSchema, sotraIds, absTypeMap)
  await recomputeAbsenceBalances(pool, sotraSchema)
  const nbExp = await seedExpensesBulk(pool, sotraSchema, sotraIds)
  const nbEnr = await seedEnrollmentsBulk(pool, sotraSchema, sotraIds, sessionIds)
  await seedSkillsEvaluationsBulk(pool, sotraSchema, sotraIds, skillIds,
    'admin@sotra.ci', sotraEmployees[0] ? [sotraEmployees[0].id] : [])
  await seedHrEventsBulk(pool, sotraSchema)
  await seedNotificationsBulk(pool, sotraSchema)
  const lastClosed = sotraPeriods[sotraPeriods.length - 1]!
  const nbMm = await seedMobileMoneyCampaign(pool, sotraSchema, lastClosed)
  const nbCnps = await seedCnpsDeclarationsFromPayslips(pool, sotraSchema, sotraPeriods)
  for (const yr of new Set(sotraPeriods.map((m) => Number(m.slice(0, 4))))) {
    await seedDisaFromPayslips(pool, sotraSchema, yr)
  }
  console.log(`[7b/10] SOTRA enrichi : ${nbAbs} absences, ${nbExp} notes de frais, ` +
    `${nbEnr} inscriptions, évaluations 9-box pour ${sotraIds.length} employés, ` +
    `${nbMm} paiements Mobile Money (${lastClosed}), ${nbCnps} déclarations CNPS, DISA, notifications`)

  // ─────────────────────────────────────────────────────────────────────────────
  // TENANT 2 — Cabinet Expertise CI
  // ─────────────────────────────────────────────────────────────────────────────
  const cabinetSlug   = 'cabinet-expertise-ci'
  const cabinetSchema = 'tenant_cabinet_expertise_ci'
  const cabinetAtRate = 0.020 // Services

  const cabinetRes = await pool.query<{ id: string }>(`
    INSERT INTO platform.tenants
      (name, slug, schema_name, plan_type, status, sector, city,
       cnps_number, at_rate, max_users, max_employees, primary_color, secondary_color)
    VALUES
      ('Cabinet Expertise CI', $1, $2, 'starter', 'active', 'services', 'Abidjan',
       'CI000567890', $3, 50, 50, '#1D4ED8', '#3B82F6')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [cabinetSlug, cabinetSchema, cabinetAtRate.toString()])

  console.log('[8/10] Tenant Cabinet Expertise CI créé')
  await provisionTenantSchema(cabinetSchema)
  await seedPayrollRulesCI(cabinetSchema, cabinetAtRate)
  await seedAbsenceTypesCI(cabinetSchema)

  // Utilisateurs Cabinet
  const cabAdminHash = await bcrypt.hash('Admin1234!', 12)
  await pool.query(`
    INSERT INTO "${cabinetSchema}".users (email, password_hash, first_name, last_name, role, is_active, last_login_at)
    VALUES
      ('admin@cabinet-expertise.ci',   $1, 'Directeur', 'Associé',   'admin',    true, now()),
      ('employe2@cabinet-expertise.ci', $1, 'Amenan',    'Traoré',    'employee', true, now())
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
  `, [cabAdminHash])

  await pool.query(`
    INSERT INTO "${cabinetSchema}".workflow_configs (module, levels_count)
    VALUES ('absences', 1), ('expenses', 1)
    ON CONFLICT DO NOTHING
  `)

  // Départements Cabinet
  const cabDeptIds: string[] = []
  for (const dept of CABINET_DEPTS) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${cabinetSchema}".departments (name)
      VALUES ($1)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [dept.name])
    if (res.rows[0]) cabDeptIds.push(res.rows[0].id)
    else {
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM "${cabinetSchema}".departments WHERE name = $1`, [dept.name]
      )
      if (existing.rows[0]) cabDeptIds.push(existing.rows[0].id)
    }
  }

  // Employés Cabinet (25)
  const cabinetEmployees: Array<{ id: string; baseSalary: number; maritalStatus: string; childrenCount: number }> = []
  let cabEmpIdx = 0

  for (let di = 0; di < CABINET_DEPTS.length; di++) {
    const dept    = CABINET_DEPTS[di]!
    const deptId  = cabDeptIds[di] ?? ''

    for (let i = 0; i < dept.size; i++) {
      const isFemale     = Math.random() > 0.5
      const firstName    = randItem(isFemale ? PRENOMS_F : PRENOMS_H)
      const lastName     = randItem(NOMS)
      const provider     = randItem(MOBILE_PROVIDERS)
      const phone        = ciPhone(provider)
      const maritalStatus = randItem(MARITAL_STATUSES)
      const childrenCount = maritalStatus === 'single' ? 0 : randInt(0, 3)
      const baseSalary   = roundFCFA(randInt(dept.baseSalaryRange[0], dept.baseSalaryRange[1]))

      const isAmenan = cabEmpIdx === 0
      const email    = isAmenan
        ? 'employe2@cabinet-expertise.ci'
        : `${firstName.toLowerCase().replace(/[^a-z]/g, '')}.${lastName.toLowerCase().replace(/[^a-z]/g, '')}${cabEmpIdx}@cabinet-expertise.ci`

      const res = await pool.query<{ id: string }>(`
        INSERT INTO "${cabinetSchema}".employees
          (first_name, last_name, email, gender, nni, cnps_number,
           mobile_money_provider, mobile_money_phone,
           department_id, contract_type, hire_date, base_salary,
           city, marital_status, children_count, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'cdi',$10,$11,'Abidjan',$12,$13,true)
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `, [
        firstName, lastName, email, isFemale ? 'F' : 'M',
        nni(), cnpsNum(), provider, phone, deptId,
        pastDate(randInt(6, 48)), baseSalary, maritalStatus, childrenCount,
      ])

      if (res.rows[0]) {
        cabinetEmployees.push({ id: res.rows[0].id, baseSalary, maritalStatus, childrenCount })
      }
      cabEmpIdx++
    }
  }

  // Lier employe2 à Amenan
  if (cabinetEmployees[0]) {
    await pool.query(
      `UPDATE "${cabinetSchema}".users SET employee_id = $1 WHERE email = 'employe2@cabinet-expertise.ci'`,
      [cabinetEmployees[0].id]
    )
  }

  // Types d'absence Cabinet
  const cabAbsTypeRes = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM "${cabinetSchema}".absence_types`
  )
  const cabAbsTypeMap: Record<string, string> = {}
  for (const t of cabAbsTypeRes.rows) { cabAbsTypeMap[t.code] = t.id }

  // Soldes Cabinet
  for (const emp of cabinetEmployees) {
    for (const [code, typeId] of Object.entries(cabAbsTypeMap)) {
      const isCP = code === 'CP'
      await pool.query(`
        INSERT INTO "${cabinetSchema}".absence_balances
          (employee_id, absence_type_id, year, acquired, taken, pending, remaining)
        VALUES ($1,$2,$3,$4,0,0,$4)
        ON CONFLICT DO NOTHING
      `, [emp.id, typeId, new Date().getFullYear(), isCP ? 26 : 5])
    }
  }

  // Bulletins Cabinet — les 3 derniers mois révolus (dates relatives)
  const cabinetPeriods = lastClosedMonths(3)
  for (const month of cabinetPeriods) {
    const [yr, mo] = month.split('-').map(Number)
    const workingDays = getWorkingDays(yr!, mo!)

    const periodRes = await pool.query<{ id: string }>(`
      INSERT INTO "${cabinetSchema}".pay_periods (month, status, closed_at, closed_by)
      VALUES ($1, 'closed', now(), 'seed')
      ON CONFLICT (month, legal_entity_id) DO UPDATE SET status = 'closed'
      RETURNING id
    `, [month])
    const periodId = periodRes.rows[0]?.id ?? ''

    for (const emp of cabinetEmployees) {
      const result = calculatePayrollCI({
        baseSalary:       emp.baseSalary,
        workedDays:       workingDays,
        workingDaysMonth: workingDays,
        atRate:           cabinetAtRate,
        maritalStatus:    emp.maritalStatus,
        childrenCount:    emp.childrenCount,
        variableElements: {},
      })

      await pool.query(`
        INSERT INTO "${cabinetSchema}".pay_slips
          (employee_id, period_id, month, base_salary, gross_salary,
           cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
           total_cnps_sal, total_cnps_pat, its, total_deductions,
           net_payable, employer_cost, lines, status, generated_at,
           payment_method, payment_status, currency)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                'generated',now(),'wave','paid','XOF')
        ON CONFLICT DO NOTHING
      `, [
        emp.id, periodId, month, emp.baseSalary, result.grossSalary,
        result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
        result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
        result.netPayable, result.employerCost, JSON.stringify(result.lines),
      ])
    }
  }
  console.log(`[9/10] ${cabinetEmployees.length * cabinetPeriods.length} bulletins Cabinet créés (3 mois)`)

  // ─── Contrats OHADA pour tous les employés Cabinet Expertise ─────────────────
  const cabContractTypes = ['cdi','cdi','cdi','cdd'] // 75% CDI, 25% CDD
  for (let ci = 0; ci < cabinetEmployees.length; ci++) {
    const emp    = cabinetEmployees[ci]!
    const ctype  = cabContractTypes[ci % cabContractTypes.length]!
    const startDate = new Date(2021 + Math.floor(ci / 12), ci % 12, 1)
    const endDate   = ctype === 'cdd'
      ? new Date(startDate.getFullYear() + 1, startDate.getMonth(), startDate.getDate())
      : null
    const isManager = ci < 3
    const trialDays = isManager ? 30 : 15
    const trialEnd  = new Date(startDate)
    trialEnd.setDate(trialEnd.getDate() + trialDays)
    await pool.query(`
      INSERT INTO "${cabinetSchema}".contracts
        (employee_id, type, start_date, end_date, trial_end_date, base_salary,
         working_hours, convention, job_title, job_level,
         cnps_affiliation, ohada_clause, non_competition_clause,
         telecommuting_days, status)
      VALUES ($1,$2,$3,$4,$5,$6,40,'Services (audit, conseil)',
              $7,$8,true,true,true,1,'active')
      ON CONFLICT DO NOTHING
    `, [
      emp.id, ctype,
      startDate.toISOString().split('T')[0],
      endDate ? endDate.toISOString().split('T')[0] : null,
      trialEnd.toISOString().split('T')[0],
      emp.baseSalary,
      isManager ? 'Manager' : ci % 2 === 0 ? 'Auditeur' : 'Consultant',
      isManager ? 'Cadre supérieur' : 'Cadre',
    ])
  }
  console.log(`[9b/10] ${cabinetEmployees.length} contrats OHADA Cabinet créés`)

  // ─── Formations Cabinet Expertise CI ─────────────────────────────────────────
  const cabTrainings = [
    { title: 'Audit & Comptabilité OHADA', description: 'Normes OHADA, états financiers, audit légal CI.', duration: 16, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Fiscalité des entreprises en CI', description: 'Impôts DGI : BIC, TVA, patente, ITS. Optimisation fiscale légale.', duration: 12, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Excel & Power BI pour consultants', description: 'Analyse de données, dashboards, modèles financiers.', duration: 8, format: 'e-learning', is_fdfp_eligible: false },
    { title: 'Gestion RH & Paie CI', description: 'CNPS, ITS/DGI, contrats OHADA, DISA.', duration: 8, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Leadership & Communication', description: 'Management, prise de parole, gestion des équipes.', duration: 6, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'RGPD & ARTCI — Protection des données', description: 'Conformité données personnelles en Côte d\'Ivoire.', duration: 4, format: 'e-learning', is_fdfp_eligible: false },
  ]
  const cabTrainingIds: string[] = []
  for (const tr of cabTrainings) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${cabinetSchema}".trainings
        (title, description, duration, format, is_fdfp_eligible, is_active)
      VALUES ($1,$2,$3,$4,$5,true)
      ON CONFLICT DO NOTHING RETURNING id
    `, [tr.title, tr.description, tr.duration, tr.format, tr.is_fdfp_eligible])
    if (res.rows[0]) cabTrainingIds.push(res.rows[0].id)
  }
  // Sessions planifiées pour Cabinet
  const cabSessionIds: string[] = []
  for (let i = 0; i < Math.min(cabTrainingIds.length, 3); i++) {
    const futureDay = (d: number) => { const dt = new Date(); dt.setDate(dt.getDate() + d); return dt.toISOString().split('T')[0] }
    const sres = await pool.query<{ id: string }>(`
      INSERT INTO "${cabinetSchema}".training_sessions
        (training_id, start_date, end_date, location, trainer, max_places, status)
      VALUES ($1,$2,$3,'Plateau — Salle Conférence','Expert FDFP',15,'planned')
      ON CONFLICT DO NOTHING RETURNING id
    `, [cabTrainingIds[i]!, futureDay(20 + i * 14), futureDay(21 + i * 14)])
    if (sres.rows[0]) cabSessionIds.push(sres.rows[0].id)
  }
  console.log(`[9c/10] ${cabTrainings.length} formations + sessions Cabinet CI créées`)

  // ─── Recrutement Cabinet Expertise : 2 offres + pipeline kanban rempli ───────
  const cabJobsData = [
    {
      title: 'Auditeur Senior', location: 'Abidjan (Plateau)',
      salaryMin: 450_000, salaryMax: 700_000,
      description: 'Missions d\'audit légal et contractuel pour des clients OHADA. Encadrement de juniors.',
      requirements: 'Bac+5 CCA / DSCG, 5 ans d\'expérience en cabinet, maîtrise des normes OHADA.',
    },
    {
      title: 'Juriste OHADA', location: 'Abidjan (Plateau)',
      salaryMin: 400_000, salaryMax: 600_000,
      description: 'Conseil juridique aux entreprises : droit des sociétés, contrats, contentieux OHADA.',
      requirements: 'Master 2 droit des affaires, 3 ans d\'expérience, connaissance du droit ivoirien.',
    },
  ]
  for (const job of cabJobsData) {
    const jres = await pool.query<{ id: string }>(`
      INSERT INTO "${cabinetSchema}".recruitment_jobs
        (title, location, contract_type, salary_min, salary_max,
         description, requirements, status, visibility, published_at, public_slug)
      VALUES ($1,$2,'cdi',$3,$4,$5,$6,'open','external',now(),$7)
      ON CONFLICT DO NOTHING RETURNING id
    `, [job.title, job.location, job.salaryMin, job.salaryMax,
        job.description, job.requirements,
        job.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80)])
    if (jres.rows[0]) await seedApplicationsForJob(pool, cabinetSchema, jres.rows[0].id, 7)
  }

  // ─── Compétences Cabinet (référentiel services/audit) ────────────────────────
  const cabSkillsData = [
    { name: 'Audit financier', category: 'technique' },
    { name: 'Normes OHADA', category: 'technique' },
    { name: 'Fiscalité ivoirienne (DGI)', category: 'technique' },
    { name: 'Excel / Power BI', category: 'transversal' },
    { name: 'Rédaction juridique', category: 'technique' },
    { name: 'Relation client', category: 'comportemental' },
    { name: 'Gestion de projet', category: 'transversal' },
    { name: 'Communication professionnelle', category: 'comportemental' },
    { name: 'Management d\'équipe', category: 'managérial' },
    { name: 'Anglais professionnel', category: 'transversal' },
  ]
  const cabSkillIds: string[] = []
  for (const sk of cabSkillsData) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${cabinetSchema}".career_skills (name, category)
      VALUES ($1,$2)
      ON CONFLICT DO NOTHING RETURNING id
    `, [sk.name, sk.category])
    if (res.rows[0]) cabSkillIds.push(res.rows[0].id)
  }

  // ─── Onboarding Cabinet : modèles + parcours (Amenan en cours) ───────────────
  await seedOnboarding(cabinetSchema, cabinetEmployees.map((e) => e.id), false)
    .catch((e: unknown) => console.warn('[!] Onboarding Cabinet (non bloquant):', (e as Error).message))

  // ─── Enrichissement « zéro écran vide » Cabinet Expertise ────────────────────
  const cabIds = cabinetEmployees.map((e) => e.id)
  await seedAbsencesBulk(pool, cabinetSchema, cabIds, cabAbsTypeMap)
  await recomputeAbsenceBalances(pool, cabinetSchema)
  await seedExpensesBulk(pool, cabinetSchema, cabIds)
  await seedEnrollmentsBulk(pool, cabinetSchema, cabIds, cabSessionIds)
  await seedSkillsEvaluationsBulk(pool, cabinetSchema, cabIds, cabSkillIds,
    'admin@cabinet-expertise.ci', cabinetEmployees[0] ? [cabinetEmployees[0].id] : [])
  await seedHrEventsBulk(pool, cabinetSchema)
  await seedNotificationsBulk(pool, cabinetSchema)
  const cabLastClosed = cabinetPeriods[cabinetPeriods.length - 1]!
  await seedMobileMoneyCampaign(pool, cabinetSchema, cabLastClosed)
  await seedCnpsDeclarationsFromPayslips(pool, cabinetSchema, cabinetPeriods)
  for (const yr of new Set(cabinetPeriods.map((m) => Number(m.slice(0, 4))))) {
    await seedDisaFromPayslips(pool, cabinetSchema, yr)
  }
  console.log('[9d/10] Cabinet Expertise enrichi : recrutement, onboarding, absences, frais, ' +
    'inscriptions, 9-box, Mobile Money, CNPS, DISA, notifications')

  // ─────────────────────────────────────────────────────────────────────────────
  // TENANT 3 — OpenLab Consulting (tenant créé via portail)
  // ─────────────────────────────────────────────────────────────────────────────
  const openlabSlug   = 'openlab-consulting'
  const openlabSchema = 'tenant_openlab_consulting'
  const openlabAtRate = 0.020

  await pool.query<{ id: string }>(`
    INSERT INTO platform.tenants
      (name, slug, schema_name, plan_type, status, sector, city, at_rate,
       max_users, max_employees, primary_color, secondary_color)
    VALUES
      ('OpenLab Consulting', $1, $2, 'business', 'active', 'services', 'Abidjan', $3,
       50, 100, '#7C3AED', '#A78BFA')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [openlabSlug, openlabSchema, openlabAtRate.toString()])

  await provisionTenantSchema(openlabSchema)
  await seedPayrollRulesCI(openlabSchema, openlabAtRate)
  await seedAbsenceTypesCI(openlabSchema)

  const openlabHash = await bcrypt.hash('Openlab1234!', 12)
  await pool.query(`
    INSERT INTO "${openlabSchema}".users (email, password_hash, first_name, last_name, role, is_active, last_login_at)
    VALUES ('coulwao@gmail.com', $1, 'Coulwao', 'Admin', 'admin', true, now())
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `, [openlabHash])

  // Offre + profils sourcés pour OpenLab — démo multi-pays Afrique
  const openlabJob = await pool.query<{ id: string }>(`
    INSERT INTO "${openlabSchema}".recruitment_jobs
      (title, location, contract_type, salary_min, salary_max, currency,
       description, requirements, status, visibility, published_at, public_slug)
    VALUES
      ('Consultant Senior Transformation Digitale',
       'Abidjan (avec déplacements régionaux)',
       'cdi', 1500000, 2500000, 'XOF',
       'Conduite de missions de transformation digitale pour clients OHADA. Filiales CI, SN, BJ, TG.',
       'Bac+5, 6+ ans en conseil/transformation, anglais professionnel, mobilité Afrique de l''Ouest.',
       'open', 'external', now(), 'consultant-senior-transformation-digitale')
    ON CONFLICT DO NOTHING
    RETURNING id
  `)
  const openlabJobId = openlabJob.rows[0]?.id
  if (openlabJobId) {
    await seedSourced(openlabSchema, openlabJobId, [
      { fn: 'Olivia',   ln: 'Ndiaye',    pos: 'Senior Manager Digital',      company: 'Deloitte Dakar',     loc: 'Dakar, SN',    yrs: 9,  skills: ['Transformation digitale', 'Change management', 'Anglais courant'], score: 92, avail: '1month',    platform: 'LinkedIn',     salary: 2_200_000, phone: '+221 7700001111', approach: 'Profil très sénior, ouverte à mobilité Abidjan pour cabinet panafricain en croissance.' },
      { fn: 'Kofi',     ln: 'Mensah',    pos: 'Lead Consultant Tech',         company: 'PwC Accra',           loc: 'Accra, GH',    yrs: 7,  skills: ['Cloud AWS/Azure', 'Agile@Scale', 'Anglais natif'],                score: 85, avail: 'passive',   platform: 'LinkedIn',     salary: 2_100_000, phone: '+233 244000111',  approach: 'Bilingue anglais/français basique, intéressé par contexte francophone régional.' },
      { fn: 'Yannick',  ln: 'Mballa',    pos: 'Consultant transformation',    company: 'EY Cameroun',          loc: 'Douala, CM',   yrs: 6,  skills: ['Process design', 'SAP', 'OHADA'],                                  score: 80, avail: '3months',   platform: 'Africawork',  salary: 1_800_000, phone: '+237 690001112',  approach: 'Connaissance solide du droit OHADA, intéressé par CI ou SN.' },
      { fn: 'Laëtitia', ln: 'Boni',      pos: 'Manager Digital Strategy',    company: 'Société Générale CI', loc: 'Abidjan, CI',  yrs: 8,  skills: ['Stratégie digitale', 'Banking', 'Data viz'],                       score: 89, avail: 'immediate', platform: 'LinkedIn',     salary: 2_300_000, phone: '+225 0707010203', approach: 'Cherche évolution rapide vers poste de direction. Profil banque-finance.' },
      { fn: 'Adama',    ln: 'Diop',      pos: 'Principal Consultant',         company: 'Sopra Steria Paris',   loc: 'Paris, FR (diaspora SN)', yrs: 11, skills: ['Architecture SI', 'PMO', 'Anglais courant'],            score: 88, avail: '3months',   platform: 'LinkedIn',     salary: 2_500_000, phone: '+33 612345678',   approach: 'Diaspora sénégalaise envisageant retour Afrique. Très expérimenté projets multi-sites.' },
    ], ['CI', 'SN', 'BJ', 'CM', 'GH', 'FR'])
    console.log('  [OpenLab] Offre + 5 profils sourcés multi-pays')
  }

  // ─── OpenLab : dotation complète (l'admin coulwao@gmail.com ne voit AUCUN ─────
  // écran vide : effectifs, paie, absences, frais, formations, carrière,
  // recrutement, onboarding, CNPS, Mobile Money, notifications).
  await pool.query(`
    INSERT INTO "${openlabSchema}".workflow_configs (module, levels_count)
    VALUES ('absences', 1), ('expenses', 1)
    ON CONFLICT DO NOTHING
  `)

  const OPENLAB_DEPTS = [
    { name: 'Conseil & Transformation', size: 6, baseSalaryRange: [250_000, 900_000] as [number, number] },
    { name: 'Technologie & Data',       size: 4, baseSalaryRange: [300_000, 1_200_000] as [number, number] },
    { name: 'Administration',           size: 2, baseSalaryRange: [150_000, 300_000] as [number, number] },
  ]
  const openlabDeptIds: string[] = []
  for (const dept of OPENLAB_DEPTS) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${openlabSchema}".departments (name)
      VALUES ($1) ON CONFLICT DO NOTHING RETURNING id
    `, [dept.name])
    if (res.rows[0]) openlabDeptIds.push(res.rows[0].id)
  }

  const openlabEmployees: Array<{ id: string; baseSalary: number; maritalStatus: string; childrenCount: number }> = []
  let olEmpIdx = 0
  for (let di = 0; di < OPENLAB_DEPTS.length; di++) {
    const dept = OPENLAB_DEPTS[di]!
    for (let i = 0; i < dept.size; i++) {
      const isFemale = Math.random() > 0.5
      const firstName = randItem(isFemale ? PRENOMS_F : PRENOMS_H)
      const lastName = randItem(NOMS)
      const provider = randItem(MOBILE_PROVIDERS)
      const maritalStatus = randItem(MARITAL_STATUSES)
      const childrenCount = maritalStatus === 'single' ? 0 : randInt(0, 3)
      const baseSalary = roundFCFA(randInt(dept.baseSalaryRange[0], dept.baseSalaryRange[1]))
      const res = await pool.query<{ id: string }>(`
        INSERT INTO "${openlabSchema}".employees
          (first_name, last_name, email, gender, nni, cnps_number,
           mobile_money_provider, mobile_money_phone,
           department_id, job_title, contract_type, hire_date, base_salary,
           city, marital_status, children_count, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'cdi',$11,$12,'Abidjan',$13,$14,true)
        ON CONFLICT (email) DO NOTHING RETURNING id
      `, [
        firstName, lastName,
        `${firstName.toLowerCase().replace(/[^a-z]/g, '')}.${lastName.toLowerCase().replace(/[^a-z]/g, '')}${olEmpIdx}@openlabconsulting.com`,
        isFemale ? 'F' : 'M', nni(), cnpsNum(), provider, ciPhone(provider),
        openlabDeptIds[di] ?? null,
        di === 0 ? 'Consultant' : di === 1 ? 'Ingénieur' : 'Assistant administratif',
        pastDate(randInt(4, 36)), baseSalary, maritalStatus, childrenCount,
      ])
      if (res.rows[0]) {
        openlabEmployees.push({ id: res.rows[0].id, baseSalary, maritalStatus, childrenCount })
      }
      olEmpIdx++
    }
  }

  // Contrats OHADA OpenLab
  for (let ci = 0; ci < openlabEmployees.length; ci++) {
    const emp = openlabEmployees[ci]!
    const startDate = new Date()
    startDate.setMonth(startDate.getMonth() - randInt(4, 36))
    const trialEnd = new Date(startDate)
    trialEnd.setDate(trialEnd.getDate() + (ci < 3 ? 30 : 15))
    await pool.query(`
      INSERT INTO "${openlabSchema}".contracts
        (employee_id, type, start_date, trial_end_date, base_salary,
         working_hours, convention, job_title, job_level,
         cnps_affiliation, ohada_clause, non_competition_clause, telecommuting_days, status)
      VALUES ($1,'cdi',$2,$3,$4,40,'Services (conseil)',$5,$6,true,true,true,2,'active')
      ON CONFLICT DO NOTHING
    `, [
      emp.id, startDate.toISOString().split('T')[0], trialEnd.toISOString().split('T')[0],
      emp.baseSalary, ci < 3 ? 'Manager' : 'Consultant', ci < 3 ? 'Cadre supérieur' : 'Cadre',
    ])
  }

  // Soldes d'absence OpenLab
  const olAbsTypeRes = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM "${openlabSchema}".absence_types`)
  const olAbsTypeMap: Record<string, string> = {}
  for (const t of olAbsTypeRes.rows) { olAbsTypeMap[t.code] = t.id }
  for (const emp of openlabEmployees) {
    for (const [code, typeId] of Object.entries(olAbsTypeMap)) {
      const isCP = code === 'CP'
      await pool.query(`
        INSERT INTO "${openlabSchema}".absence_balances
          (employee_id, absence_type_id, year, acquired, taken, pending, remaining)
        VALUES ($1,$2,$3,$4,0,0,$4)
        ON CONFLICT DO NOTHING
      `, [emp.id, typeId, new Date().getFullYear(), isCP ? 26 : 5])
    }
  }

  // Bulletins OpenLab — 3 derniers mois révolus
  const openlabPeriods = lastClosedMonths(3)
  for (const month of openlabPeriods) {
    const [yr, mo] = month.split('-').map(Number)
    const workingDays = getWorkingDays(yr!, mo!)
    const periodRes = await pool.query<{ id: string }>(`
      INSERT INTO "${openlabSchema}".pay_periods (month, status, closed_at, closed_by)
      VALUES ($1, 'closed', now(), 'seed')
      ON CONFLICT (month, legal_entity_id) DO UPDATE SET status = 'closed'
      RETURNING id
    `, [month])
    const periodId = periodRes.rows[0]?.id ?? ''
    let tg = 0, tn = 0, tc = 0, ti = 0
    for (const emp of openlabEmployees) {
      const result = calculatePayrollCI({
        baseSalary: emp.baseSalary, workedDays: workingDays, workingDaysMonth: workingDays,
        atRate: openlabAtRate, maritalStatus: emp.maritalStatus,
        childrenCount: emp.childrenCount, variableElements: {},
      })
      tg += result.grossSalary; tn += result.netPayable
      tc += result.totalCnpsSal + result.totalCnpsPat; ti += result.its
      await pool.query(`
        INSERT INTO "${openlabSchema}".pay_slips
          (employee_id, period_id, month, base_salary, gross_salary,
           cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
           total_cnps_sal, total_cnps_pat, its, total_deductions,
           net_payable, employer_cost, lines, status, generated_at,
           payment_method, payment_status, currency)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                'generated',now(),'wave','paid','XOF')
        ON CONFLICT DO NOTHING
      `, [
        emp.id, periodId, month, emp.baseSalary, result.grossSalary,
        result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
        result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
        result.netPayable, result.employerCost, JSON.stringify(result.lines),
      ])
    }
    await pool.query(`
      UPDATE "${openlabSchema}".pay_periods
      SET total_gross = $1, total_net = $2, total_cnps = $3, total_its = $4
      WHERE id = $5
    `, [tg, tn, tc, ti, periodId])
  }

  // Formations + sessions OpenLab
  const olTrainings = [
    { title: 'Méthodologie de conseil', description: 'Cadrage, diagnostic, recommandations, restitution client.', duration: 12, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'Data & IA pour consultants', description: 'Fondamentaux data, prompts IA, automatisation des livrables.', duration: 8, format: 'e-learning', is_fdfp_eligible: false },
    { title: 'Gestion de projet Agile', description: 'Scrum, Kanban, pilotage de projets de transformation.', duration: 8, format: 'presentiel', is_fdfp_eligible: true },
    { title: 'RGPD & ARTCI — Protection des données', description: 'Conformité données personnelles en Côte d\'Ivoire.', duration: 4, format: 'e-learning', is_fdfp_eligible: false },
  ]
  const olTrainingIds: string[] = []
  for (const tr of olTrainings) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${openlabSchema}".trainings
        (title, description, duration, format, is_fdfp_eligible, is_active)
      VALUES ($1,$2,$3,$4,$5,true)
      ON CONFLICT DO NOTHING RETURNING id
    `, [tr.title, tr.description, tr.duration, tr.format, tr.is_fdfp_eligible])
    if (res.rows[0]) olTrainingIds.push(res.rows[0].id)
  }
  const olSessionIds: string[] = []
  for (let i = 0; i < Math.min(olTrainingIds.length, 2); i++) {
    const sres = await pool.query<{ id: string }>(`
      INSERT INTO "${openlabSchema}".training_sessions
        (training_id, start_date, end_date, location, trainer, max_places, status)
      VALUES ($1,$2,$3,'Cocody — Salle Innovation','Consultant senior OpenLab',12,'planned')
      ON CONFLICT DO NOTHING RETURNING id
    `, [olTrainingIds[i]!, dateOffsetStr(18 + i * 12), dateOffsetStr(19 + i * 12)])
    if (sres.rows[0]) olSessionIds.push(sres.rows[0].id)
  }

  // Compétences OpenLab
  const olSkillsData = [
    { name: 'Conseil en transformation', category: 'technique' },
    { name: 'Architecture SI', category: 'technique' },
    { name: 'Data & analytics', category: 'technique' },
    { name: 'Gestion de projet', category: 'transversal' },
    { name: 'Relation client', category: 'comportemental' },
    { name: 'Communication professionnelle', category: 'comportemental' },
    { name: 'Management d\'équipe', category: 'managérial' },
    { name: 'Anglais professionnel', category: 'transversal' },
  ]
  const olSkillIds: string[] = []
  for (const sk of olSkillsData) {
    const res = await pool.query<{ id: string }>(`
      INSERT INTO "${openlabSchema}".career_skills (name, category)
      VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id
    `, [sk.name, sk.category])
    if (res.rows[0]) olSkillIds.push(res.rows[0].id)
  }

  // Pipeline kanban sur l'offre existante + onboarding + enrichissement complet
  if (openlabJobId) await seedApplicationsForJob(pool, openlabSchema, openlabJobId, 7)
  await seedOnboarding(openlabSchema, openlabEmployees.map((e) => e.id), false)
    .catch((e: unknown) => console.warn('[!] Onboarding OpenLab (non bloquant):', (e as Error).message))

  const olIds = openlabEmployees.map((e) => e.id)
  await seedAbsencesBulk(pool, openlabSchema, olIds, olAbsTypeMap)
  await recomputeAbsenceBalances(pool, openlabSchema)
  await seedExpensesBulk(pool, openlabSchema, olIds)
  await seedEnrollmentsBulk(pool, openlabSchema, olIds, olSessionIds)
  await seedSkillsEvaluationsBulk(pool, openlabSchema, olIds, olSkillIds, 'coulwao@gmail.com')
  await seedHrEventsBulk(pool, openlabSchema)
  await seedNotificationsBulk(pool, openlabSchema)
  const olLastClosed = openlabPeriods[openlabPeriods.length - 1]!
  await seedMobileMoneyCampaign(pool, openlabSchema, olLastClosed)
  await seedCnpsDeclarationsFromPayslips(pool, openlabSchema, openlabPeriods)
  for (const yr of new Set(openlabPeriods.map((m) => Number(m.slice(0, 4))))) {
    await seedDisaFromPayslips(pool, openlabSchema, yr)
  }
  console.log(`  [OpenLab] ${openlabEmployees.length} employés, ${openlabPeriods.length} mois de paie, ` +
    'recrutement, onboarding, absences, frais, formations, 9-box, CNPS, Mobile Money, notifications')

  console.log('[10/10] Tenant OpenLab Consulting créé: coulwao@gmail.com / Openlab1234!')

  // ─────────────────────────────────────────────────────────────────────────────
  // CABINET DE RECRUTEMENT — Cabinet Talents CI (gère SOTRA + Cabinet Expertise)
  // ─────────────────────────────────────────────────────────────────────────────
  const agencyHash = await bcrypt.hash('Admin1234!', 12)
  const agencyRes = await pool.query<{ id: string }>(`
    INSERT INTO platform.agencies
      (slug, name, status, country_code, city, contact_email, contact_phone,
       primary_color, sender_email, sender_name)
    VALUES
      ('cabinet-talents-ci', 'Cabinet Talents CI', 'active', 'CIV', 'Abidjan',
       'contact@cabinet-talents.ci', '+225 0707080910', '#1D4ED8',
       'recrutement@cabinet-talents.ci', 'Cabinet Talents CI')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status = 'active',
       sender_email = EXCLUDED.sender_email, sender_name = EXCLUDED.sender_name
    RETURNING id
  `)
  const agencyId = agencyRes.rows[0]!.id

  await pool.query(`
    INSERT INTO platform.agency_users (agency_id, email, password_hash, first_name, last_name, role, is_active)
    VALUES
      ($1, 'owner@cabinet-talents.ci',     $2, 'Awa',   'Koné',    'agency_owner',  true),
      ($1, 'recruteur@cabinet-talents.ci', $2, 'Jean',  'Brou',    'agency_member', true)
    ON CONFLICT (email) DO UPDATE SET is_active = true
  `, [agencyId, agencyHash])
  // (pas de reset du password_hash : un mot de passe cabinet changé survit au re-seed)

  // Rattachement aux 2 entreprises clientes CI (SOTRA + Cabinet Expertise).
  for (const tid of [sotraTenantId, cabinetRes.rows[0]!.id]) {
    await pool.query(`
      INSERT INTO platform.agency_tenants (agency_id, tenant_id)
      VALUES ($1, $2)
      ON CONFLICT (agency_id, tenant_id) DO UPDATE SET detached_at = NULL
    `, [agencyId, tid])
  }
  console.log('[10b] Cabinet Talents CI créé + rattaché à SOTRA et Cabinet Expertise')

  // ─────────────────────────────────────────────────────────────────────────────
  // RÉSUMÉ
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n=== Seed terminé avec succès ===\n')
  console.log('Comptes de connexion:')
  console.log('  [Super Admin]')
  console.log('  superadmin@nexusrh-ci.com  /  SuperAdmin1234!')
  console.log()
  console.log('  [SOTRA - Transports Abidjanais]')
  console.log('  admin@sotra.ci        /  Admin1234!  (admin)')
  console.log('  rh@sotra.ci           /  Admin1234!  (hr_manager)')
  console.log('  chef.perso@sotra.ci   /  Admin1234!  (hr_officer)')
  console.log('  manager@sotra.ci      /  Admin1234!  (manager — équipe Exploitation)')
  console.log('  employe@sotra.ci      /  Admin1234!  (employee)')
  console.log()
  console.log('  [Cabinet Expertise CI]')
  console.log('  admin@cabinet-expertise.ci   /  Admin1234!  (admin)')
  console.log('  employe2@cabinet-expertise.ci /  Admin1234!  (employee)')
  console.log()
  console.log('  [OpenLab Consulting]')
  console.log('  coulwao@gmail.com     /  Openlab1234!  (admin)')
  console.log()
  console.log('  [Cabinet Talents CI — cabinet de recrutement]')
  console.log('  owner@cabinet-talents.ci     /  Admin1234!  (agency_owner)')
  console.log('  recruteur@cabinet-talents.ci /  Admin1234!  (agency_member)')
  console.log('  → gère SOTRA + Cabinet Expertise CI')
  console.log()
  console.log(`  SOTRA       : ${sotraEmployees.length} employés, ${sotraPeriods.length} mois de bulletins`)
  console.log(`  Cabinet CI  : ${cabinetEmployees.length} employés, ${cabinetPeriods.length} mois de bulletins`)
  console.log('  API: http://localhost:4001')
  console.log('  Swagger: http://localhost:4001/docs')
}

async function main(): Promise<void> {
  // Les mots de passe changés par les utilisateurs survivent au re-seed.
  const preservedCredentials = await captureExistingCredentials(pool, TENANT_SCHEMAS)
  try {
    await runSeed()
  } finally {
    // CRITIQUE : même si le seed échoue en cours de route (schémas déjà DROP),
    // on restaure tout ce qui peut l'être — un seed partiel ne doit JAMAIS
    // laisser les utilisateurs déployés sans leur mot de passe.
    await restorePreservedCredentials(pool, preservedCredentials)
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Erreur seed:', err)
  process.exit(1)
})
