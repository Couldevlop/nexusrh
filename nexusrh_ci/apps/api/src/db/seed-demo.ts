/**
 * Seed démonstration pour un tenant nouvellement créé
 * Crée 8 employés, 3 mois de bulletins, des absences et des formations
 */
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { calculatePayrollCI } from '../services/payroll-engine-ci.js'

const EMPLOYEES = [
  { firstName: 'Kouassi',  lastName: 'Coulibaly', gender: 'M', job: 'Directeur',       dept: 'Direction',    salary: 450_000 },
  { firstName: 'Adjoua',   lastName: 'Traoré',    gender: 'F', job: 'Responsable RH',  dept: 'RH',           salary: 280_000 },
  { firstName: 'Mamadou',  lastName: 'Koné',      gender: 'M', job: 'Comptable',        dept: 'Finance',      salary: 180_000 },
  { firstName: 'Akissi',   lastName: 'N\'Goran',  gender: 'F', job: 'Assistante',       dept: 'Direction',    salary: 120_000 },
  { firstName: 'Ibrahim',  lastName: 'Ouattara',  gender: 'M', job: 'Commercial',       dept: 'Commercial',   salary: 150_000 },
  { firstName: 'Fanta',    lastName: 'Camara',    gender: 'F', job: 'Chargée comm.',    dept: 'Commercial',   salary: 140_000 },
  { firstName: 'Yao',      lastName: 'Koffi',     gender: 'M', job: 'Développeur',      dept: 'IT',           salary: 250_000 },
  { firstName: 'Aminata',  lastName: 'Diallo',    gender: 'F', job: 'Juriste',          dept: 'Juridique',    salary: 200_000 },
]

const ABSENCE_TYPES = [
  { code: 'CP',       label: 'Congés payés',         paid: true  },
  { code: 'MALADIE',  label: 'Congé maladie',         paid: false },
  { code: 'FAMILIAL', label: 'Événement familial',    paid: true  },
]

const TRAININGS = [
  { title: 'Réglementation CNPS 2024',     duration: 1, format: 'présentiel' },
  { title: 'Excel avancé pour les RH',     duration: 2, format: 'distanciel' },
  { title: 'Leadership & Management CI',   duration: 3, format: 'présentiel' },
  { title: 'Droit du travail ivoirien',    duration: 1, format: 'présentiel' },
]

function pastMonth(offset: number): { year: number; month: number; label: string } {
  const d = new Date()
  d.setMonth(d.getMonth() - offset)
  return { year: d.getFullYear(), month: d.getMonth() + 1, label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
}

export async function seedDemoTenant(pool: Pool, schemaName: string, atRate: number): Promise<void> {
  const s = schemaName

  // ── Départements ──
  const deptIds: Record<string, string> = {}
  for (const dept of [...new Set(EMPLOYEES.map(e => e.dept))]) {
    const r = await pool.query(
      `INSERT INTO "${s}".departments (name, code) VALUES ($1, $2) RETURNING id`,
      [dept, dept.substring(0, 3).toUpperCase()]
    )
    deptIds[dept] = r.rows[0].id
  }

  // ── Employés ──
  const employeeIds: string[] = []
  for (const e of EMPLOYEES) {
    const hireDate = pastMonth(randInt(12, 36))
    const r = await pool.query(
      `INSERT INTO "${s}".employees
         (first_name, last_name, gender, job_title, department_id,
          gross_salary, hire_date, is_active, marital_status, children_count,
          mobile_money_provider, mobile_money_phone, cnps_number, nni)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        e.firstName, e.lastName, e.gender, e.job, deptIds[e.dept],
        e.salary, `${hireDate.year}-${String(hireDate.month).padStart(2,'0')}-01`,
        'married', randInt(0, 3),
        ['wave','mtn_momo','orange_money'][randInt(0,2)],
        `+225 07 ${randInt(10,99)} ${randInt(10,99)} ${randInt(10,99)} ${randInt(10,99)}`,
        `CI${randInt(10000000, 99999999)}A`,
        `CI${randInt(100000000, 999999999)}`,
      ]
    )
    employeeIds.push(r.rows[0].id)
  }

  // ── Règles de paie ── (déjà créées par provisionTenantSchema, on récupère leur id)
  const rules = await pool.query(`SELECT * FROM "${s}".payroll_rules ORDER BY code`)

  // ── 3 mois de bulletins ──
  for (let mo = 2; mo >= 0; mo--) {
    const { year, month, label } = pastMonth(mo + 1)
    const period = await pool.query(
      `INSERT INTO "${s}".pay_periods (label, year, month, status)
       VALUES ($1,$2,$3,'closed') RETURNING id`,
      [label, year, month]
    )
    const periodId = period.rows[0].id

    for (let i = 0; i < employeeIds.length; i++) {
      const emp = EMPLOYEES[i]!
      const result = calculatePayrollCI({
        grossSalary: emp.salary,
        atRate,
        maritalStatus: 'married',
        childrenCount: 1,
        workingDays: 26,
        totalDays: 26,
        variableElements: [],
        payrollRules: rules.rows,
      })
      await pool.query(
        `INSERT INTO "${s}".pay_slips
           (employee_id, pay_period_id, gross_salary, net_payable,
            total_employee_contributions, total_employer_contributions,
            income_tax, employer_cost, status, lines)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'generated',$9)`,
        [
          employeeIds[i], periodId,
          result.grossSalary, result.netPayable,
          result.totalEmployeeContributions, result.totalEmployerContributions,
          result.incomeTax, result.employerCost,
          JSON.stringify(result.lines),
        ]
      )
    }
  }

  // ── Types absences ── (déjà créés, on récupère)
  const absTypes = await pool.query(`SELECT id, code FROM "${s}".absence_types LIMIT 5`)

  // ── Soldes absences ──
  for (const empId of employeeIds) {
    for (const at of absTypes.rows) {
      await pool.query(
        `INSERT INTO "${s}".absence_balances (employee_id, absence_type_id, year, acquired, taken, pending)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [empId, at.id, new Date().getFullYear(), randInt(15, 25), randInt(0, 5), 0]
      ).catch(() => {}) // ignore si pas de table ou conflit
    }
  }

  // ── Quelques absences ──
  if (absTypes.rows[0]) {
    for (let i = 0; i < 3; i++) {
      const start = pastMonth(1)
      await pool.query(
        `INSERT INTO "${s}".absences
           (employee_id, absence_type_id, start_date, end_date, status, reason)
         VALUES ($1,$2,$3,$4,$5,'Absence démo')`,
        [
          employeeIds[i % employeeIds.length],
          absTypes.rows[i % absTypes.rows.length]?.id,
          `${start.year}-${String(start.month).padStart(2,'0')}-${String(randInt(1,10)).padStart(2,'0')}`,
          `${start.year}-${String(start.month).padStart(2,'0')}-${String(randInt(11,20)).padStart(2,'0')}`,
          ['approved','pending','approved'][i],
        ]
      ).catch(() => {})
    }
  }

  // ── Formations catalogue ──
  for (const t of TRAININGS) {
    await pool.query(
      `INSERT INTO "${s}".trainings (title, duration_days, format, status, max_participants)
       VALUES ($1,$2,$3,'active',20) ON CONFLICT DO NOTHING`,
      [t.title, t.duration, t.format]
    ).catch(() => {})
  }
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
