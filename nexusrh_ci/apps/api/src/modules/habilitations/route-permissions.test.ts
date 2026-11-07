/**
 * Table route → permission de la grille d'habilitations.
 *
 * Deux niveaux :
 *  1. règles unitaires de `resolveRoutePermission` (préfixe, verbe, suffixes) ;
 *  2. invariant sur l'application réelle (`buildApp()`) : toute route dont
 *     l'`authorize()` admet un rôle RH (hr_manager, hr_officer, raf_site) se
 *     résout en une case VALIDE de la grille. Une nouvelle route RH sans
 *     correspondance ferait échouer ce test (elle serait refusée à tout
 *     utilisateur habilité).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'route-permissions-secret-minimum-32-chars!!'
  process.env.LOG_LEVEL    = 'silent'
})

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
}))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn(), connect: vi.fn() })),
}))
vi.mock('../../services/redis.js', () => ({
  redis:              { quit: vi.fn(), disconnect: vi.fn() },
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch:      vi.fn().mockResolvedValue(0),
  setTokenEpoch:      vi.fn().mockResolvedValue(undefined),
  consumeTotpStep:    vi.fn().mockResolvedValue(true),
}))

import { EXACT_ROUTES, HR_GRID_ROLES, resolveRoutePermission } from './route-permissions.js'
import { isPermission } from './catalog.js'
import { buildApp } from '../../app.js'

describe('resolveRoutePermission — règles', () => {
  it('clôture de période de paie → payroll:close', () => {
    expect(resolveRoutePermission('POST', '/payroll/periods/:id/close')).toEqual({ fn: 'payroll', action: 'close' })
  })
  it('export employés → employees:export', () => {
    expect(resolveRoutePermission('GET', '/employees/export')).toEqual({ fn: 'employees', action: 'export' })
    expect(resolveRoutePermission('GET', '/employees/export.csv')).toEqual({ fn: 'employees', action: 'export' })
  })
  it('module inconnu → null', () => {
    expect(resolveRoutePermission('GET', '/unknown-module')).toBeNull()
    expect(resolveRoutePermission('GET', '')).toBeNull()
  })
  it('verbe HTTP → action', () => {
    expect(resolveRoutePermission('GET', '/employees/:id')).toEqual({ fn: 'employees', action: 'view' })
    expect(resolveRoutePermission('HEAD', '/employees/:id')).toEqual({ fn: 'employees', action: 'view' })
    expect(resolveRoutePermission('POST', '/employees')).toEqual({ fn: 'employees', action: 'create' })
    expect(resolveRoutePermission('PUT', '/employees/:id')).toEqual({ fn: 'employees', action: 'update' })
    expect(resolveRoutePermission('PATCH', '/employees/:id')).toEqual({ fn: 'employees', action: 'update' })
    expect(resolveRoutePermission('DELETE', '/employees/:id')).toEqual({ fn: 'employees', action: 'delete' })
  })
  it('préfixe de module (le plus long gagne)', () => {
    expect(resolveRoutePermission('GET', '/payroll-workflow/periods')?.fn).toBe('payroll_multi')
    expect(resolveRoutePermission('GET', '/cnps/declarations')?.fn).toBe('declarations')
    expect(resolveRoutePermission('GET', '/bank-transfer/preview')?.fn).toBe('payments')
    expect(resolveRoutePermission('GET', '/mobile-money/payments')?.fn).toBe('payments')
    expect(resolveRoutePermission('GET', '/onboarding/journeys')?.fn).toBe('lifecycle')
    expect(resolveRoutePermission('GET', '/offboarding')?.fn).toBe('lifecycle')
    expect(resolveRoutePermission('GET', '/org-chart/departments')?.fn).toBe('reporting')
    expect(resolveRoutePermission('GET', '/dg/overview')?.fn).toBe('reporting')
    expect(resolveRoutePermission('GET', '/reporting/overview')?.fn).toBe('reporting')
    expect(resolveRoutePermission('GET', '/classification/levels')?.fn).toBe('hr_settings')
    expect(resolveRoutePermission('GET', '/interview-sim')?.fn).toBe('recruitment')
    expect(resolveRoutePermission('GET', '/contracts/signed/employee/:employeeId')?.fn).toBe('contracts')
  })
  it('export SAGE → payroll:configure (réservé DRH : le gestionnaire RH n\'y accède pas aujourd\'hui)', () => {
    expect(resolveRoutePermission('GET', '/sage/export/payroll.csv')).toEqual({ fn: 'payroll', action: 'configure' })
  })
  it('suffixes : validation, soumission, envoi, paramétrage', () => {
    expect(resolveRoutePermission('POST', '/expenses/:id/approve')?.action).toBe('validate')
    expect(resolveRoutePermission('POST', '/absences/:id/reject')?.action).toBe('validate')
    expect(resolveRoutePermission('POST', '/payroll-workflow/periods/:id/submit')).toEqual({ fn: 'payroll_multi', action: 'close' })
    expect(resolveRoutePermission('POST', '/bank-transfer/send')).toEqual({ fn: 'payments', action: 'pay' })
    expect(resolveRoutePermission('PUT', '/sage/config')).toEqual({ fn: 'payroll', action: 'configure' })
  })
  it('exceptions et motifs : proposition de contrat, paiement, RAF, dépôt CNPS', () => {
    expect(resolveRoutePermission('PUT', '/recruitment/applications/:id/contract-proposal')).toEqual({ fn: 'contracts', action: 'update' })
    expect(resolveRoutePermission('POST', '/mobile-money/campaigns/:reference/execute')).toEqual({ fn: 'payments', action: 'pay' })
    // RAF : soumettre = « Modifier » (jamais « Valider » : séparation des tâches, arbitrage 04/11).
    expect(resolveRoutePermission('POST', '/payroll-workflow/periods/:id/submit-by-raf')).toEqual({ fn: 'payroll_multi', action: 'update' })
    expect(resolveRoutePermission('POST', '/payroll-workflow/periods/:id/validate-central')).toEqual({ fn: 'payroll_multi', action: 'create' })
    expect(resolveRoutePermission('POST', '/cnps/declarations/:id/submit')).toEqual({ fn: 'declarations', action: 'close' })
    expect(resolveRoutePermission('POST', '/ai/chat')).toEqual({ fn: 'reporting', action: 'view' })
    expect(resolveRoutePermission('PATCH', '/settings/payroll-rules/:id')).toEqual({ fn: 'hr_settings', action: 'update' })
    expect(resolveRoutePermission('PATCH', '/expenses/:id/pay')).toEqual({ fn: 'payments', action: 'pay' })
    expect(resolveRoutePermission('PUT', '/attendance/config')).toEqual({ fn: 'hr_settings', action: 'configure' })
    expect(resolveRoutePermission('PUT', '/interview-sim/config')).toEqual({ fn: 'hr_settings', action: 'configure' })
    expect(resolveRoutePermission('PUT', '/bank-transfer/templates/:id')).toEqual({ fn: 'payroll', action: 'configure' })
    expect(resolveRoutePermission('PUT', '/bank-transfer/directory')).toEqual({ fn: 'payroll', action: 'configure' })
    expect(resolveRoutePermission('GET', '/bank-transfer/templates')).toEqual({ fn: 'payroll', action: 'view' })
    expect(resolveRoutePermission('DELETE', '/offboarding/:id')).toEqual({ fn: 'lifecycle', action: 'delete' })
    expect(resolveRoutePermission('DELETE', '/signature/requests/:id')).toEqual({ fn: 'signature', action: 'delete' })
    expect(resolveRoutePermission('DELETE', '/attendance/devices/:id')).toEqual({ fn: 'attendance', action: 'delete' })
  })
  it('un GET n\'est jamais une écriture (config consultée = view)', () => {
    expect(resolveRoutePermission('GET', '/bank-transfer/templates')).toEqual({ fn: 'payroll', action: 'view' })
  })
  it('pas de repli : une action absente de la grille ne se résout pas', () => {
    // hr_settings n'a pas « Créer » : sans entrée explicite, aucune case.
    expect(resolveRoutePermission('POST', '/settings/leave-policy')).toBeNull()
    // Exception explicite : créer un département = paramétrer.
    expect(resolveRoutePermission('POST', '/settings/departments')).toEqual({ fn: 'hr_settings', action: 'configure' })
    // La paie n'a pas « Supprimer ».
    expect(resolveRoutePermission('DELETE', '/payroll/periods/:month')).toBeNull()
  })
  it('export seulement en lecture : une écriture sur /export garde son action', () => {
    expect(resolveRoutePermission('GET', '/cnps/rns/:year/export')?.action).toBe('export')
    expect(resolveRoutePermission('POST', '/bank-transfer/export/send')).toEqual({ fn: 'payments', action: 'pay' })
  })
  it('HR_GRID_ROLES', () => {
    expect(HR_GRID_ROLES).toEqual(['hr_manager', 'hr_officer', 'raf_site'])
  })
})

describe('invariant — chaque route RH de buildApp() a une case de grille', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('les routes authorize() sont recensées', () => {
    expect(app.authorizedRoutes.length).toBeGreaterThan(100)
  })

  it('chaque entrée de EXACT_ROUTES correspond à une route réelle', () => {
    const registered = new Set(app.authorizedRoutes.map((r) => `${r.method} ${r.url}`))
    const stale = Object.keys(EXACT_ROUTES).filter((k) => !registered.has(k))
    expect(stale).toEqual([])
  })

  it('aucune route RH sans correspondance valide', () => {
    const hrRoles = new Set<string>(HR_GRID_ROLES)
    const hrRoutes = app.authorizedRoutes.filter((r) => r.roles.some((role) => hrRoles.has(role)))
    expect(hrRoutes.length).toBeGreaterThan(100)
    const missing = hrRoutes
      .filter((r) => {
        const p = resolveRoutePermission(r.method, r.url)
        return p === null || !isPermission(`${p.fn}:${p.action}`)
      })
      .map((r) => `${r.method} ${r.url}`)
    expect(missing).toEqual([])
  })
})
