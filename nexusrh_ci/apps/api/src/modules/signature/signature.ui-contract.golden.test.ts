/**
 * GOLDEN — Contrat UI ↔ API du module Signature électronique.
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
const routes         = readApi('modules', 'signature', 'signature.routes.ts')
const migrations     = readApi('utils', 'schema-migrations.ts')
const provisioning   = readApi('db', 'provisioning.ts')
const webModules     = readWeb('lib', 'modules.ts')
const sidebar        = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx         = readWeb('App.tsx')
const page           = readWeb('pages', 'signature', 'SignaturePage.tsx')
const i18nIndex      = readWeb('i18n', 'index.ts')

describe('GOLDEN signature — clé de module alignée API ↔ web', () => {
  it("'signature' clé canonique API + web (actif par défaut)", () => {
    expect((MODULE_KEYS as readonly string[]).includes('signature')).toBe(true)
    expect(webModules).toContain(`'signature'`)
    expect(webModules).toMatch(/signature:\s+true/)
  })
  it('mapping URL + enregistrement route', () => {
    expect(modulesService).toContain(`['/signature',        'signature']`)
    expect(appTs).toContain('signatureRoutes')
    expect(appTs).toMatch(/register\(signatureRoutes,\s*\{\s*prefix:\s*'\/signature'\s*\}\)/)
  })
})

describe('GOLDEN signature — sidebar & route protégées', () => {
  it('entrée sidebar gatée rôle + module', () => {
    expect(sidebar).toContain(`to: '/signature'`)
    expect(sidebar).toContain(`labelKey: 'signature'`)
    expect(sidebar).toContain(`moduleKey: 'signature'`)
  })
  it('route protégée par RoleGuard + ModuleGuard signature', () => {
    expect(appTsx).toContain('SignaturePage')
    expect(appTsx).toMatch(/path="signature"[\s\S]{0,240}moduleKey="signature"/)
  })
})

describe('GOLDEN signature — endpoints consommés', () => {
  it('demandes + envoi + signature self-service', () => {
    expect(page).toContain(`api.get('/signature/requests')`)
    expect(page).toContain(`api.get('/signature/my-requests')`)
    expect(page).toContain(`api.post('/signature/requests'`)
    expect(routes).toContain(`fastify.post('/requests/:id/send'`)
    expect(routes).toContain(`fastify.post('/requests/:id/sign'`)
    expect(routes).toContain(`fastify.post('/requests/:id/decline'`)
    expect(routes).toContain(`fastify.get('/my-requests'`)
  })
  it("employeeId par signataire : sélecteur web + Zod + INSERT employee_id (matching my-requests/sign)", () => {
    // Web : la page charge la liste des salariés et envoie employeeId par signataire
    expect(page).toContain(`api.get('/employees`)
    expect(page).toMatch(/employeeId:\s*s\.employeeId/)
    // API : le schéma Zod accepte employeeId et l'INSERT le persiste
    expect(routes).toMatch(/employeeId:\s*z\.string\(\)\.regex\(UUID_RE\)/)
    expect(routes).toContain('INSERT INTO "${schema}".signature_signatories (request_id, employee_id, name, email, order_index, status)')
    expect(routes).toMatch(/s\.employeeId\s*\?\?\s*null/)
    // API : my-requests et sign matchent bien par employee_id
    expect(routes).toContain('WHERE s.employee_id = $1')
    expect(routes).toContain('sigs.rows.find((s) => s.employee_id === empId)')
  })
  it('gestion réservée RH (A01) ; signature/refus audités (A09)', () => {
    expect(routes).toContain('WRITE_ROLES')
    expect(routes).toContain('MANAGE_ROLES')
    expect(routes).toContain(`'signature.signed'`)
    expect(routes).toContain(`'signature.declined'`)
  })
})

describe('GOLDEN signature — i18n FR/EN', () => {
  it('namespace enregistré + label nav, sans BOM', () => {
    expect(i18nIndex).toMatch(/signature/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'signature.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(readWeb('i18n', 'locales', lang, 'nav.json'))['signature']).toBeDefined()
    }
  })
})

describe('GOLDEN signature — tables provisionnée + migrée lazy', () => {
  it('signature_requests + signature_signatories', () => {
    for (const tbl of ['signature_requests', 'signature_signatories']) {
      expect(provisioning).toContain(tbl)
      expect(migrations).toContain(tbl)
    }
  })
})
