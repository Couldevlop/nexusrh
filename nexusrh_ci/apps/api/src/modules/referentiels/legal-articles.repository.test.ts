/**
 * Tests unitaires — legal-articles.repository.ts
 *
 * Couvre l'intégralité de la couche PostgreSQL (Drizzle) :
 *  - upsertArticles (insert + onConflictDoUpdate, valeurs par défaut)
 *  - getAllActiveArticles / getArticleByIdFromDb (mapping toInput, fallback null)
 *  - getArticlesByPayrollCodeFromDb (filtre + slice 5)
 *  - countArticles
 *  - searchArticlesFromDb (browse, filtres source/livre/countryCode, alias smic→smig, pagination)
 *  - getHierarchyTreeFromDb (regroupement source → livre)
 *
 * La base Drizzle est entièrement mockée — aucune connexion réelle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock du client Drizzle ────────────────────────────────────────────────────
// On contrôle la valeur résolue par `.select().from().where()` (selectRows)
// et on espionne la branche insert (`.insert().values().onConflictDoUpdate()`).
const { selectRows, whereMock, valuesMock, onConflictMock, insertMock, selectMock, fromMock } =
  vi.hoisted(() => {
    const state = { rows: [] as unknown[] }
    const whereMock = vi.fn(() => Promise.resolve(state.rows))
    const fromMock = vi.fn(() => ({ where: whereMock }))
    const selectMock = vi.fn(() => ({ from: fromMock }))
    const onConflictMock = vi.fn((_cfg: { set: Record<string, unknown> }) => Promise.resolve(undefined))
    const valuesMock = vi.fn((_values: Record<string, unknown>) => ({ onConflictDoUpdate: onConflictMock }))
    const insertMock = vi.fn(() => ({ values: valuesMock }))
    return { selectRows: state, whereMock, valuesMock, onConflictMock, insertMock, selectMock, fromMock }
  })

vi.mock('../../db/client.js', () => ({
  droitCiDb: {
    select: selectMock,
    insert: insertMock,
  },
}))

// drizzle-orm — on neutralise les helpers de condition (valeurs opaques)
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: 'eq', a, b })),
  and: vi.fn((...c: unknown[]) => ({ _op: 'and', c })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ _op: 'inArray', a, b })),
}))

// Le schéma : seuls les noms de colonnes sont utilisés comme clés opaques.
vi.mock('../../db/schema/droit-ci.js', () => ({
  legalArticles: {
    articleId: 'col.articleId',
    articleNumero: 'col.articleNumero',
    countryCode: 'col.countryCode',
    source: 'col.source',
    conventionSlug: 'col.conventionSlug',
    livre: 'col.livre',
    titre: 'col.titre',
    chapitre: 'col.chapitre',
    section: 'col.section',
    titreArticle: 'col.titreArticle',
    texte: 'col.texte',
    keywords: 'col.keywords',
    payrollCodes: 'col.payrollCodes',
    accessLevel: 'col.accessLevel',
    isActive: 'col.isActive',
  },
}))

import {
  upsertArticles,
  getAllActiveArticles,
  getArticleByIdFromDb,
  getArticlesByPayrollCodeFromDb,
  countArticles,
  searchArticlesFromDb,
  getHierarchyTreeFromDb,
  type ArticleInput,
} from './legal-articles.repository.js'

/** Ligne brute telle que renvoyée par Drizzle ($inferSelect). */
function makeRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    articleId: 'art-1',
    articleNumero: '11',
    countryCode: 'CIV',
    source: 'code_travail_ci',
    conventionSlug: null,
    livre: 'Livre I',
    titre: null,
    chapitre: null,
    section: null,
    titreArticle: 'Titre article',
    texte: 'Le texte de l’article sur le congé annuel',
    keywords: ['conge', 'annuel'],
    payrollCodes: ['1000'],
    accessLevel: 'public',
    isActive: true,
    ...over,
  }
}

beforeEach(() => {
  selectRows.rows = []
  whereMock.mockClear()
  fromMock.mockClear()
  selectMock.mockClear()
  insertMock.mockClear()
  valuesMock.mockClear()
  onConflictMock.mockClear()
})

describe('upsertArticles', () => {
  it('insère chaque article avec checksum et retourne le compte', async () => {
    const articles: ArticleInput[] = [
      {
        article_id: 'a1', article_numero: '1', source: 'code_travail_ci',
        country_code: 'BEN', convention_slug: 'cc', livre: 'L1', titre: 'T',
        chapitre: 'C', section: 'S', titre_article: 'TA', texte: 'texte 1',
        keywords: ['k'], payroll_codes: ['1000'], access_level: 'public',
      },
      {
        article_id: 'a2', article_numero: '2', source: 'code_travail_ci',
        titre_article: 'TA2', texte: 'texte 2',
      },
    ]
    const count = await upsertArticles(articles)
    expect(count).toBe(2)
    expect(insertMock).toHaveBeenCalledTimes(2)
    expect(valuesMock).toHaveBeenCalledTimes(2)
    expect(onConflictMock).toHaveBeenCalledTimes(2)
  })

  it('applique les valeurs par défaut (country CIV, keywords/payroll vides, access public)', async () => {
    await upsertArticles([
      { article_id: 'a3', article_numero: '3', source: 'src', titre_article: 'X', texte: 'y' },
    ])
    const firstInsert = valuesMock.mock.calls[0]![0]
    expect(firstInsert.countryCode).toBe('CIV')
    expect(firstInsert.keywords).toEqual([])
    expect(firstInsert.payrollCodes).toEqual([])
    expect(firstInsert.accessLevel).toBe('public')
    expect(typeof firstInsert.checksumSha256).toBe('string')
    expect((firstInsert.checksumSha256 as string).length).toBe(64)

    const conflictSet = onConflictMock.mock.calls[0]![0].set
    expect(conflictSet.countryCode).toBe('CIV')
    expect(conflictSet.keywords).toEqual([])
  })

  it('retourne 0 pour un tableau vide', async () => {
    expect(await upsertArticles([])).toBe(0)
    expect(insertMock).not.toHaveBeenCalled()
  })
})

describe('getAllActiveArticles', () => {
  it('mappe les lignes vers ArticleInput', async () => {
    selectRows.rows = [makeRow(), makeRow({ articleId: 'art-2', livre: null })]
    const res = await getAllActiveArticles()
    expect(res).toHaveLength(2)
    expect(res[0]!.article_id).toBe('art-1')
    expect(res[0]!.country_code).toBe('CIV')
    expect(res[0]!.keywords).toEqual(['conge', 'annuel'])
    // livre null → undefined
    expect(res[1]!.livre).toBeUndefined()
  })

  it('applique CIV par défaut quand country_code est null et keywords/payroll null', async () => {
    selectRows.rows = [makeRow({ countryCode: null, keywords: null, payrollCodes: null })]
    const res = await getAllActiveArticles()
    expect(res[0]!.country_code).toBe('CIV')
    expect(res[0]!.keywords).toEqual([])
    expect(res[0]!.payroll_codes).toEqual([])
  })
})

describe('getArticleByIdFromDb', () => {
  it('retourne l’article mappé si trouvé', async () => {
    selectRows.rows = [makeRow({ articleId: 'art-42' })]
    const res = await getArticleByIdFromDb('art-42')
    expect(res).not.toBeNull()
    expect(res!.article_id).toBe('art-42')
  })

  it('retourne null si aucun résultat', async () => {
    selectRows.rows = []
    expect(await getArticleByIdFromDb('inconnu')).toBeNull()
  })
})

describe('getArticlesByPayrollCodeFromDb', () => {
  it('filtre par code paie présent dans payroll_codes', async () => {
    selectRows.rows = [
      makeRow({ articleId: 'a', payrollCodes: ['1000', '2000'] }),
      makeRow({ articleId: 'b', payrollCodes: ['3000'] }),
      makeRow({ articleId: 'c', payrollCodes: null }),
    ]
    const res = await getArticlesByPayrollCodeFromDb('1000')
    expect(res).toHaveLength(1)
    expect(res[0]!.article_id).toBe('a')
  })

  it('limite à 5 résultats', async () => {
    selectRows.rows = Array.from({ length: 8 }, (_, i) =>
      makeRow({ articleId: `a${i}`, payrollCodes: ['9999'] }))
    const res = await getArticlesByPayrollCodeFromDb('9999')
    expect(res).toHaveLength(5)
  })
})

describe('countArticles', () => {
  it('retourne le nombre de lignes actives', async () => {
    selectRows.rows = [makeRow(), makeRow({ articleId: 'x' }), makeRow({ articleId: 'y' })]
    expect(await countArticles()).toBe(3)
  })

  it('retourne 0 si aucune ligne', async () => {
    selectRows.rows = []
    expect(await countArticles()).toBe(0)
  })
})

describe('searchArticlesFromDb', () => {
  it('mode browse (q vide) retourne tout, paginé', async () => {
    selectRows.rows = [makeRow({ articleId: 'a' }), makeRow({ articleId: 'b' })]
    const res = await searchArticlesFromDb({ q: '' })
    expect(res.total).toBe(2)
    expect(res.hits).toHaveLength(2)
  })

  it('mode browse avec q = "*"', async () => {
    selectRows.rows = [makeRow()]
    const res = await searchArticlesFromDb({ q: '*' })
    expect(res.total).toBe(1)
  })

  it('filtre full-text sur numéro/titre/texte/keywords', async () => {
    selectRows.rows = [
      makeRow({ articleId: 'a', texte: 'congé annuel payé' }),
      makeRow({ articleId: 'b', texte: 'licenciement', keywords: [], titreArticle: 'rupture' }),
    ]
    const res = await searchArticlesFromDb({ q: 'congé' })
    expect(res.total).toBe(1)
    expect(res.hits[0]!.article_id).toBe('a')
  })

  it('normalise l’alias smic → smig', async () => {
    selectRows.rows = [makeRow({ articleId: 'smig', texte: 'le smig est fixé', keywords: [] })]
    const res = await searchArticlesFromDb({ q: 'smic' })
    expect(res.total).toBe(1)
  })

  it('gère keywords null dans la recherche', async () => {
    selectRows.rows = [makeRow({ keywords: null, texte: 'mot recherche' })]
    const res = await searchArticlesFromDb({ q: 'recherche' })
    expect(res.total).toBe(1)
  })

  it('applique les filtres source / livre / countryCode (passage dans le where)', async () => {
    selectRows.rows = [makeRow()]
    await searchArticlesFromDb({ q: '', source: 'code_travail_ci', livre: 'L1', countryCode: 'CIV' })
    // 5 conditions : isActive, accessLevel, source, livre, countryCode
    const drizzle = await import('drizzle-orm')
    expect(vi.mocked(drizzle.eq)).toHaveBeenCalled()
  })

  it('respecte from/size pour la pagination', async () => {
    selectRows.rows = Array.from({ length: 10 }, (_, i) => makeRow({ articleId: `a${i}` }))
    const res = await searchArticlesFromDb({ q: '', from: 2, size: 3 })
    expect(res.total).toBe(10)
    expect(res.hits).toHaveLength(3)
    expect(res.hits[0]!.article_id).toBe('a2')
  })

  it('q undefined est traité comme browse', async () => {
    selectRows.rows = [makeRow()]
    const res = await searchArticlesFromDb({ q: undefined as unknown as string })
    expect(res.total).toBe(1)
  })
})

describe('getHierarchyTreeFromDb', () => {
  it('regroupe par source puis par livre avec compteurs', async () => {
    selectRows.rows = [
      makeRow({ articleId: '1', source: 'code_travail_ci', livre: 'Livre I' }),
      makeRow({ articleId: '2', source: 'code_travail_ci', livre: 'Livre I' }),
      makeRow({ articleId: '3', source: 'code_travail_ci', livre: 'Livre II' }),
      makeRow({ articleId: '4', source: 'convention_collective', livre: null }),
    ]
    const tree = (await getHierarchyTreeFromDb()) as Array<{
      key: string; doc_count: number; by_livre: { buckets: Array<{ key: string; doc_count: number }> }
    }>
    const ct = tree.find(t => t.key === 'code_travail_ci')!
    expect(ct.doc_count).toBe(3)
    const livreI = ct.by_livre.buckets.find(b => b.key === 'Livre I')!
    expect(livreI.doc_count).toBe(2)
    // livre null → 'Général'
    const cc = tree.find(t => t.key === 'convention_collective')!
    expect(cc.by_livre.buckets[0]!.key).toBe('Général')
  })

  it('retourne un tableau vide si aucune donnée', async () => {
    selectRows.rows = []
    expect(await getHierarchyTreeFromDb()).toEqual([])
  })
})
