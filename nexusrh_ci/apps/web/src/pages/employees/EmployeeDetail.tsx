import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, formatFCFA, formatDate } from '@/lib/api'
import { ArrowLeft } from 'lucide-react'

interface EmployeeDetails {
  id: string; first_name: string; last_name: string; email: string
  phone: string; gender: string; birth_date: string; nni: string
  cnps_number: string; job_title: string; job_level: string
  contract_type: string; hire_date: string; base_salary: string
  weekly_hours: string | null; professional_category: string | null
  iban: string | null; bank_name: string | null
  department_name: string; manager_first_name: string; manager_last_name: string
  mobile_money_provider: string; mobile_money_phone: string
  marital_status: string; children_count: number; city: string
  // EMP-009 — ancienneté calculée renvoyée par l'API
  seniority_label?: string; seniority_months?: number
}

export default function EmployeeDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation('employees')

  const { data, isLoading } = useQuery<{ data: EmployeeDetails }>({
    queryKey: ['employee', id],
    queryFn: () => api.get(`/employees/${id}`).then(r => r.data),
  })

  const emp = data?.data
  if (isLoading) return <div className="p-6 text-center text-muted-foreground">{t('loadingEmployee')}</div>
  if (!emp) return <div className="p-6 text-center text-destructive">{t('employeeNotFound')}</div>

  const PROVIDER_LABEL: Record<string, string> = {
    wave: 'Wave', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money',
  }

  const MARITAL_LABEL: Record<string, string> = {
    single: t('detail.maritalValues.single'), married: t('detail.maritalValues.married'),
    divorced: t('detail.maritalValues.divorced'), widowed: t('detail.maritalValues.widowed'),
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <button onClick={() => navigate('/employees')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {t('detail.back')}
      </button>

      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
          {emp.first_name?.[0]}{emp.last_name?.[0]}
        </div>
        <div>
          <h1 className="text-2xl font-bold">{emp.first_name} {emp.last_name}</h1>
          <p className="text-muted-foreground">{emp.job_title ?? '—'} · {emp.department_name ?? '—'}</p>
        </div>
      </div>

      {/* Grille infos */}
      <div className="grid grid-cols-2 gap-6">
        {/* Infos personnelles */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <h2 className="font-semibold border-b border-border pb-2">{t('detail.personalInfo')}</h2>
          {[
            [t('detail.fields.email'), emp.email],
            [t('detail.fields.phone'), emp.phone],
            [t('detail.fields.gender'), emp.gender === 'F' ? t('detail.genderValues.female') : emp.gender === 'M' ? t('detail.genderValues.male') : '—'],
            [t('detail.fields.birthDate'), emp.birth_date ? formatDate(emp.birth_date) : '—'],
            [t('detail.fields.nni'), emp.nni ?? '—'],
            [t('detail.fields.cnpsNumber'), emp.cnps_number ?? '—'],
            [t('detail.fields.familySituation'), MARITAL_LABEL[emp.marital_status] ?? emp.marital_status],
            [t('detail.fields.childrenCount'), String(emp.children_count ?? 0)],
            [t('detail.fields.city'), emp.city ?? '—'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-medium">{v ?? '—'}</span>
            </div>
          ))}
        </div>

        {/* Infos contractuelles */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <h2 className="font-semibold border-b border-border pb-2">{t('detail.contractualInfo')}</h2>
          {[
            [t('detail.fields.contractType'), emp.contract_type?.toUpperCase()],
            [t('detail.fields.hireDate'), emp.hire_date ? formatDate(emp.hire_date) : '—'],
            [t('detail.fields.seniority', 'Ancienneté'), emp.seniority_label ?? '—'],
            [t('detail.fields.baseSalary'), formatFCFA(parseInt(emp.base_salary ?? '0'))],
            [t('detail.fields.weeklyHours'), emp.weekly_hours ? `${parseFloat(emp.weekly_hours)} h` : '40 h'],
            [t('detail.fields.professionalCategory'), emp.professional_category ?? '—'],
            [t('detail.fields.department'), emp.department_name],
            [t('detail.fields.manager'), emp.manager_first_name ? `${emp.manager_first_name} ${emp.manager_last_name}` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-medium">{v ?? '—'}</span>
            </div>
          ))}

          <div className="mt-4 pt-4 border-t border-border">
            <h3 className="text-sm font-semibold mb-2">{t('detail.payment')}</h3>
            {emp.mobile_money_provider ? (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{PROVIDER_LABEL[emp.mobile_money_provider] ?? emp.mobile_money_provider}</span>
                <span className="font-mono">{emp.mobile_money_phone}</span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('detail.mobileMoneyNotSet')}</p>
            )}
            {emp.iban ? (
              <div className="mt-2 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('detail.fields.iban')}</span>
                  <span className="font-mono text-xs">{emp.iban}</span>
                </div>
                {emp.bank_name && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('detail.fields.bankName')}</span>
                    <span className="font-medium">{emp.bank_name}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t('detail.ibanNotSet')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
