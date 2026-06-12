/**
 * GOLDEN — IA hybride interne/externe (tool use Anthropic).
 *
 * Exigence produit : l'assistant IA répond à la fois aux questions INTERNES
 * (« la DRH a-t-elle validé la paie ? », « combien d'absents aujourd'hui ? »,
 * « quel employé est à surveiller ? ») via des outils de lecture des données
 * du tenant, ET aux questions EXTERNES (« comment booster mes équipes en tant
 * que DG/DRH ? ») via son expertise générale.
 *
 * Invariants verrouillés :
 *  1. Matrice rôle → outils alignée sur le RBAC modules (un manager n'obtient
 *     pas la paie ni le scoring rétention ; employee/readonly : aucun outil).
 *  2. Defense in depth : executeAiTool re-vérifie le rôle même si le modèle
 *     hallucinait un appel non listé (OWASP A01).
 *  3. Managers : agrégats SANS liste nominative (périmètre limité à l'équipe).
 *  4. Fail-soft : une erreur DB renvoie { error } à l'IA, jamais un 500.
 *  5. Route /ai/chat : boucle tool_use bornée (anti-boucle), rôle dg admis,
 *     outils appelés tracés dans l'audit log (OWASP A09).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildToolsForRole, executeAiTool } from './ai-tools.js'
import type { Pool } from 'pg'

const DIR = dirname(fileURLToPath(import.meta.url))
const aiRoutes = readFileSync(join(DIR, 'ai.routes.ts'), 'utf8')

const ALL_TOOL_NAMES = [
  'get_payroll_status', 'count_absences_today', 'get_pending_requests',
  'get_headcount', 'get_employees_at_risk', 'get_recruitment_pipeline',
]

function fakePool(rows: unknown[] = []): Pool {
  return { query: () => Promise.resolve({ rows }) } as unknown as Pool
}

describe('GOLDEN IA hybride — matrice rôle → outils (alignée RBAC)', () => {
  it('admin, hr_manager et dg disposent de TOUS les outils internes', () => {
    for (const role of ['admin', 'hr_manager', 'dg']) {
      expect(buildToolsForRole(role).map(t => t.name).sort()).toEqual([...ALL_TOOL_NAMES].sort())
    }
  })

  it('hr_officer : pas de scoring rétention (réservé admin/hr_manager/dg)', () => {
    const names = buildToolsForRole('hr_officer').map(t => t.name)
    expect(names).not.toContain('get_employees_at_risk')
    expect(names).toContain('get_payroll_status')
  })

  it('manager : ni paie, ni scoring rétention, ni recrutement (RBAC modules)', () => {
    const names = buildToolsForRole('manager').map(t => t.name).sort()
    expect(names).toEqual(['count_absences_today', 'get_headcount', 'get_pending_requests'])
  })

  it('employee / readonly / inconnu : AUCUN outil interne', () => {
    expect(buildToolsForRole('employee')).toEqual([])
    expect(buildToolsForRole('readonly')).toEqual([])
    expect(buildToolsForRole('super_admin')).toEqual([])
    expect(buildToolsForRole('hacker')).toEqual([])
  })
})

describe('GOLDEN IA hybride — executeAiTool (defense in depth, OWASP A01)', () => {
  it('refuse un outil hors matrice même si le modèle le demandait', async () => {
    const r = await executeAiTool(fakePool(), { schemaName: 'tenant_x', role: 'manager' }, 'get_payroll_status', {})
    expect(r['error']).toBeDefined()
    const r2 = await executeAiTool(fakePool(), { schemaName: 'tenant_x', role: 'employee' }, 'get_headcount', {})
    expect(r2['error']).toBeDefined()
  })

  it('refuse un outil inconnu', async () => {
    const r = await executeAiTool(fakePool(), { schemaName: 'tenant_x', role: 'admin' }, 'drop_database', {})
    expect(r['error']).toBeDefined()
  })

  it('manager : agrégats SANS liste nominative (absents du jour)', async () => {
    const rows = [{ first_name: 'Awa', last_name: 'Koné', type_name: 'CP', start_date: '2026-06-12', end_date: '2026-06-12' }]
    const r = await executeAiTool(fakePool(rows), { schemaName: 'tenant_x', role: 'manager' }, 'count_absences_today', {})
    expect(r['absentToday']).toBe(1)
    expect(r['details']).toBeUndefined()
  })

  it('admin/dg : détail nominatif inclus (absents du jour)', async () => {
    const rows = [{ first_name: 'Awa', last_name: 'Koné', type_name: 'CP', start_date: '2026-06-12', end_date: '2026-06-12' }]
    for (const role of ['admin', 'dg']) {
      const r = await executeAiTool(fakePool(rows), { schemaName: 'tenant_x', role }, 'count_absences_today', {})
      expect(r['absentToday']).toBe(1)
      expect(Array.isArray(r['details'])).toBe(true)
    }
  })

  it('statut paie : closed = validée, avec le nom du valideur', async () => {
    const rows = [{
      month: '2026-05', status: 'closed', closed_at: '2026-06-05T10:00:00Z',
      total_gross: '45000000', total_net: '38000000', closed_by_name: 'Responsable Paie',
    }]
    const r = await executeAiTool(fakePool(rows), { schemaName: 'tenant_x', role: 'dg' }, 'get_payroll_status', { month: '2026-05' })
    const periods = r['periods'] as Array<Record<string, unknown>>
    expect(periods[0]?.['validated']).toBe(true)
    expect(periods[0]?.['closedBy']).toBe('Responsable Paie')
    expect(periods[0]?.['totalNetFcfa']).toBe(38000000)
  })

  it('fail-soft : erreur DB → { error }, jamais une exception (pas de 500)', async () => {
    const failing = { query: () => Promise.reject(new Error('db down')) } as unknown as Pool
    const r = await executeAiTool(failing, { schemaName: 'tenant_x', role: 'admin' }, 'get_headcount', {})
    expect(r['error']).toBeDefined()
  })

  it('mois invalide ignoré (OWASP A03 — pas d\'injection via input outil)', async () => {
    let captured: unknown[] = []
    const spyPool = {
      query: (_sql: string, params?: unknown[]) => {
        captured = params ?? []
        return Promise.resolve({ rows: [] })
      },
    } as unknown as Pool
    await executeAiTool(spyPool, { schemaName: 'tenant_x', role: 'admin' }, 'get_payroll_status', { month: "'; DROP TABLE--" })
    expect(captured[0]).toBeNull() // input non conforme YYYY-MM → null paramétré
  })
})

describe('GOLDEN IA hybride — route /ai/chat', () => {
  it('le rôle dg a accès au chat IA', () => {
    expect(aiRoutes).toMatch(/fastify\.authorize\('admin', 'hr_manager', 'hr_officer', 'manager', 'dg'\)/)
  })

  it('les outils sont construits PAR RÔLE et passés au modèle', () => {
    expect(aiRoutes).toContain('buildToolsForRole(request.user.role)')
    expect(aiRoutes).toMatch(/tools\.length > 0 \? \{ tools \} : \{\}/)
  })

  it('boucle tool_use bornée (garde-fou anti-boucle infinie)', () => {
    expect(aiRoutes).toContain('MAX_TOOL_ROUNDS')
    expect(aiRoutes).toMatch(/stop_reason !== 'tool_use' \|\| rounds >= MAX_TOOL_ROUNDS/)
  })

  it('les résultats d\'outils repartent au modèle en tool_result', () => {
    expect(aiRoutes).toContain(`type: 'tool_result'`)
    expect(aiRoutes).toContain('tool_use_id: block.id')
  })

  it('les outils appelés sont audités (OWASP A09 — qui a interrogé quoi via l\'IA)', () => {
    expect(aiRoutes).toMatch(/auditLogAi\([\s\S]{0,500}toolsUsed/)
  })

  it('le system prompt couvre les DEUX familles de questions (internes + externes)', () => {
    expect(aiRoutes).toContain('QUESTIONS INTERNES')
    expect(aiRoutes).toContain('QUESTIONS EXTERNES')
    expect(aiRoutes).toContain('UTILISE LES OUTILS')
  })
})
