import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  CheckCircle, Clock, AlertCircle, Play, Lock,
  Calendar, Users, TrendingUp, Download, Plus,
  ChevronUp, ChevronDown, Filter, Search, Send,
  FileText, CreditCard, BarChart3, Settings2,
  Eye, RefreshCw, Trash2, Edit3, X, Upload,
  AlertTriangle, Building2, Shield, Zap
} from 'lucide-react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/lib/api'
import { formatCurrency, formatDate, cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PayPeriod {
  id: string
  entityId: string
  entityName?: string
  year: number
  month: number
  status: 'open' | 'calculating' | 'review' | 'validated' | 'closed'
  totalGross: string | null
  totalNet: string | null
  totalEmployerCost: string | null
  paymentDate: string | null
  openedAt: string | null
  closedAt: string | null
  slipCount?: number
}

interface PaySlip {
  id: string
  employeeId: string
  periodId: string
  year: number
  month: number
  grossSalary: string
  netPayable: string
  employerCost: string | null
  status: string
  generatedAt: string | null
  sentAt: string | null
  viewedByEmployeeAt: string | null
  pdfUrl: string | null
  employeeFirstName?: string
  employeeLastName?: string
  jobTitle?: string
  departmentName?: string
}

interface PayrollRule {
  id: string
  entityId: string
  code: string
  label: string
  type: string
  formula: string
  base: string | null
  employeeRate: string | null
  employerRate: string | null
  ceilingSS: string | null
  isActive: boolean
  order: number
  validFrom: string | null
  validUntil: string | null
  legalReference: string | null
  appliesTo: Record<string, unknown>
}

interface VariableElement {
  id: string
  employeeId: string
  periodId: string
  ruleCode: string
  label: string | null
  amount: string | null
  quantity: string | null
  rate: string | null
  note: string | null
  createdAt: string
  employeeFirstName?: string
  employeeLastName?: string
}

interface DashboardData {
  currentPeriod: PayPeriod | null
  kpis: {
    totalGross: number
    totalNet: number
    totalEmployerCost: number
    bulletinCount: number
  }
  evolution: Array<{
    year: number
    month: number
    totalGross: number
    totalNet: number
    totalEmployerCost: number
    slipCount: number
    label: string
  }>
  alerts: {
    dsnDaysLeft: number
    nextDsnDate: string
  }
}

interface ReportingData {
  monthlyEvolution: Array<{
    year: number
    month: number
    totalGross: number
    totalNet: number
    totalEmployerCost: number
    count: number
    label: string
  }>
  byDepartment: Array<{
    deptName: string
    totalGross: number
    count: number
  }>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  open: { label: 'Ouvert', icon: Clock, color: 'bg-gray-100 text-gray-700', dot: 'bg-gray-400' },
  calculating: { label: 'Calcul en cours', icon: Play, color: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
  review: { label: 'En revue', icon: AlertCircle, color: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-500' },
  validated: { label: 'Validé', icon: CheckCircle, color: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  closed: { label: 'Clôturé', icon: Lock, color: 'bg-slate-100 text-slate-600', dot: 'bg-slate-500' },
} as const

type PeriodStatus = keyof typeof STATUS_CONFIG

const SLIP_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft: { label: 'Brouillon', color: 'bg-gray-100 text-gray-600' },
  generated: { label: 'Généré', color: 'bg-blue-100 text-blue-700' },
  sent: { label: 'Envoyé', color: 'bg-yellow-100 text-yellow-700' },
  viewed: { label: 'Vu', color: 'bg-green-100 text-green-700' },
  paid: { label: 'Payé', color: 'bg-emerald-100 text-emerald-700' },
}

const RULE_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  earning: { label: 'Gain', color: 'bg-green-100 text-green-700' },
  deduction: { label: 'Retenue', color: 'bg-red-100 text-red-700' },
  employee_contribution: { label: 'Cotis. salariale', color: 'bg-blue-100 text-blue-700' },
  employer_contribution: { label: 'Cotis. patronale', color: 'bg-purple-100 text-purple-700' },
  information: { label: 'Information', color: 'bg-gray-100 text-gray-600' },
}

const TABS = [
  { id: 'overview', label: 'Aperçu', icon: BarChart3 },
  { id: 'periods', label: 'Périodes', icon: Calendar },
  { id: 'variables', label: 'Éléments variables', icon: Plus },
  { id: 'payslips', label: 'Bulletins', icon: FileText },
  { id: 'rules', label: 'Plan de paie', icon: Settings2 },
  { id: 'dsn', label: 'DSN', icon: Shield },
  { id: 'sepa', label: 'Virements', icon: CreditCard },
  { id: 'reporting', label: 'Reporting', icon: TrendingUp },
] as const

type TabId = typeof TABS[number]['id']

const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
]

// ─── Small reusable components ────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
  loading,
}: {
  label: string
  value: string
  sub?: string
  icon: React.ElementType
  color: string
  loading?: boolean
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      {loading ? (
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-gray-200 rounded w-24" />
          <div className="h-7 bg-gray-300 rounded w-32" />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <div className={`p-2 rounded-lg ${color}`}>
              <Icon className="w-4 h-4" />
            </div>
            <span className="text-sm text-gray-500">{label}</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
        </>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status as PeriodStatus] ?? {
    label: status,
    icon: Clock,
    color: 'bg-gray-100 text-gray-600',
  }
  const Icon = cfg.icon
  return (
    <span className={cn('inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium', cfg.color)}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  )
}

function SlipStatusBadge({ status }: { status: string }) {
  const cfg = SLIP_STATUS_CONFIG[status] ?? { label: status, color: 'bg-gray-100 text-gray-600' }
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium', cfg.color)}>
      {cfg.label}
    </span>
  )
}

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </motion.div>
    </div>
  )
}

// ─── Tab: Overview ────────────────────────────────────────────────────────────

function OverviewTab({ dashboard }: { dashboard: DashboardData | undefined }) {
  const isLoading = !dashboard

  const workflowSteps: Array<{ key: PeriodStatus; label: string; desc: string }> = [
    { key: 'open', label: 'Ouverture', desc: 'Période créée, saisie des variables possible' },
    { key: 'calculating', label: 'Calcul', desc: 'Moteur de paie en cours d\'exécution' },
    { key: 'review', label: 'Revue', desc: 'Vérification des bulletins calculés' },
    { key: 'validated', label: 'Validation', desc: 'Bulletins validés, prêts à envoyer' },
    { key: 'closed', label: 'Clôture', desc: 'Période définitivement clôturée' },
  ]

  const currentStatus = dashboard?.currentPeriod?.status ?? 'open'
  const currentStepIdx = workflowSteps.findIndex((s) => s.key === currentStatus)

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Masse brute"
          value={isLoading ? '—' : formatCurrency(dashboard.kpis.totalGross)}
          icon={TrendingUp}
          color="bg-indigo-100 text-indigo-600"
          loading={isLoading}
        />
        <KpiCard
          label="Net à payer"
          value={isLoading ? '—' : formatCurrency(dashboard.kpis.totalNet)}
          sub="Période courante"
          icon={CreditCard}
          color="bg-emerald-100 text-emerald-600"
          loading={isLoading}
        />
        <KpiCard
          label="Coût employeur"
          value={isLoading ? '—' : formatCurrency(dashboard.kpis.totalEmployerCost)}
          icon={Building2}
          color="bg-purple-100 text-purple-600"
          loading={isLoading}
        />
        <KpiCard
          label="Bulletins générés"
          value={isLoading ? '—' : String(dashboard.kpis.bulletinCount)}
          icon={FileText}
          color="bg-blue-100 text-blue-600"
          loading={isLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Workflow steps */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Zap className="w-4 h-4 text-indigo-500" />
            Workflow période en cours
          </h3>
          <div className="space-y-3">
            {workflowSteps.map((step, i) => {
              const isDone = i < currentStepIdx
              const isCurrent = i === currentStepIdx
              return (
                <div key={step.key} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div
                      className={cn(
                        'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0',
                        isDone ? 'bg-indigo-600 text-white' :
                        isCurrent ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-500' :
                        'bg-gray-100 text-gray-400'
                      )}
                    >
                      {isDone ? <CheckCircle className="w-3.5 h-3.5" /> : i + 1}
                    </div>
                    {i < workflowSteps.length - 1 && (
                      <div className={cn('w-0.5 flex-1 mt-1', isDone ? 'bg-indigo-300' : 'bg-gray-200')} />
                    )}
                  </div>
                  <div className="pb-3">
                    <p className={cn('text-sm font-medium', isCurrent ? 'text-indigo-700' : isDone ? 'text-gray-500 line-through' : 'text-gray-700')}>
                      {step.label}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{step.desc}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Evolution chart */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="font-semibold text-gray-900 mb-4">Évolution masse salariale (6 mois)</h3>
          {isLoading ? (
            <div className="h-40 animate-pulse bg-gray-100 rounded-lg" />
          ) : dashboard.evolution.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-sm text-gray-400">
              Aucune donnée disponible
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={dashboard.evolution} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k€`} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="totalGross" name="Brut" stroke="#6366f1" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="totalNet" name="Net" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="totalEmployerCost" name="Coût emp." stroke="#a855f7" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Alerts + legal */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-500" />
            Alertes et échéances
          </h3>
          <div className="space-y-2.5">
            {dashboard && dashboard.alerts.dsnDaysLeft <= 5 && (
              <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg border border-red-200">
                <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-red-700">DSN urgente</p>
                  <p className="text-xs text-red-600">Échéance dans {dashboard.alerts.dsnDaysLeft} jour(s) — {dashboard.alerts.nextDsnDate}</p>
                </div>
              </div>
            )}
            {dashboard && dashboard.alerts.dsnDaysLeft > 5 && dashboard.alerts.dsnDaysLeft <= 10 && (
              <div className="flex items-start gap-2 p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                <AlertCircle className="w-4 h-4 text-yellow-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-yellow-700">DSN dans {dashboard.alerts.dsnDaysLeft} jours</p>
                  <p className="text-xs text-yellow-600">Préparez votre déclaration nominative sociale</p>
                </div>
              </div>
            )}
            <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
              <Calendar className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-blue-700">Prochaine DSN</p>
                <p className="text-xs text-blue-600">
                  Avant le 5 du mois suivant (≥ 50 sal) ou le 15 (&lt; 50 sal)
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <Shield className="w-4 h-4 text-indigo-500" />
            Rappels légaux 2024
          </h3>
          <div className="space-y-2 text-sm text-gray-600">
            {[
              { label: 'SMIC horaire', value: '11,65 €/h' },
              { label: 'SMIC mensuel 35h', value: '1 766,92 €' },
              { label: 'Plafond SS mensuel', value: '3 864 €' },
              { label: 'CSG déductible', value: '6,80 %' },
              { label: 'CSG non déductible', value: '2,40 %' },
              { label: 'CRDS', value: '0,50 %' },
              { label: 'AGIRC-ARRCO T1 sal.', value: '3,15 %' },
              { label: 'AGIRC-ARRCO T1 pat.', value: '4,72 %' },
            ].map((item) => (
              <div key={item.label} className="flex justify-between py-1 border-b border-gray-100 last:border-0">
                <span className="text-gray-500">{item.label}</span>
                <span className="font-medium text-gray-800">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Tab: Periods ─────────────────────────────────────────────────────────────

function PeriodsTab({
  periods,
  isLoading,
  onCalculateAll,
  onClose,
  onViewPayslips,
  onCreatePeriod,
  onUpdatePaymentDate,
}: {
  periods: PayPeriod[]
  isLoading: boolean
  onCalculateAll: (id: string) => void
  onClose: (id: string) => void
  onViewPayslips: (period: PayPeriod) => void
  onCreatePeriod: () => void
  onUpdatePaymentDate: (id: string, date: string) => void
}) {
  const [editingDate, setEditingDate] = useState<{ id: string; value: string } | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{periods.length} période(s) au total</p>
        <button
          onClick={onCreatePeriod}
          className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nouvelle période
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Période</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Nb sal.</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Masse brute</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Net total</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Coût emp.</th>
              <th className="text-center px-4 py-3 font-semibold text-gray-600">Statut</th>
              <th className="text-center px-4 py-3 font-semibold text-gray-600">Date paiement</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-32" /></td>
                  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-10 ml-auto" /></td>
                  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-24 ml-auto" /></td>
                  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-24 ml-auto" /></td>
                  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-24 ml-auto" /></td>
                  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-20 mx-auto" /></td>
                  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-20 mx-auto" /></td>
                  <td className="px-4 py-3" />
                </tr>
              ))
            ) : periods.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                  <Calendar className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                  Aucune période de paie
                </td>
              </tr>
            ) : (
              periods.map((period) => {
                const label = new Date(period.year, period.month - 1).toLocaleDateString('fr-FR', {
                  month: 'long', year: 'numeric',
                })
                return (
                  <tr key={period.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900 capitalize">{label}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{period.slipCount ?? 0}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {Number(period.totalGross ?? 0) > 0
                        ? formatCurrency(Number(period.totalGross))
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {Number(period.totalNet ?? 0) > 0
                        ? formatCurrency(Number(period.totalNet))
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {Number(period.totalEmployerCost ?? 0) > 0
                        ? formatCurrency(Number(period.totalEmployerCost))
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={period.status} />
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-gray-500">
                      {editingDate?.id === period.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="date"
                            value={editingDate.value}
                            onChange={(e) => setEditingDate({ id: period.id, value: e.target.value })}
                            className="text-xs border border-gray-300 rounded px-1 py-0.5"
                          />
                          <button
                            className="text-indigo-600 hover:text-indigo-800"
                            onClick={() => {
                              onUpdatePaymentDate(period.id, editingDate.value)
                              setEditingDate(null)
                            }}
                          >
                            <CheckCircle className="w-3.5 h-3.5" />
                          </button>
                          <button
                            className="text-gray-400 hover:text-gray-600"
                            onClick={() => setEditingDate(null)}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          className="hover:text-indigo-600 flex items-center gap-1 mx-auto"
                          onClick={() =>
                            setEditingDate({ id: period.id, value: period.paymentDate ?? '' })
                          }
                        >
                          {period.paymentDate ? formatDate(period.paymentDate) : <span className="text-gray-300">—</span>}
                          <Edit3 className="w-3 h-3" />
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => onViewPayslips(period)}
                          className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                          title="Voir les bulletins"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {period.status === 'open' || period.status === 'review' ? (
                          <button
                            onClick={() => onCalculateAll(period.id)}
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Calculer tous les bulletins"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                        ) : null}
                        {(period.status === 'review' || period.status === 'validated') && (
                          <button
                            onClick={() => onClose(period.id)}
                            className="p-1.5 text-gray-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                            title="Clôturer la période"
                          >
                            <Lock className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Tab: Variable Elements ───────────────────────────────────────────────────

function VariablesTab({
  periods,
  variables,
  isLoadingVariables,
  selectedPeriodId,
  onSelectPeriod,
  onDeleteVariable,
}: {
  periods: PayPeriod[]
  variables: VariableElement[]
  isLoadingVariables: boolean
  selectedPeriodId: string
  onSelectPeriod: (id: string) => void
  onDeleteVariable: (id: string) => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [showCsvModal, setShowCsvModal] = useState(false)
  const [selectedVariable, setSelectedVariable] = useState<VariableElement | null>(null)
  const [editForm, setEditForm] = useState({ label: '', amount: '', quantity: '', note: '' })
  const queryClient = useQueryClient()

  const editMutation = useMutation({
    mutationFn: async (body: { id: string; label?: string; amount?: number; quantity?: number; note?: string }) => {
      const { id, ...rest } = body
      const res = await api.put(`/payroll/variable-elements/${id}`, rest)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-variables', selectedPeriodId] })
      setSelectedVariable(null)
    },
  })

  const openEdit = (ve: VariableElement) => {
    setSelectedVariable(ve)
    setEditForm({
      label: ve.label ?? '',
      amount: ve.amount !== undefined && ve.amount !== null ? String(ve.amount) : '',
      quantity: ve.quantity !== undefined && ve.quantity !== null ? String(ve.quantity) : '',
      note: ve.note ?? '',
    })
  }

  const addMutation = useMutation({
    mutationFn: async (body: {
      employeeId: string
      periodId: string
      ruleCode: string
      label: string
      amount?: number
      quantity?: number
      note?: string
    }) => {
      const res = await api.post('/payroll/variable-elements', body)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-variables', selectedPeriodId] })
      setShowAdd(false)
    },
  })

  const [form, setForm] = useState({
    employeeId: '',
    ruleCode: '',
    label: '',
    amount: '',
    quantity: '',
    note: '',
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selectedPeriodId}
          onChange={(e) => onSelectPeriod(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        >
          <option value="">— Sélectionner une période —</option>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {MONTHS_FR[p.month - 1]} {p.year}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowAdd(true)}
          disabled={!selectedPeriodId}
          className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Ajouter un élément
        </button>
        <button
          onClick={() => setShowCsvModal(true)}
          className="flex items-center gap-2 px-3 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Upload className="w-4 h-4" />
          Importer CSV
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Salarié</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Rubrique</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Libellé</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Montant</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Quantité</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Note</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {!selectedPeriodId ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                  <Filter className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                  Sélectionnez une période pour voir les éléments variables
                </td>
              </tr>
            ) : isLoadingVariables ? (
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  {Array.from({ length: 7 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-gray-200 rounded" />
                    </td>
                  ))}
                </tr>
              ))
            ) : variables.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                  Aucun élément variable pour cette période
                </td>
              </tr>
            ) : (
              variables.map((ve) => (
                <tr
                  key={ve.id}
                  className="hover:bg-indigo-50/40 cursor-pointer transition-colors"
                  onClick={() => openEdit(ve)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {ve.employeeFirstName} {ve.employeeLastName}
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-700">{ve.ruleCode}</code>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{ve.label ?? '—'}</td>
                  <td className="px-4 py-3 text-right font-medium">
                    {ve.amount ? formatCurrency(Number(ve.amount)) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{ve.quantity ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{ve.note ?? '—'}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteVariable(ve.id) }}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Ajouter un élément variable">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ID Salarié</label>
            <input
              type="text"
              value={form.employeeId}
              onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
              placeholder="UUID de l'employé"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Code rubrique</label>
            <input
              type="text"
              value={form.ruleCode}
              onChange={(e) => setForm((f) => ({ ...f, ruleCode: e.target.value }))}
              placeholder="Ex: 2100 (HS 25%)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Libellé</label>
            <input
              type="text"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Description"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Montant (€)</label>
              <input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Quantité (h)</label>
              <input
                type="number"
                step="0.5"
                value={form.quantity}
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
            <textarea
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
            >
              Annuler
            </button>
            <button
              onClick={() =>
                addMutation.mutate({
                  employeeId: form.employeeId,
                  periodId: selectedPeriodId,
                  ruleCode: form.ruleCode,
                  label: form.label,
                  amount: form.amount ? Number(form.amount) : undefined,
                  quantity: form.quantity ? Number(form.quantity) : undefined,
                  note: form.note || undefined,
                })
              }
              disabled={!form.employeeId || !form.ruleCode || addMutation.isPending}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {addMutation.isPending ? 'Enregistrement...' : 'Ajouter'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal open={!!selectedVariable} onClose={() => setSelectedVariable(null)} title="Modifier l'élément variable">
        {selectedVariable && (
          <div className="space-y-4">
            <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-500">
              <span className="font-medium">{selectedVariable.employeeFirstName} {selectedVariable.employeeLastName}</span>
              {' — '}
              <code className="bg-white border border-gray-200 px-1.5 py-0.5 rounded">{selectedVariable.ruleCode}</code>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Libellé</label>
              <input
                type="text"
                value={editForm.label}
                onChange={(e) => setEditForm((f) => ({ ...f, label: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Montant (€)</label>
                <input
                  type="number"
                  step="0.01"
                  value={editForm.amount}
                  onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantité (h)</label>
                <input
                  type="number"
                  step="0.5"
                  value={editForm.quantity}
                  onChange={(e) => setEditForm((f) => ({ ...f, quantity: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
              <textarea
                value={editForm.note}
                onChange={(e) => setEditForm((f) => ({ ...f, note: e.target.value }))}
                rows={2}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSelectedVariable(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
              >
                Annuler
              </button>
              <button
                onClick={() =>
                  editMutation.mutate({
                    id: selectedVariable.id,
                    label: editForm.label || undefined,
                    amount: editForm.amount ? Number(editForm.amount) : undefined,
                    quantity: editForm.quantity ? Number(editForm.quantity) : undefined,
                    note: editForm.note || undefined,
                  })
                }
                disabled={editMutation.isPending}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                {editMutation.isPending ? 'Enregistrement...' : 'Enregistrer'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* CSV modal */}
      <Modal open={showCsvModal} onClose={() => setShowCsvModal(false)} title="Importer depuis CSV">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Importez vos éléments variables depuis un fichier CSV. Le fichier doit respecter le format suivant :
          </p>
          <div className="bg-gray-50 rounded-lg p-3 font-mono text-xs text-gray-700">
            employee_id,rule_code,label,amount,quantity,note<br />
            uuid-sal-1,2100,Heures supp.,,,8<br />
            uuid-sal-2,PRIME,Prime exceptionnelle,500,,<br />
          </div>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
            <Upload className="w-8 h-8 mx-auto mb-2 text-gray-400" />
            <p className="text-sm text-gray-500">Glissez votre fichier ici ou cliquez pour sélectionner</p>
            <p className="text-xs text-gray-400 mt-1">Format accepté : .csv (UTF-8)</p>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowCsvModal(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
              Fermer
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ─── Tab: Payslips ────────────────────────────────────────────────────────────

function PayslipsTab({
  periods,
}: {
  periods: PayPeriod[]
}) {
  const [filterPeriodId, setFilterPeriodId] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [search, setSearch] = useState('')
  const queryClient = useQueryClient()

  const { data: slipsData, isLoading } = useQuery<PaySlip[]>({
    queryKey: ['payroll-payslips', filterPeriodId, filterStatus, filterDept, search],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (filterPeriodId) params.set('periodId', filterPeriodId)
      if (filterStatus) params.set('status', filterStatus)
      if (filterDept) params.set('departmentId', filterDept)
      if (search) params.set('search', search)
      const res = await api.get(`/payroll/payslips?${params.toString()}`)
      return res.data.data ?? []
    },
  })

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await api.patch(`/payroll/payslips/${id}`, { status })
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-payslips'] })
    },
  })

  const bulkGenerateMutation = useMutation({
    mutationFn: async (periodId: string) => {
      const res = await api.post('/payroll/payslips/bulk-generate', { periodId })
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-payslips'] })
    },
  })

  const slips = slipsData ?? []

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={filterPeriodId}
          onChange={(e) => setFilterPeriodId(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Toutes les périodes</option>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {MONTHS_FR[p.month - 1]} {p.year}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Tous les statuts</option>
          {Object.entries(SLIP_STATUS_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Rechercher un salarié..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        {filterPeriodId && (
          <button
            onClick={() => bulkGenerateMutation.mutate(filterPeriodId)}
            disabled={bulkGenerateMutation.isPending}
            className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('w-4 h-4', bulkGenerateMutation.isPending && 'animate-spin')} />
            Générer tous les PDFs
          </button>
        )}
        <button className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
          <Download className="w-4 h-4" />
          Exporter Excel
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Salarié</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Période</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Brut</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Net</th>
              <th className="text-center px-4 py-3 font-semibold text-gray-600">Statut</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  {Array.from({ length: 6 }).map((__, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-200 rounded" /></td>
                  ))}
                </tr>
              ))
            ) : slips.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                  <FileText className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                  Aucun bulletin de paie trouvé
                </td>
              </tr>
            ) : (
              slips.map((slip) => {
                const monthLabel = new Date(slip.year, slip.month - 1).toLocaleDateString('fr-FR', {
                  month: 'short', year: 'numeric',
                })
                return (
                  <tr key={slip.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">
                        {slip.employeeFirstName} {slip.employeeLastName}
                      </p>
                      <p className="text-xs text-gray-400">{slip.departmentName}</p>
                    </td>
                    <td className="px-4 py-3 capitalize text-gray-600">{monthLabel}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {formatCurrency(Number(slip.grossSalary))}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-indigo-700">
                      {formatCurrency(Number(slip.netPayable))}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <SlipStatusBadge status={slip.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        {slip.pdfUrl && (
                          <a
                            href={slip.pdfUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg"
                            title="Voir PDF"
                          >
                            <Eye className="w-4 h-4" />
                          </a>
                        )}
                        {slip.status === 'generated' && (
                          <button
                            onClick={() => updateStatusMutation.mutate({ id: slip.id, status: 'sent' })}
                            disabled={updateStatusMutation.isPending}
                            className="p-1.5 text-gray-400 hover:text-yellow-600 hover:bg-yellow-50 rounded-lg"
                            title="Marquer comme envoyé"
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        )}
                        {(slip.status === 'generated' || slip.status === 'sent' || slip.status === 'viewed') && (
                          <button
                            onClick={() => updateStatusMutation.mutate({ id: slip.id, status: 'paid' })}
                            disabled={updateStatusMutation.isPending}
                            className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg"
                            title="Marquer comme payé"
                          >
                            <CheckCircle className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Tab: Payroll Rules ───────────────────────────────────────────────────────

function RulesTab({
  rules,
  isLoading,
  onDelete,
  onMove,
  onToggle,
}: {
  rules: PayrollRule[]
  isLoading: boolean
  onDelete: (id: string) => void
  onMove: (id: string, direction: 'up' | 'down') => void
  onToggle: (rule: PayrollRule) => void
}) {
  const [filterType, setFilterType] = useState('')
  const [filterActive, setFilterActive] = useState('')
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editRule, setEditRule] = useState<PayrollRule | null>(null)
  const queryClient = useQueryClient()

  const filtered = rules.filter((r) => {
    if (filterType && r.type !== filterType) return false
    if (filterActive === 'true' && !r.isActive) return false
    if (filterActive === 'false' && r.isActive) return false
    if (search) {
      const q = search.toLowerCase()
      return r.code.toLowerCase().includes(q) || r.label.toLowerCase().includes(q)
    }
    return true
  })

  const saveMutation = useMutation({
    mutationFn: async (body: Partial<PayrollRule> & { entityId?: string }) => {
      if (body.id) {
        const res = await api.put(`/payroll/rules/${body.id}`, body)
        return res.data
      }
      const res = await api.post('/payroll/rules', body)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-rules'] })
      setShowAdd(false)
      setEditRule(null)
    },
  })

  const emptyForm: Partial<PayrollRule> = {
    code: '', label: '', type: 'earning', formula: '', base: '',
    employeeRate: '', employerRate: '', ceilingSS: '',
    isActive: true, order: 0, validFrom: '', validUntil: '',
    legalReference: '',
  }
  const [form, setForm] = useState<Partial<PayrollRule>>(emptyForm)

  const openAdd = () => { setForm(emptyForm); setShowAdd(true) }
  const openEdit = (r: PayrollRule) => { setForm(r); setEditRule(r); setShowAdd(true) }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Tous les types</option>
          {Object.entries(RULE_TYPE_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <select
          value={filterActive}
          onChange={(e) => setFilterActive(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Actif / Inactif</option>
          <option value="true">Actif uniquement</option>
          <option value="false">Inactif uniquement</option>
        </select>
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Code ou libellé..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          <Plus className="w-4 h-4" />
          Ajouter une rubrique
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-semibold text-gray-600 w-12">Ord.</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Code</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Libellé</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Type</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Formule</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Taux sal.</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Taux pat.</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Réf. légale</th>
              <th className="text-center px-4 py-3 font-semibold text-gray-600">Actif</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  {Array.from({ length: 10 }).map((__, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-200 rounded" /></td>
                  ))}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-gray-400">
                  <Settings2 className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                  Aucune rubrique trouvée
                </td>
              </tr>
            ) : (
              filtered.map((rule, idx) => {
                const typeCfg = RULE_TYPE_CONFIG[rule.type] ?? { label: rule.type, color: 'bg-gray-100 text-gray-600' }
                return (
                  <tr key={rule.id} className={cn('hover:bg-gray-50/50', !rule.isActive && 'opacity-50')}>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      <div className="flex flex-col gap-0.5">
                        <button
                          onClick={() => onMove(rule.id, 'up')}
                          disabled={idx === 0}
                          className="hover:text-gray-700 disabled:opacity-30"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onMove(rule.id, 'down')}
                          disabled={idx === filtered.length - 1}
                          className="hover:text-gray-700 disabled:opacity-30"
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{rule.code}</code>
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{rule.label}</td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex px-2 py-0.5 rounded-full text-xs font-medium', typeCfg.color)}>
                        {typeCfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-40 truncate">
                      <code className="text-xs text-gray-500">{rule.formula}</code>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {rule.employeeRate ? `${(Number(rule.employeeRate) * 100).toFixed(2)} %` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {rule.employerRate ? `${(Number(rule.employerRate) * 100).toFixed(2)} %` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 max-w-32 truncate">
                      {rule.legalReference ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => onToggle(rule)}
                        className={cn(
                          'w-10 h-5 rounded-full transition-colors relative',
                          rule.isActive ? 'bg-indigo-600' : 'bg-gray-300'
                        )}
                      >
                        <span
                          className={cn(
                            'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                            rule.isActive ? 'left-5.5 translate-x-0.5' : 'left-0.5'
                          )}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end">
                        <button
                          onClick={() => openEdit(rule)}
                          className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDelete(rule.id)}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add/Edit rule modal */}
      <Modal
        open={showAdd}
        onClose={() => { setShowAdd(false); setEditRule(null) }}
        title={editRule ? 'Modifier la rubrique' : 'Ajouter une rubrique'}
      >
        <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Code *</label>
              <input
                type="text"
                value={form.code ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Type *</label>
              <select
                value={form.type ?? 'earning'}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              >
                {Object.entries(RULE_TYPE_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Libellé *</label>
            <input
              type="text"
              value={form.label ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Formule *</label>
            <input
              type="text"
              value={form.formula ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, formula: e.target.value }))}
              placeholder="Ex: BRUT * 0.069"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Taux salarié</label>
              <input
                type="number"
                step="0.000001"
                value={form.employeeRate ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, employeeRate: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Taux patronal</label>
              <input
                type="number"
                step="0.000001"
                value={form.employerRate ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, employerRate: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Valide à partir de</label>
              <input
                type="date"
                value={form.validFrom ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Valide jusqu'au</label>
              <input
                type="date"
                value={form.validUntil ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Référence légale</label>
            <input
              type="text"
              value={form.legalReference ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, legalReference: e.target.value }))}
              placeholder="Ex: Art. L242-1 CSS"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              checked={form.isActive ?? true}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="isActive" className="text-sm text-gray-700">Rubrique active</label>
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-4 pt-4 border-t border-gray-100">
          <button
            onClick={() => { setShowAdd(false); setEditRule(null) }}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            Annuler
          </button>
          <button
            onClick={() => saveMutation.mutate(form as PayrollRule)}
            disabled={!form.code || !form.label || !form.formula || saveMutation.isPending}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Enregistrement...' : editRule ? 'Mettre à jour' : 'Créer'}
          </button>
        </div>
      </Modal>
    </div>
  )
}

// ─── Tab: DSN ─────────────────────────────────────────────────────────────────

function DsnTab({ periods }: { periods: PayPeriod[] }) {
  const [selectedPeriodId, setSelectedPeriodId] = useState('')

  const { data: periodDetail, isLoading } = useQuery<{ period: PayPeriod; slips: PaySlip[] }>({
    queryKey: ['payroll-period-detail', selectedPeriodId],
    enabled: !!selectedPeriodId,
    queryFn: async () => {
      const res = await api.get(`/payroll/periods/${selectedPeriodId}`)
      return res.data.data
    },
  })

  const handleDownloadDsn = () => {
    window.open(`${import.meta.env.VITE_API_URL ?? ''}/api/payroll/dsn/${selectedPeriodId}`, '_blank')
  }

  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={selectedPeriodId}
          onChange={(e) => setSelectedPeriodId(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">— Sélectionner une période —</option>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {MONTHS_FR[p.month - 1]} {p.year}
            </option>
          ))}
        </select>
        {selectedPeriodId && (
          <button
            onClick={handleDownloadDsn}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
          >
            <Download className="w-4 h-4" />
            Télécharger DSN
          </button>
        )}
      </div>

      {selectedPeriod && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-indigo-500" />
              Employeur
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Raison sociale</span>
                <span className="font-medium">{selectedPeriod.entityName ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Période</span>
                <span className="font-medium">
                  {MONTHS_FR[(selectedPeriod.month - 1)]} {selectedPeriod.year}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Nb salariés</span>
                <span className="font-medium">{periodDetail?.slips.length ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Masse brute</span>
                <span className="font-medium">
                  {selectedPeriod.totalGross
                    ? formatCurrency(Number(selectedPeriod.totalGross))
                    : '—'}
                </span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Salariés déclarés</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600">Salarié</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600">Brut</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600">Net imposable</th>
                    <th className="text-center px-4 py-2 text-xs font-semibold text-gray-600">Statut DSN</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {isLoading ? (
                    Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        {Array.from({ length: 4 }).map((__, j) => (
                          <td key={j} className="px-4 py-2"><div className="h-4 bg-gray-200 rounded" /></td>
                        ))}
                      </tr>
                    ))
                  ) : (periodDetail?.slips ?? []).map((slip) => (
                    <tr key={slip.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-2 font-medium text-gray-900">
                        {slip.employeeFirstName} {slip.employeeLastName}
                      </td>
                      <td className="px-4 py-2 text-right">{formatCurrency(Number(slip.grossSalary))}</td>
                      <td className="px-4 py-2 text-right">{formatCurrency(Number(slip.netPayable))}</td>
                      <td className="px-4 py-2 text-center">
                        <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-700">
                          À envoyer
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {!selectedPeriodId && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <Shield className="w-12 h-12 mb-3 text-gray-300" />
          <p className="text-sm">Sélectionnez une période pour voir les données DSN</p>
        </div>
      )}
    </div>
  )
}

// ─── Tab: SEPA ────────────────────────────────────────────────────────────────

function SepaTab({ periods }: { periods: PayPeriod[] }) {
  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [emailRecipients, setEmailRecipients] = useState('')
  const [emailMessage, setEmailMessage] = useState('')
  const [reportType, setReportType] = useState<'journal' | 'sepa' | 'both'>('both')
  const [sendingEmail, setSendingEmail] = useState(false)
  const [emailResult, setEmailResult] = useState<{ success: boolean; message: string } | null>(null)

  const { data: periodDetail, isLoading } = useQuery<{ period: PayPeriod; slips: PaySlip[] }>({
    queryKey: ['payroll-period-detail-sepa', selectedPeriodId],
    enabled: !!selectedPeriodId,
    queryFn: async () => {
      const res = await api.get(`/payroll/periods/${selectedPeriodId}`)
      return res.data.data
    },
  })

  const handleDownloadSepa = () => {
    window.open(`${import.meta.env.VITE_API_URL ?? ''}/api/payroll/sepa/${selectedPeriodId}`, '_blank')
  }

  const handleSendEmail = async () => {
    const recipients = emailRecipients.split(/[,;\n]/).map((r) => r.trim()).filter(Boolean)
    if (!recipients.length) { alert('Veuillez saisir au moins un destinataire.'); return }
    setSendingEmail(true)
    setEmailResult(null)
    try {
      const res = await api.post('/payroll/send-report', {
        periodId: selectedPeriodId,
        recipients,
        reportType,
        message: emailMessage || undefined,
      })
      setEmailResult({ success: true, message: res.data.message })
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } }
      setEmailResult({ success: false, message: error.response?.data?.error ?? 'Échec de l\'envoi' })
    } finally {
      setSendingEmail(false)
    }
  }

  const slips = periodDetail?.slips ?? []
  const totalNet = slips.reduce((a, s) => a + Number(s.netPayable), 0)
  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId)

  function maskIban(raw: string | null | undefined) {
    if (!raw) return null
    const clean = raw.replace(/\s/g, '')
    if (clean.length < 8) return raw
    return clean.slice(0, 4) + ' **** **** **** ' + clean.slice(-4)
  }

  const monthLabel = selectedPeriod
    ? `${MONTHS_FR[selectedPeriod.month - 1]} ${selectedPeriod.year}`
    : ''

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={selectedPeriodId}
          onChange={(e) => setSelectedPeriodId(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">— Sélectionner une période —</option>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {MONTHS_FR[p.month - 1]} {p.year}
            </option>
          ))}
        </select>
        {selectedPeriodId && (
          <>
            <button
              onClick={handleDownloadSepa}
              className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
            >
              <Download className="w-4 h-4" />
              Fichier SEPA
            </button>
            <button
              onClick={() => { setShowEmailModal(true); setEmailResult(null) }}
              className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700"
            >
              <Send className="w-4 h-4" />
              Envoyer par email
            </button>
          </>
        )}
      </div>

      {/* Email modal */}
      {showEmailModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <div>
                <h3 className="text-base font-bold text-gray-900">Envoyer le rapport de paie</h3>
                <p className="text-xs text-gray-500 mt-0.5">Période : {monthLabel}</p>
              </div>
              <button onClick={() => setShowEmailModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1.5">
                  Destinataires <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={emailRecipients}
                  onChange={(e) => setEmailRecipients(e.target.value)}
                  placeholder={'compta@entreprise.com\nbanque@bnpparibas.fr\ndaf@entreprise.com'}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <p className="text-xs text-gray-400 mt-1">Séparez les adresses par une virgule, point-virgule ou retour à la ligne.</p>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1.5">Documents à joindre</label>
                <div className="flex gap-2">
                  {([
                    { id: 'journal' as const, label: '📄 Journal de paie (PDF)' },
                    { id: 'sepa' as const,    label: '🏦 Fichier SEPA (XML)' },
                    { id: 'both' as const,    label: '📦 Les deux' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => setReportType(opt.id)}
                      className={cn(
                        'flex-1 px-2 py-2 rounded-lg border text-xs font-medium transition-all',
                        reportType === opt.id
                          ? 'border-green-500 bg-green-50 text-green-700'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1.5">Message personnalisé (optionnel)</label>
                <textarea
                  value={emailMessage}
                  onChange={(e) => setEmailMessage(e.target.value)}
                  placeholder="Veuillez trouver ci-joint les documents de paie pour le mois de..."
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>

              {emailResult && (
                <div className={cn(
                  'flex items-start gap-2 p-3 rounded-xl text-sm border',
                  emailResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
                )}>
                  <CheckCircle className={cn('w-4 h-4 flex-shrink-0 mt-0.5', emailResult.success ? 'text-green-600' : 'text-red-600')} />
                  <span className={cn('text-xs', emailResult.success ? 'text-green-800' : 'text-red-800')}>{emailResult.message}</span>
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  onClick={handleSendEmail}
                  disabled={sendingEmail || !emailRecipients.trim()}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white text-sm font-semibold rounded-xl hover:bg-green-700 disabled:opacity-60 transition-colors"
                >
                  {sendingEmail ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {sendingEmail ? 'Envoi en cours…' : 'Envoyer maintenant'}
                </button>
                <button
                  onClick={() => setShowEmailModal(false)}
                  className="px-4 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-xl hover:bg-gray-50"
                >
                  Fermer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


      {selectedPeriodId && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
              <p className="text-xs text-gray-400 mb-1">Nb virements</p>
              <p className="text-2xl font-bold text-gray-900">{slips.length}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
              <p className="text-xs text-gray-400 mb-1">Montant total</p>
              <p className="text-2xl font-bold text-indigo-700">{formatCurrency(totalNet)}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
              <p className="text-xs text-gray-400 mb-1">Date virement</p>
              <p className="text-lg font-bold text-gray-900">
                {selectedPeriod?.paymentDate ? formatDate(selectedPeriod.paymentDate) : '—'}
              </p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Salarié</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">IBAN</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">Net à payer</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600">Statut</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      {Array.from({ length: 4 }).map((__, j) => (
                        <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-200 rounded" /></td>
                      ))}
                    </tr>
                  ))
                ) : slips.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-gray-400">
                      Aucun bulletin pour cette période
                    </td>
                  </tr>
                ) : (
                  slips.map((slip) => (
                    <tr key={slip.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {slip.employeeFirstName} {slip.employeeLastName}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">
                        {maskIban('FR7630006000011234567890189') ?? (
                          <span className="flex items-center gap-1 text-red-500">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            IBAN manquant
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-gray-900">
                        {formatCurrency(Number(slip.netPayable))}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-700">
                          En attente
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!selectedPeriodId && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <CreditCard className="w-12 h-12 mb-3 text-gray-300" />
          <p className="text-sm">Sélectionnez une période pour préparer les virements SEPA</p>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Reporting ───────────────────────────────────────────────────────────

function ReportingTab() {
  const { data: reportingData, isLoading } = useQuery<ReportingData>({
    queryKey: ['payroll-reporting'],
    queryFn: async () => {
      const res = await api.get('/payroll/reporting')
      return res.data.data
    },
  })

  const monthlyEvolution = reportingData?.monthlyEvolution ?? []
  const byDepartment = reportingData?.byDepartment ?? []

  const avgGross =
    monthlyEvolution.length > 0 && monthlyEvolution[monthlyEvolution.length - 1]
      ? monthlyEvolution[monthlyEvolution.length - 1]!.count > 0
        ? monthlyEvolution[monthlyEvolution.length - 1]!.totalGross /
          monthlyEvolution[monthlyEvolution.length - 1]!.count
        : 0
      : 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-900">Rapport paie — 12 derniers mois</h3>
        <button className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
          <Download className="w-4 h-4" />
          Exporter Excel
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-400 mb-1">Brut moyen / salarié</p>
          <p className="text-xl font-bold text-gray-900">
            {isLoading ? '—' : formatCurrency(avgGross)}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-400 mb-1">Taux charges patronales</p>
          <p className="text-xl font-bold text-gray-900">~42,5 %</p>
          <p className="text-xs text-gray-400">estimation SYNTEC</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-400 mb-1">Période analysées</p>
          <p className="text-xl font-bold text-gray-900">{monthlyEvolution.length}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h4 className="font-semibold text-gray-800 mb-4">Évolution masse salariale (12 mois)</h4>
        {isLoading ? (
          <div className="h-56 animate-pulse bg-gray-100 rounded-lg" />
        ) : monthlyEvolution.length === 0 ? (
          <div className="h-56 flex items-center justify-center text-sm text-gray-400">
            Aucune donnée disponible
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={monthlyEvolution} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k€`} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="totalGross" name="Brut total" stroke="#6366f1" strokeWidth={2.5} />
              <Line type="monotone" dataKey="totalNet" name="Net total" stroke="#10b981" strokeWidth={2.5} />
              <Line type="monotone" dataKey="totalEmployerCost" name="Coût employeur" stroke="#a855f7" strokeWidth={1.5} strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h4 className="font-semibold text-gray-800 mb-4">Répartition par département (masse brute cumulée)</h4>
        {isLoading ? (
          <div className="h-56 animate-pulse bg-gray-100 rounded-lg" />
        ) : byDepartment.length === 0 ? (
          <div className="h-56 flex items-center justify-center text-sm text-gray-400">
            Aucune donnée disponible
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={byDepartment} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="deptName" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k€`} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="totalGross" name="Masse brute" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h4 className="font-semibold text-gray-800">Journal de paie mensuel</h4>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Mois</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Effectif payé</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Brut total</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Net total</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Coût employeur</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    {Array.from({ length: 5 }).map((__, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-200 rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : monthlyEvolution.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">Aucune donnée</td>
                </tr>
              ) : (
                monthlyEvolution.map((row) => (
                  <tr key={`${row.year}-${row.month}`} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-medium text-gray-900 capitalize">{row.label}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{row.count}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatCurrency(row.totalGross)}</td>
                    <td className="px-4 py-3 text-right font-medium text-indigo-700">{formatCurrency(row.totalNet)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatCurrency(row.totalEmployerCost)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function PayrollPage() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [showCreatePeriod, setShowCreatePeriod] = useState(false)
  const [createPeriodForm, setCreatePeriodForm] = useState({ entityId: '', year: new Date().getFullYear(), month: new Date().getMonth() + 1 })
  const [selectedVariablePeriodId, setSelectedVariablePeriodId] = useState('')
  const [viewingPeriod, setViewingPeriod] = useState<PayPeriod | null>(null)

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: legalEntitiesData } = useQuery<{ data: { id: string; name: string; siret?: string }[] }>({
    queryKey: ['legal-entities'],
    queryFn: async () => (await api.get('/payroll/legal-entities')).data,
    staleTime: 5 * 60 * 1000,
  })
  const legalEntities = legalEntitiesData?.data ?? []

  const { data: dashboard } = useQuery<DashboardData>({
    queryKey: ['payroll-dashboard'],
    queryFn: async () => {
      const res = await api.get('/payroll/dashboard')
      return res.data.data
    },
  })

  const { data: periods = [], isLoading: periodsLoading } = useQuery<PayPeriod[]>({
    queryKey: ['payroll-periods'],
    queryFn: async () => {
      const res = await api.get('/payroll/periods')
      return res.data.data ?? []
    },
  })

  const { data: rules = [], isLoading: rulesLoading } = useQuery<PayrollRule[]>({
    queryKey: ['payroll-rules'],
    queryFn: async () => {
      const res = await api.get('/payroll/rules')
      return res.data.data ?? []
    },
  })

  const { data: variables = [], isLoading: variablesLoading } = useQuery<VariableElement[]>({
    queryKey: ['payroll-variables', selectedVariablePeriodId],
    enabled: !!selectedVariablePeriodId,
    queryFn: async () => {
      const res = await api.get(`/payroll/variable-elements?periodId=${selectedVariablePeriodId}`)
      return res.data.data ?? []
    },
  })

  // ── Mutations ──────────────────────────────────────────────────────────────

  const calculateAllMutation = useMutation({
    mutationFn: async (periodId: string) => {
      const res = await api.post(`/payroll/periods/${periodId}/calculate-all`)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
      queryClient.invalidateQueries({ queryKey: ['payroll-dashboard'] })
    },
  })

  const closePeriodMutation = useMutation({
    mutationFn: async (periodId: string) => {
      const res = await api.patch(`/payroll/periods/${periodId}`, { status: 'closed' })
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
      queryClient.invalidateQueries({ queryKey: ['payroll-dashboard'] })
    },
  })

  const updatePaymentDateMutation = useMutation({
    mutationFn: async ({ id, paymentDate }: { id: string; paymentDate: string }) => {
      const res = await api.patch(`/payroll/periods/${id}`, { paymentDate })
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
    },
  })

  const createPeriodMutation = useMutation({
    mutationFn: async (body: { entityId: string; year: number; month: number }) => {
      const res = await api.post('/payroll/periods', body)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
      setShowCreatePeriod(false)
    },
  })

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.delete(`/payroll/rules/${id}`)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-rules'] })
    },
  })

  const updateRuleMutation = useMutation({
    mutationFn: async (rule: Partial<PayrollRule> & { id: string }) => {
      const res = await api.put(`/payroll/rules/${rule.id}`, rule)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-rules'] })
    },
  })

  const deleteVariableMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.delete(`/payroll/variable-elements/${id}`)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-variables', selectedVariablePeriodId] })
    },
  })

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleMoveRule = useCallback((id: string, direction: 'up' | 'down') => {
    const idx = rules.findIndex((r) => r.id === id)
    if (idx < 0) return
    const newOrder = direction === 'up' ? rules[idx]!.order - 1 : rules[idx]!.order + 1
    updateRuleMutation.mutate({ id, order: newOrder })
  }, [rules, updateRuleMutation])

  const handleToggleRule = useCallback((rule: PayrollRule) => {
    updateRuleMutation.mutate({ id: rule.id, isActive: !rule.isActive })
  }, [updateRuleMutation])

  // ── Redirect if viewing period payslips ───────────────────────────────────

  const handleViewPayslips = (period: PayPeriod) => {
    setViewingPeriod(period)
    setActiveTab('payslips')
  }

  return (
    <div className="p-6 max-w-[1400px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Gestion de la paie</h1>
          <p className="text-sm text-gray-500 mt-1">
            Bulletins de salaire, DSN, virements SEPA et reporting
          </p>
        </div>
        {dashboard?.currentPeriod && (
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-2.5 shadow-sm">
            <div className={cn('w-2 h-2 rounded-full', STATUS_CONFIG[dashboard.currentPeriod.status as PeriodStatus]?.dot ?? 'bg-gray-400')} />
            <div>
              <p className="text-xs text-gray-400">Période en cours</p>
              <p className="text-sm font-semibold text-gray-900 capitalize">
                {new Date(dashboard.currentPeriod.year, dashboard.currentPeriod.month - 1)
                  .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors',
                  isActive
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                )}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === 'overview' && <OverviewTab dashboard={dashboard} />}

          {activeTab === 'periods' && (
            <PeriodsTab
              periods={periods}
              isLoading={periodsLoading}
              onCalculateAll={(id) => calculateAllMutation.mutate(id)}
              onClose={(id) => closePeriodMutation.mutate(id)}
              onViewPayslips={handleViewPayslips}
              onCreatePeriod={() => {
                setCreatePeriodForm((f) => ({
                  ...f,
                  entityId: f.entityId || legalEntities[0]?.id || '',
                }))
                setShowCreatePeriod(true)
              }}
              onUpdatePaymentDate={(id, date) =>
                updatePaymentDateMutation.mutate({ id, paymentDate: date })
              }
            />
          )}

          {activeTab === 'variables' && (
            <VariablesTab
              periods={periods}
              variables={variables}
              isLoadingVariables={variablesLoading}
              selectedPeriodId={selectedVariablePeriodId}
              onSelectPeriod={setSelectedVariablePeriodId}
              onDeleteVariable={(id) => deleteVariableMutation.mutate(id)}
            />
          )}

          {activeTab === 'payslips' && (
            <PayslipsTab periods={periods} />
          )}

          {activeTab === 'rules' && (
            <RulesTab
              rules={rules}
              isLoading={rulesLoading}
              onDelete={(id) => deleteRuleMutation.mutate(id)}
              onMove={handleMoveRule}
              onToggle={handleToggleRule}
            />
          )}

          {activeTab === 'dsn' && <DsnTab periods={periods} />}

          {activeTab === 'sepa' && <SepaTab periods={periods} />}

          {activeTab === 'reporting' && <ReportingTab />}
        </motion.div>
      </AnimatePresence>

      {/* Create period modal */}
      <Modal
        open={showCreatePeriod}
        onClose={() => setShowCreatePeriod(false)}
        title="Créer une nouvelle période"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Entité juridique</label>
            <select
              value={createPeriodForm.entityId}
              onChange={(e) => setCreatePeriodForm((f) => ({ ...f, entityId: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">-- Sélectionner une entité --</option>
              {legalEntities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}{e.siret ? ` — ${e.siret}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Année</label>
              <input
                type="number"
                value={createPeriodForm.year}
                onChange={(e) => setCreatePeriodForm((f) => ({ ...f, year: Number(e.target.value) }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mois</label>
              <select
                value={createPeriodForm.month}
                onChange={(e) => setCreatePeriodForm((f) => ({ ...f, month: Number(e.target.value) }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              >
                {MONTHS_FR.map((m, i) => (
                  <option key={i} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowCreatePeriod(false)}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
            >
              Annuler
            </button>
            <button
              onClick={() => createPeriodMutation.mutate(createPeriodForm)}
              disabled={!createPeriodForm.entityId || createPeriodMutation.isPending}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {createPeriodMutation.isPending ? 'Création...' : 'Créer la période'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
