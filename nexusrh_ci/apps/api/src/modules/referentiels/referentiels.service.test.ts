/**
 * Tests unitaires — referentiels.service.ts (Meilisearch + PostgreSQL)
 *
 * Le MOTEUR est mocké ici (search / addDocuments / deleteDocuments / getStats),
 * le repository PostgreSQL aussi. Le comportement réel du moteur est couvert
 * séparément, contre un Meilisearch qui tourne, par
 * `src/modules/meili-integration.test.ts` — parce qu'un mock ne pouvait pas
 * révéler que `createIndex` sur un index existant ne lève pas mais rend une
 * tâche en échec.
 *
 * `filtreEgalite` et `nomIndex` ne sont PAS mockés : ce sont des fonctions
 * pures, et `filtreEgalite` porte la garde OWASP A03. La mocker reviendrait à
 * tester une liste blanche factice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock du moteur ────────────────────────────────────────────────────────────
const {
  searchMock, addDocumentsMock, deleteDocumentsMock, getStatsMock,
  waitForTaskMock, ensureIndexMock,
} = vi.hoisted(() => ({
  searchMock: vi.fn(),
  addDocumentsMock: vi.fn(),
  deleteDocumentsMock: vi.fn(),
  getStatsMock: vi.fn(),
  waitForTaskMock: vi.fn(),
  ensureIndexMock: vi.fn(),
}))

vi.mock('../../services/meilisearch.js', async (importOriginal) => {
  const reel = await importOriginal<typeof import('../../services/meilisearch.js')>()
  return {
    ...reel,
    ensureIndex: ensureIndexMock,
    indexDroit: () => ({
      search: searchMock,
      addDocuments: addDocumentsMock,
      deleteDocuments: deleteDocumentsMock,
      getStats: getStatsMock,
    }),
    meiliClient: () => ({ tasks: { waitForTask: waitForTaskMock } }),
  }
})

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
  countArticlesMock, searchDbMock, hierarchyDbMock, desactiverMock,
} = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  getAllActiveMock: vi.fn(),
  getByIdMock: vi.fn(),
  getByPayrollMock: vi.fn(),
  countArticlesMock: vi.fn(),
  searchDbMock: vi.fn(),
  hierarchyDbMock: vi.fn(),
  desactiverMock: vi.fn(),
}))

vi.mock('./legal-articles.repository.js', () => ({
  upsertArticles: upsertMock,
  getAllActiveArticles: getAllActiveMock,
  getArticleByIdFromDb: getByIdMock,
  getArticlesByPayrollCodeFromDb: getByPayrollMock,
  countArticles: countArticlesMock,
  searchArticlesFromDb: searchDbMock,
  getHierarchyTreeFromDb: hierarchyDbMock,
  desactiverArticlesAbsentsDuCorpus: desactiverMock,
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

/** Document tel que le moteur le rend : champs du document + champs techniques. */
function docMoteur(over: Record<string, unknown> = {}) {
  return {
    article_id: 'ci-1', article_numero: '1', source: 'code_travail_ci',
    titre_article: 'Congés', texte: 'Texte sur les congés', payroll_codes: ['1000'],
    _rankingScore: 0.87,
    _formatted: { texte: '…<em>congés</em>…' },
    ...over,
  }
}

beforeEach(() => {
  searchMock.mockReset()
  addDocumentsMock.mockReset()
  deleteDocumentsMock.mockReset()
  getStatsMock.mockReset()
  waitForTaskMock.mockReset()
  waitForTaskMock.mockResolvedValue({ status: 'succeeded' })
  addDocumentsMock.mockResolvedValue({ taskUid: 1 })
  deleteDocumentsMock.mockResolvedValue({ taskUid: 2 })
  ensureIndexMock.mockReset()
  ensureIndexMock.mockResolvedValue(undefined)
  desactiverMock.mockReset()
  desactiverMock.mockResolvedValue([])
  upsertMock.mockReset()
  getAllActiveMock.mockReset()
  getByIdMock.mockReset()
  getByPayrollMock.mockReset()
  countArticlesMock.mockReset()
  searchDbMock.mockReset()
  hierarchyDbMock.mockReset()
})

describe('searchReferentiel', () => {
  it('rend les documents du moteur avec leur score et leur surlignage', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 1, hits: [docMoteur()] })
    const res = await searchReferentiel({ q: 'congés' })
    expect(res.total).toBe(1)
    expect(res.hits[0]!.score).toBe(0.87)
    expect(res.hits[0]!.highlight?.texte?.[0]).toContain('<em>congés</em>')
  })

  it('ne laisse fuiter aucun champ technique du moteur dans la réponse', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 1, hits: [docMoteur()] })
    const res = await searchReferentiel({ q: 'congés' })
    expect(res.hits[0]).not.toHaveProperty('_formatted')
    expect(res.hits[0]).not.toHaveProperty('_rankingScore')
  })

  it('applique tous les filtres, access_level en tête', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 1, hits: [docMoteur()] })
    await searchReferentiel({
      q: 'x', source: 'code_travail_ci', countryCode: 'CIV',
      convention: 'cc', payrollCode: '1000', livre: 'L1',
    })
    const [, options] = searchMock.mock.calls[0] as [string, { filter: string }]
    expect(options.filter).toBe(
      'access_level = "public" AND source = "code_travail_ci" AND country_code = "CIV"'
      + ' AND convention_slug = "cc" AND payroll_codes = "1000" AND livre = "L1"',
    )
  })

  it('OWASP A03 — une valeur hostile est échappée, le filtre reste une égalité', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 0, hits: [] })
    searchDbMock.mockResolvedValueOnce({ total: 0, hits: [] })
    await searchReferentiel({ q: 'x', source: 'a" OR access_level = "prive' })
    const [, options] = searchMock.mock.calls[0] as [string, { filter: string }]
    // Le guillemet est échappé : la clause ne peut pas se refermer, donc le
    // filtre reste une égalité sur une valeur qui n'existe pas.
    expect(options.filter).toContain('source = "a\\" OR access_level = \\"prive"')
  })

  it('mode parcours (q vide) → requête vide envoyée au moteur', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 2, hits: [docMoteur()] })
    await searchReferentiel({ q: '' })
    expect(searchMock.mock.calls[0]![0]).toBe('')
  })

  it('mode parcours avec q = "*" → requête vide aussi', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 1, hits: [docMoteur()] })
    const res = await searchReferentiel({ q: '*' })
    expect(searchMock.mock.calls[0]![0]).toBe('')
    expect(res.total).toBe(1)
  })

  it('pagination alignée → page/hitsPerPage, et total EXHAUSTIF', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 42, hits: [docMoteur()] })
    const res = await searchReferentiel({ q: 'x', from: 40, size: 20 })
    const [, options] = searchMock.mock.calls[0] as [string, Record<string, number>]
    expect(options.page).toBe(3)
    expect(options.hitsPerPage).toBe(20)
    expect(options.offset).toBeUndefined()
    expect(res.total).toBe(42)
  })

  it('pagination non alignée → offset/limit, et total estimé', async () => {
    searchMock.mockResolvedValueOnce({ estimatedTotalHits: 99, hits: [docMoteur()] })
    const res = await searchReferentiel({ q: 'x', from: 7, size: 20 })
    const [, options] = searchMock.mock.calls[0] as [string, Record<string, number>]
    expect(options.offset).toBe(7)
    expect(options.limit).toBe(20)
    expect(options.page).toBeUndefined()
    expect(res.total).toBe(99)
  })

  it('score absent du document → 1 par défaut', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 1, hits: [docMoteur({ _rankingScore: undefined })] })
    const res = await searchReferentiel({ q: 'x' })
    expect(res.hits[0]!.score).toBe(1)
  })

  it('surlignage absent → pas de champ highlight inventé', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 1, hits: [docMoteur({ _formatted: undefined })] })
    const res = await searchReferentiel({ q: 'x' })
    expect(res.hits[0]!.highlight).toBeUndefined()
  })

  it('index vide mais PostgreSQL a des résultats → PostgreSQL répond', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 0, hits: [] })
    searchDbMock.mockResolvedValueOnce({
      total: 2,
      hits: [
        { article_id: 'pg-1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
        { article_id: 'pg-2', article_numero: '2', source: 's', titre_article: 'T', texte: 't' },
      ],
    })
    const res = await searchReferentiel({ q: 'congés' })
    expect(res.total).toBe(2)
    expect(res.hits[0]!.article_id).toBe('pg-1')
    expect(res.hits[0]!.score).toBe(1)
  })

  it('index vide ET PostgreSQL vide → zéro, sans erreur', async () => {
    searchMock.mockResolvedValueOnce({ totalHits: 0, hits: [] })
    searchDbMock.mockResolvedValueOnce({ total: 0, hits: [] })
    const res = await searchReferentiel({ q: 'rien' })
    expect(res.total).toBe(0)
    expect(res.hits).toHaveLength(0)
  })

  it('moteur indisponible → repli PostgreSQL complet', async () => {
    searchMock.mockRejectedValueOnce(new Error('moteur HS'))
    searchDbMock.mockResolvedValueOnce({
      total: 1,
      hits: [{ article_id: 'pg-x', article_numero: '9', source: 's', titre_article: 'T', texte: 't' }],
    })
    const res = await searchReferentiel({ q: 'congés', source: 's' })
    expect(res.total).toBe(1)
    expect(res.hits[0]!.score).toBe(1)
  })
})

describe('lectures exactes — PostgreSQL seul', () => {
  it('getHierarchyTree lit PostgreSQL et n’interroge pas le moteur', async () => {
    hierarchyDbMock.mockResolvedValueOnce([{ key: 'pg' }])
    const res = (await getHierarchyTree()) as Array<{ key: string }>
    expect(res[0]!.key).toBe('pg')
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('getArticleById lit PostgreSQL et n’interroge pas le moteur', async () => {
    getByIdMock.mockResolvedValueOnce({
      article_id: 'pg-1', article_numero: '1', source: 's',
      titre_article: 'T', texte: 't', payroll_codes: ['1000'],
    })
    const res = await getArticleById('pg-1')
    expect(res!.article_id).toBe('pg-1')
    expect(res!.payroll_codes).toEqual(['1000'])
    expect(res!.score).toBe(1)
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('getArticleById rend null quand PostgreSQL ne trouve rien', async () => {
    getByIdMock.mockResolvedValueOnce(null)
    expect(await getArticleById('inconnu')).toBeNull()
  })

  it('getArticlesByPayrollCode lit PostgreSQL', async () => {
    getByPayrollMock.mockResolvedValueOnce([
      { article_id: 'pg-1', article_numero: '1', source: 's', titre_article: 'T', texte: 't', payroll_codes: ['1000'] },
    ])
    const res = await getArticlesByPayrollCode('1000')
    expect(res[0]!.payroll_codes).toEqual(['1000'])
    expect(res[0]!.score).toBe(1)
    expect(searchMock).not.toHaveBeenCalled()
  })
})

describe('seedReferentiel', () => {
  it('persiste en PostgreSQL puis indexe (succès)', async () => {
    upsertMock.mockResolvedValueOnce(3)
    getAllActiveMock.mockResolvedValueOnce([
      { article_id: 'a1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
    ])
    const res = await seedReferentiel()
    expect(res.persisted).toBe(3)
    expect(res.indexed).toBe(1)
    const corpus = upsertMock.mock.calls[0]![0] as unknown[]
    expect(corpus.length).toBeGreaterThanOrEqual(3)
  })

  it('moteur indisponible → persiste quand même, indexed = 0', async () => {
    upsertMock.mockResolvedValueOnce(5)
    ensureIndexMock.mockRejectedValueOnce(new Error('moteur HS'))
    const res = await seedReferentiel()
    expect(res.persisted).toBe(5)
    expect(res.indexed).toBe(0)
  })
})

describe('reindexFromDb', () => {
  it('rend 0 si aucun article, sans toucher à l’index', async () => {
    getAllActiveMock.mockResolvedValueOnce([])
    expect(await reindexFromDb()).toBe(0)
    expect(addDocumentsMock).not.toHaveBeenCalled()
  })

  it('indexe tous les articles en un seul lot', async () => {
    getAllActiveMock.mockResolvedValueOnce([
      { article_id: 'a1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
      {
        article_id: 'a2', article_numero: '2', country_code: 'BEN', source: 's',
        convention_slug: 'cc', livre: 'L', titre: 'Ti', chapitre: 'Ch',
        titre_article: 'T2', texte: 't2', keywords: ['k'], payroll_codes: ['1000'],
        access_level: 'public',
      },
    ])
    const res = await reindexFromDb()
    expect(res).toBe(2)
    const [documents, options] = addDocumentsMock.mock.calls[0] as [unknown[], { primaryKey: string }]
    expect(documents).toHaveLength(2)
    expect(options.primaryKey).toBe('article_id')
  })

  it('attend la tâche d’indexation, et rend 0 si elle échoue', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    getAllActiveMock.mockResolvedValueOnce([
      { article_id: 'a1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
    ])
    waitForTaskMock.mockResolvedValueOnce({ status: 'failed', error: { code: 'un_code' } })
    expect(await reindexFromDb()).toBe(0)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('applique les valeurs par défaut (CIV, listes vides, access public)', async () => {
    getAllActiveMock.mockResolvedValueOnce([
      { article_id: 'a1', article_numero: '1', source: 's', titre_article: 'T', texte: 't' },
    ])
    await reindexFromDb()
    const [documents] = addDocumentsMock.mock.calls[0] as [Array<Record<string, unknown>>]
    const doc = documents[0]!
    expect(doc.country_code).toBe('CIV')
    expect(doc.keywords).toEqual([])
    expect(doc.payroll_codes).toEqual([])
    expect(doc.access_level).toBe('public')
    expect(doc.tenant_id).toBe('public')
  })
})

describe('getReferentielStats', () => {
  it('agrège pg_count et le nombre de documents de l’index', async () => {
    countArticlesMock.mockResolvedValueOnce(120)
    getStatsMock.mockResolvedValueOnce({ numberOfDocuments: 118 })
    const res = await getReferentielStats()
    expect(res.pg_count).toBe(120)
    expect(res.es_count).toBe(118)
  })

  it('moteur en échec → es_count = -1, ce que l’interface affiche « indisponible »', async () => {
    countArticlesMock.mockResolvedValueOnce(50)
    getStatsMock.mockRejectedValueOnce(new Error('moteur HS'))
    const res = await getReferentielStats()
    expect(res.pg_count).toBe(50)
    expect(res.es_count).toBe(-1)
  })
})

describe('seedReferentiel — retrait des articles sortis du corpus', () => {
  beforeEach(() => {
    upsertMock.mockResolvedValue(2)
    getAllActiveMock.mockResolvedValue([])
  })

  it('désactive les articles absents du corpus et les sort de l’index', async () => {
    desactiverMock.mockResolvedValue(['art-32-3', 'art-20-1'])
    const r = await seedReferentiel()
    expect(r.desactives).toBe(2)
    expect(deleteDocumentsMock).toHaveBeenCalledWith(['art-32-3', 'art-20-1'])
    expect(waitForTaskMock).toHaveBeenCalledWith(2, expect.objectContaining({ timeout: expect.any(Number) }))
  })

  it('ne touche à l’index que s’il y a quelque chose à retirer', async () => {
    desactiverMock.mockResolvedValue([])
    const r = await seedReferentiel()
    expect(r.desactives).toBe(0)
    expect(deleteDocumentsMock).not.toHaveBeenCalled()
  })

  it('ne désactive que le Code du Travail ivoirien, jamais les autres pays', async () => {
    desactiverMock.mockResolvedValue([])
    await seedReferentiel()
    const [source, pays, ids] = desactiverMock.mock.calls[0] as [string, string, string[]]
    expect(source).toBe('code_travail_ci')
    expect(pays).toBe('CIV')
    expect(ids).toEqual(['ci-1', 'ci-2'])
    expect(ids).not.toContain('ben-1')
  })
})
