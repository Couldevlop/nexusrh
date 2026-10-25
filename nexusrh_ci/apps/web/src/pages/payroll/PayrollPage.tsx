import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { PayrollStatusBadge, PayrollWorkflowModal, formatDateTime, type PendingWith } from './PayrollWorkflowModal'
import {
  Loader2, Lock, Calculator, Download, BookOpen, ShieldAlert, ChevronRight, X, CalendarPlus,
} from 'lucide-react'

interface PayPeriod {
  id: string; month: string; status: string
  total_gross: string; total_net: string; total_cnps: string; total_its: string
  employees_count: string; closed_at: string | null
  initiated_at: string | null; initiated_by: string | null
  rejection_reason: string | null
  pending_with?: PendingWith | null
}

/** « Prénom Nom (fonction) » ou équipe RH : libellé du valideur attendu. */
function pendingWithText(pw: PendingWith | null | undefined, t: TFunction): string {
  if (pw?.name) return t('history.pendingWith', { name: pw.name, fn: pw.functionLabel ?? '' })
  return t('history.pendingWithTeam')
}

/** Message de clôture : « Période 2026-10 en attente de validation de … ». */
function closeMessage(month: string, pw: PendingWith | null | undefined, t: TFunction): string {
  return pw?.name
    ? t('close.pendingWithNamed', { month, name: pw.name, fn: pw.functionLabel ?? '' })
    : t('close.pendingWithTeam', { month })
}

interface LegalEntity { id: string; name: string; city?: string | null; cnps_number?: string | null }

export default function PayrollPage() {
  const { t } = useTranslation('payroll')
  const queryClient = useQueryClient()
  const user = useAuthStore(s => s.user)
  const tenantConfig = useAuthStore(s => s.tenantConfig)
  const hasSubsidiaries = tenantConfig?.hasSubsidiaries === true

  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [selectedEntityId, setSelectedEntityId] = useState<string>('')
  const [closingResult, setClosingResult] = useState<{
    status?: string; message?: string; employeesCount?: number; bulletinsDeSolde?: number
    totals?: Record<string, number>; pendingWith?: PendingWith | null; month?: string
  } | null>(null)
  const [livreYear, setLivreYear] = useState(new Date().getFullYear().toString())
  const [livreLoading, setLivreLoading] = useState(false)
  // « Mes validations » ouvre directement le circuit d'une période : /payroll?validate=AAAA-MM
  const [searchParams, setSearchParams] = useSearchParams()
  const [workflowMonth, setWorkflowMonth] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    const m = searchParams.get('validate')
    if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) setWorkflowMonth(m)
  }, [searchParams])
  const closeWorkflow = () => {
    setWorkflowMonth(null)
    if (searchParams.has('validate')) {
      const next = new URLSearchParams(searchParams)
      next.delete('validate')
      setSearchParams(next, { replace: true })
    }
  }

  // Charge les filiales SEULEMENT si tenant multi-filiales (évite query inutile)
  const { data: entitiesData } = useQuery<{ data: LegalEntity[] }>({
    queryKey: ['legal-entities-for-payroll'],
    queryFn: () => api.get('/settings/legal-entities').then(r => r.data),
    enabled: hasSubsidiaries,
  })
  const legalEntities = entitiesData?.data ?? []

  const { data: periodsData, isLoading } = useQuery<{ data: PayPeriod[] }>({
    queryKey: ['payroll-periods'],
    queryFn: () => api.get('/payroll/periods').then(r => r.data),
  })

  const closeMut = useMutation({
    mutationFn: (month: string) => api.post(`/payroll/periods/${month}/close`,
      hasSubsidiaries && selectedEntityId ? { legalEntityId: selectedEntityId } : {},
    ),
    onSuccess: (res, month) => {
      setNotice(null)
      setClosingResult({
        ...(res.data as {
          status?: string; message?: string; employeesCount?: number; bulletinsDeSolde?: number
          totals?: Record<string, number>; pendingWith?: PendingWith | null
        }),
        month,
      })
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
    },
  })

  // PAY-019 — créer une période au statut 'open' (avant la génération via close).
  const createMut = useMutation({
    mutationFn: (month: string) => api.post(`/payroll/periods/${month}`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payroll-periods'] }),
  })

  const periods = periodsData?.data ?? []

  const exportLivre = async () => {
    setLivreLoading(true)
    try {
      const res = await api.get(`/payroll/livre-de-paie/${livreYear}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([res.data as BlobPart]))
      const a = document.createElement('a')
      a.href = url
      a.download = `livre-de-paie-${livreYear}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setLivreLoading(false)
    }
  }

  const availableMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  const monthIsLocked = (m: string) => periods.some(p => p.month === m && (p.status === 'closed' || p.status === 'pending_validation'))
  const pendingCount = periods.filter(p => p.status === 'pending_validation').length

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('page.subtitle')}
          </p>
        </div>
        {pendingCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <ShieldAlert className="h-4 w-4" />
            <Trans i18nKey="page.pendingBanner" ns="payroll" count={pendingCount} components={{ strong: <strong /> }} />
          </div>
        )}
      </div>

      {notice && (
        <div role="status" className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label={t('workflow.cancel')} className="ml-3 opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Clôture */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <Lock className="h-4 w-4" /> {t('close.title')}
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          <Trans i18nKey="close.intro" ns="payroll" components={{ strong: <strong /> }} />
        </p>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('close.monthLabel')}</label>
            <select
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
            >
              <option value="">{t('close.monthPlaceholder')}</option>
              {availableMonths.map(m => (
                <option key={m} value={m} disabled={monthIsLocked(m)}>
                  {formatMonth(m)}{monthIsLocked(m) ? t('close.monthLocked') : ''}
                </option>
              ))}
            </select>
          </div>

          {hasSubsidiaries && (
            <div>
              <label className="text-sm font-medium mb-1 block">
                {t('close.subsidiaryLabel')} <span className="text-red-500">*</span>
              </label>
              <select
                value={selectedEntityId}
                onChange={e => setSelectedEntityId(e.target.value)}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none min-w-[200px]"
              >
                <option value="">{t('close.subsidiaryPlaceholder')}</option>
                {legalEntities.map(le => (
                  <option key={le.id} value={le.id}>
                    {le.name}{le.city ? ` (${le.city})` : ''}{le.cnps_number ? ` — CNPS ${le.cnps_number}` : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {t('close.subsidiaryHint')}
              </p>
            </div>
          )}

          {/* PAY-019 — créer la période au statut open (si elle n'existe pas encore) */}
          <button
            onClick={() => selectedMonth && createMut.mutate(selectedMonth)}
            disabled={!selectedMonth || createMut.isPending || periods.some(p => p.month === selectedMonth)}
            title={t('create.title', 'Créer la période (statut open)')}
            className="flex items-center gap-2 rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {createMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <CalendarPlus className="h-4 w-4" />
            {t('create.submit', 'Créer la période')}
          </button>

          <button
            onClick={() => selectedMonth && closeMut.mutate(selectedMonth)}
            disabled={!selectedMonth || (hasSubsidiaries && !selectedEntityId) || closeMut.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {closeMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <Lock className="h-4 w-4" />
            {t('close.submit')}
          </button>
        </div>

        {closeMut.isError && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {(closeMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('close.error')}
          </div>
        )}

        {closingResult && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="font-medium text-amber-900 mb-2 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              {closingResult.month
                ? `${closeMessage(closingResult.month, closingResult.pendingWith, t)}. ${t('close.generated', { count: closingResult.employeesCount ?? 0 })}`
                : closingResult.message ?? t('close.resultDefault', { count: closingResult.employeesCount ?? 0 })}
            </p>
            {(closingResult.bulletinsDeSolde ?? 0) > 0 && (
              <p className="mb-2 text-sm text-amber-800">
                {t('close.resultFinalPayslips', { count: closingResult.bulletinsDeSolde })}
              </p>
            )}
            {closingResult.totals && (
              <div className="grid grid-cols-2 gap-2 text-sm text-amber-800">
                <p>{t('close.resultGross')} <strong>{formatFCFA(closingResult.totals['grossSalary'] ?? 0)}</strong></p>
                <p>{t('close.resultNet')} <strong>{formatFCFA(closingResult.totals['netPayable'] ?? 0)}</strong></p>
                <p>{t('close.resultCnps')} <strong>{formatFCFA(closingResult.totals['cnps'] ?? 0)}</strong></p>
                <p>{t('close.resultIts')} <strong>{formatFCFA(closingResult.totals['its'] ?? 0)}</strong></p>
              </div>
            )}
            <p className="mt-2 text-xs text-amber-700">
              {t('close.resultHint')}
            </p>
          </div>
        )}
      </div>

      {/* Livre de paie numérique */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <BookOpen className="h-4 w-4" /> {t('livre.title')}
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          {t('livre.intro')}
        </p>
        <div className="flex items-end gap-3">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('livre.yearLabel')}</label>
            <select value={livreYear} onChange={e => setLivreYear(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              {[0, 1, 2, 3].map(i => {
                const y = (new Date().getFullYear() - i).toString()
                return <option key={y} value={y}>{y}</option>
              })}
            </select>
          </div>
          <button
            onClick={exportLivre}
            disabled={livreLoading}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {livreLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {t('livre.exportCsv')}
          </button>
        </div>
        <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
          <span>{t('livre.feature1')}</span>
          <span>{t('livre.feature2')}</span>
          <span>{t('livre.feature3')}</span>
          <span>{t('livre.feature4')}</span>
        </div>
      </div>

      {/* Historique des périodes */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="font-semibold">{t('history.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('history.hint')}</p>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">{t('history.colPeriod')}</th>
                <th className="p-4 text-right">{t('history.colGross')}</th>
                <th className="p-4 text-right">{t('history.colNet')}</th>
                <th className="p-4 text-right">{t('history.colCnps')}</th>
                <th className="p-4 text-right">{t('history.colIts')}</th>
                <th className="p-4">{t('history.colStatus')}</th>
                <th className="p-4 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {periods.map(p => {
                const isInitiator = p.initiated_by === user?.sub
                const pw = p.pending_with ?? null
                // Indicatif (libellé du bouton) : les droits réels sont calculés par l'API dans la modale.
                const canValidate = !isInitiator && (pw
                  ? pw.userId === user?.sub || (pw.teamCanAct && (user?.role === 'admin' || user?.role === 'hr_manager'))
                  : (user?.role === 'admin' || user?.role === 'hr_manager'))
                return (
                  <tr key={p.id} className="hover:bg-muted/30">
                    <td className="p-4 font-medium capitalize">
                      {formatMonth(p.month)}
                      {p.rejection_reason && (
                        <p className="mt-1 text-xs text-destructive italic">{t('history.rejected', { reason: p.rejection_reason })}</p>
                      )}
                    </td>
                    <td className="p-4 text-right font-mono">{formatFCFA(parseInt(p.total_gross ?? '0'))}</td>
                    <td className="p-4 text-right font-mono">{formatFCFA(parseInt(p.total_net ?? '0'))}</td>
                    <td className="p-4 text-right font-mono text-orange-600">{formatFCFA(parseInt(p.total_cnps ?? '0'))}</td>
                    <td className="p-4 text-right font-mono text-blue-600">{formatFCFA(parseInt(p.total_its ?? '0'))}</td>
                    <td className="p-4">
                      <PayrollStatusBadge status={p.status} />
                      {p.status === 'pending_validation' && (
                        <div className="mt-1 space-y-0.5 text-xs">
                          <p className="font-medium text-amber-900">{pendingWithText(pw, t)}</p>
                          {pw && (
                            <p className="text-muted-foreground">
                              {t('history.levelProgress', { level: pw.level, total: pw.requiredLevels })}
                              {pw.dueAt ? ` · ${t('history.dueAt', { date: formatDateTime(pw.dueAt) })}` : ''}
                            </p>
                          )}
                          {pw?.overdue && <p className="text-red-600">{t('history.overdue')}</p>}
                        </div>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      {p.status === 'pending_validation' && (
                        <button
                          onClick={() => setWorkflowMonth(p.month)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1 text-xs font-medium transition ${
                            canValidate
                              ? 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'
                              : 'border-border text-muted-foreground hover:bg-accent'
                          }`}
                        >
                          {canValidate ? t('history.validate') : t('history.viewWorkflow')}
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      )}
                      {p.status === 'closed' && (
                        <button
                          onClick={() => setWorkflowMonth(p.month)}
                          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                          {t('history.audit')} <ChevronRight className="h-3 w-3" />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {periods.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    <Calculator className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    {t('history.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {workflowMonth && (
        <PayrollWorkflowModal
          target={{ kind: 'single', month: workflowMonth }}
          onClose={closeWorkflow}
          onDone={(message) => { setNotice(message); setClosingResult(null); closeWorkflow() }}
        />
      )}
    </div>
  )
}
