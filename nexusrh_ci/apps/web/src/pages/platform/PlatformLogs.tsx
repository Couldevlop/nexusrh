import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ScrollText, ChevronLeft, ChevronRight } from 'lucide-react'

// PLT-018 — Logs d'activité plateforme (cross-tenant), triés par date.
interface AuditLog {
  id: string
  user_id: string | null
  action: string
  entity: string | null
  entity_type: string | null
  entity_id: string | null
  tenant_name: string | null
  ip_address: string | null
  created_at: string
}

const LIMIT = 50

export default function PlatformLogs() {
  const [page, setPage] = useState(1)

  const { data, isLoading } = useQuery<{ data: AuditLog[]; meta: { page: number; limit: number; hasMore: boolean } }>({
    queryKey: ['platform-logs', page],
    queryFn: () => api.get(`/platform/logs?page=${page}&limit=${LIMIT}`).then(r => r.data),
    refetchInterval: 30_000,
  })

  const logs = data?.data ?? []
  const hasMore = data?.meta?.hasMore ?? false

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ScrollText className="h-6 w-6" /> Logs d'activité
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Actions super_admin cross-tenant (création / suspension / suppression de tenant, reset admin, etc.)
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="p-3">Date</th>
                <th className="p-3">Tenant</th>
                <th className="p-3">Action</th>
                <th className="p-3">Entité</th>
                <th className="p-3">Utilisateur</th>
                <th className="p-3">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map(log => (
                <tr key={log.id} className="hover:bg-muted/40">
                  <td className="p-3 whitespace-nowrap text-muted-foreground">
                    {log.created_at ? new Date(log.created_at).toLocaleString('fr-CI') : '—'}
                  </td>
                  <td className="p-3">{log.tenant_name ?? '—'}</td>
                  <td className="p-3">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{log.action}</span>
                  </td>
                  <td className="p-3 text-muted-foreground">{log.entity_type ?? log.entity ?? '—'}</td>
                  <td className="p-3 text-xs font-mono text-muted-foreground">{log.user_id?.slice(0, 8) ?? '—'}</td>
                  <td className="p-3 text-xs font-mono text-muted-foreground">{log.ip_address ?? '—'}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-12 text-center text-muted-foreground">
                    <ScrollText className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    <p>Aucun log d'activité.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setPage(p => Math.max(p - 1, 1))}
            disabled={page <= 1}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-muted">
            <ChevronLeft className="h-4 w-4" /> Précédent
          </button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={!hasMore}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-muted">
            Suivant <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
