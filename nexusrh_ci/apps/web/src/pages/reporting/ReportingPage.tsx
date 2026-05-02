import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA } from '@/lib/api'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, PieChart, Pie, Cell,
  AreaChart, Area, RadarChart, Radar, PolarGrid, PolarAngleAxis,
} from 'recharts'
import {
  TrendingUp, Users, CreditCard, FileText, Calendar,
  BarChart3, Download, Printer, AlertTriangle, Target,
  Activity, Percent,
} from 'lucide-react'

interface OverviewData {
  year: number; activeEmployees: number
  departments: Array<{ department: string; count: number; avg_salary: number }>
  payrollEvolution: Array<{ month: string; total_gross: number; total_net: number; total_cnps: number; total_its?: number }>
  annualTotals: { totalGross: number; totalNet: number; totalCnps: number; totalIts: number }
  absencesByType: Array<{ type_label: string; type_color: string; count: number; total_days: number }>
  recruitmentByStatus: Array<{ status: string; count: number }>
}

const PALETTE = ['#4F46E5','#F97316','#10B981','#8B5CF6','#EF4444','#0EA5E9','#F59E0B','#EC4899']
const currentYear = new Date().getFullYear()

function downloadCSV(rows: (string|number)[][], filename: string) {
  const csv = rows.map(r => r.join(';')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click()
}

export default function ReportingPage() {
  const [year, setYear] = useState(currentYear)

  const { data: overviewData, isLoading } = useQuery<{ data: OverviewData }>({
    queryKey: ['reporting-overview', year],
    queryFn: () => api.get(`/reporting/overview?year=${year}`).then(r => r.data),
  })

  const { data: absData } = useQuery<{ data: { byMonth: Array<{ month: string; count: number; total_days: number }> } }>({
    queryKey: ['reporting-absences', year],
    queryFn: () => api.get(`/reporting/absences?year=${year}`).then(r => r.data),
  })

  const overview = overviewData?.data
  const absMonthly = absData?.data?.byMonth ?? []

  if (!overview && !isLoading) return (
    <div className="flex flex-col items-center justify-center p-24 text-muted-foreground">
      <BarChart3 className="h-12 w-12 opacity-20 mb-3" />
      <p className="font-medium">Aucune donnée pour {year}</p>
    </div>
  )

  const payEvol = overview?.payrollEvolution ?? []
  const depts   = overview?.departments ?? []
  const absTypes = overview?.absencesByType ?? []
  const totals   = overview?.annualTotals ?? { totalGross:0, totalNet:0, totalCnps:0, totalIts:0 }

  // ── Données graphiques ─────────────────────────────────────────────────────

  const payChart = payEvol.map(p => ({
    m:    p.month.slice(5),
    brut: Math.round(p.total_gross / 1_000),
    net:  Math.round(p.total_net   / 1_000),
    cnps: Math.round(p.total_cnps  / 1_000),
    its:  Math.round((p.total_its ?? 0) / 1_000),
    ratio: p.total_gross > 0 ? Math.round((p.total_net / p.total_gross) * 100) : 0,
  }))

  const absChart = absMonthly.map(a => ({
    m: a.month.slice(5), jours: a.total_days, count: a.count,
  }))

  const deptChart = depts.map(d => {
    const dept = d.department ?? 'Sans département'
    return {
      name: dept.length > 12 ? dept.slice(0, 12) + '…' : dept,
      effectifs: d.count,
      salaireMoyen: Math.round(d.avg_salary / 1_000),
    }
  })

  // Taux absentéisme = total jours abs / (effectifs × jours ouvrés)
  const totalAbsDays = absTypes.reduce((s, a) => s + a.total_days, 0)
  const txAbsenteisme = overview?.activeEmployees && overview.activeEmployees > 0
    ? ((totalAbsDays / (overview.activeEmployees * 220)) * 100).toFixed(1)
    : '0'

  // Radar KPIs managériaux
  const radarData = [
    { kpi: 'CNPS',       value: totals.totalGross > 0 ? Math.min(100, Math.round((1-(totals.totalCnps/totals.totalGross))*100)) : 100 },
    { kpi: 'Net/Brut',   value: totals.totalGross > 0 ? Math.round((totals.totalNet/totals.totalGross)*100) : 0 },
    { kpi: 'Présence',   value: Math.max(0, 100-parseFloat(txAbsenteisme)) },
    { kpi: 'Recrutement',value: (overview?.recruitmentByStatus?.find(r=>r.status==='hired')?.count ?? 0) > 0 ? 80 : 40 },
    { kpi: 'Formation',  value: 65 },
    { kpi: 'Stabilité',  value: 75 },
  ]

  // Coût employeur pie
  const coutPie = [
    { name: 'Net versé',     value: totals.totalNet,  fill: '#10B981' },
    { name: 'CNPS patronal', value: Math.round(totals.totalCnps * 0.55), fill: '#F97316' },
    { name: 'CNPS salarial', value: Math.round(totals.totalCnps * 0.45), fill: '#FB923C' },
    { name: 'ITS / DGI',    value: totals.totalIts,  fill: '#8B5CF6' },
  ].filter(d => d.value > 0)

  const fmtK = (v: number) => v >= 1_000 ? `${(v/1_000).toFixed(0)}M` : `${v}k`

  const handleExport = () => {
    const header = ['Mois','Brut (FCFA)','Net (FCFA)','CNPS (FCFA)','ITS (FCFA)','Ratio Net/Brut']
    const rows = payEvol.map(p => [
      p.month, p.total_gross, p.total_net, p.total_cnps, p.total_its??0,
      p.total_gross > 0 ? `${Math.round((p.total_net/p.total_gross)*100)}%` : ''
    ])
    downloadCSV([
      [`=== REPORTING RH ${year} ===`],
      [`Effectifs actifs : ${overview?.activeEmployees ?? 0}`],
      [`Masse salariale : ${formatFCFA(totals.totalGross)}`],
      [`Taux absentéisme : ${txAbsenteisme}%`], [],
      header, ...rows,
      [], ['Département','Effectifs','Salaire moyen (FCFA)'],
      ...depts.map(d => [d.department ?? 'Sans département', d.count, Math.round(d.avg_salary)]),
    ], `reporting-rh-${year}.csv`)
  }

  return (
    <div className="p-6 space-y-6">

      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reporting RH</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Tableau de bord décisionnel · Contrôle de gestion sociale</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={year} onChange={e => setYear(parseInt(e.target.value))}
            className="rounded-lg border px-3 py-1.5 text-sm">
            {[currentYear, currentYear-1, currentYear-2].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={handleExport}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted">
            <Download className="h-4 w-4 text-green-600" /> Excel
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted">
            <Printer className="h-4 w-4 text-red-500" /> PDF
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : (
        <>
          {/* ── KPI Décisionnel ────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KCard icon={Users}       color="blue"   label="Effectifs actifs"     value={String(overview?.activeEmployees ?? 0)} sub={`${depts.length} dép.`} />
            <KCard icon={CreditCard}  color="orange" label="Masse salariale"       value={formatFCFA(totals.totalGross)}  sub={`${year}`} />
            <KCard icon={FileText}    color="violet" label="Charges sociales"      value={formatFCFA(totals.totalCnps + totals.totalIts)} sub="CNPS + ITS" />
            <KCard icon={Percent}     color="teal"   label="Ratio Net/Brut"
              value={totals.totalGross > 0 ? `${Math.round((totals.totalNet/totals.totalGross)*100)} %` : '—'}
              sub="Part versée salariés" />
            <KCard icon={Activity}    color="emerald" label="Taux absentéisme"    value={`${txAbsenteisme} %`} sub={`${totalAbsDays} jours`} />
            <KCard icon={TrendingUp}  color="amber"  label="Net total versé"      value={formatFCFA(totals.totalNet)} sub="Salaires nets" />
            <KCard icon={Target}      color="red"    label="Coût employeur total"  value={formatFCFA(totals.totalGross + Math.round(totals.totalCnps * 0.55))} sub="Brut + charges pat." />
            <KCard icon={AlertTriangle} color="rose" label="Absences totales"     value={`${totalAbsDays} j`} sub={`${absTypes.reduce((s,a)=>s+a.count,0)} demandes`} />
          </div>

          {/* ── Graphique 1 : Évolution masse salariale (ComposedChart) ── */}
          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <div className="mb-4">
              <p className="font-semibold">Évolution de la masse salariale {year}</p>
              <p className="text-xs text-muted-foreground">Brut · Net · CNPS · ITS · Ratio Net/Brut (axe droit) — en milliers FCFA</p>
            </div>
            {payChart.length > 0 ? (
              <ResponsiveContainer width="100%" height={290}>
                <ComposedChart data={payChart} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="m" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="l" tick={{ fontSize: 10 }} tickFormatter={fmtK} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10 }} unit="%" domain={[0,100]} />
                  <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }}
                    formatter={(v: number, n: string) => n === 'Ratio %' ? [`${v}%`] : [`${v.toLocaleString('fr-CI')} k FCFA`, n]} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                  <Bar yAxisId="l" dataKey="brut"  name="Brut"  fill="#4F46E5" radius={[2,2,0,0]} />
                  <Bar yAxisId="l" dataKey="net"   name="Net"   fill="#10B981" radius={[2,2,0,0]} />
                  <Bar yAxisId="l" dataKey="cnps"  name="CNPS"  fill="#F97316" radius={[2,2,0,0]} />
                  <Bar yAxisId="l" dataKey="its"   name="ITS"   fill="#8B5CF6" radius={[2,2,0,0]} />
                  <Line yAxisId="r" type="monotone" dataKey="ratio" name="Ratio %" stroke="#EF4444" strokeWidth={2.5} dot={{ r: 4 }} strokeDasharray="4 2" />
                </ComposedChart>
              </ResponsiveContainer>
            ) : <Empty />}
          </div>

          {/* ── Graphiques 2+3 ────────────────────────────────── */}
          <div className="grid gap-6 lg:grid-cols-3">

            {/* Répartition coût employeur — Pie donut */}
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <p className="font-semibold mb-1">Décomposition coût employeur</p>
              <p className="text-xs text-muted-foreground mb-3">Total annuel {year}</p>
              {coutPie.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={160}>
                    <PieChart>
                      <Pie data={coutPie} cx="50%" cy="50%" innerRadius={42} outerRadius={68}
                        dataKey="value" paddingAngle={3}>
                        {coutPie.map((d,i) => <Cell key={i} fill={d.fill} />)}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatFCFA(v)} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-1.5 mt-1">
                    {coutPie.map(d => (
                      <div key={d.name} className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: d.fill }} />
                          <span className="text-muted-foreground">{d.name}</span>
                        </span>
                        <span className="font-semibold">{formatFCFA(d.value)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : <Empty />}
            </div>

            {/* Radar KPIs managériaux */}
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <p className="font-semibold mb-1">Tableau de bord de pilotage</p>
              <p className="text-xs text-muted-foreground mb-3">Score sur 100 par dimension RH</p>
              <ResponsiveContainer width="100%" height={210}>
                <RadarChart data={radarData} margin={{ top: 0, right: 20, left: 20, bottom: 0 }}>
                  <PolarGrid stroke="hsl(var(--border))" />
                  <PolarAngleAxis dataKey="kpi" tick={{ fontSize: 11 }} />
                  <Radar name="Score" dataKey="value" stroke="#4F46E5" fill="#4F46E5" fillOpacity={0.25} dot={{ r: 3 }} />
                  <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} formatter={(v: number) => [`${v}/100`]} />
                </RadarChart>
              </ResponsiveContainer>
            </div>

            {/* Effectifs par département */}
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <p className="font-semibold mb-1">Effectifs par département</p>
              <p className="text-xs text-muted-foreground mb-3">Salaire moyen (axe droite, en k FCFA)</p>
              {deptChart.length > 0 ? (
                <ResponsiveContainer width="100%" height={210}>
                  <ComposedChart data={deptChart} layout="vertical" margin={{ top: 0, right: 32, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={72} />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }}
                      formatter={(v: number, n: string) => [n === 'Sal. moy (k)' ? `${v}k FCFA` : `${v} emp.`, n]} />
                    <Bar dataKey="effectifs" name="Effectifs" fill="#4F46E5" radius={[0,3,3,0]} />
                    <Line dataKey="salaireMoyen" name="Sal. moy (k)" stroke="#F97316" strokeWidth={2} dot={{ r: 3 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : <Empty />}
            </div>
          </div>

          {/* ── Graphiques 4+5 ────────────────────────────────── */}
          <div className="grid gap-6 lg:grid-cols-2">

            {/* Absentéisme mensuel — Area */}
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <p className="font-semibold mb-1">Évolution de l'absentéisme {year}</p>
              <p className="text-xs text-muted-foreground mb-3">Jours d'absence cumulés par mois</p>
              {absChart.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={absChart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gradAbs" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#EF4444" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="m" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }}
                      formatter={(v: number, n: string) => [n === 'jours' ? `${v} jours` : `${v} demandes`, n]} />
                    <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="jours" name="Jours abs." stroke="#EF4444" strokeWidth={2} fill="url(#gradAbs)" />
                    <Line type="monotone" dataKey="count" name="Demandes" stroke="#F97316" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <Empty />}
            </div>

            {/* Absences par type */}
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <p className="font-semibold mb-1">Répartition par type d'absence</p>
              <p className="text-xs text-muted-foreground mb-4">{year} · jours consommés</p>
              {absTypes.length > 0 ? (
                <div className="space-y-3">
                  {absTypes.map((a, i) => (
                    <div key={a.type_label}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: a.type_color || PALETTE[i % PALETTE.length] }} />
                          <span className="text-muted-foreground">{a.type_label}</span>
                        </span>
                        <span className="font-semibold">{a.total_days}j
                          <span className="ml-1 text-xs text-muted-foreground font-normal">({a.count} dem.)</span>
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full"
                          style={{
                            width: `${Math.round((a.total_days / (totalAbsDays || 1)) * 100)}%`,
                            background: a.type_color || PALETTE[i % PALETTE.length],
                          }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : <Empty />}
            </div>
          </div>

          {/* ── Tableau récapitulatif mensuel ────────────────── */}
          {payEvol.length > 0 && (
            <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b bg-muted/30">
                <p className="font-semibold">Récapitulatif mensuel {year}</p>
                <button onClick={handleExport}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                  <Download className="h-3.5 w-3.5" /> Exporter
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide bg-muted/20">
                      <th className="px-5 py-3">Mois</th>
                      <th className="px-5 py-3 text-right">Brut</th>
                      <th className="px-5 py-3 text-right">Net</th>
                      <th className="px-5 py-3 text-right">CNPS</th>
                      <th className="px-5 py-3 text-right">ITS/DGI</th>
                      <th className="px-5 py-3 text-right">Ratio</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {payEvol.map((p, i) => {
                      const ratio = p.total_gross > 0 ? Math.round((p.total_net/p.total_gross)*100) : 0
                      return (
                        <tr key={p.month} className={i%2===0 ? '' : 'bg-muted/10'}>
                          <td className="px-5 py-3 font-medium">{p.month}</td>
                          <td className="px-5 py-3 text-right font-mono">{formatFCFA(p.total_gross)}</td>
                          <td className="px-5 py-3 text-right font-mono text-emerald-700">{formatFCFA(p.total_net)}</td>
                          <td className="px-5 py-3 text-right font-mono text-orange-600">{formatFCFA(p.total_cnps)}</td>
                          <td className="px-5 py-3 text-right font-mono text-violet-600">{formatFCFA(p.total_its ?? 0)}</td>
                          <td className="px-5 py-3 text-right">
                            <span className={`font-semibold ${ratio >= 70 ? 'text-emerald-600' : ratio >= 60 ? 'text-amber-600' : 'text-red-500'}`}>
                              {ratio}%
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                    <tr className="bg-muted/40 font-semibold text-sm border-t-2">
                      <td className="px-5 py-3">TOTAL {year}</td>
                      <td className="px-5 py-3 text-right font-mono">{formatFCFA(totals.totalGross)}</td>
                      <td className="px-5 py-3 text-right font-mono text-emerald-700">{formatFCFA(totals.totalNet)}</td>
                      <td className="px-5 py-3 text-right font-mono text-orange-600">{formatFCFA(totals.totalCnps)}</td>
                      <td className="px-5 py-3 text-right font-mono text-violet-600">{formatFCFA(totals.totalIts)}</td>
                      <td className="px-5 py-3 text-right">
                        <span className="font-bold text-emerald-700">
                          {totals.totalGross > 0 ? `${Math.round((totals.totalNet/totals.totalGross)*100)}%` : '—'}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Composants ────────────────────────────────────────────────────────────────

const COLOR_BG: Record<string, string> = {
  blue: 'bg-blue-50 text-blue-600', orange: 'bg-orange-50 text-orange-600',
  violet: 'bg-violet-50 text-violet-600', teal: 'bg-teal-50 text-teal-600',
  emerald: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600',
  red: 'bg-red-50 text-red-600', rose: 'bg-rose-50 text-rose-600',
}

function KCard({ icon: Icon, color, label, value, sub }: {
  icon: React.ElementType; color: string; label: string; value: string; sub?: string
}) {
  const c = COLOR_BG[color] ?? 'bg-gray-50 text-gray-600'
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-2">
        <p className="text-xs font-medium text-muted-foreground leading-tight">{label}</p>
        <div className={`rounded-xl p-2 ${c}`}><Icon className="h-4 w-4" /></div>
      </div>
      <p className="text-lg font-bold leading-none">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  )
}

function Empty() {
  return <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">Aucune donnée</div>
}
