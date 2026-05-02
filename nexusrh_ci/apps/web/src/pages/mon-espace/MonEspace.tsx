import { useQuery } from '@tanstack/react-query'
import { api, formatFCFA, formatDate, formatMonth } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { Calendar, FileText, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'

interface AbsenceBalance {
  absence_type_id: string; label: string; code: string; color: string
  acquired: number; taken: number; pending: number; remaining: number
}

interface PaySlip {
  id: string; month: string; net_payable: string
  status: string; viewed_by_employee_at: string | null
}

interface Absence {
  id: string; type_label: string; type_color: string
  start_date: string; end_date: string; days: number; status: string
}

interface AccessLog {
  id: string; action: string; entity: string; ip_address: string | null; created_at: string
}

export default function MonEspace() {
  const user = useAuthStore(s => s.user)
  const tenantConfig = useAuthStore(s => s.tenantConfig)

  const { data: balancesData } = useQuery<{ data: AbsenceBalance[] }>({
    queryKey: ['my-balances'],
    queryFn: () => api.get('/absences/balances').then(r => r.data),
  })

  const { data: slipsData } = useQuery<{ data: PaySlip[] }>({
    queryKey: ['my-payslips'],
    queryFn: () => api.get('/payroll/my-payslips').then(r => r.data),
  })

  const { data: absencesData } = useQuery<{ data: Absence[] }>({
    queryKey: ['my-absences'],
    queryFn: () => api.get('/absences/my-absences').then(r => r.data),
  })

  const { data: accessLogData } = useQuery<{ data: AccessLog[] }>({
    queryKey: ['my-access-log'],
    queryFn: () => api.get('/payroll/my-access-log').then(r => r.data),
  })

  const balances = balancesData?.data ?? []
  const slips = slipsData?.data ?? []
  const absences = absencesData?.data ?? []
  const accessLogs = accessLogData?.data ?? []

  const lastSlip = slips[0]
  const recentAbsences = absences.slice(0, 3)

  const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
    pending:   { label: 'En attente', color: 'bg-yellow-100 text-yellow-700' },
    submitted: { label: 'En attente', color: 'bg-yellow-100 text-yellow-700' },
    approved:  { label: 'Approuvée',  color: 'bg-green-100 text-green-700' },
    rejected:  { label: 'Refusée',    color: 'bg-red-100 text-red-700' },
    cancelled: { label: 'Annulée',    color: 'bg-gray-100 text-gray-600' },
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Bonjour, {user?.firstName} 👋</h1>
        <p className="text-sm text-muted-foreground mt-1">{tenantConfig?.name} · Espace personnel</p>
      </div>

      {/* Soldes congés */}
      {balances.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <Calendar className="h-4 w-4" /> Mes soldes congés
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {balances.map(b => (
              <div key={b.absence_type_id} className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">{b.label}</span>
                  <span className="text-muted-foreground">{b.remaining}j restants / {b.acquired}j</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${b.acquired > 0 ? Math.round((b.taken / b.acquired) * 100) : 0}%`,
                      backgroundColor: b.color ?? 'hsl(var(--primary))',
                    }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{b.taken}j pris</span>
                  {b.pending > 0 && <span className="text-yellow-600">{b.pending}j en attente</span>}
                </div>
              </div>
            ))}
          </div>
          <Link to="/mon-espace/absences"
            className="mt-4 block text-center text-sm text-primary hover:underline">
            Demander une absence →
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Dernier bulletin */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <FileText className="h-4 w-4" /> Mon dernier bulletin
          </h2>
          {lastSlip ? (
            <div>
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-muted-foreground capitalize">{formatMonth(lastSlip.month)}</p>
                  <p className="text-2xl font-bold mt-1">{formatFCFA(parseInt(lastSlip.net_payable ?? '0'))}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Net à payer</p>
                </div>
                {!lastSlip.viewed_by_employee_at && (
                  <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                    Nouveau
                  </span>
                )}
              </div>
              <Link to="/mon-espace/bulletins"
                className="mt-4 block text-sm text-primary hover:underline">
                Voir tous mes bulletins →
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Aucun bulletin disponible</p>
          )}
        </div>

        {/* Absences récentes */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <Calendar className="h-4 w-4" /> Mes absences récentes
          </h2>
          {recentAbsences.length > 0 ? (
            <div className="space-y-3">
              {recentAbsences.map(abs => (
                <div key={abs.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{abs.type_label}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(abs.start_date)} — {abs.days}j
                    </p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CONFIG[abs.status]?.color ?? 'bg-muted'}`}>
                    {STATUS_CONFIG[abs.status]?.label ?? abs.status}
                  </span>
                </div>
              ))}
              <Link to="/mon-espace/absences"
                className="block text-sm text-primary hover:underline mt-2">
                Voir toutes mes absences →
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Aucune absence</p>
          )}
        </div>
      </div>
      {/* Journal d'accès ARTCI */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Journal d'accès — Conformité ARTCI
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Conformément à la loi CI 2013-450, vous pouvez consulter qui a accédé à vos données RH.
        </p>
        {accessLogs.length > 0 ? (
          <div className="space-y-1.5">
            {accessLogs.slice(0, 5).map(log => (
              <div key={log.id} className="flex items-center justify-between text-xs py-1 border-b border-border last:border-0">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 font-mono ${log.action === 'READ' ? 'bg-blue-100 text-blue-700' : log.action === 'UPDATE' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                    {log.action}
                  </span>
                  <span className="text-muted-foreground capitalize">{log.entity.replace('_', ' ')}</span>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  {log.ip_address && <span className="font-mono">{log.ip_address}</span>}
                  <span>{formatDate(log.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Aucun accès enregistré récemment</p>
        )}
      </div>
    </div>
  )
}
