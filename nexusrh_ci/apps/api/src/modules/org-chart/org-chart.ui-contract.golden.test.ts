/**
 * GOLDEN — Contrat UI ↔ API du module Organigramme.
 *
 * Verrouille la cohérence frontend/backend (anti « bouton → endpoint inexistant »)
 * et les invariants de sécurité du module :
 *  1. Clé de module 'org_chart' alignée API ↔ web, mapping d'URL, enregistrement.
 *  2. Sidebar + route protégées (RoleGuard + ModuleGuard), i18n FR/EN.
 *  3. La page consomme exactement les endpoints exposés par l'API.
 *  4. OWASP A02 : la requête employés des routes ne sélectionne aucun champ sensible.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MODULE_KEYS } from '../../services/tenant-modules.service.js'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..') // apps/api/src
const WEB_SRC = join(API_SRC, '..', '..', '..', 'apps', 'web', 'src')
const readApi = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')
const readWeb = (...p: string[]) => readFileSync(join(WEB_SRC, ...p), 'utf8')

const modulesService = readApi('services', 'tenant-modules.service.ts')
const appTs          = readApi('app.ts')
const routes         = readApi('modules', 'org-chart', 'org-chart.routes.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'org-chart', 'OrgChartPage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN org-chart — clé de module alignée API ↔ web', () => {
  it("'org_chart' est une clé de module canonique (API)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('org_chart')).toBe(true)
  })
  it("'org_chart' présent côté web (lib/modules.ts) et actif par défaut", () => {
    expect(webModules).toContain(`'org_chart'`)
    expect(webModules).toMatch(/org_chart:\s+true/)
  })
  it("mapping d'URL /org-chart → org_chart (enforcement A01)", () => {
    expect(modulesService).toContain(`['/org-chart',        'org_chart']`)
  })
  it('route enregistrée dans app.ts au préfixe /org-chart', () => {
    expect(appTs).toContain('orgChartRoutes')
    expect(appTs).toMatch(/register\(orgChartRoutes,\s*\{\s*prefix:\s*'\/org-chart'\s*\}\)/)
  })
})

describe('GOLDEN org-chart — sidebar & route protégées', () => {
  it('entrée de sidebar gatée par rôle + module', () => {
    expect(sidebar).toContain(`to: '/org-chart'`)
    expect(sidebar).toContain(`moduleKey: 'org_chart'`)
    expect(sidebar).toContain(`labelKey: 'orgChart'`)
  })
  it('route protégée par RoleGuard + ModuleGuard org_chart', () => {
    expect(appTsx).toContain('OrgChartPage')
    expect(appTsx).toMatch(/path="org-chart"[\s\S]{0,260}moduleKey="org_chart"/)
  })
})

describe('GOLDEN org-chart — la page consomme les endpoints exposés', () => {
  it('GET /org-chart/departments et /org-chart/reporting', () => {
    expect(page).toContain('/org-chart/departments')
    expect(page).toContain('/org-chart/reporting')
  })
  it('exports PDF et SVG', () => {
    expect(page).toContain('/org-chart/export.')
    expect(routes).toContain(`fastify.get('/export.pdf'`)
    expect(routes).toContain(`fastify.get('/export.svg'`)
  })
})

describe('GOLDEN org-chart — i18n FR/EN', () => {
  it('namespace orgChart enregistré + libellé nav présent', () => {
    expect(i18nIndex).toMatch(/orgChart/)
    expect(existsSync(join(WEB_SRC, 'i18n', 'locales', 'fr', 'orgChart.json'))).toBe(true)
    expect(existsSync(join(WEB_SRC, 'i18n', 'locales', 'en', 'orgChart.json'))).toBe(true)
    expect(JSON.parse(readWeb('i18n', 'locales', 'fr', 'nav.json'))['orgChart']).toBeDefined()
    expect(JSON.parse(readWeb('i18n', 'locales', 'en', 'nav.json'))['orgChart']).toBeDefined()
  })
  it('fichiers JSON sans BOM (piège Vite/PowerShell)', () => {
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'orgChart.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
    }
  })
})

describe('GOLDEN org-chart — sécurité (OWASP A02)', () => {
  it('la requête employés ne sélectionne aucun champ sensible', () => {
    const empSelect = routes.slice(routes.indexOf('SELECT_EMPS'))
    expect(empSelect).not.toMatch(/base_salary|\bnni\b|\biban\b/i)
    expect(routes).toContain('is_active = true')
  })
})
