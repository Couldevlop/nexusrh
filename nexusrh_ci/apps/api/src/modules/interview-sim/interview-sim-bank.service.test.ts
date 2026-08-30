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
    expect(String(queryMock.mock.calls[0]![0])).toContain('platform.interview_sim_question_banks')
    expect(String(queryMock.mock.calls[0]![0])).toContain('ORDER BY created_at DESC')
  })
  it('renvoie null si banque vide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await readBank('inconnu', 'fr')).toBeNull()
  })
})

describe('feedBank', () => {
  it('insère un nouveau jeu (enrichit la banque) puis purge les jeux excédentaires', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    await feedBank('comptable', 'Finance', 'fr', ['Q1', 'Q2'], 'mistral')
    const [sql, params] = queryMock.mock.calls[0]!
    expect(String(sql)).toContain('INSERT INTO platform.interview_sim_question_banks')
    expect(params[0]).toBe('comptable')
    expect(params[3]).toBe(JSON.stringify(['Q1', 'Q2']))
    const [purgeSql, purgeParams] = queryMock.mock.calls[1]!
    expect(String(purgeSql)).toContain('DELETE FROM platform.interview_sim_question_banks')
    expect(purgeParams).toEqual(['comptable', 'fr', 20])
  })
  it('ne fait rien si aucune question', async () => {
    await feedBank('comptable', null, 'fr', [], null)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('purge au-delà de 20 jeux : ne garde que les 20 plus récents par (role_key, langue)', async () => {
    interface FakeRow { id: string; role_key: string; langue: string; created_at: number }
    let table: FakeRow[] = []
    let seq = 0
    queryMock.mockImplementation((sql: string, params: unknown[]) => {
      const s = String(sql)
      if (s.includes('INSERT INTO platform.interview_sim_question_banks')) {
        seq += 1
        const [roleKey, , langue] = params as [string, string | null, string, string, string | null]
        table.push({ id: `id-${seq}`, role_key: roleKey, langue, created_at: seq })
        return Promise.resolve({ rows: [] })
      }
      if (s.includes('DELETE FROM platform.interview_sim_question_banks')) {
        const [roleKey, langue] = params as [string, string]
        const forKey = table
          .filter((r) => r.role_key === roleKey && r.langue === langue)
          .sort((a, b) => b.created_at - a.created_at)
        const keepIds = new Set(forKey.slice(0, 20).map((r) => r.id))
        table = table.filter((r) => !(r.role_key === roleKey && r.langue === langue) || keepIds.has(r.id))
        return Promise.resolve({ rows: [] })
      }
      return Promise.resolve({ rows: [] })
    })
    for (let i = 1; i <= 22; i++) {
      await feedBank('comptable', 'Finance', 'fr', [`Q${i}`], 'claude')
    }
    const remaining = table.filter((r) => r.role_key === 'comptable' && r.langue === 'fr')
    expect(remaining).toHaveLength(20)
    // Les 2 plus anciens jeux (seq 1 et 2) doivent avoir été purgés — restent 3..22
    expect(remaining.map((r) => r.created_at).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, idx) => idx + 3),
    )
  })

  it('n\'affecte pas un autre (role_key, langue) — purge scoping', async () => {
    interface FakeRow { id: string; role_key: string; langue: string; created_at: number }
    let table: FakeRow[] = []
    let seq = 0
    queryMock.mockImplementation((sql: string, params: unknown[]) => {
      const s = String(sql)
      if (s.includes('INSERT INTO platform.interview_sim_question_banks')) {
        seq += 1
        const [roleKey, , langue] = params as [string, string | null, string, string, string | null]
        table.push({ id: `id-${seq}`, role_key: roleKey, langue, created_at: seq })
        return Promise.resolve({ rows: [] })
      }
      if (s.includes('DELETE FROM platform.interview_sim_question_banks')) {
        const [roleKey, langue] = params as [string, string]
        const forKey = table
          .filter((r) => r.role_key === roleKey && r.langue === langue)
          .sort((a, b) => b.created_at - a.created_at)
        const keepIds = new Set(forKey.slice(0, 20).map((r) => r.id))
        table = table.filter((r) => !(r.role_key === roleKey && r.langue === langue) || keepIds.has(r.id))
        return Promise.resolve({ rows: [] })
      }
      return Promise.resolve({ rows: [] })
    })
    for (let i = 1; i <= 22; i++) {
      await feedBank('comptable', 'Finance', 'fr', [`Q${i}`], 'claude')
    }
    await feedBank('developpeur', 'Tech', 'fr', ['QX'], 'claude')
    const developpeur = table.filter((r) => r.role_key === 'developpeur')
    expect(developpeur).toHaveLength(1)
  })
})

describe('incrementUsage', () => {
  it('upsert le compteur anonyme', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await incrementUsage('comptable', 'fr')
    expect(String(queryMock.mock.calls[0]![0])).toContain('platform.interview_sim_usage')
    expect(String(queryMock.mock.calls[0]![0])).toContain('ON CONFLICT')
  })
})
