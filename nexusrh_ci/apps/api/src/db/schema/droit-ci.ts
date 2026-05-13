/**
 * Schéma PostgreSQL dédié : droit_ci
 * Source de vérité pour tous les articles juridiques (Code du Travail CI + Conventions)
 * Elasticsearch est le moteur de recherche synchronisé depuis ce schéma.
 *
 * OWASP A01 : access_level contrôlé en base + filtre ES obligatoire
 * OWASP A08 : checksum SHA-256 sur le texte de chaque article
 */
import { pgSchema, uuid, varchar, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const droitCiSchema = pgSchema('droit_ci')

export const legalArticles = droitCiSchema.table('articles', {
  id:             uuid('id').primaryKey().defaultRandom(),
  // Identifiant métier stable (ex: 'art-11-1', 'cc-tp-15')
  articleId:      varchar('article_id', { length: 50 }).notNull().unique(),
  articleNumero:  varchar('article_numero', { length: 50 }).notNull(),
  // Code pays ISO-3 (CIV par défaut pour rétro-compat — étend le schéma au multi-pays)
  countryCode:    varchar('country_code', { length: 3 }).notNull().default('CIV'),
  // 'code_travail_ci' | 'code_travail_ben' | 'convention_collective_*' | 'fiscal_its' | 'ohada' ...
  source:         varchar('source', { length: 30 }).notNull(),
  conventionSlug: varchar('convention_slug', { length: 100 }),
  livre:          varchar('livre', { length: 200 }),
  titre:          varchar('titre', { length: 300 }),
  chapitre:       varchar('chapitre', { length: 300 }),
  section:        varchar('section', { length: 300 }),
  titreArticle:   text('titre_article').notNull(),
  texte:          text('texte').notNull(),
  // Tableaux stockés comme text[] PostgreSQL natif
  keywords:       text('keywords').array().default([]),
  payrollCodes:   text('payroll_codes').array().default([]),
  // OWASP A01 : contrôle d'accès en base — 'public' | 'restricted'
  accessLevel:    varchar('access_level', { length: 20 }).notNull().default('public'),
  isActive:       boolean('is_active').notNull().default(true),
  // OWASP A08 : intégrité du texte légal
  checksumSha256: varchar('checksum_sha256', { length: 64 }),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type LegalArticle = typeof legalArticles.$inferSelect
export type NewLegalArticle = typeof legalArticles.$inferInsert
