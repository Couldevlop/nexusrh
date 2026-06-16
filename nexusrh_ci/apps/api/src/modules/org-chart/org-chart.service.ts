/**
 * Organigramme dynamique — logique PURE (zéro dépendance Fastify/DB/pdf-lib).
 *
 * L'organigramme est DÉRIVÉ des tables existantes `departments` et `employees`
 * (relations parent_id / manager_id) : aucune nouvelle table, donc aucune
 * migration. La « mise à jour automatique » exigée par le cahier des charges est
 * native — chaque appel reconstruit l'arbre à partir des données vivantes.
 *
 * SÉCURITÉ (OWASP A01/A02) : ce service ne manipule QUE des champs de niveau 1
 * (organigramme général = donnée publique) — nom, intitulé de poste, service,
 * photo. Aucune donnée sensible (salaire, NNI, IBAN…) n'entre ici : la requête
 * SQL côté routes ne les sélectionne pas et ces fonctions ne les acceptent pas.
 *
 * Couche « domain » de la Clean Architecture : entièrement testable sans
 * infrastructure (voir org-chart.service.test.ts).
 */

// ─── Entrées brutes (sous-ensemble NON SENSIBLE des colonnes) ────────────────
export interface DeptRow {
  id: string
  name: string
  code: string | null
  manager_id: string | null
  parent_id: string | null
}

export interface EmpRow {
  id: string
  first_name: string
  last_name: string
  job_title: string | null
  department_id: string | null
  manager_id: string | null
  profile_photo_url?: string | null
}

// ─── Nœuds d'arbre ───────────────────────────────────────────────────────────
export interface DeptNode {
  id: string
  name: string
  code: string | null
  managerName: string | null
  /** Effectif rattaché DIRECTEMENT à ce service. */
  headcount: number
  /** Effectif cumulé (ce service + tous ses sous-services). */
  totalHeadcount: number
  children: DeptNode[]
}

export interface EmpNode {
  id: string
  name: string
  title: string | null
  departmentName: string | null
  photoUrl: string | null
  children: EmpNode[]
}

/** Vrai si rattacher `childId` à `parentId` créerait un cycle (remontée des parents). */
function wouldCycle(
  childId: string,
  parentId: string,
  parentOf: Map<string, string | null>,
): boolean {
  let cursor: string | null | undefined = parentId
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === childId) return true
    if (seen.has(cursor)) return true // cycle préexistant dans les données
    seen.add(cursor)
    cursor = parentOf.get(cursor) ?? null
  }
  return false
}

/**
 * Construit la forêt des SERVICES (organigramme par direction/département).
 * Racines = services sans parent (ou parent introuvable). Robuste aux cycles.
 */
export function buildDepartmentTree(depts: DeptRow[], emps: EmpRow[]): DeptNode[] {
  const empName = new Map<string, string>()
  const directHeadcount = new Map<string, number>()
  for (const e of emps) {
    empName.set(e.id, `${e.first_name} ${e.last_name}`.trim())
    if (e.department_id) {
      directHeadcount.set(e.department_id, (directHeadcount.get(e.department_id) ?? 0) + 1)
    }
  }

  const byId = new Map<string, DeptNode>()
  for (const d of depts) {
    byId.set(d.id, {
      id: d.id,
      name: d.name,
      code: d.code,
      managerName: d.manager_id ? empName.get(d.manager_id) ?? null : null,
      headcount: directHeadcount.get(d.id) ?? 0,
      totalHeadcount: 0,
      children: [],
    })
  }

  const parentOf = new Map<string, string | null>()
  for (const d of depts) parentOf.set(d.id, d.parent_id)

  const roots: DeptNode[] = []
  for (const d of depts) {
    const node = byId.get(d.id)
    if (!node) continue
    const parent = d.parent_id ? byId.get(d.parent_id) : undefined
    if (parent && d.parent_id !== d.id && !wouldCycle(d.id, d.parent_id as string, parentOf)) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Effectif cumulé (post-ordre, garde anti-cycle déjà assurée par la structure).
  const computeTotal = (node: DeptNode): number => {
    let total = node.headcount
    for (const c of node.children) total += computeTotal(c)
    node.totalHeadcount = total
    return total
  }
  for (const r of roots) computeTotal(r)

  return roots
}

/**
 * Construit la forêt HIÉRARCHIQUE (qui reporte à qui) via manager_id.
 * Racines = employés sans manager (ou manager hors périmètre). Si `rootId` est
 * fourni, ne renvoie que le sous-arbre de cet employé. Robuste aux cycles.
 */
export function buildReportingTree(
  emps: EmpRow[],
  rootId?: string | null,
  deptNames?: Map<string, string>,
): EmpNode[] {
  const deptName = deptNames ?? new Map<string, string>()

  const byId = new Map<string, EmpNode>()
  for (const e of emps) {
    byId.set(e.id, {
      id: e.id,
      name: `${e.first_name} ${e.last_name}`.trim(),
      title: e.job_title ?? null,
      departmentName: e.department_id ? deptName.get(e.department_id) ?? null : null,
      photoUrl: e.profile_photo_url ?? null,
      children: [],
    })
  }

  const parentOf = new Map<string, string | null>()
  for (const e of emps) parentOf.set(e.id, e.manager_id)

  const roots: EmpNode[] = []
  for (const e of emps) {
    const node = byId.get(e.id)
    if (!node) continue
    const manager = e.manager_id ? byId.get(e.manager_id) : undefined
    if (manager && e.manager_id !== e.id && !wouldCycle(e.id, e.manager_id as string, parentOf)) {
      manager.children.push(node)
    } else {
      roots.push(node)
    }
  }

  if (rootId) {
    const sub = byId.get(rootId)
    return sub ? [sub] : []
  }
  return roots
}

// ─── Mise en page (layout) pour rendu SVG / PDF ──────────────────────────────
export const BOX_W = 196
export const BOX_H = 60
const H_GAP = 26
const V_GAP = 48
const MARGIN = 28

export interface PositionedNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  lines: string[]
}
export interface Edge { x1: number; y1: number; x2: number; y2: number }
export interface Layout { nodes: PositionedNode[]; edges: Edge[]; width: number; height: number }

interface TreeLike { id: string; children: TreeLike[] }

/**
 * Layout d'arbre « tidy » simple : largeur de sous-arbre calculée en post-ordre,
 * parent centré au-dessus de ses enfants. Forêt = racines juxtaposées.
 */
export function layoutForest<T extends TreeLike>(roots: T[], label: (n: T) => string[]): Layout {
  const nodes: PositionedNode[] = []
  const edges: Edge[] = []
  let cursorX = MARGIN

  const place = (node: T, depth: number): number => {
    const y = MARGIN + depth * (BOX_H + V_GAP)
    if (node.children.length === 0) {
      const x = cursorX
      cursorX += BOX_W + H_GAP
      nodes.push({ id: node.id, x, y, w: BOX_W, h: BOX_H, lines: label(node) })
      return x + BOX_W / 2
    }
    const childCenters: number[] = []
    for (const child of node.children) {
      childCenters.push(place(child as T, depth + 1))
    }
    const first = childCenters[0] ?? cursorX
    const last = childCenters[childCenters.length - 1] ?? first
    const centerX = (first + last) / 2
    const x = centerX - BOX_W / 2
    nodes.push({ id: node.id, x, y, w: BOX_W, h: BOX_H, lines: label(node) })
    const childY = MARGIN + (depth + 1) * (BOX_H + V_GAP)
    for (const cx of childCenters) {
      edges.push({ x1: centerX, y1: y + BOX_H, x2: cx, y2: childY })
    }
    return centerX
  }

  for (const r of roots) place(r, 0)

  let width = MARGIN
  let height = MARGIN
  for (const n of nodes) {
    width = Math.max(width, n.x + n.w)
    height = Math.max(height, n.y + n.h)
  }
  return { nodes, edges, width: width + MARGIN, height: height + MARGIN }
}

/** Coupe une chaîne trop longue pour tenir dans une boîte (suffixe PDF-safe « .. »). */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 2))}..`
}

export function deptLines(n: DeptNode): string[] {
  const head = n.code ? `${n.name} (${n.code})` : n.name
  const lines = [truncate(head, 28)]
  if (n.managerName) lines.push(truncate(`Resp. : ${n.managerName}`, 30))
  lines.push(`${n.totalHeadcount} agent${n.totalHeadcount > 1 ? 's' : ''}`)
  return lines
}

export function empLines(n: EmpNode): string[] {
  const lines = [truncate(n.name, 28)]
  if (n.title) lines.push(truncate(n.title, 30))
  if (n.departmentName) lines.push(truncate(n.departmentName, 30))
  return lines
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Rendu SVG (format image accepté par le DAO), 100% chaîne, sans dépendance. */
export function renderSvg(layout: Layout, title: string): string {
  const { nodes, edges, width, height } = layout
  const headerH = 40
  const totalH = height + headerH
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalH}" ` +
      `viewBox="0 0 ${width} ${totalH}" font-family="Helvetica, Arial, sans-serif">`,
  )
  parts.push(`<rect x="0" y="0" width="${width}" height="${totalH}" fill="#ffffff"/>`)
  parts.push(
    `<text x="${MARGIN}" y="26" font-size="16" font-weight="bold" fill="#0F2A44">${escapeXml(title)}</text>`,
  )
  const off = headerH
  for (const e of edges) {
    parts.push(
      `<path d="M ${e.x1} ${e.y1 + off} C ${e.x1} ${(e.y1 + e.y2) / 2 + off}, ${e.x2} ${(e.y1 + e.y2) / 2 + off}, ${e.x2} ${e.y2 + off}" ` +
        `fill="none" stroke="#94A3B8" stroke-width="1.5"/>`,
    )
  }
  for (const n of nodes) {
    parts.push(
      `<rect x="${n.x}" y="${n.y + off}" width="${n.w}" height="${n.h}" rx="8" ` +
        `fill="#F8FAFC" stroke="#E85D04" stroke-width="1.5"/>`,
    )
    n.lines.forEach((line, i) => {
      const fy = n.y + off + 20 + i * 15
      const weight = i === 0 ? 'bold' : 'normal'
      const color = i === 0 ? '#0F2A44' : '#475569'
      const size = i === 0 ? 11 : 9.5
      parts.push(
        `<text x="${n.x + 10}" y="${fy}" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(line)}</text>`,
      )
    })
  }
  parts.push('</svg>')
  return parts.join('\n')
}

export const ORG_CHART_LAYOUT_CONSTANTS = { BOX_W, BOX_H, H_GAP, V_GAP, MARGIN }
