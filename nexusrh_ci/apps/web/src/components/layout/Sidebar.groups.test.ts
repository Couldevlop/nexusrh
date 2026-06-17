/**
 * Garde-fou de la sidebar groupée : chaque entrée de NAV_GROUPS doit cibler une
 * route et un libellé, les libellés de groupe doivent exister en FR/EN, et aucun
 * doublon de route entre groupes (sinon une page apparaitrait deux fois).
 *
 * Test statique (lecture de source) — pas de rendu React requis.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(WEB_SRC, ...p), 'utf8')
const sidebar = read('components', 'layout', 'Sidebar.tsx')
const navFr = JSON.parse(read('i18n', 'locales', 'fr', 'nav.json')) as { groups: Record<string, string> }
const navEn = JSON.parse(read('i18n', 'locales', 'en', 'nav.json')) as { groups: Record<string, string> }

const GROUP_KEYS = ['collaborators', 'payroll', 'timeExpenses', 'talent', 'analytics', 'adminSecurity']

describe('Sidebar groupée — structure', () => {
  it('le tableau de bord reste épinglé hors groupe', () => {
    expect(sidebar).toContain('const PINNED: NavItem = { to: \'/dashboard\'')
  })

  it('chaque groupe déclaré est traduit en FR et EN', () => {
    for (const key of GROUP_KEYS) {
      expect(sidebar).toContain(`key: '${key}'`)
      expect(navFr.groups[key]).toBeTruthy()
      expect(navEn.groups[key]).toBeTruthy()
    }
  })

  it('aucune route en double entre les groupes', () => {
    const routes = [...sidebar.matchAll(/\bto: '(\/[^']+)'/g)].map(m => m[1]!)
    // /dashboard (épinglé) + entrées de groupe ; pas de doublon attendu.
    const dups = routes.filter((r, i) => routes.indexOf(r) !== i)
    expect(dups, `routes en double: ${dups.join(', ')}`).toEqual([])
  })

  it('les entrées critiques sont rattachées à un groupe (rendu via NAV_GROUPS)', () => {
    for (const route of ['/employees', '/payroll', '/sage', '/security', '/classification', '/org-chart', '/reporting']) {
      expect(sidebar).toContain(`to: '${route}'`)
    }
    expect(sidebar).toContain('NAV_GROUPS')
    expect(sidebar).toContain('toggleGroup')
  })
})
