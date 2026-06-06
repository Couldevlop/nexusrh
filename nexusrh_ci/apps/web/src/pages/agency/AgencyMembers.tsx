import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Loader2, UserCircle } from 'lucide-react'
import { api } from '@/lib/api'

interface Member {
  id: string; email: string; first_name: string; last_name: string
  role: string; is_active: boolean; last_login_at: string | null
}

export default function AgencyMembers() {
  const { t } = useTranslation('agency')
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'agency_member' })
  const [result, setResult] = useState<{ tempPassword: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: Member[] }>({
    queryKey: ['agency-members'],
    queryFn: () => api.get('/agency/members').then((r) => r.data),
  })

  const create = useMutation({
    mutationFn: () => api.post('/agency/members', form).then((r) => r.data),
    onSuccess: (res: { tempPassword: string }) => {
      setResult(res); setError(null)
      setForm({ email: '', firstName: '', lastName: '', role: 'agency_member' })
      qc.invalidateQueries({ queryKey: ['agency-members'] })
    },
    onError: (err: unknown) => {
      const ax = err as { response?: { data?: { error?: string } } }
      setError(ax.response?.data?.error ?? t('common.createError'))
    },
  })

  const members = data?.data ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('members.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('members.subtitle')}</p>
        </div>
        <button onClick={() => { setShowForm((v) => !v); setResult(null) }}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('members.inviteButton')}
        </button>
      </div>

      {showForm && (
        <div className="rounded-xl border border-border bg-card p-5">
          {result ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-emerald-700">{t('members.createdTitle')}</p>
              <p className="text-sm">{t('common.tempPassword')} <code className="rounded bg-muted px-2 py-0.5">{result.tempPassword}</code></p>
              <button onClick={() => { setShowForm(false); setResult(null) }} className="mt-2 text-sm text-primary hover:underline">{t('common.close')}</button>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('members.fields.email')} type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} required />
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('members.fields.role')}</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20">
                  <option value="agency_member">{t('members.roleMember')}</option>
                  <option value="agency_owner">{t('members.roleOwner')}</option>
                </select>
              </div>
              <Field label={t('members.fields.firstName')} value={form.firstName} onChange={(v) => setForm({ ...form, firstName: v })} />
              <Field label={t('members.fields.lastName')} value={form.lastName} onChange={(v) => setForm({ ...form, lastName: v })} />
              {error && <p className="sm:col-span-2 text-sm text-red-600">{error}</p>}
              <div className="sm:col-span-2">
                <button type="submit" disabled={create.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
                  {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {t('members.submit')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr><th className="px-4 py-3">{t('members.table.member')}</th><th className="px-4 py-3">{t('members.table.email')}</th><th className="px-4 py-3">{t('members.table.role')}</th><th className="px-4 py-3">{t('members.table.status')}</th></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-t border-border">
                  <td className="px-4 py-3"><div className="flex items-center gap-2"><UserCircle className="h-5 w-5 text-muted-foreground" /> {m.first_name} {m.last_name}</div></td>
                  <td className="px-4 py-3 text-muted-foreground">{m.email}</td>
                  <td className="px-4 py-3">{m.role === 'agency_owner' ? t('members.roleOwner') : t('members.roleMember')}</td>
                  <td className="px-4 py-3">{m.is_active ? <span className="text-emerald-600">{t('common.active')}</span> : <span className="text-red-500">{t('common.inactive')}</span>}</td>
                </tr>
              ))}
              {members.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">{t('members.empty')}</td></tr>}
            </tbody>
          </table>
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
