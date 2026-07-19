import { useEffect, useRef, useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import nexusrhLogoDark from '@/assets/NexusRH-dark.png'
import openlabLogo from '@/assets/OPENLAB.png'
import {
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
} from 'lucide-react'

interface SetupResponse {
  qrCodeDataUrl: string
  secret: string
  backupCodes: string[]
}

/**
 * Page d'enrôlement MFA IMPOSÉE — route `/mfa-setup`, plein écran, hors de
 * tout layout gardé (PlatformGuard / AgencyGuard / layout tenant) afin d'être
 * accessible à TOUS les rôles (super_admin, admin, employee…).
 *
 * Contexte : quand la MFA est obligatoire et que l'utilisateur ne l'a pas encore
 * enrôlée, `POST /auth/login` renvoie 200 avec un token RESTREINT (`mfaPending`).
 * Ce token n'ouvre QUE `/auth/mfa/setup` et `/auth/mfa/verify` ; toute route
 * métier répond 403. Rediriger vers une page applicative (ex. `/settings`)
 * produit donc un écran vide — d'où cette page dédiée.
 *
 * IMPORTANT : après un `/verify` réussi le token reste restreint (le serveur ne
 * délivre pas de session pleine). On purge donc le store et on impose une
 * reconnexion, qui passera cette fois par le challenge TOTP (202).
 */
export default function MfaEnrollmentPage() {
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const logout = useAuthStore((s) => s.logout)

  const [setupData, setSetupData] = useState<SetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'secret' | 'codes' | null>(null)

  const setupMut = useMutation({
    mutationFn: () => api.post<SetupResponse>('/auth/mfa/setup').then((r) => r.data),
    onSuccess: (data) => {
      setSetupData(data)
      setError(null)
    },
    onError: (err: unknown) => {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      setError(e.response?.data?.error ?? t('mfaEnroll.setupError'))
    },
  })

  const verifyMut = useMutation({
    mutationFn: (value: string) =>
      api.post('/auth/mfa/verify', { code: value }).then((r) => r.data),
    onSuccess: () => {
      // Le token en poche reste RESTREINT après activation : on ne l'utilise
      // jamais pour entrer dans l'application (403 garanti). Reconnexion imposée.
      try {
        sessionStorage.setItem('nexusrh:mfa-enrolled', '1')
      } catch {
        /* quota / navigation privée — le message de succès est simplement perdu */
      }
      logout()
      navigate('/login', { replace: true })
    },
    onError: (err: unknown) => {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      // /auth/mfa/verify est limité à 5 tentatives / 15 min côté serveur.
      if (e.response?.status === 429) {
        setError(t('mfaEnroll.rateLimited'))
        return
      }
      setError(e.response?.data?.error ?? t('mfaEnroll.verifyError'))
    },
  })

  // Initialisation du secret dès l'arrivée sur la page (une seule fois, même
  // sous StrictMode où l'effet est rejoué à froid).
  const started = useRef(false)
  const { mutate: startSetup } = setupMut
  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    startSetup()
  }, [token, startSetup])

  // Pas de session du tout → rien à enrôler, retour à la connexion.
  if (!token) return <Navigate to="/login" replace />

  const copy = (text: string, what: 'secret' | 'codes') => {
    try {
      void navigator.clipboard?.writeText(text).then(
        () => setCopied(what),
        () => setCopied(null),
      )
    } catch {
      /* clipboard indisponible (contexte non sécurisé) — copie manuelle possible */
    }
  }

  const downloadCodes = (codes: string[]) => {
    try {
      const blob = new Blob([codes.join('\n')], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'nexusrh-codes-de-secours.txt'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      /* environnement sans Blob/URL — les codes restent copiables à l'écran */
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-2xl">
        {/* En-tête */}
        <div className="mb-8 flex flex-col items-center text-center">
          <img src={nexusrhLogoDark} alt="NexusRH CI" className="mb-6 h-9 w-auto object-contain" />
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100">
            <ShieldCheck className="h-6 w-6 text-indigo-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{t('mfaEnroll.title')}</h1>
          <p className="mt-1 text-sm text-gray-500">{t('mfaEnroll.subtitle')}</p>
        </div>

        {/* Parcours imposé : aucune échappatoire vers l'application */}
        <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
          {t('mfaEnroll.mandatoryNotice')}
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {setupMut.isPending && !setupData && (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-gray-100 bg-white px-6 py-10 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('mfaEnroll.loading')}
          </div>
        )}

        {setupData && (
          <div className="space-y-4">
            {/* Étape 1 — scanner le QR */}
            <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
              <p className="mb-1 font-semibold text-gray-900">{t('mfaEnroll.step1Title')}</p>
              <p className="mb-4 text-sm text-gray-500">{t('mfaEnroll.step1Desc')}</p>
              <div className="flex flex-col items-start gap-4 sm:flex-row">
                <img
                  src={setupData.qrCodeDataUrl}
                  alt={t('mfaEnroll.qrAlt')}
                  className="h-48 w-48 rounded-lg border border-gray-200"
                />
                <div className="flex-1 text-sm">
                  <p className="mb-2 text-gray-500">{t('mfaEnroll.manualHint')}</p>
                  <code className="block break-all rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700">
                    {setupData.secret}
                  </code>
                  <button
                    type="button"
                    onClick={() => copy(setupData.secret, 'secret')}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Copy className="h-3 w-3" />
                    {copied === 'secret' ? t('mfaEnroll.copied') : t('mfaEnroll.copySecret')}
                  </button>
                </div>
              </div>
            </div>

            {/* Étape 2 — codes de secours (affichés UNE SEULE FOIS) */}
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
              <div className="mb-3 flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-semibold text-amber-900">{t('mfaEnroll.step2Title')}</p>
                  <p className="mt-1 text-sm text-amber-800">{t('mfaEnroll.step2Desc')}</p>
                  <p className="mt-2 text-sm font-semibold text-amber-900">
                    {t('mfaEnroll.backupWarning')}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                {setupData.backupCodes.map((c) => (
                  <div
                    key={c}
                    className="rounded-md bg-white px-3 py-2 text-center font-semibold text-amber-900"
                  >
                    {c}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-4">
                <button
                  type="button"
                  onClick={() => copy(setupData.backupCodes.join('\n'), 'codes')}
                  className="inline-flex items-center gap-1 text-xs text-amber-700 hover:underline"
                >
                  <Copy className="h-3 w-3" />
                  {copied === 'codes' ? t('mfaEnroll.copied') : t('mfaEnroll.copyCodes')}
                </button>
                <button
                  type="button"
                  onClick={() => downloadCodes(setupData.backupCodes)}
                  className="inline-flex items-center gap-1 text-xs text-amber-700 hover:underline"
                >
                  <Download className="h-3 w-3" />
                  {t('mfaEnroll.downloadCodes')}
                </button>
              </div>
            </div>

            {/* Étape 3 — vérification du code à 6 chiffres */}
            <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
              <p className="mb-1 font-semibold text-gray-900">{t('mfaEnroll.step3Title')}</p>
              <p className="mb-2 text-sm text-gray-500">{t('mfaEnroll.step3Desc')}</p>
              {/* Cause n°1 des codes refusés alors que la clé est bonne : dérive
                  d'horloge du téléphone (fenêtres TOTP de 30 s). */}
              <p className="mb-4 text-xs text-gray-400">{t('mfaEnroll.clockHint')}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (code.length === 6) verifyMut.mutate(code)
                }}
                className="flex flex-col gap-3 sm:flex-row"
              >
                <input
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={t('mfaEnroll.codePlaceholder')}
                  maxLength={6}
                  inputMode="numeric"
                  className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-center font-mono text-lg tracking-widest text-gray-900 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="submit"
                  disabled={code.length !== 6 || verifyMut.isPending}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  {verifyMut.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  {verifyMut.isPending ? t('mfaEnroll.activating') : t('mfaEnroll.activate')}
                </button>
              </form>
              <p className="mt-3 text-xs text-gray-500">{t('mfaEnroll.relogHint')}</p>
            </div>
          </div>
        )}

        {/* Setup en échec : proposer une nouvelle tentative (pas de sortie vers l'app) */}
        {!setupData && !setupMut.isPending && error && (
          <button
            type="button"
            onClick={() => setupMut.mutate()}
            className="mt-4 w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            {t('mfaEnroll.retry')}
          </button>
        )}

        {/* Sortie de secours : jamais vers l'app (le token restreint y produirait
            des 403), mais l'utilisateur ne doit pas rester prisonnier de la page
            s'il ne parvient pas à enrôler sa MFA (incident prod du 2026-07-20). */}
        <button
          type="button"
          onClick={() => { logout(); navigate('/login', { replace: true }) }}
          className="mt-6 w-full text-center text-sm text-gray-500 underline-offset-4 transition hover:text-gray-700 hover:underline"
        >
          {t('mfaEnroll.signOut')}
        </button>

        <div className="mt-8 flex items-center justify-center gap-2 opacity-50">
          <img src={openlabLogo} alt="OpenLab" className="h-5 w-auto object-contain" />
          <span className="text-xs text-gray-400">{t('footer.company')}</span>
        </div>
      </div>
    </div>
  )
}
