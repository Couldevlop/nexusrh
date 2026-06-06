import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { ShieldCheck, ShieldOff, KeyRound, AlertTriangle, CheckCircle2, Copy } from 'lucide-react'

interface SetupResponse {
  qrCodeDataUrl: string
  secret: string
  backupCodes: string[]
}

/**
 * Page Paramètres > Sécurité > MFA.
 * Flow :
 *   1. Affiche statut actuel (mfaEnabled depuis user store si dispo, sinon /auth/me)
 *   2. Si désactivé : bouton "Activer MFA" → setup → affiche QR + backup codes
 *      → input 6 digits → verify → success
 *   3. Si activé : bouton "Désactiver MFA" → demande mot de passe → disable
 */
export default function MfaSettingsPage() {
  const { t } = useTranslation('settings')
  const user = useAuthStore((s) => s.user)
  const [step, setStep] = useState<'idle' | 'setup' | 'verify' | 'disable'>('idle')
  const [setupData, setSetupData] = useState<SetupResponse | null>(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [disablePwd, setDisablePwd] = useState('')
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  const setupMut = useMutation({
    mutationFn: () => api.post<SetupResponse>('/auth/mfa/setup').then((r) => r.data),
    onSuccess: (data) => { setSetupData(data); setStep('setup'); setFeedback(null) },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string } } }
      setFeedback({ type: 'error', msg: e.response?.data?.error ?? t('mfa.setupError') })
    },
  })

  const verifyMut = useMutation({
    mutationFn: (code: string) => api.post('/auth/mfa/verify', { code }).then((r) => r.data),
    onSuccess: () => {
      setStep('idle'); setSetupData(null); setVerifyCode('')
      setFeedback({ type: 'success', msg: t('mfa.verifySuccess') })
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string } } }
      setFeedback({ type: 'error', msg: e.response?.data?.error ?? t('mfa.verifyError') })
    },
  })

  const disableMut = useMutation({
    mutationFn: (password: string) => api.post('/auth/mfa/disable', { password }).then((r) => r.data),
    onSuccess: () => {
      setStep('idle'); setDisablePwd('')
      setFeedback({ type: 'success', msg: t('mfa.disableSuccess') })
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string } } }
      setFeedback({ type: 'error', msg: e.response?.data?.error ?? t('mfa.disableError') })
    },
  })

  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {})

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">{t('mfa.title')}</h2>
        <p className="mt-1 text-sm text-gray-500">{t('mfa.subtitle')}</p>
      </div>

      {feedback && (
        <div className={`rounded-xl px-4 py-3 text-sm ${
          feedback.type === 'success'
            ? 'bg-green-50 border border-green-100 text-green-800'
            : 'bg-red-50 border border-red-100 text-red-800'
        }`}>
          {feedback.msg}
        </div>
      )}

      {/* État idle : bouton activer ou désactiver */}
      {step === 'idle' && (
        <div className="bg-white rounded-xl border border-gray-100 p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50">
              <ShieldCheck className="h-6 w-6 text-indigo-600" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-gray-900">
                {user ? t('mfa.statusConfigurable') : t('mfa.statusLoggedOut')}
              </p>
              <p className="mt-1 text-sm text-gray-500">{t('mfa.statusHint')}</p>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => setupMut.mutate()}
                  disabled={setupMut.isPending}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {setupMut.isPending ? t('mfa.initializing') : t('mfa.enable')}
                </button>
                <button
                  onClick={() => { setStep('disable'); setFeedback(null) }}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  {t('mfa.disable')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Setup : QR + backup codes */}
      {step === 'setup' && setupData && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-6">
            <p className="font-semibold text-gray-900 mb-1">{t('mfa.setup.step1Title')}</p>
            <p className="text-sm text-gray-500 mb-4">{t('mfa.setup.step1Desc')}</p>
            <div className="flex flex-col sm:flex-row items-start gap-4">
              <img src={setupData.qrCodeDataUrl} alt={t('mfa.setup.qrAlt')} className="h-48 w-48 rounded-lg border border-gray-200" />
              <div className="flex-1 text-sm">
                <p className="text-gray-500 mb-2">{t('mfa.setup.manualHint')}</p>
                <code className="block break-all rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700">
                  {setupData.secret}
                </code>
                <button
                  onClick={() => copy(setupData.secret)}
                  className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Copy className="h-3 w-3" /> {t('mfa.setup.copy')}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
            <div className="flex items-start gap-3 mb-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
              <div>
                <p className="font-semibold text-amber-900">{t('mfa.setup.step2Title')}</p>
                <p className="mt-1 text-sm text-amber-800">{t('mfa.setup.step2Desc')}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-sm">
              {setupData.backupCodes.map((c, i) => (
                <div key={i} className="rounded-md bg-white px-3 py-2 text-amber-900 text-center font-semibold">
                  {c}
                </div>
              ))}
            </div>
            <button
              onClick={() => copy(setupData.backupCodes.join('\n'))}
              className="mt-3 inline-flex items-center gap-1 text-xs text-amber-700 hover:underline"
            >
              <Copy className="h-3 w-3" /> {t('mfa.setup.copyAll')}
            </button>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 p-6">
            <p className="font-semibold text-gray-900 mb-1">{t('mfa.setup.step3Title')}</p>
            <p className="text-sm text-gray-500 mb-4">{t('mfa.setup.step3Desc')}</p>
            <form
              onSubmit={(e) => { e.preventDefault(); if (verifyCode.length === 6) verifyMut.mutate(verifyCode) }}
              className="flex gap-3"
            >
              <input
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder={t('mfa.setup.codePlaceholder')}
                maxLength={6}
                inputMode="numeric"
                className="flex-1 rounded-xl border border-gray-200 px-4 py-3 text-center text-lg font-mono tracking-widest focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="submit"
                disabled={verifyCode.length !== 6 || verifyMut.isPending}
                className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
              >
                <CheckCircle2 className="h-4 w-4" />
                {verifyMut.isPending ? t('mfa.setup.verifying') : t('mfa.setup.activate')}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Désactivation : demande mot de passe */}
      {step === 'disable' && (
        <div className="bg-white rounded-xl border border-gray-100 p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50">
              <ShieldOff className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="font-semibold text-gray-900">{t('mfa.disablePanel.title')}</p>
              <p className="mt-1 text-sm text-gray-500">{t('mfa.disablePanel.desc')}</p>
            </div>
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); if (disablePwd) disableMut.mutate(disablePwd) }}
            className="space-y-3"
          >
            <input
              value={disablePwd}
              onChange={(e) => setDisablePwd(e.target.value)}
              type="password"
              placeholder={t('mfa.disablePanel.passwordPlaceholder')}
              className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={!disablePwd || disableMut.isPending}
                className="rounded-xl bg-red-600 px-6 py-3 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                <KeyRound className="h-4 w-4" />
                {disableMut.isPending ? t('mfa.disablePanel.disabling') : t('mfa.disablePanel.disable')}
              </button>
              <button
                type="button"
                onClick={() => { setStep('idle'); setDisablePwd(''); setFeedback(null) }}
                className="rounded-xl border border-gray-200 px-6 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                {t('mfa.disablePanel.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
