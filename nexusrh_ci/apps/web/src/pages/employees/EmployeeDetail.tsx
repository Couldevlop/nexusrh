import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { api, formatFCFA, formatDate } from '@/lib/api'
import { ArrowLeft } from 'lucide-react'

interface EmployeeDetails {
  id: string; first_name: string; last_name: string; email: string
  phone: string; gender: string; birth_date: string; nni: string
  cnps_number: string; job_title: string; job_level: string
  contract_type: string; hire_date: string; base_salary: string
  department_name: string; manager_first_name: string; manager_last_name: string
  mobile_money_provider: string; mobile_money_phone: string
  marital_status: string; children_count: number; city: string
}

export default function EmployeeDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, isLoading } = useQuery<{ data: EmployeeDetails }>({
    queryKey: ['employee', id],
    queryFn: () => api.get(`/employees/${id}`).then(r => r.data),
  })

  const emp = data?.data
  if (isLoading) return <div className="p-6 text-center text-muted-foreground">Chargement...</div>
  if (!emp) return <div className="p-6 text-center text-destructive">Employé introuvable</div>

  const PROVIDER_LABEL: Record<string, string> = {
    wave: 'Wave', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money',
  }

  const MARITAL_LABEL: Record<string, string> = {
    single: 'Célibataire', married: 'Marié(e)', divorced: 'Divorcé(e)', widowed: 'Veuf/Veuve',
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <button onClick={() => navigate('/employees')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Retour aux employés
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
          <h2 className="font-semibold border-b border-border pb-2">Informations personnelles</h2>
          {[
            ['Email', emp.email],
            ['Téléphone', emp.phone],
            ['Genre', emp.gender === 'F' ? 'Femme' : emp.gender === 'M' ? 'Homme' : '—'],
            ['Date de naissance', emp.birth_date ? formatDate(emp.birth_date) : '—'],
            ['NNI', emp.nni ?? '—'],
            ['N° CNPS', emp.cnps_number ?? '—'],
            ['Situation familiale', MARITAL_LABEL[emp.marital_status] ?? emp.marital_status],
            ['Enfants à charge', String(emp.children_count ?? 0)],
            ['Ville', emp.city ?? '—'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-medium">{v ?? '—'}</span>
            </div>
          ))}
        </div>

        {/* Infos contractuelles */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <h2 className="font-semibold border-b border-border pb-2">Informations contractuelles</h2>
          {[
            ['Type de contrat', emp.contract_type?.toUpperCase()],
            ['Date d\'embauche', emp.hire_date ? formatDate(emp.hire_date) : '—'],
            ['Salaire brut mensuel', formatFCFA(parseInt(emp.base_salary ?? '0'))],
            ['Département', emp.department_name],
            ['Manager', emp.manager_first_name ? `${emp.manager_first_name} ${emp.manager_last_name}` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-medium">{v ?? '—'}</span>
            </div>
          ))}

          <div className="mt-4 pt-4 border-t border-border">
            <h3 className="text-sm font-semibold mb-2">Mobile Money</h3>
            {emp.mobile_money_provider ? (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{PROVIDER_LABEL[emp.mobile_money_provider] ?? emp.mobile_money_provider}</span>
                <span className="font-mono">{emp.mobile_money_phone}</span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Non renseigné</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
