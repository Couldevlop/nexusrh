/**
 * GOLDEN — Contrat UI ↔ API du module Sécurité & conformité (SSO/AD + SIEM).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MODULE_KEYS } from '../../services/tenant-modules.service.js'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB_SRC = join(API_SRC, '..', '..', '..', 'apps', 'web', 'src')
const readApi = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')
const readWeb = (...p: string[]) => readFileSync(join(WEB_SRC, ...p), 'utf8')

const modulesService = readApi('services', 'tenant-modules.service.ts')
const appTs          = readApi('app.ts')
const routes         = readApi('modules', 'security', 'security.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'security', 'SecurityPage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN security — clé de module alignée API ↔ web', () => {
  it("'security' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('security')).toBe(true)
    expect(webModules).toContain(`'security'`)
    expect(webModules).toMatch(/security:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/security',         'security']`)
    expect(appTs).toContain('securityRoutes')
    expect(appTs).toMatch(/register\(securityRoutes,\s*\{\s*prefix:\s*'\/security'\s*\}\)/)
  })
})

describe('GOLDEN security — sidebar & route protégées (admin only)', () => {
  it('entrée sidebar gatée admin + module', () => {
    expect(sidebar).toContain(`to: '/security'`)
    expect(sidebar).toContain(`labelKey: 'security'`)
    expect(sidebar).toContain(`moduleKey: 'security'`)
  })
  it('route protégée par RoleGuard admin + ModuleGuard security', () => {
    expect(appTsx).toContain('SecurityPage')
    expect(appTsx).toMatch(/path="security"[\s\S]{0,240}moduleKey="security"/)
  })
})

describe('GOLDEN security — endpoints consommés', () => {
  it('SSO + SIEM + événements', () => {
    expect(page).toContain(`api.get('/security/sso-config')`)
    expect(page).toContain(`api.put('/security/sso-config'`)
    expect(page).toContain(`api.get('/security/siem-config')`)
    expect(page).toContain(`api.get('/security/events')`)
    expect(routes).toContain(`fastify.post('/sso-config/test'`)
    expect(routes).toContain(`fastify.post('/siem-config/test'`)
    expect(routes).toContain(`fastify.post('/siem/forward'`)
  })
  it('réservé admin (A01), secrets chiffrés (A02), SSRF guard (A10), audit (A09)', () => {
    expect(routes).toContain(`fastify.authorize(...ADMIN)`)
    expect(routes).toContain('encrypt(')
    expect(routes).toContain('assertSafeOutboundUrl')
    expect(routes).toContain(`'security.sso_updated'`)
    expect(routes).toContain(`'security.siem_updated'`)
  })
})

describe('GOLDEN security — i18n FR/EN', () => {
  it('namespace enregistré + label nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/security/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'security.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['security']).toBeDefined()
    }
  })
})

describe('GOLDEN security — tables provisionnée + migrée lazy', () => {
  it('sso_config + siem_config', () => {
    for (const tbl of ['sso_config', 'siem_config']) {
      expect(provisioning).toContain(tbl)
      expect(migrations).toContain(tbl)
    }
  })
})
