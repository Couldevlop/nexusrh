/**
 * Tests unitaires — referentiels.service.ts (double couche ES / PostgreSQL)
 *
 * Elasticsearch est ENTIÈREMENT mocké (esClient.search / bulk / count / ensureIndex).
 * Le repository PostgreSQL est mocké également.
 *
 * Couvre :
 *  - searchReferentiel : ES OK, browse, filtres, highlights, fallback PG (index vide), catch ES
 *  - getHierarchyTree : ES OK + fallback PG
 *  - getArticleById : ES hit, ES miss → PG, ES catch → PG, null
 *  - getArticlesByPayrollCode : ES OK + fallback PG
 *  - seedReferentiel : PG + ES OK / ES indisponible
 *  - reindexFromDb : vide, succès, erreurs bulk
 *  - getReferentielStats : ES OK + ES en échec
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Elasticsearch ────────────────────────────────────────────────────────
const { searchMock, bulkMock, countMock, ensureIndexMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  bulkMock: vi.fn(),
  countMock: vi.fn(),
  ensureIndexMock: vi.fn(),
}))

vi.mock('../../services/elasticsearch.js', () => ({
  esClient: { search: searchMock, bulk: bulkMock, count: countMock },
  ES_INDEX: 'test_index',
  ensureIndex: ensureIndexMock,
}))

// ── Mock des fichiers de données (corpus) — minimal et déterministe ───────────
vi.mock('../../data/code-travail-ci.js', () => ({
  ALL_ARTICLES: [
    { article_id: 'ci-1', article_numero: '1', source: 'code_travail_ci', titre_article: 'A', texte: 't' },
    { article_id: 'ci-2', article_numero: '2', source: 'code_travail_ci', titre_article: 'B', texte: 't', country_code: 'CIV' },
  ],
}))
vi.mock('../../data/code-travail-ben.js', () => ({
  CODE_TRAVAIL_BEN: [{ article_id: 'ben-1', article_numero: '1', source: 'code_travail_ben', country_code: 'BEN', titre_article: 'A', texte: 't' }],
  CONVENTIONS_COLLECTIVES_BEN: [],
}))
vi.mock('../../data/code-travail-tgo.js', () => ({
  CODE_TRAVAIL_TGO: [],
  CONVENTIONS_COLLECTIVES_TGO: [],
}))
vi.mock('../../data/code-travail-tcd.js', () => ({ CODE_TRAVAIL_TCD: [] }))
vi.mock('../../data/code-travail-nga.js', () => ({ CODE_TRAVAIL_NGA: [] }))

// ── Mock du repository PostgreSQL ─────────────────────────────────────────────
const {
  upsertMock, getAllActiveMock, getByIdMock, getByPayrollMock,
  countArticlesMock, searchDbMock, hierarchyDbMock,
} = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  getAllActiveMock: vi.fn(),
  getByIdMock: vi.fn(),
  getByPayrollMock: vi.fn(),
  countArticlesMock: vi.fn(),
  searchDbMock: vi.fn(),
  hierarchyDbMock: vi.fn(),
}))

vi.mock('./legal-articles.repository.js', () => ({
  upsertArticles: upsertMock,
  getAllActiveArticles: getAllActiveMock,
  getArticleByIdFromDb: getByIdMock,
  getArticlesByPayrollCodeFromDb: getByPayrollMock,
  countArticles: countArticlesMock,
  searchArticlesFromDb: searchDbMock,
  getHierarchyTreeFromDb: hierarchyDbMock,
}))

import {
  searchReferentiel,
  getHierarchyTree,
  getArticleById,
  getArticlesByPayrollCode,
  seedReferentiel,
  reindexFromDb,
  getReferentielStats,
} from './referentiels.service.js'

function esHit(over: Record<string, unknown> = {}) {
  return {
    _id: 'ci-1',
    _score: 2.5,
    _source: {
      article_id: 'ci-1', article_numero: '1', source: 'code_travail_ci',
      titre_article: 'Congés', texte: 'Texte sur les congés', payroll_codes: ['1000'],
    },
    highlight: { texte: ['…<em>congés</em>…'] },
    ...over,
  }
}

beforeEach(() => {
  searchMock.mockReset()
  bulkMock.mockReset()
  countMock.mockReset()
  ensureIndexMock.mockReset()
  ensureIndexMock.mockResolvedValue(undefined)
  upsertMock.mockReset()
  getAllActiveMock.mockReset()
  getByIdMock.mockReset()
  getByPayrollMock.mockReset()
  countArticlesMock.mockReset()
  searchDbMock.mockReset()
  hierarchyDbMock.mockReset()
})

describe('searchReferentiel', () => {
  it('renvoie les hits ES avec score et highlight (total objet)', async () => {
    searchMock.mockResolvedValueOnce({
      hits: { total: { value: 1 }, hits: [esHit()] },
    })
    const res = await searchReferentiel({ q: 'congés' })
    expect(res.total).toBe(1)
    expect(res.hits[0]!.score).toBe(2.5)
    expect(res.hits[0]!.highlight?.texte?.[0]).toContain('congés')
    // construit une requête multi_match (pas browse)
    const arg = searchMock.mock.calls[0]![0] as { query: { bool: { must: Record<string, unknown> } } }
    expect(arg.query.bool.must.multi_match).toBeDefined()
  })

  it('mode browse (q vide) → match_all et applique tous les filtres', async () => {
    searchMock.mockResolvedValueOnce({ hits: { total: { value: 0 }, hits: [] } })
    searchDbMock.mockResolvedValueOnce({ total: 0, hits: [] })
    await searchReferentiel({
      q: '', source: 'code_travail_ci', countryCode: 'CIV',
      convention: 'cc', payrollCode: '1000', livre: 'L1', from: 5, size: 20,
    })
    const arg = searchMock.mock.calls[0]![0] as {
      from: number; size: number
      query: { bool: { must: Record<string, unknown>; filter: object[] } }
    }
    expect(arg.from).toBe(5)
    expect(arg.size).toBe(20)
    expect(arg.query.bool.must.match_all).toBeDefined()
    // access_level + 5 filtres = 6
    expect(arg.query.bool.filter).toHaveLength(6)
  })

  it('mode browse avec q = "*"', async () => {
    searchMock.mockResolvedValueOnce({ hits: { total: { value: 1 }, hits: [esHit()] } })
    const res = await searchReferentiel({ q: '*' })
    expect(res.total).toBe(1)
  })

  it('total numérique simple (pas un objet)', async () => {
    searchMock.mockResolvedValueOnce({ hits: { total: 7, hits: [esHit()] } })
    const res = await searchReferentiel({ q: 'x' })
    expect(res.total).toBe(7)
  })

  it('total absent (undefined) → 0', async () => {
    searchMock.mockResolvedValueOnce({ hits: { total: undefined, hits: [esHit()] } })
    const res = await searchReferentiel({ q: 'x' })
    expect(res.total).toBe(0)
  })

  it('score absent → 0', async () => {
    searchMock.mockResolvedValueOnce({
      hits: { total: { value: 1 }, hits: [esHit({ _score: undefined })] },
    })
    const res = await searchReferentiel({ q: 'x' })
    expect(res.hits[0]!.score).toBe(0)
  })

  it('ES répond mais index vide → fallback PG si PG a des résultats', async () => {
    searchMock.mockResolvedValueOnce({ hits: { total: { value: 0 }, hits: [] } })
    searchDbMock.mockResolvedValueOnce({
      total: 2,
      hits: [
        { article_id: 'pg-1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
        { article_id: 'pg-2', article_numero: '2', source: 's', titre_article: 'T', texte: 't' },
      ],
    })
    const res = await searchReferentiel({ q: 'congés' })
    expect(res.total).toBe(2)
    expect(res.hits[0]!.score).toBe(1)
    expect(res.hits[0]!.article_id).toBe('pg-1')
  })

  it('ES index vide ET PG vide → retourne le résultat ES (0)', async () => {
    searchMock.mockResolvedValueOnce({ hits: { total: { value: 0 }, hits: [] } })
    searchDbMock.mockResolvedValueOnce({ total: 0, hits: [] })
    const res = await searchReferentiel({ q: 'rien' })
    expect(res.total).toBe(0)
    expect(res.hits).toHaveLength(0)
  })

  it('ES indisponible (throw) → fallback PG complet', async () => {
    searchMock.mockRejectedValueOnce(new Error('ES down'))
    searchDbMock.mockResolvedValueOnce({
      total: 1,
      hits: [{ article_id: 'pg-x', article_numero: '9', source: 's', titre_article: 'T', texte: 't' }],
    })
    const res = await searchReferentiel({ q: 'congés', source: 's' })
    expect(res.total).toBe(1)
    expect(res.hits[0]!.score).toBe(1)
  })
})

describe('getHierarchyTree', () => {
  it('retourne les buckets d’agrégation ES', async () => {
    searchMock.mockResolvedValueOnce({
      aggregations: { by_source: { buckets: [{ key: 'code_travail_ci', doc_count: 5 }] } },
    })
    const res = (await getHierarchyTree()) as Array<{ key: string }>
    expect(res[0]!.key).toBe('code_travail_ci')
  })

  it('aggregations absentes → tableau vide', async () => {
    searchMock.mockResolvedValueOnce({ aggregations: undefined })
    expect(await getHierarchyTree()).toEqual([])
  })

  it('ES en échec → fallback getHierarchyTreeFromDb', async () => {
    searchMock.mockRejectedValueOnce(new Error('down'))
    hierarchyDbMock.mockResolvedValueOnce([{ key: 'pg' }])
    const res = (await getHierarchyTree()) as Array<{ key: string }>
    expect(res[0]!.key).toBe('pg')
    expect(hierarchyDbMock).toHaveBeenCalled()
  })
})

describe('getArticleById', () => {
  it('retourne le hit ES si trouvé', async () => {
    searchMock.mockResolvedValueOnce({ hits: { hits: [esHit()] } })
    const res = await getArticleById('ci-1')
    expect(res!.article_id).toBe('ci-1')
    expect(res!.score).toBe(2.5)
  })

  it('hit ES sans score → 0', async () => {
    searchMock.mockResolvedValueOnce({ hits: { hits: [esHit({ _score: null })] } })
    const res = await getArticleById('ci-1')
    expect(res!.score).toBe(0)
  })

  it('ES sans résultat → fallback PG (trouvé)', async () => {
    searchMock.mockResolvedValueOnce({ hits: { hits: [] } })
    getByIdMock.mockResolvedValueOnce({
      article_id: 'pg-1', article_numero: '1', source: 's', titre_article: 'T', texte: 't', payroll_codes: ['1000'],
    })
    const res = await getArticleById('pg-1')
    expect(res!.article_id).toBe('pg-1')
    expect(res!.score).toBe(1)
    expect(res!.payroll_codes).toEqual(['1000'])
  })

  it('ES throw → fallback PG, et PG renvoie null', async () => {
    searchMock.mockRejectedValueOnce(new Error('down'))
    getByIdMock.mockResolvedValueOnce(null)
    expect(await getArticleById('inconnu')).toBeNull()
  })
})

describe('getArticlesByPayrollCode', () => {
  it('retourne les hits ES', async () => {
    searchMock.mockResolvedValueOnce({ hits: { hits: [esHit(), esHit({ _id: 'ci-2', _score: 1 })] } })
    const res = await getArticlesByPayrollCode('1000')
    expect(res).toHaveLength(2)
    expect(res[0]!.score).toBe(2.5)
    expect(res[1]!.score).toBe(1)
  })

  it('hit sans score → 0', async () => {
    searchMock.mockResolvedValueOnce({ hits: { hits: [esHit({ _score: undefined })] } })
    const res = await getArticlesByPayrollCode('1000')
    expect(res[0]!.score).toBe(0)
  })

  it('ES throw → fallback PG', async () => {
    searchMock.mockRejectedValueOnce(new Error('down'))
    getByPayrollMock.mockResolvedValueOnce([
      { article_id: 'pg-1', article_numero: '1', source: 's', titre_article: 'T', texte: 't', payroll_codes: ['1000'] },
    ])
    const res = await getArticlesByPayrollCode('1000')
    expect(res[0]!.score).toBe(1)
    expect(res[0]!.payroll_codes).toEqual(['1000'])
  })
})

describe('seedReferentiel', () => {
  it('persiste en PG puis indexe ES (succès)', async () => {
    upsertMock.mockResolvedValueOnce(3)
    getAllActiveMock.mockResolvedValueOnce([
      { article_id: 'a1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
    ])
    bulkMock.mockResolvedValueOnce({ items: [{ index: {} }] })
    const res = await seedReferentiel()
    expect(res.persisted).toBe(3)
    expect(res.indexed).toBe(1)
    expect(upsertMock).toHaveBeenCalledTimes(1)
    // le corpus multi-pays a été agrégé et passé à upsert
    const corpus = upsertMock.mock.calls[0]![0] as unknown[]
    expect(corpus.length).toBeGreaterThanOrEqual(3)
  })

  it('ES indisponible → persiste quand même, indexed = 0', async () => {
    upsertMock.mockResolvedValueOnce(5)
    ensureIndexMock.mockRejectedValueOnce(new Error('ES down'))
    const res = await seedReferentiel()
    expect(res.persisted).toBe(5)
    expect(res.indexed).toBe(0)
  })
})

describe('reindexFromDb', () => {
  it('retourne 0 si aucun article', async () => {
    getAllActiveMock.mockResolvedValueOnce([])
    expect(await reindexFromDb()).toBe(0)
    expect(bulkMock).not.toHaveBeenCalled()
  })

  it('indexe tous les articles (sans erreur bulk)', async () => {
    getAllActiveMock.mockResolvedValueOnce([
      { article_id: 'a1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
      {
        article_id: 'a2', article_numero: '2', country_code: 'BEN', source: 's',
        convention_slug: 'cc', livre: 'L', titre: 'Ti', chapitre: 'Ch',
        titre_article: 'T2', texte: 't2', keywords: ['k'], payroll_codes: ['1000'],
        access_level: 'public',
      },
    ])
    bulkMock.mockResolvedValueOnce({ items: [{ index: {} }, { index: {} }] })
    const res = await reindexFromDb()
    expect(res).toBe(2)
    // 2 articles → 4 opérations (action + document)
    const ops = (bulkMock.mock.calls[0]![0] as { operations: unknown[] }).operations
    expect(ops).toHaveLength(4)
  })

  it('déduit les erreurs bulk du compte', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    getAllActiveMock.mockResolvedValueOnce([
      { article_id: 'a1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
      { article_id: 'a2', article_numero: '2', source: 's', titre_article: 'T', texte: 't' },
    ])
    bulkMock.mockResolvedValueOnce({ items: [{ index: { error: { type: 'x' } } }, { index: {} }] })
    const res = await reindexFromDb()
    expect(res).toBe(1)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('applique les valeurs par défaut (country CIV, keywords/payroll vides, access public)', async () => {
    getAllActiveMock.mockResolvedValueOnce([
      { article_id: 'a1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
    ])
    bulkMock.mockResolvedValueOnce({ items: [{ index: {} }] })
    await reindexFromDb()
    const ops = (bulkMock.mock.calls[0]![0] as { operations: Array<Record<string, unknown>> }).operations
    const doc = ops[1]!
    expect(doc.country_code).toBe('CIV')
    expect(doc.keywords).toEqual([])
    expect(doc.payroll_codes).toEqual([])
    expect(doc.access_level).toBe('public')
    expect(doc.tenant_id).toBe('public')
  })
})

describe('getReferentielStats', () => {
  it('agrège pg_count et es_count', async () => {
    countArticlesMock.mockResolvedValueOnce(120)
    countMock.mockResolvedValueOnce({ count: 118 })
    const res = await getReferentielStats()
    expect(res.pg_count).toBe(120)
    expect(res.es_count).toBe(118)
  })

  it('ES count en échec → es_count = -1', async () => {
    countArticlesMock.mockResolvedValueOnce(50)
    countMock.mockRejectedValueOnce(new Error('ES down'))
    const res = await getReferentielStats()
    expect(res.pg_count).toBe(50)
    expect(res.es_count).toBe(-1)
  })
})
