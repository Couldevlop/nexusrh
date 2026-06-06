import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Save } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { LogoUpload } from '@/components/shared/LogoUpload'

interface AgencyMe {
  id: string; name: string; city: string | null; contact_email: string | null
  contact_phone: string | null; primary_color: string | null; logo_url: string | null
  sender_email: string | null; sender_name: string | null
}

export default function AgencySettings() {
  const { t } = useTranslation('agency')
  const qc = useQueryClient()
  const isOwner = useAuthStore((s) => s.user?.role) === 'agency_owner'
  const [form, setForm] = useState({
    name: '', city: '', contactEmail: '', contactPhone: '',
    primaryColor: '#1D4ED8', logoUrl: null as string | null,
    senderEmail: '', senderName: '',
  })
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: AgencyMe }>({
    queryKey: ['agency-me'],
    queryFn: () => api.get('/agency/me').then((r) => r.data),
  })

  useEffect(() => {
    const a = data?.data
    if (a) setForm({
      name: a.name ?? '', city: a.city ?? '', contactEmail: a.contact_email ?? '',
      contactPhone: a.contact_phone ?? '', primaryColor: a.primary_color ?? '#1D4ED8',
      logoUrl: a.logo_url, senderEmail: a.sender_email ?? '', senderName: a.sender_name ?? '',
    })
  }, [data])

  const save = useMutation({
    mutationFn: () => api.patch(`/agency/agencies/${data!.data.id}`, form).then((r) => r.data),
    onSuccess: () => { setSaved(true); setError(null); qc.invalidateQueries({ queryKey: ['agency-me'] }); setTimeout(() => setSaved(false), 2500) },
    onError: (err: unknown) => {
      const ax = err as { response?: { data?: { error?: string } } }
      setError(ax.response?.data?.error ?? t('settings.saveError'))
    },
  })

  if (isLoading) return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.subtitle')}</p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} className="space-y-5 rounded-xl border border-border bg-card p-6">
        <LogoUpload value={form.logoUrl} onChange={(url) => setForm({ ...form, logoUrl: url })} label={t('settings.logo')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('settings.fields.name')} value={form.name} onChange={(v) => setForm({ ...form, name: v })} disabled={!isOwner} />
          <Field label={t('settings.fields.city')} value={form.city} onChange={(v) => setForm({ ...form, city: v })} disabled={!isOwner} />
          <Field label={t('settings.fields.contactEmail')} type="email" value={form.contactEmail} onChange={(v) => setForm({ ...form, contactEmail: v })} disabled={!isOwner} />
          <Field label={t('settings.fields.contactPhone')} value={form.contactPhone} onChange={(v) => setForm({ ...form, contactPhone: v })} disabled={!isOwner} />
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('settings.fields.primaryColor')}</label>
            <input type="color" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
              disabled={!isOwner} className="h-10 w-20 rounded border border-gray-200" />
          </div>
        </div>

        <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
          <p className="mb-3 text-sm font-semibold text-indigo-900">{t('settings.senderSection.title')}</p>
          <p className="mb-3 text-xs text-indigo-700">
            {t('settings.senderSection.hint')}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('settings.fields.senderEmail')} type="email" value={form.senderEmail} onChange={(v) => setForm({ ...form, senderEmail: v })} disabled={!isOwner} />
            <Field label={t('settings.fields.senderName')} value={form.senderName} onChange={(v) => setForm({ ...form, senderName: v })} disabled={!isOwner} />
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {isOwner && (
          <button type="submit" disabled={save.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saved ? t('settings.saved') : t('settings.save')}
          </button>
        )}
      </form>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', disabled }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{label}</label>
      <input type={type} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60" />
    </div>
  )
}
