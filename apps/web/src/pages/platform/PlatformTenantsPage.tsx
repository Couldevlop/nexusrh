import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { Link, useParams, useNavigate } from 'react-router-dom'
import {
  Plus, Search, X, ChevronLeft, ChevronRight, AlertTriangle,
  CheckCircle2, XCircle, Pencil, Trash2, Users, Eye,
  Building2, ArrowLeft, Loader2, ChevronDown, Check, Upload, Image,
} from 'lucide-react'
import api from '@/lib/api'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

interface TenantRow {
  id: string; slug: string; name: string; plan_type: string; status: string
  schema_name: string; max_users: number; max_employees: number
  primary_color: string; secondary_color: string; logo_url: string | null
  custom_domain: string | null; trial_ends_at: string | null
  created_at: string; updated_at: string
  userCount: number; employeeCount: number
}

interface TenantUser {
  id: string; email: string; first_name: string; last_name: string
  role: string; is_active: boolean; created_at: string
}

// ── Constants ────────────────────────────────────────────────────────────────

const PLAN_STYLES: Record<string, string> = {
  trial:      'bg-amber-100 text-amber-700 border-amber-200',
  starter:    'bg-sky-100 text-sky-700 border-sky-200',
  pro:        'bg-violet-100 text-violet-700 border-violet-200',
  enterprise: 'bg-purple-100 text-purple-700 border-purple-200',
}
const PLAN_LABELS: Record<string, string> = { trial:'Trial', starter:'Starter', pro:'Pro', enterprise:'Enterprise' }
const STATUS_STYLES: Record<string, string> = {
  active:    'bg-emerald-100 text-emerald-700',
  trial:     'bg-amber-100 text-amber-700',
  suspended: 'bg-red-100 text-red-700',
}
const STATUS_LABELS: Record<string, string> = { active: 'Actif', trial: 'Trial', suspended: 'Suspendu' }

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin', hr_manager: 'RH Manager', hr_officer: 'RH Officer',
  manager: 'Manager', employee: 'Employé', readonly: 'Lecture seule',
}

// ── Shared Drawer Shell ───────────────────────────────────────────────────────

function Drawer({ open, onClose, children, width = 'max-w-lg' }: {
  open: boolean; onClose: () => void; children: React.ReactNode; width?: string
}) {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className={cn('relative bg-white h-full shadow-2xl flex flex-col overflow-hidden w-full', width)}>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

// ── Confirm Modal ─────────────────────────────────────────────────────────────

function ConfirmModal({ open, title, description, confirmLabel, confirmClass, onConfirm, onCancel, loading }: {
  open: boolean; title: string; description: string; confirmLabel: string
  confirmClass?: string; onConfirm: () => void; onCancel: () => void; loading?: boolean
}) {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onCancel} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <motion.div initial={{ opacity: 0, scale: 0.92, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92 }}
            className="relative bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
            <h3 className="text-base font-bold text-gray-900 mb-2">{title}</h3>
            <p className="text-sm text-gray-500 mb-6">{description}</p>
            <div className="flex gap-3 justify-end">
              <button onClick={onCancel}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors">
                Annuler
              </button>
              <button onClick={onConfirm} disabled={loading}
                className={cn('px-4 py-2 text-sm font-medium text-white rounded-xl transition-colors disabled:opacity-60 flex items-center gap-2',
                  confirmClass ?? 'bg-violet-600 hover:bg-violet-700')}>
                {loading && <Loader2 size={14} className="animate-spin" />}
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

// ── Create Tenant Wizard ──────────────────────────────────────────────────────

const STEPS = ['Société', 'Admin', 'Apparence']

interface CreateForm {
  name: string; slug: string; planType: string; status: string
  maxUsers: number; maxEmployees: number
  country: string; sector: string
  adminEmail: string; adminFirstName: string; adminLastName: string; adminPhone: string
  primaryColor: string; secondaryColor: string
}

const PLAN_QUOTAS: Record<string, { maxUsers: number; maxEmployees: number }> = {
  trial:      { maxUsers: 10,   maxEmployees: 20   },
  starter:    { maxUsers: 50,   maxEmployees: 100  },
  pro:        { maxUsers: 200,  maxEmployees: 500  },
  enterprise: { maxUsers: 9999, maxEmployees: 9999 },
}

function slugify(s: string) {
  return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function CreateTenantDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<CreateForm>({
    name: '', slug: '', planType: 'trial', status: 'trial',
    maxUsers: 10, maxEmployees: 20,
    country: 'FR', sector: '',
    adminEmail: '', adminFirstName: '', adminLastName: '', adminPhone: '',
    primaryColor: '#4F46E5', secondaryColor: '#818CF8',
  })
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ tempPassword: string; tenantName: string } | null>(null)
  const [error, setError] = useState('')
  const logoInputRef = useRef<HTMLInputElement>(null)

  const set = (k: keyof CreateForm, v: string) => setForm(f => ({ ...f, [k]: v }))

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoFile(file)
    const reader = new FileReader()
    reader.onload = (ev) => setLogoPreview(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  const createMutation = useMutation({
    mutationFn: async (data: CreateForm) => {
      const res = await api.post<{ data: { tenant: { id: string }; tempPassword: string } }>('/platform/tenants', {
        name: data.name, slug: data.slug, planType: data.planType, status: data.status,
        maxUsers: data.maxUsers, maxEmployees: data.maxEmployees,
        country: data.country, adminEmail: data.adminEmail, adminFirstName: data.adminFirstName,
        adminLastName: data.adminLastName, adminPhone: data.adminPhone || undefined,
        primaryColor: data.primaryColor, secondaryColor: data.secondaryColor,
      })
      const { tenant, tempPassword } = res.data.data
      // Upload logo if provided
      if (logoFile && tenant.id) {
        const formData = new FormData()
        formData.append('file', logoFile)
        await api.post(`/platform/tenants/${tenant.id}/logo`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        }).catch(() => undefined) // non-blocking
      }
      return { tempPassword }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['platform-tenants'] })
      queryClient.invalidateQueries({ queryKey: ['platform-dashboard'] })
      setSuccess({ tempPassword: data.tempPassword, tenantName: form.name })
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message
      setError(msg ?? 'Erreur lors de la création')
    },
  })

  function handleClose() {
    setStep(0)
    setForm({ name:'', slug:'', planType:'trial', status:'trial', maxUsers:10, maxEmployees:20, country:'FR', sector:'', adminEmail:'', adminFirstName:'', adminLastName:'', adminPhone:'', primaryColor:'#4F46E5', secondaryColor:'#818CF8' })
    setLogoFile(null); setLogoPreview(null)
    setSuccess(null); setError(''); onClose()
  }

  function canNext() {
    if (step === 0) return form.name.length >= 2 && form.slug.length >= 2
    if (step === 1) return form.adminEmail.includes('@') && form.adminFirstName && form.adminLastName
    return true
  }

  return (
    <Drawer open={open} onClose={handleClose} width="max-w-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center">
            <Plus size={16} className="text-violet-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-gray-900">Créer un tenant</h2>
            <p className="text-xs text-gray-400">Étape {step + 1} sur {STEPS.length}</p>
          </div>
        </div>
        <button onClick={handleClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
          <X size={16} className="text-gray-400" />
        </button>
      </div>

      {/* Step indicator */}
      <div className="flex px-6 pt-4 pb-2 gap-2 flex-shrink-0">
        {STEPS.map((s, i) => (
          <div key={s} className="flex-1 flex items-center gap-1.5">
            <div className={cn('w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all',
              i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-violet-600 text-white' : 'bg-gray-200 text-gray-400')}>
              {i < step ? <Check size={12} /> : i + 1}
            </div>
            <span className={cn('text-xs font-medium', i === step ? 'text-violet-700' : 'text-gray-400')}>{s}</span>
            {i < STEPS.length - 1 && <div className={cn('flex-1 h-0.5 rounded ml-1', i < step ? 'bg-emerald-400' : 'bg-gray-200')} />}
          </div>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {success ? (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
            className="text-center py-8">
            <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 size={32} className="text-emerald-500" />
            </div>
            <h3 className="text-lg font-bold text-gray-900 mb-1">Tenant créé !</h3>
            <p className="text-sm text-gray-500 mb-6"><strong>{success.tenantName}</strong> est prêt à l'emploi.</p>
            <div className="bg-gray-50 rounded-xl p-4 text-left border border-gray-200">
              <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">Mot de passe temporaire</p>
              <code className="text-sm font-mono text-violet-700 bg-violet-50 px-3 py-2 rounded-lg block">{success.tempPassword}</code>
              <p className="text-xs text-gray-400 mt-2">À transmettre à l'administrateur par canal sécurisé.</p>
            </div>
            <button onClick={handleClose}
              className="mt-6 w-full py-2.5 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors">
              Fermer
            </button>
          </motion.div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div key={step} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }} className="space-y-4">
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
              )}

              {/* Step 0: Société */}
              {step === 0 && <>
                <Field label="Nom de l'entreprise *">
                  <input value={form.name} onChange={e => { set('name', e.target.value); set('slug', slugify(e.target.value)) }}
                    placeholder="TechCorp SAS" className={inputCls} />
                </Field>
                <Field label="Slug (identifiant unique) *" hint="Lettres minuscules, chiffres et tirets">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-400 bg-gray-50 border border-gray-200 rounded-l-xl px-3 py-2.5 border-r-0">tenant_</span>
                    <input value={form.slug} onChange={e => set('slug', slugify(e.target.value))}
                      placeholder="techcorp" className="flex-1 px-3 py-2.5 border border-gray-200 rounded-r-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent" />
                  </div>
                </Field>
                <Field label="Plan">
                  <SelectField value={form.planType} onChange={v => {
                    const quotas = PLAN_QUOTAS[v] ?? PLAN_QUOTAS['starter']
                    setForm(f => ({
                      ...f,
                      planType: v,
                      status: v !== 'trial' ? 'active' : 'trial',
                      maxUsers: quotas.maxUsers,
                      maxEmployees: quotas.maxEmployees,
                    }))
                  }}
                    options={[
                      { value: 'trial', label: 'Trial (14 jours gratuit)' },
                      { value: 'starter', label: 'Starter — 99€/mois' },
                      { value: 'pro', label: 'Pro — 299€/mois' },
                      { value: 'enterprise', label: 'Enterprise — 799€/mois' },
                    ]} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Max utilisateurs">
                    <input type="number" min={1} value={form.maxUsers}
                      onChange={e => setForm(f => ({ ...f, maxUsers: Number(e.target.value) }))}
                      className={inputCls} />
                  </Field>
                  <Field label="Max employés">
                    <input type="number" min={1} value={form.maxEmployees}
                      onChange={e => setForm(f => ({ ...f, maxEmployees: Number(e.target.value) }))}
                      className={inputCls} />
                  </Field>
                </div>
                <Field label="Statut initial">
                  <SelectField value={form.status} onChange={v => set('status', v)}
                    options={[
                      { value: 'active', label: 'Actif (accès immédiat)' },
                      { value: 'trial', label: 'Trial (période d\'essai)' },
                    ]} />
                </Field>
                <Field label="Secteur d'activité">
                  <input value={form.sector} onChange={e => set('sector', e.target.value)}
                    placeholder="Technologie, Bâtiment, Santé..." className={inputCls} />
                </Field>
              </>}

              {/* Step 1: Admin */}
              {step === 1 && <>
                <div className="p-3 bg-blue-50 rounded-xl border border-blue-100 text-xs text-blue-700">
                  Cet utilisateur recevra les droits d'administration du tenant et son mot de passe provisoire.
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Prénom *">
                    <input value={form.adminFirstName} onChange={e => set('adminFirstName', e.target.value)}
                      placeholder="Marie" className={inputCls} />
                  </Field>
                  <Field label="Nom *">
                    <input value={form.adminLastName} onChange={e => set('adminLastName', e.target.value)}
                      placeholder="Dupont" className={inputCls} />
                  </Field>
                </div>
                <Field label="Email professionnel *">
                  <input type="email" value={form.adminEmail} onChange={e => set('adminEmail', e.target.value)}
                    placeholder="admin@entreprise.com" className={inputCls} />
                </Field>
                <Field label="Téléphone">
                  <input value={form.adminPhone} onChange={e => set('adminPhone', e.target.value)}
                    placeholder="+33 6 00 00 00 00" className={inputCls} />
                </Field>
              </>}

              {/* Step 2: Apparence */}
              {step === 2 && <>
                {/* Logo upload */}
                <Field label="Logo de l'entreprise">
                  <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
                  <div
                    onClick={() => logoInputRef.current?.click()}
                    className="flex items-center gap-4 p-4 border-2 border-dashed border-gray-200 rounded-xl cursor-pointer hover:border-violet-400 hover:bg-violet-50/30 transition-colors"
                  >
                    {logoPreview ? (
                      <>
                        <img src={logoPreview} alt="Logo preview" className="w-14 h-14 object-contain rounded-lg border border-gray-200 bg-white" />
                        <div>
                          <p className="text-sm font-medium text-gray-800">{logoFile?.name}</p>
                          <p className="text-xs text-gray-400 mt-0.5">Cliquer pour changer</p>
                        </div>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setLogoFile(null); setLogoPreview(null) }}
                          className="ml-auto p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors">
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
                          <Image size={24} className="text-gray-400" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-600">Cliquer pour uploader</p>
                          <p className="text-xs text-gray-400 mt-0.5">PNG, JPG, SVG — max 2 Mo</p>
                        </div>
                        <Upload size={16} className="ml-auto text-gray-400" />
                      </>
                    )}
                  </div>
                </Field>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="Couleur primaire">
                    <div className="flex items-center gap-2">
                      <input type="color" value={form.primaryColor} onChange={e => set('primaryColor', e.target.value)}
                        className="w-10 h-10 rounded-lg border border-gray-200 cursor-pointer p-0.5" />
                      <input value={form.primaryColor} onChange={e => set('primaryColor', e.target.value)}
                        placeholder="#4F46E5" className={cn(inputCls, 'flex-1')} />
                    </div>
                  </Field>
                  <Field label="Couleur secondaire">
                    <div className="flex items-center gap-2">
                      <input type="color" value={form.secondaryColor} onChange={e => set('secondaryColor', e.target.value)}
                        className="w-10 h-10 rounded-lg border border-gray-200 cursor-pointer p-0.5" />
                      <input value={form.secondaryColor} onChange={e => set('secondaryColor', e.target.value)}
                        placeholder="#818CF8" className={cn(inputCls, 'flex-1')} />
                    </div>
                  </Field>
                </div>

                {/* Preview */}
                <div className="mt-2 rounded-2xl overflow-hidden border border-gray-200 shadow-sm">
                  <div className="h-2" style={{ background: `linear-gradient(90deg, ${form.primaryColor}, ${form.secondaryColor})` }} />
                  <div className="p-4 bg-white">
                    <div className="flex items-center gap-3 mb-3">
                      {logoPreview ? (
                        <img src={logoPreview} alt="logo" className="w-10 h-10 object-contain rounded-xl border border-gray-200 bg-white" />
                      ) : (
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-bold shadow"
                          style={{ backgroundColor: form.primaryColor }}>
                          {(form.name || 'TC').slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-bold text-gray-900">{form.name || 'Nom du tenant'}</p>
                        <p className="text-xs text-gray-400">Portail RH</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <div className="h-8 px-4 rounded-lg text-white text-xs font-semibold flex items-center"
                        style={{ backgroundColor: form.primaryColor }}>
                        Se connecter
                      </div>
                      <div className="h-8 px-4 rounded-lg text-xs font-semibold flex items-center border"
                        style={{ color: form.primaryColor, borderColor: form.primaryColor }}>
                        En savoir plus
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] text-gray-400 text-center py-2 bg-gray-50">Aperçu branding</p>
                </div>
              </>}
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      {/* Footer */}
      {!success && (
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
          <button onClick={() => step > 0 ? setStep(s => s - 1) : handleClose()}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors">
            <ChevronLeft size={15} />
            {step === 0 ? 'Annuler' : 'Précédent'}
          </button>
          {step < STEPS.length - 1 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={!canNext()}
              className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors disabled:opacity-40">
              Suivant <ChevronRight size={15} />
            </button>
          ) : (
            <button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending || !canNext()}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-40">
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              Créer le tenant
            </button>
          )}
        </div>
      )}
    </Drawer>
  )
}

// ── Edit Tenant Drawer ────────────────────────────────────────────────────────

function EditTenantDrawer({ tenant, onClose }: { tenant: TenantRow | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    name: '', planType: 'trial', maxUsers: 50, maxEmployees: 100,
    primaryColor: '#4F46E5', secondaryColor: '#818CF8', customDomain: '', trialEndsAt: '',
  })
  const [saved, setSaved] = useState(false)
  const [resetResult, setResetResult] = useState<{ adminEmail: string; tempPassword: string } | null>(null)

  useEffect(() => {
    if (tenant) setForm({
      name: tenant.name,
      planType: tenant.plan_type,
      maxUsers: tenant.max_users,
      maxEmployees: tenant.max_employees,
      primaryColor: tenant.primary_color,
      secondaryColor: tenant.secondary_color,
      customDomain: tenant.custom_domain ?? '',
      trialEndsAt: tenant.trial_ends_at ? tenant.trial_ends_at.slice(0, 10) : '',
    })
    setResetResult(null)
  }, [tenant])

  const updateMutation = useMutation({
    mutationFn: async () => {
      await api.put(`/platform/tenants/${tenant!.id}`, {
        name: form.name,
        planType: form.planType,
        maxUsers: Number(form.maxUsers),
        maxEmployees: Number(form.maxEmployees),
        primaryColor: form.primaryColor,
        secondaryColor: form.secondaryColor,
        customDomain: form.customDomain || null,
        trialEndsAt: form.trialEndsAt ? new Date(form.trialEndsAt).toISOString() : null,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-tenants'] })
      queryClient.invalidateQueries({ queryKey: ['platform-dashboard'] })
      setSaved(true)
      setTimeout(() => { setSaved(false); onClose() }, 1200)
    },
  })

  const activateMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/platform/tenants/${tenant!.id}/activate`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-tenants'] })
      queryClient.invalidateQueries({ queryKey: ['platform-dashboard'] })
      onClose()
    },
  })

  const suspendMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/platform/tenants/${tenant!.id}/suspend`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-tenants'] })
      queryClient.invalidateQueries({ queryKey: ['platform-dashboard'] })
      onClose()
    },
  })

  const resetAdminMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ data: { adminEmail: string; tempPassword: string } }>(
        `/platform/tenants/${tenant!.id}/reset-admin`
      )
      return res.data.data
    },
    onSuccess: (data) => {
      setResetResult(data)
    },
  })

  const set = (k: string, v: string | number) => setForm(f => ({ ...f, [k]: v }))

  const currentStatus = tenant?.status ?? 'trial'

  return (
    <Drawer open={!!tenant} onClose={onClose} width="max-w-lg">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-3">
          {tenant && (
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold"
              style={{ backgroundColor: tenant.primary_color }}>
              {tenant.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <h2 className="text-base font-bold text-gray-900">Modifier le tenant</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-xs text-gray-400">{tenant?.slug}</p>
              <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wide',
                STATUS_STYLES[currentStatus] ?? 'bg-gray-100 text-gray-500')}>
                {STATUS_LABELS[currentStatus] ?? currentStatus}
              </span>
            </div>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
          <X size={16} className="text-gray-400" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

        {/* Status management */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Statut du compte</h3>
          <div className="flex gap-2">
            {currentStatus !== 'active' && (
              <button
                onClick={() => activateMutation.mutate()}
                disabled={activateMutation.isPending}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors disabled:opacity-60"
              >
                {activateMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Activer
              </button>
            )}
            {currentStatus !== 'suspended' && (
              <button
                onClick={() => suspendMutation.mutate()}
                disabled={suspendMutation.isPending}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 rounded-xl transition-colors disabled:opacity-60"
              >
                {suspendMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                Suspendre
              </button>
            )}
            {currentStatus === 'suspended' && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2 flex-1 text-center">
                Tenant suspendu — les utilisateurs ne peuvent plus se connecter
              </p>
            )}
          </div>
        </section>
        <div className="h-px bg-gray-100" />

        {/* Reset admin password */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Accès administrateur</h3>
          {resetResult ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-amber-800 mb-1">Nouveau mot de passe généré</p>
              <p className="text-xs text-amber-700 mb-2">Email : <strong>{resetResult.adminEmail}</strong></p>
              <code className="block text-sm font-mono text-amber-900 bg-amber-100 px-3 py-2 rounded-lg">{resetResult.tempPassword}</code>
              <p className="text-[10px] text-amber-600 mt-2">À transmettre par canal sécurisé. Valide jusqu'au prochain changement.</p>
            </div>
          ) : (
            <button
              onClick={() => resetAdminMutation.mutate()}
              disabled={resetAdminMutation.isPending}
              className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-xl transition-colors disabled:opacity-60"
            >
              {resetAdminMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
              Réinitialiser le mot de passe admin
            </button>
          )}
        </section>
        <div className="h-px bg-gray-100" />

        {/* Infos générales */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Informations</h3>
          <Field label="Nom de l'entreprise">
            <input value={form.name} onChange={e => set('name', e.target.value)} className={inputCls} />
          </Field>
        </section>
        <div className="h-px bg-gray-100" />

        {/* Plan */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Plan & Limites</h3>
          <Field label="Plan">
            <SelectField value={form.planType} onChange={v => set('planType', v)}
              options={[
                { value: 'trial', label: 'Trial' },
                { value: 'starter', label: 'Starter — 99€/mois' },
                { value: 'pro', label: 'Pro — 299€/mois' },
                { value: 'enterprise', label: 'Enterprise — 799€/mois' },
              ]} />
          </Field>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Max utilisateurs">
              <input type="number" value={form.maxUsers} onChange={e => set('maxUsers', e.target.value)} className={inputCls} min={1} />
            </Field>
            <Field label="Max employés">
              <input type="number" value={form.maxEmployees} onChange={e => set('maxEmployees', e.target.value)} className={inputCls} min={1} />
            </Field>
          </div>
          {(form.planType === 'trial' || currentStatus === 'trial') && (
            <div className="mt-3">
              <Field label="Fin du trial">
                <input type="date" value={form.trialEndsAt} onChange={e => set('trialEndsAt', e.target.value)} className={inputCls} />
              </Field>
            </div>
          )}
        </section>
        <div className="h-px bg-gray-100" />

        {/* Apparence */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Apparence</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Couleur primaire">
              <div className="flex items-center gap-2">
                <input type="color" value={form.primaryColor} onChange={e => set('primaryColor', e.target.value)}
                  className="w-9 h-9 rounded-lg border border-gray-200 cursor-pointer p-0.5" />
                <input value={form.primaryColor} onChange={e => set('primaryColor', e.target.value)} className={cn(inputCls, 'flex-1 text-xs')} />
              </div>
            </Field>
            <Field label="Couleur secondaire">
              <div className="flex items-center gap-2">
                <input type="color" value={form.secondaryColor} onChange={e => set('secondaryColor', e.target.value)}
                  className="w-9 h-9 rounded-lg border border-gray-200 cursor-pointer p-0.5" />
                <input value={form.secondaryColor} onChange={e => set('secondaryColor', e.target.value)} className={cn(inputCls, 'flex-1 text-xs')} />
              </div>
            </Field>
          </div>
          <div className="mt-3 h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${form.primaryColor}, ${form.secondaryColor})` }} />
        </section>
        <div className="h-px bg-gray-100" />

        {/* Domaine */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Domaine personnalisé</h3>
          <Field label="Domaine" hint="ex: rh.monentreprise.com">
            <input value={form.customDomain} onChange={e => set('customDomain', e.target.value)}
              placeholder="rh.monentreprise.com" className={inputCls} />
          </Field>
        </section>
      </div>

      <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
        <button onClick={onClose} className="flex-1 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors">
          Annuler
        </button>
        <button onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending || saved}
          className={cn('flex-1 py-2.5 text-sm font-semibold text-white rounded-xl transition-all flex items-center justify-center gap-2',
            saved ? 'bg-emerald-500' : 'bg-violet-600 hover:bg-violet-700')}>
          {updateMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
          {saved ? 'Enregistré !' : 'Sauvegarder'}
        </button>
      </div>
    </Drawer>
  )
}

// ── View Users Drawer ─────────────────────────────────────────────────────────

function ViewUsersDrawer({ tenantId, tenantName, onClose }: { tenantId: string | null; tenantName: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-users', tenantId],
    queryFn: async () => {
      const res = await api.get<{ data: TenantUser[] }>(`/platform/tenants/${tenantId}/users`)
      return res.data.data
    },
    enabled: !!tenantId,
  })

  return (
    <Drawer open={!!tenantId} onClose={onClose} width="max-w-md">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-blue-100 flex items-center justify-center">
            <Users size={15} className="text-blue-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-gray-900">Utilisateurs</h2>
            <p className="text-xs text-gray-400">{tenantName}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
          <X size={16} className="text-gray-400" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
        {isLoading ? (
          <div className="p-6 space-y-3">{[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-gray-100 rounded-xl animate-pulse" />)}</div>
        ) : (data ?? []).map(u => (
          <div key={u.id} className="flex items-center gap-3 px-6 py-3.5 hover:bg-gray-50 transition-colors">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-400 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
              {u.first_name.charAt(0)}{u.last_name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">{u.first_name} {u.last_name}</p>
              <p className="text-xs text-gray-400 truncate">{u.email}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', u.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600')}>
                {u.is_active ? 'Actif' : 'Inactif'}
              </span>
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{ROLE_LABELS[u.role] ?? u.role}</span>
            </div>
          </div>
        ))}
        {!isLoading && (data ?? []).length === 0 && (
          <div className="px-6 py-10 text-center text-sm text-gray-400">Aucun utilisateur</div>
        )}
      </div>
    </Drawer>
  )
}

// ── Shared form components ────────────────────────────────────────────────────

const inputCls = 'w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent transition-all'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-gray-700">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-400">{hint}</p>}
    </div>
  )
}

function SelectField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="relative">
      <select value={value} onChange={e => onChange(e.target.value)}
        className={cn(inputCls, 'appearance-none pr-8 bg-white cursor-pointer')}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function PlatformTenantsPage() {
  const { id: tenantIdParam } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [planFilter, setPlanFilter] = useState('')

  const [showCreate, setShowCreate] = useState(() => tenantIdParam === 'new')
  const [editTenant, setEditTenant] = useState<TenantRow | null>(null)
  const [viewUsersTenant, setViewUsersTenant] = useState<TenantRow | null>(null)
  const [confirmSuspend, setConfirmSuspend] = useState<TenantRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<TenantRow | null>(null)
  const [detailTenant, setDetailTenant] = useState<TenantRow | null>(null)

  const pageSize = 15

  const { data, isLoading } = useQuery({
    queryKey: ['platform-tenants', page, search, statusFilter, planFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(pageSize) })
      if (search) params.set('search', search)
      if (statusFilter) params.set('status', statusFilter)
      const res = await api.get<{ data: TenantRow[]; meta: { total: number; totalPages: number } }>(
        `/platform/tenants?${params}`
      )
      return res.data
    },
  })

  const suspendMutation = useMutation({
    mutationFn: async (t: TenantRow) => {
      const endpoint = t.status === 'suspended' ? 'activate' : 'suspend'
      await api.post(`/platform/tenants/${t.id}/${endpoint}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-tenants'] })
      queryClient.invalidateQueries({ queryKey: ['platform-dashboard'] })
      setConfirmSuspend(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/platform/tenants/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-tenants'] })
      queryClient.invalidateQueries({ queryKey: ['platform-dashboard'] })
      setConfirmDelete(null)
    },
  })

  const totalPages = data?.meta.totalPages ?? 1

  // Handle /platform/tenants/new route
  useEffect(() => {
    if (tenantIdParam === 'new') { setShowCreate(true); navigate('/platform/tenants', { replace: true }) }
  }, [tenantIdParam, navigate])

  const tenants = data?.data ?? []

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
          <h1 className="text-2xl font-bold text-gray-900">Tenants</h1>
          <p className="text-sm text-gray-500 mt-0.5">{data?.meta.total ?? 0} tenant{(data?.meta.total ?? 0) > 1 ? 's' : ''} au total</p>
        </motion.div>
        <motion.button initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors shadow-sm shadow-violet-200">
          <Plus size={15} /> Créer un tenant
        </motion.button>
      </div>

      {/* Filters */}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Rechercher par nom ou slug..."
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white" />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X size={13} />
          </button>}
        </div>

        {/* Status filter */}
        <div className="relative">
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
            className="appearance-none pl-3 pr-8 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 text-gray-700 cursor-pointer">
            <option value="">Tous les statuts</option>
            <option value="active">Actif</option>
            <option value="trial">Trial</option>
            <option value="suspended">Suspendu</option>
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>

        {/* Active filters badges */}
        {(statusFilter || planFilter || search) && (
          <button onClick={() => { setSearch(''); setStatusFilter(''); setPlanFilter(''); setPage(1) }}
            className="flex items-center gap-1.5 px-3 py-2 bg-red-50 text-red-600 rounded-xl text-xs font-medium hover:bg-red-100 transition-colors border border-red-100">
            <X size={12} /> Réinitialiser
          </button>
        )}
      </motion.div>

      {/* Table */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}
        className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(6)].map((_, i) => <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" style={{ opacity: 1 - i * 0.15 }} />)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-3.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Tenant</th>
                  <th className="px-4 py-3.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Plan</th>
                  <th className="px-4 py-3.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Statut</th>
                  <th className="px-4 py-3.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Utilisateurs</th>
                  <th className="px-4 py-3.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Employés</th>
                  <th className="px-4 py-3.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Trial</th>
                  <th className="px-5 py-3.5 text-right text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {tenants.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/50 transition-colors group">
                    {/* Name */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold flex-shrink-0 shadow-sm"
                          style={{ backgroundColor: t.primary_color || '#4F46E5' }}>
                          {t.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                          <p className="text-xs text-gray-400">{t.slug}</p>
                        </div>
                      </div>
                    </td>
                    {/* Plan */}
                    <td className="px-4 py-3.5">
                      <span className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold border', PLAN_STYLES[t.plan_type])}>
                        {PLAN_LABELS[t.plan_type] ?? t.plan_type}
                      </span>
                    </td>
                    {/* Status */}
                    <td className="px-4 py-3.5">
                      <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold', STATUS_STYLES[t.status])}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {STATUS_LABELS[t.status] ?? t.status}
                      </span>
                    </td>
                    {/* Users */}
                    <td className="px-4 py-3.5">
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-700 font-medium">{t.userCount}</span>
                          <span className="text-gray-400">/{t.max_users}</span>
                        </div>
                        <div className="h-1 bg-gray-100 rounded-full w-20 overflow-hidden">
                          <div className="h-full bg-violet-400 rounded-full transition-all"
                            style={{ width: `${Math.min(100, (t.userCount / t.max_users) * 100)}%` }} />
                        </div>
                      </div>
                    </td>
                    {/* Employees */}
                    <td className="px-4 py-3.5">
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-700 font-medium">{t.employeeCount}</span>
                          <span className="text-gray-400">/{t.max_employees}</span>
                        </div>
                        <div className="h-1 bg-gray-100 rounded-full w-20 overflow-hidden">
                          <div className="h-full bg-blue-400 rounded-full transition-all"
                            style={{ width: `${Math.min(100, (t.employeeCount / t.max_employees) * 100)}%` }} />
                        </div>
                      </div>
                    </td>
                    {/* Trial */}
                    <td className="px-4 py-3.5 text-xs text-gray-500">
                      {t.trial_ends_at ? new Date(t.trial_ends_at).toLocaleDateString('fr-FR') : '—'}
                    </td>
                    {/* Actions */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <ActionBtn title="Voir les utilisateurs" onClick={() => setViewUsersTenant(t)}>
                          <Users size={13} />
                        </ActionBtn>
                        <ActionBtn title="Modifier" onClick={() => setEditTenant(t)}>
                          <Pencil size={13} />
                        </ActionBtn>
                        <ActionBtn
                          title={t.status === 'suspended' ? 'Réactiver' : 'Suspendre'}
                          onClick={() => setConfirmSuspend(t)}
                          className={t.status === 'suspended' ? 'hover:bg-emerald-50 hover:text-emerald-600' : 'hover:bg-amber-50 hover:text-amber-600'}>
                          {t.status === 'suspended' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                        </ActionBtn>
                        <ActionBtn title="Supprimer" onClick={() => setConfirmDelete(t)}
                          className="hover:bg-red-50 hover:text-red-600">
                          <Trash2 size={13} />
                        </ActionBtn>
                        <ActionBtn title="Détail" onClick={() => setDetailTenant(t)}>
                          <Eye size={13} />
                        </ActionBtn>
                      </div>
                    </td>
                  </tr>
                ))}
                {tenants.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-16 text-center">
                      <Building2 size={32} className="text-gray-200 mx-auto mb-3" />
                      <p className="text-sm text-gray-400">Aucun tenant trouvé</p>
                      <button onClick={() => setShowCreate(true)}
                        className="mt-3 text-sm text-violet-600 hover:underline font-medium">
                        + Créer le premier tenant
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3.5 border-t border-gray-50 bg-gray-50/50">
            <p className="text-xs text-gray-400">Page {page} sur {totalPages} · {data?.meta.total} résultats</p>
            <div className="flex gap-1">
              {[...Array(totalPages)].map((_, i) => (
                <button key={i} onClick={() => setPage(i + 1)}
                  className={cn('w-7 h-7 rounded-lg text-xs font-medium transition-colors',
                    page === i + 1 ? 'bg-violet-600 text-white' : 'text-gray-500 hover:bg-gray-200')}>
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        )}
      </motion.div>

      {/* ── Detail side panel ── */}
      <Drawer open={!!detailTenant} onClose={() => setDetailTenant(null)} width="max-w-md">
        {detailTenant && <>
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold"
                style={{ backgroundColor: detailTenant.primary_color }}>
                {detailTenant.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <h2 className="text-base font-bold text-gray-900">{detailTenant.name}</h2>
                <p className="text-xs text-gray-400">{detailTenant.slug}</p>
              </div>
            </div>
            <button onClick={() => setDetailTenant(null)} className="p-1.5 rounded-lg hover:bg-gray-100">
              <X size={16} className="text-gray-400" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {/* Banner */}
            <div className="h-16 rounded-xl" style={{ background: `linear-gradient(135deg, ${detailTenant.primary_color}, ${detailTenant.secondary_color})` }} />

            {/* Info grid */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Plan', value: PLAN_LABELS[detailTenant.plan_type] ?? detailTenant.plan_type },
                { label: 'Statut', value: STATUS_LABELS[detailTenant.status] ?? detailTenant.status },
                { label: 'Utilisateurs', value: `${detailTenant.userCount} / ${detailTenant.max_users}` },
                { label: 'Employés', value: `${detailTenant.employeeCount} / ${detailTenant.max_employees}` },
                { label: 'Schéma DB', value: detailTenant.schema_name },
                { label: 'Créé le', value: new Date(detailTenant.created_at).toLocaleDateString('fr-FR') },
              ].map(item => (
                <div key={item.label} className="bg-gray-50 rounded-xl p-3">
                  <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">{item.label}</p>
                  <p className="text-sm font-semibold text-gray-800">{item.value}</p>
                </div>
              ))}
            </div>

            {detailTenant.custom_domain && (
              <div className="bg-violet-50 rounded-xl p-3 border border-violet-100">
                <p className="text-xs text-violet-500 font-semibold mb-1">Domaine personnalisé</p>
                <p className="text-sm text-violet-800 font-mono">{detailTenant.custom_domain}</p>
              </div>
            )}
          </div>
          <div className="px-6 py-4 border-t border-gray-100 flex gap-2 flex-shrink-0">
            <button onClick={() => { setDetailTenant(null); setEditTenant(detailTenant) }}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-colors">
              <Pencil size={14} /> Modifier
            </button>
            <button onClick={() => { setDetailTenant(null); setViewUsersTenant(detailTenant) }}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-blue-50 text-blue-700 rounded-xl text-sm font-semibold hover:bg-blue-100 transition-colors">
              <Users size={14} /> Utilisateurs
            </button>
          </div>
        </>}
      </Drawer>

      {/* ── Modals & Drawers ── */}
      <CreateTenantDrawer open={showCreate} onClose={() => setShowCreate(false)} />
      <EditTenantDrawer tenant={editTenant} onClose={() => setEditTenant(null)} />
      <ViewUsersDrawer
        tenantId={viewUsersTenant?.id ?? null}
        tenantName={viewUsersTenant?.name ?? ''}
        onClose={() => setViewUsersTenant(null)} />

      <ConfirmModal
        open={!!confirmSuspend}
        title={confirmSuspend?.status === 'suspended' ? 'Réactiver le tenant ?' : 'Suspendre le tenant ?'}
        description={confirmSuspend?.status === 'suspended'
          ? `Les utilisateurs de "${confirmSuspend?.name}" pourront à nouveau se connecter.`
          : `Les utilisateurs de "${confirmSuspend?.name}" seront bloqués immédiatement.`}
        confirmLabel={confirmSuspend?.status === 'suspended' ? 'Réactiver' : 'Suspendre'}
        confirmClass={confirmSuspend?.status === 'suspended' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-500 hover:bg-amber-600'}
        loading={suspendMutation.isPending}
        onConfirm={() => confirmSuspend && suspendMutation.mutate(confirmSuspend)}
        onCancel={() => setConfirmSuspend(null)} />

      <ConfirmModal
        open={!!confirmDelete}
        title="Supprimer ce tenant ?"
        description={`Cette action est irréversible. Toutes les données de "${confirmDelete?.name}" (employés, bulletins, etc.) seront définitivement supprimées.`}
        confirmLabel="Supprimer définitivement"
        confirmClass="bg-red-600 hover:bg-red-700"
        loading={deleteMutation.isPending}
        onConfirm={() => confirmDelete && deleteMutation.mutate(confirmDelete.id)}
        onCancel={() => setConfirmDelete(null)} />
    </div>
  )
}

// ── Small action button ───────────────────────────────────────────────────────

function ActionBtn({ children, onClick, title, className }: {
  children: React.ReactNode; onClick: () => void; title: string; className?: string
}) {
  return (
    <button onClick={onClick} title={title}
      className={cn('p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 transition-colors', className)}>
      {children}
    </button>
  )
}
