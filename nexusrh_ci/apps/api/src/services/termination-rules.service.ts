/**
 * Règles de rupture du contrat (préavis + indemnité de licenciement) — PUR.
 *
 * Priorité : règles du tenant (convention collective, plus favorable) > règles
 * du pack législatif du pays de l'employé > aucune. « Aucune » n'est JAMAIS
 * remplacée par les règles d'un autre pays : le solde signale les postes non
 * calculés (cf. offboarding.service.computeSettlement).
 */
import { z } from 'zod'
import type {
  LegislationPack, NoticeCategoryRule, NoticeTier, PayBasis, TerminationRules,
} from './legislation-packs.js'

/** Bornes strictement croissantes, dernier palier sans borne (null). */
function checkTiers(bounds: Array<number | null>, ctx: z.RefinementCtx): void {
  if (bounds[bounds.length - 1] !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Le dernier palier doit être sans borne (null).' })
    return
  }
  for (let i = 0; i < bounds.length - 1; i++) {
    const cur = bounds[i]
    const next = bounds[i + 1]
    if (cur === null || cur === undefined || (next !== null && next !== undefined && next <= cur)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Les bornes des paliers doivent être strictement croissantes.' })
      return
    }
  }
}

const bound = z.number().int().min(0).max(600).nullable()

const noticeTiersSchema = z.array(z.object({
  upToSeniorityMonths: bound,
  months: z.number().min(0).max(24),
  days: z.number().int().min(0).max(60).optional(),
}).strict()).min(1).max(12)
  .superRefine((tiers, ctx) => checkTiers(tiers.map((t) => t.upToSeniorityMonths), ctx))

const categoryLevelSchema = z.number().int().min(1).max(20)

export const terminationRulesSchema = z.object({
  noticeMonths: noticeTiersSchema,
  noticeByCategory: z.array(z.object({
    key: z.string().regex(/^[a-z0-9_]{1,40}$/),
    label: z.string().trim().min(1).max(120),
    minCategoryLevel: categoryLevelSchema.optional(),
    maxCategoryLevel: categoryLevelSchema.optional(),
    payBasis: z.enum(['monthly', 'non_monthly']).optional(),
    tiers: noticeTiersSchema,
  }).strict()).max(10).optional(),
  severanceRates: z.array(z.object({
    upToYear: bound,
    rate: z.number().min(0).max(2),
  }).strict()).min(1).max(12)
    .superRefine((tiers, ctx) => checkTiers(tiers.map((t) => t.upToYear), ctx)),
  severanceMinSeniorityMonths: z.number().int().min(0).max(120).optional(),
}).strict()

/** Lecture tolérante d'une valeur en base : invalide ou absente → null. */
export function parseTerminationRules(raw: unknown): TerminationRules | null {
  if (raw === null || raw === undefined) return null
  const parsed = terminationRulesSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export interface EffectiveTerminationRules {
  rules: TerminationRules | null
  source: 'tenant' | 'pack' | 'none'
}

export function effectiveTerminationRules(
  tenantOverride: unknown,
  pack: Pick<LegislationPack, 'terminationRules'>,
): EffectiveTerminationRules {
  const tenant = parseTerminationRules(tenantOverride)
  if (tenant) return { rules: tenant, source: 'tenant' }
  if (pack.terminationRules) return { rules: pack.terminationRules, source: 'pack' }
  return { rules: null, source: 'none' }
}

/**
 * Niveau de catégorie professionnelle déduit du libellé saisi au dossier
 * (saisie libre, cf. grille CCI) : « 3ème catégorie » → 3, agents de maîtrise
 * → 7, cadres / ingénieurs / hors catégorie → 8. null = non déterminable.
 */
export function categoryLevel(raw: string | null | undefined): number | null {
  if (!raw) return null
  const s = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (/cadre|ingenieur|hors\s*cat/.test(s)) return 8
  if (/maitrise|\bam\s*\d/.test(s)) return 7
  const m = /(?:^|\D)(\d{1,2})\s*(?:e|eme|er|ere|re)?\b/.exec(s)
  if (m && /cat/.test(s)) return parseInt(m[1]!, 10)
  if (/^\s*\d{1,2}\s*$/.test(s)) return parseInt(s, 10)
  return null
}

/** Durée d'un palier en mois (jours convertis sur une base de 30 jours). */
export function tierMonths(t: Pick<NoticeTier, 'months' | 'days'>): number {
  return t.months + (t.days ?? 0) / 30
}

function tierFor(tiers: ReadonlyArray<NoticeTier>, seniorityMonths: number): NoticeTier | null {
  for (const t of tiers) {
    if (t.upToSeniorityMonths === null || seniorityMonths <= t.upToSeniorityMonths) return t
  }
  return null
}

export interface NoticeEmployee {
  seniorityMonths: number
  /** Niveau de catégorie (categoryLevel) ; null = inconnu. */
  categoryLevel: number | null
  payBasis: PayBasis
}

export interface ResolvedNotice {
  months: number
  tier: NoticeTier
  /** Ligne de catégorie appliquée ; null = barème par défaut. */
  category: Pick<NoticeCategoryRule, 'key' | 'label'> | null
  /** Des lignes par catégorie existent mais la catégorie de l'employé est inconnue. */
  categoryUnknown: boolean
}

function matches(rule: NoticeCategoryRule, e: NoticeEmployee): boolean {
  if (rule.payBasis && rule.payBasis !== e.payBasis) return false
  if (rule.minCategoryLevel === undefined && rule.maxCategoryLevel === undefined) return true
  if (e.categoryLevel === null) return false
  if (rule.minCategoryLevel !== undefined && e.categoryLevel < rule.minCategoryLevel) return false
  if (rule.maxCategoryLevel !== undefined && e.categoryLevel > rule.maxCategoryLevel) return false
  return true
}

/**
 * Préavis applicable : première ligne de `noticeByCategory` qui correspond à
 * la catégorie et au mode de paie de l'employé, sinon le barème par défaut.
 */
export function resolveNotice(rules: TerminationRules | null, e: NoticeEmployee): ResolvedNotice | null {
  if (!rules) return null
  const seniority = Math.max(0, e.seniorityMonths)
  const byCategory = rules.noticeByCategory ?? []
  const rule = byCategory.find((r) => matches(r, e))
  const tier = tierFor(rule ? rule.tiers : rules.noticeMonths, seniority)
  if (!tier) return null
  const categoryUnknown = e.categoryLevel === null
    && byCategory.some((r) => r.minCategoryLevel !== undefined || r.maxCategoryLevel !== undefined)
  return {
    months: tierMonths(tier),
    tier,
    category: rule ? { key: rule.key, label: rule.label } : null,
    categoryUnknown,
  }
}

/**
 * Indemnité progressive : chaque année au taux de son palier, la fraction
 * d'année (mois entiers) au taux de l'année entamée.
 */
export function severanceAmount(seniorityMonths: number, base: number, rules: TerminationRules): number {
  const months = Math.max(0, Math.floor(seniorityMonths))
  const years = Math.floor(months / 12)
  const rateOf = (y: number) => rules.severanceRates.find((t) => t.upToYear === null || y <= t.upToYear)?.rate ?? 0
  let amount = 0
  for (let y = 1; y <= years; y++) amount += rateOf(y) * base
  amount += rateOf(years + 1) * base * ((months % 12) / 12)
  return Math.round(amount)
}
