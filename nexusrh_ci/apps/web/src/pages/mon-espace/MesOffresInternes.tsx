import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA } from '@/lib/api'
import { Briefcase, MapPin, Send, CheckCircle, Lock } from 'lucide-react'

interface InternalJob {
  id: string
  title: string
  department_name: string | null
  location: string
  contract_type: string
  salary_min: string | null
  salary_max: string | null
  description: string | null
  requirements: string | null
  visibility: string
  target_min_seniority_months: number | null
  created_at: string
  already_applied: number
}

const CONTRACT_LABELS: Record<string, string> = {
  cdi: 'CDI', cdd: 'CDD', stage: 'Stage', apprentissage: 'Apprentissage',
}

export default function MesOffresInternes() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<InternalJob | null>(null)
  const [coverLetter, setCoverLetter] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: InternalJob[] }>({
    queryKey: ['internal-jobs'],
    queryFn: () => api.get('/recruitment/internal-jobs').then(r => r.data),
  })

  const apply = useMutation({
    mutationFn: (vars: { id: string; cover_letter: string; phone?: string }) =>
      api.post(`/recruitment/internal-jobs/${vars.id}/apply`, {
        cover_letter: vars.cover_letter,
        phone: vars.phone || undefined,
      }),
    onSuccess: () => {
      setSuccess('Candidature envoyée avec succès — votre RH va en être informé.')
      setError(null)
      setSelected(null)
      setCoverLetter('')
      setPhone('')
      queryClient.invalidateQueries({ queryKey: ['internal-jobs'] })
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Erreur lors de la candidature')
      setSuccess(null)
    },
  })

  const jobs = data?.data ?? []

  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <Lock className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold md:text-2xl">Offres internes</h1>
          <p className="text-sm text-muted-foreground">
            Postes ouverts en interne qui correspondent à votre profil
          </p>
        </div>
      </div>

      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
          <Briefcase className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
          <p className="font-medium">Aucune offre interne pour le moment</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Les offres ciblées qui correspondent à votre profil apparaîtront ici.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {jobs.map(job => (
            <div key={job.id} className="rounded-xl border border-border bg-card p-4 transition-all hover:border-primary hover:shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold truncate">{job.title}</h3>
                  {job.department_name && (
                    <p className="text-xs text-muted-foreground mt-0.5">{job.department_name}</p>
                  )}
                </div>
                {job.already_applied > 0 && (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                    <CheckCircle className="h-3 w-3" /> Candidature envoyée
                  </span>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-muted-foreground">
                  <MapPin className="h-3 w-3" /> {job.location}
                </span>
                <span className="rounded-md bg-muted/60 px-2 py-1 font-medium text-foreground">
                  {CONTRACT_LABELS[job.contract_type] ?? job.contract_type.toUpperCase()}
                </span>
                {job.salary_min && job.salary_max && (
                  <span className="rounded-md bg-primary/10 px-2 py-1 font-medium text-primary">
                    {formatFCFA(parseInt(job.salary_min))} – {formatFCFA(parseInt(job.salary_max))}
                  </span>
                )}
                {job.target_min_seniority_months !== null && (
                  <span className="rounded-md bg-purple-50 px-2 py-1 text-purple-700">
                    Ancienneté min : {job.target_min_seniority_months} mois
                  </span>
                )}
              </div>

              {job.description && (
                <p className="mt-3 text-sm text-muted-foreground line-clamp-3">{job.description}</p>
              )}

              <div className="mt-4 flex justify-end">
                <button onClick={() => { setSelected(job); setError(null); setSuccess(null) }}
                  disabled={job.already_applied > 0}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
                  <Send className="h-3.5 w-3.5" />
                  {job.already_applied > 0 ? 'Déjà candidat' : 'Postuler'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSelected(null)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">Postuler : {selected.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Votre profil employé sera transmis automatiquement. Ajoutez une lettre
              de motivation pour expliquer votre intérêt.
            </p>

            {error && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>
            )}

            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Téléphone (facultatif)</label>
                <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder="+225 07 XX XX XX XX"
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Lettre de motivation *</label>
                <textarea value={coverLetter} onChange={e => setCoverLetter(e.target.value)}
                  rows={6} placeholder="Expliquez en quelques lignes pourquoi vous postulez à ce poste…"
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setSelected(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
                Annuler
              </button>
              <button onClick={() => apply.mutate({ id: selected.id, cover_letter: coverLetter, phone })}
                disabled={apply.isPending || coverLetter.trim().length < 10}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {apply.isPending ? 'Envoi…' : 'Envoyer ma candidature'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
