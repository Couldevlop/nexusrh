import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, formatDate, formatFCFA } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { User, Smartphone } from 'lucide-react'

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
    </div>
  )
}
