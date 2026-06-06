import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell, Area, AreaChart,
} from 'recharts'
import {
  AlertTriangle, CheckCircle, XCircle, ClipboardCheck, Download,
  RefreshCw, Users, Shield, ShieldCheck, Smartphone, TrendingUp,
  Settings, FileText, BarChart3,
} from 'lucide-react'

// ── Types ───────────────────────────────────────────────────────────────────

interface Anomalie {
  code: string
  severity: 'bloquant' | 'avertissement'
  categorie: string
  message: string
  employeeId?: string
  employeeName?: string
}

interface EmployeeRow {
  id: string
  nom: string
  prenom: string
  poste: string
  departement: string
  contractType: string
  nniOk: boolean
  cnpsOk: boolean
  smigOk: boolean
  mobileOk: boolean
  mobileProvider: string | null
  netPayable: number | null
  moisRef: string | null
}

interface DeclarationRow {
  trimestre: number
  mois: string
  status: string
  totalCotisations: number
  employeesCount: number
}

interface MensuelRow {
  mois: string
  nb: number
  masse: number
  cnpsSal: number
  cnpsPat: number
  its: number
  net: number
}

interface AuditResult {
  year?: number
  scoreConformite: number
  statut: 'conforme' | 'avertissements' | 'non_conforme'
  auditParams?: Record<string, boolean>
  resume: {
    bloquants: number; avertissements: number; totalEmployes: number
    employesActifs?: number
    nbSansNni?: number; nbSansCnps?: number; nbSousSmig?: number; nbSansMobile?: number
  }
  kpis?: {
    tauxImmatriculation: number; tauxSmig: number; tauxMobile: number
    declarationsSoumises: number; masseSalariale: number
    totalCnpsSal: number; totalCnpsPat: number; totalIts: number
    totalNet: number; nbBulletins: number
  }
  employeur?: { cnpsOk: boolean; dgiOk: boolean; rccmOk: boolean }
  employees?: EmployeeRow[]
  declarations?: DeclarationRow[]
  mensuel?: MensuelRow[]
  mobileMoney?: { provider: string; count: number }[]
  plafonds?: {
    plafondRetraite: number; plafondAtPf: number
    nbAuDessusRetraite: number; nbAuDessusAtPf: number
  }
  smigReference: number
  currency?: string
  anomalies: Anomalie[]
  recommandations: string[]
  generatedAt: string
}

// ── Params par défaut ────────────────────────────────────────────────────────

interface AuditParams {
  year: number
  checkEmployeur: boolean
  checkCnps: boolean
  checkSmig: boolean
  checkDecl: boolean
  checkMobile: boolean
  checkPlafonds: boolean
}

const currentYear = new Date().getFullYear()
const defaultParams: AuditParams = {
  year: currentYear,
  checkEmployeur: true,
  checkCnps: true,
  checkSmig: true,
  checkDecl: true,
  checkMobile: true,
  checkPlafonds: true,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat('fr-CI', { maximumFractionDigits: 0 }).format(n)

const pct = (n: number) => `${n.toFixed(1)} %`

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700"><CheckCircle className="h-3 w-3" />{label}</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"><XCircle className="h-3 w-3" />{label}</span>
}

const STATUS_LABEL_KEY: Record<string, string> = {
  soumise: 'audit.declarationsTab.statusSoumise',
  generee: 'audit.declarationsTab.statusGeneree',
  brouillon: 'audit.declarationsTab.statusBrouillon',
  en_retard: 'audit.declarationsTab.statusEnRetard',
}

function StatusBadge({ status, t }: { status: string; t: TFunction }) {
  const map: Record<string, string> = {
    soumise: 'bg-green-100 text-green-700',
    generee: 'bg-blue-100 text-blue-700',
    brouillon: 'bg-gray-100 text-gray-600',
    en_retard: 'bg-red-100 text-red-700',
  }
  const labelKey = STATUS_LABEL_KEY[status]
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {labelKey ? t(labelKey) : status}
    </span>
  )
}

function KpiCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string; sub?: string; color: string
}) {
  return (
    <div className="rounded-xl border bg-card p-4 flex items-start gap-3">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-bold leading-tight">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'salaries' | 'cotisations' | 'declarations' | 'params'

const TABS: { id: Tab; labelKey: string; icon: React.ElementType }[] = [
  { id: 'overview',      labelKey: 'audit.tabs.overview',     icon: Shield },
  { id: 'salaries',      labelKey: 'audit.tabs.salaries',     icon: Users },
  { id: 'cotisations',   labelKey: 'audit.tabs.cotisations',  icon: BarChart3 },
  { id: 'declarations',  labelKey: 'audit.tabs.declarations', icon: FileText },
  { id: 'params',        labelKey: 'audit.tabs.params',       icon: Settings },
]

// ── Page principale ──────────────────────────────────────────────────────────

export default function CnpsAuditPage() {
  const { t } = useTranslation('cnps')
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [params, setParams] = useState<AuditParams>(defaultParams)
  const [draftParams, setDraftParams] = useState<AuditParams>(defaultParams)

  const { data, isLoading, isFetching, refetch } = useQuery<AuditResult>({
    queryKey: ['cnps-audit', params],
    queryFn: () =>
      api.get('/cnps/audit-conformite', {
        params: {
          year: params.year,
          checkEmployeur: params.checkEmployeur,
          checkCnps: params.checkCnps,
          checkSmig: params.checkSmig,
          checkDecl: params.checkDecl,
          checkMobile: params.checkMobile,
          checkPlafonds: params.checkPlafonds,
        },
      }).then(r => r.data),
    staleTime: 0,
  })

  const score = data?.scoreConformite ?? 0
  const scoreColor =
    score >= 80 ? 'text-green-600' : score >= 50 ? 'text-amber-500' : 'text-red-600'
  const scoreBg =
    score >= 80
      ? 'bg-green-50 border-green-200'
      : score >= 50
      ? 'bg-amber-50 border-amber-200'
      : 'bg-red-50 border-red-200'

  const applyParams = () => setParams(draftParams)

  return (
    <div className="flex flex-col h-full">
      {/* En-tête */}
      <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
        <div className="flex items-center gap-3">
          <ClipboardCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold">{t('audit.title')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('audit.subtitle', { year: params.year })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/cnps/rns/${params.year}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Download className="h-4 w-4" />
            {t('audit.rnsPdf', { year: params.year })}
          </a>
          <a
            href={`/api/cnps/rns/${params.year}/export`}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Download className="h-4 w-4" />
            {t('audit.rnsCsv')}
          </a>
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            {t('audit.refresh')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b bg-card shrink-0 px-6">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4" />
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* Contenu scrollable */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground">
            <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
            {t('audit.analyzing')}
          </div>
        ) : !data ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground">
            {t('audit.noData')}
          </div>
        ) : (
          <div className="p-6 space-y-6">
            {activeTab === 'overview'     && <TabOverview     data={data} scoreColor={scoreColor} scoreBg={scoreBg} score={score} t={t} />}
            {activeTab === 'salaries'     && <TabSalaries     data={data} t={t} />}
            {activeTab === 'cotisations'  && <TabCotisations  data={data} t={t} />}
            {activeTab === 'declarations' && <TabDeclarations data={data} t={t} />}
            {activeTab === 'params'       && (
              <TabParams
                draft={draftParams}
                onChange={setDraftParams}
                onApply={applyParams}
                isFetching={isFetching}
                result={data ?? null}
                t={t}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tab 1 — Vue d'ensemble ───────────────────────────────────────────────────

function TabOverview({ data, scoreColor, scoreBg, score, t }: {
  data: AuditResult; scoreColor: string; scoreBg: string; score: number; t: TFunction
}) {
  const bloquants     = data.anomalies.filter(a => a.severity === 'bloquant')
  const avertissements = data.anomalies.filter(a => a.severity === 'avertissement')

  return (
    <div className="space-y-6">
      {/* Score global */}
      <div className={`rounded-xl border p-6 ${scoreBg}`}>
        <div className="flex items-center gap-6">
          <div className="text-center shrink-0">
            <div className={`text-6xl font-bold leading-none ${scoreColor}`}>{score}</div>
            <div className="text-xs text-muted-foreground mt-1 font-medium">{t('audit.overview.scoreOutOf')}</div>
          </div>
          <div className="w-px h-16 bg-border shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2">
              {data.statut === 'conforme'
                ? <CheckCircle className="h-5 w-5 text-green-600" />
                : <AlertTriangle className="h-5 w-5 text-amber-500" />}
              <span className="font-semibold text-lg">
                {t(`audit.statut.${data.statut}`)}
              </span>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-red-600 font-medium">{t('audit.overview.blockers', { count: data.resume.bloquants })}</span>
              <span className="text-amber-600 font-medium">{t('audit.overview.warnings', { count: data.resume.avertissements })}</span>
              <span className="text-muted-foreground">{t('audit.overview.activeEmployees', { count: data.resume.employesActifs ?? data.resume.totalEmployes })}</span>
              <span className="text-muted-foreground">{t('audit.overview.smig', { value: fmt(data.smigReference) })}</span>
            </div>
          </div>
          {data.kpis && (
            <div className="flex gap-3 shrink-0">
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">{pct(data.kpis.tauxImmatriculation)}</div>
                <div className="text-xs text-muted-foreground">{t('audit.overview.cnpsRegistration')}</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-emerald-600">{pct(data.kpis.tauxSmig)}</div>
                <div className="text-xs text-muted-foreground">{t('audit.overview.smigCompliant')}</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-purple-600">{pct(data.kpis.tauxMobile)}</div>
                <div className="text-xs text-muted-foreground">{t('audit.overview.mobileMoney')}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard icon={Users} label={t('audit.overview.totalEmployees')} value={String(data.resume.totalEmployes)}
          sub={t('audit.overview.withoutNni', { count: data.resume.nbSansNni ?? 0 })} color="bg-blue-100 text-blue-700" />
        <KpiCard icon={TrendingUp} label={t('audit.overview.grossPayroll')}
          value={data.kpis ? `${fmt(data.kpis.masseSalariale)} FCFA` : '—'}
          sub={data.kpis ? t('audit.overview.payslipsCount', { count: data.kpis.nbBulletins }) : undefined}
          color="bg-emerald-100 text-emerald-700" />
        <KpiCard icon={Shield} label={t('audit.overview.cnpsContributions')}
          value={data.kpis ? `${fmt(data.kpis.totalCnpsSal + data.kpis.totalCnpsPat)} FCFA` : '—'}
          sub={data.kpis ? t('audit.overview.cnpsBreakdown', { employee: fmt(data.kpis.totalCnpsSal), employer: fmt(data.kpis.totalCnpsPat) }) : undefined}
          color="bg-orange-100 text-orange-700" />
        <KpiCard icon={FileText} label={t('audit.overview.itsDgi')}
          value={data.kpis ? `${fmt(data.kpis.totalIts)} FCFA` : '—'}
          sub={data.kpis ? t('audit.overview.declarationsSubmitted', { count: data.kpis.declarationsSoumises }) : undefined}
          color="bg-violet-100 text-violet-700" />
      </div>

      {/* Statut employeur */}
      {data.employeur && (
        <div className="rounded-xl border p-4">
          <p className="mb-3 font-semibold">{t('audit.overview.employerStatus')}</p>
          <div className="flex flex-wrap gap-3">
            <Badge ok={data.employeur.cnpsOk} label={t('audit.overview.employerCnps')} />
            <Badge ok={data.employeur.dgiOk}  label={t('audit.overview.employerDgi')} />
            <Badge ok={data.employeur.rccmOk} label={t('audit.overview.employerRccm')} />
          </div>
        </div>
      )}

      {/* Résumé anomalies */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border p-4 text-center">
          <div className="text-3xl font-bold text-red-600">{data.resume.nbSansNni ?? 0}</div>
          <div className="text-sm text-muted-foreground mt-1">{t('audit.overview.withoutNniLabel')}</div>
        </div>
        <div className="rounded-xl border p-4 text-center">
          <div className="text-3xl font-bold text-amber-600">{data.resume.nbSansCnps ?? 0}</div>
          <div className="text-sm text-muted-foreground mt-1">{t('audit.overview.notRegisteredCnps')}</div>
        </div>
        <div className="rounded-xl border p-4 text-center">
          <div className="text-3xl font-bold text-orange-600">{data.resume.nbSousSmig ?? 0}</div>
          <div className="text-sm text-muted-foreground mt-1">{t('audit.overview.belowSmig')}</div>
        </div>
        <div className="rounded-xl border p-4 text-center">
          <div className="text-3xl font-bold text-purple-600">{data.resume.nbSansMobile ?? 0}</div>
          <div className="text-sm text-muted-foreground mt-1">{t('audit.overview.withoutMobile')}</div>
        </div>
      </div>

      {/* Recommandations */}
      {data.recommandations.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-1">
          <p className="font-semibold text-amber-800 mb-2">{t('audit.overview.recommendations')}</p>
          {data.recommandations.map((r, i) => (
            <p key={i} className="text-sm text-amber-800">• {r}</p>
          ))}
        </div>
      )}

      {/* Anomalies bloquantes */}
      {bloquants.length > 0 && (
        <AnomalieSection
          title={t('audit.overview.blockingAnomalies')}
          items={bloquants}
          icon={<XCircle className="h-5 w-5 text-red-500" />}
          badgeClass="bg-red-100 text-red-700"
        />
      )}
      {avertissements.length > 0 && (
        <AnomalieSection
          title={t('audit.overview.warningAnomalies')}
          items={avertissements}
          icon={<AlertTriangle className="h-5 w-5 text-amber-500" />}
          badgeClass="bg-amber-100 text-amber-700"
        />
      )}

      {data.anomalies.length === 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-6">
          <CheckCircle className="h-8 w-8 text-green-600 shrink-0" />
          <div>
            <p className="font-semibold text-green-800">{t('audit.overview.noAnomaliesTitle')}</p>
            <p className="text-sm text-green-700">{t('audit.overview.noAnomaliesSub')}</p>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-right">
        {t('audit.overview.generatedOn', { date: new Date(data.generatedAt).toLocaleString('fr-CI') })}
      </p>
    </div>
  )
}

// ── Tab 2 — Salariés ─────────────────────────────────────────────────────────

function TabSalaries({ data, t }: { data: AuditResult; t: TFunction }) {
  const [search, setSearch] = useState('')
  const [filterIssues, setFilterIssues] = useState(false)

  const rows = (data.employees ?? []).filter(e => {
    const matchSearch = !search || `${e.nom} ${e.prenom} ${e.poste}`.toLowerCase().includes(search.toLowerCase())
    const hasIssue = !e.nniOk || !e.cnpsOk || !e.smigOk || !e.mobileOk
    return matchSearch && (!filterIssues || hasIssue)
  })

  const compliance = (e: EmployeeRow) =>
    [e.nniOk, e.cnpsOk, e.smigOk, e.mobileOk].filter(Boolean).length

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder={t('audit.salaries.searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={filterIssues}
            onChange={e => setFilterIssues(e.target.checked)}
            className="rounded"
          />
          {t('audit.salaries.issuesOnly')}
        </label>
        <span className="text-sm text-muted-foreground">{t('audit.salaries.count', { count: rows.length })}</span>
      </div>

      <div className="rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">{t('audit.salaries.employee')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('audit.salaries.positionDept')}</th>
                <th className="px-4 py-3 text-center font-medium">{t('audit.salaries.nni')}</th>
                <th className="px-4 py-3 text-center font-medium">{t('audit.salaries.cnps')}</th>
                <th className="px-4 py-3 text-center font-medium">{t('audit.salaries.smig')}</th>
                <th className="px-4 py-3 text-center font-medium">{t('audit.salaries.mobile')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('audit.salaries.netRefMonth')}</th>
                <th className="px-4 py-3 text-center font-medium">{t('audit.salaries.score')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map(e => {
                const score = compliance(e)
                const scoreColor =
                  score === 4 ? 'text-green-600' : score >= 2 ? 'text-amber-600' : 'text-red-600'
                return (
                  <tr key={e.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{e.prenom} {e.nom}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      <div>{e.poste}</div>
                      <div>{e.departement}</div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {e.nniOk
                        ? <CheckCircle className="mx-auto h-4 w-4 text-green-600" />
                        : <XCircle   className="mx-auto h-4 w-4 text-red-500" />}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {e.cnpsOk
                        ? <CheckCircle className="mx-auto h-4 w-4 text-green-600" />
                        : <XCircle   className="mx-auto h-4 w-4 text-red-500" />}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {e.smigOk
                        ? <CheckCircle className="mx-auto h-4 w-4 text-green-600" />
                        : <XCircle   className="mx-auto h-4 w-4 text-red-500" />}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {e.mobileOk
                        ? <span className="text-xs font-medium text-green-700">{e.mobileProvider}</span>
                        : <XCircle className="mx-auto h-4 w-4 text-amber-500" />}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {e.netPayable !== null ? `${fmt(e.netPayable)} FCFA` : '—'}
                      {e.moisRef && <div className="text-xs text-muted-foreground">{e.moisRef}</div>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`font-bold ${scoreColor}`}>{t('audit.salaries.scoreValue', { score })}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Tab 3 — Cotisations ──────────────────────────────────────────────────────

function TabCotisations({ data, t }: { data: AuditResult; t: TFunction }) {
  const mensuel = data.mensuel ?? []
  const plafonds = data.plafonds

  // ComposedChart : barres empilées CNPS + ITS, ligne Net
  const composed = mensuel.map(m => ({
    mois:       m.mois.slice(0, 7),
    cnpsSal:    Math.round(m.cnpsSal),
    cnpsPat:    Math.round(m.cnpsPat),
    its:        Math.round(m.its),
    net:        Math.round(m.net),
    masse:      Math.round(m.masse),
    chargeTotal: Math.round(m.cnpsSal + m.cnpsPat + m.its),
  }))

  // Pie répartition dernier mois
  const last = mensuel[mensuel.length - 1]
  const pieData = last ? [
    { name: t('audit.cotisations.netPaid'),      value: Math.round(last.net),    fill: '#10B981' },
    { name: t('audit.cotisations.employeeCnps'), value: Math.round(last.cnpsSal), fill: '#F97316' },
    { name: t('audit.cotisations.employerCnps'), value: Math.round(last.cnpsPat), fill: '#FB923C' },
    { name: t('audit.cotisations.itsDgi'),       value: Math.round(last.its),      fill: '#8B5CF6' },
  ].filter(d => d.value > 0) : []

  // Area charge patronale
  const areaData = composed.map(d => ({
    mois: d.mois,
    employerCharge: d.cnpsPat,
    employeeCharge: d.cnpsSal + d.its,
  }))

  const tickFmt = (v: number) =>
    v >= 1_000_000 ? `${(v/1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v/1_000).toFixed(0)}k` : String(v)

  return (
    <div className="space-y-6">

      {/* Totaux annuels */}
      {data.kpis && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: t('audit.cotisations.employeeCnps'), value: data.kpis.totalCnpsSal, color: 'text-orange-600', bg: 'bg-orange-50 border-orange-200' },
            { label: t('audit.cotisations.employerCnps'), value: data.kpis.totalCnpsPat, color: 'text-amber-600',  bg: 'bg-amber-50 border-amber-200' },
            { label: t('audit.cotisations.itsDgi'),       value: data.kpis.totalIts,      color: 'text-violet-600', bg: 'bg-violet-50 border-violet-200' },
            { label: t('audit.cotisations.netPaid'),      value: data.kpis.totalNet,      color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
          ].map(({ label, value, color, bg }) => (
            <div key={label} className={`rounded-xl border p-4 text-center ${bg}`}>
              <div className={`text-2xl font-bold ${color}`}>{fmt(value)}</div>
              <div className="text-xs text-muted-foreground mt-1 font-medium">{label}</div>
              <div className="text-xs text-muted-foreground">{t('audit.cotisations.annualCumulative')}</div>
            </div>
          ))}
        </div>
      )}

      {/* ComposedChart principal */}
      <div className="rounded-xl border bg-card p-5">
        <div className="mb-1 flex items-start justify-between">
          <div>
            <p className="font-semibold">{t('audit.cotisations.monthlyBreakdownTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('audit.cotisations.monthlyBreakdownSub')}</p>
          </div>
        </div>
        {composed.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={composed} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradNet" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10B981" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="mois" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left"  tick={{ fontSize: 10 }} tickFormatter={tickFmt} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} tickFormatter={tickFmt} />
              <Tooltip
                contentStyle={{ borderRadius: 8, fontSize: 12 }}
                formatter={(v: number, n: string) => [`${fmt(v)} FCFA`, n]}
                labelStyle={{ fontWeight: 700 }}
              />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="left" dataKey="cnpsSal"  name={t('audit.cotisations.employeeCnps')}  stackId="a" fill="#F97316" radius={[0,0,0,0]} />
              <Bar yAxisId="left" dataKey="cnpsPat"  name={t('audit.cotisations.employerCnps')} stackId="a" fill="#FB923C" radius={[0,0,0,0]} />
              <Bar yAxisId="left" dataKey="its"       name={t('audit.cotisations.itsDgi')}    stackId="a" fill="#8B5CF6" radius={[3,3,0,0]} />
              <Line yAxisId="right" type="monotone" dataKey="net"  name={t('audit.cotisations.netPaid')} stroke="#10B981" strokeWidth={2.5} dot={{ r: 4, fill: '#10B981' }} />
              <Line yAxisId="right" type="monotone" dataKey="masse" name={t('audit.cotisations.grossPayroll')} stroke="#4F46E5" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-72 items-center justify-center text-muted-foreground text-sm">
            {t('audit.cotisations.noMonthlyData')}
          </div>
        )}
      </div>

      {/* Deux graphiques côte à côte */}
      <div className="grid gap-6 md:grid-cols-2">

        {/* Répartition coût employeur — Pie */}
        <div className="rounded-xl border bg-card p-5">
          <p className="font-semibold mb-1">{t('audit.cotisations.employerCostTitle')}</p>
          <p className="text-xs text-muted-foreground mb-3">{t('audit.cotisations.lastMonth', { month: last?.mois?.slice(0,7) ?? '—' })}</p>
          {pieData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={68}
                    dataKey="value" paddingAngle={3} label={({ name, percent }) => `${name.split(' ')[0]} ${(percent*100).toFixed(0)}%`}
                    labelLine={false}>
                    {pieData.map((_, i) => <Cell key={i} fill={pieData[i]!.fill} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmt(v) + ' FCFA'} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1.5">
                {pieData.map(d => (
                  <div key={d.name} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: d.fill }} />
                      <span className="text-muted-foreground">{d.name}</span>
                    </span>
                    <span className="font-semibold">{fmt(d.value)} FCFA</span>
                  </div>
                ))}
              </div>
            </>
          ) : <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">{t('audit.cotisations.noData')}</div>}
        </div>

        {/* Charges salariales vs patronales — Area empilée */}
        <div className="rounded-xl border bg-card p-5">
          <p className="font-semibold mb-1">{t('audit.cotisations.chargesTitle')}</p>
          <p className="text-xs text-muted-foreground mb-3">{t('audit.cotisations.chargesSub')}</p>
          {areaData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={areaData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradSal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#F97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#F97316" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradPat" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#4F46E5" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#4F46E5" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="mois" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={tickFmt} />
                <Tooltip formatter={(v: number, n: string) => [`${fmt(v)} FCFA`, n]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="employerCharge" name={t('audit.cotisations.employerCharge')} stroke="#4F46E5" strokeWidth={2} fill="url(#gradPat)" />
                <Area type="monotone" dataKey="employeeCharge" name={t('audit.cotisations.employeeCharge')} stroke="#F97316" strokeWidth={2} fill="url(#gradSal)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">{t('audit.cotisations.noData')}</div>}
        </div>
      </div>

      {/* Analyse plafonds */}
      {plafonds && (
        <div className="rounded-xl border p-4 space-y-3">
          <p className="font-semibold">{t('audit.cotisations.ceilingsTitle')}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              { label: t('audit.cotisations.ceilingRetirement'), value: plafonds.plafondRetraite, nb: plafonds.nbAuDessusRetraite },
              { label: t('audit.cotisations.ceilingAtPf'), value: plafonds.plafondAtPf, nb: plafonds.nbAuDessusAtPf },
            ].map(p => (
              <div key={p.label} className="rounded-lg bg-muted/40 p-3">
                <p className="text-sm font-medium">{p.label}</p>
                <p className="text-xl font-bold mt-1">{fmt(p.value)} FCFA</p>
                <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full rounded-full ${p.nb > 0 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: p.nb > 0 ? '100%' : '0%' }} />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  <span className={p.nb > 0 ? 'text-amber-600 font-semibold' : 'text-emerald-600 font-semibold'}>
                    {t('audit.cotisations.employeesAboveCeiling', { count: p.nb })}
                  </span>{' '}{t('audit.cotisations.aboveCeilingSuffix')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mobile Money */}
      {(data.mobileMoney ?? []).length > 0 && (
        <div className="rounded-xl border p-4">
          <p className="font-semibold mb-3">{t('audit.cotisations.mobileMoneyTitle')}</p>
          <div className="flex flex-wrap gap-3">
            {(data.mobileMoney ?? []).map(m => (
              <div key={m.provider} className="flex items-center gap-2 rounded-lg border px-4 py-2">
                <Smartphone className="h-4 w-4 text-primary" />
                <span className="font-medium capitalize">{m.provider.replace('_', ' ')}</span>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">{m.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab 4 — Déclarations ─────────────────────────────────────────────────────

function TabDeclarations({ data, t }: { data: AuditResult; t: TFunction }) {
  const quarters: { q: number; label: string; items: DeclarationRow[] }[] = [1, 2, 3, 4].map(q => ({
    q,
    label: t('audit.declarationsTab.quarterLabel', { quarter: q, year: data.year ?? new Date().getFullYear() }),
    items: (data.declarations ?? []).filter(d => d.trimestre === q),
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        {quarters.map(({ q, label, items }) => (
          <div key={q} className="rounded-xl border overflow-hidden">
            <div className="border-b bg-muted/50 px-4 py-2 font-medium text-sm">{label}</div>
            {items.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('audit.declarationsTab.none')}</p>
            ) : (
              <div className="divide-y">
                {items.map((d, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{d.mois}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('audit.declarationsTab.employeesAmount', { count: d.employeesCount, amount: fmt(d.totalCotisations) })}
                      </p>
                    </div>
                    <StatusBadge status={d.status} t={t} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
        <p className="font-semibold mb-1">{t('audit.declarationsTab.reminderTitle')}</p>
        <p>• <Trans i18nKey="audit.declarationsTab.reminderMonthly" ns="cnps" components={{ strong: <strong /> }} /></p>
        <p>• <Trans i18nKey="audit.declarationsTab.reminderDisa" ns="cnps" components={{ strong: <strong /> }} /></p>
        <p>• {t('audit.declarationsTab.reminderSanction')}</p>
      </div>
    </div>
  )
}

// ── Tab 5 — Paramètres audit ──────────────────────────────────────────────────

function TabParams({ draft, onChange, onApply, isFetching, result, t }: {
  draft: AuditParams
  onChange: (p: AuditParams) => void
  onApply: () => void
  isFetching: boolean
  result: AuditResult | null
  t: TFunction
}) {
  const toggle = (key: keyof AuditParams) => {
    if (key === 'year') return
    onChange({ ...draft, [key]: !draft[key] })
  }

  const checks: { key: keyof AuditParams; label: string; desc: string }[] = [
    { key: 'checkEmployeur', label: t('audit.params.checkEmployerLabel'), desc: t('audit.params.checkEmployerDesc') },
    { key: 'checkCnps',      label: t('audit.params.checkCnpsLabel'),     desc: t('audit.params.checkCnpsDesc') },
    { key: 'checkSmig',      label: t('audit.params.checkSmigLabel'),     desc: t('audit.params.checkSmigDesc', { value: draft.year >= 2026 ? '75 000' : '60 000' }) },
    { key: 'checkDecl',      label: t('audit.params.checkDeclLabel'),     desc: t('audit.params.checkDeclDesc') },
    { key: 'checkMobile',    label: t('audit.params.checkMobileLabel'),   desc: t('audit.params.checkMobileDesc') },
    { key: 'checkPlafonds',  label: t('audit.params.checkPlafondsLabel'), desc: t('audit.params.checkPlafondsDesc') },
  ]

  const activeChecks = checks.filter(c => draft[c.key] as boolean)
  const score = result?.scoreConformite ?? null
  const scoreColor = score === null ? '' : score >= 80 ? 'text-green-600' : score >= 50 ? 'text-amber-500' : 'text-red-600'
  const scoreBg    = score === null ? '' : score >= 80 ? 'bg-green-50 border-green-200' : score >= 50 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'

  return (
    <div className="flex gap-8 items-start">

      {/* Colonne gauche — Formulaire */}
      <div className="w-80 shrink-0 space-y-5">
        <div className="rounded-xl border p-4 space-y-3">
          <p className="font-semibold text-sm">{t('audit.params.auditYear')}</p>
          <select
            value={draft.year}
            onChange={e => onChange({ ...draft, year: Number(e.target.value) })}
            disabled={isFetching}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          >
            {[currentYear, currentYear - 1, currentYear - 2].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        <div className="rounded-xl border p-4 space-y-3">
          <p className="font-semibold text-sm">{t('audit.params.checksToRun')}</p>
          {checks.map(({ key, label, desc }) => (
            <label key={key} className="flex items-start gap-3 cursor-pointer group select-none">
              <input
                type="checkbox"
                checked={draft[key] as boolean}
                onChange={() => toggle(key)}
                disabled={isFetching}
                className="mt-0.5 rounded accent-primary"
              />
              <div>
                <p className="text-sm font-medium group-hover:text-primary">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </label>
          ))}
        </div>

        <button
          onClick={onApply}
          disabled={isFetching}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60 transition-opacity"
        >
          {isFetching
            ? <><Spiral /> {t('audit.params.analyzing')}</>
            : <><RefreshCw className="h-4 w-4" /> {t('audit.params.runAudit', { count: activeChecks.length })}</>
          }
        </button>
      </div>

      {/* Colonne droite — État / Résultat */}
      <div className="flex-1 min-h-[360px] flex items-center justify-center">
        {isFetching ? (
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="relative h-24 w-24">
              <svg className="animate-spin h-24 w-24" viewBox="0 0 96 96" fill="none">
                <circle cx="48" cy="48" r="40" stroke="hsl(var(--muted))" strokeWidth="6" />
                <path d="M48 8 a40 40 0 0 1 40 40" stroke="hsl(var(--primary))" strokeWidth="6" strokeLinecap="round" />
                <path d="M48 16 a32 32 0 0 1 32 32" stroke="hsl(var(--primary))" strokeWidth="4" strokeLinecap="round" opacity="0.5" />
                <path d="M48 24 a24 24 0 0 1 24 24" stroke="hsl(var(--primary))" strokeWidth="3" strokeLinecap="round" opacity="0.3" />
              </svg>
              <ShieldCheck className="absolute inset-0 m-auto h-8 w-8 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-lg">{t('audit.params.auditInProgress')}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t('audit.params.checkingCriteria', { count: activeChecks.length, year: draft.year })}
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {activeChecks.map(c => (
                  <span key={c.key} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary font-medium">
                    {c.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : result ? (
          <div className={`w-full rounded-2xl border p-6 ${scoreBg}`}>
            <div className="flex items-center gap-4 mb-5">
              <div className="text-center shrink-0">
                <div className={`text-5xl font-black leading-none ${scoreColor}`}>{score}</div>
                <div className="text-xs text-muted-foreground font-medium mt-1">{t('audit.params.scoreOutOf')}</div>
              </div>
              <div>
                <p className="font-bold text-lg">{t(`audit.statut.${result.statut}`)}</p>
                <p className="text-sm text-muted-foreground">{t('audit.params.auditMeta', { year: result.year, date: new Date(result.generatedAt).toLocaleString('fr-CI') })}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {[
                { label: t('audit.params.blockers'),    value: result.resume.bloquants,         color: 'text-red-600 bg-red-50 border-red-200' },
                { label: t('audit.params.warnings'),     value: result.resume.avertissements,    color: 'text-amber-600 bg-amber-50 border-amber-200' },
                { label: t('audit.params.withoutNni'),   value: result.resume.nbSansNni ?? 0,    color: 'text-orange-600 bg-orange-50 border-orange-200' },
                { label: t('audit.params.belowSmig'),    value: result.resume.nbSousSmig ?? 0,   color: 'text-rose-600 bg-rose-50 border-rose-200' },
              ].map(({ label, value, color }) => (
                <div key={label} className={`rounded-xl border p-3 text-center ${color}`}>
                  <div className="text-2xl font-bold">{value}</div>
                  <div className="text-xs mt-0.5 font-medium opacity-80">{label}</div>
                </div>
              ))}
            </div>
            {result.recommandations.length > 0 && (
              <div className="rounded-xl bg-white/60 border border-amber-200 p-3 space-y-1">
                <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">{t('audit.params.recommendations')}</p>
                {result.recommandations.slice(0, 3).map((r, i) => (
                  <p key={i} className="text-xs text-amber-700">· {r}</p>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground text-right mt-3">
              {t('audit.params.seeTabs')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 text-center text-muted-foreground">
            <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center">
              <ShieldCheck className="h-10 w-10 opacity-30" />
            </div>
            <div>
              <p className="font-medium">{t('audit.params.configurePrompt')}</p>
              <p className="text-sm mt-1"><Trans i18nKey="audit.params.configureHint" ns="cnps" components={{ br: <br /> }} /></p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Spiral() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeOpacity="0.3" />
      <path d="M8 2 a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// ── Anomalie section ──────────────────────────────────────────────────────────

function AnomalieSection({ title, items, icon, badgeClass }: {
  title: string
  items: Anomalie[]
  icon: React.ReactNode
  badgeClass: string
}) {
  const categories = [...new Set(items.map(a => a.categorie))]

  return (
    <div className="rounded-xl border">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        {icon}
        <span className="font-semibold">{title}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}>{items.length}</span>
      </div>
      <div className="divide-y">
        {categories.map(cat => (
          <div key={cat} className="px-4 py-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{cat}</p>
            <div className="space-y-1">
              {items.filter(a => a.categorie === cat).map((a, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 shrink-0 text-muted-foreground">·</span>
                  <div>
                    {a.employeeName && <span className="font-medium">{a.employeeName} — </span>}
                    {a.message}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
