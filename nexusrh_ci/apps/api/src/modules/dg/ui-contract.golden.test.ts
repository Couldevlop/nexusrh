/**
 * GOLDEN — Contrat UI ↔ API : modules par tenant + vue DG 360°.
 *
 * Verrouille la cohérence frontend/backend pour éviter le bug classique
 * « bouton qui appelle un endpoint inexistant » :
 *  1. La liste canonique des modules est IDENTIQUE côté web et côté API.
 *  2. Le portail super_admin appelle bien PUT /platform/tenants/:id/modules et
 *     POST /platform/tenants/modules-bulk (cabinet).
 *  3. La sidebar tenant filtre par module ; le rôle dg a sa navigation dédiée.
 *  4. Les pages DG appellent les endpoints /dg/* exposés par l'API.
 *  5. i18n : namespace dg présent en FR et EN ; libellés modules en FR et EN.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MODULE_KEYS as API_MODULE_KEYS } from '../../services/tenant-modules.service.js'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB_SRC = join(API_SRC, '..', '..', '..', 'apps', 'web', 'src')
const read = (...p: string[]) => readFileSync(join(WEB_SRC, ...p), 'utf8')

const webModules    = read('lib', 'modules.ts')
const sidebar       = read('components', 'layout', 'Sidebar.tsx')
const appTsx        = read('App.tsx')
const authStore     = read('stores', 'authStore.ts')
const moduleGuard   = read('guards', 'ModuleGuard.tsx')
const tenantDetail  = read('pages', 'platform', 'PlatformTenantDetail.tsx')
const agencyDetail  = read('pages', 'platform', 'PlatformAgencyDetail.tsx')
const dgDashboard   = read('pages', 'dg', 'DgDashboardPage.tsx')
const dgActivity    = read('pages', 'dg', 'DgActivityPage.tsx')

describe('GOLDEN contrat UI↔API — liste canonique des modules', () => {
  it('chaque clé de module API existe dans lib/modules.ts web (et dg_view opt-in)', () => {
    for (const key of API_MODULE_KEYS) {
      expect(webModules).toContain(`'${key}'`)
    }
    expect(webModules).toMatch(/dg_view:\s+false/)
  })

  it('tenantConfig.enabledModules typé dans le store (reçu au login)', () => {
    expect(authStore).toContain('enabledModules?: Record<string, boolean>')
  })

  it('le rôle dg existe côté web', () => {
    expect(authStore).toContain(`'dg'`)
  })
})

describe('GOLDEN contrat UI↔API — portail super_admin', () => {
  it('détail tenant : GET + PUT /platform/tenants/:id/modules', () => {
    expect(tenantDetail).toMatch(/\/platform\/tenants\/\$\{[^}]+\}\/modules/)
    expect(tenantDetail).toMatch(/\.put\(/)
  })

  it('détail cabinet : POST /platform/tenants/modules-bulk avec tenantIds + modules', () => {
    expect(agencyDetail).toContain('/platform/tenants/modules-bulk')
    expect(agencyDetail).toContain('tenantIds')
    expect(agencyDetail).toContain('modules')
  })
})

describe('GOLDEN contrat UI↔API — sidebar et guards', () => {
  it('la sidebar filtre les entrées par module activé', () => {
    expect(sidebar).toContain('moduleKey')
    expect(sidebar).toContain('isModuleEnabled')
  })

  it('navigation dédiée au rôle dg (Vue 360° + Activité)', () => {
    expect(sidebar).toContain('DG_NAV')
    expect(sidebar).toContain(`'/dg'`)
    expect(sidebar).toContain(`'/dg/activity'`)
  })

  it('ModuleGuard redirige si le module est désactivé', () => {
    expect(moduleGuard).toContain('isModuleEnabled')
    expect(moduleGuard).toContain('Navigate')
  })

  it('App.tsx : routes /dg protégées par RoleGuard dg + ModuleGuard dg_view', () => {
    expect(appTsx).toMatch(/RoleGuard[\s\S]{0,200}'dg'/)
    expect(appTsx).toMatch(/ModuleGuard[\s\S]{0,80}dg_view/)
  })
})

describe('GOLDEN contrat UI↔API — pages DG', () => {
  it('le dashboard DG consomme GET /dg/overview et affiche les KPIs', () => {
    expect(dgDashboard).toContain('/dg/overview')
    for (const kpi of ['activeEmployees', 'payrollMassFcfa', 'absentToday', 'pendingApprovals', 'absenteeismRatePct']) {
      expect(dgDashboard).toContain(kpi)
    }
  })

  it('le journal consomme GET /dg/activity et /dg/actors avec les filtres', () => {
    expect(dgActivity).toContain('/dg/activity')
    expect(dgActivity).toContain('/dg/actors')
    expect(dgActivity).toContain('userId')
    expect(dgActivity).toMatch(/period/)
  })

  it('groupes par catégorie dépliables (accordéon) côté UI', () => {
    expect(dgActivity).toMatch(/groups/)
    expect(dgActivity).toMatch(/category/)
  })
})

describe('GOLDEN contrat UI↔API — i18n FR/EN', () => {
  it('namespace dg présent en FR et EN et enregistré', () => {
    expect(existsSync(join(WEB_SRC, 'i18n', 'locales', 'fr', 'dg.json'))).toBe(true)
    expect(existsSync(join(WEB_SRC, 'i18n', 'locales', 'en', 'dg.json'))).toBe(true)
    const i18nIndex = read('i18n', 'index.ts')
    expect(i18nIndex).toMatch(/dg/)
  })

  it('libellés des 14 modules présents en FR et EN (platform.json)', () => {
    const fr = JSON.parse(read('i18n', 'locales', 'fr', 'platform.json')) as Record<string, unknown>
    const en = JSON.parse(read('i18n', 'locales', 'en', 'platform.json')) as Record<string, unknown>
    for (const dict of [fr, en]) {
      const modules = dict['modules'] as { items?: Record<string, unknown> } | undefined
      expect(modules?.items).toBeDefined()
      for (const key of API_MODULE_KEYS) {
        expect(modules?.items?.[key], `libellé manquant pour ${key}`).toBeDefined()
      }
    }
  })

  it('les JSON i18n ne contiennent pas de BOM (piège Vite/PowerShell)', () => {
    for (const lang of ['fr', 'en']) {
      for (const ns of ['dg.json', 'platform.json', 'nav.json']) {
        const raw = read('i18n', 'locales', lang, ns)
        expect(raw.charCodeAt(0), `${lang}/${ns} commence par un BOM`).not.toBe(0xFEFF)
      }
    }
  })
})
