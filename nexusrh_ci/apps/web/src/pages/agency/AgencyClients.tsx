import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Building2, Plus, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { LogoUpload } from '@/components/shared/LogoUpload'

interface ClientTenant {
  id: string; name: string; slug: string; city: string | null; plan_type: string; status: string
}

export default function AgencyClients() {
  const { t: tt } = useTranslation('agency')
  const qc = useQueryClient()
  const isOwner = useAuthStore((s) => s.user?.role) === 'agency_owner'
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', slug: '', adminEmail: '', city: 'Abidjan', sector: 'services', logoUrl: null as string | null })
  const [result, setResult] = useState<{ adminEmail: string; tempPassword: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: ClientTenant[] }>({
    queryKey: ['agency-my-tenants'],
    queryFn: () => api.get('/agency/my-tenants').then((r) => r.data),
  })

  const create = useMutation({
    mutationFn: () => api.post('/agency/client-tenants', form).then((r) => r.data),
    onSuccess: (res: { adminEmail: string; tempPassword: string }) => {
      setResult(res); setError(null)
      setForm({ name: '', slug: '', adminEmail: '', city: 'Abidjan', sector: 'services', logoUrl: null })
      qc.invalidateQueries({ queryKey: ['agency-my-tenants'] })
    },
    onError: (err: unknown) => {
      const ax = err as { response?: { data?: { error?: string } } }
      setError(ax.response?.data?.error ?? tt('common.createError'))
    },
  })

  const tenants = data?.data ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tt('clients.title')}</h1>
          <p className="text-sm text-muted-foreground">{tt('clients.subtitle')}</p>
        </div>
        {isOwner && (
          <button onClick={() => { setShowForm((v) => !v); setResult(null) }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> {tt('clients.newButton')}
          </button>
        )}
      </div>

      {showForm && isOwner && (
        <div className="rounded-xl border border-border bg-card p-5">
          {result ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-emerald-700">{tt('clients.createdTitle')}</p>
              <p className="text-sm">{tt('clients.adminLabel')} <strong>{result.adminEmail}</strong></p>
              <p className="text-sm">{tt('common.tempPassword')} <code className="rounded bg-muted px-2 py-0.5">{result.tempPassword}</code></p>
              <p className="text-xs text-muted-foreground">{tt('clients.tempPasswordNote')}</p>
              <button onClick={() => { setShowForm(false); setResult(null) }} className="mt-2 text-sm text-primary hover:underline">{tt('common.close')}</button>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={tt('clients.fields.name')} value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
              <Field label={tt('clients.fields.slug')} value={form.slug} onChange={(v) => setForm({ ...form, slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} required />
              <Field label={tt('clients.fields.adminEmail')} type="email" value={form.adminEmail} onChange={(v) => setForm({ ...form, adminEmail: v })} required />
              <Field label={tt('clients.fields.city')} value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
              <div className="sm:col-span-2">
                <LogoUpload value={form.logoUrl} onChange={(url) => setForm({ ...form, logoUrl: url })} label={tt('clients.fields.logo')} />
              </div>
              {error && <p className="sm:col-span-2 text-sm text-red-600">{error}</p>}
              <div className="sm:col-span-2">
                <button type="submit" disabled={create.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
                  {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {tt('clients.submit')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {tt('common.loading')}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tenants.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted"><Building2 className="h-5 w-5 text-muted-foreground" /></div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{t.name}</p>
                <p className="truncate text-xs text-muted-foreground">{t.city ?? tt('common.ciShort')} · {t.plan_type}</p>
              </div>
            </div>
          ))}
          {tenants.length === 0 && <p className="text-sm text-muted-foreground">{tt('clients.empty')}</p>}
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', required }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{label}</label>
      <input type={type} value={value} required={required} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20" />
    </div>
  )
}
