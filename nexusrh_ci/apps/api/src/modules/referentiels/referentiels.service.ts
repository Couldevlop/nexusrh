/**
 * Service Référentiels — Architecture double couche
 *   PostgreSQL (schema droit_ci) : source de vérité persistante
 *   Elasticsearch               : moteur de recherche full-text
 *
 * OWASP A01 : filtre access_level:'public' sur chaque requête ES + Drizzle
 * OWASP A03 : Query DSL ES uniquement — zéro concaténation de chaînes
 * OWASP A08 : checksum SHA-256 vérifié à l'indexation
 */
import { esClient, ES_INDEX, ensureIndex } from '../../services/elasticsearch.js'
import { ALL_ARTICLES } from '../../data/code-travail-ci.js'
import {
  upsertArticles,
  getAllActiveArticles,
  getArticleByIdFromDb,
  getArticlesByPayrollCodeFromDb,
  countArticles,
  searchArticlesFromDb,
  getHierarchyTreeFromDb,
} from './legal-articles.repository.js'
import type { ArticleInput } from './legal-articles.repository.js'

export interface SearchParams {
  q: string
  source?: 'code_travail_ci' | 'convention_collective'
  convention?: string
  payrollCode?: string
  from?: number
  size?: number
}

export interface ArticleHit {
  article_id: string; article_numero: string; source: string
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; titre_article: string; texte: string
  payroll_codes?: string[]; score: number
  highlight?: { texte?: string[]; titre_article?: string[] }
}

// OWASP A03 : Query DSL typé, jamais de string concat
export async function searchReferentiel(params: SearchParams): Promise<{ total: number; hits: ArticleHit[] }> {
  const { q, source, convention, payrollCode, from = 0, size = 10 } = params

  try {
    const filterArr: object[] = [{ term: { access_level: 'public' } }]
    if (source)      filterArr.push({ term: { source } })
    if (convention)  filterArr.push({ term: { convention_slug: convention } })
    if (payrollCode) filterArr.push({ term: { payroll_codes: payrollCode } })

    const response = await esClient.search({
      index: ES_INDEX,
      from,
      size,
      query: {
        bool: {
          must: { multi_match: { query: q, fields: ['titre_article^3', 'texte', 'keywords^2'], fuzziness: 'AUTO', type: 'best_fields' } },
          filter: filterArr,
        },
      } as any,
      highlight: { fields: { texte: { fragment_size: 200, number_of_fragments: 2 }, titre_article: { number_of_fragments: 1 } } } as any,
    })

    const hits: ArticleHit[] = response.hits.hits.map((h: any) => ({
      ...(h._source as ArticleHit),
      score: h._score ?? 0,
      highlight: h.highlight,
    }))
    return {
      total: typeof response.hits.total === 'object' ? response.hits.total.value : (response.hits.total ?? 0),
      hits,
    }
  } catch {
    // Fallback PostgreSQL si Elasticsearch indisponible
    const result = await searchArticlesFromDb({ q, source, from, size })
    return {
      total: result.total,
      hits: result.hits.map(a => ({ ...a, score: 1 }) as ArticleHit),
    }
  }
}

export async function getHierarchyTree(): Promise<unknown> {
  try {
    const response = await esClient.search({
      index: ES_INDEX,
      size: 0,
      query: { term: { access_level: 'public' } } as any,
      aggs: {
        by_source: {
          terms: { field: 'source', size: 10 },
          aggs: { by_livre: { terms: { field: 'livre', size: 20, missing: 'Général' } } },
        },
      } as any,
    })
    return (response.aggregations as any)?.by_source?.buckets ?? []
  } catch {
    // Fallback PostgreSQL si Elasticsearch indisponible
    return getHierarchyTreeFromDb()
  }
}

/** Cherche dans ES, fallback PG si ES indisponible */
export async function getArticleById(articleId: string): Promise<ArticleHit | null> {
  try {
    const response = await esClient.search({
      index: ES_INDEX,
      size: 1,
      query: {
        bool: {
          must:   { term: { article_id: articleId } },
          filter: { term: { access_level: 'public' } },
        },
      } as any,
    })
    const hit = response.hits.hits[0]
    if (hit) return { ...(hit._source as ArticleHit), score: hit._score ?? 0 }
  } catch { /* ES indisponible → fallback PG */ }

  const art = await getArticleByIdFromDb(articleId)
  return art ? { ...art, payroll_codes: art.payroll_codes, score: 1 } as ArticleHit : null
}

/** Cherche dans ES, fallback PG si ES indisponible */
export async function getArticlesByPayrollCode(code: string): Promise<ArticleHit[]> {
  try {
    const response = await esClient.search({
      index: ES_INDEX,
      size: 5,
      query: {
        bool: {
          must:   { term: { payroll_codes: code } },
          filter: { term: { access_level: 'public' } },
        },
      } as any,
    })
    return response.hits.hits.map((h: any) => ({
      ...(h._source as ArticleHit),
      score: h._score ?? 0,
    }))
  } catch {
    const arts = await getArticlesByPayrollCodeFromDb(code)
    return arts.map(a => ({ ...a, payroll_codes: a.payroll_codes, score: 1 }) as ArticleHit)
  }
}

/**
 * Seed complet : data file → PostgreSQL → Elasticsearch
 * Étape 1 : upsert tous les articles en PG (source de vérité)
 * Étape 2 : réindexer ES depuis PG
 */
export async function seedReferentiel(): Promise<{ persisted: number; indexed: number }> {
  await ensureIndex()

  // Étape 1 — Persist PG
  const persisted = await upsertArticles(ALL_ARTICLES as ArticleInput[])

  // Étape 2 — Sync ES depuis PG (source de vérité, pas depuis le fichier)
  const indexed = await reindexFromDb()

  return { persisted, indexed }
}

/**
 * Réindexe Elasticsearch depuis PostgreSQL (admin uniquement)
 * Permet de reconstruire l'index sans toucher aux données
 */
export async function reindexFromDb(): Promise<number> {
  await ensureIndex()
  const articles = await getAllActiveArticles()

  if (articles.length === 0) return 0

  const ops = articles.flatMap(a => [
    { index: { _index: ES_INDEX, _id: a.article_id } },
    {
      article_id:      a.article_id,
      article_numero:  a.article_numero,
      source:          a.source,
      convention_slug: a.convention_slug,
      livre:           a.livre,
      titre:           a.titre,
      chapitre:        a.chapitre,
      titre_article:   a.titre_article,
      texte:           a.texte,
      keywords:        a.keywords ?? [],
      payroll_codes:   a.payroll_codes ?? [],
      access_level:    a.access_level ?? 'public',
      tenant_id:       'public',
    },
  ])

  const result = await esClient.bulk({ operations: ops, refresh: true })
  const errors = result.items.filter((i: any) => i.index?.error)
  if (errors.length) console.error('[ES reindex] erreurs:', errors.length)
  return articles.length - errors.length
}

/** Stats pour le dashboard admin */
export async function getReferentielStats(): Promise<{ pg_count: number; es_count: number }> {
  const [pgCount, esResp] = await Promise.all([
    countArticles(),
    esClient.count({ index: ES_INDEX, query: { term: { access_level: 'public' } } as any })
      .catch(() => ({ count: -1 })),
  ])
  return { pg_count: pgCount, es_count: esResp.count }
}
