import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslation } from 'react-i18next'
import axios from 'axios'
import { KeyRound, ArrowLeft, CheckCircle2 } from 'lucide-react'

const schema = z.object({
  newPassword: z.string()
    .min(12, 'auth:validation.min12Chars')
    .max(256)
    .regex(/[A-Z]/, 'auth:validation.uppercase')
    .regex(/[a-z]/, 'auth:validation.lowercase')
    .regex(/[0-9]/, 'auth:validation.digit'),
  confirm: z.string(),
}).refine((d) => d.newPassword === d.confirm, {
  path: ['confirm'], message: 'auth:validation.passwordsMismatch',
})
type Form = z.infer<typeof schema>

const API_BASE = import.meta.env.VITE_API_URL ?? '/api'

export default function ResetPasswordPage() {
  const { t } = useTranslation('auth')
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''

  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form>({
    resolver: zodResolver(schema),
  })

  const onSubmit = async (data: Form) => {
    setError(null)
    try {
      await axios.post(`${API_BASE}/auth/reset-password`, {
        token, newPassword: data.newPassword,
      })
      setDone(true)
      setTimeout(() => navigate('/login', { replace: true }), 3500)
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      const status = e.response?.status
      if (status === 410) setError(t('reset.errorExpired'))
      else if (status === 409) setError(t('reset.errorUsed'))
      else if (status === 404) setError(t('reset.errorInvalid'))
      else setError(e.response?.data?.error ?? t('reset.errorGeneric'))
    }
  }

  // Pas de token dans l'URL : message d'erreur immédiat
  if (!token) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-amber-50 flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-8">
            <h1 className="text-lg font-bold text-gray-900 mb-2">{t('reset.noTokenTitle')}</h1>
            <p className="text-sm text-gray-600">
              {t('reset.noTokenBody')}
            </p>
            <Link to="/forgot-password" className="mt-4 inline-block text-sm text-primary font-medium hover:underline">
              {t('reset.requestNewLink')}
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-amber-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary font-black text-sm text-primary-foreground">N</div>
            <span className="font-black text-lg">NexusRH CI</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{t('reset.title')}</h1>
          <p className="mt-2 text-sm text-gray-500">
            {t('reset.subtitle')}
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          {done ? (
            <div className="text-center py-4">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-100 mb-4">
                <CheckCircle2 className="h-7 w-7 text-green-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900 mb-2">{t('reset.doneTitle')}</h2>
              <p className="text-sm text-gray-600">{t('reset.doneBody')}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {t('reset.newPasswordLabel')}
                </label>
                <input
                  {...register('newPassword')}
                  type="password"
                  autoFocus
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                {errors.newPassword && (
                  <p className="mt-1.5 text-xs text-red-500">{t(errors.newPassword.message ?? '')}</p>
                )}
                <p className="mt-2 text-xs text-gray-500">
                  {t('reset.newPasswordHint')}
                </p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {t('reset.confirmLabel')}
                </label>
                <input
                  {...register('confirm')}
                  type="password"
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                {errors.confirm && (
                  <p className="mt-1.5 text-xs text-red-500">{t(errors.confirm.message ?? '')}</p>
                )}
              </div>
              {error && (
                <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                <KeyRound className="h-4 w-4" />
                {isSubmitting ? t('reset.submitting') : t('reset.submit')}
              </button>
            </form>
          )}
        </div>

        <Link
          to="/login"
          className="mt-6 inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" /> {t('reset.backToLogin')}
        </Link>
      </div>
    </div>
  )
}
