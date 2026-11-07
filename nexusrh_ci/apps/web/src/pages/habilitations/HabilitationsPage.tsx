/**
 * Habilitations RH — écran d'administration (3 onglets).
 *
 *  - Structure : groupes, sous-groupes, plafonds à cocher, membres, compteur
 *    des employés sans filiale (le « siège »), aperçu « Ce que voit X ».
 *  - Fiches : liste par étape, grille préremplissable par modèle, actions
 *    dépendant de l'étape, téléchargement du PDF.
 *  - Délégations : posée ici (vide), remplie par la tâche 12.
 *
 * Deux refus délibérés :
 *  - une fiche verrouillée n'est PAS modifiable : la validation porte sur un
 *    contenu figé ;
 *  - un cumul sensible exige une case de prise de connaissance avant de
 *    valider — l'avertissement passif ne suffit pas pour une décision d'accès.
 *
 * Quand le contrôle par la grille n'est pas activé pour le client, un bandeau
 * le dit : sans lui, un admin croirait qu'une révocation a un effet immédiat.
 */
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, AlertTriangle, FileText, Eye, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'
import { PermissionGrid } from '@/components/habilitations/PermissionGrid'
import { PreviewDrawer } from '@/components/habilitations/PreviewDrawer'
import { isFicheEditable } from '@/lib/habilitations'

type Tab = 'structure' | 'fiches' | 'delegations'

interface Member {
  userId: string
  email: string
  firstName: string | null
  lastName: string | null
  role: string
  source: string
  revokedAt: string | null
  permissions: string[]
}
interface Subgroup {
  id: string
  name: string
  kind: 'siege' | 'entity'
  legalEntityId: string | null
  legalEntityName: string | null
  ceiling: string[]
  members: Member[]
}
interface Group { id: string; name: string; subgroups: Subgroup[] }
interface Structure { enforced: boolean; siegeEmployeeCount: number; groups: Group[] }

interface Fiche {
  id: string
  number: string
  status: string
  target_user_id: string
  subgroup_id: string | null
  permissions: string[] | null
  kind: 'grant' | 'revoke'
  n1_user_id: string | null
  n2_user_id: string | null
  created_by: string | null
  sod_alerts: Array<{ ruleId: string; label: string }> | null
  motive: string | null
  effective_from: string | null
  rejected_reason: string | null
}

export default function HabilitationsPage() {
  const { t } = useTranslation('habilitations')
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const me = user?.sub ?? ''
  const role = user?.role ?? ''
  const [tab, setTab] = useState<Tab>('structure')
  const [previewUser, setPreviewUser] = useState<{ id: string; label: string } | null>(null)

  const structureQ = useQuery({
    queryKey: ['habilitations', 'structure'],
    queryFn: async () => (await api.get('/habilitations/structure')).data.data as Structure,
    enabled: role === 'admin',
  })
  const fichesQ = useQuery({
    queryKey: ['habilitations', 'fiches'],
    queryFn: async () => (await api.get('/habilitations/fiches')).data.data as Fiche[],
  })

  const structure = structureQ.data
  const fiches = fichesQ.data ?? []

  // ── Onglet Structure : plafonds ───────────────────────────────────────────
  const [ceilingEdit, setCeilingEdit] = useState<{ id: string; ceiling: string[] } | null>(null)
  const saveCeiling = useMutation({
    mutationFn: async (payload: { id: string; ceiling: string[] }) =>
      (await api.patch(`/habilitations/subgroups/${payload.id}/ceiling`, { ceiling: payload.ceiling })).data,
    onSuccess: () => {
      setCeilingEdit(null)
      void qc.invalidateQueries({ queryKey: ['habilitations'] })
    },
  })

  const toggleEnforcement = useMutation({
    mutationFn: async (enabled: boolean) => (await api.post('/habilitations/enforcement', { enabled })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['habilitations'] }),
  })

  // ── Onglet Fiches ────────────────────────────────────────────────────────
  const [openFiche, setOpenFiche] = useState<string | null>(null)
  const [draftPermissions, setDraftPermissions] = useState<string[] | null>(null)
  const [acceptSod, setAcceptSod] = useState(false)

  const fiche = useMemo(() => fiches.find((f) => f.id === openFiche) ?? null, [fiches, openFiche])
  const ficheSubgroup = useMemo(() => {
    if (!fiche || !structure) return null
    for (const g of structure.groups) {
      const sg = g.subgroups.find((s) => s.id === fiche.subgroup_id)
      if (sg) return sg
    }
    return null
  }, [fiche, structure])

  const editable = fiche ? isFicheEditable(fiche.status) : false
  const sodAlerts = fiche?.sod_alerts ?? []
  // Acteur attendu à l'étape : lui seul voit les actions de validation.
  const isApprover = fiche
    ? (fiche.status === 'n1' && fiche.n1_user_id === me) || (fiche.status === 'n2' && fiche.n2_user_id === me)
    : false
  const canValidate = isApprover && (sodAlerts.length === 0 || acceptSod)

  const openDetail = (f: Fiche): void => {
    setOpenFiche(f.id)
    setDraftPermissions(f.permissions ?? [])
    setAcceptSod(false)
  }

  const saveFiche = useMutation({
    mutationFn: async (payload: { id: string; permissions: string[] }) =>
      (await api.patch(`/habilitations/fiches/${payload.id}`, { permissions: payload.permissions })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['habilitations', 'fiches'] }),
  })
  const act = useMutation({
    mutationFn: async (payload: { id: string; action: 'submit' | 'validate' | 'reject' | 'apply'; body?: Record<string, unknown> }) =>
      (await api.post(`/habilitations/fiches/${payload.id}/${payload.action}`, payload.body ?? {})).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['habilitations', 'fiches'] }),
  })

  const downloadPdf = async (id: string, number: string): Promise<void> => {
    const res = await api.get(`/habilitations/fiches/${id}/pdf`, { responseType: 'blob' })
    const url = URL.createObjectURL(new Blob([res.data as Blob], { type: 'application/pdf' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `fiche-${number}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  }

  const tabs: Tab[] = ['structure', 'fiches', 'delegations']

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </header>

      {structure && !structure.enforced ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2">
            <p>{t('notEnforced')}</p>
            {role === 'admin' ? (
              <button
                onClick={() => toggleEnforcement.mutate(true)}
                className="rounded-md bg-amber-900 px-3 py-1.5 text-xs font-medium text-amber-50"
              >
                {t('actions.enable')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <nav className="flex gap-2 border-b border-border">
        {tabs.map((x) => (
          <button
            key={x}
            onClick={() => setTab(x)}
            className={cn(
              'px-3 py-2 text-sm font-medium border-b-2 -mb-px',
              tab === x ? 'border-primary text-primary' : 'border-transparent text-muted-foreground',
            )}
          >
            {t(`tabs.${x}`)}
          </button>
        ))}
      </nav>

      {tab === 'structure' ? (
        <section className="space-y-4">
          {structureQ.isLoading ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : null}
          {structure ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              {t('structure.siegeCount', { count: structure.siegeEmployeeCount })}
              <span className="font-medium">{structure.siegeEmployeeCount}</span>
            </p>
          ) : null}

          {(structure?.groups ?? []).map((g) => (
            <article key={g.id} className="rounded-lg border border-border">
              <h2 className="border-b border-border px-4 py-2 font-medium">{g.name}</h2>
              <div className="divide-y divide-border">
                {g.subgroups.map((sg) => (
                  <div key={sg.id} className="space-y-3 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium">{sg.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {sg.kind === 'siege' ? t('structure.siege') : (sg.legalEntityName ?? t('structure.entity'))}
                          {' · '}
                          {t('structure.memberCount', { count: sg.members.length })}
                        </p>
                      </div>
                      <button
                        onClick={() => setCeilingEdit({ id: sg.id, ceiling: [...sg.ceiling] })}
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium"
                      >
                        {t('actions.editCeiling')}
                      </button>
                    </div>

                    {ceilingEdit?.id === sg.id ? (
                      <div className="space-y-2">
                        <PermissionGrid
                          value={ceilingEdit.ceiling}
                          onChange={(next) => setCeilingEdit({ id: sg.id, ceiling: next })}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveCeiling.mutate(ceilingEdit)}
                            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                          >
                            {t('actions.save')}
                          </button>
                          <button onClick={() => setCeilingEdit(null)} className="rounded-md border border-border px-3 py-1.5 text-xs">
                            {t('actions.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <ul className="space-y-1">
                      {sg.members.map((m) => (
                        <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span>
                            {[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}
                            <span className="ml-2 text-xs text-muted-foreground">{m.email}</span>
                            {m.revokedAt ? <span className="ml-2 text-xs text-destructive">{t('structure.revoked')}</span> : null}
                          </span>
                          <button
                            onClick={() => setPreviewUser({ id: m.userId, label: m.email })}
                            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                          >
                            <Eye className="h-3 w-3" />
                            {t('preview.open')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {tab === 'fiches' ? (
        <section className="space-y-4">
          {fichesQ.isLoading ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : null}
          {fiches.length === 0 && !fichesQ.isLoading ? <p className="text-sm text-muted-foreground">{t('fiche.empty')}</p> : null}

          <ul className="divide-y divide-border rounded-lg border border-border">
            {fiches.map((f) => (
              <li key={f.id} className="px-4 py-3">
                <button onClick={() => openDetail(f)} className="text-left font-medium text-primary">
                  {f.number}
                </button>
                <span className="ml-3 rounded bg-muted px-2 py-0.5 text-xs">{t(`status.${f.status}`)}</span>
                {f.kind === 'revoke' ? <span className="ml-2 text-xs text-destructive">{t('fiche.revokeKind')}</span> : null}
              </li>
            ))}
          </ul>

          {fiche ? (
            <article className="space-y-4 rounded-lg border border-border p-4">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-medium">{fiche.number}</h2>
                  <p className="text-xs text-muted-foreground">{t(`status.${fiche.status}`)}</p>
                </div>
                <button
                  onClick={() => void downloadPdf(fiche.id, fiche.number)}
                  className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium"
                >
                  <FileText className="h-3 w-3" />
                  {t('actions.pdf')}
                </button>
              </header>

              {fiche.motive ? <p className="text-sm">{fiche.motive}</p> : null}
              {fiche.rejected_reason ? (
                <p className="rounded bg-destructive/10 p-2 text-sm text-destructive">{fiche.rejected_reason}</p>
              ) : null}

              {sodAlerts.length > 0 ? (
                <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-medium">{t('fiche.sodTitle')}</p>
                  <ul className="list-disc pl-5">
                    {sodAlerts.map((a) => <li key={a.ruleId}>{a.label}</li>)}
                  </ul>
                  {isApprover ? (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={t('fiche.acceptSod')}
                        checked={acceptSod}
                        onChange={(e) => setAcceptSod(e.target.checked)}
                        className="h-4 w-4"
                      />
                      <span>{t('fiche.acceptSod')}</span>
                    </label>
                  ) : null}
                </div>
              ) : null}

              <PermissionGrid
                value={draftPermissions ?? fiche.permissions ?? []}
                onChange={setDraftPermissions}
                ceiling={ficheSubgroup?.ceiling ?? null}
                readOnly={!editable}
              />

              <div className="flex flex-wrap gap-2">
                {editable ? (
                  <button
                    onClick={() => saveFiche.mutate({ id: fiche.id, permissions: draftPermissions ?? [] })}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                  >
                    {t('actions.save')}
                  </button>
                ) : null}

                {fiche.status === 'draft' || fiche.status === 'rejected' ? (
                  <button
                    onClick={() => act.mutate({ id: fiche.id, action: 'submit' })}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium"
                  >
                    {t('actions.submit')}
                  </button>
                ) : null}

                {isApprover ? (
                  <>
                    <button
                      disabled={!canValidate}
                      onClick={() => act.mutate({
                        id: fiche.id, action: 'validate',
                        body: sodAlerts.length > 0 ? { acceptSod: true } : {},
                      })}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
                    >
                      {t('actions.validate')}
                    </button>
                    <button
                      onClick={() => {
                        const reason = window.prompt(t('fiche.rejectReason') ?? '')
                        if (reason) act.mutate({ id: fiche.id, action: 'reject', body: { reason } })
                      }}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium"
                    >
                      {t('actions.reject')}
                    </button>
                  </>
                ) : null}

                {role === 'admin' && fiche.status === 'locked' ? (
                  <button
                    onClick={() => act.mutate({ id: fiche.id, action: 'apply' })}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                  >
                    {t('actions.apply')}
                  </button>
                ) : null}
              </div>
            </article>
          ) : null}
        </section>
      ) : null}

      {tab === 'delegations' ? (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('delegations.intro')}</p>
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t('delegations.empty')}
          </p>
        </section>
      ) : null}

      {previewUser ? (
        <PreviewDrawer userId={previewUser.id} label={previewUser.label} onClose={() => setPreviewUser(null)} />
      ) : null}
    </div>
  )
}
