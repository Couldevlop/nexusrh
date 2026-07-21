import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('../../db/pool.js', () => ({ pool: { query: queryMock } }))

import {
  normalizeRoleKey,
  readBank,
  feedBank,
  incrementUsage,
} from './interview-sim-bank.service.js'

beforeEach(() => { queryMock.mockReset() })

describe('normalizeRoleKey', () => {
  it('normalise accents, casse et séparateurs en slug métier', () => {
    expect(normalizeRoleKey("Chargé d'Exploitation", 'Transport')).toBe('charge-d-exploitation-transport')
  })
  it('sans secteur, reste déterministe', () => {
    expect(normalizeRoleKey('Comptable')).toBe('comptable')
    expect(normalizeRoleKey('Comptable')).toBe(normalizeRoleKey('  COMPTABLE '))
  })
  it('repli sur poste-generique si vide', () => {
    expect(normalizeRoleKey('   ', null)).toBe('poste-generique')
  })
})

describe('readBank', () => {
  it('renvoie le dernier jeu de questions du métier', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ questions: ['Q1', 'Q2'], source_model: 'claude' }] })
    const entry = await readBank('comptable', 'fr')
    expect(entry).toEqual({ questions: ['Q1', 'Q2'], sourceModel: 'claude' })
    expect(String(queryMock.mock.calls[0][0])).toContain('platform.interview_sim_question_banks')
    expect(String(queryMock.mock.calls[0][0])).toContain('ORDER BY created_at DESC')
  })
  it('renvoie null si banque vide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await readBank('inconnu', 'fr')).toBeNull()
  })
})

describe('feedBank', () => {
  it('insère un nouveau jeu (enrichit la banque)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await feedBank('comptable', 'Finance', 'fr', ['Q1', 'Q2'], 'mistral')
    const [sql, params] = queryMock.mock.calls[0]
    expect(String(sql)).toContain('INSERT INTO platform.interview_sim_question_banks')
    expect(params[0]).toBe('comptable')
    expect(params[3]).toBe(JSON.stringify(['Q1', 'Q2']))
  })
  it('ne fait rien si aucune question', async () => {
    await feedBank('comptable', null, 'fr', [], null)
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('incrementUsage', () => {
  it('upsert le compteur anonyme', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await incrementUsage('comptable', 'fr')
    expect(String(queryMock.mock.calls[0][0])).toContain('platform.interview_sim_usage')
    expect(String(queryMock.mock.calls[0][0])).toContain('ON CONFLICT')
  })
})
