import { esClient, ES_INDEX } from '../../services/elasticsearch.js'
import { ALL_ARTICLES } from '../../data/code-travail-ci.js'

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

// OWASP A03 : toutes les requêtes utilisent le Query DSL typé, jamais de string concat
export async function searchReferentiel(params: SearchParams): Promise<{ total: number; hits: ArticleHit[] }> {
  const { q, source, convention, payrollCode, from = 0, size = 10 } = params

  // OWASP A01 : filtre access_level obligatoire sur chaque requête
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
        must: {
          multi_match: {
            query: q,
            fields: ['titre_article^3', 'texte', 'keywords^2'],
            fuzziness: 'AUTO',
            type: 'best_fields',
          },
        },
        filter: filterArr,
      },
    } as any,
    highlight: {
      fields: {
        texte:         { fragment_size: 200, number_of_fragments: 2 },
        titre_article: { number_of_fragments: 1 },
      },
    } as any,
  })

  const hits: ArticleHit[] = response.hits.hits.map((h: any) => ({
    ...(h._source as ArticleHit),
    score: h._score ?? 0,
    highlight: h.highlight,
  }))

  return {
    total: typeof response.hits.total === 'object'
      ? response.hits.total.value
      : (response.hits.total ?? 0),
    hits,
  }
}

export async function getHierarchyTree(): Promise<unknown> {
  const response = await esClient.search({
    index: ES_INDEX,
    size: 0,
    query: { term: { access_level: 'public' } } as any,
    aggs: {
      by_source: {
        terms: { field: 'source', size: 10 },
        aggs: {
          by_livre: {
            terms: { field: 'livre', size: 20, missing: 'Général' },
          },
        },
      },
    } as any,
  })
  return (response.aggregations as any)?.by_source?.buckets ?? []
}

export async function getArticleById(articleId: string): Promise<ArticleHit | null> {
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
  if (!hit) return null
  return { ...(hit._source as ArticleHit), score: hit._score ?? 0 }
}

export async function getArticlesByPayrollCode(code: string): Promise<ArticleHit[]> {
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
}

export async function seedReferentiel(): Promise<{ indexed: number }> {
  const ops = ALL_ARTICLES.flatMap(article => [
    { index: { _index: ES_INDEX, _id: article.article_id } },
    article,
  ])
  const result = await esClient.bulk({ operations: ops, refresh: true })
  const errors = result.items.filter((i: any) => i.index?.error)
  if (errors.length) console.error('[ES seed] erreurs:', errors.length)
  return { indexed: ALL_ARTICLES.length - errors.length }
}
