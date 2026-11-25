/**
 * Changement de mot de passe à l'initiative de l'utilisateur — route
 * `/change-password`, plein écran, HORS de tout layout gardé.
 *
 * POURQUOI CETTE PAGE. Le bandeau d'avertissement et le rappel par email
 * invitent à changer son mot de passe avant l'échéance, mais cette adresse
 * n'existait pas : le catch-all de l'application renvoyait silencieusement
 * vers `/`, et le seul formulaire disponible vivait dans l'espace employé
 * (`/mon-espace/profil`), inaccessible aux super_admin et aux cabinets — les
 * populations précisément restées dehors le 25/11/2026. L'API émet déjà
 * `redirectTo: '/change-password'` quand elle impose le changement : cette
 * page rend cette promesse tenable.
 *
 * Hors layout gardé pour la même raison que `/mfa-setup` : elle doit s'ouvrir
 * pour TOUS les rôles, y compris un token restreint `pwdResetRequired`, qui
 * n'autorise que ce parcours.
 *
 * RECONNEXION IMPOSÉE APRÈS SUCCÈS. Le serveur révoque les refresh tokens et
 * pose une nouvelle époque d'invalidation : tout JWT émis avant le changement
 * est rejeté en 401 au prochain appel, et ce handler ne délivre pas de
 * nouveau token. Rester dans l'application afficherait donc une session morte
 * qui tombe en panne au premier clic. On purge le store et on renvoie vers la
 * connexion, en l'annonçant clairement.
 */
import { useState } from 'react'
import { useNavigate, Navigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation } from '@tanstack/react-query'
import { KeyRound, AlertTriangle, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import nexusrhLogoDark from '@/assets/NexusRH-dark.png'
import openlabLogo from '@/assets/OPENLAB.png'

/** Mêmes exigences que le formulaire imposé de la page de connexion. */
const STRONG_PASSWORD = z
  .string()
  .min(12, 'auth:validation.minChars')
  .regex(/[A-Z]/, 'auth:validation.uppercase')
  .regex(/[a-z]/, 'auth:validation.lowercase')
  .regex(/[0-9]/, 'auth:validation.digit')
  .regex(/[^A-Za-z0-9]/, 'auth:validation.special')

const schema = z
  .object({
    oldPassword: z.string().min(1, 'auth:validation.passwordRequired'),
    newPassword: STRONG_PASSWORD,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'auth:validation.passwordsMismatch',
    path: ['confirmPassword'],
  })
  .refine((d) => d.newPassword !== d.oldPassword, {
    message: 'auth:changePage.sameAsOld',
    path: ['newPassword'],
  })

type FormValues = z.infer<typeof schema>

/** Critères affichés en direct : mêmes règles que le schéma ci-dessus. */
export function criteresMotDePasse(valeur: string): Array<{ cle: string; ok: boolean }> {
  return [
    { cle: 'strength.chars', ok: valeur.length >= 12 },
    { cle: 'strength.uppercase', ok: /[A-Z]/.test(valeur) },
    { cle: 'strength.lowercase', ok: /[a-z]/.test(valeur) },
    { cle: 'strength.digit', ok: /[0-9]/.test(valeur) },
    { cle: 'strength.special', ok: /[^A-Za-z0-9]/.test(valeur) },
  ]
}

export default function ChangePasswordPage() {
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const logout = useAuthStore((s) => s.logout)
  const joursRestants = useAuthStore((s) => s.passwordExpiresInDays)
  const setPasswordExpiry = useAuthStore((s) => s.setPasswordExpiry)

  const [error, setError] = useState<string | null>(null)

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const nouveau = form.watch('newPassword') ?? ''

  const mut = useMutation({
    mutationFn: (v: FormValues) =>
      api.post('/auth/change-password', {
        oldPassword: v.oldPassword,
        newPassword: v.newPassword,
      }),
    onSuccess: () => {
      // Le compte à rebours n'a plus lieu d'être : il est persisté, et le
      // laisser en place ferait réapparaître le bandeau après le changement.
      setPasswordExpiry(null)
      try {
        sessionStorage.setItem('nexusrh:password-changed', '1')
      } catch {
        /* quota / navigation privée — le message de succès est simplement perdu */
      }
      logout()
      navigate('/login', { replace: true })
    },
    onError: (err: unknown) => {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      if (e.response?.status === 429) {
        setError(t('changePage.rateLimited'))
        return
      }
      setError(e.response?.data?.error ?? t('change.error'))
    },
  })

  // Sans session, rien à changer : le lien d'un email cliqué après
  // déconnexion doit mener à la connexion, pas à un formulaire inerte.
  if (!token) return <Navigate to="/login" replace />

  const messageEcheance =
    joursRestants === null || joursRestants > 7
      ? null
      : joursRestants <= 0
        // Échu : ne pas annoncer « moins de 24 heures », le délai est passé.
        ? t('changePage.deadlinePassed')
        : joursRestants <= 1
          ? t('changePage.deadlineSoon')
          : t('changePage.deadlineInDays', { count: joursRestants })

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 dark:bg-gray-950">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <img src={nexusrhLogoDark} alt="NexusRH" className="h-12 w-auto object-contain" />
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="mb-5 flex items-center gap-3">
            <span className="rounded-lg bg-primary/10 p-2 text-primary">
              <KeyRound className="h-5 w-5" />
            </span>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-50">
              {t('changePage.title')}
            </h1>
          </div>

          {messageEcheance && (
            <p
              data-testid="change-password-deadline"
              className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
            >
              {messageEcheance}
            </p>
          )}

          <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
            {t('changePage.intro')}
          </p>

          {error && (
            <p
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-100"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <form
            onSubmit={form.handleSubmit((v) => {
              setError(null)
              mut.mutate(v)
            })}
            className="space-y-4"
          >
            <div>
              <label htmlFor="oldPassword" className="mb-1 block text-sm font-medium">
                {t('changePage.oldPasswordLabel')}
              </label>
              <input
                id="oldPassword"
                type="password"
                autoComplete="current-password"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                {...form.register('oldPassword')}
              />
              {form.formState.errors.oldPassword && (
                <p className="mt-1 text-xs text-red-600">
                  {t(form.formState.errors.oldPassword.message ?? '', { ns: undefined })}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="newPassword" className="mb-1 block text-sm font-medium">
                {t('change.newPasswordLabel')}
              </label>
              <input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                placeholder={t('change.newPasswordPlaceholder')}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                {...form.register('newPassword')}
              />
              {form.formState.errors.newPassword && (
                <p className="mt-1 text-xs text-red-600">
                  {t(form.formState.errors.newPassword.message ?? '', { ns: undefined })}
                </p>
              )}
              {nouveau && (
                <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                  {criteresMotDePasse(nouveau).map((c) => (
                    <li
                      key={c.cle}
                      className={`text-xs ${c.ok ? 'text-emerald-600' : 'text-gray-400'}`}
                    >
                      {c.ok ? '✓' : '·'} {t(c.cle)}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <label htmlFor="confirmPassword" className="mb-1 block text-sm font-medium">
                {t('change.confirmLabel')}
              </label>
              <input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                {...form.register('confirmPassword')}
              />
              {form.formState.errors.confirmPassword && (
                <p className="mt-1 text-xs text-red-600">
                  {t(form.formState.errors.confirmPassword.message ?? '', { ns: undefined })}
                </p>
              )}
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('changePage.reloginNotice')}
            </p>

            <button
              type="submit"
              disabled={mut.isPending}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {mut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mut.isPending ? t('change.submitting') : t('changePage.submit')}
            </button>
          </form>

          {/* Sortie : l'utilisateur qui arrive par curiosité ou par email ne
              doit pas se retrouver prisonnier de la page. */}
          <Link
            to="/"
            className="mt-5 block text-center text-sm text-gray-500 underline-offset-4 transition hover:text-gray-700 hover:underline"
          >
            {t('changePage.back')}
          </Link>
        </div>

        <div className="mt-8 flex items-center justify-center gap-2 opacity-50">
          <img src={openlabLogo} alt="OpenLab" className="h-5 w-auto object-contain" />
          <span className="text-xs text-gray-400">{t('footer.company')}</span>
        </div>
      </div>
    </div>
  )
}
