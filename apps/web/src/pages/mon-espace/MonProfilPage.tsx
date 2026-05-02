import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  User, Building2, Calendar, Phone, MapPin,
  CreditCard, Lock, CheckCircle, AlertTriangle, Camera,
} from 'lucide-react'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface EmployeeProfile {
  id: string
  firstName: string
  lastName: string
  email: string
  jobTitle: string
  departmentName: string
  managerName: string | null
  hireDate: string
  phone: string | null
  address: string | null
  avatarUrl: string | null
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const profileSchema = z.object({
  phone: z.string().optional(),
  address: z.string().optional(),
  iban: z.string().optional(),
  ibanConfirm: z.string().optional(),
}).refine(
  (d) => !d.iban || !d.ibanConfirm || d.iban === d.ibanConfirm,
  { message: "L'IBAN ne correspond pas", path: ['ibanConfirm'] }
)

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Mot de passe actuel requis'),
    newPassword: z
      .string()
      .min(8, 'Au moins 8 caractères')
      .regex(/[A-Z]/, 'Au moins une majuscule')
      .regex(/[0-9]/, 'Au moins un chiffre'),
    confirmPassword: z.string().min(1, 'Confirmation requise'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Les mots de passe ne correspondent pas',
    path: ['confirmPassword'],
  })

type ProfileFormData = z.infer<typeof profileSchema>
type PasswordFormData = z.infer<typeof passwordSchema>

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calculateSeniority(hireDate: string): string {
  const start = new Date(hireDate)
  const now = new Date()
  const years = now.getFullYear() - start.getFullYear()
  const months = now.getMonth() - start.getMonth()
  const totalMonths = years * 12 + months
  if (totalMonths < 12) {
    return `${totalMonths} mois`
  }
  const y = Math.floor(totalMonths / 12)
  const m = totalMonths % 12
  return m > 0 ? `${y} an${y > 1 ? 's' : ''} et ${m} mois` : `${y} an${y > 1 ? 's' : ''}`
}

// ─── Component ───────────────────────────────────────────────────────────────

export function MonProfilPage() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'info' | 'security'>('info')
  const [passwordSuccess, setPasswordSuccess] = useState(false)
  const [profileSuccess, setProfileSuccess] = useState(false)

  const { data: profile, isLoading } = useQuery<EmployeeProfile>({
    queryKey: ['my-profile'],
    queryFn: async () => {
      const res = await api.get<{ data: EmployeeProfile }>('/employees/my-profile')
      return res.data.data
    },
  })

  const {
    register: registerProfile,
    handleSubmit: handleProfileSubmit,
    formState: { errors: profileErrors },
  } = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    values: {
      phone: profile?.phone ?? '',
      address: profile?.address ?? '',
      iban: '',
      ibanConfirm: '',
    },
  })

  const {
    register: registerPassword,
    handleSubmit: handlePasswordSubmit,
    reset: resetPassword,
    formState: { errors: passwordErrors },
  } = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
  })

  const updateProfileMutation = useMutation({
    mutationFn: async (data: ProfileFormData) => {
      await api.patch('/employees/my-profile', {
        phone: data.phone || undefined,
        address: data.address || undefined,
        iban: data.iban || undefined,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-profile'] })
      setProfileSuccess(true)
      setTimeout(() => setProfileSuccess(false), 3000)
    },
  })

  const changePasswordMutation = useMutation({
    mutationFn: async (data: PasswordFormData) => {
      await api.post('/auth/change-password', {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      })
    },
    onSuccess: () => {
      resetPassword()
      setPasswordSuccess(true)
      setTimeout(() => setPasswordSuccess(false), 3000)
    },
  })

  const initials = profile
    ? `${profile.firstName.charAt(0)}${profile.lastName.charAt(0)}`
    : `${user?.firstName?.charAt(0) ?? ''}${user?.lastName?.charAt(0) ?? ''}`

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Mon profil</h1>
        <p className="text-sm text-gray-500 mt-1">Gérez vos informations personnelles</p>
      </div>

      {/* Profile header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-xl border border-gray-200 shadow-sm p-6"
      >
        <div className="flex items-start gap-5">
          <div className="relative group">
            <div className="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center text-white text-xl font-bold overflow-hidden">
              {profile?.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt={initials}
                  className="w-full h-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <button
              className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Modifier la photo"
            >
              <Camera className="w-5 h-5 text-white" />
            </button>
          </div>

          {isLoading ? (
            <div className="space-y-2 flex-1">
              <div className="h-5 w-40 bg-gray-100 rounded animate-pulse" />
              <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
            </div>
          ) : (
            <div className="flex-1">
              <h2 className="text-lg font-bold text-gray-900">
                {profile?.firstName} {profile?.lastName}
              </h2>
              <p className="text-sm text-gray-500">{profile?.jobTitle}</p>
              <div className="flex flex-wrap gap-3 mt-3">
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 bg-gray-100 px-2.5 py-1 rounded-full">
                  <Building2 className="w-3.5 h-3.5" />
                  {profile?.departmentName}
                </span>
                {profile?.managerName && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 bg-gray-100 px-2.5 py-1 rounded-full">
                    <User className="w-3.5 h-3.5" />
                    Manager : {profile.managerName}
                  </span>
                )}
                {profile?.hireDate && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 bg-gray-100 px-2.5 py-1 rounded-full">
                    <Calendar className="w-3.5 h-3.5" />
                    {calculateSeniority(profile.hireDate)} d'ancienneté
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {(
          [
            { id: 'info', label: 'Informations' },
            { id: 'security', label: 'Sécurité' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-lg transition-colors',
              activeTab === tab.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab: Informations */}
      {activeTab === 'info' && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-6"
        >
          <h3 className="text-sm font-semibold text-gray-900 mb-5">
            Informations modifiables
          </h3>
          <form onSubmit={handleProfileSubmit((d) => updateProfileMutation.mutate(d))} className="space-y-5">
            {/* Phone */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <span className="flex items-center gap-1.5">
                  <Phone className="w-4 h-4" />
                  Téléphone
                </span>
              </label>
              <input
                type="tel"
                {...registerProfile('phone')}
                placeholder="+33 6 00 00 00 00"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* Address */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-4 h-4" />
                  Adresse personnelle
                </span>
              </label>
              <textarea
                {...registerProfile('address')}
                rows={2}
                placeholder="Votre adresse..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />
            </div>

            {/* IBAN */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <span className="flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4" />
                  IBAN (pour virement de salaire)
                </span>
              </label>
              <input
                type="text"
                {...registerProfile('iban')}
                placeholder="FR76 XXXX XXXX XXXX XXXX XXXX XXX"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
              />
            </div>

            {/* IBAN confirm */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Confirmer l'IBAN
              </label>
              <input
                type="text"
                {...registerProfile('ibanConfirm')}
                placeholder="Saisissez à nouveau l'IBAN"
                className={cn(
                  'w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono',
                  profileErrors.ibanConfirm ? 'border-red-300' : 'border-gray-300'
                )}
              />
              {profileErrors.ibanConfirm && (
                <p className="text-xs text-red-500 mt-1">{profileErrors.ibanConfirm.message}</p>
              )}
            </div>

            {profileSuccess && (
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle className="w-4 h-4" />
                Profil mis à jour avec succès
              </div>
            )}

            {updateProfileMutation.isError && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4" />
                Une erreur est survenue. Veuillez réessayer.
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={updateProfileMutation.isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-60"
              >
                {updateProfileMutation.isPending ? 'Sauvegarde...' : 'Sauvegarder'}
              </button>
            </div>
          </form>
        </motion.div>
      )}

      {/* Tab: Sécurité */}
      {activeTab === 'security' && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-6"
        >
          <h3 className="text-sm font-semibold text-gray-900 mb-5 flex items-center gap-2">
            <Lock className="w-4 h-4" />
            Changer de mot de passe
          </h3>
          <form
            onSubmit={handlePasswordSubmit((d) => changePasswordMutation.mutate(d))}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Mot de passe actuel <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                {...registerPassword('currentPassword')}
                className={cn(
                  'w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500',
                  passwordErrors.currentPassword ? 'border-red-300' : 'border-gray-300'
                )}
              />
              {passwordErrors.currentPassword && (
                <p className="text-xs text-red-500 mt-1">
                  {passwordErrors.currentPassword.message}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Nouveau mot de passe <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                {...registerPassword('newPassword')}
                className={cn(
                  'w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500',
                  passwordErrors.newPassword ? 'border-red-300' : 'border-gray-300'
                )}
              />
              {passwordErrors.newPassword && (
                <p className="text-xs text-red-500 mt-1">{passwordErrors.newPassword.message}</p>
              )}
              <p className="text-xs text-gray-400 mt-1">
                Au moins 8 caractères, une majuscule et un chiffre
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Confirmer le nouveau mot de passe <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                {...registerPassword('confirmPassword')}
                className={cn(
                  'w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500',
                  passwordErrors.confirmPassword ? 'border-red-300' : 'border-gray-300'
                )}
              />
              {passwordErrors.confirmPassword && (
                <p className="text-xs text-red-500 mt-1">
                  {passwordErrors.confirmPassword.message}
                </p>
              )}
            </div>

            {passwordSuccess && (
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                <CheckCircle className="w-4 h-4" />
                Mot de passe modifié avec succès
              </div>
            )}

            {changePasswordMutation.isError && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4" />
                Mot de passe actuel incorrect ou erreur serveur.
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={changePasswordMutation.isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-60"
              >
                {changePasswordMutation.isPending ? 'Modification...' : 'Modifier le mot de passe'}
              </button>
            </div>
          </form>
        </motion.div>
      )}
    </div>
  )
}
