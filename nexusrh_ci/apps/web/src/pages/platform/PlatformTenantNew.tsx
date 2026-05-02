import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/lib/api'
import { Loader2, ArrowLeft } from 'lucide-react'

const schema = z.object({
  name:           z.string().min(2, 'Nom requis'),
  slug:           z.string().min(2).regex(/^[a-z0-9-]+$/, 'Slug: minuscules, chiffres et tirets uniquement'),
  planType:       z.enum(['trial', 'starter', 'business', 'enterprise', 'public_sector']),
  sector:         z.string().min(1, 'Secteur requis'),
  city:           z.string().min(1, 'Ville requise'),
  cnpsNumber:     z.string().optional(),
  dgiNumber:      z.string().optional(),
  adminEmail:     z.string().email('Email invalide'),
  adminFirstName: z.string().min(1, 'Prénom requis'),
  adminLastName:  z.string().min(1, 'Nom requis'),
  adminPhone:     z.string().optional(),
  primaryColor:   z.string().default('#E85D04'),
  secondaryColor: z.string().default('#F48C06'),
})
type FormData = z.infer<typeof schema>

const SECTORS = [
  { value: 'commerce',   label: 'Commerce & Distribution',   atRate: '2%' },
  { value: 'services',   label: 'Services & Conseil',        atRate: '2%' },
  { value: 'finance',    label: 'Finance & Banque',          atRate: '2%' },
  { value: 'education',  label: 'Éducation & Formation',     atRate: '2%' },
  { value: 'sante',      label: 'Santé',                     atRate: '3%' },
  { value: 'btp',        label: 'BTP & Construction',        atRate: '3%' },
  { value: 'transport',  label: 'Transport & Logistique',    atRate: '3%' },
  { value: 'industrie',  label: 'Industrie & Manufacture',   atRate: '4%' },
  { value: 'agriculture',label: 'Agriculture',               atRate: '4%' },
  { value: 'extraction', label: 'Extraction & Mines',        atRate: '5%' },
  { value: 'public',     label: 'Secteur public & ONG',      atRate: '2%' },
]
const CITIES = ['Abidjan', 'Bouaké', 'San-Pédro', 'Daloa', 'Man', 'Yamoussoukro', 'Korhogo', 'Divo']

export default function PlatformTenantNew() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ tempPassword: string; adminEmail: string } | null>(null)

  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { planType: 'trial', sector: 'services', city: 'Abidjan', primaryColor: '#E85D04', secondaryColor: '#F48C06' },
  })

  const selectedSector = watch('sector')
  const atRate = SECTORS.find(s => s.value === selectedSector)?.atRate ?? '2%'

  const onSubmit = async (data: FormData) => {
    setError(null)
    try {
      const res = await api.post('/platform/tenants', data)
      setResult({ tempPassword: res.data.tempPassword, adminEmail: res.data.adminEmail })
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setError(e.response?.data?.error ?? 'Erreur lors de la création')
    }
  }

  if (result) {
    return (
      <div className="p-6 max-w-lg mx-auto">
        <div className="rounded-xl border border-green-200 bg-green-50 p-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <span className="text-2xl">✓</span>
          </div>
          <h2 className="text-lg font-bold text-green-800 mb-2">Tenant créé avec succès</h2>
          <p className="text-sm text-green-700 mb-4">
            L'admin a été créé avec un mot de passe temporaire.
          </p>
          <div className="rounded-lg bg-white p-4 text-left text-sm mb-4 border border-green-200">
            <p><strong>Email admin :</strong> {result.adminEmail}</p>
            <p className="mt-1"><strong>Mot de passe temporaire :</strong>{' '}
              <code className="rounded bg-muted px-1 font-mono">{result.tempPassword}</code>
            </p>
          </div>
          <div className="flex gap-2 justify-center">
            <button onClick={() => navigate('/platform/tenants')}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700">
              Voir les tenants
            </button>
            <button onClick={() => { setResult(null) }}
              className="rounded-lg border border-green-300 px-4 py-2 text-sm text-green-700 hover:bg-green-100">
              Créer un autre
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <button onClick={() => navigate(-1)} className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Retour
      </button>

      <h1 className="text-2xl font-bold mb-6">Créer un nouveau tenant</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Informations entreprise */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4">1. Informations entreprise</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="text-sm font-medium">Nom de l'entreprise *</label>
              <input {...register('name')} placeholder="SOTRA" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">Slug *</label>
              <input {...register('slug')} placeholder="sotra" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.slug && <p className="text-xs text-destructive mt-1">{errors.slug.message}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">Plan *</label>
              <select {...register('planType')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none bg-background">
                <option value="trial">Trial (30j gratuit)</option>
                <option value="starter">Starter</option>
                <option value="business">Business</option>
                <option value="enterprise">Enterprise</option>
                <option value="public_sector">Secteur Public</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Secteur d'activité *</label>
              <select {...register('sector')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none bg-background">
                {SECTORS.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">Taux AT CNPS : {atRate}</p>
            </div>
            <div>
              <label className="text-sm font-medium">Ville *</label>
              <select {...register('city')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none bg-background">
                {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">N° CNPS employeur</label>
              <input {...register('cnpsNumber')} placeholder="CI000123456" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
            <div>
              <label className="text-sm font-medium">N° DGI</label>
              <input {...register('dgiNumber')} placeholder="DGI-ABJ-2024-XXXX" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
          </div>
        </section>

        {/* Admin */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4">2. Administrateur principal</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Prénom *</label>
              <input {...register('adminFirstName')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.adminFirstName && <p className="text-xs text-destructive mt-1">{errors.adminFirstName.message}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">Nom *</label>
              <input {...register('adminLastName')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
            <div>
              <label className="text-sm font-medium">Email admin *</label>
              <input {...register('adminEmail')} type="email" placeholder="admin@entreprise.ci" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.adminEmail && <p className="text-xs text-destructive mt-1">{errors.adminEmail.message}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">Téléphone (+225)</label>
              <input {...register('adminPhone')} placeholder="+225 07 XX XX XX XX" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
          </div>
        </section>

        {/* Apparence */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4">3. Apparence</h2>
          <div className="flex gap-6">
            <div>
              <label className="text-sm font-medium">Couleur primaire</label>
              <div className="mt-1 flex items-center gap-2">
                <input {...register('primaryColor')} type="color" className="h-9 w-9 rounded cursor-pointer border border-input" />
                <input {...register('primaryColor')} type="text" className="w-24 rounded-lg border px-2 py-2 text-sm font-mono focus:ring-2 focus:ring-ring outline-none" />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">Couleur secondaire</label>
              <div className="mt-1 flex items-center gap-2">
                <input {...register('secondaryColor')} type="color" className="h-9 w-9 rounded cursor-pointer border border-input" />
                <input {...register('secondaryColor')} type="text" className="w-24 rounded-lg border px-2 py-2 text-sm font-mono focus:ring-2 focus:ring-ring outline-none" />
              </div>
            </div>
          </div>
        </section>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <button type="submit" disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {isSubmitting ? 'Création en cours...' : 'Créer le tenant'}
        </button>
      </form>
    </div>
  )
}
