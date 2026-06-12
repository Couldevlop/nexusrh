/**
 * Outils IA "données internes" — donnent à l'assistant un accès LECTURE SEULE
 * et scopé (tenant + rôle) aux données RH, pour répondre aux questions internes
 * ("la DRH a-t-elle validé la paie ?", "combien d'absents aujourd'hui ?",
 * "quel employé est à surveiller ?") en plus des questions générales.
 *
 * Sécurité (OWASP A01/A03) :
 *  - schemaName validé par la route AVANT tout appel (SCHEMA_NAME_RE) ;
 *  - chaque outil n'est exposé qu'aux rôles autorisés (matrice TOOL_ACCESS,
 *    alignée sur la matrice RBAC des modules — un manager n'obtient pas la paie) ;
 *  - les managers reçoivent des agrégats SANS liste nominative (leur périmètre
 *    RBAC est limité à leur équipe) ;
 *  - requêtes paramétrées uniquement, montants en FCFA entiers ;
 *  - exécution fail-soft : une erreur DB renvoie { error } à l'IA, jamais un 500.
 */
import type { Pool } from 'pg'

export interface AiToolContext {
  schemaName: string
  role: string
}

// Format Anthropic Messages API (structurel — compatible Anthropic.Messages.Tool)
export interface AiToolDef {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

const ALL_TOOLS: AiToolDef[] = [
  {
    name: 'get_payroll_status',
    description:
      "Statut des périodes de paie du tenant : la période est-elle validée/clôturée, par qui et quand, totaux brut/net en FCFA. Utiliser pour répondre à « la DRH a-t-elle validé la paie ? », « où en est la paie de tel mois ? ».",
    input_schema: {
      type: 'object',
      properties: {
        month: {
          type: 'string',
          description: "Mois au format YYYY-MM (optionnel — par défaut les 3 dernières périodes)",
        },
      },
    },
  },
  {
    name: 'count_absences_today',
    description:
      "Nombre d'employés absents AUJOURD'HUI (absences approuvées couvrant la date du jour), avec le détail nominatif et le type d'absence si le rôle l'autorise.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pending_requests',
    description:
      "Demandes en attente de validation : absences (pending/submitted) et notes de frais (submitted). Utiliser pour « qu'est-ce qui attend une validation ? ».",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_headcount',
    description:
      "Effectifs actifs du tenant : total et répartition par département.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_employees_at_risk',
    description:
      "Employés à surveiller de près : top 5 par risque de départ (retention_score 0–1, élevé = risque fort) et risque de burnout calculés par le scoring IA nocturne. Utiliser pour « quel employé est à surveiller ? ».",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recruitment_pipeline',
    description:
      "Pipeline recrutement : offres ouvertes et candidatures par étape.",
    input_schema: { type: 'object', properties: {} },
  },
]

// Matrice rôle → outils (alignée RBAC modules : paie interdite aux managers,
// scoring rétention réservé admin/hr_manager/dg).
const TOOL_ACCESS: Record<string, ReadonlySet<string>> = {
  admin:      new Set(ALL_TOOLS.map(t => t.name)),
  hr_manager: new Set(ALL_TOOLS.map(t => t.name)),
  dg:         new Set(ALL_TOOLS.map(t => t.name)),
  hr_officer: new Set(['get_payroll_status', 'count_absences_today', 'get_pending_requests', 'get_headcount', 'get_recruitment_pipeline']),
  manager:    new Set(['count_absences_today', 'get_pending_requests', 'get_headcount']),
}

export function buildToolsForRole(role: string): AiToolDef[] {
  const allowed = TOOL_ACCESS[role]
  if (!allowed) return []
  return ALL_TOOLS.filter(t => allowed.has(t.name))
}

function asMonth(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const m = (input as Record<string, unknown>)['month']
    if (typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return m
  }
  return null
}

/**
 * Exécute un outil pour le tenant courant. Vérifie l'autorisation rôle→outil
 * (defense in depth : même si le modèle hallucinait un appel non listé).
 */
export async function executeAiTool(
  pool: Pool,
  ctx: AiToolContext,
  toolName: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const allowed = TOOL_ACCESS[ctx.role]
  if (!allowed || !allowed.has(toolName)) {
    return { error: `Outil non autorisé pour le rôle ${ctx.role}` }
  }
  const s = ctx.schemaName
  // Les managers ne reçoivent que des agrégats (pas de liste nominative).
  const includeNames = ctx.role !== 'manager'

  try {
    switch (toolName) {
      case 'get_payroll_status': {
        const month = asMonth(input)
        const res = await pool.query<{
          month: string; status: string; closed_at: string | null
          total_gross: string | null; total_net: string | null
          closed_by_name: string | null
        }>(
          `SELECT p.month, p.status, p.closed_at,
                  p.total_gross, p.total_net,
                  CASE WHEN u.id IS NULL THEN NULL
                       ELSE u.first_name || ' ' || u.last_name END AS closed_by_name
             FROM "${s}".pay_periods p
             -- closed_by est varchar(100) (uuid de user OU libellé hérité) :
             -- cast côté users, jamais uuid = varchar (erreur d'opérateur PG).
             LEFT JOIN "${s}".users u ON u.id::text = p.closed_by
            WHERE p.parent_period_id IS NULL
              AND ($1::text IS NULL OR p.month = $1)
            ORDER BY p.month DESC
            LIMIT 3`,
          [month],
        )
        return {
          periods: res.rows.map(r => ({
            month: r.month,
            status: r.status,
            validated: r.status === 'closed',
            closedAt: r.closed_at,
            closedBy: r.closed_by_name,
            totalGrossFcfa: r.total_gross ? Number(r.total_gross) : null,
            totalNetFcfa:   r.total_net ? Number(r.total_net) : null,
          })),
          note: "status 'closed' = paie validée et clôturée ; 'open' = en cours",
        }
      }

      case 'count_absences_today': {
        const res = await pool.query<{
          first_name: string; last_name: string; type_name: string | null
          start_date: string; end_date: string
        }>(
          `SELECT e.first_name, e.last_name, at.name AS type_name, a.start_date, a.end_date
             FROM "${s}".absences a
             JOIN "${s}".employees e ON e.id = a.employee_id
             LEFT JOIN "${s}".absence_types at ON at.id = a.absence_type_id
            WHERE a.status = 'approved'
              AND a.start_date <= CURRENT_DATE AND a.end_date >= CURRENT_DATE
            ORDER BY e.last_name
            LIMIT 100`,
        )
        return {
          absentToday: res.rows.length,
          ...(includeNames
            ? {
                details: res.rows.map(r => ({
                  employee: `${r.first_name} ${r.last_name}`,
                  type: r.type_name,
                  from: r.start_date,
                  to: r.end_date,
                })),
              }
            : { note: 'Détail nominatif non disponible pour votre rôle' }),
        }
      }

      case 'get_pending_requests': {
        const abs = await pool.query<{ count: string }>(
          `SELECT count(*) FROM "${s}".absences WHERE status IN ('pending', 'submitted')`,
        )
        const exp = await pool.query<{ count: string }>(
          `SELECT count(*) FROM "${s}".expense_reports WHERE status = 'submitted'`,
        )
        const out: Record<string, unknown> = {
          pendingAbsences: parseInt(abs.rows[0]?.count ?? '0'),
          pendingExpenseReports: parseInt(exp.rows[0]?.count ?? '0'),
        }
        if (includeNames) {
          const detail = await pool.query<{
            first_name: string; last_name: string; start_date: string; end_date: string
          }>(
            `SELECT e.first_name, e.last_name, a.start_date, a.end_date
               FROM "${s}".absences a
               JOIN "${s}".employees e ON e.id = a.employee_id
              WHERE a.status IN ('pending', 'submitted')
              ORDER BY a.created_at DESC LIMIT 10`,
          )
          out['pendingAbsencesDetails'] = detail.rows.map(r => ({
            employee: `${r.first_name} ${r.last_name}`, from: r.start_date, to: r.end_date,
          }))
        }
        return out
      }

      case 'get_headcount': {
        const total = await pool.query<{ count: string }>(
          `SELECT count(*) FROM "${s}".employees WHERE is_active = true`,
        )
        const byDept = await pool.query<{ name: string | null; count: string }>(
          `SELECT d.name, count(e.id) AS count
             FROM "${s}".employees e
             LEFT JOIN "${s}".departments d ON d.id = e.department_id
            WHERE e.is_active = true
            GROUP BY d.name ORDER BY count DESC`,
        )
        return {
          activeEmployees: parseInt(total.rows[0]?.count ?? '0'),
          byDepartment: byDept.rows.map(r => ({
            department: r.name ?? 'Sans département',
            count: parseInt(r.count),
          })),
        }
      }

      case 'get_employees_at_risk': {
        const res = await pool.query<{
          first_name: string; last_name: string; job_title: string | null
          retention_score: string | null; burnout_risk: string | null
        }>(
          `SELECT first_name, last_name, job_title, retention_score, burnout_risk
             FROM "${s}".employees
            WHERE is_active = true
              AND (retention_score IS NOT NULL OR burnout_risk IS NOT NULL)
            ORDER BY
              CASE burnout_risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              retention_score DESC NULLS LAST
            LIMIT 5`,
        )
        if (res.rows.length === 0) {
          return { employeesAtRisk: [], note: 'Aucun scoring IA disponible (le job nocturne n\'a pas encore tourné)' }
        }
        return {
          employeesAtRisk: res.rows.map(r => ({
            employee: `${r.first_name} ${r.last_name}`,
            jobTitle: r.job_title,
            retentionRiskScore: r.retention_score ? Number(r.retention_score) : null,
            burnoutRisk: r.burnout_risk,
          })),
          note: 'retentionRiskScore 0–1 (élevé = risque de départ fort) — scoring IA nocturne',
        }
      }

      case 'get_recruitment_pipeline': {
        const jobs = await pool.query<{ count: string }>(
          `SELECT count(*) FROM "${s}".recruitment_jobs WHERE status = 'open'`,
        )
        const byStage = await pool.query<{ stage: string | null; count: string }>(
          `SELECT a.stage, count(*) AS count
             FROM "${s}".applications a
             JOIN "${s}".recruitment_jobs j ON j.id = a.job_id
            WHERE j.status = 'open'
            GROUP BY a.stage ORDER BY count DESC`,
        )
        return {
          openJobs: parseInt(jobs.rows[0]?.count ?? '0'),
          applicationsByStage: byStage.rows.map(r => ({
            stage: r.stage ?? 'new',
            count: parseInt(r.count),
          })),
        }
      }

      default:
        return { error: `Outil inconnu : ${toolName}` }
    }
  } catch {
    return { error: 'Données indisponibles pour cette question (erreur interne ou module non provisionné)' }
  }
}
