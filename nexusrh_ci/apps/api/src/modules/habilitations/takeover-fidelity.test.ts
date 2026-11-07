/**
 * Invariant de la reprise d'office : le jour où un tenant est activé
 * (habilitations_enforced), l'accès de hr_manager, hr_officer et raf_site ne
 * change PAS, route par route.
 *
 * On construit l'application réelle (buildApp), on lit les rôles de chaque
 * `authorize()` (app.authorizedRoutes) et on compare, pour chacun des trois
 * rôles :
 *   - accès d'aujourd'hui  : le rôle figure dans `authorize(...)` ;
 *   - accès après reprise  : la case (fonction, action) résolue par
 *     `resolveRoutePermission` figure dans les droits écrits par la reprise
 *     (`takeoverPermissions`).
 *
 * GAIN  (accès après reprise, pas aujourd'hui) : interdit, sauf liste ci-dessous.
 * PERTE (accès aujourd'hui, pas après)         : tolérée seulement sur une route
 *   self-service (le rôle `employee` y est admis : l'utilisateur y passe en tant
 *   qu'employé, cf. plugins/auth.ts), sauf liste ci-dessous.
 * Une nouvelle route RH dont la case donne un gain ou une perte fait échouer ce
 * test : il faut alors remapper la route (route-permissions.ts) ou l'arbitrer
 * ici, avec une justification d'une ligne.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.hoisted(() => {
  process.env.NODE_ENV     = 'test'
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.JWT_SECRET   = 'takeover-fidelity-secret-minimum-32-chars!!'
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

import { buildApp } from '../../app.js'
import { resolveRoutePermission } from './route-permissions.js'
import { takeoverPermissions, type BootstrapRole } from '../../db/habilitations-bootstrap.js'

const ROLES: BootstrapRole[] = ['hr_manager', 'hr_officer', 'raf_site']

/** Écarts arbitrés. Clé : `<rôle> <MÉTHODE> <url>` ; valeur : justification d'une ligne. */
const GAIN_ALLOWLIST: Readonly<Record<string, string>> = {}
const LOSS_ALLOWLIST: Readonly<Record<string, string>> = {}

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
}, 120_000)
afterAll(async () => { await app.close() })

function diff(role: BootstrapRole): { gains: string[]; losses: string[]; selfService: string[] } {
  const perms = new Set(takeoverPermissions(role))
  const gains: string[] = []
  const losses: string[] = []
  const selfService: string[] = []
  const seen = new Set<string>()
  for (const r of app.authorizedRoutes) {
    // authorize() ne consulte la grille que si la route admet un rôle RH.
    if (!r.roles.some((x) => (ROLES as string[]).includes(x))) continue
    const key = `${role} ${r.method} ${r.url}`
    if (seen.has(key)) continue
    seen.add(key)
    const today = r.roles.includes(role)
    const perm = resolveRoutePermission(r.method, r.url)
    const after = perm !== null && perms.has(`${perm.fn}:${perm.action}`)
    if (after && !today) gains.push(key)
    if (today && !after) (r.roles.includes('employee') ? selfService : losses).push(key)
  }
  return { gains, losses, selfService }
}

describe('Reprise d\'office : accès inchangé route par route', () => {
  for (const role of ROLES) {
    it(`${role} : aucun gain d'accès hors liste arbitrée`, () => {
      const unexpected = diff(role).gains.filter((k) => !(k in GAIN_ALLOWLIST))
      expect(unexpected).toEqual([])
    })
    it(`${role} : aucune perte hors self-service ni liste arbitrée`, () => {
      const unexpected = diff(role).losses.filter((k) => !(k in LOSS_ALLOWLIST))
      expect(unexpected).toEqual([])
    })
  }

  it('le test voit bien les routes (garde contre un faux vert)', () => {
    expect(app.authorizedRoutes.length).toBeGreaterThan(300)
    // Les pertes tolérées (self-service) existent bel et bien pour le RAF.
    expect(diff('raf_site').selfService.length).toBeGreaterThan(0)
  })

  it('les listes arbitrées ne contiennent aucune entrée périmée', () => {
    const allGains = new Set(ROLES.flatMap((r) => diff(r).gains))
    const allLosses = new Set(ROLES.flatMap((r) => diff(r).losses))
    for (const k of Object.keys(GAIN_ALLOWLIST)) expect(allGains.has(k), `gain périmé : ${k}`).toBe(true)
    for (const k of Object.keys(LOSS_ALLOWLIST)) expect(allLosses.has(k), `perte périmée : ${k}`).toBe(true)
  })

  it('séparation des tâches : un RAF ne valide, n\'approuve, ni ne clôture la paie multi-filiales', () => {
    const raf = new Set(takeoverPermissions('raf_site'))
    for (const [method, url] of [
      ['POST', '/payroll-workflow/periods/:id/validate-central'],
      ['POST', '/payroll-workflow/periods/:id/approve'],
      ['POST', '/payroll-workflow/periods/:id/reject'],
      ['POST', '/payroll-workflow/periods/:id/close'],
      ['POST', '/payroll-workflow/periods/:id/cancel'],
    ] as const) {
      const p = resolveRoutePermission(method, url)
      expect(p, `${method} ${url}`).not.toBeNull()
      expect(raf.has(`${p!.fn}:${p!.action}`), `${method} ${url}`).toBe(false)
    }
    // …mais il saisit et soumet ses variables.
    for (const [method, url] of [
      ['PUT', '/payroll-workflow/periods/:id/variables/:employeeId'],
      ['POST', '/payroll-workflow/periods/:id/submit-by-raf'],
    ] as const) {
      const p = resolveRoutePermission(method, url)!
      expect(raf.has(`${p.fn}:${p.action}`), `${method} ${url}`).toBe(true)
    }
  })

  it('HEAD se résout comme GET (routes exactes comprises)', () => {
    expect(resolveRoutePermission('HEAD', '/sage/config')).toEqual(resolveRoutePermission('GET', '/sage/config'))
  })
})
