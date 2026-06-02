import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Plus, Loader2, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { LogoUpload } from '@/components/shared/LogoUpload'

interface Agency {
  id: string; slug: string; name: string; status: string; city: string | null
  users_count: string; tenants_count: string
}

export default function PlatformAgencies() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    name: '', slug: '', ownerEmail: '', city: 'Abidjan',
    primaryColor: '#1D4ED8', logoUrl: null as string | null, senderEmail: '', senderName: '',
  })
  const [result, setResult] = useState<{ ownerEmail: string; tempPassword: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: Agency[] }>({
    queryKey: ['platform-agencies'],
    queryFn: () => api.get('/agency/agencies').then((r) => r.data),
  })

  const create = useMutation({
    mutationFn: () => api.post('/agency/agencies', form).then((r) => r.data),
    onSuccess: (res: { ownerEmail: string; tempPassword: string }) => {
      setResult(res); setError(null)
      setForm({ name: '', slug: '', ownerEmail: '', city: 'Abidjan', primaryColor: '#1D4ED8', logoUrl: null, senderEmail: '', senderName: '' })
      qc.invalidateQueries({ queryKey: ['platform-agencies'] })
    },
    onError: (err: unknown) => {
      const ax = err as { response?: { data?: { error?: string } } }
      setError(ax.response?.data?.error ?? 'Erreur lors de la création')
    },
  })

  const agencies = data?.data ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cabinets de recrutement</h1>
          <p className="text-sm text-muted-foreground">Cabinets gérant plusieurs entreprises clientes (Côte d'Ivoire).</p>
        </div>
        <button onClick={() => { setShowForm((v) => !v); setResult(null) }}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
          <Plus className="h-4 w-4" /> Nouveau cabinet
        </button>
      </div>

      {showForm && (
        <div className="rounded-xl border border-border bg-card p-5">
          {result ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-emerald-700">Cabinet créé ✓</p>
              <p className="text-sm">Owner : <strong>{result.ownerEmail}</strong></p>
              <p className="text-sm">Mot de passe temporaire : <code className="rounded bg-muted px-2 py-0.5">{result.tempPassword}</code></p>
              <button onClick={() => { setShowForm(false); setResult(null) }} className="mt-2 text-sm text-primary hover:underline">Fermer</button>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Nom du cabinet" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
              <Field label="Slug" value={form.slug} onChange={(v) => setForm({ ...form, slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} required />
              <Field label="Email du propriétaire" type="email" value={form.ownerEmail} onChange={(v) => setForm({ ...form, ownerEmail: v })} required />
              <Field label="Ville" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
              <Field label="Email expéditeur (invitations)" type="email" value={form.senderEmail} onChange={(v) => setForm({ ...form, senderEmail: v })} />
              <Field label="Nom expéditeur" value={form.senderName} onChange={(v) => setForm({ ...form, senderName: v })} />
              <div className="sm:col-span-2">
                <LogoUpload value={form.logoUrl} onChange={(url) => setForm({ ...form, logoUrl: url })} label="Logo du cabinet" />
              </div>
              {error && <p className="sm:col-span-2 text-sm text-red-600">{error}</p>}
              <div className="sm:col-span-2">
                <button type="submit" disabled={create.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
                  {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Créer le cabinet
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr><th className="px-4 py-3">Cabinet</th><th className="px-4 py-3">Ville</th><th className="px-4 py-3">Membres</th><th className="px-4 py-3">Clients</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3"></th></tr>
            </thead>
            <tbody>
              {agencies.map((a) => (
                <tr key={a.id} className="border-t border-border hover:bg-muted/30">
                  <td className="px-4 py-3"><div className="flex items-center gap-2"><Briefcase className="h-4 w-4 text-indigo-500" /> {a.name}</div></td>
                  <td className="px-4 py-3 text-muted-foreground">{a.city ?? '—'}</td>
                  <td className="px-4 py-3">{a.users_count}</td>
                  <td className="px-4 py-3">{a.tenants_count}</td>
                  <td className="px-4 py-3">{a.status === 'active' ? <span className="text-emerald-600">Actif</span> : <span className="text-red-500">Suspendu</span>}</td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/platform/agencies/${a.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">Gérer <ChevronRight className="h-4 w-4" /></Link>
                  </td>
                </tr>
              ))}
              {agencies.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Aucun cabinet.</td></tr>}
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
