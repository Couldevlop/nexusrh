import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Check, Loader2, Bot, BarChart3, PenTool, Globe, Monitor, Zap, Shield, Database, Bell } from 'lucide-react'
import api from '@/lib/api'
import { cn } from '@/lib/utils'

interface PlatformSettings {
  appName: string
  appUrl: string
  features: {
    aiAssistant: boolean
    predictiveAnalytics: boolean
    electronicSignature: boolean
    multiCountry: boolean
    kioskMode: boolean
  }
}

const FEATURE_META = [
  {
    key: 'aiAssistant',
    label: 'Assistant IA',
    description: 'Chatbot RH propulsé par Claude, génération de documents, scoring de rétention.',
    icon: Bot,
    color: 'bg-violet-100 text-violet-600',
    badge: 'Recommandé',
    badgeColor: 'bg-violet-100 text-violet-700',
  },
  {
    key: 'predictiveAnalytics',
    label: 'Analytique prédictive',
    description: 'Prédiction des risques de départ, scoring burnout, alertes préventives.',
    icon: BarChart3,
    color: 'bg-blue-100 text-blue-600',
    badge: 'Pro+',
    badgeColor: 'bg-blue-100 text-blue-700',
  },
  {
    key: 'electronicSignature',
    label: 'Signature électronique',
    description: 'Signature de contrats et documents RH directement dans la plateforme.',
    icon: PenTool,
    color: 'bg-emerald-100 text-emerald-600',
    badge: null,
    badgeColor: '',
  },
  {
    key: 'multiCountry',
    label: 'Multi-pays',
    description: 'Support de la paie et des règles légales dans plusieurs pays (Beta).',
    icon: Globe,
    color: 'bg-amber-100 text-amber-600',
    badge: 'Beta',
    badgeColor: 'bg-amber-100 text-amber-700',
  },
  {
    key: 'kioskMode',
    label: 'Mode kiosque',
    description: 'Interface self-service simplifiée pour les tablettes en espace commun.',
    icon: Monitor,
    color: 'bg-pink-100 text-pink-600',
    badge: null,
    badgeColor: '',
  },
]

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none',
        checked ? 'bg-violet-600' : 'bg-gray-200'
      )}
    >
      <motion.span
        animate={{ x: checked ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="inline-block h-5 w-5 rounded-full bg-white shadow"
      />
    </button>
  )
}

export function PlatformSettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['platform-settings'],
    queryFn: async () => {
      const res = await api.get<{ data: PlatformSettings }>('/platform/settings')
      return res.data.data
    },
  })

  const [features, setFeatures] = useState<PlatformSettings['features'] | null>(null)
  const [saved, setSaved] = useState(false)

  const currentFeatures = features ?? data?.features

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Settings are environment-driven; in real prod this would call a PATCH endpoint
      await new Promise(r => setTimeout(r, 800))
    },
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  function toggleFeature(key: keyof PlatformSettings['features']) {
    setFeatures(prev => ({
      ...(prev ?? data?.features ?? {}),
      [key]: !(currentFeatures?.[key] ?? false),
    } as PlatformSettings['features']))
  }

  const enabledCount = Object.values(currentFeatures ?? {}).filter(Boolean).length

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
        <h1 className="text-2xl font-bold text-gray-900">Paramètres plateforme</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configuration globale de NexusRH</p>
      </motion.div>

      {/* Platform info */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-50">
          <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center">
            <Database size={15} className="text-slate-600" />
          </div>
          <h2 className="text-sm font-semibold text-gray-800">Informations plateforme</h2>
        </div>
        <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-3 gap-5">
          {isLoading ? (
            [...Array(3)].map((_, i) => <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />)
          ) : ([
            { label: 'Nom de l\'application', value: data?.appName ?? '—', icon: Zap },
            { label: 'URL de la plateforme', value: data?.appUrl ?? '—', icon: Globe },
            { label: 'Modules actifs', value: `${enabledCount} / ${FEATURE_META.length}`, icon: Shield },
          ]).map(item => (
            <div key={item.label} className="bg-gray-50 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <item.icon size={14} className="text-gray-400" />
                <p className="text-xs text-gray-400 font-medium">{item.label}</p>
              </div>
              <p className="text-sm font-bold text-gray-800">{item.value}</p>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Feature flags */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
        className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-50">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center">
              <Zap size={15} className="text-violet-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Modules & Fonctionnalités</h2>
              <p className="text-xs text-gray-400">Activez ou désactivez les modules pour tous les tenants</p>
            </div>
          </div>
          <span className="text-xs font-semibold text-violet-700 bg-violet-50 px-2.5 py-1 rounded-full border border-violet-100">
            {enabledCount} actif{enabledCount > 1 ? 's' : ''}
          </span>
        </div>

        <div className="divide-y divide-gray-50">
          {isLoading ? (
            [...Array(5)].map((_, i) => <div key={i} className="h-20 mx-5 my-3 bg-gray-100 rounded-xl animate-pulse" />)
          ) : FEATURE_META.map((feat) => {
            const isEnabled = currentFeatures?.[feat.key as keyof PlatformSettings['features']] ?? false
            return (
              <motion.div key={feat.key} layout
                className={cn('flex items-start gap-4 px-6 py-5 transition-colors', isEnabled ? 'bg-white' : 'bg-gray-50/50')}>
                <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all', feat.color)}>
                  <feat.icon size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-gray-900">{feat.label}</span>
                    {feat.badge && (
                      <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full', feat.badgeColor)}>
                        {feat.badge}
                      </span>
                    )}
                    {isEnabled && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full font-semibold">
                        <span className="w-1 h-1 rounded-full bg-emerald-500 inline-block" /> Actif
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">{feat.description}</p>
                </div>
                <Toggle checked={isEnabled} onChange={() => toggleFeature(feat.key as keyof PlatformSettings['features'])} />
              </motion.div>
            )
          })}
        </div>

        <div className="px-6 py-4 border-t border-gray-50 flex items-center justify-between bg-gray-50/50">
          <p className="text-xs text-gray-400">
            Les modifications s'appliquent à tous les tenants actifs après sauvegarde.
          </p>
          <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || saved}
            className={cn(
              'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all',
              saved ? 'bg-emerald-500 cursor-default' : 'bg-violet-600 hover:bg-violet-700'
            )}>
            {saveMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
            {saved ? 'Sauvegardé !' : 'Sauvegarder'}
          </button>
        </div>
      </motion.div>

      {/* Notifications / Alertes */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
        className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-50">
          <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center">
            <Bell size={15} className="text-amber-600" />
          </div>
          <h2 className="text-sm font-semibold text-gray-800">Alertes automatiques</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          {[
            { label: 'Alerte trial expirant sous 7 jours', enabled: true },
            { label: 'Résumé hebdomadaire de la plateforme', enabled: true },
            { label: 'Notification de tenant suspendu', enabled: true },
            { label: 'Rapport mensuel MRR', enabled: false },
          ].map(item => (
            <div key={item.label} className="flex items-center justify-between">
              <span className="text-sm text-gray-700">{item.label}</span>
              <Toggle checked={item.enabled} onChange={() => {}} />
            </div>
          ))}
        </div>
      </motion.div>

      {/* Danger zone */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
        className="bg-red-50/50 rounded-2xl border border-red-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-red-100">
          <h2 className="text-sm font-semibold text-red-700">Zone de danger</h2>
          <p className="text-xs text-red-400 mt-0.5">Actions irréversibles — à utiliser avec précaution</p>
        </div>
        <div className="px-6 py-5 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-800">Purger les logs anciens</p>
            <p className="text-xs text-gray-400 mt-0.5">Supprimer les logs de plus de 90 jours</p>
          </div>
          <button className="px-4 py-2 border border-red-200 text-red-600 rounded-xl text-sm font-medium hover:bg-red-100 transition-colors">
            Purger
          </button>
        </div>
      </motion.div>
    </div>
  )
}
