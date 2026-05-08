/**
 * Repository PostgreSQL pour les articles juridiques CI
 * Source de vérité — Elasticsearch est synchronisé depuis ici
 *
 * OWASP A03 : Drizzle ORM uniquement (zéro SQL brut avec input utilisateur)
 * OWASP A08 : checksum SHA-256 pour détecter toute altération du texte légal
 */
import { createHash } from 'crypto'
import { eq, and, inArray } from 'drizzle-orm'

export interface SearchResult { total: number; hits: ArticleInput[] }
import { droitCiDb } from '../../db/client.js'
import { legalArticles } from '../../db/schema/droit-ci.js'

export interface ArticleInput {
  article_id: string
  article_numero: string
  source: string
  convention_slug?: string
  livre?: string
  titre?: string
  chapitre?: string
  section?: string
  titre_article: string
  texte: string
  keywords?: string[]
  payroll_codes?: string[]
  access_level?: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function toInput(r: typeof legalArticles.$inferSelect): ArticleInput {
  return {
    article_id:      r.articleId,
    article_numero:  r.articleNumero,
    source:          r.source,
    convention_slug: r.conventionSlug ?? undefined,
    livre:           r.livre ?? undefined,
    titre:           r.titre ?? undefined,
    chapitre:        r.chapitre ?? undefined,
    section:         r.section ?? undefined,
    titre_article:   r.titreArticle,
    texte:           r.texte,
    keywords:        (r.keywords ?? []) as string[],
    payroll_codes:   (r.payrollCodes ?? []) as string[],
    access_level:    r.accessLevel,
  }
}

/** Upsert batch — insert ou update si texte modifié */
export async function upsertArticles(articles: ArticleInput[]): Promise<number> {
  let count = 0
  for (const art of articles) {
    const checksum = sha256(art.texte)
    await droitCiDb
      .insert(legalArticles)
      .values({
        articleId:      art.article_id,
        articleNumero:  art.article_numero,
        source:         art.source,
        conventionSlug: art.convention_slug,
        livre:          art.livre,
        titre:          art.titre,
        chapitre:       art.chapitre,
        section:        art.section,
        titreArticle:   art.titre_article,
        texte:          art.texte,
        keywords:       art.keywords ?? [],
        payrollCodes:   art.payroll_codes ?? [],
        accessLevel:    art.access_level ?? 'public',
        checksumSha256: checksum,
        lastVerifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: legalArticles.articleId,
        set: {
          titreArticle:   art.titre_article,
          texte:          art.texte,
          keywords:       art.keywords ?? [],
          payrollCodes:   art.payroll_codes ?? [],
          checksumSha256: checksum,
          lastVerifiedAt: new Date(),
          updatedAt:      new Date(),
        },
      })
    count++
  }
  return count
}

/** Tous les articles actifs et publics */
export async function getAllActiveArticles(): Promise<ArticleInput[]> {
  const rows = await droitCiDb
    .select()
    .from(legalArticles)
    .where(and(
      eq(legalArticles.isActive, true),
      eq(legalArticles.accessLevel, 'public'),
    ))
  return rows.map(toInput)
}

/** Article par identifiant métier */
export async function getArticleByIdFromDb(articleId: string): Promise<ArticleInput | null> {
  const rows = await droitCiDb
    .select()
    .from(legalArticles)
    .where(and(
      eq(legalArticles.articleId, articleId),
      eq(legalArticles.isActive, true),
      eq(legalArticles.accessLevel, 'public'),
    ))
  return rows[0] ? toInput(rows[0]) : null
}

/** Articles liés à une rubrique de paie */
export async function getArticlesByPayrollCodeFromDb(code: string): Promise<ArticleInput[]> {
  // OWASP A03 : tableau PostgreSQL — requête paramétrée Drizzle
  const all = await droitCiDb
    .select()
    .from(legalArticles)
    .where(and(
      eq(legalArticles.isActive, true),
      eq(legalArticles.accessLevel, 'public'),
    ))
  return all
    .filter(r => (r.payrollCodes as string[])?.includes(code))
    .map(toInput)
    .slice(0, 5)
}

/** Nombre total d'articles en base */
export async function countArticles(): Promise<number> {
  const rows = await droitCiDb.select().from(legalArticles).where(eq(legalArticles.isActive, true))
  return rows.length
}

/** Recherche full-text basique via LIKE PostgreSQL (fallback sans Elasticsearch) */
export async function searchArticlesFromDb(params: {
  q: string; source?: string; from?: number; size?: number
}): Promise<SearchResult> {
  const { q, source, from = 0, size = 10 } = params
  const conditions = [eq(legalArticles.isActive, true), eq(legalArticles.accessLevel, 'public')]
  if (source) conditions.push(eq(legalArticles.source as any, source))

  const all = await droitCiDb.select().from(legalArticles).where(and(...conditions))
  const ql = q.toLowerCase()
  const filtered = all.filter(r =>
    r.titreArticle.toLowerCase().includes(ql) ||
    r.texte.toLowerCase().includes(ql) ||
    (r.keywords as string[] ?? []).some(k => k.toLowerCase().includes(ql))
  )
  return { total: filtered.length, hits: filtered.slice(from, from + size).map(toInput) }
}

/** Arborescence source → livre depuis PostgreSQL (fallback sans Elasticsearch) */
export async function getHierarchyTreeFromDb(): Promise<unknown> {
  const all = await droitCiDb
    .select()
    .from(legalArticles)
    .where(and(eq(legalArticles.isActive, true), eq(legalArticles.accessLevel, 'public')))

  const grouped: Record<string, Record<string, number>> = {}
  for (const a of all) {
    if (!grouped[a.source]) grouped[a.source] = {}
    const livre = a.livre ?? 'Général'
    const bucket = grouped[a.source]!
    bucket[livre] = (bucket[livre] ?? 0) + 1
  }

  return Object.entries(grouped).map(([source, livres]) => ({
    key: source,
    doc_count: Object.values(livres).reduce((s, c) => s + c, 0),
    by_livre: {
      buckets: Object.entries(livres).map(([livre, count]) => ({ key: livre, doc_count: count })),
    },
  }))
}
