import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AxiosError } from 'axios'
import { api, formatDate, formatFCFA } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { User, Smartphone, ShieldCheck, KeyRound, Loader2 } from 'lucide-react'

interface MfaSetupResponse {
  qrCodeDataUrl: string
  secret: string
  backupCodes: string[]
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data as { error?: string } | undefined
    if (data?.error) return data.error
  }
  return fallback
}

interface ProfileData {
  id: string; first_name: string; last_name: string; email: string
  phone: string; birth_date: string; gender: string; nni: string
  cnps_number: string; job_title: string; contract_type: string
  hire_date: string; base_salary: string; department_name: string
  manager_first_name: string; manager_last_name: string
  mobile_money_provider: string; mobile_money_phone: string
  marital_status: string; children_count: number; city: string
}

const PROVIDER_LABEL: Record<string, string> = {
  wave: 'Wave', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money',
}

export default function MonProfil() {
  const { t } = useTranslation('monEspace')
  const user = useAuthStore(s => s.user)
  const queryClient = useQueryClient()
  const [editPhone, setEditPhone] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [editMM, setEditMM] = useState(false)
  const [newMMProvider, setNewMMProvider] = useState('')
  const [newMMPhone, setNewMMPhone] = useState('')

  // ── Sécurité : changement de mot de passe ──────────────────────────────────
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwdMsg, setPwdMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // ── Sécurité : MFA TOTP ────────────────────────────────────────────────────
  // Aucun endpoint de statut MFA : l'état est piloté localement (activé après
  // /verify, désactivé après /disable).
  const [mfaActive, setMfaActive] = useState(false)
  const [mfaSetup, setMfaSetup] = useState<MfaSetupResponse | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [disablePassword, setDisablePassword] = useState('')
  const [showDisable, setShowDisable] = useState(false)
  const [mfaMsg, setMfaMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const changePwdMut = useMutation({
    mutationFn: (payload: { oldPassword: string; newPassword: string }) =>
      api.post('/auth/change-password', payload),
    onSuccess: () => {
      setPwdMsg({ type: 'success', text: t('security.password.success') })
      setOldPassword(''); setNewPassword(''); setConfirmPassword('')
    },
    onError: (err: unknown) =>
      setPwdMsg({ type: 'error', text: apiErrorMessage(err, t('security.password.error')) }),
  })

  const mfaSetupMut = useMutation({
    mutationFn: () => api.post<MfaSetupResponse>('/auth/mfa/setup').then(r => r.data),
    onSuccess: (data) => { setMfaSetup(data); setMfaMsg(null); setMfaCode('') },
    onError: (err: unknown) =>
      setMfaMsg({ type: 'error', text: apiErrorMessage(err, t('security.mfa.setupError')) }),
  })

  const mfaVerifyMut = useMutation({
    mutationFn: (code: string) => api.post('/auth/mfa/verify', { code }),
    onSuccess: () => {
      setMfaActive(true); setMfaSetup(null); setMfaCode('')
      setMfaMsg({ type: 'success', text: t('security.mfa.enabled') })
    },
    onError: (err: unknown) =>
      setMfaMsg({ type: 'error', text: apiErrorMessage(err, t('security.mfa.verifyError')) }),
  })

  const mfaDisableMut = useMutation({
    mutationFn: (password: string) => api.post('/auth/mfa/disable', { password }),
    onSuccess: () => {
      setMfaActive(false); setShowDisable(false); setDisablePassword('')
      setMfaMsg({ type: 'success', text: t('security.mfa.disabled') })
    },
    onError: (err: unknown) =>
      setMfaMsg({ type: 'error', text: apiErrorMessage(err, t('security.mfa.disableError')) }),
  })

  const submitPasswordChange = () => {
    setPwdMsg(null)
    if (newPassword.length < 8) {
      setPwdMsg({ type: 'error', text: t('security.password.tooShort') }); return
    }
    if (newPassword !== confirmPassword) {
      setPwdMsg({ type: 'error', text: t('security.password.mismatch') }); return
    }
    changePwdMut.mutate({ oldPassword, newPassword })
  }

  const { data, isLoading } = useQuery<{ data: ProfileData }>({
    queryKey: ['my-profile'],
    queryFn: async () => {
      // Trouver l'ID de l'employé courant
      if (user?.employeeId) {
        return api.get(`/employees/${user.employeeId}`).then(r => r.data)
      }
      return { data: null }
    },
    enabled: !!user,
  })

  const updateMut = useMutation({
    mutationFn: (updates: Record<string, unknown>) =>
      api.patch(`/employees/${data?.data?.id}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-profile'] })
      setEditPhone(false)
      setEditMM(false)
    },
  })

  const emp = data?.data
  if (isLoading) return <div className="p-6 text-center text-muted-foreground">{t('profile.loading')}</div>
  if (!emp) return (
    <div className="p-6 text-center text-muted-foreground">
      <User className="mx-auto mb-2 h-8 w-8 opacity-30" />
      <p>{t('profile.noRecordTitle')}</p>
      <p className="text-xs mt-1">{t('profile.noRecordHint')}</p>
    </div>
  )

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('profile.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('profile.subtitle')}</p>
      </div>

      {/* Avatar */}
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
          {emp.first_name?.[0]}{emp.last_name?.[0]}
        </div>
        <div>
          <h2 className="text-xl font-bold">{emp.first_name} {emp.last_name}</h2>
          <p className="text-muted-foreground">{emp.job_title ?? '—'}</p>
          <p className="text-sm text-muted-foreground">{emp.department_name ?? '—'}</p>
        </div>
      </div>

      {/* Infos contrat */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h3 className="font-semibold border-b border-border pb-2">{t('profile.myContract')}</h3>
        {([
          ['contractType', t('profile.contractType'), emp.contract_type?.toUpperCase()],
          ['hireDate', t('profile.hireDate'), emp.hire_date ? formatDate(emp.hire_date) : t('common.dash')],
          ['salary', t('profile.grossMonthlySalary'), formatFCFA(parseInt(emp.base_salary ?? '0'))],
          ['cnps', t('profile.cnpsNumber'), emp.cnps_number ?? t('common.dash')],
          ['nni', t('profile.nni'), emp.nni ?? t('common.dash')],
          ['manager', t('profile.manager'), emp.manager_first_name ? `${emp.manager_first_name} ${emp.manager_last_name}` : t('common.dash')],
        ] as const).map(([id, k, v]) => (
          <div key={id} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium">{v ?? t('common.dash')}</span>
          </div>
        ))}
      </div>

      {/* Infos personnelles */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h3 className="font-semibold border-b border-border pb-2">{t('profile.personalInfo')}</h3>
        {([
          ['email', t('profile.email'), emp.email],
          ['gender', t('profile.gender'), emp.gender === 'F' ? t('profile.genderFemale') : emp.gender === 'M' ? t('profile.genderMale') : t('common.dash')],
          ['birthDate', t('profile.birthDate'), emp.birth_date ? formatDate(emp.birth_date) : t('common.dash')],
          ['maritalStatus', t('profile.maritalStatus'), t(`profile.maritalLabels.${emp.marital_status}`, { defaultValue: emp.marital_status })],
          ['children', t('profile.childrenCount'), String(emp.children_count ?? 0)],
          ['city', t('profile.city'), emp.city ?? t('common.dash')],
        ] as const).map(([id, k, v]) => (
          <div key={id} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium">{v ?? t('common.dash')}</span>
          </div>
        ))}

        {/* Téléphone — modifiable */}
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('profile.phone')}</span>
          {editPhone ? (
            <div className="flex items-center gap-2">
              <input
                value={newPhone}
                onChange={e => setNewPhone(e.target.value)}
                placeholder={t('profile.phonePlaceholder')}
                className="rounded border border-input px-2 py-1 text-xs w-40 focus:ring-2 focus:ring-ring outline-none"
              />
              <button onClick={() => updateMut.mutate({ phone: newPhone })}
                className="text-xs text-primary hover:underline">{t('profile.save')}</button>
              <button onClick={() => setEditPhone(false)}
                className="text-xs text-muted-foreground hover:underline">{t('profile.cancel')}</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-medium">{emp.phone ?? t('common.dash')}</span>
              <button onClick={() => { setEditPhone(true); setNewPhone(emp.phone ?? '') }}
                className="text-xs text-primary hover:underline">{t('profile.modify')}</button>
            </div>
          )}
        </div>
      </div>

      {/* Mobile Money — modifiable */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-semibold border-b border-border pb-2 mb-3 flex items-center gap-2">
          <Smartphone className="h-4 w-4" /> {t('profile.myMobileMoney')}
        </h3>
        {editMM ? (
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('profile.operator')}</label>
              <select value={newMMProvider} onChange={e => setNewMMProvider(e.target.value)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
                <option value="">{t('profile.selectPlaceholder')}</option>
                <option value="wave">Wave</option>
                <option value="mtn_momo">MTN MoMo</option>
                <option value="orange_money">Orange Money</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('profile.mmNumber')}</label>
              <input value={newMMPhone} onChange={e => setNewMMPhone(e.target.value)}
                placeholder={t('profile.phonePlaceholder')}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => updateMut.mutate({ mobile_money_provider: newMMProvider, mobile_money_phone: newMMPhone })}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90">
                {t('profile.save')}
              </button>
              <button onClick={() => setEditMM(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
                {t('profile.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            {emp.mobile_money_provider ? (
              <div>
                <p className="text-sm font-medium">{PROVIDER_LABEL[emp.mobile_money_provider] ?? emp.mobile_money_provider}</p>
                <p className="text-sm text-muted-foreground font-mono">{emp.mobile_money_phone}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('profile.notProvided')}</p>
            )}
            <button
              onClick={() => {
                setEditMM(true)
                setNewMMProvider(emp.mobile_money_provider ?? '')
                setNewMMPhone(emp.mobile_money_phone ?? '')
              }}
              className="text-sm text-primary hover:underline">
              {t('profile.modify')}
            </button>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-3">
          {t('profile.mobileMoneyNote')}
        </p>
      </div>

      {/* Sécurité */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-6">
        <h3 className="font-semibold border-b border-border pb-2 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> {t('security.title')}
        </h3>

        {/* Changement de mot de passe */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4 text-muted-foreground" /> {t('security.password.title')}
          </div>
          {pwdMsg && (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-sm ${
                pwdMsg.type === 'success'
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {pwdMsg.text}
            </div>
          )}
          <input
            type="password" autoComplete="current-password"
            value={oldPassword} onChange={e => setOldPassword(e.target.value)}
            placeholder={t('security.password.current')}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
          />
          <input
            type="password" autoComplete="new-password"
            value={newPassword} onChange={e => setNewPassword(e.target.value)}
            placeholder={t('security.password.new')}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
          />
          <input
            type="password" autoComplete="new-password"
            value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
            placeholder={t('security.password.confirm')}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
          />
          <button
            onClick={submitPasswordChange}
            disabled={changePwdMut.isPending || !oldPassword || !newPassword || !confirmPassword}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {changePwdMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('security.password.submit')}
          </button>
        </div>

        {/* MFA TOTP */}
        <div className="space-y-3 border-t border-border pt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" /> {t('security.mfa.title')}
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              mfaActive ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'
            }`}>
              {mfaActive ? t('security.mfa.statusOn') : t('security.mfa.statusOff')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t('security.mfa.description')}</p>

          {mfaMsg && (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-sm ${
                mfaMsg.type === 'success'
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {mfaMsg.text}
            </div>
          )}

          {/* Activé : bouton désactiver */}
          {mfaActive && !showDisable && (
            <button
              onClick={() => { setMfaMsg(null); setShowDisable(true) }}
              className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent"
            >
              {t('security.mfa.disable')}
            </button>
          )}

          {/* Confirmation désactivation (re-saisie mot de passe) */}
          {mfaActive && showDisable && (
            <div className="space-y-2">
              <input
                type="password" autoComplete="current-password"
                value={disablePassword} onChange={e => setDisablePassword(e.target.value)}
                placeholder={t('security.mfa.passwordToDisable')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => mfaDisableMut.mutate(disablePassword)}
                  disabled={mfaDisableMut.isPending || !disablePassword}
                  className="flex items-center gap-2 rounded-lg bg-destructive px-4 py-2 text-sm text-destructive-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {mfaDisableMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('security.mfa.confirmDisable')}
                </button>
                <button
                  onClick={() => { setShowDisable(false); setDisablePassword('') }}
                  className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent"
                >
                  {t('profile.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Désactivé, pas de setup en cours : bouton activer */}
          {!mfaActive && !mfaSetup && (
            <button
              onClick={() => { setMfaMsg(null); mfaSetupMut.mutate() }}
              disabled={mfaSetupMut.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {mfaSetupMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('security.mfa.enable')}
            </button>
          )}

          {/* Setup en cours : QR + codes de secours + saisie code */}
          {!mfaActive && mfaSetup && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground text-center">{t('security.mfa.scanHint')}</p>
                <img src={mfaSetup.qrCodeDataUrl} alt="QR code MFA" className="h-44 w-44" />
                <p className="text-xs text-muted-foreground">{t('security.mfa.manualKey')}</p>
                <code className="rounded bg-background px-2 py-1 text-xs font-mono break-all">{mfaSetup.secret}</code>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-medium text-amber-800 mb-2">{t('security.mfa.backupCodesTitle')}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {mfaSetup.backupCodes.map(code => (
                    <code key={code} className="rounded bg-white px-2 py-1 text-center text-xs font-mono text-amber-900">{code}</code>
                  ))}
                </div>
                <p className="text-[11px] text-amber-700 mt-2">{t('security.mfa.backupCodesHint')}</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('security.mfa.codeLabel')}</label>
                <input
                  inputMode="numeric" maxLength={6} value={mfaCode}
                  onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm tracking-widest font-mono focus:ring-2 focus:ring-ring outline-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => mfaVerifyMut.mutate(mfaCode)}
                    disabled={mfaVerifyMut.isPending || mfaCode.length !== 6}
                    className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
                  >
                    {mfaVerifyMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('security.mfa.verify')}
                  </button>
                  <button
                    onClick={() => { setMfaSetup(null); setMfaCode(''); setMfaMsg(null) }}
                    className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent"
                  >
                    {t('profile.cancel')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
