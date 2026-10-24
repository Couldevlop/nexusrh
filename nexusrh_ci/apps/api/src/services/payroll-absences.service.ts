/**
 * Absences validées du mois -> paramètres du moteur de paie (maternité, AT,
 * maladie). Partagé par le calcul unitaire, le lot mono-filiale et le lot
 * multi-filiales (payroll-workflow) pour qu'ils appliquent les mêmes règles.
 */
import { pool as rawPool } from '../db/pool.js'
import type { AbsencePayrollInfo } from './payroll-engine-ci.js'

export function getWorkingDays(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate()
  let count = 0
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month - 1, d).getDay() !== 0) count++
  }
  return count
}

// ── Helper : ancienneté en années complètes ────────────────────────────────────
function getAnciennete(hireDateStr: string, refDate: Date): number {
  const hire = new Date(hireDateStr)
  let years = refDate.getFullYear() - hire.getFullYear()
  const m = refDate.getMonth() - hire.getMonth()
  if (m < 0 || (m === 0 && refDate.getDate() < hire.getDate())) years--
  return Math.max(0, years)
}

// ── Helper : taux de maintien maladie selon ancienneté (Convention collective CI) ──
function getMaintienTauxMaladie(anciennete: number): number {
  if (anciennete < 1)  return 0.50  // < 1 an : 50%
  if (anciennete < 5)  return 0.75  // 1–4 ans : 75%
  return 1.00                        // ≥ 5 ans : 100%
}

// ── Helper : résolution de l'absence principale du mois pour la paie ──────────
// Priorité : maternite > accident_travail > maladie_sans_at
// Retourne null si aucune absence validée impactant la paie
export async function resolveAbsenceForPayroll(
  schema: string,
  employeeId: string,
  month: string, // 'YYYY-MM'
  hireDateStr: string | null,
): Promise<{ info: AbsencePayrollInfo; absenceDays: number; workedDays: number; workingDaysMonth: number } | null> {
  const [year, monthNum] = month.split('-').map(Number)
  if (!year || !monthNum) return null

  const workingDaysMonth = getWorkingDays(year, monthNum)
  const monthStart = `${month}-01`
  const daysInMonth = new Date(year, monthNum, 0).getDate()
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`

  // Récupérer toutes les absences approuvées du mois
  // absence_types n'a pas de colonne slug : le type se reconnaît à son code
  // (MATERNITE, MALADIE, AT… — cf. seedAbsenceTypesCI).
  const absRes = await rawPool.query<{
    absence_type_code: string
    start_date: string
    end_date: string
  }>(
    `SELECT at.code AS absence_type_code, a.start_date, a.end_date
     FROM "${schema}".absences a
     JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
     WHERE a.employee_id = $1
       AND a.status = 'approved'
       AND a.start_date <= $2
       AND a.end_date   >= $3`,
    [employeeId, monthEnd, monthStart]
  )

  if (absRes.rows.length === 0) return null

  // Calculer les jours d'absence réels dans le mois (chevauchement)
  let materniteDay = 0
  let atDays = 0; let atJourAccidentInMonth = false
  let maladieDays = 0

  for (const row of absRes.rows) {
    const start = new Date(Math.max(new Date(row.start_date).getTime(), new Date(monthStart).getTime()))
    const end   = new Date(Math.min(new Date(row.end_date).getTime(), new Date(monthEnd).getTime()))
    // Compter jours ouvrables dans l'intersection
    let days = 0
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0) days++ // lundi–samedi
    }

    const code = (row.absence_type_code ?? '').toLowerCase()
    if (code.includes('maternit')) {
      materniteDay += days
    } else if (code === 'at' || code.includes('accident') || code.endsWith('_at')) {
      // Jour J = premier jour d'arrêt (payé employeur)
      const startMonth = new Date(row.start_date)
      atJourAccidentInMonth = startMonth >= new Date(monthStart) && startMonth <= new Date(monthEnd)
      atDays += days
    } else if (code.includes('maladi')) {
      maladieDays += days
    }
  }

  // Priorité : maternite > AT > maladie
  let absenceDays = 0
  let info: AbsencePayrollInfo | null = null

  if (materniteDay > 0) {
    absenceDays = Math.min(materniteDay, workingDaysMonth)
    info = { type: 'maternite', absenceDays }
  } else if (atDays > 0) {
    absenceDays = Math.min(atDays, workingDaysMonth)
    info = { type: 'accident_travail', absenceDays, atJourAccidentInMonth }
  } else if (maladieDays > 0) {
    absenceDays = Math.min(maladieDays, workingDaysMonth)
    const anciennete = hireDateStr ? getAnciennete(hireDateStr, new Date()) : 0
    const maintienTaux = getMaintienTauxMaladie(anciennete)
    info = { type: 'maladie_sans_at', absenceDays, maintienTaux }
  }

  if (!info) return null

  const workedDays = Math.max(0, workingDaysMonth - absenceDays)
  return { info, absenceDays, workedDays, workingDaysMonth }
}
