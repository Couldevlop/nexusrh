import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { api } from '@/lib/api'
import { Loader2, ArrowLeft, Database } from 'lucide-react'
import { MODULE_DEFAULTS, MODULE_KEYS, type ModuleKey } from '@/lib/modules'
import { ModuleTogglesGrid } from '@/components/shared/ModuleTogglesGrid'

const schema = z.object({
  name:           z.string().min(2, 'nameRequired'),
  slug:           z.string().min(2).regex(/^[a-z0-9-]+$/, 'slugFormat'),
  planType:       z.enum(['trial', 'starter', 'business', 'enterprise', 'public_sector']),
  sector:         z.string().min(1, 'sectorRequired'),
  city:           z.string().min(1, 'cityRequired'),
  cnpsNumber:     z.string().optional(),
  dgiNumber:      z.string().optional(),
  adminEmail:     z.string().email('emailInvalid'),
  adminFirstName: z.string().min(1, 'firstNameRequired'),
  adminLastName:  z.string().min(1, 'lastNameRequired'),
  adminPhone:     z.string().optional(),
  primaryColor:   z.string().default('#E85D04'),
  secondaryColor: z.string().default('#F48C06'),
  seedDemoData:   z.boolean().default(false),
  // Option filiales multi-pays (opt-in, désactivée par défaut)
  hasSubsidiaries: z.boolean().default(false),
  defaultCountryCode: z.string().length(3).default('CIV'),
})
type FormData = z.infer<typeof schema>

const SECTORS = [
  { value: 'commerce',   atRate: '2%' },
  { value: 'services',   atRate: '2%' },
  { value: 'finance',    atRate: '2%' },
  { value: 'education',  atRate: '2%' },
  { value: 'sante',      atRate: '3%' },
  { value: 'btp',        atRate: '3%' },
  { value: 'transport',  atRate: '3%' },
  { value: 'industrie',  atRate: '4%' },
  { value: 'agriculture',atRate: '4%' },
  { value: 'extraction', atRate: '5%' },
  { value: 'public',     atRate: '2%' },
]
const CITIES = ['Abidjan', 'Bouaké', 'San-Pédro', 'Daloa', 'Man', 'Yamoussoukro', 'Korhogo', 'Divo']

export default function PlatformTenantNew() {
  const { t } = useTranslation('platform')
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ tempPassword: string; adminEmail: string; seeded?: boolean; modulesCount?: number } | null>(null)
  // Modules à activer dès la création — pré-cochés selon MODULE_DEFAULTS
  // (dg_view décoché par défaut, comme partout ailleurs dans le produit).
  const [modules, setModules] = useState<Record<ModuleKey, boolean>>({ ...MODULE_DEFAULTS })
  const enabledModulesCount = MODULE_KEYS.filter((k) => modules[k]).length

  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      planType: 'trial', sector: 'services', city: 'Abidjan',
      primaryColor: '#E85D04', secondaryColor: '#F48C06',
      seedDemoData: false,
      hasSubsidiaries: false, defaultCountryCode: 'CIV',
    },
  })

  const selectedSector = watch('sector')
  const hasSubsidiaries = watch('hasSubsidiaries')
  const atRate = SECTORS.find(s => s.value === selectedSector)?.atRate ?? '2%'
  // Les messages d'erreur Zod sont des clés i18n → traduites à l'affichage.
  const fieldError = (key?: string) => (key ? t(`tenantNew.errors.${key}`) : undefined)

  const onSubmit = async (data: FormData) => {
    setError(null)
    try {
      // Si hasSubsidiaries=true → payrollMode='multi_country' (côté API c'est garanti
      // aussi, mais l'expliciter ici facilite le débogage réseau)
      const payload = {
        ...data,
        payrollMode: data.hasSubsidiaries ? 'multi_country' : 'single_country',
        // Carte { moduleKey: boolean } — même forme que PUT /tenants/:id/modules.
        modules,
      }
      const res = await api.post('/platform/tenants', payload)
      setResult({
        tempPassword: res.data.tempPassword,
        adminEmail: res.data.adminEmail,
        seeded: data.seedDemoData,
        modulesCount: enabledModulesCount,
      })
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setError(e.response?.data?.error ?? t('tenantNew.errors.createError'))
    }
  }

  if (result) {
    return (
      <div className="p-6 max-w-lg mx-auto">
        <div className="rounded-xl border border-green-200 bg-green-50 p-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <span className="text-2xl">✓</span>
          </div>
          <h2 className="text-lg font-bold text-green-800 mb-2">{t('tenantNew.successTitle')}</h2>
          <p className="text-sm text-green-700 mb-4">
            {t('tenantNew.successDesc')}
            {result.seeded && t('tenantNew.successSeeded')}
          </p>
          <div className="rounded-lg bg-white p-4 text-left text-sm mb-4 border border-green-200">
            <p><strong>{t('tenantNew.adminEmail')}</strong> {result.adminEmail}</p>
            <p className="mt-1"><strong>{t('tenantNew.tempPassword')}</strong>{' '}
              <code className="rounded bg-muted px-1 font-mono">{result.tempPassword}</code>
            </p>
            {typeof result.modulesCount === 'number' && (
              <p className="mt-1">
                <strong>{t('tenantNew.modules.activeLabel')}</strong>{' '}
                {t('tenantNew.modules.activeCount', { count: result.modulesCount })}
              </p>
            )}
          </div>
          <div className="flex gap-2 justify-center">
            <button onClick={() => navigate('/platform/tenants')}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700">
              {t('tenantNew.viewTenants')}
            </button>
            <button onClick={() => { setResult(null) }}
              className="rounded-lg border border-green-300 px-4 py-2 text-sm text-green-700 hover:bg-green-100">
              {t('tenantNew.createAnother')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <button onClick={() => navigate(-1)} className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {t('tenantNew.back')}
      </button>

      <h1 className="text-2xl font-bold mb-6">{t('tenantNew.title')}</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Informations entreprise */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4">{t('tenantNew.step1')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="text-sm font-medium">{t('tenantNew.fields.name')}</label>
              <input {...register('name')} placeholder="SOTRA" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.name && <p className="text-xs text-destructive mt-1">{fieldError(errors.name.message)}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.slug')}</label>
              <input {...register('slug')} placeholder="sotra" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.slug && <p className="text-xs text-destructive mt-1">{fieldError(errors.slug.message)}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.plan')}</label>
              <select {...register('planType')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none bg-background">
                <option value="trial">{t('tenantNew.planOptions.trial')}</option>
                <option value="starter">{t('tenantNew.planOptions.starter')}</option>
                <option value="business">{t('tenantNew.planOptions.business')}</option>
                <option value="enterprise">{t('tenantNew.planOptions.enterprise')}</option>
                <option value="public_sector">{t('tenantNew.planOptions.public_sector')}</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.sector')}</label>
              <select {...register('sector')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none bg-background">
                {SECTORS.map(s => (
                  <option key={s.value} value={s.value}>{t(`tenantNew.sectors.${s.value}`)}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">{t('tenantNew.atRate', { rate: atRate })}</p>
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.city')}</label>
              <select {...register('city')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none bg-background">
                {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.cnpsNumber')}</label>
              <input {...register('cnpsNumber')} placeholder="CI000123456" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.dgiNumber')}</label>
              <input {...register('dgiNumber')} placeholder="DGI-ABJ-2024-XXXX" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
          </div>
        </section>

        {/* Admin */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4">{t('tenantNew.step2')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.firstName')}</label>
              <input {...register('adminFirstName')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.adminFirstName && <p className="text-xs text-destructive mt-1">{fieldError(errors.adminFirstName.message)}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.lastName')}</label>
              <input {...register('adminLastName')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.adminLastName && <p className="text-xs text-destructive mt-1">{fieldError(errors.adminLastName.message)}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.adminEmail')}</label>
              <input {...register('adminEmail')} type="email" placeholder="admin@entreprise.ci" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
              {errors.adminEmail && <p className="text-xs text-destructive mt-1">{fieldError(errors.adminEmail.message)}</p>}
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.phone')}</label>
              <input {...register('adminPhone')} placeholder="+225 07 XX XX XX XX" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
          </div>
        </section>

        {/* Apparence */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4">{t('tenantNew.step3')}</h2>
          <div className="flex gap-6">
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.primaryColor')}</label>
              <div className="mt-1 flex items-center gap-2">
                <input {...register('primaryColor')} type="color" className="h-9 w-9 rounded cursor-pointer border border-input" />
                <input {...register('primaryColor')} type="text" className="w-24 rounded-lg border px-2 py-2 text-sm font-mono focus:ring-2 focus:ring-ring outline-none" />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">{t('tenantNew.fields.secondaryColor')}</label>
              <div className="mt-1 flex items-center gap-2">
                <input {...register('secondaryColor')} type="color" className="h-9 w-9 rounded cursor-pointer border border-input" />
                <input {...register('secondaryColor')} type="text" className="w-24 rounded-lg border px-2 py-2 text-sm font-mono focus:ring-2 focus:ring-ring outline-none" />
              </div>
            </div>
          </div>
        </section>

        {/* Données de démonstration */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-3">{t('tenantNew.step4')}</h2>
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              {...register('seedDemoData')}
              className="mt-0.5 h-4 w-4 rounded border-input accent-primary cursor-pointer"
            />
            <div>
              <div className="flex items-center gap-2 text-sm font-medium group-hover:text-primary transition-colors">
                <Database className="h-4 w-4 shrink-0" />
                {t('tenantNew.seedDemo.label')}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('tenantNew.seedDemo.hint')}
              </p>
            </div>
          </label>
        </section>

        {/* Multi-pays / filiales — opt-in */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-1">{t('tenantNew.step5')}</h2>
          <p className="text-xs text-muted-foreground mb-3">
            {t('tenantNew.subsidiaries.intro')}
          </p>
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              {...register('hasSubsidiaries')}
              className="mt-0.5 h-4 w-4 rounded border-input accent-primary cursor-pointer"
            />
            <div className="flex-1">
              <div className="text-sm font-medium group-hover:text-primary transition-colors">
                {t('tenantNew.subsidiaries.label')}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('tenantNew.subsidiaries.hint')}
              </p>
            </div>
          </label>
          {hasSubsidiaries && (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <label className="text-xs font-medium text-muted-foreground">{t('tenantNew.subsidiaries.defaultCountry')}</label>
              <select {...register('defaultCountryCode')} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-background">
                <option value="CIV">{t('tenantNew.countries.CIV')}</option>
                <option value="BFA">{t('tenantNew.countries.BFA')}</option>
                <option value="SEN">{t('tenantNew.countries.SEN')}</option>
                <option value="MLI">{t('tenantNew.countries.MLI')}</option>
                <option value="TGO">{t('tenantNew.countries.TGO')}</option>
                <option value="BEN">{t('tenantNew.countries.BEN')}</option>
                <option value="NER">{t('tenantNew.countries.NER')}</option>
                <option value="GNB">{t('tenantNew.countries.GNB')}</option>
              </select>
              <p className="mt-2 text-[11px] text-primary/80">
                {t('tenantNew.subsidiaries.afterCreate')}
              </p>
            </div>
          )}
        </section>

        {/* Modules à activer — pré-cochés selon les défauts produit */}
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-semibold">{t('tenantNew.modules.title')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('tenantNew.modules.activeCount', { count: enabledModulesCount })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            {t('tenantNew.modules.intro')}
          </p>
          <ModuleTogglesGrid
            values={modules}
            onToggle={(key, enabled) => setModules((prev) => ({ ...prev, [key]: enabled }))}
            disabled={isSubmitting}
          />
        </section>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <button type="submit" disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {isSubmitting ? t('tenantNew.submitting') : t('tenantNew.submit')}
        </button>
      </form>
    </div>
  )
}
