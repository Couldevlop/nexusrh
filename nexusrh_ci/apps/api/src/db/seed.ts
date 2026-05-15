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

// ── Main seed ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('NexusRH CI — Initialisation du seed...')

  // Nettoyage idempotent : drop des schémas tenant pour repartir propre
  for (const schema of ['tenant_sotra', 'tenant_cabinet_expertise_ci', 'tenant_openlab_consulting']) {
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
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `, [superAdminHash])
  console.log('[2/10] Super admin créé: superadmin@nexusrh-ci.com / SuperAdmin1234!')

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
      ('manager@sotra.ci',  $2, 'Chef',      'Dépôt',       'manager',    true, now()),
      ('employe@sotra.ci',  $3, 'Kouassi',   'Coulibaly',   'employee',   true, now())
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
  `, [adminHash, managerHash, employeeHash])

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

  // Bulletins de paie — 6 mois (janv à juin 2025)
  const sotraPeriods = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06']
  for (const month of sotraPeriods) {
    const [yr, mo] = month.split('-').map(Number)
    const workingDays = getWorkingDays(yr!, mo!)

    // Créer la période
    const periodRes = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".pay_periods (month, status, closed_at, closed_by)
      VALUES ($1, 'closed', now(), 'seed')
      ON CONFLICT (month) DO UPDATE SET status = 'closed'
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

  // Absences pour l'employé Kouassi (employe@sotra.ci)
  if (sotraEmployees[0] && absTypeMap['CP']) {
    const empId = sotraEmployees[0].id
    await pool.query(`
      INSERT INTO "${sotraSchema}".absences
        (employee_id, absence_type_id, start_date, end_date, days, half_day, reason, status, approved_by, approved_at)
      VALUES
        ($1,$2,'2025-01-13','2025-01-17',5,false,'Congés annuels','approved',null,now()),
        ($1,$2,'2025-03-03','2025-03-07',5,false,'Congés de détente','approved',null,now()),
        ($1,$2,'2025-06-09','2025-06-11',2,false,'Événement familial','pending',null,null)
      ON CONFLICT DO NOTHING
    `, [empId, absTypeMap['CP']])
  }

  // ─── Expense reports pour Kouassi ────────────────────────────────────────────
  if (sotraEmployees[0]) {
    const kouassiId = sotraEmployees[0].id
    const erRes1 = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".expense_reports
        (employee_id, title, month, status, submitted_at, total_amount, currency)
      VALUES ($1,'Mission terrain Bouaké','2025-03','approved',now()-interval'15 days',34500,'XOF')
      ON CONFLICT DO NOTHING RETURNING id
    `, [kouassiId])
    const erRes2 = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".expense_reports
        (employee_id, title, month, status, submitted_at, total_amount, currency)
      VALUES ($1,'Déplacement Yopougon','2025-04','submitted',now()-interval'3 days',12000,'XOF')
      ON CONFLICT DO NOTHING RETURNING id
    `, [kouassiId])
    const erRes3 = await pool.query<{ id: string }>(`
      INSERT INTO "${sotraSchema}".expense_reports
        (employee_id, title, month, status, total_amount, currency)
      VALUES ($1,'Frais repas formation','2025-05','draft',11500,'XOF')
      ON CONFLICT DO NOTHING RETURNING id
    `, [kouassiId])
    if (erRes1.rows[0]) {
      await pool.query(`
        INSERT INTO "${sotraSchema}".expense_lines
          (report_id, description, category, date, amount, currency)
        VALUES
          ($1,'Taxi Abidjan-Bouaké','transport','2025-03-10',15000,'XOF'),
          ($1,'Repas déjeuner','meals','2025-03-10',8500,'XOF'),
          ($1,'Hébergement 1 nuit','accommodation','2025-03-10',11000,'XOF')
        ON CONFLICT DO NOTHING
      `, [erRes1.rows[0].id])
    }
    if (erRes3.rows[0]) {
      await pool.query(`
        INSERT INTO "${sotraSchema}".expense_lines
          (report_id, description, category, date, amount, currency)
        VALUES
          ($1,'Repas midi formation','meals','2025-05-15',8500,'XOF'),
          ($1,'Taxi retour','transport','2025-05-15',3000,'XOF')
        ON CONFLICT DO NOTHING
      `, [erRes3.rows[0].id])
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
              CASE WHEN $7 IS NULL THEN NULL ELSE now() END)
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

  // Employee skills pour les 10 premiers employés
  for (let ei = 0; ei < Math.min(sotraEmployees.length, 10); ei++) {
    const emp = sotraEmployees[ei]!
    for (let si = 0; si < Math.min(skillIds.length, 5); si++) {
      await pool.query(`
        INSERT INTO "${sotraSchema}".employee_skills (employee_id, skill_id, level)
        VALUES ($1,$2,$3)
        ON CONFLICT (employee_id, skill_id) DO UPDATE SET level = EXCLUDED.level
      `, [emp.id, skillIds[si]!, randInt(2, 5)])
    }
  }

  // Évaluations annuelles pour les 5 premiers employés
  for (let ei = 0; ei < Math.min(sotraEmployees.length, 5); ei++) {
    const emp = sotraEmployees[ei]!
    const perfScore = (randInt(30, 50) / 10).toFixed(1)
    const skillScore = (randInt(25, 50) / 10).toFixed(1)
    await pool.query(`
      INSERT INTO "${sotraSchema}".evaluations
        (employee_id, year, type, status, global_score, skills_score,
         strengths, improvements, manager_comments)
      VALUES ($1, 2024, 'annual', 'completed', $2, $3,
        '["Ponctualité", "Fiabilité", "Esprit d''équipe"]',
        '["Développer les compétences informatiques"]',
        'Excellent collaborateur. À accompagner pour progression.')
      ON CONFLICT DO NOTHING
    `, [emp.id, perfScore, skillScore])
  }

  console.log('[7b/10] Recrutement, formations, compétences, évaluations, frais seedés')

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

  // Bulletins Cabinet — 3 mois
  const cabinetPeriods = ['2025-04', '2025-05', '2025-06']
  for (const month of cabinetPeriods) {
    const [yr, mo] = month.split('-').map(Number)
    const workingDays = getWorkingDays(yr!, mo!)

    const periodRes = await pool.query<{ id: string }>(`
      INSERT INTO "${cabinetSchema}".pay_periods (month, status, closed_at, closed_by)
      VALUES ($1, 'closed', now(), 'seed')
      ON CONFLICT (month) DO UPDATE SET status = 'closed'
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
  for (let i = 0; i < Math.min(cabTrainingIds.length, 3); i++) {
    const futureDay = (d: number) => { const dt = new Date(); dt.setDate(dt.getDate() + d); return dt.toISOString().split('T')[0] }
    await pool.query(`
      INSERT INTO "${cabinetSchema}".training_sessions
        (training_id, start_date, end_date, location, trainer, max_places, status)
      VALUES ($1,$2,$3,'Plateau — Salle Conférence','Expert FDFP',15,'planned')
      ON CONFLICT DO NOTHING
    `, [cabTrainingIds[i]!, futureDay(20 + i * 14), futureDay(21 + i * 14)])
  }
  console.log(`[9c/10] ${cabTrainings.length} formations + sessions Cabinet CI créées`)

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

  console.log('[10/10] Tenant OpenLab Consulting créé: coulwao@gmail.com / Openlab1234!')

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
  console.log('  manager@sotra.ci      /  Admin1234!  (manager)')
  console.log('  employe@sotra.ci      /  Admin1234!  (employee)')
  console.log()
  console.log('  [Cabinet Expertise CI]')
  console.log('  admin@cabinet-expertise.ci   /  Admin1234!  (admin)')
  console.log('  employe2@cabinet-expertise.ci /  Admin1234!  (employee)')
  console.log()
  console.log('  [OpenLab Consulting]')
  console.log('  coulwao@gmail.com     /  Openlab1234!  (admin)')
  console.log()
  console.log(`  SOTRA       : ${sotraEmployees.length} employés, ${sotraPeriods.length} mois de bulletins`)
  console.log(`  Cabinet CI  : ${cabinetEmployees.length} employés, ${cabinetPeriods.length} mois de bulletins`)
  console.log('  API: http://localhost:4001')
  console.log('  Swagger: http://localhost:4001/docs')

  await pool.end()
}

main().catch((err) => {
  console.error('Erreur seed:', err)
  process.exit(1)
})
