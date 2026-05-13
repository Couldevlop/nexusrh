/**
 * Seed indépendant : "PME Test CI" — scénario de validation paie
 *
 * Crée un tenant minimal avec 5 employés (3 cadres + 1 agent de maîtrise +
 * 1 ouvrier), tous déclarés à la CNPS, avec deux absences pré-saisies pour
 * décembre 2024 :
 *   - Aïcha Koffi (cadre Direction) — congé maternité 16/12 → 31/12
 *   - Yao Touré (agent de maîtrise Atelier) — accident du travail 11/12
 *     sur 3 semaines (jusqu'au 31/12 inclus)
 *
 * Lancer : `pnpm --filter api run db:seed-pme-test`
 * Idempotent : ré-exécutable, drop+recrée le tenant tenant_pme_test.
 *
 * Connexion :
 *   admin@pme-test.ci   / Admin1234!  (admin)
 *   aicha@pme-test.ci   / Admin1234!  (employee — cadre en maternité)
 */
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'
import {
  createPlatformSchema, createDroitCiSchema, provisionTenantSchema,
  seedPayrollRulesCI, seedAbsenceTypesCI,
} from './provisioning.js'
import {
  calculatePayrollCI, type AbsencePayrollInfo,
} from '../services/payroll-engine-ci.js'

const pool = new Pool({ connectionString: config.database.url })

interface PmeEmployee {
  firstName: string; lastName: string; gender: 'H' | 'F'
  jobTitle: string; jobLevel: 'cadre' | 'agent_maitrise' | 'employe' | 'ouvrier'
  department: 'Direction' | 'Commercial' | 'Finance' | 'Atelier' | 'Production'
  baseSalary: number  // FCFA mensuel brut
  maritalStatus: 'single' | 'married'
  childrenCount: number
  email: string
  absence?: { type: AbsencePayrollInfo['type']; startDate: string; endDate: string; absenceDays: number; atJourAccidentInMonth?: boolean }
}

const PME_EMPLOYEES: PmeEmployee[] = [
  {
    firstName: 'Aïcha', lastName: 'Koffi', gender: 'F',
    jobTitle: 'Directrice Générale', jobLevel: 'cadre', department: 'Direction',
    baseSalary: 1_200_000, maritalStatus: 'married', childrenCount: 0,
    email: 'aicha@pme-test.ci',
    absence: {
      type: 'maternite',
      startDate: '2024-12-16', endDate: '2024-12-31',
      absenceDays: 14,   // 16-31 déc. en jours ouvrables (dim. 22, 29 exclus)
    },
  },
  {
    firstName: 'Marc', lastName: 'Diallo', gender: 'H',
    jobTitle: 'Responsable Commercial', jobLevel: 'cadre', department: 'Commercial',
    baseSalary: 950_000, maritalStatus: 'single', childrenCount: 0,
    email: 'marc@pme-test.ci',
  },
  {
    firstName: 'Sandra', lastName: 'Bamba', gender: 'F',
    jobTitle: 'Directrice Financière', jobLevel: 'cadre', department: 'Finance',
    baseSalary: 1_050_000, maritalStatus: 'married', childrenCount: 2,
    email: 'sandra@pme-test.ci',
  },
  {
    firstName: 'Yao', lastName: 'Touré', gender: 'H',
    jobTitle: 'Chef Atelier', jobLevel: 'agent_maitrise', department: 'Atelier',
    baseSalary: 380_000, maritalStatus: 'married', childrenCount: 1,
    email: 'yao@pme-test.ci',
    absence: {
      type: 'accident_travail',
      startDate: '2024-12-11', endDate: '2024-12-31',
      absenceDays: 18,   // 11-31 déc. en j. ouvrables (dim. 15, 22, 29 exclus)
      atJourAccidentInMonth: true,
    },
  },
  {
    firstName: 'Issa', lastName: 'Konaté', gender: 'H',
    jobTitle: 'Opérateur Production', jobLevel: 'ouvrier', department: 'Production',
    baseSalary: 180_000, maritalStatus: 'married', childrenCount: 3,
    email: 'issa@pme-test.ci',
  },
]

const TENANT_SLUG   = 'pme-test'
const TENANT_SCHEMA = 'tenant_pme_test'
const AT_RATE       = 0.02   // services/commerce
const PERIOD_MONTH  = '2024-12'
const WORKING_DAYS  = 26     // déc. 2024 : lun-sam, 5 dimanches exclus

async function main() {
  console.log('NexusRH CI — Seed PME-Test (scénario maternité + AT)')

  // Reset propre
  await pool.query(`DROP SCHEMA IF EXISTS "${TENANT_SCHEMA}" CASCADE`)
  console.log(`[0] Schéma ${TENANT_SCHEMA} supprimé (reset)`)

  await createPlatformSchema()
  await createDroitCiSchema()

  // ── Création tenant ──────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO platform.tenants
      (name, slug, schema_name, plan_type, status, sector, city,
       cnps_number, dgi_number, rccm, at_rate,
       max_users, max_employees, primary_color, secondary_color, trial_ends_at)
    VALUES
      ('PME Test CI (scénario QA)', $1, $2, 'starter', 'active', 'services', 'Abidjan',
       'CI-TEST-000001', 'DGI-ABJ-TEST-001', 'CI-ABJ-TEST-001', $3,
       30, 30, '#0EA5E9', '#38BDF8', null)
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name, status = EXCLUDED.status
  `, [TENANT_SLUG, TENANT_SCHEMA, AT_RATE.toString()])
  console.log('[1] Tenant PME Test créé')

  await provisionTenantSchema(TENANT_SCHEMA)
  await seedPayrollRulesCI(TENANT_SCHEMA, AT_RATE)
  await seedAbsenceTypesCI(TENANT_SCHEMA)
  console.log('[2] Schema PME Test provisionné + rubriques/types absences seedés')

  // ── Comptes utilisateurs ─────────────────────────────────────────────────────
  const adminHash    = await bcrypt.hash('Admin1234!', 12)
  const employeeHash = await bcrypt.hash('Admin1234!', 12)

  await pool.query(`
    INSERT INTO "${TENANT_SCHEMA}".users
      (email, password_hash, first_name, last_name, role, is_active, last_login_at)
    VALUES
      ('admin@pme-test.ci', $1, 'Admin', 'PME Test', 'admin', true, now()),
      ('aicha@pme-test.ci', $2, 'Aïcha', 'Koffi',     'employee', true, now())
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `, [adminHash, employeeHash])

  // ── Départements ─────────────────────────────────────────────────────────────
  const deptMap = new Map<string, string>()
  for (const deptName of ['Direction', 'Commercial', 'Finance', 'Atelier', 'Production']) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO "${TENANT_SCHEMA}".departments (name) VALUES ($1) RETURNING id`,
      [deptName],
    )
    deptMap.set(deptName, r.rows[0]!.id)
  }
  console.log('[3] 5 départements créés')

  // ── Employés ────────────────────────────────────────────────────────────────
  const employeeIds = new Map<string, string>()
  // Hire date : 2 ans avant déc 2024 pour avoir une ancienneté solide
  const hireDate = '2022-01-01'
  for (const e of PME_EMPLOYEES) {
    // Lier l'email user → employee.user_id (pour Aïcha qui a un compte)
    const userRes = await pool.query<{ id: string }>(
      `SELECT id FROM "${TENANT_SCHEMA}".users WHERE email = $1 LIMIT 1`, [e.email],
    )
    const userId = userRes.rows[0]?.id ?? null

    const r = await pool.query<{ id: string }>(`
      INSERT INTO "${TENANT_SCHEMA}".employees
        (user_id, employee_number, first_name, last_name, email, phone,
         gender, nationality, nni, cnps_number,
         department_id, job_title, job_level, contract_type,
         hire_date, base_salary, currency, city,
         marital_status, children_count, is_active)
      VALUES
        ($1, $2, $3, $4, $5, $6,
         $7, 'Ivoirienne', $8, $9,
         $10, $11, $12, 'cdi',
         $13, $14, 'XOF', 'Abidjan',
         $15, $16, true)
      RETURNING id
    `, [
      userId,
      `PME-${e.lastName.toUpperCase().slice(0, 3)}`,
      e.firstName, e.lastName, e.email,
      '+225 07 ' + Math.floor(10_000_000 + Math.random() * 89_999_999).toString().match(/.{1,2}/g)!.join(' '),
      e.gender,
      'NNI-' + Math.floor(100000 + Math.random() * 900000),
      'CNPS-' + Math.floor(100000 + Math.random() * 900000),
      deptMap.get(e.department)!,
      e.jobTitle, e.jobLevel,
      hireDate, e.baseSalary,
      e.maritalStatus, e.childrenCount,
    ])
    employeeIds.set(e.email, r.rows[0]!.id)
  }
  console.log(`[4] ${PME_EMPLOYEES.length} employés créés (3 cadres + 1 maîtrise + 1 ouvrier)`)

  // ── Période de paie déc. 2024 ────────────────────────────────────────────────
  const periodRes = await pool.query<{ id: string }>(`
    INSERT INTO "${TENANT_SCHEMA}".pay_periods (month, status, closed_at, closed_by)
    VALUES ($1, 'closed', now(), 'seed-pme-test')
    ON CONFLICT (month) DO UPDATE SET status = 'closed'
    RETURNING id
  `, [PERIOD_MONTH])
  const periodId = periodRes.rows[0]!.id
  console.log(`[5] Période ${PERIOD_MONTH} créée (status=closed)`)

  // ── Absences pré-saisies + bulletins ─────────────────────────────────────────
  // Récupération des absence_types
  const absTypeMap = new Map<string, string>()
  for (const code of ['MATERNITE', 'MALADIE']) {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM "${TENANT_SCHEMA}".absence_types WHERE code = $1`, [code],
    )
    if (r.rows[0]) absTypeMap.set(code, r.rows[0].id)
  }

  let absencesCreated = 0
  let bulletinsCreated = 0
  for (const e of PME_EMPLOYEES) {
    const empId = employeeIds.get(e.email)!
    let absenceForEngine: AbsencePayrollInfo | undefined

    if (e.absence) {
      // Mapper le type absence engine → code absence_types CI
      const absCode = e.absence.type === 'maternite' ? 'MATERNITE' : 'MALADIE'
      const absTypeId = absTypeMap.get(absCode)
      if (absTypeId) {
        const reason = e.absence.type === 'maternite'
          ? 'Congé maternité (14 semaines — Art. 25 Code du Travail CI)'
          : e.absence.type === 'accident_travail'
          ? 'Accident du travail — 3 semaines (déclaration CNPS effectuée)'
          : 'Maladie'
        await pool.query(`
          INSERT INTO "${TENANT_SCHEMA}".absences
            (employee_id, absence_type_id, start_date, end_date, days, reason,
             status, validation_level, approved_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'approved', 1, now())
        `, [empId, absTypeId, e.absence.startDate, e.absence.endDate, e.absence.absenceDays, reason])
        absencesCreated++
      }
      absenceForEngine = {
        type: e.absence.type,
        absenceDays: e.absence.absenceDays,
        atJourAccidentInMonth: e.absence.atJourAccidentInMonth,
      }
    }

    const workedDays = WORKING_DAYS - (e.absence?.absenceDays ?? 0)
    const result = calculatePayrollCI({
      baseSalary:       e.baseSalary,
      workedDays,
      workingDaysMonth: WORKING_DAYS,
      atRate:           AT_RATE,
      maritalStatus:    e.maritalStatus,
      childrenCount:    e.childrenCount,
      variableElements: {},
      absence:          absenceForEngine,
    })

    await pool.query(`
      INSERT INTO "${TENANT_SCHEMA}".pay_slips
        (employee_id, period_id, month, base_salary, gross_salary,
         cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
         total_cnps_sal, total_cnps_pat, its, total_deductions,
         net_payable, employer_cost, lines, status, generated_at,
         payment_method, payment_status, currency)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
              'generated', now(), 'mobile_money', 'pending', 'XOF')
    `, [
      empId, periodId, PERIOD_MONTH, e.baseSalary, result.grossSalary,
      result.cnpsRetraiteSal, result.cnpsRetraitePat, result.cnpsPfPat, result.cnpsAtPat,
      result.totalCnpsSal, result.totalCnpsPat, result.its, result.totalDeductions,
      result.netPayable, result.employerCost, JSON.stringify(result.lines),
    ])
    bulletinsCreated++

    // Affichage console des résultats clés
    const tag = e.absence ? `  [${e.absence.type}]` : ''
    console.log(
      `   - ${e.firstName.padEnd(8)} ${e.lastName.padEnd(8)} (${e.jobLevel.padEnd(15)}) ` +
      `brut=${result.grossSalary.toLocaleString('fr-FR').padStart(11)} FCFA · ` +
      `net=${result.netPayable.toLocaleString('fr-FR').padStart(11)} FCFA · ` +
      `ITS=${result.its.toString().padStart(7)} · ` +
      `bordereauCNPS=${result.bordereauCnps ? result.bordereauCnps.montant.toLocaleString('fr-FR') : '—'}${tag}`,
    )
  }
  console.log(`[6] ${absencesCreated} absences et ${bulletinsCreated} bulletins créés pour ${PERIOD_MONTH}`)

  console.log('\n=== Seed PME-Test terminé ===\n')
  console.log('Connexion :')
  console.log('  admin@pme-test.ci   /  Admin1234!  (admin)')
  console.log('  aicha@pme-test.ci   /  Admin1234!  (employee, cadre en maternité)')
  console.log()
  console.log('Vérifications attendues dans l\'UI :')
  console.log('  - 5 bulletins de décembre 2024 visibles dans /payroll')
  console.log('  - Aïcha : ligne 1700 "Indemnités de congé maternité" + bordereau CNPS')
  console.log('  - Yao   : ligne 1900 "Indemnité journalière AT" + bordereau CNPS')
  console.log('  - Tous : net ≥ SMIG 75 000 FCFA, montants en FCFA entiers')

  await pool.end()
}

main().catch((err) => {
  console.error('Erreur seed PME-Test:', err)
  process.exit(1)
})
