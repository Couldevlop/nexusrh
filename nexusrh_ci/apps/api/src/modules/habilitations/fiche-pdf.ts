/**
 * PDF de la fiche d'habilitation, à la charte de l'entreprise.
 *
 * La fiche imprimée est la pièce qui circule : elle est signée par la
 * hiérarchie, classée au dossier, parfois montrée à un auditeur. Deux
 * conséquences de conception :
 *
 *  - elle ne porte QUE l'identité professionnelle (nom, matricule) et des
 *    cases de la grille — jamais de salaire, de NNI, de RIB : aucune donnée
 *    sensible ne doit fuir par un document distribué ;
 *  - tant qu'elle n'est pas verrouillée, elle porte une marque de brouillon,
 *    pour qu'un tirage intermédiaire ne puisse pas passer pour la décision.
 *
 * Le rendu réutilise `renderHrDocumentPdf` (logo, couleur et mentions légales
 * du tenant) : la fiche a la même tenue que les autres documents RH.
 */
import { pool } from '../../db/pool.js'
import { assertValidSchemaName } from '../../utils/schema-name.js'
import { renderHrDocumentPdf } from '../recruitment/hr-document-pdf.js'
import { loadContractEmployer } from '../recruitment/contract-proposal.service.js'
import { HAB_FUNCTIONS, HAB_GRID, HAB_EXTRA, type HabAction, type HabFunction } from './catalog.js'
import { FicheError, type FicheDb } from './fiche.service.js'

/** Marque portée par tout tirage d'une fiche non verrouillée. */
export const FICHE_DRAFT_MARK = 'BROUILLON — fiche non verrouillée'

/** Libellés des fonctions et des actions (le PDF se lit sans décodeur). */
const FUNCTION_LABELS: Record<HabFunction, string> = {
  employees: 'Employés', contracts: 'Contrats', absences: 'Absences',
  attendance: 'Pointage', payroll: 'Paie', payroll_multi: 'Paie multi-filiales',
  declarations: 'Déclarations', payments: 'Paiements', expenses: 'Notes de frais',
  recruitment: 'Recrutement', lifecycle: 'Entrées / sorties', discipline: 'Discipline',
  training: 'Formation', talent: 'Talents et carrières', climate: 'Climat social',
  signature: 'Signature', reporting: 'Reporting', hr_settings: 'Paramétrage RH',
}
const ACTION_LABELS: Record<HabAction, string> = {
  view: 'Consulter', create: 'Créer', update: 'Modifier', delete: 'Supprimer',
  validate: 'Valider', close: 'Clôturer', export: 'Exporter', pay: 'Payer',
  configure: 'Paramétrer',
}
const EXTRA_LABELS: Record<string, string> = {
  sensitive_data: 'Données sensibles (salaires, coordonnées bancaires)',
  all_entities: 'Toutes les filiales',
  manage_habilitations: 'Gérer les habilitations',
}
const EVENT_LABELS: Record<string, string> = {
  created: 'Rédigée', edited: 'Modifiée', submitted: 'Soumise',
  validated: 'Validée', rejected: 'Refusée', locked: 'Verrouillée',
  applied: 'Appliquée', sod_accepted: 'Cumul accepté',
}

/** Colonnes du tableau : l'ordre canonique du catalogue. */
const ACTION_COLUMNS: HabAction[] = ['view', 'create', 'update', 'delete', 'validate', 'close', 'export', 'pay', 'configure']

export interface FichePdfData {
  number: string
  status: string
  kind: 'grant' | 'revoke'
  person: { name: string; matricule: string | null }
  groupName: string | null
  subgroupName: string | null
  /** Périmètre en clair : « Siège », « Toutes les filiales », « Filiale X ». */
  scopeLabel: string
  permissions: string[]
  sodAlerts: string[]
  timeline: Array<{ event: string; actorName: string | null; at: string }>
  motive: string | null
}

/** `null` dès que la fiche est verrouillée : le tirage vaut alors décision. */
export function draftMarkFor(status: string): string | null {
  return status === 'locked' || status === 'applied' ? null : FICHE_DRAFT_MARK
}

/** Date lisible (AAAA-MM-JJ conservé tel quel : non ambigu, et testable). */
function day(value: string): string {
  return (value ?? '').slice(0, 10)
}

export function ficheMarkdown(d: FichePdfData): string {
  const lines: string[] = []
  lines.push(`# Fiche d'habilitation ${d.number}`)
  lines.push('')
  lines.push(d.kind === 'revoke'
    ? '**Objet : retrait de droits d\'accès**'
    : '**Objet : attribution de droits d\'accès**')
  lines.push('')
  lines.push(`**Personne concernée :** ${d.person.name}${d.person.matricule ? ` (matricule ${d.person.matricule})` : ''}`)
  lines.push(`**Groupe :** ${d.groupName ?? '—'}`)
  lines.push(`**Sous-groupe :** ${d.subgroupName ?? '—'}`)
  lines.push(`**Périmètre :** ${d.scopeLabel}`)
  if (d.motive) lines.push(`**Motif :** ${d.motive}`)
  lines.push('')

  // Tableau fonctions × actions : seules les fonctions réellement ouvertes,
  // pour que la fiche se lise d'un coup d'œil.
  const granted = new Set(d.permissions)
  const rows = HAB_FUNCTIONS.filter((fn) => HAB_GRID[fn].some((a) => granted.has(`${fn}:${a}`)))
  lines.push('## Droits accordés')
  lines.push('')
  if (rows.length === 0) {
    lines.push('Aucune case cochée.')
  } else {
    const cols = ACTION_COLUMNS.filter((a) => rows.some((fn) => (HAB_GRID[fn] as readonly string[]).includes(a)))
    lines.push(`| Fonction | ${cols.map((a) => ACTION_LABELS[a]).join(' | ')} |`)
    lines.push(`|---|${cols.map(() => '---').join('|')}|`)
    for (const fn of rows) {
      const cells = cols.map((a) => {
        if (!(HAB_GRID[fn] as readonly string[]).includes(a)) return ' '
        return granted.has(`${fn}:${a}`) ? 'X' : '-'
      })
      lines.push(`| ${FUNCTION_LABELS[fn]} | ${cells.join(' | ')} |`)
    }
  }
  lines.push('')

  const extras = HAB_EXTRA.filter((e) => granted.has(e))
  if (extras.length > 0) {
    lines.push('## Droits transverses')
    lines.push('')
    for (const e of extras) lines.push(`- ${EXTRA_LABELS[e] ?? e}`)
    lines.push('')
  }

  if (d.sodAlerts.length > 0) {
    lines.push('## Cumuls sensibles relevés')
    lines.push('')
    for (const a of d.sodAlerts) lines.push(`- ${a}`)
    lines.push('')
    lines.push('Ces cumuls ont été acceptés explicitement par le validateur.')
    lines.push('')
  }

  lines.push('## Chronologie des validations')
  lines.push('')
  if (d.timeline.length === 0) {
    lines.push('Aucune étape enregistrée.')
  } else {
    lines.push('| Étape | Par | Le |')
    lines.push('|---|---|---|')
    for (const t of d.timeline) {
      lines.push(`| ${EVENT_LABELS[t.event] ?? t.event} | ${t.actorName ?? '—'} | ${day(t.at)} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

interface FicheDataRow {
  number: string
  status: string
  kind: 'grant' | 'revoke'
  permissions: string[] | null
  sod_alerts: Array<{ label: string }> | null
  motive: string | null
  group_name: string | null
  subgroup_name: string | null
  subgroup_kind: 'siege' | 'entity' | null
  legal_entity_name: string | null
  person_name: string | null
  matricule: string | null
}

/** Périmètre en clair, déduit du sous-groupe et de la case « toutes filiales ». */
function scopeLabel(row: FicheDataRow, permissions: string[]): string {
  if (row.subgroup_kind === 'entity') return row.legal_entity_name ?? 'Filiale'
  if (permissions.includes('all_entities')) return 'Toutes les filiales'
  return 'Siège'
}

/** Rassemble la fiche, la personne et le journal, puis rend le PDF. */
export async function renderFichePdf(
  schema: string, ficheId: string, db: FicheDb = pool,
): Promise<{ pdf: Uint8Array; number: string }> {
  assertValidSchemaName(schema)
  const res = await db.query<FicheDataRow>(
    `SELECT f.number, f.status, f.kind, f.permissions, f.sod_alerts, f.motive,
            g.name AS group_name, sg.name AS subgroup_name, sg.kind AS subgroup_kind,
            le.name AS legal_entity_name,
            trim(coalesce(e.first_name, u.first_name, '') || ' ' || coalesce(e.last_name, u.last_name, '')) AS person_name,
            e.employee_number AS matricule
       FROM "${schema}".hab_fiches f
       LEFT JOIN "${schema}".hab_subgroups sg ON sg.id = f.subgroup_id
       LEFT JOIN "${schema}".hab_groups g ON g.id = sg.group_id
       LEFT JOIN "${schema}".legal_entities le ON le.id = sg.legal_entity_id
       LEFT JOIN "${schema}".users u ON u.id = f.target_user_id
       LEFT JOIN "${schema}".employees e ON e.id = u.employee_id
      WHERE f.id = $1::uuid`,
    [ficheId],
  )
  const row = res.rows[0]
  if (!row) throw new FicheError(404, 'Fiche introuvable')

  const events = await db.query<{ event: string; at: string; actor_name: string | null }>(
    `SELECT ev.event, ev.created_at AS at,
            nullif(trim(coalesce(e.first_name, u.first_name, '') || ' ' || coalesce(e.last_name, u.last_name, '')), '') AS actor_name
       FROM "${schema}".hab_fiche_events ev
       LEFT JOIN "${schema}".users u ON u.id = ev.actor_id
       LEFT JOIN "${schema}".employees e ON e.id = u.employee_id
      WHERE ev.fiche_id = $1::uuid
      ORDER BY ev.created_at`,
    [ficheId],
  )

  const permissions = row.permissions ?? []
  const data: FichePdfData = {
    number: row.number,
    status: row.status,
    kind: row.kind,
    person: { name: row.person_name?.trim() || 'Personne inconnue', matricule: row.matricule },
    groupName: row.group_name,
    subgroupName: row.subgroup_name,
    scopeLabel: scopeLabel(row, permissions),
    permissions,
    sodAlerts: (row.sod_alerts ?? []).map((a) => a.label).filter((l): l is string => Boolean(l)),
    timeline: events.rows.map((e) => ({ event: e.event, actorName: e.actor_name, at: String(e.at) })),
    motive: row.motive,
  }

  // Habillage du tenant, mais marque PROPRE à la fiche (jamais « PROPOSITION »).
  const employer = await loadContractEmployer(schema, null)
  const pdf = await renderHrDocumentPdf(ficheMarkdown(data), {
    ...employer.branding,
    draftMark: draftMarkFor(row.status),
  })
  return { pdf, number: row.number }
}
