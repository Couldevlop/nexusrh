import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslation, Trans } from 'react-i18next'
import axios from 'axios'
import { MailCheck, ArrowLeft } from 'lucide-react'

const schema = z.object({
  email: z.string().email('auth:validation.emailInvalid').max(254),
})
type Form = z.infer<typeof schema>

const API_BASE = import.meta.env.VITE_API_URL ?? '/api'

/**
 * Page publique : demande de réinitialisation de mot de passe.
 * Anti-énumération côté API : on reçoit toujours 200 OK, même si l'email
 * n'existe pas. Le message à l'utilisateur est volontairement générique.
 */
export default function ForgotPasswordPage() {
  const { t } = useTranslation('auth')
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form>({
    resolver: zodResolver(schema),
  })
  const [sent, setSent] = useState(false)

  const onSubmit = async (data: Form) => {
    try {
      await axios.post(`${API_BASE}/auth/forgot-password`, data)
    } catch {
      // Anti-énumération : on affiche succès même si erreur réseau
    }
    setSent(true)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-amber-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary font-black text-sm text-primary-foreground">N</div>
            <span className="font-black text-lg">NexusRH CI</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{t('forgot.title')}</h1>
          <p className="mt-2 text-sm text-gray-500">
            {t('forgot.subtitle')}
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          {sent ? (
            <div className="text-center py-4">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-100 mb-4">
                <MailCheck className="h-7 w-7 text-green-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900 mb-2">
                {t('forgot.sentTitle')}
              </h2>
              <p className="text-sm text-gray-600 leading-relaxed">
                <Trans i18nKey="forgot.sentBody" ns="auth" components={{ strong: <strong /> }} />
              </p>
              <p className="mt-4 text-xs text-gray-400">
                {t('forgot.sentSpam')}
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {t('forgot.emailLabel')}
                </label>
                <input
                  {...register('email')}
                  type="email"
                  autoFocus
                  placeholder={t('forgot.emailPlaceholder')}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                {errors.email && (
                  <p className="mt-1.5 text-xs text-red-500">{t(errors.email.message ?? '')}</p>
                )}
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {isSubmitting ? t('forgot.submitting') : t('forgot.submit')}
              </button>
            </form>
          )}
        </div>

        <Link
          to="/login"
          className="mt-6 inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" /> {t('forgot.backToLogin')}
        </Link>
      </div>
    </div>
  )
}
