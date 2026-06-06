import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  Briefcase, MapPin, Clock, Send, CheckCircle2,
  Loader2, Search, Banknote, AlertCircle, FileText, ArrowRight, X,
} from 'lucide-react'
import { api } from '../../lib/api'
import { apecMetaPairs } from '../../lib/apec'
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher'
import i18n from '@/i18n'

interface PublicJob {
  id: string
  title: string
  location: string | null
  contract_type: string | null
  salary_min: number | null
  salary_max: number | null
  currency: string | null
  description: string | null
  requirements: string | null
  public_slug: string | null
  created_at: string
  published_at: string | null
  applications_count: number
  // ── Champs APEC ──
  reference?: string | null
  experience_level?: string | null
  job_level?: string | null
  sector?: string | null
  required_education?: string | null
  benefits?: string | null
  work_mode?: string | null
  start_date?: string | null
  recruitment_process?: string | null
}

interface CareersResponse {
  tenant: {
    name: string; slug: string; city: string | null; sector: string | null
    primaryColor: string; secondaryColor: string; logoUrl: string | null
  }
  data: PublicJob[]
  count: number
}

interface ApplyResponse {
  data: { id: string; jobTitle: string; companyName: string }
  message: string
}

// Libellés de contrat : clé technique (= valeur API) → libellé d'affichage i18n.
const CONTRACT_KEYS: Record<string, string> = {
  cdi: 'cdi', cdd: 'cdd', stage: 'stage', freelance: 'freelance',
  apprentissage: 'apprentissage', interim: 'interim',
}

function contractLabel(code: string): string {
  const key = CONTRACT_KEYS[code]
  return key ? i18n.t(`publicPages:contractTypes.${key}`) : code
}

// Upload CV : doit refléter l'allowlist serveur (cv-extraction.service.ts)
const CV_ACCEPT = '.pdf,.doc,.docx,.txt'
const CV_MAX_BYTES_PUBLIC = 5 * 1024 * 1024 // 5 Mo (aligné CV_MAX_BYTES_PUBLIC API)

function formatSalary(min: number | null, max: number | null, currency: string | null): string | null {
  if (!min && !max) return null
  const cur = currency || 'XOF'
  const fmt = (n: number) => new Intl.NumberFormat('fr-FR').format(n)
  if (min && max) return `${fmt(min)} – ${fmt(max)} ${cur}`
  if (min) return i18n.t('publicPages:salary.from', { value: `${fmt(min)} ${cur}` })
  return i18n.t('publicPages:salary.upTo', { value: `${fmt(max!)} ${cur}` })
}

function timeAgo(dateStr: string): string {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  if (days === 0) return i18n.t('publicPages:timeAgo.today')
  if (days === 1) return i18n.t('publicPages:timeAgo.yesterday')
  if (days < 7) return i18n.t('publicPages:timeAgo.days', { count: days })
  if (days < 30) return i18n.t('publicPages:timeAgo.weeks', { count: Math.floor(days / 7) })
  return i18n.t('publicPages:timeAgo.months', { count: Math.floor(days / 30) })
}

export default function PublicCareersPage() {
  const { t } = useTranslation('publicPages')
  const { tenantSlug } = useParams<{ tenantSlug: string }>()
  const [search, setSearch] = useState('')
  // Flux façon APEC : la carte montre un aperçu → on ouvre le détail complet,
  // depuis lequel on lance la candidature.
  const [detailJob, setDetailJob] = useState<PublicJob | null>(null)
  const [applyJob, setApplyJob] = useState<PublicJob | null>(null)

  const { data, isLoading, isError } = useQuery<CareersResponse>({
    queryKey: ['public-careers', tenantSlug],
    queryFn: () => api.get(`/recruitment/public/${tenantSlug}/jobs`).then(r => r.data),
    enabled: !!tenantSlug,
  })

  const filtered = (data?.data ?? []).filter(j =>
    !search ||
    j.title.toLowerCase().includes(search.toLowerCase()) ||
    (j.description ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 px-4 text-center">
        <AlertCircle className="h-12 w-12 text-red-400" />
        <h1 className="text-xl font-semibold text-slate-800">{t('error.notFoundTitle')}</h1>
        <p className="text-slate-500">{t('error.notFoundText')}</p>
      </div>
    )
  }

  const { tenant } = data
  const primary = tenant.primaryColor || '#E85D04'

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header avec branding tenant */}
      <header className="border-b bg-white" style={{ borderTopColor: primary, borderTopWidth: 4 }}>
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-6">
          {tenant.logoUrl ? (
            <img src={tenant.logoUrl} alt={tenant.name} className="h-12 w-12 rounded-lg object-contain" />
          ) : (
            <div
              className="flex h-12 w-12 items-center justify-center rounded-lg text-lg font-bold text-white"
              style={{ backgroundColor: primary }}
            >
              {tenant.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-xl font-bold text-slate-900">{tenant.name}</h1>
            <p className="text-sm text-slate-500">
              {tenant.sector && <span className="capitalize">{tenant.sector}</span>}
              {tenant.city && <span> · {tenant.city}</span>}
            </p>
          </div>
          <div className="ml-auto">
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      {/* Hero */}
      <div className="border-b bg-white">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <h2 className="text-2xl font-bold text-slate-900">{t('hero.title')}</h2>
          <p className="mt-1 text-slate-500">
            {t('hero.openPositions', { count: data.count })}
          </p>
          {/* Recherche */}
          <div className="relative mt-4 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('hero.searchPlaceholder')}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-10 pr-4 text-sm outline-none focus:border-slate-400"
            />
          </div>
        </div>
      </div>

      {/* Liste des offres */}
      <main className="mx-auto max-w-5xl px-4 py-8">
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center">
            <Briefcase className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-slate-500">{t('list.empty')}</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {filtered.map(job => (
              <JobPreviewCard key={job.id} job={job} primary={primary} onView={() => setDetailJob(job)} />
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-white py-6 text-center text-sm text-slate-400">
        <Trans
          i18nKey="footer.poweredBy"
          ns="publicPages"
          components={{ brand: <span className="font-semibold text-slate-600" /> }}
        />
      </footer>

      {/* Modal détail offre (aperçu → intégralité, façon APEC) */}
      {detailJob && (
        <JobDetailModal
          job={detailJob}
          primary={primary}
          onClose={() => setDetailJob(null)}
          onApply={() => { setApplyJob(detailJob); setDetailJob(null) }}
        />
      )}

      {/* Modal candidature */}
      {applyJob && (
        <ApplyDialog
          job={applyJob}
          tenantSlug={tenantSlug!}
          primary={primary}
          onClose={() => setApplyJob(null)}
        />
      )}
    </div>
  )
}

// ── Carte aperçu (façon APEC) : titre + méta + extrait + « Voir l'offre » ─────
function JobPreviewCard({ job, primary, onView }: {
  job: PublicJob; primary: string; onView: () => void
}) {
  const { t } = useTranslation('publicPages')
  const salary = formatSalary(job.salary_min, job.salary_max, job.currency)
  return (
    <article className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <h3 className="text-lg font-semibold text-slate-900 line-clamp-2">{job.title}</h3>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
        {job.location && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" /> {job.location}
          </span>
        )}
        {job.contract_type && (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {contractLabel(job.contract_type)}
          </span>
        )}
        {(job.published_at || job.created_at) && (
          <span className="text-slate-400">{timeAgo(job.published_at ?? job.created_at)}</span>
        )}
      </div>
      {job.description && (
        <p className="mt-3 line-clamp-2 flex-1 text-sm text-slate-600">{job.description}</p>
      )}
      <div className="mt-4 flex items-center justify-between">
        {salary ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700">
            <Banknote className="h-4 w-4" /> {salary}
          </span>
        ) : <span />}
        <button
          onClick={onView}
          className="inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-semibold transition hover:bg-slate-50"
          style={{ color: primary, borderColor: primary }}
        >
          {t('card.viewOffer')} <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </article>
  )
}

// ── Détail complet de l'offre (description + prérequis intégraux) ─────────────
function JobDetailModal({ job, primary, onClose, onApply }: {
  job: PublicJob; primary: string; onClose: () => void; onApply: () => void
}) {
  const { t } = useTranslation('publicPages')
  const salary = formatSalary(job.salary_min, job.salary_max, job.currency)
  return (
    <Dialog onClose={onClose}>
      <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">{job.title}</h3>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
            {job.location && (
              <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> {job.location}</span>
            )}
            {job.contract_type && (
              <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {contractLabel(job.contract_type)}</span>
            )}
            {(job.published_at || job.created_at) && (
              <span className="text-slate-400">{timeAgo(job.published_at ?? job.created_at)}</span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label={t('common.close')}>
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="space-y-5 px-6 py-5">
        {salary && (
          <div className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
            <Banknote className="h-4 w-4" /> {salary}
          </div>
        )}
        {apecMetaPairs(job).length > 0 && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-slate-50 p-4 sm:grid-cols-3">
            {apecMetaPairs(job).map(({ label, value }) => (
              <div key={label}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                <p className="text-sm font-medium text-slate-800">{value}</p>
              </div>
            ))}
          </div>
        )}
        {job.description && (
          <section>
            <h4 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('detail.jobDescription')}</h4>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{job.description}</p>
          </section>
        )}
        {job.requirements && (
          <section>
            <h4 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('detail.profileSought')}</h4>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{job.requirements}</p>
          </section>
        )}
        {job.benefits && (
          <section>
            <h4 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('detail.benefits')}</h4>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{job.benefits}</p>
          </section>
        )}
        {job.recruitment_process && (
          <section>
            <h4 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('detail.recruitmentProcess')}</h4>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{job.recruitment_process}</p>
          </section>
        )}
      </div>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-white px-6 py-4">
        <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
          {t('common.close')}
        </button>
        <button
          onClick={onApply}
          className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          style={{ backgroundColor: primary }}
        >
          <Send className="h-4 w-4" /> {t('detail.apply')}
        </button>
      </div>
    </Dialog>
  )
}

function ApplyDialog({ job, tenantSlug, primary, onClose }: {
  job: PublicJob; tenantSlug: string; primary: string; onClose: () => void
}) {
  const { t } = useTranslation('publicPages')
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', cover_letter: '', expected_salary: '',
  })
  const [cvFile, setCvFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const mutation = useMutation({
    mutationFn: (payload: typeof form) => {
      // multipart si un CV est joint (le serveur accepte JSON OU multipart) ;
      // sinon JSON simple (compat historique).
      if (cvFile) {
        const fd = new FormData()
        fd.append('first_name', payload.first_name)
        fd.append('last_name', payload.last_name)
        fd.append('email', payload.email)
        if (payload.phone) fd.append('phone', payload.phone)
        if (payload.cover_letter) fd.append('cover_letter', payload.cover_letter)
        if (payload.expected_salary) fd.append('expected_salary', payload.expected_salary)
        fd.append('cv', cvFile)
        return api.post(`/recruitment/public/${tenantSlug}/jobs/${job.id}/apply`, fd)
          .then(r => r.data as ApplyResponse)
      }
      const json: Record<string, unknown> = {
        first_name: payload.first_name, last_name: payload.last_name, email: payload.email,
      }
      if (payload.phone) json.phone = payload.phone
      if (payload.cover_letter) json.cover_letter = payload.cover_letter
      if (payload.expected_salary) json.expected_salary = Number(payload.expected_salary)
      return api.post(`/recruitment/public/${tenantSlug}/jobs/${job.id}/apply`, json)
        .then(r => r.data as ApplyResponse)
    },
    onSuccess: () => setDone(true),
  })

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null)
    const f = e.target.files?.[0] ?? null
    if (f && f.size > CV_MAX_BYTES_PUBLIC) {
      setFileError(t('apply.cvTooLarge'))
      e.target.value = ''
      return
    }
    setCvFile(f)
  }

  if (done) {
    return (
      <Dialog onClose={onClose}>
        <div className="flex flex-col items-center gap-3 p-6 text-center">
          <CheckCircle2 className="h-14 w-14 text-emerald-500" />
          <h3 className="text-lg font-semibold text-slate-900">{t('apply.successTitle')}</h3>
          <p className="text-sm text-slate-600">
            {t('apply.successText')}
          </p>
          <button
            onClick={onClose}
            className="mt-2 rounded-lg px-5 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: primary }}
          >
            {t('common.close')}
          </button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog onClose={onClose}>
      <div className="border-b px-6 py-4">
        <h3 className="text-lg font-semibold text-slate-900">{t('apply.title', { title: job.title })}</h3>
      </div>
      <form
        onSubmit={e => { e.preventDefault(); mutation.mutate(form) }}
        className="space-y-3 p-6"
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('apply.firstName')}>
            <input
              required value={form.first_name}
              onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </Field>
          <Field label={t('apply.lastName')}>
            <input
              required value={form.last_name}
              onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </Field>
        </div>
        <Field label={t('apply.email')}>
          <input
            type="email" required value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('apply.phone')}>
            <input
              value={form.phone}
              onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </Field>
          <Field label={t('apply.expectedSalary')}>
            <input
              type="number" min={0} value={form.expected_salary}
              onChange={e => setForm(f => ({ ...f, expected_salary: e.target.value }))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </Field>
        </div>
        <Field label={t('apply.cvLabel')}>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-sm text-slate-600 hover:border-slate-400">
            <FileText className="h-4 w-4 text-slate-400" />
            <span className="truncate">{cvFile ? cvFile.name : t('apply.chooseFile')}</span>
            <input type="file" accept={CV_ACCEPT} onChange={onPickFile} className="hidden" />
          </label>
          {fileError && <span className="mt-1 block text-xs text-red-600">{fileError}</span>}
        </Field>
        <Field label={t('apply.coverLetter')}>
          <textarea
            rows={5} value={form.cover_letter}
            onChange={e => setForm(f => ({ ...f, cover_letter: e.target.value }))}
            className="w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
          />
        </Field>
        {mutation.isError && (
          <p className="text-sm text-red-600">
            {(mutation.error as { response?: { data?: { error?: string } } })?.response?.data?.error
              ?? t('apply.genericError')}
          </p>
        )}
        <button
          type="submit" disabled={mutation.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          style={{ backgroundColor: primary }}
        >
          {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t('apply.submit')}
        </button>
      </form>
    </Dialog>
  )
}

function Dialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}
