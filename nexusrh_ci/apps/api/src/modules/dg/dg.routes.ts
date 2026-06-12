import type { FastifyPluginAsync } from 'fastify'
import { pool } from '../../db/pool.js'

/**
 * Vue DG 360° — tableau de bord Direction Générale, AU-DESSUS du périmètre DRH.
 *
 * Donne au DG :
 *  - un dashboard 360° instantané (effectifs, masse salariale, paie, absences,
 *    validations en attente, recrutement, formation, frais) ;
 *  - le journal d'activité des responsables (DRH, RH, managers) : qui a fait
 *    quoi dans la journée / la semaine / le mois, filtrable par personne,
 *    groupé par catégorie dépliable (source : audit_log du tenant).
 *
 * Sécurité :
 *  - Rôle dédié `dg` UNIQUEMENT (OWASP A01) — ni admin ni hr_manager : la vue
 *    sert précisément à contrôler leurs actions.
 *  - Module `dg_view` OPT-IN : désactivé par défaut, activable PAR TENANT par
 *    le super_admin seul (hook global app.ts → 403 moduleDisabled sinon).
 *  - Lecture seule : aucune route de mutation dans ce module.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// OWASP A09 — trace des consultations DG (la vue de contrôle est elle-même
// auditée : le DRH peut savoir que le DG a consulté son activité).
function auditLogDg(
  schema: string, userId: string, action: string,
  changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'dg', NULL, $3, $4)`,
    [userId, action, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

/** Bornes temporelles d'une période relative (jour / semaine / mois). */
function periodBounds(period: string | undefined, from?: string, to?: string): { from: string; to: string } {
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  if (from && DATE_RE.test(from) && to && DATE_RE.test(to)) return { from, to }
  const end = iso(today)
  const start = new Date(today)
  if (period === 'day') {
    // aujourd'hui
  } else if (period === 'month') {
    start.setDate(start.getDate() - 30)
  } else {
    // défaut : semaine
    start.setDate(start.getDate() - 7)
  }
  return { from: iso(start), to: end }
}

const dgRoutes: FastifyPluginAsync = async (fastify) => {

  // ── GET /dg/overview — dashboard 360° (KPIs + séries graphiques) ───────────
  fastify.get('/overview', {
    preHandler: [fastify.authorize('dg')],
    schema: { tags: ['dg'], summary: 'Vue DG 360° — KPIs et graphiques instantanés' },
    handler: async (request, reply) => {
      const s = request.user.schemaName
      // Chaque bloc est fail-soft : un module non provisionné ne casse jamais
      // le dashboard (valeurs zéro à la place).
      const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
        try { return await fn() } catch { return fallback }
      }

      const [
        headcount, byDepartment, headcountSeries,
        payrollPeriods, payrollSeries,
        absencesToday, pendingAbsences, absencesByType,
        pendingExpenses, expensesMonth,
        recruitment, applicationsByStage,
        upcomingTrainingSessions, activeEnrollments,
        employeesAtRisk,
      ] = await Promise.all([
        safe(async () => {
          const r = await pool.query<{ count: string }>(
            `SELECT count(*) FROM "${s}".employees WHERE is_active = true`)
          return parseInt(r.rows[0]?.count ?? '0')
        }, 0),
        safe(async () => {
          const r = await pool.query<{ name: string | null; count: string }>(
            `SELECT d.name, count(e.id) AS count
               FROM "${s}".employees e
               LEFT JOIN "${s}".departments d ON d.id = e.department_id
              WHERE e.is_active = true GROUP BY d.name ORDER BY count DESC`)
          return r.rows.map(x => ({ department: x.name ?? 'Sans département', count: parseInt(x.count) }))
        }, [] as Array<{ department: string; count: number }>),
        safe(async () => {
          // Évolution des effectifs actifs sur 12 mois (cumul par date d'embauche)
          const r = await pool.query<{ month: string; count: string }>(
            `SELECT to_char(m.month, 'YYYY-MM') AS month,
                    (SELECT count(*) FROM "${s}".employees e
                      WHERE e.is_active = true
                        AND e.hire_date <= (m.month + interval '1 month' - interval '1 day')::date
                    ) AS count
               FROM generate_series(
                      date_trunc('month', CURRENT_DATE) - interval '11 months',
                      date_trunc('month', CURRENT_DATE),
                      interval '1 month') AS m(month)
              ORDER BY m.month`)
          return r.rows.map(x => ({ month: x.month, count: parseInt(x.count) }))
        }, [] as Array<{ month: string; count: number }>),
        safe(async () => {
          const r = await pool.query<{
            month: string; status: string; closed_at: string | null
            total_gross: string | null; total_net: string | null
            closed_by_name: string | null
          }>(
            `SELECT p.month, p.status, p.closed_at, p.total_gross, p.total_net,
                    CASE WHEN u.id IS NULL THEN NULL
                         ELSE u.first_name || ' ' || u.last_name END AS closed_by_name
               FROM "${s}".pay_periods p
               LEFT JOIN "${s}".users u ON u.id = p.closed_by
              WHERE p.parent_period_id IS NULL
              ORDER BY p.month DESC LIMIT 3`)
          return r.rows.map(x => ({
            month: x.month, status: x.status, validated: x.status === 'closed',
            closedAt: x.closed_at, closedBy: x.closed_by_name,
            totalGross: x.total_gross ? Number(x.total_gross) : 0,
            totalNet: x.total_net ? Number(x.total_net) : 0,
          }))
        }, [] as Array<{ month: string; status: string; validated: boolean; closedAt: string | null; closedBy: string | null; totalGross: number; totalNet: number }>),
        safe(async () => {
          const r = await pool.query<{
            month: string; total_gross: string | null; total_net: string | null
            total_cnps: string | null; total_its: string | null
          }>(
            `SELECT month, total_gross, total_net, total_cnps, total_its
               FROM "${s}".pay_periods
              WHERE parent_period_id IS NULL AND status = 'closed'
              ORDER BY month DESC LIMIT 12`)
          return r.rows.reverse().map(x => ({
            month: x.month,
            gross: x.total_gross ? Number(x.total_gross) : 0,
            net:   x.total_net ? Number(x.total_net) : 0,
            cnps:  x.total_cnps ? Number(x.total_cnps) : 0,
            its:   x.total_its ? Number(x.total_its) : 0,
          }))
        }, [] as Array<{ month: string; gross: number; net: number; cnps: number; its: number }>),
        safe(async () => {
          const r = await pool.query<{ count: string }>(
            `SELECT count(*) FROM "${s}".absences
              WHERE status = 'approved'
                AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE`)
          return parseInt(r.rows[0]?.count ?? '0')
        }, 0),
        safe(async () => {
          const r = await pool.query<{ count: string }>(
            `SELECT count(*) FROM "${s}".absences WHERE status IN ('pending', 'submitted')`)
          return parseInt(r.rows[0]?.count ?? '0')
        }, 0),
        safe(async () => {
          const r = await pool.query<{ name: string | null; count: string; days: string | null }>(
            `SELECT at.name, count(*) AS count, COALESCE(sum(a.days), 0) AS days
               FROM "${s}".absences a
               LEFT JOIN "${s}".absence_types at ON at.id = a.absence_type_id
              WHERE a.status = 'approved'
                AND a.start_date >= date_trunc('year', CURRENT_DATE)::date
              GROUP BY at.name ORDER BY count DESC`)
          return r.rows.map(x => ({
            type: x.name ?? 'Autre', count: parseInt(x.count), days: Number(x.days ?? 0),
          }))
        }, [] as Array<{ type: string; count: number; days: number }>),
        safe(async () => {
          const r = await pool.query<{ count: string }>(
            `SELECT count(*) FROM "${s}".expense_reports WHERE status = 'submitted'`)
          return parseInt(r.rows[0]?.count ?? '0')
        }, 0),
        safe(async () => {
          const r = await pool.query<{ total: string | null }>(
            `SELECT COALESCE(sum(total_amount), 0) AS total
               FROM "${s}".expense_reports
              WHERE status IN ('approved', 'paid')
                AND month = to_char(CURRENT_DATE, 'YYYY-MM')`)
          return Number(r.rows[0]?.total ?? 0)
        }, 0),
        safe(async () => {
          const r = await pool.query<{ count: string }>(
            `SELECT count(*) FROM "${s}".recruitment_jobs WHERE status = 'open'`)
          return parseInt(r.rows[0]?.count ?? '0')
        }, 0),
        safe(async () => {
          const r = await pool.query<{ stage: string | null; count: string }>(
            `SELECT a.stage, count(*) AS count
               FROM "${s}".applications a
               JOIN "${s}".recruitment_jobs j ON j.id = a.job_id
              WHERE j.status = 'open' GROUP BY a.stage ORDER BY count DESC`)
          return r.rows.map(x => ({ stage: x.stage ?? 'new', count: parseInt(x.count) }))
        }, [] as Array<{ stage: string; count: number }>),
        safe(async () => {
          const r = await pool.query<{ count: string }>(
            `SELECT count(*) FROM "${s}".training_sessions
              WHERE start_date >= CURRENT_DATE AND status <> 'cancelled'`)
          return parseInt(r.rows[0]?.count ?? '0')
        }, 0),
        safe(async () => {
          const r = await pool.query<{ count: string }>(
            `SELECT count(*) FROM "${s}".training_enrollments WHERE status = 'enrolled'`)
          return parseInt(r.rows[0]?.count ?? '0')
        }, 0),
        safe(async () => {
          const r = await pool.query<{
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
              LIMIT 5`)
          return r.rows.map(x => ({
            employee: `${x.first_name} ${x.last_name}`,
            jobTitle: x.job_title,
            retentionRiskScore: x.retention_score ? Number(x.retention_score) : null,
            burnoutRisk: x.burnout_risk,
          }))
        }, [] as Array<{ employee: string; jobTitle: string | null; retentionRiskScore: number | null; burnoutRisk: string | null }>),
      ])

      const lastClosed = payrollPeriods.find(p => p.validated)

      // KPIs dérivés instantanés : taux d'absentéisme du jour, évolution de la
      // masse salariale vs mois précédent, volume de candidatures en cours.
      const closedSeries = payrollSeries.filter(p => p.gross > 0)
      const prevClosed = closedSeries.length >= 2 ? closedSeries[closedSeries.length - 2] : undefined
      const lastSeriesGross = closedSeries.length >= 1 ? closedSeries[closedSeries.length - 1]?.gross ?? 0 : 0
      const payrollEvolutionPct = prevClosed && prevClosed.gross > 0
        ? Math.round(((lastSeriesGross - prevClosed.gross) / prevClosed.gross) * 1000) / 10
        : null
      const absenteeismRatePct = headcount > 0
        ? Math.round((absencesToday / headcount) * 1000) / 10
        : 0
      const totalApplications = applicationsByStage.reduce((sum, x) => sum + x.count, 0)

      auditLogDg(s, request.user.sub, 'dg.overview', {}, request.ip ?? null)

      return reply.send({
        data: {
          kpis: {
            activeEmployees:   headcount,
            payrollMassFcfa:   lastClosed?.totalGross ?? 0,
            payrollNetFcfa:    lastClosed?.totalNet ?? 0,
            payrollEvolutionPct,
            absentToday:       absencesToday,
            absenteeismRatePct,
            pendingApprovals:  pendingAbsences + pendingExpenses,
            pendingAbsences,
            pendingExpenses,
            openJobs:          recruitment,
            totalApplications,
            upcomingTrainingSessions,
            activeEnrollments,
            expensesApprovedThisMonthFcfa: expensesMonth,
          },
          payroll: {
            recentPeriods: payrollPeriods,
            series: payrollSeries,
          },
          headcount: {
            byDepartment,
            series: headcountSeries,
          },
          absences: { byType: absencesByType },
          recruitment: { applicationsByStage },
          employeesAtRisk,
        },
      })
    },
  })

  // ── GET /dg/activity — journal d'activité des responsables ─────────────────
  // ?userId=<uuid> (optionnel) — filtrer sur UN responsable (DRH, manager…)
  // ?period=day|week|month OU ?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Réponse : actions groupées par catégorie (dépliables côté UI) + détails.
  fastify.get('/activity', {
    preHandler: [fastify.authorize('dg')],
    schema: { tags: ['dg'], summary: 'Activité des responsables (jour/semaine/mois, par personne, groupée par catégorie)' },
    handler: async (request, reply) => {
      const s = request.user.schemaName
      const q = request.query as Record<string, string | undefined>

      // OWASP A03 — filtres strictement validés avant la requête.
      const userId = q['userId'] && UUID_RE.test(q['userId']) ? q['userId'] : null
      if (q['userId'] && !userId) {
        return reply.status(400).send({ error: 'userId invalide (UUID requis)' })
      }
      const { from, to } = periodBounds(q['period'], q['from'], q['to'])

      try {
        const res = await pool.query<{
          id: string; user_id: string | null; action: string; entity: string
          entity_id: string | null; changes: unknown; created_at: string
          user_name: string | null; user_role: string | null
        }>(
          `SELECT l.id, l.user_id, l.action, l.entity, l.entity_id, l.changes, l.created_at,
                  CASE WHEN u.id IS NULL THEN NULL
                       ELSE u.first_name || ' ' || u.last_name END AS user_name,
                  u.role AS user_role
             FROM "${s}".audit_log l
             LEFT JOIN "${s}".users u ON u.id = l.user_id
            WHERE l.created_at >= $1::date
              AND l.created_at < ($2::date + interval '1 day')
              AND ($3::uuid IS NULL OR l.user_id = $3::uuid)
            ORDER BY l.created_at DESC
            LIMIT 1000`,
          [from, to, userId],
        )

        // Groupement par catégorie (= colonne entity de l'audit log). L'UI
        // affiche les groupes repliés avec le compteur, dépliables vers les
        // détails pertinents (acteur, action, date, changements).
        const groups = new Map<string, Array<Record<string, unknown>>>()
        for (const row of res.rows) {
          const items = groups.get(row.entity) ?? []
          items.push({
            id:        row.id,
            action:    row.action,
            entityId:  row.entity_id,
            userId:    row.user_id,
            userName:  row.user_name ?? 'Système',
            userRole:  row.user_role,
            changes:   row.changes ?? {},
            createdAt: row.created_at,
          })
          groups.set(row.entity, items)
        }

        auditLogDg(s, request.user.sub, 'dg.activity', { from, to, userId }, request.ip ?? null)

        return reply.send({
          data: {
            from, to, userId,
            totalActions: res.rows.length,
            groups: [...groups.entries()]
              .map(([category, items]) => ({ category, count: items.length, items }))
              .sort((a, b) => b.count - a.count),
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /dg/actors — responsables filtrables (dropdown du journal) ────────
  fastify.get('/actors', {
    preHandler: [fastify.authorize('dg')],
    schema: { tags: ['dg'], summary: 'Responsables du tenant (filtre du journal d\'activité)' },
    handler: async (request, reply) => {
      const s = request.user.schemaName
      try {
        const res = await pool.query<{
          id: string; first_name: string; last_name: string; role: string; email: string
        }>(
          `SELECT id, first_name, last_name, role, email
             FROM "${s}".users
            WHERE is_active = true
              AND role IN ('admin', 'hr_manager', 'hr_officer', 'manager', 'raf_site')
            ORDER BY role, last_name`,
        )
        return reply.send({
          data: res.rows.map(u => ({
            id: u.id,
            name: `${u.first_name} ${u.last_name}`,
            role: u.role,
            email: u.email,
          })),
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default dgRoutes
