import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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

const MARITAL_LABEL: Record<string, string> = {
  single: 'Célibataire', married: 'Marié(e)', divorced: 'Divorcé(e)', widowed: 'Veuf/Veuve',
}

export default function MonProfil() {
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
  if (isLoading) return <div className="p-6 text-center text-muted-foreground">Chargement...</div>
  if (!emp) return (
    <div className="p-6 text-center text-muted-foreground">
      <User className="mx-auto mb-2 h-8 w-8 opacity-30" />
      <p>Aucun dossier employé associé à votre compte.</p>
      <p className="text-xs mt-1">Contactez votre RH.</p>
    </div>
  )

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Mon profil</h1>
        <p className="text-sm text-muted-foreground mt-1">Informations personnelles et contrat</p>
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
        <h3 className="font-semibold border-b border-border pb-2">Mon contrat</h3>
        {[
          ['Type de contrat', emp.contract_type?.toUpperCase()],
          ['Date d\'embauche', emp.hire_date ? formatDate(emp.hire_date) : '—'],
          ['Salaire brut mensuel', formatFCFA(parseInt(emp.base_salary ?? '0'))],
          ['N° CNPS', emp.cnps_number ?? '—'],
          ['NNI', emp.nni ?? '—'],
          ['Manager', emp.manager_first_name ? `${emp.manager_first_name} ${emp.manager_last_name}` : '—'],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium">{v ?? '—'}</span>
          </div>
        ))}
      </div>

      {/* Infos personnelles */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h3 className="font-semibold border-b border-border pb-2">Informations personnelles</h3>
        {[
          ['Email', emp.email],
          ['Genre', emp.gender === 'F' ? 'Femme' : emp.gender === 'M' ? 'Homme' : '—'],
          ['Date de naissance', emp.birth_date ? formatDate(emp.birth_date) : '—'],
          ['Situation familiale', MARITAL_LABEL[emp.marital_status] ?? emp.marital_status],
          ['Enfants à charge', String(emp.children_count ?? 0)],
          ['Ville', emp.city ?? '—'],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium">{v ?? '—'}</span>
          </div>
        ))}

        {/* Téléphone — modifiable */}
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Téléphone</span>
          {editPhone ? (
            <div className="flex items-center gap-2">
              <input
                value={newPhone}
                onChange={e => setNewPhone(e.target.value)}
                placeholder="+225 07 XX XX XX XX"
                className="rounded border border-input px-2 py-1 text-xs w-40 focus:ring-2 focus:ring-ring outline-none"
              />
              <button onClick={() => updateMut.mutate({ phone: newPhone })}
                className="text-xs text-primary hover:underline">Sauvegarder</button>
              <button onClick={() => setEditPhone(false)}
                className="text-xs text-muted-foreground hover:underline">Annuler</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-medium">{emp.phone ?? '—'}</span>
              <button onClick={() => { setEditPhone(true); setNewPhone(emp.phone ?? '') }}
                className="text-xs text-primary hover:underline">Modifier</button>
            </div>
          )}
        </div>
      </div>

      {/* Mobile Money — modifiable */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-semibold border-b border-border pb-2 mb-3 flex items-center gap-2">
          <Smartphone className="h-4 w-4" /> Mon Mobile Money
        </h3>
        {editMM ? (
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Opérateur</label>
              <select value={newMMProvider} onChange={e => setNewMMProvider(e.target.value)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
                <option value="">-- Sélectionner --</option>
                <option value="wave">Wave</option>
                <option value="mtn_momo">MTN MoMo</option>
                <option value="orange_money">Orange Money</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Numéro (+225)</label>
              <input value={newMMPhone} onChange={e => setNewMMPhone(e.target.value)}
                placeholder="+225 07 XX XX XX XX"
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => updateMut.mutate({ mobile_money_provider: newMMProvider, mobile_money_phone: newMMPhone })}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90">
                Sauvegarder
              </button>
              <button onClick={() => setEditMM(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
                Annuler
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
              <p className="text-sm text-muted-foreground">Non renseigné</p>
            )}
            <button
              onClick={() => {
                setEditMM(true)
                setNewMMProvider(emp.mobile_money_provider ?? '')
                setNewMMPhone(emp.mobile_money_phone ?? '')
              }}
              className="text-sm text-primary hover:underline">
              Modifier
            </button>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-3">
          Ce numéro est utilisé pour recevoir votre salaire par Mobile Money.
        </p>
      </div>
    </div>
  )
}
