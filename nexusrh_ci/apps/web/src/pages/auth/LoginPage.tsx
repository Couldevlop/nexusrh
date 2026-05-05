import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/lib/api'
import { useAuthStore, type AuthUser, type TenantConfig } from '@/stores/authStore'
import { Loader2, Eye, EyeOff, ShieldCheck, CheckCircle } from 'lucide-react'

// ── Schémas Zod ──────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email:    z.string().email('Email invalide'),
  password: z.string().min(1, 'Mot de passe requis'),
})

const STRONG_PASSWORD = z
  .string()
  .min(12, 'Minimum 12 caractères')
  .regex(/[A-Z]/, 'Au moins une majuscule')
  .regex(/[a-z]/, 'Au moins une minuscule')
  .regex(/[0-9]/, 'Au moins un chiffre')
  .regex(/[^A-Za-z0-9]/, 'Au moins un caractère spécial (!@#$…)')

const changeSchema = z.object({
  newPassword:    STRONG_PASSWORD,
  confirmPassword: z.string(),
}).refine(d => d.newPassword === d.confirmPassword, {
  message: 'Les mots de passe ne correspondent pas',
  path: ['confirmPassword'],
})

type LoginForm   = z.infer<typeof loginSchema>
type ChangeForm  = z.infer<typeof changeSchema>

// ── Indicateur de force ───────────────────────────────────────────────────────

function PasswordStrength({ value }: { value: string }) {
  const checks = [
    { label: '12 caractères',        ok: value.length >= 12 },
    { label: 'Majuscule',            ok: /[A-Z]/.test(value) },
    { label: 'Minuscule',            ok: /[a-z]/.test(value) },
    { label: 'Chiffre',              ok: /[0-9]/.test(value) },
    { label: 'Caractère spécial',    ok: /[^A-Za-z0-9]/.test(value) },
  ]
  const score = checks.filter(c => c.ok).length
  const color = score <= 2 ? 'bg-red-500' : score <= 3 ? 'bg-amber-500' : score <= 4 ? 'bg-yellow-400' : 'bg-emerald-500'

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-1">
        {checks.map((_, i) => (
          <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i < score ? color : 'bg-muted'}`} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {checks.map(c => (
          <div key={c.label} className={`flex items-center gap-1 text-xs ${c.ok ? 'text-emerald-600' : 'text-muted-foreground'}`}>
            <CheckCircle className={`h-3 w-3 shrink-0 ${c.ok ? 'opacity-100' : 'opacity-30'}`} />
            {c.label}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Page principale ───────────────────────────────────────────────────────────

export default function LoginPage() {
  const navigate = useNavigate()
  const setAuth  = useAuthStore(s => s.setAuth)

  const [error, setError]           = useState<string | null>(null)
  const [showPwd, setShowPwd]       = useState(false)
  const [showNewPwd, setShowNewPwd] = useState(false)

  // Etat "première connexion"
  const [mustChange, setMustChange]   = useState(false)
  const [pendingAuth, setPendingAuth] = useState<{
    user: AuthUser; token: string; refreshToken: string
    tenantConfig: TenantConfig | null; redirectTo: string
  } | null>(null)

  // ── Formulaire login ──

  const loginForm = useForm<LoginForm>({ resolver: zodResolver(loginSchema) })

  const onLogin = async (data: LoginForm) => {
    setError(null)
    try {
      const res = await api.post<{
        token: string; refreshToken: string; user: AuthUser
        tenantConfig: TenantConfig | null; redirectTo: string
        must_change_password?: boolean
      }>('/auth/login', data)

      if (res.data.must_change_password === true) {
        setPendingAuth(res.data)
        setMustChange(true)
        return
      }

      setAuth(res.data.user, res.data.token, res.data.refreshToken, res.data.tenantConfig)
      navigate(res.data.redirectTo ?? '/', { replace: true })
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setError(e.response?.data?.error ?? 'Identifiants invalides')
    }
  }

  // ── Formulaire changement mot de passe ──

  const changeForm = useForm<ChangeForm>({ resolver: zodResolver(changeSchema) })
  const pwdValue = changeForm.watch('newPassword') ?? ''

  const onChangePassword = async (data: ChangeForm) => {
    setError(null)
    try {
      await api.post('/auth/change-password', {
        oldPassword: loginForm.getValues('password'),
        newPassword: data.newPassword,
      }, {
        headers: { Authorization: `Bearer ${pendingAuth?.token}` },
      })

      if (pendingAuth) {
        setAuth(pendingAuth.user, pendingAuth.token, pendingAuth.refreshToken, pendingAuth.tenantConfig)
        navigate(pendingAuth.redirectTo ?? '/', { replace: true })
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setError(e.response?.data?.error ?? 'Erreur lors du changement de mot de passe')
    }
  }

  // ── Rendu ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen bg-background">
      {/* Panel gauche — branding (desktop uniquement) */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden">
        {/* Photo de fond */}
        <img
          src="https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=1200&q=80"
          alt="Équipe professionnelle"
          className="absolute inset-0 h-full w-full object-cover grayscale"
        />
        {/* Overlay gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/85 via-primary/70 to-black/60" />
        {/* Contenu */}
        <div className="relative z-10 flex flex-col justify-between p-12 text-white w-full">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 backdrop-blur font-black text-lg">N</div>
            <span className="text-xl font-black">NexusRH CI</span>
          </div>
          <div>
            <h2 className="text-4xl font-black leading-tight mb-4">
              La RH Intelligente,<br />au service de<br />l'Afrique qui avance
            </h2>
            <div className="space-y-3 mb-8">
              {['Conformité CNPS & ITS/DGI native', 'Paiement salaires Mobile Money', 'Assistant IA Anthropic intégré', 'Multi-tenant · Multi-entreprise'].map(f => (
                <div key={f} className="flex items-center gap-3 text-sm text-white/90">
                  <div className="h-1.5 w-1.5 rounded-full bg-white shrink-0" />
                  {f}
                </div>
              ))}
            </div>
            <p className="text-xs text-white/50">OpenLab Consulting · Abidjan, Côte d'Ivoire</p>
          </div>
        </div>
      </div>

      {/* Panel droit — formulaire */}
      <div className="flex flex-1 items-center justify-center px-4 py-8 lg:px-12">
      <div className="w-full max-w-sm">

        {/* Logo mobile uniquement */}
        <div className="mb-8 text-center lg:hidden">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground shadow-lg">
            N
          </div>
          <h1 className="text-2xl font-bold">NexusRH CI</h1>
          <p className="mt-1 text-sm text-muted-foreground">La RH Intelligente, au service de l'Afrique qui avance</p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-sm">

          {/* ── Formulaire connexion ── */}
          {!mustChange && (
            <>
              <h2 className="mb-6 text-center text-lg font-semibold">Connexion</h2>
              <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Email</label>
                  <input {...loginForm.register('email')} type="email" placeholder="vous@entreprise.ci"
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                  {loginForm.formState.errors.email && (
                    <p className="mt-1 text-xs text-destructive">{loginForm.formState.errors.email.message}</p>
                  )}
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Mot de passe</label>
                  <div className="relative">
                    <input {...loginForm.register('password')} type={showPwd ? 'text' : 'password'}
                      placeholder="••••••••"
                      className="w-full rounded-lg border px-3 py-2 pr-10 text-sm outline-none focus:ring-2 focus:ring-ring" />
                    <button type="button" onClick={() => setShowPwd(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {loginForm.formState.errors.password && (
                    <p className="mt-1 text-xs text-destructive">{loginForm.formState.errors.password.message}</p>
                  )}
                </div>
                {error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
                )}
                <button type="submit" disabled={loginForm.formState.isSubmitting}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
                  {loginForm.formState.isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loginForm.formState.isSubmitting ? 'Connexion…' : 'Se connecter'}
                </button>
              </form>
            </>
          )}

          {/* ── Formulaire première connexion ── */}
          {mustChange && (
            <>
              <div className="flex items-center gap-2 mb-5">
                <ShieldCheck className="h-5 w-5 text-primary shrink-0" />
                <div>
                  <h2 className="text-base font-semibold">Sécurisation du compte</h2>
                  <p className="text-xs text-muted-foreground">Première connexion détectée — changement requis</p>
                </div>
              </div>
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                Pour sécuriser votre compte, définissez un nouveau mot de passe fort de <strong>12 caractères minimum</strong> avec majuscule, minuscule, chiffre et caractère spécial.
              </div>
              <form onSubmit={changeForm.handleSubmit(onChangePassword)} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Nouveau mot de passe</label>
                  <div className="relative">
                    <input {...changeForm.register('newPassword')} type={showNewPwd ? 'text' : 'password'}
                      placeholder="Minimum 12 caractères"
                      className="w-full rounded-lg border px-3 py-2 pr-10 text-sm outline-none focus:ring-2 focus:ring-ring" />
                    <button type="button" onClick={() => setShowNewPwd(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showNewPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {pwdValue && <PasswordStrength value={pwdValue} />}
                  {changeForm.formState.errors.newPassword && (
                    <p className="mt-1 text-xs text-destructive">{changeForm.formState.errors.newPassword.message}</p>
                  )}
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Confirmer le mot de passe</label>
                  <input {...changeForm.register('confirmPassword')} type="password" placeholder="••••••••••••"
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                  {changeForm.formState.errors.confirmPassword && (
                    <p className="mt-1 text-xs text-destructive">{changeForm.formState.errors.confirmPassword.message}</p>
                  )}
                </div>
                {error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
                )}
                <button type="submit" disabled={changeForm.formState.isSubmitting}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
                  {changeForm.formState.isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {changeForm.formState.isSubmitting ? 'Enregistrement…' : 'Valider et accéder'}
                </button>
              </form>
            </>
          )}
        </div>

        {!mustChange && (
          <div className="mt-5 rounded-xl border bg-muted/50 p-4 text-xs text-muted-foreground">
            <p className="mb-2 font-medium text-foreground">Comptes de démonstration :</p>
            <div className="space-y-1">
              <p>SOTRA admin : <span className="font-mono text-foreground">admin@sotra-ci.com / Admin1234!</span></p>
              <p>SOTRA employé : <span className="font-mono text-foreground">employe@sotra-ci.com / Admin1234!</span></p>
              <p>Super admin : <span className="font-mono text-foreground">superadmin@nexusrh-ci.com / SuperAdmin1234!</span></p>
            </div>
          </div>
        )}

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Propulsé par <span className="font-medium">OpenLab Consulting</span> · Abidjan, CI
        </p>
      </div>
      </div>
    </div>
  )
}
