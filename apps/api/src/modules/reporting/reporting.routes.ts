import type { FastifyPluginAsync } from 'fastify'
import { eq, and, isNull, sql, count, gte, lte, desc, or } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { employees, departments } from '../../db/schema/employees'
import { paySlips, payPeriods, contracts } from '../../db/schema/payroll'
import { absences, absenceTypes } from '../../db/schema/absences'
import { jobOffers } from '../../db/schema/recruitment'
import { generateDashboardInsights } from '../ai/ai.service'

const reportingRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /reporting/dashboard ───────────────────────────────────────────────
  fastify.get('/dashboard', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['reporting'], summary: 'Données tableau de bord 360°' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const now = new Date()
      const todayStr = now.toISOString().split('T')[0] ?? ''

      // ── KPIs de base ──────────────────────────────────────────────────────
      const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        .toISOString().split('T')[0] ?? ''

      const [activeCount, newHiresCount, absentToday, openPositionsRow, pendingAbsencesRow] =
        await Promise.all([
          db.select({ count: count() }).from(employees)
            .where(and(eq(employees.status, 'active'), isNull(employees.deletedAt))),
          db.select({ count: count() }).from(employees)
            .where(and(
              eq(employees.status, 'active'),
              isNull(employees.deletedAt),
              gte(employees.hireDate, firstDayThisMonth),
            )),
          db.select({ count: count() }).from(absences)
            .where(and(
              eq(absences.status, 'approved'),
              lte(absences.startDate, todayStr),
              gte(absences.endDate, todayStr),
            )),
          db.select({ count: count() }).from(jobOffers)
            .where(eq(jobOffers.status, 'published')),
          db.select({ count: count() }).from(absences)
            .where(eq(absences.status, 'pending')),
        ])

      const active = Number(activeCount[0]?.count ?? 0)
      const absentCount = Number(absentToday[0]?.count ?? 0)
      const absenteeismRate = active > 0 ? (absentCount / active) * 100 : 0

      // ── Masse salariale dernière période clôturée ─────────────────────────
      const [latestPeriod] = await db.select()
        .from(payPeriods)
        .where(eq(payPeriods.status, 'closed'))
        .orderBy(desc(payPeriods.year), desc(payPeriods.month))
        .limit(1)

      let salaryMass = 0
      let avgGrossSalary = 0
      let salaryByDepartment: Array<{ department: string; amount: number; employeeCount: number }> = []

      if (latestPeriod) {
        const [massRow] = await db
          .select({
            total: sql<string>`COALESCE(SUM(${paySlips.grossSalary}::numeric), 0)`,
            avg: sql<string>`COALESCE(AVG(${paySlips.grossSalary}::numeric), 0)`,
          })
          .from(paySlips)
          .where(eq(paySlips.periodId, latestPeriod.id))

        salaryMass = Number(massRow?.total ?? 0)
        avgGrossSalary = Number(massRow?.avg ?? 0)

        const deptRows = await db
          .select({
            department: departments.name,
            amount: sql<string>`COALESCE(SUM(${paySlips.grossSalary}::numeric), 0)`,
            employeeCount: count(),
          })
          .from(paySlips)
          .innerJoin(employees, eq(paySlips.employeeId, employees.id))
          .leftJoin(departments, eq(employees.departmentId, departments.id))
          .where(eq(paySlips.periodId, latestPeriod.id))
          .groupBy(departments.name)
          .orderBy(sql`SUM(${paySlips.grossSalary}::numeric) DESC`)

        salaryByDepartment = deptRows.map((r) => ({
          department: r.department ?? 'Non affecté',
          amount: Number(r.amount),
          employeeCount: Number(r.employeeCount),
        }))
      }

      // ── Turnover 12 mois ──────────────────────────────────────────────────
      const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1)
        .toISOString().split('T')[0] ?? ''

      const departuresRows = await db
        .select({
          year: sql<number>`EXTRACT(YEAR FROM ${employees.endDate}::date)::integer`,
          month: sql<number>`EXTRACT(MONTH FROM ${employees.endDate}::date)::integer`,
          count: count(),
        })
        .from(employees)
        .where(and(
          isNull(employees.deletedAt),
          gte(employees.endDate, twelveMonthsAgo),
          lte(employees.endDate, todayStr),
        ))
        .groupBy(
          sql`EXTRACT(YEAR FROM ${employees.endDate}::date)`,
          sql`EXTRACT(MONTH FROM ${employees.endDate}::date)`,
        )

      const departureMap = new Map<string, number>()
      for (const r of departuresRows) {
        departureMap.set(`${r.year}-${r.month}`, Number(r.count))
      }

      // ── Headcount réel par mois ────────────────────────────────────────────
      const headcountTrend: Array<{ month: string; count: number }> = []
      const headcountPromises = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1)
        const firstDay = d.toISOString().split('T')[0] ?? ''
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0] ?? ''
        return db.select({ count: count() })
          .from(employees)
          .where(and(
            isNull(employees.deletedAt),
            lte(employees.hireDate, lastDay),
            or(isNull(employees.endDate), gte(employees.endDate, firstDay)),
          ))
          .then(([row]) => ({ d, count: Number(row?.count ?? 0) }))
      })
      const headcountResults = await Promise.all(headcountPromises)
      for (const { d, count: c } of headcountResults) {
        headcountTrend.push({
          month: d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }),
          count: c,
        })
      }

      // ── Turnover par mois (calculé sur headcount réel) ────────────────────
      const turnoverByMonth = headcountTrend.map((h, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1)
        const key = `${d.getFullYear()}-${d.getMonth() + 1}`
        const departures = departureMap.get(key) ?? 0
        return {
          month: h.month,
          rate: h.count > 0 ? Math.round((departures / h.count) * 1000) / 10 : 0,
          departures,
          hires: 0,
        }
      })

      // ── Absentéisme par mois ──────────────────────────────────────────────
      const absenceRows = await db
        .select({
          year: sql<number>`EXTRACT(YEAR FROM ${absences.startDate}::date)::integer`,
          month: sql<number>`EXTRACT(MONTH FROM ${absences.startDate}::date)::integer`,
          category: absenceTypes.category,
          days: sql<string>`COALESCE(SUM(${absences.daysCount}::numeric), 0)`,
        })
        .from(absences)
        .innerJoin(absenceTypes, eq(absences.absenceTypeId, absenceTypes.id))
        .where(and(
          eq(absences.status, 'approved'),
          gte(absences.startDate, twelveMonthsAgo),
        ))
        .groupBy(
          sql`EXTRACT(YEAR FROM ${absences.startDate}::date)`,
          sql`EXTRACT(MONTH FROM ${absences.startDate}::date)`,
          absenceTypes.category,
        )

      const absenceMap = new Map<string, { sick: number; vacation: number; other: number }>()
      for (const r of absenceRows) {
        const key = `${r.year}-${r.month}`
        const cur = absenceMap.get(key) ?? { sick: 0, vacation: 0, other: 0 }
        const days = Number(r.days)
        if (r.category === 'sickness' || r.category === 'maladie') cur.sick += days
        else if (r.category === 'paid_leave' || r.category === 'conges') cur.vacation += days
        else cur.other += days
        absenceMap.set(key, cur)
      }

      const absenceByMonth = headcountTrend.map((h, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1)
        const key = `${d.getFullYear()}-${d.getMonth() + 1}`
        const data = absenceMap.get(key) ?? { sick: 0, vacation: 0, other: 0 }
        return { month: h.month, ...data }
      })

      // ── Répartition absences par type ─────────────────────────────────────
      const absenceByType = await db
        .select({
          type: absenceTypes.label,
          category: absenceTypes.category,
          count: count(),
          days: sql<string>`COALESCE(SUM(${absences.daysCount}::numeric), 0)`,
        })
        .from(absences)
        .innerJoin(absenceTypes, eq(absences.absenceTypeId, absenceTypes.id))
        .where(and(
          eq(absences.status, 'approved'),
          gte(absences.startDate, twelveMonthsAgo),
        ))
        .groupBy(absenceTypes.label, absenceTypes.category)
        .orderBy(sql`SUM(${absences.daysCount}::numeric) DESC`)

      // ── Contrats expirant dans 30 jours ───────────────────────────────────
      const in30Days = new Date(now.getTime() + 30 * 24 * 3600 * 1000)
        .toISOString().split('T')[0] ?? ''

      const contractsExpiring = await db
        .select({
          id: contracts.id,
          type: contracts.type,
          endDate: contracts.endDate,
          firstName: employees.firstName,
          lastName: employees.lastName,
          jobTitle: employees.jobTitle,
          departmentName: departments.name,
        })
        .from(contracts)
        .innerJoin(employees, eq(contracts.employeeId, employees.id))
        .leftJoin(departments, eq(employees.departmentId, departments.id))
        .where(and(
          eq(contracts.status, 'active'),
          gte(contracts.endDate, todayStr),
          lte(contracts.endDate, in30Days),
          isNull(employees.deletedAt),
        ))
        .orderBy(contracts.endDate)

      // ── Stats par département ──────────────────────────────────────────────
      const deptStatsRows = await db
        .select({
          departmentId: departments.id,
          departmentName: departments.name,
          employeeCount: count(),
          avgSalary: sql<string>`COALESCE(AVG(${contracts.grossSalary}::numeric), 0)`,
        })
        .from(employees)
        .innerJoin(departments, eq(employees.departmentId, departments.id))
        .leftJoin(contracts, and(
          eq(contracts.employeeId, employees.id),
          eq(contracts.status, 'active'),
        ))
        .where(and(eq(employees.status, 'active'), isNull(employees.deletedAt)))
        .groupBy(departments.id, departments.name)
        .orderBy(sql`count(*) DESC`)

      // ── Calcul turnover 12 mois ───────────────────────────────────────────
      const totalDepartures = [...departureMap.values()].reduce((a, b) => a + b, 0)
      const turnoverRate = active > 0 ? (totalDepartures / active) * 100 : 0

      const dashboardData = {
        kpis: {
          totalEmployees: active,
          newHiresThisMonth: Number(newHiresCount[0]?.count ?? 0),
          salaryMassThisMonth: salaryMass,
          avgGrossSalary: Math.round(avgGrossSalary),
          absenteeismRate: Math.round(absenteeismRate * 10) / 10,
          turnoverRate: Math.round(turnoverRate * 10) / 10,
          openPositions: Number(openPositionsRow[0]?.count ?? 0),
          contractsExpiringIn30Days: contractsExpiring.length,
          pendingAbsences: Number(pendingAbsencesRow[0]?.count ?? 0),
          departures12Months: totalDepartures,
        },
        headcountTrend,
        salaryByDepartment,
        absenceByMonth,
        absenceByType: absenceByType.map((r) => ({
          type: r.type,
          category: r.category,
          count: Number(r.count),
          days: Math.round(Number(r.days) * 10) / 10,
        })),
        turnoverByMonth,
        contractsExpiring: contractsExpiring.map((c) => ({
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          jobTitle: c.jobTitle,
          department: c.departmentName ?? 'Non affecté',
          type: c.type,
          endDate: c.endDate,
        })),
        departmentStats: deptStatsRows.map((r) => ({
          department: r.departmentName,
          employeeCount: Number(r.employeeCount),
          avgSalary: Math.round(Number(r.avgSalary)),
        })),
        aiInsights: [],
      }

      const insights = await generateDashboardInsights(dashboardData as never).catch(() => [])
      dashboardData.aiInsights = insights as never

      return reply.send({ data: dashboardData })
    },
  })

  // ── GET /reporting/manager-dashboard ──────────────────────────────────────
  fastify.get('/manager-dashboard', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['reporting'], summary: 'Tableau de bord manager' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const managerId = request.user.sub
      const todayStr = new Date().toISOString().split('T')[0] ?? ''

      const teamMembers = await db
        .select({
          id: employees.id,
          firstName: employees.firstName,
          lastName: employees.lastName,
          jobTitle: employees.jobTitle,
        })
        .from(employees)
        .where(and(eq(employees.managerId, managerId), isNull(employees.deletedAt)))

      const teamIds = teamMembers.map((m) => m.id)

      let absentToday = 0
      if (teamIds.length > 0) {
        const [row] = await db.select({ count: count() }).from(absences)
          .where(and(
            eq(absences.status, 'approved'),
            lte(absences.startDate, todayStr),
            gte(absences.endDate, todayStr),
          ))
        absentToday = Number(row?.count ?? 0)
      }

      const pendingAbsencesRaw = await db
        .select({
          id: absences.id,
          employeeId: absences.employeeId,
          startDate: absences.startDate,
          endDate: absences.endDate,
          absenceType: absences.absenceTypeId,
        })
        .from(absences)
        .where(eq(absences.status, 'pending'))

      return reply.send({
        data: {
          teamSize: teamMembers.length,
          absentToday,
          pendingApprovals: pendingAbsencesRaw.length,
          ongoingTrainings: 0,
          teamMembers: teamMembers.map((m) => ({ ...m, isAbsentToday: false })),
          pendingAbsences: pendingAbsencesRaw.map((a) => ({
            id: a.id,
            firstName: '',
            lastName: '',
            startDate: a.startDate,
            endDate: a.endDate,
            absenceType: a.absenceType,
          })),
          pendingExpenses: [],
        },
      })
    },
  })

  // ── GET /reporting/export/xlsx ─────────────────────────────────────────────
  fastify.get('/export/xlsx', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['reporting'], summary: 'Export Excel du rapport RH complet' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const now = new Date()
      const todayStr = now.toISOString().split('T')[0] ?? ''
      const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1)
        .toISOString().split('T')[0] ?? ''
      const in30Days = new Date(now.getTime() + 30 * 24 * 3600 * 1000)
        .toISOString().split('T')[0] ?? ''

      const [allEmployees, deptRows, absenceRows, expiringContracts, [latestPeriod]] =
        await Promise.all([
          db.select({
            firstName: employees.firstName,
            lastName: employees.lastName,
            email: employees.email,
            jobTitle: employees.jobTitle,
            status: employees.status,
            hireDate: employees.hireDate,
            endDate: employees.endDate,
            departmentName: departments.name,
          })
          .from(employees)
          .leftJoin(departments, eq(employees.departmentId, departments.id))
          .where(isNull(employees.deletedAt))
          .orderBy(employees.lastName),

          db.select({
            name: departments.name,
            employeeCount: count(),
          })
          .from(employees)
          .innerJoin(departments, eq(employees.departmentId, departments.id))
          .where(and(eq(employees.status, 'active'), isNull(employees.deletedAt)))
          .groupBy(departments.name)
          .orderBy(sql`count(*) DESC`),

          db.select({
            label: absenceTypes.label,
            count: count(),
            days: sql<string>`COALESCE(SUM(${absences.daysCount}::numeric), 0)`,
          })
          .from(absences)
          .innerJoin(absenceTypes, eq(absences.absenceTypeId, absenceTypes.id))
          .where(and(
            eq(absences.status, 'approved'),
            gte(absences.startDate, twelveMonthsAgo),
          ))
          .groupBy(absenceTypes.label)
          .orderBy(sql`SUM(${absences.daysCount}::numeric) DESC`),

          db.select({
            firstName: employees.firstName,
            lastName: employees.lastName,
            jobTitle: employees.jobTitle,
            contractType: contracts.type,
            endDate: contracts.endDate,
            grossSalary: contracts.grossSalary,
          })
          .from(contracts)
          .innerJoin(employees, eq(contracts.employeeId, employees.id))
          .where(and(
            eq(contracts.status, 'active'),
            gte(contracts.endDate, todayStr),
            lte(contracts.endDate, in30Days),
            isNull(employees.deletedAt),
          ))
          .orderBy(contracts.endDate),

          db.select().from(payPeriods)
            .where(eq(payPeriods.status, 'closed'))
            .orderBy(desc(payPeriods.year), desc(payPeriods.month))
            .limit(1),
        ])

      let paySlipRows: Array<{ firstName: string; lastName: string; grossSalary: string; netPayable: string; month: number; year: number }> = []
      if (latestPeriod) {
        paySlipRows = await db
          .select({
            firstName: employees.firstName,
            lastName: employees.lastName,
            grossSalary: paySlips.grossSalary,
            netPayable: paySlips.netPayable,
            month: paySlips.month,
            year: paySlips.year,
          })
          .from(paySlips)
          .innerJoin(employees, eq(paySlips.employeeId, employees.id))
          .where(eq(paySlips.periodId, latestPeriod.id))
          .orderBy(employees.lastName)
          .then((rows) => rows.map((r) => ({
            firstName: r.firstName,
            lastName: r.lastName,
            grossSalary: String(r.grossSalary),
            netPayable: String(r.netPayable),
            month: Number(r.month),
            year: Number(r.year),
          })))
      }

      const PRIMARY = '#4F46E5'
      const wb = new ExcelJS.Workbook()
      wb.creator = 'NexusRH'
      wb.created = new Date()

      const headerStyle: Partial<ExcelJS.Style> = {
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } },
        font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
        alignment: { horizontal: 'center', vertical: 'middle' },
        border: {
          bottom: { style: 'thin', color: { argb: 'FF3730A3' } },
        },
      }

      const addSheet = (
        name: string,
        columns: Array<{ header: string; key: string; width: number }>,
        rows: Record<string, unknown>[],
      ) => {
        const ws = wb.addWorksheet(name)
        ws.columns = columns
        const headerRow = ws.getRow(1)
        headerRow.height = 28
        columns.forEach((_, i) => {
          const cell = headerRow.getCell(i + 1)
          Object.assign(cell, { style: headerStyle })
        })
        rows.forEach((r, idx) => {
          const row = ws.addRow(r)
          row.height = 20
          if (idx % 2 === 0) {
            row.eachCell((cell) => {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F3FF' } }
            })
          }
          row.eachCell((cell) => {
            cell.border = {
              bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } },
            }
          })
        })
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }
        return ws
      }

      // Sheet 1 — Effectifs
      addSheet('Effectifs', [
        { header: 'Nom', key: 'lastName', width: 18 },
        { header: 'Prénom', key: 'firstName', width: 16 },
        { header: 'Email', key: 'email', width: 28 },
        { header: 'Poste', key: 'jobTitle', width: 22 },
        { header: 'Département', key: 'departmentName', width: 18 },
        { header: 'Statut', key: 'status', width: 12 },
        { header: 'Date d\'embauche', key: 'hireDate', width: 16 },
        { header: 'Fin de contrat', key: 'endDate', width: 16 },
      ], allEmployees.map((e) => ({
        lastName: e.lastName,
        firstName: e.firstName,
        email: e.email ?? '',
        jobTitle: e.jobTitle ?? '',
        departmentName: e.departmentName ?? 'Non affecté',
        status: e.status === 'active' ? 'Actif' : 'Inactif',
        hireDate: e.hireDate ?? '',
        endDate: e.endDate ?? '',
      })))

      // Sheet 2 — Paie
      if (paySlipRows.length > 0) {
        addSheet(`Paie ${latestPeriod?.month}/${latestPeriod?.year}`, [
          { header: 'Nom', key: 'lastName', width: 18 },
          { header: 'Prénom', key: 'firstName', width: 16 },
          { header: 'Brut (€)', key: 'grossSalary', width: 14 },
          { header: 'Net (€)', key: 'netPayable', width: 14 },
          { header: 'Mois', key: 'month', width: 10 },
          { header: 'Année', key: 'year', width: 10 },
        ], paySlipRows)
      }

      // Sheet 3 — Absences par type
      addSheet('Absences 12 mois', [
        { header: 'Type d\'absence', key: 'label', width: 24 },
        { header: 'Nombre de demandes', key: 'count', width: 20 },
        { header: 'Jours totaux', key: 'days', width: 16 },
      ], absenceRows.map((r) => ({
        label: r.label,
        count: Number(r.count),
        days: Math.round(Number(r.days) * 10) / 10,
      })))

      // Sheet 4 — Répartition par département
      addSheet('Départements', [
        { header: 'Département', key: 'name', width: 24 },
        { header: 'Effectifs actifs', key: 'employeeCount', width: 18 },
      ], deptRows.map((r) => ({
        name: r.name,
        employeeCount: Number(r.employeeCount),
      })))

      // Sheet 5 — Contrats expirant
      addSheet('Contrats expirant (30j)', [
        { header: 'Nom', key: 'lastName', width: 18 },
        { header: 'Prénom', key: 'firstName', width: 16 },
        { header: 'Poste', key: 'jobTitle', width: 22 },
        { header: 'Type contrat', key: 'contractType', width: 14 },
        { header: 'Date de fin', key: 'endDate', width: 14 },
      ], expiringContracts.map((c) => ({
        lastName: c.lastName,
        firstName: c.firstName,
        jobTitle: c.jobTitle ?? '',
        contractType: c.contractType,
        endDate: c.endDate ?? '',
      })))

      const buffer = await wb.xlsx.writeBuffer()
      const dateStr = now.toISOString().split('T')[0]

      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="rapport-rh-${dateStr}.xlsx"`)
        .send(Buffer.from(buffer))
    },
  })

  // ── GET /reporting/export/pdf ──────────────────────────────────────────────
  fastify.get('/export/pdf', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['reporting'], summary: 'Export PDF du rapport RH' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const now = new Date()
      const todayStr = now.toISOString().split('T')[0] ?? ''
      const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1)
        .toISOString().split('T')[0] ?? ''
      const in30Days = new Date(now.getTime() + 30 * 24 * 3600 * 1000)
        .toISOString().split('T')[0] ?? ''

      const [activeCount, deptRows, absenceRows, expiringContracts, [latestPeriod]] =
        await Promise.all([
          db.select({ count: count() }).from(employees)
            .where(and(eq(employees.status, 'active'), isNull(employees.deletedAt))),
          db.select({
            name: departments.name,
            employeeCount: count(),
            avgSalary: sql<string>`COALESCE(AVG(${contracts.grossSalary}::numeric), 0)`,
          })
          .from(employees)
          .innerJoin(departments, eq(employees.departmentId, departments.id))
          .leftJoin(contracts, and(eq(contracts.employeeId, employees.id), eq(contracts.status, 'active')))
          .where(and(eq(employees.status, 'active'), isNull(employees.deletedAt)))
          .groupBy(departments.name)
          .orderBy(sql`count(*) DESC`),

          db.select({
            label: absenceTypes.label,
            count: count(),
            days: sql<string>`COALESCE(SUM(${absences.daysCount}::numeric), 0)`,
          })
          .from(absences)
          .innerJoin(absenceTypes, eq(absences.absenceTypeId, absenceTypes.id))
          .where(and(
            eq(absences.status, 'approved'),
            gte(absences.startDate, twelveMonthsAgo),
          ))
          .groupBy(absenceTypes.label)
          .orderBy(sql`SUM(${absences.daysCount}::numeric) DESC`)
          .limit(10),

          db.select({
            firstName: employees.firstName,
            lastName: employees.lastName,
            jobTitle: employees.jobTitle,
            contractType: contracts.type,
            endDate: contracts.endDate,
          })
          .from(contracts)
          .innerJoin(employees, eq(contracts.employeeId, employees.id))
          .where(and(
            eq(contracts.status, 'active'),
            gte(contracts.endDate, todayStr),
            lte(contracts.endDate, in30Days),
            isNull(employees.deletedAt),
          ))
          .orderBy(contracts.endDate)
          .limit(20),

          db.select().from(payPeriods)
            .where(eq(payPeriods.status, 'closed'))
            .orderBy(desc(payPeriods.year), desc(payPeriods.month))
            .limit(1),
        ])

      let salaryMass = 0
      if (latestPeriod) {
        const [massRow] = await db.select({
          total: sql<string>`COALESCE(SUM(${paySlips.grossSalary}::numeric), 0)`,
        }).from(paySlips).where(eq(paySlips.periodId, latestPeriod.id))
        salaryMass = Number(massRow?.total ?? 0)
      }

      const doc = new PDFDocument({ margin: 50, size: 'A4' })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))

      const PRIMARY_HEX = '#4F46E5'
      const DARK = '#1E293B'
      const GRAY = '#64748B'
      const LIGHT = '#F1F5F9'
      const totalEmployees = Number(activeCount[0]?.count ?? 0)
      const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })

      // Cover
      doc.rect(0, 0, doc.page.width, 120).fill(PRIMARY_HEX)
      doc.fillColor('white').fontSize(28).font('Helvetica-Bold').text('NexusRH', 50, 35)
      doc.fontSize(14).font('Helvetica').text('Rapport RH — Vision 360°', 50, 72)
      doc.fontSize(10).text(`Généré le ${dateStr}`, 50, 95)

      doc.moveDown(3).fillColor(DARK)

      // KPI section
      doc.fontSize(16).font('Helvetica-Bold').fillColor(PRIMARY_HEX).text('Indicateurs Clés', 50, 140)
      doc.moveTo(50, 162).lineTo(545, 162).strokeColor(PRIMARY_HEX).lineWidth(1).stroke()

      const kpis = [
        { label: 'Effectifs actifs', value: String(totalEmployees) },
        { label: 'Masse salariale', value: new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(salaryMass) },
        { label: 'Contrats expirant (30j)', value: String(expiringContracts.length) },
      ]

      let kpiX = 50
      const kpiY = 175
      for (const kpi of kpis) {
        doc.rect(kpiX, kpiY, 155, 60).fill(LIGHT)
        doc.fillColor(GRAY).fontSize(9).font('Helvetica').text(kpi.label, kpiX + 10, kpiY + 10, { width: 135 })
        doc.fillColor(DARK).fontSize(20).font('Helvetica-Bold').text(kpi.value, kpiX + 10, kpiY + 28, { width: 135 })
        kpiX += 165
      }

      // Departments table
      doc.moveDown(6)
      doc.fontSize(14).font('Helvetica-Bold').fillColor(PRIMARY_HEX).text('Répartition par Département', 50, 260)
      doc.moveTo(50, 280).lineTo(545, 280).strokeColor(PRIMARY_HEX).lineWidth(0.5).stroke()

      const deptHeaders = ['Département', 'Effectifs', 'Salaire moyen (€)']
      const deptWidths = [220, 100, 160]
      let ty = 290
      doc.rect(50, ty, 495, 22).fill(PRIMARY_HEX)
      let tx = 50
      for (let i = 0; i < deptHeaders.length; i++) {
        doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text(deptHeaders[i]!, tx + 6, ty + 6, { width: deptWidths[i]! - 6 })
        tx += deptWidths[i]!
      }
      ty += 22

      for (const [idx, dept] of deptRows.entries()) {
        if (idx % 2 === 0) doc.rect(50, ty, 495, 20).fill('#F8F9FF')
        tx = 50
        const vals = [
          dept.name,
          String(Number(dept.employeeCount)),
          new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Number(dept.avgSalary)),
        ]
        for (let i = 0; i < vals.length; i++) {
          doc.fillColor(DARK).fontSize(9).font('Helvetica').text(vals[i]!, tx + 6, ty + 5, { width: deptWidths[i]! - 6 })
          tx += deptWidths[i]!
        }
        ty += 20
        if (ty > 700) { doc.addPage(); ty = 50 }
      }

      // Absences table
      ty += 20
      if (ty + 60 > 720) { doc.addPage(); ty = 50 }
      doc.fontSize(14).font('Helvetica-Bold').fillColor(PRIMARY_HEX).text('Absences par type (12 mois)', 50, ty)
      ty += 20
      doc.moveTo(50, ty).lineTo(545, ty).strokeColor(PRIMARY_HEX).lineWidth(0.5).stroke()
      ty += 10

      const absHeaders = ['Type d\'absence', 'Demandes', 'Jours']
      const absWidths = [280, 100, 115]
      doc.rect(50, ty, 495, 22).fill(PRIMARY_HEX)
      tx = 50
      for (let i = 0; i < absHeaders.length; i++) {
        doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text(absHeaders[i]!, tx + 6, ty + 6, { width: absWidths[i]! - 6 })
        tx += absWidths[i]!
      }
      ty += 22

      for (const [idx, abs] of absenceRows.entries()) {
        if (idx % 2 === 0) doc.rect(50, ty, 495, 20).fill('#F8F9FF')
        tx = 50
        const vals = [abs.label, String(Number(abs.count)), String(Math.round(Number(abs.days) * 10) / 10)]
        for (let i = 0; i < vals.length; i++) {
          doc.fillColor(DARK).fontSize(9).font('Helvetica').text(vals[i]!, tx + 6, ty + 5, { width: absWidths[i]! - 6 })
          tx += absWidths[i]!
        }
        ty += 20
        if (ty > 700) { doc.addPage(); ty = 50 }
      }

      // Contrats expirant
      if (expiringContracts.length > 0) {
        ty += 20
        if (ty + 60 > 720) { doc.addPage(); ty = 50 }
        doc.fontSize(14).font('Helvetica-Bold').fillColor(PRIMARY_HEX).text('Contrats expirant dans 30 jours', 50, ty)
        ty += 20
        doc.moveTo(50, ty).lineTo(545, ty).strokeColor(PRIMARY_HEX).lineWidth(0.5).stroke()
        ty += 10

        const cHeaders = ['Collaborateur', 'Poste', 'Type', 'Fin de contrat']
        const cWidths = [160, 160, 70, 105]
        doc.rect(50, ty, 495, 22).fill(PRIMARY_HEX)
        tx = 50
        for (let i = 0; i < cHeaders.length; i++) {
          doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text(cHeaders[i]!, tx + 6, ty + 6, { width: cWidths[i]! - 6 })
          tx += cWidths[i]!
        }
        ty += 22

        for (const [idx, c] of expiringContracts.entries()) {
          if (idx % 2 === 0) doc.rect(50, ty, 495, 20).fill('#FFF7ED')
          tx = 50
          const vals = [
            `${c.lastName} ${c.firstName}`,
            c.jobTitle ?? '',
            c.contractType,
            c.endDate ?? '',
          ]
          for (let i = 0; i < vals.length; i++) {
            doc.fillColor(DARK).fontSize(9).font('Helvetica').text(vals[i]!, tx + 6, ty + 5, { width: cWidths[i]! - 6 })
            tx += cWidths[i]!
          }
          ty += 20
          if (ty > 700) { doc.addPage(); ty = 50 }
        }
      }

      // Footer
      doc.rect(0, doc.page.height - 40, doc.page.width, 40).fill(PRIMARY_HEX)
      doc.fillColor('white').fontSize(9).font('Helvetica')
        .text(`NexusRH — Rapport confidentiel — ${dateStr}`, 50, doc.page.height - 25, { align: 'center' })

      doc.end()
      const pdfBuffer = await new Promise<Buffer>((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)))
      })

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="rapport-rh-${now.toISOString().split('T')[0]}.pdf"`)
        .send(pdfBuffer)
    },
  })
}

export default reportingRoutes
