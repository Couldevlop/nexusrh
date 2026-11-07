/**
 * Habilitations RH — écran d'administration (3 onglets).
 *
 *  - Structure : groupes, sous-groupes, plafonds à cocher, membres, compteur
 *    des employés sans filiale (le « siège »), aperçu « Ce que voit X ».
 *  - Fiches : liste par étape, grille préremplissable par modèle, actions
 *    dépendant de l'étape, téléchargement du PDF.
 *  - Délégations : procurations données et reçues, révocables.
 *  - Piste d'audit : TOUTES les requêtes des habilités, filtrables par rôle,
 *    matricule, période et RÉSULTAT — les accès refusés sont le premier motif
 *    de consultation d'un contrôleur.
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
import { isFicheEditable, MAX_DELEGATION_DAYS } from '@/lib/habilitations'

type Tab = 'structure' | 'fiches' | 'delegations' | 'audit'

interface Delegation {
  id: string
  delegator_id: string
  delegate_id: string
  subgroup_id: string | null
  starts_at: string
  ends_at: string
  revoked_at: string | null
  active: boolean
}

interface AuditRow {
  id: string
  created_at: string
  action: string
  entity: string
  entity_id: string | null
  changes: Record<string, unknown> | null
  email: string | null
  role: string | null
  subgroup_name: string | null
  employee_number: string | null
}

interface AuditFilters {
  result: string
  matricule: string
  from: string
  to: string
}

/** Causes de refus et masquage, telles que le serveur les écrit (hab-trace). */
const AUDIT_RESULTS = ['denied', 'denied_permission', 'denied_scope', 'denied_self', 'masked', 'allowed'] as const

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

  /**
   * Rédaction d'une fiche. Sans cet écran, `POST /habilitations/fiches`
   * n'était appelé nulle part : aucune fiche ne pouvait naître, donc tout le
   * circuit N+1 / N+2, l'application des droits et le PDF restaient
   * inatteignables depuis l'interface.
   *
   * Le N+1 et le N+2 ne sont PAS demandés ici : le serveur les déduit de la
   * hiérarchie du collaborateur visé — deux sources pour la même décision
   * finiraient par diverger.
   */
  const [newFiche, setNewFiche] = useState<{
    targetUserId: string; subgroupId: string; permissions: string[]
    motive: string; effectiveFrom: string; kind: 'grant' | 'revoke'
  } | null>(null)

  /** Utilisateurs du tenant : cibles possibles d'une fiche, membres compris. */
  const usersQ = useQuery({
    queryKey: ['habilitations', 'tenant-users'],
    queryFn: async () => (await api.get('/settings/users')).data.data as Array<{ id: string; email: string }>,
    enabled: role === 'admin' && tab === 'fiches',
  })

  const subgroups = useMemo(
    () => (structure?.groups ?? []).flatMap((g) => g.subgroups),
    [structure],
  )
  const members = useMemo(() => subgroups.flatMap((sg) => sg.members), [subgroups])
  /** Cibles : les membres déjà rattachés ET les autres comptes du tenant. */
  const targetOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const m of members) byId.set(m.userId, m.email)
    for (const u of usersQ.data ?? []) if (!byId.has(u.id)) byId.set(u.id, u.email)
    byId.delete(me) // personne ne rédige sa propre fiche (refusé par le serveur)
    return [...byId.entries()].map(([id, email]) => ({ id, email }))
  }, [members, usersQ.data, me])

  const newFicheSubgroup = useMemo(
    () => subgroups.find((sg) => sg.id === newFiche?.subgroupId) ?? null,
    [subgroups, newFiche?.subgroupId],
  )

  const createFiche = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      (await api.post('/habilitations/fiches', payload)).data,
    onSuccess: () => {
      setNewFiche(null)
      void qc.invalidateQueries({ queryKey: ['habilitations', 'fiches'] })
    },
  })

  const submitNewFiche = (): void => {
    if (!newFiche || !newFiche.targetUserId || !newFiche.subgroupId) return
    const payload: Record<string, unknown> = {
      targetUserId: newFiche.targetUserId,
      subgroupId: newFiche.subgroupId,
      permissions: newFiche.permissions,
      kind: newFiche.kind,
    }
    if (newFiche.motive.trim() !== '') payload.motive = newFiche.motive.trim()
    if (newFiche.effectiveFrom !== '') payload.effectiveFrom = newFiche.effectiveFrom
    createFiche.mutate(payload)
  }

  // ── Onglet Délégations ───────────────────────────────────────────────────
  const delegationsQ = useQuery({
    queryKey: ['habilitations', 'delegations'],
    queryFn: async () => (await api.get('/habilitations/delegations')).data.data as Delegation[],
  })
  const revokeDelegation = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/habilitations/delegations/${id}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['habilitations', 'delegations'] }),
  })

  /**
   * Donner une procuration. Sans ce formulaire, l'onglet ne savait que
   * révoquer des délégations qu'aucun écran ne pouvait créer.
   *
   * La borne de 90 jours est posée sur le champ (attribut `max`) comme elle
   * l'est côté serveur : la refuser sur place évite un aller-retour, et le
   * serveur reste l'autorité.
   */
  const [newDelegation, setNewDelegation] = useState({ delegateId: '', endsAt: '' })
  const maxDelegationDate = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + MAX_DELEGATION_DAYS)
    return d.toISOString().slice(0, 10)
  }, [])
  const createDelegation = useMutation({
    mutationFn: async (payload: { delegateId: string; endsAt: string }) =>
      (await api.post('/habilitations/delegations', payload)).data,
    onSuccess: () => {
      setNewDelegation({ delegateId: '', endsAt: '' })
      void qc.invalidateQueries({ queryKey: ['habilitations', 'delegations'] })
    },
  })

  // ── Onglet Piste d'audit ─────────────────────────────────────────────────
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({ result: '', matricule: '', from: '', to: '' })
  // Filtres passés en `params` (et non concaténés dans l'URL) : l'URL reste un
  // littéral, donc vérifiable par le banc golden du contrat UI↔API.
  const auditParams = useMemo(
    () => Object.fromEntries(Object.entries(auditFilters).filter(([, v]) => v !== '')),
    [auditFilters],
  )
  const auditQ = useQuery({
    queryKey: ['habilitations', 'audit', auditParams],
    queryFn: async () => (await api.get('/habilitations/audit', { params: auditParams })).data.data as AuditRow[],
    enabled: role === 'admin' && tab === 'audit',
  })
  /**
   * Libellé d'une personne à partir de son identifiant, repris des membres déjà
   * chargés par la structure. Repli sur l'identifiant : une délégation reste
   * lisible même si le membre a quitté le sous-groupe entre-temps.
   */
  const memberLabel = (userId: string): string => {
    for (const g of structure?.groups ?? []) {
      for (const sg of g.subgroups) {
        const m = sg.members.find((x) => x.userId === userId)
        if (m) return m.email
      }
    }
    return userId
  }

  /**
   * Export CSV de la piste, AVEC les filtres en cours : un contrôleur part de
   * ce qu'il a sous les yeux. Téléchargement par le flux authentifié (comme le
   * PDF d'une fiche) et non par un lien nu : la piste porte des adresses, des
   * matricules et des routes, elle ne s'ouvre pas sans jeton.
   */
  const exportAudit = async (): Promise<void> => {
    const res = await api.get('/habilitations/audit', {
      params: { ...auditParams, format: 'csv' }, responseType: 'blob',
    })
    const url = URL.createObjectURL(new Blob([res.data as Blob], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `piste-audit-habilitations-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const setAuditFilter = (key: keyof AuditFilters, value: string): void =>
    setAuditFilters((prev) => ({ ...prev, [key]: value }))

  const tabs: Tab[] = role === 'admin'
    ? ['structure', 'fiches', 'delegations', 'audit']
    : ['structure', 'fiches', 'delegations']

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
          {role === 'admin' ? (
            <div className="max-w-2xl space-y-3 rounded-lg border border-border p-4">
              {newFiche === null ? (
                <button
                  onClick={() => setNewFiche({
                    targetUserId: '', subgroupId: '', permissions: [],
                    motive: '', effectiveFrom: '', kind: 'grant',
                  })}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  {t('fiche.new')}
                </button>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">{t('fiche.form.intro')}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">{t('fiche.form.subgroup')}</span>
                      <select
                        aria-label={t('fiche.form.subgroup')}
                        value={newFiche.subgroupId}
                        onChange={(e) => setNewFiche({ ...newFiche, subgroupId: e.target.value, permissions: [] })}
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="">—</option>
                        {subgroups.map((sg) => <option key={sg.id} value={sg.id}>{sg.name}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">{t('fiche.form.target')}</span>
                      <select
                        aria-label={t('fiche.form.target')}
                        value={newFiche.targetUserId}
                        onChange={(e) => setNewFiche({ ...newFiche, targetUserId: e.target.value })}
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="">—</option>
                        {targetOptions.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">{t('fiche.form.kind')}</span>
                      <select
                        aria-label={t('fiche.form.kind')}
                        value={newFiche.kind}
                        onChange={(e) => setNewFiche({ ...newFiche, kind: e.target.value as 'grant' | 'revoke' })}
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="grant">{t('fiche.form.kindGrant')}</option>
                        <option value="revoke">{t('fiche.form.kindRevoke')}</option>
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">{t('fiche.form.effectiveFrom')}</span>
                      <input
                        type="date"
                        aria-label={t('fiche.form.effectiveFrom')}
                        value={newFiche.effectiveFrom}
                        onChange={(e) => setNewFiche({ ...newFiche, effectiveFrom: e.target.value })}
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      />
                    </label>
                  </div>
                  <label className="block space-y-1 text-sm">
                    <span className="font-medium">{t('fiche.form.motive')}</span>
                    <textarea
                      aria-label={t('fiche.form.motive')}
                      value={newFiche.motive}
                      onChange={(e) => setNewFiche({ ...newFiche, motive: e.target.value })}
                      rows={2}
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                    />
                  </label>

                  <PermissionGrid
                    value={newFiche.permissions}
                    onChange={(next) => setNewFiche({ ...newFiche, permissions: next })}
                    ceiling={newFicheSubgroup?.ceiling ?? null}
                  />

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={submitNewFiche}
                      disabled={newFiche.targetUserId === '' || newFiche.subgroupId === ''}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
                    >
                      {t('fiche.form.submit')}
                    </button>
                    <button
                      onClick={() => setNewFiche(null)}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium"
                    >
                      {t('fiche.form.cancel')}
                    </button>
                  </div>
                  {createFiche.isError ? (
                    <p className="text-xs text-destructive">{t('fiche.form.error')}</p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

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

          <div className="max-w-2xl space-y-3 rounded-lg border border-border p-4">
            <p className="text-sm font-medium">{t('delegations.form.title')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span>{t('delegations.form.delegate')}</span>
                <select
                  aria-label={t('delegations.form.delegate')}
                  value={newDelegation.delegateId}
                  onChange={(e) => setNewDelegation({ ...newDelegation, delegateId: e.target.value })}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">—</option>
                  {members
                    .filter((m) => m.userId !== me)
                    .map((m) => <option key={m.userId} value={m.userId}>{m.email}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span>{t('delegations.form.endsAt')}</span>
                <input
                  type="date"
                  aria-label={t('delegations.form.endsAt')}
                  value={newDelegation.endsAt}
                  max={maxDelegationDate}
                  onChange={(e) => setNewDelegation({ ...newDelegation, endsAt: e.target.value })}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('delegations.form.maxDays', { days: MAX_DELEGATION_DAYS })}
            </p>
            <button
              onClick={() => createDelegation.mutate(newDelegation)}
              disabled={newDelegation.delegateId === '' || newDelegation.endsAt === ''}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              {t('delegations.form.submit')}
            </button>
            {createDelegation.isError ? (
              <p className="text-xs text-destructive">{t('delegations.form.error')}</p>
            ) : null}
          </div>

          {(delegationsQ.data ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {t('delegations.empty')}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {(delegationsQ.data ?? []).map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium">{memberLabel(d.delegate_id)}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('delegations.until')} {new Date(d.ends_at).toLocaleDateString()}
                      {d.revoked_at !== null
                        ? ` · ${t('delegations.revoked')}`
                        : d.active ? '' : ` · ${t('delegations.expired')}`}
                    </p>
                  </div>
                  {d.revoked_at === null && d.delegator_id === me ? (
                    <button
                      onClick={() => revokeDelegation.mutate(d.id)}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium"
                    >
                      {t('delegations.revoke')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {tab === 'audit' ? (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('audit.intro')}</p>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('audit.filters.result')}
              <select
                aria-label={t('audit.filters.result')}
                value={auditFilters.result}
                onChange={(e) => setAuditFilter('result', e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                <option value="">{t('audit.filters.all')}</option>
                {AUDIT_RESULTS.map((r) => (
                  <option key={r} value={r}>{t(`audit.results.${r}`)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('audit.filters.matricule')}
              <input
                aria-label={t('audit.filters.matricule')}
                value={auditFilters.matricule}
                onChange={(e) => setAuditFilter('matricule', e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('audit.filters.from')}
              <input
                type="date"
                aria-label={t('audit.filters.from')}
                value={auditFilters.from}
                onChange={(e) => setAuditFilter('from', e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('audit.filters.to')}
              <input
                type="date"
                aria-label={t('audit.filters.to')}
                value={auditFilters.to}
                onChange={(e) => setAuditFilter('to', e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <button
              onClick={() => void exportAudit()}
              className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium"
            >
              <FileText className="h-3 w-3" />
              {t('audit.export')}
            </button>
          </div>

          {auditQ.isLoading ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : null}
          {!auditQ.isLoading && (auditQ.data ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {t('audit.empty')}
            </p>
          ) : null}
          {(auditQ.data ?? []).length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">{t('audit.columns.date')}</th>
                    <th className="px-3 py-2 text-left">{t('audit.columns.user')}</th>
                    <th className="px-3 py-2 text-left">{t('audit.columns.subgroup')}</th>
                    <th className="px-3 py-2 text-left">{t('audit.columns.matricule')}</th>
                    <th className="px-3 py-2 text-left">{t('audit.columns.action')}</th>
                    <th className="px-3 py-2 text-left">{t('audit.columns.result')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(auditQ.data ?? []).map((r) => {
                    const raw = r.changes?.['result']
                    const result = typeof raw === 'string' ? raw : 'allowed'
                    return (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                        <td className="px-3 py-2">{r.email ?? '—'}</td>
                        <td className="px-3 py-2">{r.subgroup_name ?? '—'}</td>
                        <td className="px-3 py-2">{r.employee_number ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              'rounded px-2 py-0.5 text-xs',
                              result.startsWith('denied')
                                ? 'bg-red-100 text-red-900'
                                : result === 'masked'
                                  ? 'bg-amber-100 text-amber-900'
                                  : 'bg-emerald-100 text-emerald-900',
                            )}
                          >
                            {t(`audit.results.${result}`)}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {previewUser ? (
        <PreviewDrawer userId={previewUser.id} label={previewUser.label} onClose={() => setPreviewUser(null)} />
      ) : null}
    </div>
  )
}
