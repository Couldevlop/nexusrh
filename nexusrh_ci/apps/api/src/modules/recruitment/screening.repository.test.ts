/**
 * Dépôt d'accès aux données du pré-tri.
 *
 * Le schéma est reçu à la construction et validé une fois : l'isolation
 * multi-tenant devient une propriété du dépôt, pas une discipline d'appelant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
}))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
  },
}))

import { screeningRepo } from './screening.repository.js'

const JOB = '11111111-1111-4111-8111-111111111111'
const APP = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  queryMock.mockClear()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('screeningRepo — isolation', () => {
  it('cloisonne toutes ses requêtes dans le schéma reçu à la construction', async () => {
    const repo = screeningRepo('tenant_sotra')
    await repo.getQuestions(JOB)
    await repo.getCriteria(JOB)
    await repo.listPending(JOB)
    await repo.queue(JOB, 20, 0)
    await repo.getVerdict(APP)
    await repo.saveVerdict(APP, 'pass', [])
    await repo.decide(APP, 'kept', null, USER)

    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(7)
    for (const call of queryMock.mock.calls) {
      expect(String(call[0])).toContain('"tenant_sotra".')
    }
  })

  it('refuse un nom de schéma non conforme, avant toute requête', () => {
    expect(() => screeningRepo('tenant"; DROP SCHEMA public; --')).toThrow(/non conforme/i)
    expect(() => screeningRepo('')).toThrow()
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('screeningRepo — file de revue', () => {
  it('ne renvoie que les dossiers SANS décision humaine', async () => {
    await screeningRepo('tenant_sotra').queue(JOB, 20, 0)
    expect(String(queryMock.mock.calls[0]![0])).toMatch(/screening_decision IS NULL/)
  })

  it('ne remonte jamais le binaire du CV, seulement le drapeau', async () => {
    await screeningRepo('tenant_sotra').queue(JOB, 20, 0)
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toMatch(/\(cv_blob IS NOT NULL\) AS has_cv/)
    // Aucune sélection du binaire lui-même.
    expect(sql).not.toMatch(/SELECT[^;]*\bcv_blob\s*,/)
  })

  it('présente les dossiers conformes avant les signalés', async () => {
    await screeningRepo('tenant_sotra').queue(JOB, 20, 0)
    expect(String(queryMock.mock.calls[0]![0]))
      .toMatch(/ORDER BY \(screening_verdict = 'flagged'\)/)
  })
})

describe('screeningRepo — décision', () => {
  it('retenir place la candidature au stage `screening`', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: APP, screening_verdict: 'pass' }] })
    await screeningRepo('tenant_sotra').decide(APP, 'kept', 'motif', USER)
    expect(queryMock.mock.calls[0]![1]).toContain('screening')
  })

  it('écarter place la candidature au stage `rejected`', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: APP, screening_verdict: 'flagged' }] })
    await screeningRepo('tenant_sotra').decide(APP, 'dismissed', 'motif', USER)
    expect(queryMock.mock.calls[0]![1]).toContain('rejected')
  })

  it('ne peut pas trancher deux fois le même dossier', async () => {
    // La garde est dans le SQL : une candidature déjà décidée ne matche plus.
    await screeningRepo('tenant_sotra').decide(APP, 'kept', null, USER)
    expect(String(queryMock.mock.calls[0]![0])).toMatch(/AND screening_decision IS NULL/)
  })

  it('renvoie null quand rien n’a été mis à jour', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const r = await screeningRepo('tenant_sotra').decide(APP, 'kept', null, USER)
    expect(r).toBeNull()
  })

  it('trace l’auteur et l’horodatage de la décision', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: APP, screening_verdict: 'pass' }] })
    await screeningRepo('tenant_sotra').decide(APP, 'kept', 'dérogation motivée', USER)
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toMatch(/screening_decided_by = \$/)
    expect(sql).toMatch(/screening_decided_at = now\(\)/)
    expect(queryMock.mock.calls[0]![1]).toContain(USER)
  })
})

describe('screeningRepo — questions', () => {
  it('normalise ce qui vient de la base (jsonb libre)', async () => {
    queryMock.mockResolvedValue({
      rows: [{ screening_questions: [
        { id: 'q1', label: 'Permis B ?', type: 'boolean', required: true, knockout: true },
        { id: 'q2', label: 'Inconnu', type: 'date', required: true, knockout: false },
      ] }],
    })
    const out = await screeningRepo('tenant_sotra').getQuestions(JOB)
    expect(out).toHaveLength(1)          // le type inconnu est écarté
    expect(out[0]!.knockout).toBe(false) // knockout sans règle → informatif
  })

  it('setQuestions renvoie false si l’offre n’existe pas', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    expect(await screeningRepo('tenant_sotra').setQuestions(JOB, [])).toBe(false)
  })
})
