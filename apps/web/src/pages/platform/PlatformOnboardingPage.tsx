/**
 * PlatformOnboardingPage — Wizard d'onboarding première connexion super_admin.
 * 4 étapes : config plateforme → test SMTP → créer premier tenant → résumé.
 * Redirigé automatiquement par RootRedirect si needsOnboarding = true.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Settings, Mail, Building2, CheckCircle2,
  ChevronRight, ChevronLeft, Loader2, AlertCircle,
  Eye, EyeOff, Zap, Globe, Shield,
} from 'lucide-react'
import { api } from '@/lib/api'

// ── Schemas Zod ───────────────────────────────────────────────────────────────

const step1Schema = z.object({
  appName: z.string().min(2, 'Minimum 2 caractères').max(100),
  appUrl: z.string().url("URL valide requise (ex: https://nexusrh.monentreprise.com)"),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur hex invalide'),
})

const step2Schema = z.object({
  smtpHost: z.string().min(1, 'Hôte SMTP requis'),
  smtpUser: z.string().email('Email valide requis'),
  smtpPass: z.string().min(1, 'Mot de passe requis'),
  testEmail: z.string().email('Email de test valide requis'),
})

const step3Schema = z.object({
  tenantName: z.string().min(2, 'Nom minimum 2 caractères').max(255),
  tenantSlug: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, 'Minuscules, chiffres et tirets uniquement'),
  planType: z.enum(['trial', 'starter', 'pro', 'enterprise']),
  adminEmail: z.string().email('Email admin valide requis'),
  adminFirstName: z.string().min(1, 'Prénom requis'),
  adminLastName: z.string().min(1, 'Nom requis'),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().default('#4F46E5'),
})

type Step1Data = z.infer<typeof step1Schema>
type Step2Data = z.infer<typeof step2Schema>
type Step3Data = z.infer<typeof step3Schema>

// ── Composants UI légers ──────────────────────────────────────────────────────

function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${
            i < step ? 'bg-green-500 text-white' :
            i === step ? 'bg-indigo-600 text-white ring-4 ring-indigo-200' :
            'bg-gray-200 text-gray-500'
          }`}>
            {i < step ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
          </div>
          {i < total - 1 && (
            <div className={`h-0.5 w-12 transition-all ${i < step ? 'bg-green-400' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

function InputField({ label, error, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
          error ? 'border-red-400 bg-red-50' : 'border-gray-300'
        }`}
        {...props}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

// ── Page principale ───────────────────────────────────────────────────────────

export function PlatformOnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [smtpTestResult, setSmtpTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [createdTenant, setCreatedTenant] = useState<{ name: string; adminEmail: string; tempPassword?: string } | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  // ── Formulaire étape 1 ─────────────────────────────────────────────────────
  const form1 = useForm<Step1Data>({
    resolver: zodResolver(step1Schema),
    defaultValues: { appName: 'NexusRH', appUrl: 'http://localhost:3000', primaryColor: '#4F46E5' },
  })

  // ── Formulaire étape 2 ─────────────────────────────────────────────────────
  const form2 = useForm<Step2Data>({
    resolver: zodResolver(step2Schema),
    defaultValues: { smtpHost: 'smtp.gmail.com', smtpUser: '', smtpPass: '', testEmail: '' },
  })

  // ── Formulaire étape 3 ─────────────────────────────────────────────────────
  const form3 = useForm<Step3Data>({
    resolver: zodResolver(step3Schema),
    defaultValues: { tenantName: '', tenantSlug: '', planType: 'trial', adminEmail: '', adminFirstName: '', adminLastName: '', primaryColor: '#4F46E5' },
  })

  // Auto-générer le slug depuis le nom du tenant
  const tenantName = form3.watch('tenantName')
  const autoSlug = tenantName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  // ── Mutation test SMTP ─────────────────────────────────────────────────────
  const testSmtpMutation = useMutation({
    mutationFn: async (email: string) => {
      const { data } = await api.post('/platform/smtp/test', { email })
      return data
    },
    onSuccess: (data) => setSmtpTestResult(data),
    onError: () => setSmtpTestResult({ success: false, message: 'Connexion échouée — vérifiez vos paramètres SMTP' }),
  })

  // ── Mutation création tenant ───────────────────────────────────────────────
  const createTenantMutation = useMutation({
    mutationFn: async (data: Step3Data) => {
      const { data: res } = await api.post('/platform/tenants', {
        name: data.tenantName,
        slug: data.tenantSlug || autoSlug,
        planType: data.planType,
        adminEmail: data.adminEmail,
        adminFirstName: data.adminFirstName,
        adminLastName: data.adminLastName,
        primaryColor: data.primaryColor,
      })
      return res
    },
    onSuccess: (data) => {
      setCreatedTenant({
        name: data.data?.tenant?.name ?? form3.getValues('tenantName'),
        adminEmail: form3.getValues('adminEmail'),
        tempPassword: data.tempPassword,
      })
      setStep(3)
    },
  })

  // ── Mutation compléter l'onboarding ────────────────────────────────────────
  const completeOnboardingMutation = useMutation({
    mutationFn: async () => {
      await api.post('/platform/onboarding/complete')
    },
    onSuccess: () => navigate('/platform/dashboard'),
  })

  const STEP_TITLES = [
    { icon: Settings, label: 'Configuration plateforme' },
    { icon: Mail, label: 'Configuration email' },
    { icon: Building2, label: 'Premier tenant' },
    { icon: CheckCircle2, label: 'Prêt !' },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-2xl"
      >
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <div className="text-left">
              <div className="text-2xl font-bold text-gray-900">NexusRH</div>
              <div className="text-sm text-gray-500">Configuration initiale</div>
            </div>
          </div>
          <h1 className="text-xl font-semibold text-gray-800">
            Bienvenue ! Configurons votre plateforme SIRH.
          </h1>
          <p className="text-sm text-gray-500 mt-1">4 étapes — environ 5 minutes</p>
        </div>

        <StepIndicator step={step} total={4} />

        {/* Carte principale */}
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
          {/* Step header */}
          <div className="px-6 py-4 bg-gray-50 border-b flex items-center gap-3">
            {(() => { const Icon = STEP_TITLES[step]!.icon; return <Icon className="w-5 h-5 text-indigo-600" /> })()}
            <div>
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Étape {step + 1}/4</div>
              <div className="text-sm font-semibold text-gray-800">{STEP_TITLES[step]!.label}</div>
            </div>
          </div>

          <div className="p-6">
            <AnimatePresence mode="wait">
              {/* ── ÉTAPE 1 : Config plateforme ──────────────────────────── */}
              {step === 0 && (
                <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <p className="text-sm text-gray-600 mb-5">
                    Ces paramètres définissent l'identité de votre plateforme NexusRH.
                  </p>
                  <form onSubmit={form1.handleSubmit(() => setStep(1))} className="space-y-4">
                    <InputField
                      label="Nom de la plateforme"
                      placeholder="NexusRH"
                      error={form1.formState.errors.appName?.message}
                      {...form1.register('appName')}
                    />
                    <InputField
                      label="URL de l'application"
                      placeholder="https://nexusrh.monentreprise.com"
                      error={form1.formState.errors.appUrl?.message}
                      {...form1.register('appUrl')}
                    />
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Couleur principale</label>
                      <div className="flex gap-3 items-center">
                        <input type="color" className="w-12 h-10 rounded cursor-pointer border" {...form1.register('primaryColor')} />
                        <input
                          type="text"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                          placeholder="#4F46E5"
                          {...form1.register('primaryColor')}
                        />
                      </div>
                    </div>
                    <div className="flex justify-end pt-2">
                      <button type="submit" className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                        Suivant <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </form>
                </motion.div>
              )}

              {/* ── ÉTAPE 2 : Config SMTP ──────────────────────────────── */}
              {step === 1 && (
                <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <p className="text-sm text-gray-600 mb-5">
                    Configurez l'envoi d'emails pour les invitations, les bulletins et les notifications.
                    <span className="text-gray-400"> (Optionnel — vous pouvez passer cette étape)</span>
                  </p>
                  <form className="space-y-4">
                    <InputField
                      label="Serveur SMTP"
                      placeholder="smtp.gmail.com"
                      {...form2.register('smtpHost')}
                      error={form2.formState.errors.smtpHost?.message}
                    />
                    <InputField
                      label="Email SMTP"
                      type="email"
                      placeholder="vous@example.com"
                      {...form2.register('smtpUser')}
                      error={form2.formState.errors.smtpUser?.message}
                    />
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Mot de passe SMTP</label>
                      <div className="relative">
                        <input
                          type={showPassword ? 'text' : 'password'}
                          className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg text-sm"
                          placeholder="App Password si Gmail"
                          {...form2.register('smtpPass')}
                        />
                        <button type="button" onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <InputField
                        label="Email de test"
                        type="email"
                        placeholder="test@example.com"
                        {...form2.register('testEmail')}
                        error={form2.formState.errors.testEmail?.message}
                      />
                      <div className="flex items-end">
                        <button
                          type="button"
                          onClick={() => testSmtpMutation.mutate(form2.getValues('testEmail'))}
                          disabled={testSmtpMutation.isPending}
                          className="px-4 py-2 border border-indigo-200 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-50 disabled:opacity-50"
                        >
                          {testSmtpMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Tester'}
                        </button>
                      </div>
                    </div>

                    {smtpTestResult && (
                      <div className={`flex items-start gap-2 p-3 rounded-lg text-sm ${
                        smtpTestResult.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
                      }`}>
                        {smtpTestResult.success ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
                        {smtpTestResult.message}
                      </div>
                    )}
                  </form>

                  <div className="flex justify-between pt-4">
                    <button onClick={() => setStep(0)} className="flex items-center gap-2 px-4 py-2 text-gray-600 text-sm hover:text-gray-800">
                      <ChevronLeft className="w-4 h-4" /> Retour
                    </button>
                    <div className="flex gap-2">
                      <button onClick={() => setStep(2)} className="px-4 py-2 text-gray-500 text-sm hover:text-gray-700 border border-gray-200 rounded-lg">
                        Passer
                      </button>
                      <button onClick={() => setStep(2)} className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                        Suivant <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* ── ÉTAPE 3 : Créer premier tenant ────────────────────── */}
              {step === 2 && (
                <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <p className="text-sm text-gray-600 mb-5">
                    Créez votre première entreprise cliente. Vous pourrez en créer d'autres depuis le portail.
                  </p>
                  <form onSubmit={form3.handleSubmit((data) => createTenantMutation.mutate(data))} className="space-y-4">
                    <InputField
                      label="Nom de l'entreprise"
                      placeholder="TechCorp SAS"
                      error={form3.formState.errors.tenantName?.message}
                      {...form3.register('tenantName')}
                    />
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Slug (identifiant URL)</label>
                      <div className="flex items-center gap-2">
                        <input
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                          placeholder={autoSlug || 'techcorp'}
                          {...form3.register('tenantSlug')}
                        />
                        {autoSlug && !form3.watch('tenantSlug') && (
                          <button type="button" onClick={() => form3.setValue('tenantSlug', autoSlug)}
                            className="px-3 py-2 text-xs bg-gray-100 rounded-lg text-gray-600 hover:bg-gray-200">
                            Utiliser "{autoSlug}"
                          </button>
                        )}
                      </div>
                      {form3.formState.errors.tenantSlug && (
                        <p className="mt-1 text-xs text-red-600">{form3.formState.errors.tenantSlug.message}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Plan</label>
                      <select className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" {...form3.register('planType')}>
                        <option value="trial">Trial (10 users, 20 employés)</option>
                        <option value="starter">Starter (50 users, 100 employés)</option>
                        <option value="pro">Pro (200 users, 500 employés)</option>
                        <option value="enterprise">Enterprise (illimité)</option>
                      </select>
                    </div>

                    <div className="border-t pt-4">
                      <div className="text-sm font-medium text-gray-700 mb-3">Administrateur principal</div>
                      <div className="grid grid-cols-2 gap-3">
                        <InputField
                          label="Prénom"
                          placeholder="Jean"
                          error={form3.formState.errors.adminFirstName?.message}
                          {...form3.register('adminFirstName')}
                        />
                        <InputField
                          label="Nom"
                          placeholder="Dupont"
                          error={form3.formState.errors.adminLastName?.message}
                          {...form3.register('adminLastName')}
                        />
                      </div>
                      <InputField
                        label="Email admin"
                        type="email"
                        placeholder="admin@techcorp.com"
                        error={form3.formState.errors.adminEmail?.message}
                        {...form3.register('adminEmail')}
                      />
                    </div>

                    {createTenantMutation.isError && (
                      <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        {(createTenantMutation.error as Error)?.message ?? 'Erreur création tenant'}
                      </div>
                    )}

                    <div className="flex justify-between pt-2">
                      <button type="button" onClick={() => setStep(1)} className="flex items-center gap-2 px-4 py-2 text-gray-600 text-sm">
                        <ChevronLeft className="w-4 h-4" /> Retour
                      </button>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => { setStep(3); completeOnboardingMutation.mutate() }}
                          className="px-4 py-2 text-gray-500 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
                          Passer
                        </button>
                        <button type="submit" disabled={createTenantMutation.isPending}
                          className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                          {createTenantMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                          Créer le tenant <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </form>
                </motion.div>
              )}

              {/* ── ÉTAPE 4 : Résumé ──────────────────────────────────── */}
              {step === 3 && (
                <motion.div key="step4" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
                  <div className="text-center py-4">
                    <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <CheckCircle2 className="w-8 h-8 text-green-600" />
                    </div>
                    <h2 className="text-lg font-semibold text-gray-900 mb-2">NexusRH est prêt !</h2>
                    <p className="text-sm text-gray-500 mb-6">Votre plateforme SIRH est configurée et opérationnelle.</p>
                  </div>

                  {createdTenant && (
                    <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 mb-5">
                      <div className="text-sm font-semibold text-indigo-800 mb-2">✅ Tenant créé : {createdTenant.name}</div>
                      <div className="space-y-1 text-sm text-indigo-700">
                        <div>Email admin : <strong>{createdTenant.adminEmail}</strong></div>
                        {createdTenant.tempPassword && (
                          <div>Mot de passe temporaire : <strong className="font-mono bg-indigo-100 px-1 rounded">{createdTenant.tempPassword}</strong></div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-3 mb-6">
                    {[
                      { icon: Globe, label: 'Multi-tenant', desc: 'Isolation schéma PostgreSQL' },
                      { icon: Shield, label: 'RBAC complet', desc: '7 rôles différenciés' },
                      { icon: Zap, label: 'IA intégrée', desc: 'Claude AI assistant RH' },
                    ].map(({ icon: Icon, label, desc }) => (
                      <div key={label} className="bg-gray-50 rounded-lg p-3 text-center">
                        <Icon className="w-5 h-5 text-indigo-600 mx-auto mb-1" />
                        <div className="text-xs font-semibold text-gray-800">{label}</div>
                        <div className="text-xs text-gray-500">{desc}</div>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() => completeOnboardingMutation.mutate()}
                    disabled={completeOnboardingMutation.isPending}
                    className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {completeOnboardingMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Accéder au tableau de bord <ChevronRight className="w-4 h-4" />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
