/**
 * COVERAGE — onboarding.service (logique métier partagée).
 *
 * Couvre les fonctions impliquant la DB (Pool mocké) que le golden n'exerce
 * pas : startOnboardingJourney (modèle vide / avec étapes), autoStartOnboarding
 * (doublon / aucun modèle / création), refreshJourneyStatus, et les branches
 * restantes de selectBestTemplate / computeDueDate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'

vi.mock('../config.js', () => ({
  config: { env: 'test', database: { url: 'postgresql://test' } },
}))

import {
  selectBestTemplate,
  computeDueDate,
  startOnboardingJourney,
  autoStartOnboarding,
  refreshJourneyStatus,
  type OnboardingTemplateRow,
  type EmployeeForOnboarding,
} from './onboarding.service.js'

const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

const EMP: EmployeeForOnboarding = {
  id: 'emp1', job_title: 'Chauffeur', job_level: 'junior',
  department_id: 'dep1', hire_date: '2026-06-15',
}

beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }) })

// ─── selectBestTemplate — branches restantes ─────────────────────────────────
describe('selectBestTemplate — branches additionnelles', () => {
  const tpl = (over: Partial<OnboardingTemplateRow>): OnboardingTemplateRow => ({
    id: 't', name: 'T', seniority: 'any', job_keywords: null, department_id: null,
    is_active: true, is_default: false, ...over,
  })

  it('séniorité null traitée comme "any" (+1)', () => {
    const best = selectBestTemplate(
      [tpl({ id: 'x', seniority: null as unknown as string })],
      { job_title: 'X', job_level: null, department_id: null },
    )
    expect(best?.id).toBe('x')
  })

  it('département identique ajoute du score', () => {
    const best = selectBestTemplate(
      [tpl({ id: 'nodept' }), tpl({ id: 'dept', department_id: 'dep1' })],
      { job_title: 'X', job_level: null, department_id: 'dep1' },
    )
    expect(best?.id).toBe('dept')
  })

  it('job_keywords null → aucun bonus mot-clé (ne plante pas)', () => {
    const best = selectBestTemplate(
      [tpl({ id: 'a', is_default: true, job_keywords: null })],
      { job_title: 'Quelconque', job_level: null, department_id: null },
    )
    expect(best?.id).toBe('a')
  })

  it('liste vide → null', () => {
    expect(selectBestTemplate([], { job_title: 'X', job_level: null, department_id: null })).toBeNull()
  })

  it('séniorité any mais job_level renseigné → +1 (pas +3)', () => {
    const best = selectBestTemplate(
      [tpl({ id: 'generic' })],
      { job_title: 'X', job_level: 'cadre', department_id: null },
    )
    expect(best?.id).toBe('generic')
  })
})

describe('computeDueDate — date invalide', () => {
  it('date non parsable → null', () => {
    expect(computeDueDate('pas-une-date', 5)).toBeNull()
  })
})

// ─── startOnboardingJourney ──────────────────────────────────────────────────
describe('startOnboardingJourney', () => {
  it('modèle sans étape → null (aucune insertion de parcours)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT template steps
    const id = await startOnboardingJourney(pool, 'tenant_sotra', EMP, { id: 'tpl1', name: 'M' }, 'creator')
    expect(id).toBeNull()
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('avec étapes → crée le parcours et insère chaque étape avec échéance calculée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [
        { title: 'A', description: 'd', phase: 'before_start', owner_role: 'hr', due_offset_days: -3, sort_order: 0, resources: [{ type: 'link', title: 'L', url: '' }] },
        { title: 'B', description: null, phase: 'day_one', owner_role: 'employee', due_offset_days: 0, sort_order: 1, resources: null },
      ] }) // SELECT steps
      .mockResolvedValueOnce({ rows: [{ id: 'journeyZ' }] }) // INSERT journey
      .mockResolvedValueOnce({ rows: [] }) // INSERT step 1
      .mockResolvedValueOnce({ rows: [] }) // INSERT step 2
    const id = await startOnboardingJourney(pool, 'tenant_sotra', EMP, { id: 'tpl1', name: 'Modèle' }, 'creator')
    expect(id).toBe('journeyZ')
    // échéance de la 1re étape : hire_date - 3 jours
    const step1 = queryMock.mock.calls[2]
    expect(step1?.[1]).toContain('2026-06-12')
    // resources null → fallback []
    const step2 = queryMock.mock.calls[3]
    expect(step2?.[1]?.[7]).toBe('[]')
  })

  it('createdBy null accepté', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [
        { title: 'A', description: 'd', phase: 'day_one', owner_role: 'hr', due_offset_days: 0, sort_order: 0, resources: [] },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: 'jNull' }] })
      .mockResolvedValueOnce({ rows: [] })
    const id = await startOnboardingJourney(pool, 'tenant_sotra', { ...EMP, hire_date: null }, { id: 'tpl', name: 'M' }, null)
    expect(id).toBe('jNull')
    // hire_date null → due_date null (param index 5)
    expect(queryMock.mock.calls[2]?.[1]?.[5]).toBeNull()
  })
})

// ─── autoStartOnboarding ─────────────────────────────────────────────────────
describe('autoStartOnboarding', () => {
  it('parcours actif déjà existant → null (pas de doublon)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // existing check
    const id = await autoStartOnboarding(pool, 'tenant_sotra', EMP, 'creator')
    expect(id).toBeNull()
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('aucun modèle applicable → null', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // no existing journey
      .mockResolvedValueOnce({ rows: [] }) // no active templates → selectBestTemplate → null
    const id = await autoStartOnboarding(pool, 'tenant_sotra', EMP, 'creator')
    expect(id).toBeNull()
    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it('modèle trouvé → délègue à startOnboardingJourney et retourne l\'id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // no existing journey
      .mockResolvedValueOnce({ rows: [
        { id: 'tplBest', name: 'Best', seniority: 'junior', job_keywords: 'chauffeur', department_id: 'dep1', is_active: true, is_default: true },
      ] }) // active templates
      .mockResolvedValueOnce({ rows: [
        { title: 'A', description: 'd', phase: 'day_one', owner_role: 'hr', due_offset_days: 0, sort_order: 0, resources: [] },
      ] }) // startOnboardingJourney SELECT steps
      .mockResolvedValueOnce({ rows: [{ id: 'journeyAuto' }] }) // INSERT journey
      .mockResolvedValueOnce({ rows: [] }) // INSERT step
    const id = await autoStartOnboarding(pool, 'tenant_sotra', EMP, 'creator')
    expect(id).toBe('journeyAuto')
  })
})

// ─── refreshJourneyStatus ────────────────────────────────────────────────────
describe('refreshJourneyStatus', () => {
  it('exécute la requête de recalcul avec le journeyId', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await refreshJourneyStatus(pool, 'tenant_sotra', 'jX')
    const call = queryMock.mock.calls[0]
    expect(String(call?.[0])).toContain('onboarding_journeys j')
    expect(call?.[1]).toEqual(['jX'])
  })
})
