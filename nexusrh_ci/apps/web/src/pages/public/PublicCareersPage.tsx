/**
 * Page carrières publique — accessible sans authentification.
 *
 * URL : /careers/:tenantSlug
 *
 * Affiche les offres "external" ou "both" d'un tenant + formulaire de
 * candidature (modale). Thématisée avec les couleurs du tenant (logo +
 * primaryColor / secondaryColor).
 *
 * OWASP A05 : pas de leak d'info (slug invalide → 404 propre).
 * Mobile-first responsive (Tailwind).
 */
import { useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Briefcase, MapPin, Calendar, ExternalLink, CheckCircle, XCircle,
  Send, Loader2, Building2, Sparkles, Search, ArrowRight, AlertCircle,
} from 'lucide-react'

interface PublicJob {
  id: string; title: string
  location: string | null
  contract_type: string | null
  salary_min: string | null
  salary_max: string | null
  currency: string | null
  description: string | null
  requirements: string | null
  public_slug: string | null
  created_at: string
  published_at: string | null
  applications_count: number
}

interface TenantBranding {
  name: string; slug: string
  city: string | null; sector: string | null
  primaryColor: string
  secondaryColor: string
  logoUrl: string | null
}

interface CareersResponse {
  tenant: TenantBranding
  data: PublicJob[]
  count: number
}

const CONTRACT_LABELS: Record<string, string> = {
  cdi: 'CDI', cdd: 'CDD', stage: 'Stage', apprentissage: 'Apprentissage',
  interim: 'Intérim', freelance: 'Freelance',
}

function formatSalary(min: string | null, max: string | null, currency: string | null): string | null {
  if (!min && !max) return null
  const cur = currency || 'XOF'
  const fmt = (v: string) => parseInt(v).toLocaleString('fr-FR')
  if (min && max) return `${fmt(min)} – ${fmt(max)} ${cur}`
  if (min) return `À partir de ${fmt(min)} ${cur}`
  return `Jusqu'à ${fmt(max!)} ${cur}`
}

export default function PublicCareersPage() {
  const { tenantSlug } = useParams<{ tenantSlug: string }>()
  const [selectedJob, setSelectedJob] = useState<PublicJob | null>(null)
  const [search, setSearch] = useState('')

  const { data, isLoading, error } = useQuery<CareersResponse>({
    queryKey: ['public-careers', tenantSlug],
    queryFn: () => api.get(`/recruitment/public/${tenantSlug}/jobs`).then(r => r.data),
    enabled: !!tenantSlug,
  })

  const tenant = data?.tenant
  const jobs = data?.data ?? []

  const filteredJobs = useMemo(() => {
    if (!search.trim()) return jobs
    const q = search.toLowerCase()
    return jobs.filter(j =>
      j.title.toLowerCase().includes(q) ||
      (j.location ?? '').toLowerCase().includes(q) ||
      (j.contract_type ?? '').toLowerCase().includes(q),
    )
  }, [jobs, search])

  // Applique le thème tenant si dispo
  const themeStyle = useMemo<React.CSSProperties>(() => {
    if (!tenant) return {}
    return {
      ['--brand-primary' as string]: tenant.primaryColor,
      ['--brand-secondary' as string]: tenant.secondaryColor,
    } as React.CSSProperties
  }, [tenant])

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  if (error || !tenant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="text-center max-w-md">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-rose-400" />
          <h1 className="text-xl font-bold text-slate-900">Entreprise introuvable</h1>
          <p className="mt-2 text-sm text-slate-600">
            Le lien de cette page carrières semble invalide ou expiré.
            Vérifiez l'URL ou contactez l'entreprise.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50" style={themeStyle}>
      {/* Hero header avec branding tenant */}
      <header className="relative overflow-hidden text-white shadow-lg"
        style={{
          background: `linear-gradient(135deg, ${tenant.primaryColor} 0%, ${tenant.secondaryColor} 100%)`,
        }}>
        <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_top_right,_white_0%,_transparent_60%)]" />
        <div className="relative mx-auto max-w-6xl px-4 py-12 sm:py-16">
          <div className="flex items-start gap-5">
            {/* Logo tenant ou initiale */}
            <div className="flex h-16 w-16 sm:h-20 sm:w-20 flex-shrink-0 items-center justify-center rounded-2xl bg-white/95 shadow-xl ring-4 ring-white/30">
              {tenant.logoUrl ? (
                <img src={tenant.logoUrl} alt={tenant.name}
                  className="h-full w-full object-contain rounded-2xl p-2" />
              ) : (
                <span className="text-2xl sm:text-3xl font-bold" style={{ color: tenant.primaryColor }}>
                  {tenant.name.charAt(0)}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-white/80 text-xs sm:text-sm">
                <Building2 className="h-4 w-4" />
                <span>{tenant.name}</span>
                {tenant.city && <><span>·</span><span>{tenant.city}</span></>}
              </div>
              <h1 className="mt-1 text-3xl sm:text-4xl font-bold leading-tight">
                Nos offres d'emploi
              </h1>
              <p className="mt-2 text-white/90 text-sm sm:text-base max-w-2xl">
                Rejoignez {tenant.name}{tenant.sector ? ` · ${tenant.sector}` : ''}. {jobs.length} poste{jobs.length > 1 ? 's' : ''} ouvert{jobs.length > 1 ? 's' : ''}.
              </p>

              {/* Barre de recherche */}
              <div className="mt-5 relative max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Rechercher un poste, un lieu…"
                  className="w-full rounded-full bg-white/95 text-slate-900 placeholder-slate-400 pl-10 pr-4 py-2.5 text-sm shadow-md ring-2 ring-white/30 focus:ring-white outline-none"
                />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Liste des offres */}
      <main className="mx-auto max-w-6xl px-4 py-10">
        {filteredJobs.length === 0 && jobs.length > 0 && (
          <div className="text-center py-16">
            <Search className="mx-auto h-12 w-12 text-slate-300 mb-3" />
            <p className="text-slate-600">Aucune offre ne correspond à « {search} »</p>
          </div>
        )}

        {jobs.length === 0 && (
          <div className="text-center py-20">
            <Briefcase className="mx-auto h-16 w-16 text-slate-300 mb-4" />
            <h2 className="text-xl font-bold text-slate-700">Aucune offre actuellement</h2>
            <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
              {tenant.name} n'a pas d'offre publiée pour l'instant. Revenez bientôt !
            </p>
          </div>
        )}

        {filteredJobs.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredJobs.map(job => (
              <JobCard key={job.id} job={job} primaryColor={tenant.primaryColor}
                onApply={() => setSelectedJob(job)} />
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-6 mt-10">
        <div className="mx-auto max-w-6xl px-4 text-center text-xs text-slate-500">
          Propulsé par <strong>NexusRH CI</strong> — Plateforme SIRH multi-tenant ·{' '}
          <Link to="/login" className="text-slate-600 hover:text-slate-800 underline">Espace recruteur</Link>
        </div>
      </footer>

      {/* Modale de candidature */}
      {selectedJob && (
        <ApplyDialog
          tenant={tenant}
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
        />
      )}
    </div>
  )
}

// ─── Carte d'une offre ──────────────────────────────────────────────────────
function JobCard({ job, primaryColor, onApply }: {
  job: PublicJob
  primaryColor: string
  onApply: () => void
}) {
  const salary = formatSalary(job.salary_min, job.salary_max, job.currency)
  const contractLabel = CONTRACT_LABELS[job.contract_type?.toLowerCase() ?? ''] ?? job.contract_type ?? 'CDI'
  const publishedDate = job.published_at ?? job.created_at

  return (
    <article className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-1 hover:shadow-xl">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-slate-900 line-clamp-2 group-hover:text-[var(--brand-primary)]">
            {job.title}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
            {job.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {job.location}
              </span>
            )}
            <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide" style={{ color: primaryColor }}>
              {contractLabel}
            </span>
          </div>
        </div>
      </div>

      {job.description && (
        <p className="text-sm text-slate-600 line-clamp-3 mb-4 flex-1">
          {job.description}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {salary && (
          <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
            {salary}
          </span>
        )}
        {publishedDate && (
          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
            <Calendar className="h-3 w-3" />
            {new Date(publishedDate).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
          </span>
        )}
        {job.applications_count > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
            {job.applications_count} candidature{job.applications_count > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <button onClick={onApply}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5"
        style={{ background: `linear-gradient(135deg, ${primaryColor} 0%, var(--brand-secondary) 100%)` }}>
        Postuler <ArrowRight className="h-4 w-4" />
      </button>
    </article>
  )
}

// ─── Modale de candidature ──────────────────────────────────────────────────
function ApplyDialog({ tenant, job, onClose }: {
  tenant: TenantBranding
  job: PublicJob
  onClose: () => void
}) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    cover_letter: '',
  })
  const [success, setSuccess] = useState<{ id: string; jobTitle: string; companyName: string } | null>(null)

  const submit = useMutation({
    mutationFn: (body: typeof form) => api.post(
      `/recruitment/public/${tenant.slug}/jobs/${job.id}/apply`,
      body,
    ).then(r => r.data),
    onSuccess: (data) => setSuccess(data.data),
  })

  const canSubmit = form.first_name.trim() && form.last_name.trim() && /^.+@.+\..+$/.test(form.email)

  const errorMsg = submit.error
    ? ((submit.error as { response?: { data?: { error?: string; issues?: { field: string; message: string }[] } } })
        .response?.data?.error ?? 'Erreur lors de l\'envoi')
    : null
  const issues = (submit.error as { response?: { data?: { issues?: { field: string; message: string }[] } } } | null)
    ?.response?.data?.issues

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden my-auto"
        onClick={e => e.stopPropagation()}>
        {success ? (
          // ─── Écran de succès ─────────────────────────────────────────
          <div className="p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 shadow-lg">
              <CheckCircle className="h-8 w-8 text-white" />
            </div>
            <h2 className="text-xl font-bold text-slate-900">Candidature envoyée !</h2>
            <p className="mt-2 text-sm text-slate-600 max-w-sm mx-auto">
              Merci pour votre intérêt pour le poste <strong>{success.jobTitle}</strong> chez <strong>{success.companyName}</strong>.
              Vous serez recontacté(e) si votre profil correspond.
            </p>
            <button onClick={onClose}
              className="mt-6 inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-md"
              style={{ background: `linear-gradient(135deg, ${tenant.primaryColor} 0%, ${tenant.secondaryColor} 100%)` }}>
              Voir d'autres offres
            </button>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="relative overflow-hidden text-white p-5"
              style={{ background: `linear-gradient(135deg, ${tenant.primaryColor} 0%, ${tenant.secondaryColor} 100%)` }}>
              <button onClick={onClose}
                className="absolute right-3 top-3 rounded-full p-1 hover:bg-white/20"
                aria-label="Fermer">
                <XCircle className="h-5 w-5 text-white" />
              </button>
              <div className="flex items-start gap-3">
                <Sparkles className="h-5 w-5 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs uppercase tracking-wider text-white/80">Candidature</p>
                  <h3 className="text-lg font-bold leading-tight">{job.title}</h3>
                  <p className="text-xs text-white/90 mt-0.5">
                    {tenant.name}{job.location ? ` · ${job.location}` : ''}
                  </p>
                </div>
              </div>
            </div>

            {/* Form */}
            <form
              onSubmit={e => { e.preventDefault(); submit.mutate(form) }}
              className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Prénom *</label>
                  <input value={form.first_name} onChange={e => setForm(p => ({ ...p, first_name: e.target.value }))}
                    required maxLength={100}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 outline-none"
                    style={{ ['--tw-ring-color' as string]: tenant.primaryColor } as React.CSSProperties} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Nom *</label>
                  <input value={form.last_name} onChange={e => setForm(p => ({ ...p, last_name: e.target.value }))}
                    required maxLength={100}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 outline-none" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Email *</label>
                <input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                  required maxLength={255} placeholder="vous@exemple.com"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 outline-none" />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Téléphone</label>
                <input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))}
                  maxLength={30} placeholder="+225 07 09 32 05 94"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 outline-none" />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Lettre de motivation</label>
                <textarea value={form.cover_letter} onChange={e => setForm(p => ({ ...p, cover_letter: e.target.value }))}
                  rows={5} maxLength={5000}
                  placeholder="Parlez-nous de votre expérience, votre motivation, vos disponibilités…"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none focus:ring-2 outline-none" />
                <div className="mt-1 text-[10px] text-slate-400 text-right">
                  {form.cover_letter.length} / 5000
                </div>
              </div>

              {errorMsg && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                  <div className="flex items-start gap-2 text-sm text-rose-700">
                    <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-medium">{errorMsg}</p>
                      {issues && issues.length > 0 && (
                        <ul className="mt-1 text-xs space-y-0.5">
                          {issues.map((i, k) => (
                            <li key={k}>• <strong>{i.field}</strong> : {i.message}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <p className="text-[10px] text-slate-500 leading-relaxed">
                En soumettant ce formulaire, vous acceptez que {tenant.name} utilise vos données
                à des fins de recrutement. Vous pouvez demander leur suppression à tout moment.
                Voir notre <a href="#" className="underline">politique de confidentialité</a>.
              </p>

              <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200">
                <button type="button" onClick={onClose}
                  className="text-sm text-slate-500 hover:text-slate-700">Annuler</button>
                <button type="submit" disabled={!canSubmit || submit.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-md disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:-translate-y-0.5 disabled:hover:translate-y-0"
                  style={{ background: `linear-gradient(135deg, ${tenant.primaryColor} 0%, ${tenant.secondaryColor} 100%)` }}>
                  {submit.isPending
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Envoi…</>
                    : <><Send className="h-4 w-4" /> Envoyer ma candidature</>}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
