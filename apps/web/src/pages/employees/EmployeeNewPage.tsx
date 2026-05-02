import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, Save, User, Briefcase, FileText, Mail, Upload, X, Paperclip } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/lib/api'
import { cn } from '@/lib/utils'

const STEPS = [
  { id: 'personal', label: 'Informations personnelles', icon: User },
  { id: 'professional', label: 'Informations professionnelles', icon: Briefcase },
  { id: 'contract', label: 'Contrat', icon: FileText },
]

// ── Schemas ──────────────────────────────────────────────────────────────────

const personalSchema = z.object({
  firstName: z.string().min(2, 'Requis'),
  lastName: z.string().min(2, 'Requis'),
  email: z.string().email('Email invalide'),
  phone: z.string().optional(),
  birthDate: z.string().optional(),
  nationality: z.string().length(2).optional().or(z.literal('')),
})

const professionalSchema = z.object({
  jobTitle: z.string().min(2, 'Requis'),
  hireDate: z.string().min(1, 'Requis'),
  departmentId: z.string().uuid().optional().or(z.literal('')),
  workingTimePercentage: z.number().min(1).max(100).default(100),
  weeklyHours: z.number().min(1).max(48).default(35),
})

const contractSchema = z.object({
  type: z.string().min(1, 'Type de contrat requis'),
  startDate: z.string().min(1, 'Date de début requise'),
  endDate: z.string().optional(),
  trialPeriodEnd: z.string().optional(),
  grossSalary: z.number({ invalid_type_error: 'Salaire requis' }).min(1, 'Salaire requis'),
  collectiveAgreement: z.string().optional(),
  telecommutingDays: z.number().min(0).max(5).default(0),
})

type PersonalData = z.infer<typeof personalSchema>
type ProfessionalData = z.infer<typeof professionalSchema>
type ContractData = z.infer<typeof contractSchema>

interface Department { id: string; name: string }
interface RefParam { id: string; code: string; label: string }

// ── Component ─────────────────────────────────────────────────────────────────

export function EmployeeNewPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [currentStep, setCurrentStep] = useState(0)
  const [personalData, setPersonalData] = useState<PersonalData | null>(null)
  const [professionalData, setProfessionalData] = useState<ProfessionalData | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [createAccount, setCreateAccount] = useState(true)
  // Documents à uploader : contrat + avenants
  const [contractFile, setContractFile] = useState<File | null>(null)
  const [amendmentFiles, setAmendmentFiles] = useState<File[]>([])
  const [credentialsAlert, setCredentialsAlert] = useState<{
    message: string; tempPassword: string; employeeId: string
  } | null>(null)

  // Fetch departments
  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/employees/departments')).data.data ?? [],
    staleTime: 0,
  })

  // Fetch configurable lists
  const { data: contractTypes = [] } = useQuery<RefParam[]>({
    queryKey: ['settings-parameters', 'contract_type'],
    queryFn: async () => (await api.get('/settings/parameters?category=contract_type')).data.data ?? [],
    staleTime: 0,
  })

  const { data: jobLevels = [] } = useQuery<RefParam[]>({
    queryKey: ['settings-parameters', 'job_level'],
    queryFn: async () => (await api.get('/settings/parameters?category=job_level')).data.data ?? [],
    staleTime: 0,
  })

  const { data: collectiveAgreements = [] } = useQuery<RefParam[]>({
    queryKey: ['settings-parameters', 'collective_agreement'],
    queryFn: async () => (await api.get('/settings/parameters?category=collective_agreement')).data.data ?? [],
    staleTime: 0,
  })

  const personalForm = useForm<PersonalData>({
    resolver: zodResolver(personalSchema),
  })

  const professionalForm = useForm<ProfessionalData>({
    resolver: zodResolver(professionalSchema),
    defaultValues: { workingTimePercentage: 100, weeklyHours: 35 },
  })

  const contractForm = useForm<ContractData>({
    resolver: zodResolver(contractSchema),
    defaultValues: { telecommutingDays: 0 },
  })

  // Create employee then contract in sequence
  const createMutation = useMutation({
    mutationFn: async (contractData: ContractData) => {
      if (!personalData || !professionalData) throw new Error('Données manquantes')

      // Step A — create employee (+ optional account + welcome email)
      const empRes = await api.post<{
        data: { id: string }
        accountCreated?: boolean
        emailSent?: boolean
        tempPassword?: string
        message?: string
      }>('/employees', {
        firstName: personalData.firstName,
        lastName: personalData.lastName,
        email: personalData.email,
        phone: personalData.phone || undefined,
        birthDate: personalData.birthDate || undefined,
        nationality: personalData.nationality || undefined,
        jobTitle: professionalData.jobTitle,
        hireDate: professionalData.hireDate,
        departmentId: professionalData.departmentId || undefined,
        workingTimePercentage: professionalData.workingTimePercentage,
        weeklyHours: professionalData.weeklyHours,
        createAccount,
      })
      const employee = empRes.data.data
      const accountCreated = empRes.data.accountCreated ?? false
      const emailSent = empRes.data.emailSent ?? true
      const tempPassword = empRes.data.tempPassword
      const apiMessage = empRes.data.message

      // Step B — create contract linked to this employee
      await api.post('/contracts', {
        employeeId: employee.id,
        type: contractData.type,
        startDate: contractData.startDate,
        endDate: contractData.endDate || undefined,
        trialPeriodEnd: contractData.trialPeriodEnd || undefined,
        grossSalary: contractData.grossSalary,
        collectiveAgreement: contractData.collectiveAgreement || undefined,
        workingHoursPerWeek: professionalData.weeklyHours,
        telecommutingDays: contractData.telecommutingDays,
      })

      // Step C — upload contract document (if selected) — non-blocking
      const uploadDoc = async (file: File, type: string, title: string) => {
        const fd = new FormData()
        fd.append('type', type)
        fd.append('title', title)
        fd.append('file', file)
        await api.post(`/employees/${employee.id}/documents`, fd)
      }

      if (contractFile) {
        try {
          await uploadDoc(contractFile, 'contract', `Contrat — ${personalData.firstName} ${personalData.lastName}`)
        } catch {
          // Document metadata may still be saved; non-fatal
        }
      }
      for (const amendFile of amendmentFiles) {
        try {
          await uploadDoc(amendFile, 'amendment', amendFile.name.replace(/\.[^.]+$/, ''))
        } catch {
          // non-fatal
        }
      }

      return { ...employee, accountCreated, emailSent, tempPassword, apiMessage }
    },
    onSuccess: (employee) => {
      queryClient.invalidateQueries({ queryKey: ['employees'] })
      if (employee.accountCreated && !employee.emailSent && employee.tempPassword) {
        setCredentialsAlert({
          message: employee.apiMessage ?? `Email non envoyé. Mot de passe temporaire : ${employee.tempPassword}`,
          tempPassword: employee.tempPassword,
          employeeId: employee.id,
        })
      } else {
        navigate(`/employees/${employee.id}`)
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string; error?: string } } })
        ?.response?.data?.message
        ?? (err as { response?: { data?: { message?: string; error?: string } } })
        ?.response?.data?.error
        ?? 'Erreur lors de la création'
      setApiError(msg)
    },
  })

  const handlePersonalNext = (data: PersonalData) => {
    setPersonalData(data)
    setCurrentStep(1)
  }

  const handleProfessionalNext = (data: ProfessionalData) => {
    setProfessionalData(data)
    setCurrentStep(2)
  }

  const handleContractSubmit = (data: ContractData) => {
    setApiError(null)
    createMutation.mutate(data)
  }

  const inputClass =
    'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'
  const labelClass = 'text-xs font-medium text-gray-700 block mb-1.5'
  const errorClass = 'text-xs text-red-500 mt-1'

  return (
    <div className="p-6 max-w-2xl">
      {/* Credentials alert — shown when email failed */}
      {credentialsAlert && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-800 mb-1">Collaborateur créé — email non envoyé</p>
              <p className="text-sm text-amber-700 mb-3">{credentialsAlert.message}</p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-amber-600">Mot de passe temporaire :</span>
                <code className="bg-amber-100 border border-amber-300 rounded px-2 py-0.5 text-sm font-mono font-bold text-amber-900 select-all">
                  {credentialsAlert.tempPassword}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(credentialsAlert.tempPassword)}
                  className="text-xs text-amber-700 underline hover:text-amber-900"
                >
                  Copier
                </button>
              </div>
              <p className="text-xs text-amber-600 mt-2">Transmettez ce mot de passe manuellement au collaborateur.</p>
            </div>
            <button
              onClick={() => navigate(`/employees/${credentialsAlert.employeeId}`)}
              className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg"
            >
              Voir le collaborateur
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <button
          onClick={() => navigate('/employees')}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="w-4 h-4" />
          Collaborateurs
        </button>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Nouveau collaborateur</span>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((step, idx) => {
          const Icon = step.icon
          const isDone = idx < currentStep
          const isActive = idx === currentStep
          return (
            <div key={step.id} className="flex items-center gap-2">
              <div className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive ? 'bg-indigo-100 text-indigo-700' :
                isDone ? 'bg-green-100 text-green-700' :
                'bg-gray-100 text-gray-400'
              )}>
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{step.label}</span>
              </div>
              {idx < STEPS.length - 1 && (
                <div className={cn('h-px w-8', isDone ? 'bg-green-400' : 'bg-gray-200')} />
              )}
            </div>
          )
        })}
      </div>

      <motion.div
        key={currentStep}
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        className="bg-white rounded-xl border border-gray-200 shadow-sm p-6"
      >
        {/* ── STEP 0 : Informations personnelles ── */}
        {currentStep === 0 && (
          <form onSubmit={personalForm.handleSubmit(handlePersonalNext)} className="space-y-4">
            <h2 className="font-semibold text-gray-900">Informations personnelles</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Prénom *</label>
                <input
                  {...personalForm.register('firstName')}
                  placeholder="Marie"
                  className={inputClass}
                />
                {personalForm.formState.errors.firstName && (
                  <p className={errorClass}>{personalForm.formState.errors.firstName.message}</p>
                )}
              </div>
              <div>
                <label className={labelClass}>Nom *</label>
                <input
                  {...personalForm.register('lastName')}
                  placeholder="Dupont"
                  className={inputClass}
                />
                {personalForm.formState.errors.lastName && (
                  <p className={errorClass}>{personalForm.formState.errors.lastName.message}</p>
                )}
              </div>
            </div>
            <div>
              <label className={labelClass}>Email professionnel *</label>
              <input
                {...personalForm.register('email')}
                type="email"
                placeholder="marie.dupont@entreprise.com"
                className={inputClass}
              />
              {personalForm.formState.errors.email && (
                <p className={errorClass}>{personalForm.formState.errors.email.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Téléphone</label>
                <input
                  {...personalForm.register('phone')}
                  placeholder="+33 6 12 34 56 78"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Date de naissance</label>
                <input
                  {...personalForm.register('birthDate')}
                  type="date"
                  className={inputClass}
                />
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="submit"
                className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
              >
                Suivant →
              </button>
            </div>
          </form>
        )}

        {/* ── STEP 1 : Informations professionnelles ── */}
        {currentStep === 1 && (
          <form onSubmit={professionalForm.handleSubmit(handleProfessionalNext)} className="space-y-4">
            <h2 className="font-semibold text-gray-900">Informations professionnelles</h2>
            <div>
              <label className={labelClass}>Intitulé du poste *</label>
              <input
                {...professionalForm.register('jobTitle')}
                placeholder="Développeur Full Stack"
                className={inputClass}
              />
              {professionalForm.formState.errors.jobTitle && (
                <p className={errorClass}>{professionalForm.formState.errors.jobTitle.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Date d'embauche *</label>
                <input
                  {...professionalForm.register('hireDate')}
                  type="date"
                  className={inputClass}
                />
                {professionalForm.formState.errors.hireDate && (
                  <p className={errorClass}>{professionalForm.formState.errors.hireDate.message}</p>
                )}
              </div>
              <div>
                <label className={labelClass}>Département</label>
                <select
                  {...professionalForm.register('departmentId')}
                  className={inputClass}
                >
                  <option value="">— Aucun —</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Temps de travail (%)</label>
                <input
                  {...professionalForm.register('workingTimePercentage', { valueAsNumber: true })}
                  type="number"
                  min={1}
                  max={100}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Heures / semaine</label>
                <input
                  {...professionalForm.register('weeklyHours', { valueAsNumber: true })}
                  type="number"
                  min={1}
                  max={48}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={() => setCurrentStep(0)}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                ← Retour
              </button>
              <button
                type="submit"
                className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
              >
                Suivant →
              </button>
            </div>
          </form>
        )}

        {/* ── STEP 2 : Contrat ── */}
        {currentStep === 2 && (
          <form onSubmit={contractForm.handleSubmit(handleContractSubmit)} className="space-y-4">
            <h2 className="font-semibold text-gray-900">Contrat de travail</h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Type de contrat *</label>
                <select
                  {...contractForm.register('type')}
                  className={inputClass}
                >
                  <option value="">— Choisir —</option>
                  {contractTypes.map((t) => (
                    <option key={t.code} value={t.code}>{t.label}</option>
                  ))}
                </select>
                {contractForm.formState.errors.type && (
                  <p className={errorClass}>{contractForm.formState.errors.type.message}</p>
                )}
              </div>
              <div>
                <label className={labelClass}>Salaire brut mensuel (€) *</label>
                <input
                  {...contractForm.register('grossSalary', { valueAsNumber: true })}
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="3 500"
                  className={inputClass}
                />
                {contractForm.formState.errors.grossSalary && (
                  <p className={errorClass}>{contractForm.formState.errors.grossSalary.message}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Date de début *</label>
                <input
                  {...contractForm.register('startDate')}
                  type="date"
                  className={inputClass}
                />
                {contractForm.formState.errors.startDate && (
                  <p className={errorClass}>{contractForm.formState.errors.startDate.message}</p>
                )}
              </div>
              <div>
                <label className={labelClass}>Date de fin <span className="font-normal text-gray-400">(CDD)</span></label>
                <input
                  {...contractForm.register('endDate')}
                  type="date"
                  className={inputClass}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Fin période d'essai</label>
                <input
                  {...contractForm.register('trialPeriodEnd')}
                  type="date"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Jours de télétravail / semaine</label>
                <input
                  {...contractForm.register('telecommutingDays', { valueAsNumber: true })}
                  type="number"
                  min={0}
                  max={5}
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label className={labelClass}>Convention collective</label>
              <select
                {...contractForm.register('collectiveAgreement')}
                className={inputClass}
              >
                <option value="">— Aucune / Non renseignée —</option>
                {collectiveAgreements.map((c) => (
                  <option key={c.code} value={c.label}>{c.label}</option>
                ))}
              </select>
            </div>

            {/* ── Documents du contrat ── */}
            <div className="space-y-3 border border-gray-200 rounded-xl p-4 bg-gray-50">
              <p className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                <Paperclip className="w-4 h-4 text-gray-500" />
                Documents à joindre
              </p>

              {/* Contrat signé */}
              <div>
                <label className={labelClass}>Contrat signé <span className="text-gray-400 font-normal">(PDF, Word — optionnel)</span></label>
                {contractFile ? (
                  <div className="flex items-center gap-2 p-2 bg-white border border-indigo-200 rounded-lg">
                    <FileText className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                    <span className="text-sm text-gray-700 truncate flex-1">{contractFile.name}</span>
                    <span className="text-xs text-gray-400">{(contractFile.size / 1024).toFixed(0)} Ko</span>
                    <button type="button" onClick={() => setContractFile(null)} className="text-gray-400 hover:text-red-500">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <label className="flex items-center gap-2 px-3 py-2 border border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition-colors">
                    <Upload className="w-4 h-4 text-gray-400" />
                    <span className="text-sm text-gray-500">Cliquer pour sélectionner le contrat</span>
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx"
                      className="hidden"
                      onChange={(e) => setContractFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                )}
              </div>

              {/* Avenants */}
              <div>
                <label className={labelClass}>Avenants <span className="text-gray-400 font-normal">(plusieurs fichiers possibles)</span></label>
                <label className="flex items-center gap-2 px-3 py-2 border border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition-colors">
                  <Upload className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-500">Ajouter des avenants</span>
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const newFiles = Array.from(e.target.files ?? [])
                      setAmendmentFiles((prev) => [...prev, ...newFiles])
                      e.target.value = ''
                    }}
                  />
                </label>
                {amendmentFiles.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {amendmentFiles.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 bg-white border border-gray-200 rounded-lg">
                        <FileText className="w-4 h-4 text-purple-500 flex-shrink-0" />
                        <span className="text-sm text-gray-700 truncate flex-1">{f.name}</span>
                        <span className="text-xs text-gray-400">{(f.size / 1024).toFixed(0)} Ko</span>
                        <button type="button" onClick={() => setAmendmentFiles((prev) => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ── Créer un compte + envoyer email de bienvenue ── */}
            <div className={cn(
              'flex items-start gap-3 p-4 rounded-lg border transition-colors cursor-pointer',
              createAccount ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-gray-200'
            )} onClick={() => setCreateAccount(!createAccount)}>
              <div className={cn(
                'mt-0.5 w-5 h-5 rounded flex items-center justify-center border-2 flex-shrink-0 transition-colors',
                createAccount ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300 bg-white'
              )}>
                {createAccount && <span className="text-white text-xs font-bold">✓</span>}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-indigo-500" />
                  <span className="text-sm font-medium text-gray-900">Créer un accès et envoyer les identifiants</span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  Un compte sera créé avec un mot de passe temporaire envoyé à{' '}
                  <strong>{personalData?.email ?? 'l\'adresse email renseignée'}</strong>.
                  Le collaborateur devra le changer à la première connexion.
                </p>
              </div>
            </div>

            {apiError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {apiError}
              </div>
            )}

            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={() => setCurrentStep(1)}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                ← Retour
              </button>
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {createMutation.isPending ? (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {createMutation.isPending
                  ? 'Création en cours…'
                  : createAccount
                  ? 'Créer et envoyer les identifiants'
                  : 'Créer le collaborateur'}
              </button>
            </div>
          </form>
        )}
      </motion.div>
    </div>
  )
}
