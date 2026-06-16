import { describe, it, expect } from 'vitest'
import {
  buildDepartmentTree,
  buildReportingTree,
  layoutForest,
  renderSvg,
  deptLines,
  empLines,
  truncate,
  type DeptRow,
  type EmpRow,
  type DeptNode,
} from './org-chart.service.js'

// ─── Jeux de données ─────────────────────────────────────────────────────────
const DEPTS: DeptRow[] = [
  { id: 'dir', name: 'Direction Générale', code: 'DG', manager_id: 'e1', parent_id: null },
  { id: 'expl', name: 'Exploitation', code: 'EXP', manager_id: 'e2', parent_id: 'dir' },
  { id: 'maint', name: 'Maintenance', code: 'MNT', manager_id: null, parent_id: 'dir' },
  { id: 'ligne', name: 'Lignes urbaines', code: null, manager_id: null, parent_id: 'expl' },
]

const EMPS: EmpRow[] = [
  { id: 'e1', first_name: 'Aya', last_name: 'Koné', job_title: 'DG', department_id: 'dir', manager_id: null },
  { id: 'e2', first_name: 'Jean', last_name: 'Brou', job_title: 'Chef Exploitation', department_id: 'expl', manager_id: 'e1' },
  { id: 'e3', first_name: 'Awa', last_name: 'Traoré', job_title: 'Chauffeur', department_id: 'ligne', manager_id: 'e2' },
  { id: 'e4', first_name: 'Koffi', last_name: 'Yao', job_title: 'Contrôleur', department_id: 'ligne', manager_id: 'e2' },
  { id: 'e5', first_name: 'Mariam', last_name: 'Sane', job_title: 'Mécanicien', department_id: 'maint', manager_id: 'e1' },
]

describe('buildDepartmentTree', () => {
  it('construit la hiérarchie par parent_id avec une seule racine', () => {
    const roots = buildDepartmentTree(DEPTS, EMPS)
    expect(roots).toHaveLength(1)
    expect(roots[0]?.id).toBe('dir')
    expect(roots[0]?.children.map((c) => c.id).sort()).toEqual(['expl', 'maint'])
  })

  it('résout le nom du responsable depuis manager_id', () => {
    const roots = buildDepartmentTree(DEPTS, EMPS)
    expect(roots[0]?.managerName).toBe('Aya Koné')
    const expl = roots[0]?.children.find((c) => c.id === 'expl')
    expect(expl?.managerName).toBe('Jean Brou')
  })

  it('compte les effectifs directs et cumulés', () => {
    const roots = buildDepartmentTree(DEPTS, EMPS)
    const dir = roots[0] as DeptNode
    expect(dir.headcount).toBe(1) // e1 rattaché à dir
    expect(dir.totalHeadcount).toBe(5) // tous
    const ligne = dir.children.find((c) => c.id === 'expl')?.children.find((c) => c.id === 'ligne')
    expect(ligne?.headcount).toBe(2) // e3, e4
  })

  it('traite un parent introuvable comme racine', () => {
    const roots = buildDepartmentTree(
      [{ id: 'x', name: 'Orphelin', code: null, manager_id: null, parent_id: 'inexistant' }],
      [],
    )
    expect(roots).toHaveLength(1)
    expect(roots[0]?.id).toBe('x')
  })

  it('ne boucle jamais sur un cycle de données (a→b→a)', () => {
    const cyclic: DeptRow[] = [
      { id: 'a', name: 'A', code: null, manager_id: null, parent_id: 'b' },
      { id: 'b', name: 'B', code: null, manager_id: null, parent_id: 'a' },
    ]
    const roots = buildDepartmentTree(cyclic, [])
    // Au moins une racine, pas d'exception/boucle infinie.
    expect(roots.length).toBeGreaterThanOrEqual(1)
  })
})

describe('buildReportingTree', () => {
  it('construit la hiérarchie managériale via manager_id', () => {
    const roots = buildReportingTree(EMPS)
    expect(roots).toHaveLength(1)
    expect(roots[0]?.id).toBe('e1')
    const e2 = roots[0]?.children.find((c) => c.id === 'e2')
    expect(e2?.children.map((c) => c.id).sort()).toEqual(['e3', 'e4'])
  })

  it('résout le service via la map fournie', () => {
    const deptNames = new Map([['expl', 'Exploitation']])
    const roots = buildReportingTree(EMPS, null, deptNames)
    const e2 = roots[0]?.children.find((c) => c.id === 'e2')
    expect(e2?.departmentName).toBe('Exploitation')
  })

  it('rootEmployeeId ne renvoie que le sous-arbre demandé', () => {
    const roots = buildReportingTree(EMPS, 'e2')
    expect(roots).toHaveLength(1)
    expect(roots[0]?.id).toBe('e2')
    expect(roots[0]?.children).toHaveLength(2)
  })

  it('rootEmployeeId inexistant → forêt vide', () => {
    expect(buildReportingTree(EMPS, 'inconnu')).toEqual([])
  })
})

describe('layoutForest', () => {
  it('positionne chaque nœud et crée une arête par lien parent→enfant', () => {
    const roots = buildDepartmentTree(DEPTS, EMPS)
    const layout = layoutForest<DeptNode>(roots, deptLines)
    expect(layout.nodes).toHaveLength(4) // 4 services
    expect(layout.edges).toHaveLength(3) // dir→expl, dir→maint, expl→ligne
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })
})

describe('renderSvg', () => {
  it('produit un SVG bien formé contenant les libellés (échappés)', () => {
    const roots = buildDepartmentTree(DEPTS, EMPS)
    const svg = renderSvg(layoutForest<DeptNode>(roots, deptLines), 'Organigramme par service')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('</svg>')
    expect(svg).toContain('Direction')
    expect(svg).toContain('<rect')
  })

  it('échappe les caractères XML spéciaux', () => {
    const roots = buildDepartmentTree(
      [{ id: 'a', name: 'R&D <Innovation>', code: null, manager_id: null, parent_id: null }],
      [],
    )
    const svg = renderSvg(layoutForest<DeptNode>(roots, deptLines), 'Test & <co>')
    expect(svg).toContain('R&amp;D &lt;Innovation&gt;')
    expect(svg).not.toContain('R&D <Innovation>')
  })
})

describe('truncate / lignes', () => {
  it('truncate respecte la longueur max avec suffixe PDF-safe', () => {
    expect(truncate('court', 10)).toBe('court')
    expect(truncate('un nom vraiment beaucoup trop long', 10)).toBe('un nom v..')
  })

  it('empLines expose nom + poste (jamais de donnée sensible)', () => {
    const node = buildReportingTree(EMPS)[0]
    const lines = empLines(node!)
    expect(lines[0]).toBe('Aya Koné')
    expect(lines.join(' ')).not.toMatch(/salaire|salary|\d{6,}/i)
  })
})
