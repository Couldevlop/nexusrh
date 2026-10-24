/**
 * Règles de rupture du contrat (préavis + indemnité de licenciement) — PUR.
 *
 * Priorité : règles du tenant (convention collective, plus favorable) > règles
 * du pack législatif du pays de l'employé > aucune. « Aucune » n'est JAMAIS
 * remplacée par les règles d'un autre pays : le solde signale les postes non
 * calculés (cf. offboarding.service.computeSettlement).
 */
import { z } from 'zod'
import type { LegislationPack, TerminationRules } from './legislation-packs.js'

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

export const terminationRulesSchema = z.object({
  noticeMonths: z.array(z.object({
    upToSeniorityMonths: bound,
    months: z.number().min(0).max(24),
  }).strict()).min(1).max(12)
    .superRefine((tiers, ctx) => checkTiers(tiers.map((t) => t.upToSeniorityMonths), ctx)),
  severanceRates: z.array(z.object({
    upToYear: bound,
    rate: z.number().min(0).max(2),
  }).strict()).min(1).max(12)
    .superRefine((tiers, ctx) => checkTiers(tiers.map((t) => t.upToYear), ctx)),
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
