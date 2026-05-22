import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import {
  Loader2, Lock, Calculator, Download, BookOpen, CheckCircle2, XCircle,
  Clock, Shield, ShieldAlert, Users, AlertCircle, ChevronRight, X
} from 'lucide-react'

interface PayPeriod {
  id: string; month: string; status: string
  total_gross: string; total_net: string; total_cnps: string; total_its: string
  employees_count: string; closed_at: string | null
  initiated_at: string | null; initiated_by: string | null
  rejection_reason: string | null
}

interface WorkflowApproval {
  level: number
  approverId: string
  approverRole: string | null
  approverName: string | null
  approvedAt: string
  notes: string | null
}

interface WorkflowState {
  period: { id: string; month: string; status: string; initiatedBy: string | null; initiatedAt: string | null; initiatorName: string | null }
  requiredLevels: number
  currentLevel: number
  isComplete: boolean
  approvals: WorkflowApproval[]
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; Icon: typeof Lock }> = {
    open: { label: 'Ouverte', cls: 'bg-gray-100 text-gray-700', Icon: Clock },
    pending_validation: { label: 'En validation', cls: 'bg-amber-100 text-amber-800', Icon: ShieldAlert },
    closed: { label: 'Clôturée', cls: 'bg-green-100 text-green-700', Icon: CheckCircle2 },
  }
  const cfg = map[status] ?? map.open
  const { Icon, label, cls } = cfg!
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon className="h-3 w-3" /> {label}
    </span>
  )
}

function WorkflowModal({ month, onClose }: { month: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const user = useAuthStore(s => s.user)
  const [notes, setNotes] = useState('')
  const [rejectMode, setRejectMode] = useState(false)
  const [reason, setReason] = useState('')

  const { data, isLoading } = useQuery<WorkflowState>({
    queryKey: ['payroll-workflow', month],
    queryFn: () => api.get(`/payroll/periods/${month}/workflow`).then(r => r.data as WorkflowState),
  })

  const approveMut = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${month}/approve`, { notes: notes || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-workflow', month] })
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
      setNotes('')
    },
  })

  const rejectMut = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${month}/reject`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-workflow', month] })
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
      setRejectMode(false); setReason('')
      onClose()
    },
  })

  const canActOnRole = user?.role === 'admin' || user?.role === 'hr_manager'
  const isInitiator = data?.period.initiatedBy === user?.sub
  const alreadyApproved = data?.approvals.some(a => a.approverId === user?.sub) ?? false
  const periodStatus = data?.period.status
  const canApprove = canActOnRole && !isInitiator && !alreadyApproved && periodStatus === 'pending_validation'
  const canReject = canActOnRole && !isInitiator && periodStatus === 'pending_validation'

  const approveError = (approveMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error
  const rejectError = (rejectMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Workflow de validation — {formatMonth(month)}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Séparation des tâches (SOX/SoD) · L'initiateur ne peut pas s'auto-approuver
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {isLoading || !data ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Statut global */}
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Statut actuel</p>
                  <div className="mt-1"><StatusBadge status={data.period.status} /></div>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Niveaux requis</p>
                  <p className="text-xl font-bold text-primary">{data.currentLevel} / {data.requiredLevels}</p>
                </div>
              </div>
              {/* Barre de progression */}
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.min(100, (data.currentLevel / Math.max(1, data.requiredLevels)) * 100)}%` }}
                />
              </div>
            </div>

            {/* Timeline */}
            <div>
              <h4 className="mb-3 text-sm font-semibold">Timeline</h4>
              <ol className="space-y-3">
                {/* Étape 0 : Initiation */}
                <li className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Users className="h-4 w-4" />
                  </div>
                  <div className="flex-1 rounded-lg border border-border bg-card p-3">
                    <p className="text-sm font-medium">Clôture initiée</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {data.period.initiatorName ?? (data.period.initiatedBy ? `Utilisateur ${data.period.initiatedBy.slice(0, 8)}` : 'Inconnu')}
                      {' · '}
                      {data.period.initiatedAt ? new Date(data.period.initiatedAt).toLocaleString('fr-FR') : '—'}
                    </p>
                  </div>
                </li>

                {/* Approbations */}
                {data.approvals.map(a => (
                  <li key={a.level} className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
                      <CheckCircle2 className="h-4 w-4" />
                    </div>
                    <div className="flex-1 rounded-lg border border-green-200 bg-green-50 p-3">
                      <p className="text-sm font-medium text-green-900">Niveau {a.level} approuvé</p>
                      <p className="text-xs text-green-700 mt-0.5">
                        {a.approverName ?? `Utilisateur ${a.approverId.slice(0, 8)}`}
                        {a.approverRole ? ` (${a.approverRole})` : ''}
                        {' · '}
                        {new Date(a.approvedAt).toLocaleString('fr-FR')}
                      </p>
                      {a.notes && <p className="mt-1 text-xs italic text-green-800">"{a.notes}"</p>}
                    </div>
                  </li>
                ))}

                {/* Niveaux restants */}
                {!data.isComplete && Array.from({ length: data.requiredLevels - data.currentLevel }).map((_, i) => (
                  <li key={`pending-${i}`} className="flex gap-3 opacity-60">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 bg-card">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 rounded-lg border border-dashed border-border p-3">
                      <p className="text-sm text-muted-foreground">Niveau {data.currentLevel + i + 1} en attente</p>
                    </div>
                  </li>
                ))}

                {/* Clôture finale */}
                {data.isComplete && (
                  <li className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-600 text-white">
                      <Lock className="h-4 w-4" />
                    </div>
                    <div className="flex-1 rounded-lg border border-green-300 bg-green-100 p-3">
                      <p className="text-sm font-semibold text-green-900">Période clôturée définitivement</p>
                    </div>
                  </li>
                )}
              </ol>
            </div>

            {/* Bandeau SoD */}
            {periodStatus === 'pending_validation' && (isInitiator || alreadyApproved || !canActOnRole) && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  {!canActOnRole && <p>Votre rôle ne permet pas la validation paie (admin ou hr_manager requis).</p>}
                  {isInitiator && <p>Vous avez initié cette clôture — un autre approbateur doit valider (séparation des tâches).</p>}
                  {alreadyApproved && <p>Vous avez déjà approuvé un niveau — un autre approbateur doit prendre le relais.</p>}
                </div>
              </div>
            )}

            {/* Actions */}
            {periodStatus === 'pending_validation' && canActOnRole && !isInitiator && !alreadyApproved && !rejectMode && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
                <label className="block text-xs font-medium">Notes (optionnel)</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Vérifié les totaux, conforme au mois précédent…"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
                />
                {approveError && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {approveError}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => approveMut.mutate()}
                    disabled={approveMut.isPending}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {approveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Approuver le niveau {data.currentLevel + 1}
                  </button>
                  <button
                    onClick={() => setRejectMode(true)}
                    className="flex items-center gap-2 rounded-lg border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
                  >
                    <XCircle className="h-4 w-4" /> Rejeter
                  </button>
                </div>
              </div>
            )}

            {/* Mode rejet */}
            {rejectMode && (
              <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <label className="block text-xs font-medium text-destructive">Motif du rejet (obligatoire, min. 5 caractères)</label>
                <textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  placeholder="Ex : écart inexpliqué sur la CNPS retraite, à recalculer…"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
                />
                {rejectError && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {rejectError}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => rejectMut.mutate()}
                    disabled={rejectMut.isPending || reason.trim().length < 5}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {rejectMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                    Confirmer le rejet (réouvre la période)
                  </button>
                  <button
                    onClick={() => { setRejectMode(false); setReason('') }}
                    className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            )}

            {/* Rejet précédent */}
            {data.period.status === 'open' && (
              <RejectionHistoryBanner month={month} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function RejectionHistoryBanner({ month: _month }: { month: string }) {
  // L'API renvoie rejection_reason sur pay_periods. On l'affiche si présent.
  // Note : le bandeau est géré côté liste (period.rejection_reason), pas besoin ici.
  return null
}

interface LegalEntity { id: string; name: string; city?: string | null; cnps_number?: string | null }

export default function PayrollPage() {
  const queryClient = useQueryClient()
  const user = useAuthStore(s => s.user)
  const tenantConfig = useAuthStore(s => s.tenantConfig)
  const hasSubsidiaries = tenantConfig?.hasSubsidiaries === true

  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [selectedEntityId, setSelectedEntityId] = useState<string>('')
  const [closingResult, setClosingResult] = useState<{
    status?: string; message?: string; employeesCount?: number; totals?: Record<string, number>
  } | null>(null)
  const [livreYear, setLivreYear] = useState(new Date().getFullYear().toString())
  const [livreLoading, setLivreLoading] = useState(false)
  const [workflowMonth, setWorkflowMonth] = useState<string | null>(null)

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
    onSuccess: (res) => {
      setClosingResult(res.data as { status?: string; message?: string; employeesCount?: number; totals?: Record<string, number> })
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
    },
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
          <h1 className="text-2xl font-bold">Paie CI — Clôture mensuelle</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Moteur CNPS 2024 + ITS/DGI · Devise : FCFA (XOF) · Workflow paramétrable (SoD)
          </p>
        </div>
        {pendingCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <ShieldAlert className="h-4 w-4" />
            <strong>{pendingCount}</strong> période{pendingCount > 1 ? 's' : ''} en attente de validation
          </div>
        )}
      </div>

      {/* Clôture */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <Lock className="h-4 w-4" /> Initier la clôture d'une période
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          La clôture passe d'abord en <strong>« En validation »</strong>. Un autre approbateur (admin / hr_manager)
          doit confirmer pour finaliser la période (séparation des tâches obligatoire).
        </p>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-sm font-medium mb-1 block">Mois à clôturer</label>
            <select
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
            >
              <option value="">-- Sélectionner --</option>
              {availableMonths.map(m => (
                <option key={m} value={m} disabled={monthIsLocked(m)}>
                  {formatMonth(m)}{monthIsLocked(m) ? ' (verrouillée)' : ''}
                </option>
              ))}
            </select>
          </div>

          {hasSubsidiaries && (
            <div>
              <label className="text-sm font-medium mb-1 block">
                Filiale <span className="text-red-500">*</span>
              </label>
              <select
                value={selectedEntityId}
                onChange={e => setSelectedEntityId(e.target.value)}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none min-w-[200px]"
              >
                <option value="">-- Sélectionner une filiale --</option>
                {legalEntities.map(le => (
                  <option key={le.id} value={le.id}>
                    {le.name}{le.city ? ` (${le.city})` : ''}{le.cnps_number ? ` — CNPS ${le.cnps_number}` : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Chaque filiale a son numéro CNPS → clôture distincte
              </p>
            </div>
          )}

          <button
            onClick={() => selectedMonth && closeMut.mutate(selectedMonth)}
            disabled={!selectedMonth || (hasSubsidiaries && !selectedEntityId) || closeMut.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {closeMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <Lock className="h-4 w-4" />
            Initier la clôture
          </button>
        </div>

        {closeMut.isError && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {(closeMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Erreur lors de la clôture'}
          </div>
        )}

        {closingResult && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="font-medium text-amber-900 mb-2 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              {closingResult.message ?? `Période en attente de validation — ${closingResult.employeesCount ?? 0} bulletins générés`}
            </p>
            {closingResult.totals && (
              <div className="grid grid-cols-2 gap-2 text-sm text-amber-800">
                <p>Masse brute : <strong>{formatFCFA(closingResult.totals['grossSalary'] ?? 0)}</strong></p>
                <p>Net à payer : <strong>{formatFCFA(closingResult.totals['netPayable'] ?? 0)}</strong></p>
                <p>CNPS : <strong>{formatFCFA(closingResult.totals['cnps'] ?? 0)}</strong></p>
                <p>ITS : <strong>{formatFCFA(closingResult.totals['its'] ?? 0)}</strong></p>
              </div>
            )}
            <p className="mt-2 text-xs text-amber-700">
              → Demandez à un autre admin/hr_manager de valider depuis le tableau ci-dessous.
            </p>
          </div>
        )}
      </div>

      {/* Livre de paie numérique */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <BookOpen className="h-4 w-4" /> Livre de paie numérique
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Export CSV format Inspection du Travail CI — récapitulatif annuel de tous les bulletins.
        </p>
        <div className="flex items-end gap-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Année</label>
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
            Exporter CSV
          </button>
        </div>
        <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
          <span>• 20 colonnes règlementaires</span>
          <span>• Totaux mensuels inclus</span>
          <span>• En-tête employeur (CNPS, RCCM)</span>
          <span>• Encodage UTF-8</span>
        </div>
      </div>

      {/* Historique des périodes */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="font-semibold">Historique des périodes</h2>
          <p className="text-xs text-muted-foreground">Cliquez sur une période en validation pour voir le workflow</p>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">Période</th>
                <th className="p-4 text-right">Brut total</th>
                <th className="p-4 text-right">Net total</th>
                <th className="p-4 text-right">CNPS total</th>
                <th className="p-4 text-right">ITS total</th>
                <th className="p-4">Statut</th>
                <th className="p-4 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {periods.map(p => {
                const isInitiator = p.initiated_by === user?.sub
                const canValidate = (user?.role === 'admin' || user?.role === 'hr_manager') && !isInitiator
                return (
                  <tr key={p.id} className="hover:bg-muted/30">
                    <td className="p-4 font-medium capitalize">
                      {formatMonth(p.month)}
                      {p.rejection_reason && (
                        <p className="mt-1 text-xs text-destructive italic">Rejetée : « {p.rejection_reason} »</p>
                      )}
                    </td>
                    <td className="p-4 text-right font-mono">{formatFCFA(parseInt(p.total_gross ?? '0'))}</td>
                    <td className="p-4 text-right font-mono">{formatFCFA(parseInt(p.total_net ?? '0'))}</td>
                    <td className="p-4 text-right font-mono text-orange-600">{formatFCFA(parseInt(p.total_cnps ?? '0'))}</td>
                    <td className="p-4 text-right font-mono text-blue-600">{formatFCFA(parseInt(p.total_its ?? '0'))}</td>
                    <td className="p-4"><StatusBadge status={p.status} /></td>
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
                          {canValidate ? 'Valider' : 'Voir workflow'}
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      )}
                      {p.status === 'closed' && (
                        <button
                          onClick={() => setWorkflowMonth(p.month)}
                          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                          Audit <ChevronRight className="h-3 w-3" />
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
                    Aucune période de paie
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {workflowMonth && (
        <WorkflowModal month={workflowMonth} onClose={() => setWorkflowMonth(null)} />
      )}
    </div>
  )
}
