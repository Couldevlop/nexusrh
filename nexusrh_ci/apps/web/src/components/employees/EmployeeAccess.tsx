/**
 * Accès applicatif d'un salarié, depuis sa fiche :
 *  - compte lié → badge « Accès : <rôle> » ;
 *  - aucun compte → bouton « Donner un accès » (admin uniquement, même RBAC
 *    que Paramètres → Utilisateurs) qui crée le compte via POST /settings/users
 *    avec employee_id : lien explicite, email de bienvenue, mot de passe
 *    temporaire jamais affiché si l'email est parti (filet seulement en échec).
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { KeyRound, ShieldCheck, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

const ACCESS_ROLES = ['employee', 'manager', 'hr_officer', 'hr_manager', 'readonly', 'dg', 'raf_site', 'admin'] as const

interface Props {
  employee: {
    id: string; first_name: string; last_name: string; email: string | null
    linked_user_id?: string | null; linked_user_role?: string | null
  }
}

export function EmployeeAccess({ employee }: Props) {
  const { t } = useTranslation('employees')
  const { t: ts } = useTranslation('settings')
  const qc = useQueryClient()
  const isAdmin = useAuthStore(s => s.user?.role) === 'admin'
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', role: 'employee' })
  const [result, setResult] = useState<{ emailSent: boolean; tempPassword: string | null } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const create = useMutation({
    mutationFn: () => api.post<{ tempPassword: string; emailSent: boolean }>('/settings/users', { ...form, employee_id: employee.id }),
    onSuccess: (res) => {
      setResult({ emailSent: !!res.data.emailSent, tempPassword: res.data.emailSent ? null : res.data.tempPassword })
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['employee', employee.id] })
      void qc.invalidateQueries({ queryKey: ['employees'] })
      void qc.invalidateQueries({ queryKey: ['settings-users'] })
    },
  })

  // Accessibilité : Échap ferme, focus dans la boîte à l'ouverture.
  useEffect(() => {
    if (!open) return
    dialogRef.current?.querySelector<HTMLElement>('input,select,button')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (employee.linked_user_id) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
        <ShieldCheck className="h-3.5 w-3.5" />
        {t('access.badge', { role: ts(`roles.${employee.linked_user_role ?? 'employee'}`, { defaultValue: employee.linked_user_role ?? '' }) })}
      </span>
    )
  }
  if (!isAdmin) {
    return <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">{t('access.none')}</span>
  }

  const startOpen = () => {
    setForm({ email: employee.email ?? '', first_name: employee.first_name, last_name: employee.last_name, role: 'employee' })
    setResult(null)
    create.reset()
    setOpen(true)
  }
  const apiError = (create.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error

  return (
    <>
      <button type="button" onClick={startOpen}
        className="inline-flex items-center gap-1.5 rounded-lg border border-primary px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10">
        <KeyRound className="h-3.5 w-3.5" /> {t('access.grant')}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="grant-access-title"
            className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 id="grant-access-title" className="font-semibold">{t('access.title', { name: `${employee.first_name} ${employee.last_name}` })}</h3>
              <button type="button" onClick={() => setOpen(false)} aria-label={t('access.close')}><X className="h-4 w-4" /></button>
            </div>
            {result ? (
              <div className="space-y-3 text-center">
                <ShieldCheck className="mx-auto h-10 w-10 text-green-600" />
                <p className="text-sm">{t('access.created')}</p>
                {result.emailSent
                  ? <p className="text-xs text-green-600">{t('access.emailSent')}</p>
                  : (
                    <>
                      <p className="text-xs text-amber-600">{t('access.emailNotSent')}</p>
                      {result.tempPassword && <div className="rounded-lg bg-muted px-4 py-3 font-mono text-base font-bold tracking-widest">{result.tempPassword}</div>}
                    </>
                  )}
                <button type="button" onClick={() => setOpen(false)}
                  className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">{t('access.close')}</button>
              </div>
            ) : (
              <form className="space-y-3" onSubmit={e => { e.preventDefault(); create.mutate() }}>
                <div>
                  <label htmlFor="grant-email" className="text-xs font-medium text-muted-foreground">{ts('users.form.email')}</label>
                  <input id="grant-email" type="email" required value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="grant-first" className="text-xs font-medium text-muted-foreground">{ts('users.form.firstName')}</label>
                    <input id="grant-first" required value={form.first_name} onChange={e => setForm(p => ({ ...p, first_name: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                  </div>
                  <div>
                    <label htmlFor="grant-last" className="text-xs font-medium text-muted-foreground">{ts('users.form.lastName')}</label>
                    <input id="grant-last" required value={form.last_name} onChange={e => setForm(p => ({ ...p, last_name: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                  </div>
                </div>
                <div>
                  <label htmlFor="grant-role" className="text-xs font-medium text-muted-foreground">{ts('users.form.role')}</label>
                  <select id="grant-role" value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    {ACCESS_ROLES.map(r => <option key={r} value={r}>{ts(`roles.${r}`)}</option>)}
                  </select>
                </div>
                {apiError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{apiError}</p>}
                {create.isError && !apiError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{t('access.error')}</p>}
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('access.cancel')}</button>
                  <button type="submit" disabled={create.isPending || !form.email || !form.first_name || !form.last_name}
                    className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    {create.isPending ? t('access.creating') : t('access.submit')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  )
}
