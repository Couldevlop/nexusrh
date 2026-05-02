import { Pool, PoolClient } from 'pg'
import bcrypt from 'bcryptjs'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'
import { createTenantTables } from './provisioning'

dotenvConfig({ path: resolve(process.cwd(), '../../.env') })

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://nexusrh:nexusrh@localhost:5432/nexusrh'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIRST_NAMES_M = [
  'Lucas', 'Nathan', 'Hugo', 'Théo', 'Mathieu', 'Pierre', 'Antoine',
  'Thomas', 'Julien', 'Nicolas', 'Alexis', 'Romain', 'Kevin', 'Maxime',
  'Baptiste', 'Alexandre', 'Quentin', 'Florian', 'Clément', 'Guillaume',
  'Karim', 'Mehdi', 'Youssef', 'Ibrahim', 'Léo', 'Arthur', 'Ethan',
]
const FIRST_NAMES_F = [
  'Emma', 'Léa', 'Chloé', 'Manon', 'Camille', 'Lucie', 'Marine',
  'Pauline', 'Laure', 'Margot', 'Sarah', 'Julie', 'Anaïs', 'Laura',
  'Marie', 'Céline', 'Élodie', 'Aurélie', 'Nathalie', 'Sophie',
  'Fatima', 'Aïcha', 'Amina', 'Yasmine', 'Inès', 'Zoé', 'Alice',
]
const LAST_NAMES = [
  'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit',
  'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel',
  'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier',
  'Morel', 'Girard', 'André', 'Mercier', 'Dupont', 'Lambert', 'Bonnet',
  'François', 'Martinez', 'Legrand', 'Benali', 'Diallo', 'Ngom', 'Traoré',
]

const ENGINEERING_TITLES = [
  'Développeur Frontend', 'Développeur Backend', 'Ingénieur DevOps',
  'Lead Developer', 'Architecte Logiciel', 'QA Engineer',
  'Data Engineer', 'Développeur Full Stack', 'Ingénieur Cloud',
]
const PRODUCT_TITLES = ['Product Manager', 'Product Owner', 'UX Designer', 'UI Designer', 'Business Analyst']
const MARKETING_TITLES = ['Responsable Marketing', 'Community Manager', 'SEO Manager', 'Content Manager', 'Growth Hacker']
const SALES_TITLES = ['Commercial', 'Account Manager', 'Business Developer', 'Responsable Commercial', 'Sales Engineer']
const FINANCE_TITLES = ['Contrôleur de Gestion', 'Comptable', 'Directeur Financier', 'Analyst Financier', 'Responsable Paie']

const BTP_CHANTIER_TITLES = [
  'Maçon', 'Plombier', 'Électricien', 'Charpentier', 'Peintre',
  'Carreleur', 'Plaquiste', 'Couvreur', 'Menuisier', 'Chauffagiste',
  'Serrurier', 'Vitrier', 'Terrassier', 'Chef de chantier', 'Conducteur de travaux',
]
const BTP_ADMIN_TITLES = ['Comptable', 'Secrétaire', 'Office Manager']

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomDate(start: Date, end: Date): string {
  const d = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()))
  return d.toISOString().split('T')[0] ?? ''
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

async function hash(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

// ─── Phase 0 : Platform schema & tables ──────────────────────────────────────

async function createPlatformSchema(client: PoolClient): Promise<void> {
  console.log('📐 Création du schema platform...')

  await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
  await client.query(`CREATE SCHEMA IF NOT EXISTS platform`)

  await client.query(`
    CREATE TABLE IF NOT EXISTS platform.tenants (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      slug VARCHAR(100) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      plan_type VARCHAR(20) NOT NULL DEFAULT 'trial',
      status VARCHAR(20) NOT NULL DEFAULT 'trial',
      schema_name VARCHAR(100) NOT NULL,
      max_users INTEGER NOT NULL DEFAULT 100,
      max_employees INTEGER NOT NULL DEFAULT 200,
      primary_color VARCHAR(7) NOT NULL DEFAULT '#4F46E5',
      secondary_color VARCHAR(7) NOT NULL DEFAULT '#818CF8',
      logo_url TEXT,
      favicon_url TEXT,
      custom_domain VARCHAR(255),
      trial_ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS platform.platform_users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'super_admin',
      is_active BOOLEAN NOT NULL DEFAULT true,
      mfa_enabled BOOLEAN NOT NULL DEFAULT false,
      mfa_secret VARCHAR(255),
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS platform.tenant_invitations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'admin',
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Refresh tokens for platform users
  await client.query(`
    CREATE TABLE IF NOT EXISTS platform.platform_refresh_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL,
      token TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      ip_address VARCHAR(45),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  console.log('✅ Schema platform créé')
}

// ─── Phase 1 : Super admin ────────────────────────────────────────────────────

async function seedSuperAdmin(client: PoolClient): Promise<void> {
  console.log('👑 Création du super_admin...')
  const passwordHash = await hash('SuperAdmin1234!')

  await client.query(`
    INSERT INTO platform.platform_users (email, password_hash, first_name, last_name, role)
    VALUES ('superadmin@nexusrh.com', $1, 'Super', 'Admin', 'super_admin')
    ON CONFLICT (email) DO UPDATE SET password_hash = $1
  `, [passwordHash])

  console.log('✅ superadmin@nexusrh.com / SuperAdmin1234!')
}

// ─── Seed a tenant schema with employees and all related data ────────────────

interface TenantDeptConfig {
  name: string
  code: string
  costCenter: string
  titles: string[]
  count: number
  salaryRange: [number, number]
}

async function seedTenantSchema(
  pool: Pool,
  tenant: {
    slug: string
    name: string
    schemaName: string
    planType: string
    primaryColor: string
    secondaryColor: string
    siren: string
    siret: string
    collectiveAgreement: string
    adminEmail: string
    adminPassword: string
    hrEmail?: string
    managerEmail?: string
    employeeEmail?: string
    depts: TenantDeptConfig[]
  },
): Promise<string> {
  const s = tenant.schemaName
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Create schema if not exists, then create tables
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${s}"`)
    await createTenantTables(client, s)

    // Truncate for idempotency
    await client.query(`
      TRUNCATE TABLE
        "${s}".nine_box, "${s}".evaluations, "${s}".employee_skills, "${s}".skills,
        "${s}".expense_lines, "${s}".expense_reports,
        "${s}".training_enrollments, "${s}".training_sessions, "${s}".training_courses,
        "${s}".interviews, "${s}".candidates, "${s}".job_offers,
        "${s}".absences, "${s}".absence_balances, "${s}".absence_types,
        "${s}".variable_elements, "${s}".pay_slips, "${s}".pay_periods, "${s}".payroll_rules,
        "${s}".contracts, "${s}".hr_events, "${s}".employee_documents,
        "${s}".notifications, "${s}".audit_log, "${s}".refresh_tokens,
        "${s}".employees, "${s}".departments, "${s}".users, "${s}".legal_entities
      RESTART IDENTITY CASCADE
    `)

    // ── Legal entity ─────────────────────────────────────────────────────────
    const entityRes = await client.query<{ id: string }>(`
      INSERT INTO "${s}".legal_entities
        (name, siren, siret, ape_code, collective_agreement, country_code, address)
      VALUES ($1, $2, $3, '6201Z', $4, 'FR', $5)
      RETURNING id
    `, [
      tenant.name,
      tenant.siren,
      tenant.siret,
      tenant.collectiveAgreement,
      JSON.stringify({ street: '12 rue de la Paix', city: 'Paris', postalCode: '75001', country: 'FR' }),
    ])
    const entityId = entityRes.rows[0]!.id

    // ── Departments ──────────────────────────────────────────────────────────
    const deptIds: string[] = []
    for (const d of tenant.depts) {
      const deptRes = await client.query<{ id: string }>(`
        INSERT INTO "${s}".departments (entity_id, name, code, cost_center)
        VALUES ($1, $2, $3, $4) RETURNING id
      `, [entityId, d.name, d.code, d.costCenter])
      deptIds.push(deptRes.rows[0]!.id)
    }

    // ── Demo users ───────────────────────────────────────────────────────────
    const adminHash = await hash(tenant.adminPassword)

    const adminUserRes = await client.query<{ id: string }>(`
      INSERT INTO "${s}".users (email, password_hash, first_name, last_name, role, is_active)
      VALUES ($1, $2, 'Admin', $3, 'admin', true) RETURNING id
    `, [tenant.adminEmail, adminHash, tenant.name])
    const adminUserId = adminUserRes.rows[0]!.id

    if (tenant.hrEmail) {
      await client.query(`
        INSERT INTO "${s}".users (email, password_hash, first_name, last_name, role, is_active)
        VALUES ($1, $2, 'Sophie', 'Dupont', 'hr_manager', true)
        ON CONFLICT (email) DO NOTHING
      `, [tenant.hrEmail, adminHash])
    }

    let managerUserId: string | null = null
    let managerEmpId: string | null = null
    if (tenant.managerEmail) {
      const mRes = await client.query<{ id: string }>(`
        INSERT INTO "${s}".users (email, password_hash, first_name, last_name, role, is_active)
        VALUES ($1, $2, 'Pierre', 'Martin', 'manager', true)
        ON CONFLICT (email) DO UPDATE SET password_hash = $2 RETURNING id
      `, [tenant.managerEmail, adminHash])
      managerUserId = mRes.rows[0]?.id ?? null
    }

    let aliceEmpId: string | null = null
    let aliceUserId: string | null = null
    if (tenant.employeeEmail) {
      const eRes = await client.query<{ id: string }>(`
        INSERT INTO "${s}".users (email, password_hash, first_name, last_name, role, is_active)
        VALUES ($1, $2, 'Alice', 'Martin', 'employee', true)
        ON CONFLICT (email) DO UPDATE SET password_hash = $2 RETURNING id
      `, [tenant.employeeEmail, adminHash])
      aliceUserId = eRes.rows[0]?.id ?? null
    }

    // ── Employees ────────────────────────────────────────────────────────────
    const createdEmps: Array<{ id: string; deptIdx: number; grossSalary: number }> = []
    let seq = 1

    for (let deptIdx = 0; deptIdx < tenant.depts.length; deptIdx++) {
      const dept = tenant.depts[deptIdx]!
      const deptId = deptIds[deptIdx]!

      for (let i = 0; i < dept.count; i++) {
        const isFemale = Math.random() > 0.5
        const firstName = isFemale ? rand(FIRST_NAMES_F) : rand(FIRST_NAMES_M)
        const lastName = rand(LAST_NAMES)
        const jobTitle = rand(dept.titles)
        const hireDate = randomDate(new Date('2018-01-01'), new Date('2024-01-01'))
        const grossMonthly = randInt(dept.salaryRange[0], dept.salaryRange[1]) / 12

        // First employee of dept 0 = Alice Martin (employe@ user)
        const isAlice = aliceUserId !== null && deptIdx === 0 && i === 0
        // Second employee of dept 0 = manager user
        const isManager = managerUserId !== null && deptIdx === 0 && i === 1

        const actualFirst = isAlice ? 'Alice' : (isManager ? 'Pierre' : firstName)
        const actualLast = isAlice ? 'Martin' : (isManager ? 'Martin' : lastName)
        const actualEmail = isAlice
          ? tenant.employeeEmail!
          : isManager
            ? `pierre.martin@${slugify(tenant.slug)}.fr`
            : `${firstName.toLowerCase().replace(/[^a-z]/g, '')}.${lastName.toLowerCase().replace(/[^a-z]/g, '')}${seq}@${slugify(tenant.slug)}.fr`

        const empRes = await client.query<{ id: string }>(`
          INSERT INTO "${s}".employees
            (entity_id, employee_number, profile_type, first_name, last_name, email,
             birth_date, nationality, address, hire_date, job_title, job_level,
             department_id, working_time_percentage, weekly_hours, status,
             retention_score, burnout_risk, ai_score_factors, custom_fields)
          VALUES ($1,$2,'employee',$3,$4,$5,$6,'FR',$7,$8,$9,$10,$11,'100.00','35.00','active',$12,$13,$14,$15)
          RETURNING id
        `, [
          entityId,
          `EMP${String(seq).padStart(5, '0')}`,
          actualFirst,
          actualLast,
          actualEmail,
          randomDate(new Date('1975-01-01'), new Date('2000-01-01')),
          JSON.stringify({ street: `${randInt(1, 99)} rue de la République`, city: rand(['Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Nantes']), postalCode: `${randInt(10, 99)}000`, country: 'FR' }),
          hireDate,
          jobTitle,
          rand(['junior', 'confirmed', 'senior', 'lead']),
          deptId,
          (0.5 + Math.random() * 0.5).toFixed(2),
          rand(['low', 'low', 'medium', 'high']),
          '[]',
          '{}',
        ])

        const empId = empRes.rows[0]!.id

        if (isAlice) {
          aliceEmpId = empId
          if (aliceUserId) {
            await client.query(`UPDATE "${s}".users SET employee_id = $1 WHERE id = $2`, [empId, aliceUserId])
          }
        }
        if (isManager) {
          managerEmpId = empId
          if (managerUserId) {
            await client.query(`UPDATE "${s}".users SET employee_id = $1 WHERE id = $2`, [empId, managerUserId])
          }
        }

        // Contract CDI
        await client.query(`
          INSERT INTO "${s}".contracts (employee_id, type, start_date, gross_salary, salary_basis, working_hours_per_week, collective_agreement, status)
          VALUES ($1, 'CDI', $2, $3, 'monthly', '35', $4, 'active')
        `, [empId, hireDate, grossMonthly.toFixed(2), tenant.collectiveAgreement])

        createdEmps.push({ id: empId, deptIdx, grossSalary: grossMonthly })
        seq++
      }
    }

    // Set manager's managerId for Alice if both exist
    if (aliceEmpId && managerEmpId) {
      await client.query(`UPDATE "${s}".employees SET manager_id = $1 WHERE id = $2`, [managerEmpId, aliceEmpId])
    }

    console.log(`  ✅ ${createdEmps.length} employés créés pour ${tenant.name}`)

    // ── Payroll rules ─────────────────────────────────────────────────────────
    const payrollRulesData = [
      { code: 'SALAIRE_BASE', label: 'Salaire de base', type: 'earning', formula: 'BRUT_PRORATA', order: 1 },
      { code: 'CSG_DED', label: 'CSG déductible', type: 'employee_contribution', formula: 'BASE * 0.068', base: 'BRUT * 0.9825', employee_rate: '0.068000', order: 10, legal_reference: 'Art. L136-1 CSS' },
      { code: 'CSG_NDED', label: 'CSG non déductible', type: 'employee_contribution', formula: 'BASE * 0.024', base: 'BRUT * 0.9825', employee_rate: '0.024000', order: 11, legal_reference: 'Art. L136-8 CSS' },
      { code: 'CRDS', label: 'CRDS', type: 'employee_contribution', formula: 'BASE * 0.005', base: 'BRUT * 0.9825', employee_rate: '0.005000', order: 12 },
      { code: 'MAL_SAL', label: 'Assurance maladie salariale', type: 'employee_contribution', formula: 'BRUT * 0', employee_rate: '0.000000', order: 20 },
      { code: 'RETRAITE_A_SAL', label: 'Retraite de base TA salariale', type: 'employee_contribution', formula: 'TRANCHE_A * 0.069', employee_rate: '0.069000', order: 30 },
      { code: 'ARRCO_A_SAL', label: 'AGIRC-ARRCO T1 salariale', type: 'employee_contribution', formula: 'TRANCHE_A * 0.0315', employee_rate: '0.031500', order: 31 },
      { code: 'ARRCO_B_SAL', label: 'AGIRC-ARRCO T2 salariale', type: 'employee_contribution', formula: 'TRANCHE_B * 0.0864', employee_rate: '0.086400', order: 32 },
      { code: 'CHOMAGE_SAL', label: 'Chômage salariale', type: 'employee_contribution', formula: 'TRANCHE_A * 0.024', employee_rate: '0.024000', order: 40 },
      { code: 'MUTUELLE_SAL', label: 'Mutuelle salariale', type: 'employee_contribution', formula: '45', order: 41 },
      { code: 'MAL_PAT', label: 'Assurance maladie patronale', type: 'employer_contribution', formula: '0', employer_rate: '0.070000', order: 50 },
      { code: 'AF_PAT', label: 'Allocations familiales patronale', type: 'employer_contribution', formula: '0', employer_rate: '0.034500', order: 51 },
      { code: 'AT_MP', label: 'AT/MP patronale', type: 'employer_contribution', formula: '0', employer_rate: '0.022200', order: 52 },
      { code: 'RETRAITE_A_PAT', label: 'Retraite de base TA patronale', type: 'employer_contribution', formula: '0', employer_rate: '0.085500', order: 53 },
      { code: 'ARRCO_A_PAT', label: 'AGIRC-ARRCO T1 patronale', type: 'employer_contribution', formula: '0', employer_rate: '0.047200', order: 54 },
      { code: 'ARRCO_B_PAT', label: 'AGIRC-ARRCO T2 patronale', type: 'employer_contribution', formula: '0', employer_rate: '0.129500', order: 55 },
      { code: 'CHOMAGE_PAT', label: 'Chômage patronale', type: 'employer_contribution', formula: '0', employer_rate: '0.040000', order: 56 },
      { code: 'MUTUELLE_PAT', label: 'Mutuelle patronale', type: 'employer_contribution', formula: '0', employer_rate: '0', order: 57 },
      { code: 'VEILLESSE_DEPL_SAL', label: 'Vieillesse déplafonnée sal.', type: 'employee_contribution', formula: 'BRUT * 0.004', employee_rate: '0.004000', order: 33 },
      { code: 'VEILLESSE_DEPL_PAT', label: 'Vieillesse déplafonnée pat.', type: 'employer_contribution', formula: '0', employer_rate: '0.017500', order: 58 },
    ]

    for (const r of payrollRulesData) {
      await client.query(`
        INSERT INTO "${s}".payroll_rules
          (entity_id, code, label, type, formula, base, employee_rate, employer_rate, is_active, "order", applies_to, legal_reference)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,'{}', $10)
      `, [
        entityId, r.code, r.label, r.type, r.formula,
        (r as Record<string, unknown>)['base'] ?? null,
        (r as Record<string, unknown>)['employee_rate'] ?? null,
        (r as Record<string, unknown>)['employer_rate'] ?? null,
        r.order,
        (r as Record<string, unknown>)['legal_reference'] ?? null,
      ])
    }

    console.log(`  ✅ ${payrollRulesData.length} rubriques de paie créées`)

    // ── Pay periods (6 months) ────────────────────────────────────────────────
    const PLAFOND_SS = 3864
    const periodIds: string[] = []
    const monthsCount = tenant.depts.reduce((a, d) => a + d.count, 0) >= 20 ? 6 : 3

    for (let m = 13 - monthsCount; m <= 12; m++) {
      const periodRes = await client.query<{ id: string }>(`
        INSERT INTO "${s}".pay_periods (entity_id, year, month, status, opened_at, closed_at)
        VALUES ($1, 2024, $2, 'closed', $3, $4)
        RETURNING id
      `, [
        entityId, m,
        new Date(2024, m - 1, 1).toISOString(),
        new Date(2024, m - 1, 28).toISOString(),
      ])
      periodIds.push(periodRes.rows[0]!.id)
    }

    console.log(`  ✅ ${periodIds.length} périodes de paie créées`)

    // ── Pay slips ─────────────────────────────────────────────────────────────
    for (const periodId of periodIds) {
      let totalGross = 0
      let totalNet = 0
      let totalCost = 0

      for (const emp of createdEmps) {
        const brut = emp.grossSalary
        const trancheA = Math.min(brut, PLAFOND_SS)
        const trancheB = Math.max(0, brut - PLAFOND_SS)
        const baseCSG = brut * 0.9825

        const cotisationsSal =
          baseCSG * 0.068 + baseCSG * 0.024 + baseCSG * 0.005 +
          trancheA * 0.069 + trancheA * 0.0315 + trancheB * 0.0864 +
          trancheA * 0.024 + brut * 0.004 + 45

        const cotisationsPat =
          brut * 0.07 + brut * 0.0345 + brut * 0.0222 +
          trancheA * 0.0855 + trancheA * 0.0472 + trancheB * 0.1295 +
          brut * 0.04 + brut * 0.0175 + 90

        const net = brut - cotisationsSal
        const employerCost = brut + cotisationsPat

        const lines = [
          { ruleCode: 'SALAIRE_BASE', label: 'Salaire de base', base: brut, employeeAmount: brut, employerAmount: 0, type: 'earning' },
          { ruleCode: 'CSG_DED', label: 'CSG déductible', base: baseCSG, employeeRate: 0.068, employeeAmount: -(baseCSG * 0.068), employerAmount: 0, type: 'employee_contribution' },
          { ruleCode: 'CSG_NDED', label: 'CSG non déductible', base: baseCSG, employeeRate: 0.024, employeeAmount: -(baseCSG * 0.024), employerAmount: 0, type: 'employee_contribution' },
          { ruleCode: 'CRDS', label: 'CRDS', base: baseCSG, employeeRate: 0.005, employeeAmount: -(baseCSG * 0.005), employerAmount: 0, type: 'employee_contribution' },
          { ruleCode: 'RETRAITE_A_SAL', label: 'Retraite TA sal.', base: trancheA, employeeRate: 0.069, employeeAmount: -(trancheA * 0.069), employerAmount: 0, type: 'employee_contribution' },
          { ruleCode: 'ARRCO_A_SAL', label: 'AGIRC-ARRCO T1 sal.', base: trancheA, employeeRate: 0.0315, employeeAmount: -(trancheA * 0.0315), employerAmount: 0, type: 'employee_contribution' },
          { ruleCode: 'MUTUELLE_SAL', label: 'Mutuelle sal.', base: 0, employeeAmount: -45, employerAmount: 0, type: 'employee_contribution' },
          { ruleCode: 'MAL_PAT', label: 'Maladie pat.', base: brut, employerRate: 0.07, employeeAmount: 0, employerAmount: brut * 0.07, type: 'employer_contribution' },
          { ruleCode: 'AF_PAT', label: 'Alloc. fam. pat.', base: brut, employerRate: 0.0345, employeeAmount: 0, employerAmount: brut * 0.0345, type: 'employer_contribution' },
        ]

        await client.query(`
          INSERT INTO "${s}".pay_slips
            (employee_id, period_id, year, month, gross_salary, net_before_tax, income_tax,
             net_payable, employer_cost, lines, working_days, status, generated_at)
          VALUES ($1,$2,2024,$3,$4,$5,0,$6,$7,$8,22,'generated',NOW())
        `, [
          emp.id, periodId,
          periodIds.indexOf(periodId) + (13 - monthsCount),
          brut.toFixed(2),
          net.toFixed(2),
          net.toFixed(2),
          employerCost.toFixed(2),
          JSON.stringify(lines),
        ])

        totalGross += brut
        totalNet += net
        totalCost += employerCost
      }

      await client.query(`
        UPDATE "${s}".pay_periods
        SET total_gross = $1, total_net = $2, total_employer_cost = $3
        WHERE id = $4
      `, [totalGross.toFixed(2), totalNet.toFixed(2), totalCost.toFixed(2), periodId])
    }

    console.log(`  ✅ ${createdEmps.length * periodIds.length} bulletins de paie générés`)

    // ── Variable elements (historical — last closed period) ──────────────────
    const lastPeriodId = periodIds[periodIds.length - 1]!
    const variableEmps = createdEmps.slice(0, Math.min(8, createdEmps.length))
    const variableSamples = [
      { ruleCode: 'HEURES_SUPP', label: 'Heures supplémentaires (25%)', amount: null, quantity: randInt(2, 10), rate: 1.25 },
      { ruleCode: 'PRIME_PERF', label: 'Prime de performance', amount: randInt(200, 800), quantity: null, rate: null },
      { ruleCode: 'PRIME_ANCIENNETE', label: "Prime d'ancienneté", amount: randInt(50, 300), quantity: null, rate: null },
      { ruleCode: 'ASTREINTE', label: 'Indemnité d\'astreinte', amount: randInt(100, 400), quantity: null, rate: null },
    ]
    for (const emp of variableEmps) {
      const sample = variableSamples[variableEmps.indexOf(emp) % variableSamples.length]!
      await client.query(`
        INSERT INTO "${s}".variable_elements
          (employee_id, period_id, rule_code, label, amount, quantity, rate, source, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8)
      `, [
        emp.id, lastPeriodId,
        sample.ruleCode, sample.label,
        sample.amount?.toFixed(2) ?? null,
        sample.quantity?.toFixed(2) ?? null,
        sample.rate?.toFixed(6) ?? null,
        adminUserId,
      ])
    }
    console.log(`  ✅ ${variableEmps.length} éléments variables historiques créés`)

    // ── Current open period (for active payroll workflow) ────────────────────
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1 // 1-based
    const openPeriodRes = await client.query<{ id: string }>(`
      INSERT INTO "${s}".pay_periods (entity_id, year, month, status, opened_at)
      VALUES ($1, $2, $3, 'open', NOW())
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [entityId, currentYear, currentMonth])

    if (openPeriodRes.rows.length > 0) {
      const openPeriodId = openPeriodRes.rows[0]!.id
      // Seed variable elements for current period
      const currentVarSamples = [
        { ruleCode: 'PRIME_PERF', label: 'Prime de performance Q1', amount: 500 },
        { ruleCode: 'HEURES_SUPP', label: 'Heures supplémentaires', amount: 180 },
        { ruleCode: 'TICKET_RESTO', label: 'Participation titres-resto', amount: -96 },
        { ruleCode: 'PRIME_VACANCES', label: 'Prime de vacances', amount: 350 },
        { ruleCode: 'ASTREINTE', label: 'Indemnité d\'astreinte nuit', amount: 240 },
      ]
      const openVarEmps = createdEmps.slice(0, Math.min(5, createdEmps.length))
      for (let i = 0; i < openVarEmps.length; i++) {
        const emp = openVarEmps[i]!
        const sample = currentVarSamples[i % currentVarSamples.length]!
        await client.query(`
          INSERT INTO "${s}".variable_elements
            (employee_id, period_id, rule_code, label, amount, source, created_by)
          VALUES ($1,$2,$3,$4,$5,'manual',$6)
        `, [emp.id, openPeriodId, sample.ruleCode, sample.label, sample.amount.toFixed(2), adminUserId])
      }
      console.log(`  ✅ Période courante (${currentYear}-${String(currentMonth).padStart(2,'0')}) ouverte avec ${openVarEmps.length} éléments variables`)
    }

    // ── Absence types ─────────────────────────────────────────────────────────
    const absenceTypesData = [
      { code: 'CP', label: 'Congés payés', category: 'paid_leave', color: '#4F46E5', requires_approval: true, is_paid: true, max_days_per_year: '25' },
      { code: 'RTT', label: 'RTT', category: 'rtt', color: '#7C3AED', requires_approval: true, is_paid: true },
      { code: 'MAL', label: 'Arrêt maladie', category: 'sick', color: '#DC2626', requires_justification: true, requires_approval: false, impacts_payroll: true },
      { code: 'MAT', label: 'Congé maternité', category: 'maternity', color: '#EC4899', requires_justification: true, requires_approval: false },
      { code: 'PAT', label: 'Congé paternité', category: 'paternity', color: '#0EA5E9', requires_justification: true, requires_approval: false },
      { code: 'ENF', label: 'Enfant malade', category: 'family', color: '#F59E0B', requires_justification: true, requires_approval: false },
      { code: 'SANS_SOLDE', label: 'Congé sans solde', category: 'unpaid', color: '#6B7280', requires_approval: true, is_paid: false },
    ]

    const absenceTypeIds: Record<string, string> = {}
    for (const at of absenceTypesData) {
      const res = await client.query<{ id: string }>(`
        INSERT INTO "${s}".absence_types
          (entity_id, code, label, category, color, requires_justification, requires_approval, is_paid, impacts_payroll, max_days_per_year)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
      `, [
        entityId, at.code, at.label, at.category,
        at.color ?? '#6B7280',
        (at as Record<string, unknown>)['requires_justification'] ?? false,
        (at as Record<string, unknown>)['requires_approval'] ?? true,
        (at as Record<string, unknown>)['is_paid'] ?? true,
        (at as Record<string, unknown>)['impacts_payroll'] ?? false,
        (at as Record<string, unknown>)['max_days_per_year'] ?? null,
      ])
      absenceTypeIds[at.code] = res.rows[0]!.id
    }

    // Absence balances for all employees
    const cpId = absenceTypeIds['CP']!
    const rttId = absenceTypeIds['RTT']!

    for (const emp of createdEmps) {
      await client.query(`
        INSERT INTO "${s}".absence_balances (employee_id, absence_type_id, period_label, acquired, taken, pending, carried)
        VALUES ($1,$2,'2024-2025',$3,$4,$5,$6)
      `, [emp.id, cpId, '25.00', randInt(0, 10).toString(), randInt(0, 5).toString(), '2.00'])

      await client.query(`
        INSERT INTO "${s}".absence_balances (employee_id, absence_type_id, period_label, acquired, taken, pending, carried)
        VALUES ($1,$2,'2024-2025',$3,$4,$5,$6)
      `, [emp.id, rttId, '12.00', randInt(0, 8).toString(), '0.00', '1.00'])
    }

    // Special absences for Alice
    if (aliceEmpId && cpId) {
      const dates: Array<{ start: string; end: string; days: number; status: string }> = [
        { start: '2024-07-15', end: '2024-07-19', days: 5, status: 'approved' },
        { start: '2024-09-02', end: '2024-09-04', days: 3, status: 'approved' },
        { start: '2024-11-18', end: '2024-11-20', days: 3, status: 'pending' },
        { start: '2024-10-07', end: '2024-10-09', days: 3, status: 'rejected' },
      ]
      for (const d of dates) {
        await client.query(`
          INSERT INTO "${s}".absences
            (employee_id, absence_type_id, start_date, end_date, days_count, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [aliceEmpId, cpId, d.start, d.end, d.days.toString(), d.status])
      }
    }

    console.log(`  ✅ Types d'absences et soldes créés`)

    // ── Training courses ──────────────────────────────────────────────────────
    const trainingTitles = [
      { title: 'Management d\'équipe', category: 'Management', provider: 'Cegos', hours: 14, format: 'in_person', cost: '1800' },
      { title: 'Droit du travail fondamentaux', category: 'RH/Juridique', provider: 'Lefebvre Dalloz', hours: 7, format: 'remote', cost: '690' },
      { title: 'Excel avancé', category: 'Bureautique', provider: 'ORSYS', hours: 14, format: 'in_person', cost: '1290' },
      { title: 'Sécurité des données et RGPD', category: 'Sécurité', provider: 'CNIL Academy', hours: 7, format: 'e_learning', cost: '450', cpf_eligible: true },
      { title: 'Leadership et communication', category: 'Management', provider: 'Cegos', hours: 21, format: 'in_person', cost: '2400', cpf_eligible: true },
      { title: 'Gestion de projet Agile / Scrum', category: 'Méthodes', provider: 'Scrum.org', hours: 14, format: 'blended', cost: '1500', cpf_eligible: true, cpf_code: 'RS6503' },
      { title: 'React Avancé', category: 'Technique', provider: 'Opquast', hours: 28, format: 'remote', cost: '2200' },
      { title: 'Anglais professionnel B2→C1', category: 'Langues', provider: 'Wall Street English', hours: 40, format: 'blended', cost: '1800', cpf_eligible: true },
      { title: 'Prise de parole en public', category: 'Communication', provider: 'Dale Carnegie', hours: 14, format: 'in_person', cost: '1650' },
      { title: 'Comptabilité générale', category: 'Finance', provider: 'Compta Formation', hours: 21, format: 'in_person', cost: '1950' },
      { title: 'PowerBI & Data Visualisation', category: 'Technique', provider: 'Microsoft', hours: 14, format: 'e_learning', cost: '900' },
      { title: 'Cybersécurité pour tous', category: 'Sécurité', provider: 'ANSSI', hours: 7, format: 'e_learning', cost: '290' },
      { title: 'Gestion du stress et bien-être', category: 'Soft skills', provider: 'Mindful Work', hours: 7, format: 'in_person', cost: '800' },
      { title: 'Prospection commerciale B2B', category: 'Commercial', provider: 'Mercuri', hours: 14, format: 'blended', cost: '1600' },
      { title: 'DevOps et CI/CD', category: 'Technique', provider: 'Cloud Academy', hours: 21, format: 'remote', cost: '1850' },
    ]

    const courseIds: string[] = []
    for (const t of trainingTitles) {
      const res = await client.query<{ id: string }>(`
        INSERT INTO "${s}".training_courses
          (entity_id, title, category, provider, format, duration_hours, cost, cpf_eligible, cpf_code, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id
      `, [
        entityId, t.title, t.category, t.provider, t.format, t.hours, t.cost,
        (t as Record<string, unknown>)['cpf_eligible'] ?? false,
        (t as Record<string, unknown>)['cpf_code'] ?? null,
      ])
      courseIds.push(res.rows[0]!.id)
    }

    // Training sessions (8 future sessions)
    const sessionIds: string[] = []
    for (let i = 0; i < 8; i++) {
      const startDate = new Date(2025, i + 1, 10)
      const endDate = new Date(2025, i + 1, 11)
      const sessionRes = await client.query<{ id: string }>(`
        INSERT INTO "${s}".training_sessions (course_id, start_date, end_date, location, max_participants, status)
        VALUES ($1,$2,$3,$4,$5,'scheduled') RETURNING id
      `, [
        courseIds[i % courseIds.length],
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0],
        rand(['Paris', 'Lyon', 'En ligne', 'Bordeaux']),
        randInt(8, 20),
      ])
      sessionIds.push(sessionRes.rows[0]!.id)
    }

    // Enroll Alice in 2 sessions
    if (aliceEmpId && sessionIds.length >= 2) {
      for (let i = 0; i < 2; i++) {
        await client.query(`
          INSERT INTO "${s}".training_enrollments (session_id, employee_id, status)
          VALUES ($1, $2, 'enrolled')
        `, [sessionIds[i], aliceEmpId])
      }
    }

    console.log(`  ✅ ${trainingTitles.length} formations, ${sessionIds.length} sessions créées`)

    // ── Job offers ────────────────────────────────────────────────────────────
    const jobOfferTitles = [
      { title: 'Développeur·euse Senior React / Node.js', dept: 0, min: 65000, max: 85000, remote: 'hybrid' },
      { title: 'Product Manager B2B SaaS', dept: 1, min: 60000, max: 80000, remote: 'remote' },
      { title: 'Growth Marketing Manager', dept: 2, min: 50000, max: 65000, remote: 'hybrid' },
      { title: 'Ingénieur·e DevOps / SRE', dept: 0, min: 60000, max: 80000, remote: 'full_remote' },
      { title: 'Account Executive Grands Comptes', dept: 3, min: 55000, max: 90000, remote: 'hybrid' },
    ]

    const jobOfferIds: string[] = []
    for (const j of jobOfferTitles) {
      const deptId = deptIds[j.dept] ?? deptIds[0]!
      const res = await client.query<{ id: string }>(`
        INSERT INTO "${s}".job_offers
          (entity_id, department_id, title, description, contract_type, location, remote, salary_min, salary_max, status, published_at)
        VALUES ($1,$2,$3,$4,'CDI','Paris (75001)',$5,$6,$7,'published',NOW()) RETURNING id
      `, [entityId, deptId, j.title, `Description du poste : ${j.title}`, j.remote, j.min.toString(), j.max.toString()])
      jobOfferIds.push(res.rows[0]!.id)
    }

    // Candidates (20 total)
    const stages = ['new', 'screening', 'phone_interview', 'technical', 'hr_interview', 'offer', 'hired', 'rejected']
    for (let i = 0; i < 20; i++) {
      const offerId = jobOfferIds[i % jobOfferIds.length]!
      await client.query(`
        INSERT INTO "${s}".candidates
          (job_offer_id, first_name, last_name, email, stage, source)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [
        offerId,
        rand([...FIRST_NAMES_M, ...FIRST_NAMES_F]),
        rand(LAST_NAMES),
        `candidat${i + 1}@example.com`,
        rand(stages),
        rand(['linkedin', 'indeed', 'referral', 'direct']),
      ])
    }

    console.log(`  ✅ ${jobOfferIds.length} offres d'emploi, 20 candidatures créées`)

    // ── Expense reports for Alice ─────────────────────────────────────────────
    if (aliceEmpId) {
      // 1. Brouillon avec 2 lignes
      const draftRes = await client.query<{ id: string }>(`
        INSERT INTO "${s}".expense_reports (employee_id, title, month, total_amount, status)
        VALUES ($1, 'Frais décembre 2024', '2024-12', '38.00', 'draft') RETURNING id
      `, [aliceEmpId])
      const draftId = draftRes.rows[0]!.id

      await client.query(`
        INSERT INTO "${s}".expense_lines (report_id, category, description, date, amount)
        VALUES ($1,'meals','Déjeuner client','2024-12-05','23.00'),
               ($1,'transport','Taxi aéroport','2024-12-06','15.00')
      `, [draftId])

      // 2. Soumis
      await client.query(`
        INSERT INTO "${s}".expense_reports (employee_id, title, month, total_amount, status, submitted_at)
        VALUES ($1, 'Frais novembre 2024', '2024-11', '156.50', 'submitted', NOW() - INTERVAL '5 days')
      `, [aliceEmpId])

      // 3. Approuvé
      await client.query(`
        INSERT INTO "${s}".expense_reports (employee_id, title, month, total_amount, status, submitted_at, approved_at)
        VALUES ($1, 'Frais octobre 2024', '2024-10', '89.00', 'approved', NOW() - INTERVAL '15 days', NOW() - INTERVAL '10 days')
      `, [aliceEmpId])

      console.log(`  ✅ 3 notes de frais créées pour Alice Martin`)
    }

    // ── Skills ────────────────────────────────────────────────────────────────
    const skillNames = [
      { name: 'JavaScript / TypeScript', category: 'Technique' },
      { name: 'React', category: 'Technique' },
      { name: 'Node.js', category: 'Technique' },
      { name: 'PostgreSQL', category: 'Technique' },
      { name: 'Docker / Kubernetes', category: 'Technique' },
      { name: 'Leadership', category: 'Management' },
      { name: 'Communication', category: 'Soft skills' },
      { name: 'Gestion de projet', category: 'Méthodes' },
      { name: 'Agile / Scrum', category: 'Méthodes' },
      { name: 'Analyse financière', category: 'Finance' },
      { name: 'Excel / PowerBI', category: 'Bureautique' },
      { name: 'Anglais professionnel', category: 'Langues' },
      { name: 'Droit du travail', category: 'RH/Juridique' },
      { name: 'Marketing digital', category: 'Marketing' },
      { name: 'Vente B2B', category: 'Commercial' },
    ]

    const skillIds: string[] = []
    for (const sk of skillNames) {
      const res = await client.query<{ id: string }>(`
        INSERT INTO "${s}".skills (entity_id, name, category) VALUES ($1,$2,$3) RETURNING id
      `, [entityId, sk.name, sk.category])
      skillIds.push(res.rows[0]!.id)
    }

    // Assign 3-5 skills per employee
    for (const emp of createdEmps) {
      const count = randInt(3, 5)
      const shuffled = [...skillIds].sort(() => Math.random() - 0.5).slice(0, count)
      for (const skillId of shuffled) {
        await client.query(`
          INSERT INTO "${s}".employee_skills (employee_id, skill_id, level)
          VALUES ($1,$2,$3)
          ON CONFLICT DO NOTHING
        `, [emp.id, skillId, randInt(1, 4)])
      }
    }

    // ── HR events ─────────────────────────────────────────────────────────────
    for (const emp of createdEmps) {
      // Hire event
      await client.query(`
        INSERT INTO "${s}".hr_events (employee_id, type, title, event_date, created_by)
        VALUES ($1,'hire','Embauche',NOW() - INTERVAL '${randInt(180, 2000)} days',$2)
      `, [emp.id, adminUserId])

      // Promotion or raise event
      if (Math.random() > 0.3) {
        await client.query(`
          INSERT INTO "${s}".hr_events (employee_id, type, title, event_date, created_by)
          VALUES ($1,$2,$3,NOW() - INTERVAL '${randInt(30, 365)} days',$4)
        `, [
          emp.id,
          rand(['promotion', 'salary_increase', 'role_change']),
          rand(['Promotion au grade supérieur', 'Augmentation salariale annuelle', 'Changement de poste']),
          adminUserId,
        ])
      }
    }

    // ── Evaluations ───────────────────────────────────────────────────────────
    for (const emp of createdEmps) {
      await client.query(`
        INSERT INTO "${s}".evaluations
          (employee_id, type, year, status, overall_rating, completed_at)
        VALUES ($1,'annual',2024,'completed',$2,NOW() - INTERVAL '${randInt(30, 180)} days')
      `, [emp.id, randInt(3, 5)])
    }

    console.log(`  ✅ Compétences, événements RH et évaluations créés`)

    // ── Parameters (configurable lists) ──────────────────────────────────────
    // Standards inspirés de Workday, SAP SuccessFactors, BambooHR, Lucca, Payfit, N2F
    const defaultParameters = [

      // ── Types de contrat (droit français complet) ─────────────────────────
      { category: 'contract_type', code: 'CDI',          label: 'CDI — Contrat à durée indéterminée',             sort_order:  1 },
      { category: 'contract_type', code: 'CDI_CHANTIER', label: 'CDI de chantier ou d\'opération',               sort_order:  2 },
      { category: 'contract_type', code: 'CDD',          label: 'CDD — Contrat à durée déterminée',               sort_order:  3 },
      { category: 'contract_type', code: 'CDII',         label: 'CDI Intérimaire (CDII)',                         sort_order:  4 },
      { category: 'contract_type', code: 'CTT',          label: 'Intérim / Contrat de travail temporaire (CTT)',  sort_order:  5 },
      { category: 'contract_type', code: 'APPRENTISSAGE',label: 'Contrat d\'apprentissage',                       sort_order:  6 },
      { category: 'contract_type', code: 'PRO',          label: 'Contrat de professionnalisation',               sort_order:  7 },
      { category: 'contract_type', code: 'STAGE',        label: 'Convention de stage',                           sort_order:  8 },
      { category: 'contract_type', code: 'PORTAGE',      label: 'Portage salarial',                              sort_order:  9 },
      { category: 'contract_type', code: 'FREELANCE',    label: 'Prestataire indépendant / Freelance',           sort_order: 10 },
      { category: 'contract_type', code: 'VIE',          label: 'VIE — Volontariat International en Entreprise', sort_order: 11 },
      { category: 'contract_type', code: 'GERANT',       label: 'Mandat social / Gérance',                       sort_order: 12 },

      // ── Catégories de frais (standard Concur / N2F / Expensify / Jenji) ──
      { category: 'expense_category', code: 'TRANSPORT_TRAIN',  label: 'Transport — Train / TGV / Eurostar',         color: '#3B82F6', sort_order:  1 },
      { category: 'expense_category', code: 'TRANSPORT_AVION',  label: 'Transport — Avion',                          color: '#2563EB', sort_order:  2 },
      { category: 'expense_category', code: 'TRANSPORT_TAXI',   label: 'Transport — Taxi / VTC / Uber',              color: '#1D4ED8', sort_order:  3 },
      { category: 'expense_category', code: 'TRANSPORT_TC',     label: 'Transport — Transports en commun',           color: '#60A5FA', sort_order:  4 },
      { category: 'expense_category', code: 'KILOMETRIQUE',     label: 'Indemnités kilométriques (IK)',              color: '#0EA5E9', sort_order:  5 },
      { category: 'expense_category', code: 'PARKING_PEAGE',    label: 'Parking / Péage / Vignette',                 color: '#06B6D4', sort_order:  6 },
      { category: 'expense_category', code: 'REPAS_MIDI',       label: 'Repas — Déjeuner de travail',                color: '#10B981', sort_order:  7 },
      { category: 'expense_category', code: 'REPAS_CLIENT',     label: 'Repas — Invitation client / prospect',       color: '#059669', sort_order:  8 },
      { category: 'expense_category', code: 'REPAS_SOIR',       label: 'Repas — Déplacement / dîner',                color: '#34D399', sort_order:  9 },
      { category: 'expense_category', code: 'HEBERGEMENT',      label: 'Hébergement — Hôtel / Airbnb',               color: '#8B5CF6', sort_order: 10 },
      { category: 'expense_category', code: 'REPRESENTATION',   label: 'Frais de représentation / Cadeaux clients',  color: '#A855F7', sort_order: 11 },
      { category: 'expense_category', code: 'CONFERENCE',       label: 'Conférence / Salon professionnel',           color: '#EC4899', sort_order: 12 },
      { category: 'expense_category', code: 'FORMATION_EXT',    label: 'Formation externe / Certification',          color: '#F472B6', sort_order: 13 },
      { category: 'expense_category', code: 'MATERIEL_INFO',    label: 'Matériel informatique / Accessoires',        color: '#F59E0B', sort_order: 14 },
      { category: 'expense_category', code: 'LOGICIEL_OUTIL',   label: 'Logiciels / Abonnements SaaS',               color: '#D97706', sort_order: 15 },
      { category: 'expense_category', code: 'FOURNITURES',      label: 'Fournitures de bureau',                      color: '#EF4444', sort_order: 16 },
      { category: 'expense_category', code: 'TELEPHONIE',       label: 'Téléphonie / Internet professionnel',        color: '#F87171', sort_order: 17 },
      { category: 'expense_category', code: 'SANTE_BIEN_ETRE',  label: 'Santé / Bien-être au travail',               color: '#14B8A6', sort_order: 18 },
      { category: 'expense_category', code: 'AUTRE',            label: 'Autre / Divers',                             color: '#6B7280', sort_order: 19 },

      // ── Niveaux de poste (grille IC + Management, standard Workday / LinkedIn) ─
      // Filière Individuel Contributeur (IC)
      { category: 'job_level', code: 'IC1_STAGIAIRE',   label: 'IC1 — Stagiaire / Alternant',                          sort_order:  1 },
      { category: 'job_level', code: 'IC2_JUNIOR',      label: 'IC2 — Junior (0–2 ans)',                               sort_order:  2 },
      { category: 'job_level', code: 'IC3_CONFIRME',    label: 'IC3 — Confirmé (2–5 ans)',                             sort_order:  3 },
      { category: 'job_level', code: 'IC4_SENIOR',      label: 'IC4 — Senior (5–9 ans)',                               sort_order:  4 },
      { category: 'job_level', code: 'IC5_LEAD',        label: 'IC5 — Lead / Expert métier',                           sort_order:  5 },
      { category: 'job_level', code: 'IC6_PRINCIPAL',   label: 'IC6 — Principal / Architecte / Staff',                 sort_order:  6 },
      { category: 'job_level', code: 'IC7_DISTINGUE',   label: 'IC7 — Distinguished / Fellow / Expert reconnu',        sort_order:  7 },
      // Filière Management
      { category: 'job_level', code: 'M1_TEAM_LEAD',   label: 'M1 — Team Lead / Chef de projet',                      sort_order:  8 },
      { category: 'job_level', code: 'M2_MANAGER',     label: 'M2 — Manager (5–10 pers.)',                             sort_order:  9 },
      { category: 'job_level', code: 'M3_SR_MANAGER',  label: 'M3 — Senior Manager / Manager de managers',            sort_order: 10 },
      { category: 'job_level', code: 'M4_DIRECTOR',    label: 'M4 — Directeur / Head of',                             sort_order: 11 },
      { category: 'job_level', code: 'M5_SR_DIRECTOR', label: 'M5 — Directeur Senior / VP associé',                   sort_order: 12 },
      { category: 'job_level', code: 'M6_VP',          label: 'M6 — VP / Directeur Général Adjoint',                  sort_order: 13 },
      { category: 'job_level', code: 'M7_C_LEVEL',     label: 'M7 — C-Level / DG / PDG / Dirigeant',                  sort_order: 14 },

      // ── Catégories de formation (standard 360Learning / Cornerstone / Docebo) ─
      { category: 'training_category', code: 'TECH_DEV',       label: 'Développement logiciel & Architecture',          sort_order:  1 },
      { category: 'training_category', code: 'TECH_INFRA',     label: 'Infrastructure, Cloud & Cybersécurité',          sort_order:  2 },
      { category: 'training_category', code: 'DATA_IA',        label: 'Data, Intelligence Artificielle & Analytics',    sort_order:  3 },
      { category: 'training_category', code: 'MANAGEMENT',     label: 'Management & Leadership',                        sort_order:  4 },
      { category: 'training_category', code: 'GESTION_PROJET', label: 'Gestion de projet & Agilité (Scrum, PMP…)',      sort_order:  5 },
      { category: 'training_category', code: 'COMMERCIAL',     label: 'Commercial, Vente & Négociation',                sort_order:  6 },
      { category: 'training_category', code: 'MARKETING_DIG',  label: 'Marketing Digital & Communication',              sort_order:  7 },
      { category: 'training_category', code: 'FINANCE_COMPTA', label: 'Finance, Comptabilité & Contrôle de gestion',    sort_order:  8 },
      { category: 'training_category', code: 'RH_DROIT',       label: 'Ressources Humaines & Droit du travail',         sort_order:  9 },
      { category: 'training_category', code: 'JURIDIQUE',      label: 'Juridique, Conformité & RGPD',                   sort_order: 10 },
      { category: 'training_category', code: 'BUREAUTIQUE',    label: 'Bureautique & Outils collaboratifs (Office 365…)', sort_order: 11 },
      { category: 'training_category', code: 'LANGUES',        label: 'Langues étrangères',                             sort_order: 12 },
      { category: 'training_category', code: 'SECURITE_QHSE',  label: 'Sécurité, QHSE & Prévention des risques',        sort_order: 13 },
      { category: 'training_category', code: 'DEV_PERSO',      label: 'Développement personnel & Soft skills',          sort_order: 14 },
      { category: 'training_category', code: 'QUALITE',        label: 'Qualité, Process & Amélioration continue (ISO…)', sort_order: 15 },
      { category: 'training_category', code: 'RSE_DD',         label: 'RSE, Développement durable & Frugalité',         sort_order: 16 },
      { category: 'training_category', code: 'SANTE_MEDICAL',  label: 'Santé, Médical & Paramédical',                   sort_order: 17 },
      { category: 'training_category', code: 'AUTRE',          label: 'Autre / Non classifié',                          sort_order: 18 },

      // ── Conventions collectives (50 CCN les plus utilisées en France) ──────
      // Idées / bureaux / conseil / tech
      { category: 'collective_agreement', code: 'CCN1486',  label: 'CCN 1486 — SYNTEC (bureaux d\'études, ingénierie, conseil, informatique)', sort_order:  1 },
      { category: 'collective_agreement', code: 'CCN2941',  label: 'CCN 2941 — Télécommunications',                                           sort_order:  2 },
      { category: 'collective_agreement', code: 'CCN1043',  label: 'CCN 1043 — Hôpitaux privés',                                              sort_order:  3 },
      // Bâtiment / TP
      { category: 'collective_agreement', code: 'CCN1596',  label: 'CCN 1596 — Bâtiment : ouvriers (entreprises ≥ 10 salariés)',               sort_order:  4 },
      { category: 'collective_agreement', code: 'CCN2609',  label: 'CCN 2609 — Bâtiment : ETAM',                                              sort_order:  5 },
      { category: 'collective_agreement', code: 'CCN2614',  label: 'CCN 2614 — Travaux Publics : ouvriers',                                   sort_order:  6 },
      { category: 'collective_agreement', code: 'CCN1412',  label: 'CCN 1412 — Bâtiment : ouvriers (entreprises < 10 salariés)',               sort_order:  7 },
      // Commerce / Distribution
      { category: 'collective_agreement', code: 'CCN0573',  label: 'CCN 0573 — Commerce de gros',                                             sort_order:  8 },
      { category: 'collective_agreement', code: 'CCN3252',  label: 'CCN 3252 — Commerce de détail et gros à prédominance alimentaire',        sort_order:  9 },
      { category: 'collective_agreement', code: 'CCN1558',  label: 'CCN 1558 — Grandes surfaces de bricolage',                                sort_order: 10 },
      { category: 'collective_agreement', code: 'CCN2216',  label: 'CCN 2216 — Commerce de détail non alimentaire',                           sort_order: 11 },
      // Industrie / Métallurgie
      { category: 'collective_agreement', code: 'CCN_METAL', label: 'CCN Métallurgie (accord national 2023)',                                  sort_order: 12 },
      { category: 'collective_agreement', code: 'CCN1539',  label: 'CCN 1539 — Chimie',                                                       sort_order: 13 },
      { category: 'collective_agreement', code: 'CCN1000',  label: 'CCN 1000 — Plasturgie',                                                   sort_order: 14 },
      { category: 'collective_agreement', code: 'CCN0018',  label: 'CCN 0018 — Industrie textile',                                            sort_order: 15 },
      { category: 'collective_agreement', code: 'CCN3127',  label: 'CCN 3127 — Industrie pharmaceutique',                                     sort_order: 16 },
      // Transport / Logistique
      { category: 'collective_agreement', code: 'CCN0016',  label: 'CCN 0016 — Transport routier de marchandises',                            sort_order: 17 },
      { category: 'collective_agreement', code: 'CCN1194',  label: 'CCN 1194 — Personnel navigant aviation civile',                           sort_order: 18 },
      { category: 'collective_agreement', code: 'CCN0275',  label: 'CCN 0275 — Entreprises de manutention portuaire',                         sort_order: 19 },
      // Hôtellerie / Restauration / Tourisme
      { category: 'collective_agreement', code: 'CCN1979',  label: 'CCN 1979 — Hôtellerie, Cafés, Restaurants (HCR)',                        sort_order: 20 },
      { category: 'collective_agreement', code: 'CCN1501',  label: 'CCN 1501 — Restauration rapide',                                         sort_order: 21 },
      { category: 'collective_agreement', code: 'CCN1747',  label: 'CCN 1747 — Restauration collective',                                     sort_order: 22 },
      // Santé / Social
      { category: 'collective_agreement', code: 'CCN0029',  label: 'CCN 0029 — Hospitalisation privée (FEHAP / UGECAM)',                      sort_order: 23 },
      { category: 'collective_agreement', code: 'CCN0413',  label: 'CCN 0413 — Établissements privés d\'hospitalisation lucrative',           sort_order: 24 },
      { category: 'collective_agreement', code: 'CCN3220',  label: 'CCN 3220 — Aide, accompagnement & services à domicile (BAD)',             sort_order: 25 },
      // Banque / Assurance / Finance
      { category: 'collective_agreement', code: 'CCN2120',  label: 'CCN 2120 — Banque',                                                      sort_order: 26 },
      { category: 'collective_agreement', code: 'CCN1672',  label: 'CCN 1672 — Sociétés d\'assurance',                                       sort_order: 27 },
      { category: 'collective_agreement', code: 'CCN0637',  label: 'CCN 0637 — Mutuelles',                                                   sort_order: 28 },
      // Immobilier / Propreté / Sécurité
      { category: 'collective_agreement', code: 'CCN1527',  label: 'CCN 1527 — Immobilier',                                                  sort_order: 29 },
      { category: 'collective_agreement', code: 'CCN3043',  label: 'CCN 3043 — Propreté et services associés',                               sort_order: 30 },
      { category: 'collective_agreement', code: 'CCN1351',  label: 'CCN 1351 — Prévention et sécurité',                                     sort_order: 31 },
      // Presse / Audiovisuel / Culture
      { category: 'collective_agreement', code: 'CCN1480',  label: 'CCN 1480 — Journalistes (Presse quotidienne nationale)',                  sort_order: 32 },
      { category: 'collective_agreement', code: 'CCN2642',  label: 'CCN 2642 — Édition',                                                     sort_order: 33 },
      { category: 'collective_agreement', code: 'CCN1285',  label: 'CCN 1285 — Production audiovisuelle',                                    sort_order: 34 },
      // Autres secteurs courants
      { category: 'collective_agreement', code: 'CCN0700',  label: 'CCN 0700 — Coiffure',                                                    sort_order: 35 },
      { category: 'collective_agreement', code: 'CCN2596',  label: 'CCN 2596 — Esthétique-cosmétique',                                       sort_order: 36 },
      { category: 'collective_agreement', code: 'CCN1794',  label: 'CCN 1794 — Camping',                                                     sort_order: 37 },
      { category: 'collective_agreement', code: 'CCN_NA',   label: 'Pas de convention collective applicable',                                sort_order: 99 },
    ]

    for (const p of defaultParameters) {
      await client.query(`
        INSERT INTO "${s}".parameters (category, code, label, color, sort_order)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (category, code) DO NOTHING
      `, [p.category, p.code, p.label, (p as Record<string, unknown>)['color'] ?? null, p.sort_order])
    }
    console.log(`  ✅ ${defaultParameters.length} paramètres de référentiel créés`)

    await client.query('COMMIT')
    return entityId
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function seed() {
  const pool = new Pool({ connectionString: DATABASE_URL })

  console.log('\n🌱 Démarrage du seeding NexusRH multi-tenant...\n')

  const client = await pool.connect()
  try {
    // Phase 0 — Platform schema
    await createPlatformSchema(client)

    // Phase 1 — Super admin
    await seedSuperAdmin(client)

    // Register tenant 1 in platform.tenants
    const techcorpSchemaName = 'tenant_techcorp'
    const techcorpRes = await client.query<{ id: string }>(`
      INSERT INTO platform.tenants
        (slug, name, plan_type, status, schema_name, max_users, max_employees,
         primary_color, secondary_color)
      VALUES ('techcorp','TechCorp SAS','pro','active','${techcorpSchemaName}',200,100,'#4F46E5','#818CF8')
      ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `)
    const techcorpId = techcorpRes.rows[0]!.id
    console.log(`✅ Tenant TechCorp enregistré (id: ${techcorpId})`)

    // Register tenant 2 in platform.tenants
    const artisanproSchemaName = 'tenant_artisanpro'
    const artisanRes = await client.query<{ id: string }>(`
      INSERT INTO platform.tenants
        (slug, name, plan_type, status, schema_name, max_users, max_employees,
         primary_color, secondary_color)
      VALUES ('artisanpro','Artisan Pro SARL','starter','active','${artisanproSchemaName}',50,50,'#16A34A','#4ADE80')
      ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `)
    const artisanproId = artisanRes.rows[0]!.id
    console.log(`✅ Tenant ArtisanPro enregistré (id: ${artisanproId})`)
  } finally {
    client.release()
  }

  // Phase 2 — TechCorp full seed
  console.log('\n🏢 Seeding TechCorp SAS...')
  await seedTenantSchema(pool, {
    slug: 'techcorp',
    name: 'TechCorp SAS',
    schemaName: 'tenant_techcorp',
    planType: 'pro',
    primaryColor: '#4F46E5',
    secondaryColor: '#818CF8',
    siren: '123456789',
    siret: '12345678900015',
    collectiveAgreement: 'syntec',
    adminEmail: 'admin@techcorp.com',
    adminPassword: 'Admin1234!',
    hrEmail: 'rh@techcorp.com',
    managerEmail: 'manager@techcorp.com',
    employeeEmail: 'employe@techcorp.com',
    depts: [
      { name: 'Engineering', code: 'ENG', costCenter: 'CC001', titles: ENGINEERING_TITLES, count: 20, salaryRange: [45000, 90000] },
      { name: 'Product', code: 'PRD', costCenter: 'CC002', titles: PRODUCT_TITLES, count: 8, salaryRange: [48000, 85000] },
      { name: 'Marketing', code: 'MKT', costCenter: 'CC003', titles: MARKETING_TITLES, count: 7, salaryRange: [38000, 65000] },
      { name: 'Sales', code: 'SAL', costCenter: 'CC004', titles: SALES_TITLES, count: 10, salaryRange: [40000, 70000] },
      { name: 'Finance', code: 'FIN', costCenter: 'CC005', titles: FINANCE_TITLES, count: 5, salaryRange: [42000, 72000] },
    ],
  })
  console.log('✅ TechCorp SAS seedé avec succès')

  // Phase 3 — ArtisanPro minimal seed
  console.log('\n🏗️  Seeding Artisan Pro SARL...')
  await seedTenantSchema(pool, {
    slug: 'artisanpro',
    name: 'Artisan Pro SARL',
    schemaName: 'tenant_artisanpro',
    planType: 'starter',
    primaryColor: '#16A34A',
    secondaryColor: '#4ADE80',
    siren: '987654321',
    siret: '98765432100011',
    collectiveAgreement: 'batiment',
    adminEmail: 'admin@artisanpro.com',
    adminPassword: 'Admin1234!',
    employeeEmail: 'employe2@artisanpro.com',
    depts: [
      { name: 'Chantiers', code: 'CHT', costCenter: 'CC010', titles: BTP_CHANTIER_TITLES, count: 15, salaryRange: [28000, 52000] },
      { name: 'Administration', code: 'ADM', costCenter: 'CC011', titles: BTP_ADMIN_TITLES, count: 3, salaryRange: [30000, 45000] },
    ],
  })
  console.log('✅ Artisan Pro SARL seedé avec succès')

  await pool.end()

  console.log('\n🎉 Seeding terminé avec succès !')
  console.log('\n📋 Comptes de test :')
  console.log('\n  PLATEFORME :')
  console.log('    👑 superadmin@nexusrh.com / SuperAdmin1234!  → /platform/dashboard')
  console.log('\n  TECHCORP (indigo) :')
  console.log('    🔑 admin@techcorp.com       / Admin1234!  → /dashboard (admin)')
  console.log('    👩‍💼 rh@techcorp.com          / Admin1234!  → /dashboard (RH manager)')
  console.log('    👨‍💼 manager@techcorp.com     / Admin1234!  → /dashboard (manager)')
  console.log('    👤 employe@techcorp.com     / Admin1234!  → /mon-espace (employee)')
  console.log('\n  ARTISANPRO (vert) :')
  console.log('    🔑 admin@artisanpro.com     / Admin1234!  → /dashboard')
  console.log('    👤 employe2@artisanpro.com  / Admin1234!  → /mon-espace')
}

seed().catch((err) => {
  console.error('\n❌ Erreur lors du seeding:', err?.message ?? err)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
})
