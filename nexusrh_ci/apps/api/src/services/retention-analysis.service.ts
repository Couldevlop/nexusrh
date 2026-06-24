/**
 * Analyse du risque de rétention (départ) d'un salarié — calibrée Côte d'Ivoire.
 * Heuristique déterministe (pas d'appel IA requis) basée sur les facteurs du
 * CLAUDE.md : ancienneté < 18 mois, salaire ≈ SMIG depuis longtemps, absences
 * maladie élevées, absence de formation récente, faible score d'évaluation.
 *
 * Sortie : { score 0-100 (élevé = risque), risk: low|medium|high, factors[],
 * recommendations[] } — entièrement en français.
 */
import type { Pool } from 'pg'
import { isValidSchemaName } from '../utils/schema-name.js'

const SMIG_CI = 60_000 // FCFA/mois

export interface RetentionFactor { label: string; weight: number }
export interface RetentionResult {
  employeeId: string
  score: number
  risk: 'low' | 'medium' | 'high'
  factors: string[]
  recommendations: string[]
}

export async function analyzeRetentionRisk(
  pool: Pool, schema: string, employeeId: string,
): Promise<RetentionResult | null> {
  if (!isValidSchemaName(schema)) return null

  const empRes = await pool.query<{
    id: string; hire_date: string | null; base_salary: string | null
  }>(
    `SELECT id, hire_date, base_salary FROM "${schema}".employees
      WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [employeeId],
  )
  const emp = empRes.rows[0]
  if (!emp) return null

  const factors: string[] = []
  const recommendations: string[] = []
  let score = 0

  // 1) Ancienneté < 18 mois (intégration récente, plus volatile)
  let tenureMonths = 999
  if (emp.hire_date) {
    const hire = new Date(emp.hire_date)
    const now = new Date()
    tenureMonths = (now.getFullYear() - hire.getFullYear()) * 12 + (now.getMonth() - hire.getMonth())
  }
  if (tenureMonths < 18) {
    score += 25
    factors.push(`Ancienneté faible (${tenureMonths} mois < 18 mois)`)
    recommendations.push('Renforcer l\'accompagnement d\'intégration et planifier un point carrière.')
  }

  // 2) Salaire au niveau du SMIG (peu de marge de progression ressentie)
  const salary = Math.round(Number(emp.base_salary) || 0)
  if (salary > 0 && salary <= SMIG_CI * 1.1) {
    score += 20
    factors.push(`Rémunération proche du SMIG (${salary.toLocaleString('fr-FR')} FCFA)`)
    recommendations.push('Étudier une revalorisation salariale ou une prime de fidélisation.')
  }

  // 3) Absences maladie élevées sur le dernier trimestre (> 5 jours)
  let sickDays = 0
  try {
    const sick = await pool.query<{ d: string | null }>(
      `SELECT COALESCE(SUM(a.days),0) AS d
         FROM "${schema}".absences a
         JOIN "${schema}".absence_types t ON t.id = a.absence_type_id
        WHERE a.employee_id = $1 AND a.status = 'approved'
          AND a.start_date >= (CURRENT_DATE - INTERVAL '90 days')
          AND (t.code ILIKE 'malad%' OR t.label ILIKE 'malad%' OR t.code ILIKE 'sick%')`,
      [employeeId],
    )
    sickDays = Number(sick.rows[0]?.d) || 0
  } catch { /* table absente : ignoré */ }
  if (sickDays > 5) {
    score += 20
    factors.push(`Absences maladie élevées (${sickDays} j sur le trimestre)`)
    recommendations.push('Échanger avec le salarié sur la charge de travail et le bien-être (prévention burnout).')
  }

  // 4) Aucune formation depuis > 12 mois (manque de développement)
  let lastTraining: Date | null = null
  try {
    const tr = await pool.query<{ last: string | null }>(
      `SELECT MAX(ts.start_date) AS last
         FROM "${schema}".training_enrollments te
         JOIN "${schema}".training_sessions ts ON ts.id = te.session_id
        WHERE te.employee_id = $1`, [employeeId],
    )
    lastTraining = tr.rows[0]?.last ? new Date(tr.rows[0].last) : null
  } catch { /* ignoré */ }
  const noTraining = !lastTraining ||
    (Date.parse(new Date().toISOString()) - lastTraining.getTime()) > 365 * 24 * 3600 * 1000
  if (noTraining) {
    score += 15
    factors.push('Aucune formation suivie depuis plus de 12 mois')
    recommendations.push('Proposer une formation alignée sur le projet professionnel du salarié.')
  }

  // 5) Faible score à la dernière évaluation (< 3 / 5)
  let lastScore: number | null = null
  try {
    const ev = await pool.query<{ s: string | null }>(
      `SELECT COALESCE(global_score, performance_score) AS s
         FROM "${schema}".evaluations
        WHERE employee_id = $1 AND status = 'completed'
        ORDER BY year DESC, created_at DESC LIMIT 1`, [employeeId],
    )
    lastScore = ev.rows[0]?.s != null ? Number(ev.rows[0].s) : null
  } catch { /* ignoré */ }
  if (lastScore != null && lastScore < 3) {
    score += 20
    factors.push(`Dernière évaluation faible (${lastScore}/5)`)
    recommendations.push('Mettre en place un plan d\'accompagnement managérial avec objectifs intermédiaires.')
  }

  score = Math.min(100, score)
  const risk: RetentionResult['risk'] = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low'
  if (factors.length === 0) {
    factors.push('Aucun facteur de risque significatif détecté')
    recommendations.push('Maintenir le suivi régulier et reconnaître les contributions du salarié.')
  }

  return { employeeId, score, risk, factors, recommendations }
}
