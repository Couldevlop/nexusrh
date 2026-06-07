/**
 * Scénario WOYAA — joué dans l'applicatif (vraie base, vrai moteur de paie CI).
 *
 * WOYAA SARL — conseil stratégique (différenciation par méthodes nouvelles de
 * stratégie et de vente), Abidjan, Côte d'Ivoire. Secteur services → taux AT 2%.
 *
 * Effectif : CEO, DRH, RH Manager, Directeur commercial, 3 agents de maîtrise
 * (1 commerciale, 1 secrétaire de direction, 1 maintenancier informaticien).
 *
 * Salaires donnés en NET → « gross-up » (recherche du brut qui produit le net
 * cible) avec le moteur réel calculatePayrollCI. Hypothèses documentées :
 *   - situation familiale : célibataire, 0 enfant (non précisé) → crédit ITS = 0
 *   - aucune prime (transport, etc.) sauf indiqué
 *
 * Événements :
 *   - Secrétaire de direction : congé maternité à partir du 16/03/2026 (14 sem.
 *     CI = 98 j). N'a jamais pris de congés depuis l'embauche → ses CP acquis
 *     sont payés (ICP) sur le bulletin de mars (« posés en même temps »).
 *   - Informaticien : accident du travail le 05/06/2026, arrêt 2 semaines.
 *
 * Exécution : pnpm --filter @nexusrhci/api exec tsx src/scripts/scenario-woyaa.ts
 */
import bcrypt from 'bcryptjs'
import { pool } from '../db/pool.js'
import {
  createPlatformSchema,
  provisionTenantSchema,
  seedPayrollRulesCI,
  seedAbsenceTypesCI,
} from '../db/provisioning.js'
import { calculatePayrollCI, type PayrollContext, type PayrollResult } from '../services/payroll-engine-ci.js'

const SCHEMA = 'tenant_woyaa'
const SLUG = 'woyaa'
const AT_RATE = 0.02 // services / conseil

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Jours ouvrables d'un mois (lun→sam, dimanche exclu — convention moteur CI). */
function workingDaysInMonth(year: number, month1to12: number): number {
  const days = new Date(year, month1to12, 0).getDate()
  let n = 0
  for (let d = 1; d <= days; d++) if (new Date(year, month1to12 - 1, d).getDay() !== 0) n++
  return n
}
/** Jours ouvrables entre deux jours du mois (bornes incluses). */
function workingDaysBetween(year: number, month1to12: number, from: number, to: number): number {
  let n = 0
  for (let d = from; d <= to; d++) {
    if (d < 1) continue
    const dim = new Date(year, month1to12, 0).getDate()
    if (d > dim) break
    if (new Date(year, month1to12 - 1, d).getDay() !== 0) n++
  }
  return n
}

/** Recherche du brut mensuel produisant le net cible (mois plein, sans absence). */
function grossUp(targetNet: number, maritalStatus: string, childrenCount: number): number {
  const wd = 26 // mois plein de référence
  const netFor = (brut: number): number => calculatePayrollCI({
    baseSalary: brut, workedDays: wd, workingDaysMonth: wd,
    atRate: AT_RATE, maritalStatus, childrenCount, variableElements: {},
  }).netPayable
  let lo = targetNet, hi = targetNet * 2
  while (netFor(hi) < targetNet) hi *= 2
  for (let i = 0; i < 60; i++) {
    const mid = Math.floor((lo + hi) / 2)
    if (netFor(mid) < targetNet) lo = mid + 1; else hi = mid
  }
  // Arrondi « propre » au millier le plus proche si le net reste correct
  const rounded = Math.round(hi / 1000) * 1000
  if (netFor(rounded) >= targetNet && netFor(rounded) <= targetNet + 1500) return rounded
  return hi
}

const fmt = (n: number): string => n.toLocaleString('fr-FR').replace(/ /g, ' ') + ' FCFA'

const CP_PAR_MOIS = 2.5 // jours ouvrables acquis / mois travaillé (Code du Travail CI)

/** Solde de congés payés (acquis/pris/restant) à la fin du mois donné. */
function congesAsOf(e: Emp, year: number, month1to12: number): { acquired: number; taken: number; remaining: number } {
  const hire = new Date(e.hireDate)
  const monthsWorked = (year * 12 + month1to12) - (hire.getFullYear() * 12 + (hire.getMonth() + 1)) + 1
  const acquired = Math.max(0, Math.round(monthsWorked * CP_PAR_MOIS * 10) / 10)
  // Seule la secrétaire pose ses CP (avec la maternité, à partir de mars 2026).
  let taken = 0
  if (e.key === 'sec' && (year > 2026 || (year === 2026 && month1to12 >= 3))) {
    taken = e.cpPosed ?? 0
  }
  return { acquired, taken, remaining: Math.max(0, Math.round((acquired - taken) * 10) / 10) }
}

interface Emp {
  key: string
  firstName: string
  lastName: string
  email: string
  gender: 'M' | 'F'
  jobTitle: string
  dept: string
  category: string
  netTarget: number
  hireDate: string
  maritalStatus: string
  childrenCount: number
  brut?: number
  id?: string
  cpPosed?: number
}

/** Durée hebdo légale : 40h cadres, 35h agents de maîtrise (consigne WOYAA). */
function weeklyHours(category: string): number {
  return category === 'Agent de maîtrise' ? 35 : 40
}

/**
 * Crée/rafraîchit le tenant WOYAA (appelé par le seed prod ET en standalone).
 * @param opts.drop   true = drop le schéma tenant_woyaa avant (standalone). Quand
 *   le seed gère déjà le DROP via TENANT_SCHEMAS, passer false.
 * @param opts.report true = imprime les bulletins + RNS (run local uniquement).
 */
export async function seedWoyaa(opts: { drop?: boolean; report?: boolean } = {}): Promise<void> {
  const doDrop = opts.drop ?? true
  const doReport = opts.report ?? false
  if (doReport) console.log('=== Scénario WOYAA — initialisation ===\n')
  await createPlatformSchema()

  // 1) Tenant WOYAA (SARL, conseil stratégique, Abidjan)
  await pool.query(
    `INSERT INTO platform.tenants
       (name, slug, schema_name, plan_type, status, sector, city,
        cnps_number, dgi_number, rccm, at_rate, max_users, max_employees,
        primary_color, secondary_color)
     VALUES ('WOYAA SARL', $1, $2, 'business', 'active', 'services', 'Abidjan',
        'CI-CNPS-WOYAA-01', 'CI-DGI-WOYAA-01', 'CI-ABJ-2025-B-WOYAA', $3,
        50, 50, '#0EA5E9', '#0369A1')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sector = EXCLUDED.sector`,
    [SLUG, SCHEMA, AT_RATE.toString()],
  )

  // 2) Schéma tenant propre (idempotent). Quand le seed gère déjà le DROP via
  // TENANT_SCHEMAS, on ne re-drop pas (doDrop=false).
  if (doDrop) await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await provisionTenantSchema(SCHEMA)
  await seedPayrollRulesCI(SCHEMA, AT_RATE)
  await seedAbsenceTypesCI(SCHEMA)
  // Type d'absence Accident du travail (non inclus dans le set par défaut)
  await pool.query(
    `INSERT INTO "${SCHEMA}".absence_types (code, label, is_paid, color, calculation_mode)
     VALUES ('ACCIDENT_TRAVAIL', 'Accident du travail', true, '#DC2626', 'calendar_days')
     ON CONFLICT (code) DO NOTHING`,
  )
  if (doReport) console.log(`[1] Tenant ${SLUG} provisionné (schéma ${SCHEMA}, AT ${AT_RATE * 100}%)`)

  // 3) Départements
  const deptDefs = ['Direction Générale', 'Ressources Humaines', 'Commercial', 'Informatique']
  const deptId: Record<string, string> = {}
  for (const name of deptDefs) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO "${SCHEMA}".departments (name) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING id`, [name])
    deptId[name] = r.rows[0]?.id
      ?? (await pool.query<{ id: string }>(`SELECT id FROM "${SCHEMA}".departments WHERE name=$1`, [name])).rows[0]!.id
  }

  // 4) Effectif (salaires en NET → gross-up). Hypothèse : célibataire, 0 enfant.
  const employees: Emp[] = [
    { key: 'ceo', firstName: 'Konan',  lastName: 'Yao',       email: 'ceo@woyaa.ci',          gender: 'M', jobTitle: 'Directeur Général (CEO)',     dept: 'Direction Générale',   category: 'Cadre supérieur', netTarget: 1_600_000, hireDate: '2025-02-05', maritalStatus: 'single', childrenCount: 0 },
    { key: 'drh', firstName: 'Aïcha',  lastName: 'Touré',     email: 'drh@woyaa.ci',          gender: 'F', jobTitle: 'Directrice des Ressources Humaines', dept: 'Ressources Humaines', category: 'Cadre supérieur', netTarget: 1_200_000, hireDate: '2025-03-05', maritalStatus: 'single', childrenCount: 0 },
    { key: 'dc',  firstName: 'Marc',   lastName: 'Kouadio',   email: 'commercial@woyaa.ci',   gender: 'M', jobTitle: 'Directeur Commercial',        dept: 'Commercial',           category: 'Cadre supérieur', netTarget: 1_000_000, hireDate: '2025-03-05', maritalStatus: 'single', childrenCount: 0 },
    { key: 'rhm', firstName: 'Fatou',  lastName: 'Diallo',    email: 'rh.manager@woyaa.ci',   gender: 'F', jobTitle: 'RH Manager',                  dept: 'Ressources Humaines',  category: 'Cadre',           netTarget: 350_000,   hireDate: '2025-04-05', maritalStatus: 'single', childrenCount: 0 },
    { key: 'com', firstName: 'Awa',    lastName: 'Bamba',     email: 'commerciale@woyaa.ci',  gender: 'F', jobTitle: 'Chargée commerciale',         dept: 'Commercial',           category: 'Agent de maîtrise', netTarget: 350_000, hireDate: '2025-04-05', maritalStatus: 'single', childrenCount: 0 },
    { key: 'sec', firstName: 'Mariam', lastName: 'Koné',      email: 'secretaire@woyaa.ci',   gender: 'F', jobTitle: 'Secrétaire de direction',     dept: 'Direction Générale',   category: 'Agent de maîtrise', netTarget: 350_000, hireDate: '2025-04-05', maritalStatus: 'single', childrenCount: 0 },
    { key: 'it',  firstName: 'Ibrahim', lastName: 'Cissé',    email: 'informaticien@woyaa.ci', gender: 'M', jobTitle: 'Maintenancier informaticien', dept: 'Informatique',         category: 'Agent de maîtrise', netTarget: 350_000, hireDate: '2025-04-05', maritalStatus: 'single', childrenCount: 0 },
  ]

  // Admin du tenant
  const adminHash = await bcrypt.hash('Woyaa1234!', 12)
  await pool.query(
    `INSERT INTO "${SCHEMA}".users (email, password_hash, first_name, last_name, role, is_active)
     VALUES ('admin@woyaa.ci', $1, 'Admin', 'WOYAA', 'admin', true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [adminHash])

  for (const e of employees) {
    e.brut = grossUp(e.netTarget, e.maritalStatus, e.childrenCount)
    const r = await pool.query<{ id: string }>(
      `INSERT INTO "${SCHEMA}".employees
         (first_name, last_name, email, gender, nni, cnps_number,
          mobile_money_provider, mobile_money_phone, department_id, job_title,
          professional_category, contract_type, hire_date, base_salary, weekly_hours,
          city, marital_status, children_count, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,'wave',$7,$8,$9,$10,'cdi',$11,$12,$15,'Abidjan',$13,$14,true)
       RETURNING id`,
      [e.firstName, e.lastName, e.email, e.gender,
       `CI${Math.floor(100000000 + Math.random() * 899999999)}`,
       `CI${Math.floor(10000000 + Math.random() * 89999999)}A`,
       `+22507${Math.floor(10000000 + Math.random() * 89999999)}`,
       deptId[e.dept], e.jobTitle, e.category, e.hireDate, e.brut, e.maritalStatus, e.childrenCount,
       weeklyHours(e.category)],
    )
    e.id = r.rows[0]!.id
    // Contrat OHADA CDI
    await pool.query(
      `INSERT INTO "${SCHEMA}".contracts
         (employee_id, type, start_date, base_salary, working_hours, convention,
          job_title, job_level, cnps_affiliation, ohada_clause, status)
       VALUES ($1,'cdi',$2,$3,$6,'Convention conseil/services CI',$4,$5,true,true,'active')`,
      [e.id, e.hireDate, e.brut, e.jobTitle, e.category, weeklyHours(e.category)])
  }
  // Lier l'employé "secrétaire" et "ceo" à des comptes self-service
  for (const e of employees) {
    await pool.query(
      `INSERT INTO "${SCHEMA}".users (email, password_hash, first_name, last_name, role, is_active, employee_id)
       VALUES ($1,$2,$3,$4,'employee',true,$5)
       ON CONFLICT (email) DO UPDATE SET employee_id = EXCLUDED.employee_id`,
      [`${e.key}.self@woyaa.ci`, adminHash, e.firstName, e.lastName, e.id])
  }
  if (doReport) {
    console.log('[2] 7 employés + contrats créés (brut calculé par gross-up) :')
    for (const e of employees) {
      console.log(`    ${e.jobTitle.padEnd(34)} net cible ${fmt(e.netTarget).padStart(16)}  → brut ${fmt(e.brut!)}`)
    }
  }

  // 5) Types d'absence
  const at = await pool.query<{ id: string; code: string }>(`SELECT id, code FROM "${SCHEMA}".absence_types`)
  const absId: Record<string, string> = {}
  for (const row of at.rows) absId[row.code] = row.id

  // Maternité secrétaire : 16/03/2026, 98 jours calendaires
  const matStart = new Date(2026, 2, 16)
  const matEnd = new Date(matStart); matEnd.setDate(matEnd.getDate() + 98 - 1)
  // CP acquis par la secrétaire (jamais pris) : 2,5 j ouvrables / mois depuis 05/04/2025 → 28/02/2026
  const moisAcquis = 11 // avr 2025 → fév 2026 inclus (≈ 11 mois)
  const cpAcquisJours = Math.round(moisAcquis * 2.5) // ≈ 28 jours ouvrables
  // CP posés par la secrétaire avec la maternité (affichés sur le bulletin)
  employees.find((e) => e.key === 'sec')!.cpPosed = cpAcquisJours

  // Accident du travail informaticien : 05/06/2026, arrêt 2 semaines (14 j calendaires)
  const atStart = new Date(2026, 5, 5)
  const atEnd = new Date(atStart); atEnd.setDate(atEnd.getDate() + 14 - 1)

  // 6) Génère les bulletins mensuels (embauche → juin 2026) pour tout le monde
  const monthsRange: Array<{ y: number; m: number }> = []
  for (let y = 2025; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2025 && m < 2) continue
      if (y === 2026 && m > 6) continue
      monthsRange.push({ y, m })
    }
  }

  const slipKept: Record<string, Record<string, PayrollResult>> = {} // key emp.key → 'YYYY-MM' → result
  for (const e of employees) slipKept[e.key] = {}

  for (const { y, m } of monthsRange) {
    const monthStr = `${y}-${String(m).padStart(2, '0')}`
    const wdMonth = workingDaysInMonth(y, m)
    const period = await pool.query<{ id: string }>(
      `INSERT INTO "${SCHEMA}".pay_periods (month, status, closed_at, closed_by)
       VALUES ($1,'closed',now(),'scenario')
       ON CONFLICT (month, legal_entity_id) DO UPDATE SET status='closed' RETURNING id`,
      [monthStr])
    const periodId = period.rows[0]!.id
    let tg = 0, tn = 0, tc = 0, ti = 0

    for (const e of employees) {
      // Embauché ce mois-ci ? (pas de bulletin avant l'embauche)
      const hire = new Date(e.hireDate)
      if (y < hire.getFullYear() || (y === hire.getFullYear() && m < hire.getMonth() + 1)) continue

      // Prorata d'embauche : 1er mois → jours ouvrables à partir de la date d'embauche
      let workedDays = wdMonth
      let firstMonthProrata = false
      if (y === hire.getFullYear() && m === hire.getMonth() + 1) {
        workedDays = workingDaysBetween(y, m, hire.getDate(), 31)
        firstMonthProrata = true
      }

      const ctx: PayrollContext = {
        baseSalary: e.brut!, workedDays, workingDaysMonth: wdMonth,
        atRate: AT_RATE, maritalStatus: e.maritalStatus, childrenCount: e.childrenCount,
        variableElements: {},
      }

      // ── Secrétaire : maternité (16/03/2026 → +98 j) ─────────────────────────
      if (e.key === 'sec') {
        const mDay = new Date(y, m - 1, 1)
        const monthFirst = mDay
        const monthLast = new Date(y, m, 0)
        // Intersection [matStart, matEnd] ∩ mois
        const from = matStart > monthFirst ? matStart : monthFirst
        const to = matEnd < monthLast ? matEnd : monthLast
        if (from <= to && matEnd >= monthFirst && matStart <= monthLast) {
          // Jours d'absence maternité = jours ouvrables dans la fenêtre maternité
          // du mois ; les jours travaillés sont TOUS les autres (avant ET après,
          // ex. juin : maternité 1→21, travail 22→30).
          const absWd = workingDaysBetween(y, m, from.getDate(), to.getDate())
          ctx.workedDays = Math.max(0, wdMonth - absWd)
          ctx.absence = { type: 'maternite', absenceDays: absWd }
          // Les CP acquis sont POSÉS avec la maternité (consommés sur la période
          // couverte par l'indemnité maternité) : pas de cash ICP en double sur
          // le bulletin ; le solde de congés reflète les jours pris/restants.
        }
      }

      // ── Informaticien : accident du travail (05/06/2026, 2 semaines) ────────
      if (e.key === 'it' && monthStr === '2026-06') {
        const absWd = workingDaysBetween(y, m, atStart.getDate(), atEnd.getDate())
        const workedDaysJune = wdMonth - absWd
        ctx.workedDays = workedDaysJune
        ctx.absence = { type: 'accident_travail', absenceDays: absWd, atJourAccidentInMonth: true }
      }

      const res = calculatePayrollCI(ctx)
      slipKept[e.key]![monthStr] = res
      tg += res.grossSalary; tn += res.netPayable
      tc += res.totalCnpsSal + res.totalCnpsPat; ti += res.its

      await pool.query(
        `INSERT INTO "${SCHEMA}".pay_slips
           (employee_id, period_id, month, base_salary, gross_salary,
            cnps_retraite_sal, cnps_retraite_pat, cnps_pf_pat, cnps_at_pat,
            total_cnps_sal, total_cnps_pat, its, total_deductions,
            net_payable, employer_cost, lines, status, generated_at,
            payment_method, payment_status, payment_reference, paid_at, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'generated',now(),
                 'wave','paid',$17,now(),'XOF')
         ON CONFLICT DO NOTHING`,
        [e.id, periodId, monthStr, e.brut, res.grossSalary,
         res.cnpsRetraiteSal, res.cnpsRetraitePat, res.cnpsPfPat, res.cnpsAtPat,
         res.totalCnpsSal, res.totalCnpsPat, res.its, res.totalDeductions,
         res.netPayable, res.employerCost, JSON.stringify(res.lines),
         `WOYAA_${monthStr.replace('-', '')}_${e.key.toUpperCase()}`],
      )
      void firstMonthProrata
    }
    await pool.query(
      `UPDATE "${SCHEMA}".pay_periods SET total_gross=$1,total_net=$2,total_cnps=$3,total_its=$4 WHERE id=$5`,
      [tg, tn, tc, ti, periodId])
  }
  if (doReport) console.log(`[3] Bulletins générés (${monthsRange.length} mois × effectif présent)`)

  // 7) Enregistre les absences (maternité, CP, accident du travail)
  const sec = employees.find((e) => e.key === 'sec')!
  const it = employees.find((e) => e.key === 'it')!
  await pool.query(
    `INSERT INTO "${SCHEMA}".absences (employee_id, absence_type_id, start_date, end_date, days, reason, status, approved_at)
     VALUES ($1,$2,$3,$4,$5,'Congé maternité (14 semaines)','approved',now())`,
    [sec.id, absId['MATERNITE'], '2026-03-16', matEnd.toISOString().slice(0, 10), 98])
  await pool.query(
    `INSERT INTO "${SCHEMA}".absences (employee_id, absence_type_id, start_date, end_date, days, reason, status, approved_at)
     VALUES ($1,$2,$3,$4,$5,'Congés payés acquis (posés avec la maternité)','approved',now())`,
    [sec.id, absId['CP'], '2026-03-16', '2026-04-22', cpAcquisJours])
  await pool.query(
    `INSERT INTO "${SCHEMA}".absences (employee_id, absence_type_id, start_date, end_date, days, reason, status, approved_at)
     VALUES ($1,$2,$3,$4,14,'Accident du travail — arrêt 2 semaines','approved',now())`,
    [it.id, absId['ACCIDENT_TRAVAIL'] ?? absId['MALADIE'], '2026-06-05', atEnd.toISOString().slice(0, 10)])

  // Soldes de congés payés (CP) — visibles dans l'app, cohérents avec les bulletins (fin juin 2026)
  for (const e of employees) {
    const cp = congesAsOf(e, 2026, 6)
    await pool.query(
      `INSERT INTO "${SCHEMA}".absence_balances (employee_id, absence_type_id, year, acquired, taken, pending, remaining)
       VALUES ($1,$2,2026,$3,$4,0,$5)
       ON CONFLICT DO NOTHING`,
      [e.id, absId['CP'], cp.acquired, cp.taken, cp.remaining])
  }

  // ── RAPPORT : bulletins demandés ────────────────────────────────────────────
  const printSlip = (title: string, e: Emp, monthStr: string): void => {
    const r = slipKept[e.key]![monthStr]
    if (!r) { console.log(`\n### ${title} : aucun bulletin (absent ce mois)`); return }
    console.log(`\n──────────────────────────────────────────────────────────────`)
    console.log(`BULLETIN — ${title}`)
    console.log(`${e.firstName} ${e.lastName} · ${e.jobTitle} · ${monthStr}`)
    console.log(`Catégorie : ${e.category} · ${weeklyHours(e.category)}h/semaine · embauché le ${e.hireDate}`)
    console.log(`Salaire de base (brut mensuel) : ${fmt(e.brut!)}  | Jours travaillés : ${r.workingDays}/${workingDaysInMonth(+monthStr.slice(0,4), +monthStr.slice(5,7))}`)
    console.log(`──────────────────────────────────────────────────────────────`)
    for (const l of r.lines) {
      const sign = (l.type === 'employee_contribution' || l.type === 'deduction') ? '-' : (l.type.startsWith('employer') ? '~' : '+')
      console.log(`  ${sign} [${l.code}] ${l.label.padEnd(40)} ${fmt(l.amount).padStart(18)}`)
    }
    console.log(`  ─────`)
    console.log(`  Salaire brut .................... ${fmt(r.grossSalary).padStart(18)}`)
    console.log(`  Total retenues salariales ...... ${fmt(r.totalDeductions).padStart(18)}  (CNPS ${fmt(r.totalCnpsSal)} + ITS ${fmt(r.its)})`)
    console.log(`  NET À PAYER .................... ${fmt(r.netPayable).padStart(18)}`)
    console.log(`  Coût employeur (brut+patronal) . ${fmt(r.employerCost).padStart(18)}`)
    if (r.indemniteAbsence) console.log(`  Indemnité absence .............. ${fmt(r.indemniteAbsence).padStart(18)}`)
    if (r.bordereauCnps) console.log(`  ${r.bordereauCnps.label} : ${fmt(r.bordereauCnps.montant)}`)
    const cp = congesAsOf(e, +monthStr.slice(0, 4), +monthStr.slice(5, 7))
    console.log(`  Congés payés : acquis ${cp.acquired} j | pris ${cp.taken} j | restant ${cp.remaining} j`)
  }

  if (!doReport) return // appelé par le seed : pas d'impression des bulletins/RNS

  console.log('\n\n═══════════════ BULLETINS DEMANDÉS ═══════════════')
  printSlip('Secrétaire de direction — MARS 2026 (maternité + ICP)', sec, '2026-03')
  printSlip('Informaticien — JUIN 2026 (accident du travail)', it, '2026-06')
  printSlip('CEO — JUIN 2026', employees.find((e) => e.key === 'ceo')!, '2026-06')
  printSlip('DRH — JUIN 2026', employees.find((e) => e.key === 'drh')!, '2026-06')
  printSlip('Directeur commercial — JUIN 2026', employees.find((e) => e.key === 'dc')!, '2026-06')

  // ── RNS / RSN cumulé Jan→Juin 2026 ─────────────────────────────────────────
  console.log('\n\n═══════════════ RNS (Relevé Nominatif des Salaires) — cumul janvier→juin 2026 ═══════════════')
  console.log('Salarié                         | Brut cumulé      | CNPS sal.      | CNPS pat.      | ITS cumulé     | Net cumulé')
  console.log('─'.repeat(118))
  const rnsFor = employees
  for (const e of rnsFor) {
    let brut = 0, cnpsSal = 0, cnpsPat = 0, its = 0, net = 0
    for (let m = 1; m <= 6; m++) {
      const r = slipKept[e.key]![`2026-${String(m).padStart(2, '0')}`]
      if (!r) continue
      brut += r.grossSalary; cnpsSal += r.totalCnpsSal; cnpsPat += r.totalCnpsPat; its += r.its; net += r.netPayable
    }
    console.log(
      `${(e.jobTitle).slice(0, 30).padEnd(31)}| ${fmt(brut).padStart(16)} | ${fmt(cnpsSal).padStart(13)} | ${fmt(cnpsPat).padStart(13)} | ${fmt(its).padStart(13)} | ${fmt(net).padStart(13)}`)
  }

  console.log('\n\n=== Connexion à l\'application ===')
  console.log('  Tenant WOYAA SARL — admin@woyaa.ci / Woyaa1234!')
  console.log('  Self-service : <role>.self@woyaa.ci / Woyaa1234! (ex: sec.self@woyaa.ci)')
  console.log('\nScénario WOYAA terminé.')
}

// Exécution standalone (pnpm exec tsx src/scripts/scenario-woyaa.ts) : drop +
// rapport complet. En import (depuis seed.ts), rien ne s'exécute ici.
if (process.argv[1]?.includes('scenario-woyaa')) {
  seedWoyaa({ drop: true, report: true })
    .then(() => pool.end())
    .catch(async (err) => { console.error('Erreur scénario WOYAA:', err); await pool.end(); process.exit(1) })
}
