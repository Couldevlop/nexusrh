import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import {
  Users, CreditCard, FileText, AlertCircle, TrendingUp,
  ArrowUpRight, ArrowDownRight, Download, Printer,
  Briefcase, ShieldCheck, Calendar, Activity,
} from 'lucide-react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell,
  AreaChart, Area,
} from 'recharts'

// ── Types ────────────────────────────────────────────────────────────────────

interface PayPeriod {
  month: string
  total_gross: string
  total_net: string
  total_cnps: string
  total_its?: string
  employee_count?: number
}

interface Employee {
  id: string
  department?: string
  is_active: boolean
  gross_salary?: string
}

interface AbsenceToday {
  id: string
  employee_name?: string
  type?: string
}

// ── Export helpers ────────────────────────────────────────────────────────────

function downloadCSV(rows: (string | number)[][], filename: string) {
  const csv = rows.map(r => r.join(';')).join('\n')
  const bom = '﻿'
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
}

// ── Couleurs ──────────────────────────────────────────────────────────────────

const PALETTE = ['#4F46E5', '#F97316', '#10B981', '#8B5CF6', '#EF4444', '#0EA5E9', '#F59E0B']

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const user = useAuthStore(s => s.user)
  const tenantConfig = useAuthStore(s => s.tenantConfig)
  const printRef = useRef<HTMLDivElement>(null)

  const { data: periodsData } = useQuery<{ data: PayPeriod[] }>({
    queryKey: ['payroll-periods'],
    queryFn: () => api.get('/payroll/periods').then(r => r.data),
  })

  const { data: empsData } = useQuery<{ data: Employee[] }>({
    queryKey: ['employees-active'],
    queryFn: () => api.get('/employees?isActive=true&limit=500').then(r => r.data),
  })

  const { data: absData } = useQuery<{ data: AbsenceToday[] }>({
    queryKey: ['absences-today'],
    queryFn: () => api.get('/absences?status=approved&today=true').then(r => r.data).catch(() => ({ data: [] })),
  })

  const periods  = periodsData?.data ?? []
  const employees = empsData?.data ?? []
  const absToday  = absData?.data ?? []

  const last    = periods[0]
  const prev    = periods[1]
  const grossLast = parseInt(last?.total_gross ?? '0')
  const grossPrev = parseInt(prev?.total_gross ?? '0')
  const trend     = grossPrev > 0 ? ((grossLast - grossPrev) / grossPrev) * 100 : 0

  // Répartition par département
  const deptMap: Record<string, number> = {}
  employees.forEach(e => {
    const d = e.department ?? 'Autre'
    deptMap[d] = (deptMap[d] ?? 0) + 1
  })
  const deptData = Object.entries(deptMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, value], i) => ({ name, value, fill: PALETTE[i % PALETTE.length] }))

  // Données graphique 6 mois
  const chartData = [...periods].reverse().slice(-6).map(p => ({
    mois:  formatMonth(p.month).slice(0, 3),
    brut:  Math.round(parseInt(p.total_gross ?? '0') / 1_000),
    net:   Math.round(parseInt(p.total_net   ?? '0') / 1_000),
    cnps:  Math.round(parseInt(p.total_cnps  ?? '0') / 1_000),
    its:   Math.round(parseInt(p.total_its   ?? '0') / 1_000),
    nb:    p.employee_count ?? 0,
  }))

  // Distribution masse salariale
  const paiePie = [
    { name: 'Net versé',   value: parseInt(last?.total_net ?? '0'),  fill: '#10B981' },
    { name: 'CNPS total',  value: parseInt(last?.total_cnps ?? '0'), fill: '#F97316' },
    { name: 'ITS / DGI',  value: parseInt(last?.total_its  ?? '0'), fill: '#8B5CF6' },
  ].filter(d => d.value > 0)

  // Conformité radiale (fictif si pas d'audit)
  const conformiteData = [
    { name: 'CNPS', value: 85, fill: '#F97316' },
    { name: 'SMIG', value: 97, fill: '#10B981' },
    { name: 'Mobile', value: 78, fill: '#4F46E5' },
  ]

  const roleLabel: Record<string, string> = {
    admin: 'Administrateur', hr_manager: 'Responsable RH',
    hr_officer: 'Chargé RH', manager: 'Manager', readonly: 'Lecture seule',
  }

  // ── Exports ────────────────────────────────────────────────────────────────

  const handleExportXLSX = () => {
    const header = ['Période', 'Brut (FCFA)', 'Net (FCFA)', 'CNPS (FCFA)', 'ITS (FCFA)', 'Nb employés']
    const rows = periods.slice(0, 12).map(p => [
      formatMonth(p.month),
      parseInt(p.total_gross ?? '0'),
      parseInt(p.total_net ?? '0'),
      parseInt(p.total_cnps ?? '0'),
      parseInt(p.total_its ?? '0'),
      p.employee_count ?? 0,
    ])
    const deptHeader = ['Département', 'Effectifs']
    const deptRows = deptData.map(d => [d.name, d.value])
    downloadCSV(
      [['=== TABLEAU DE BORD RH ==='], [`Société : ${tenantConfig?.name ?? ''}`],
       [`Exporté le : ${new Date().toLocaleDateString('fr-CI')}`], [],
       header, ...rows, [], deptHeader, ...deptRows],
      `nexusrh-dashboard-${new Date().toISOString().slice(0, 10)}.csv`
    )
  }

  const handlePrint = () => window.print()

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* CSS print */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          #dashboard-print { display: block !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div id="dashboard-print" ref={printRef} className="p-6 space-y-6 bg-background min-h-full">

        {/* ── En-tête ──────────────────────────────────────────── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Tableau de bord</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {tenantConfig?.name ?? 'NexusRH CI'} · {roleLabel[user?.role ?? ''] ?? user?.role}
              · {new Date().toLocaleDateString('fr-CI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          </div>
          <div className="no-print flex items-center gap-2">
            <button onClick={handleExportXLSX}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted">
              <Download className="h-4 w-4 text-green-600" /> Excel
            </button>
            <button onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted">
              <Printer className="h-4 w-4 text-red-500" /> PDF
            </button>
          </div>
        </div>

        {/* ── KPI Cards ────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Effectifs actifs"
            value={employees.length > 0 ? String(employees.length) : '—'}
            icon={Users} color="blue"
            sub={`${deptData.length} départements`}
          />
          <KpiCard
            label="Masse salariale"
            value={grossLast > 0 ? formatFCFA(grossLast) : '—'}
            icon={CreditCard} color="orange"
            trend={trend}
            sub={last ? formatMonth(last.month) : undefined}
          />
          <KpiCard
            label="Cotisations CNPS"
            value={formatFCFA(parseInt(last?.total_cnps ?? '0'))}
            icon={ShieldCheck} color="emerald"
            sub="Mois en cours"
          />
          <KpiCard
            label="Absences aujourd'hui"
            value={String(absToday.length)}
            icon={Calendar} color="red"
            sub={absToday.length > 0 ? `${absToday.length} employé(s) absent(s)` : 'Aucune absence'}
          />
          <KpiCard
            label="ITS / DGI"
            value={formatFCFA(parseInt(last?.total_its ?? '0'))}
            icon={FileText} color="violet"
            sub="Retenues du mois"
          />
          <KpiCard
            label="Net total versé"
            value={formatFCFA(parseInt(last?.total_net ?? '0'))}
            icon={Activity} color="teal"
            sub="Salaires nets mois"
          />
          <KpiCard
            label="Bulletins générés"
            value={periods.length > 0 ? String(periods.reduce((s, p) => s + (p.employee_count ?? 0), 0)) : '—'}
            icon={Briefcase} color="amber"
            sub={`sur ${periods.length} période(s)`}
          />
          <KpiCard
            label="Tendance salariale"
            value={trend !== 0 ? `${trend > 0 ? '+' : ''}${trend.toFixed(1)} %` : '—'}
            icon={TrendingUp} color={trend >= 0 ? 'green' : 'red'}
            sub="vs mois précédent"
          />
        </div>

        {/* ── Graphiques ligne 1 ───────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-3">

          {/* ComposedChart masse salariale */}
          <div className="lg:col-span-2 rounded-2xl border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold">Évolution masse salariale</h2>
                <p className="text-xs text-muted-foreground">6 derniers mois · en milliers FCFA</p>
              </div>
            </div>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="mois" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 10 }}
                    tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}M` : `${v}k`} />
                  <Tooltip
                    contentStyle={{ borderRadius: 8, fontSize: 12 }}
                    formatter={(v: number, n: string) => [`${v.toLocaleString('fr-CI')} k FCFA`, n]}
                  />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="brut" name="Brut" fill="#4F46E5" radius={[3,3,0,0]} />
                  <Bar dataKey="net"  name="Net"  fill="#10B981" radius={[3,3,0,0]} />
                  <Line dataKey="cnps" name="CNPS" stroke="#F97316" strokeWidth={2} dot={{ r: 3 }} type="monotone" />
                  <Line dataKey="its"  name="ITS"  stroke="#8B5CF6" strokeWidth={2} dot={{ r: 3 }} strokeDasharray="4 2" type="monotone" />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-60 items-center justify-center text-muted-foreground text-sm">Aucune donnée</div>
            )}
          </div>

          {/* Répartition masse salariale (Pie) */}
          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Répartition coût employeur</h2>
            <p className="text-xs text-muted-foreground mb-4">Dernier mois clos</p>
            {paiePie.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie data={paiePie} cx="50%" cy="50%" innerRadius={45} outerRadius={70}
                      dataKey="value" paddingAngle={3}>
                      {paiePie.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                    </Pie>
                    <Tooltip formatter={(v: number) => formatFCFA(v)} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2 mt-2">
                  {paiePie.map(d => (
                    <div key={d.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: d.fill }} />
                        <span className="text-muted-foreground">{d.name}</span>
                      </div>
                      <span className="font-medium">{formatFCFA(d.value)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">Aucune donnée</div>
            )}
          </div>
        </div>

        {/* ── Graphiques ligne 2 ───────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-3">

          {/* Effectifs par département */}
          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Effectifs par département</h2>
            <p className="text-xs text-muted-foreground mb-4">{employees.length} employés actifs</p>
            {deptData.length > 0 ? (
              <div className="space-y-3">
                {deptData.map(d => (
                  <div key={d.name}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="truncate text-muted-foreground">{d.name}</span>
                      <span className="font-semibold ml-2 shrink-0">{d.value}</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.round((d.value / employees.length) * 100)}%`,
                          background: d.fill,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">Aucune donnée</div>
            )}
          </div>

          {/* Évolution effectifs (Area) */}
          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Bulletins / Effectifs</h2>
            <p className="text-xs text-muted-foreground mb-4">6 derniers mois</p>
            {chartData.some(d => d.nb > 0) ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradNb" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#4F46E5" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#4F46E5" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="mois" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="nb" name="Employés" stroke="#4F46E5" strokeWidth={2} fill="url(#gradNb)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">Données indisponibles</div>
            )}
          </div>

          {/* Indicateurs CNPS — barres circulaires */}
          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Indicateurs CNPS</h2>
            <p className="text-xs text-muted-foreground mb-4">Taux de conformité estimés</p>
            <div className="space-y-4">
              {conformiteData.map(d => (
                <div key={d.name}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-medium">{d.name}</span>
                    <span className="text-sm font-bold" style={{ color: d.fill }}>{d.value}%</span>
                  </div>
                  <div className="h-3 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${d.value}%`, background: d.fill }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Basé sur le dernier audit · <a href="/cnps/audit" className="text-primary hover:underline">Voir l'audit complet →</a>
            </p>
          </div>
        </div>

        {/* ── Tableau périodes ─────────────────────────────────── */}
        {periods.length > 0 && (
          <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div>
                <h2 className="font-semibold">Périodes de paie</h2>
                <p className="text-xs text-muted-foreground">{periods.length} période(s) disponibles</p>
              </div>
              <button onClick={handleExportXLSX}
                className="no-print flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border rounded-lg px-3 py-1.5">
                <Download className="h-3.5 w-3.5" /> Exporter
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 text-left text-xs text-muted-foreground uppercase tracking-wide">
                    <th className="px-5 py-3">Période</th>
                    <th className="px-5 py-3 text-right">Brut</th>
                    <th className="px-5 py-3 text-right">Net versé</th>
                    <th className="px-5 py-3 text-right">CNPS</th>
                    <th className="px-5 py-3 text-right">ITS/DGI</th>
                    <th className="px-5 py-3 text-right">Charge pat.</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {periods.slice(0, 8).map((p, i) => {
                    const brut = parseInt(p.total_gross ?? '0')
                    const net  = parseInt(p.total_net ?? '0')
                    const cnps = parseInt(p.total_cnps ?? '0')
                    const its  = parseInt(p.total_its ?? '0')
                    const charge = cnps + its
                    const netRatio = brut > 0 ? Math.round((net / brut) * 100) : 0
                    return (
                      <tr key={p.month} className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                        <td className="px-5 py-3 font-medium capitalize">{formatMonth(p.month)}</td>
                        <td className="px-5 py-3 text-right font-mono">{formatFCFA(brut)}</td>
                        <td className="px-5 py-3 text-right">
                          <span className="font-mono text-emerald-700">{formatFCFA(net)}</span>
                          <span className="ml-1.5 text-xs text-muted-foreground">({netRatio}%)</span>
                        </td>
                        <td className="px-5 py-3 text-right font-mono text-orange-600">{formatFCFA(cnps)}</td>
                        <td className="px-5 py-3 text-right font-mono text-violet-600">{formatFCFA(its)}</td>
                        <td className="px-5 py-3 text-right font-mono text-muted-foreground">{formatFCFA(charge)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Alertes ──────────────────────────────────────────── */}
        <div className="grid gap-4 md:grid-cols-2">
          <AlertCard
            color="orange"
            icon={AlertCircle}
            title="Déclaration CNPS mensuelle"
            text="Dépôt e-CNPS avant le 15 du mois suivant. Vérifiez l'onglet CNPS & DISA."
          />
          <AlertCard
            color="blue"
            icon={ShieldCheck}
            title="DISA annuelle"
            text="La Déclaration Individuelle des Salaires est due avant le 31 janvier N+1."
          />
        </div>

      </div>
    </>
  )
}

// ── Composants ───────────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, { bg: string; text: string; icon: string }> = {
  blue:    { bg: 'bg-blue-50',    text: 'text-blue-700',    icon: 'text-blue-500' },
  orange:  { bg: 'bg-orange-50',  text: 'text-orange-700',  icon: 'text-orange-500' },
  emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', icon: 'text-emerald-500' },
  red:     { bg: 'bg-red-50',     text: 'text-red-700',     icon: 'text-red-500' },
  violet:  { bg: 'bg-violet-50',  text: 'text-violet-700',  icon: 'text-violet-500' },
  teal:    { bg: 'bg-teal-50',    text: 'text-teal-700',    icon: 'text-teal-500' },
  amber:   { bg: 'bg-amber-50',   text: 'text-amber-700',   icon: 'text-amber-500' },
  green:   { bg: 'bg-green-50',   text: 'text-green-700',   icon: 'text-green-500' },
}

function KpiCard({ label, value, icon: Icon, color, trend, sub }: {
  label: string; value: string; icon: React.ElementType
  color: string; trend?: number; sub?: string
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP['blue']!
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-medium text-muted-foreground leading-tight">{label}</p>
        <div className={`rounded-xl p-2 ${c.bg}`}>
          <Icon className={`h-4 w-4 ${c.icon}`} />
        </div>
      </div>
      <p className={`text-xl font-bold ${c.text} leading-none`}>{value}</p>
      <div className="mt-2 flex items-center gap-1.5">
        {trend !== undefined && Math.abs(trend) > 0.1 && (
          trend > 0
            ? <ArrowUpRight className="h-3.5 w-3.5 text-emerald-500" />
            : <ArrowDownRight className="h-3.5 w-3.5 text-red-400" />
        )}
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </div>
    </div>
  )
}

function AlertCard({ color, icon: Icon, title, text }: {
  color: 'orange' | 'blue'; icon: React.ElementType; title: string; text: string
}) {
  const c = color === 'orange'
    ? { border: 'border-orange-200', bg: 'bg-orange-50', title: 'text-orange-800', body: 'text-orange-600', icon: 'text-orange-500' }
    : { border: 'border-blue-200',   bg: 'bg-blue-50',   title: 'text-blue-800',   body: 'text-blue-600',   icon: 'text-blue-500' }
  return (
    <div className={`rounded-2xl border ${c.border} ${c.bg} p-4 flex items-start gap-3`}>
      <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${c.icon}`} />
      <div>
        <p className={`text-sm font-semibold ${c.title}`}>{title}</p>
        <p className={`text-xs mt-0.5 ${c.body}`}>{text}</p>
      </div>
    </div>
  )
}
