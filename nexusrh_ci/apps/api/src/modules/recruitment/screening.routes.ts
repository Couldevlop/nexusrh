/**
 * Pré-tri des candidatures — définition des questions, simulation, file de revue
 * et décision humaine.
 *
 * Principe directeur, repris de l'état de l'art des ATS : **la machine propose,
 * l'humain dispose, tout est tracé.** Le verdict machine (`screening_verdict`)
 * n'est jamais une décision ; seule `screening_decision`, posée ici par une
 * personne identifiée, fait entrer ou sortir une candidature du pipeline.
 *
 * C'est l'article 22 du RGPD (aucune décision individuelle purement
 * automatisée) et le contrôle humain qu'exige l'AI Act pour le recrutement,
 * classé à haut risque — traduits en routes.
 *
 * Fichier séparé de `recruitment.routes.ts`, qui dépasse déjà 2 000 lignes.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ensureRecruitmentSchemaMigrated } from '../../db/provisioning.js'
import { auditTenant } from '../../utils/audit-log.js'
import { badRequest, badRequestFromZod } from '../../utils/http-errors.js'
import { screeningRepo, type PendingRow } from './screening.repository.js'
import {
  sanitizeQuestions, sanitizeCriteria, evaluateQuestions, evaluateScreening,
  combineVerdicts, type ScreeningQuestion, type CandidateExtracted,
} from '../../services/recruitment-screening.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const READ_ROLES  = ['admin', 'hr_manager', 'hr_officer'] as const
const WRITE_ROLES = ['admin', 'hr_manager'] as const
/** Décider est un acte de recrutement courant : hr_officer y a accès. */
const DECIDE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const

/** Motif minimal exigé quand l'humain contredit la machine. */
const MIN_REASON_LENGTH = 10

const questionRuleSchema = z.union([
  z.object({ op: z.literal('is'),  value: z.boolean() }),
  z.object({ op: z.literal('min'), value: z.number().finite() }),
  z.object({ op: z.literal('max'), value: z.number().finite() }),
  z.object({ op: z.literal('in'),  value: z.array(z.string().max(200)).max(20) }),
])

const questionSchema = z.object({
  id:       z.string().min(1).max(64),
  label:    z.string().min(1).max(300),
  type:     z.enum(['boolean', 'number', 'choice']),
  options:  z.array(z.string().max(200)).max(20).optional(),
  required: z.boolean(),
  knockout: z.boolean(),
  rule:     questionRuleSchema.optional(),
})

const putQuestionsSchema = z.object({
  questions: z.array(questionSchema).max(15),
})

const previewSchema = z.object({
  criteria:  z.unknown().optional(),
  questions: z.array(questionSchema).max(15).optional(),
})

const decisionSchema = z.object({
  decision: z.enum(['kept', 'dismissed']),
  reason:   z.string().max(1000).optional(),
})

/** Extrait de la ligne persistée les données attendues par le moteur de règles. */
function toExtracted(row: PendingRow): CandidateExtracted {
  return {
    yearsExperience: row.ai_years_experience,
    skills:          row.ai_skills ?? [],
    highestDiploma:  row.ai_diploma,
    location:        row.ai_location,
    languages:       row.ai_languages ?? [],
    expectedSalary:  row.expected_salary,
  }
}

interface Counters {
  total: number
  pass: number
  flagged: number
  pending: number
  byRule: Array<{ rule: string; count: number }>
}

/**
 * Évalue en mémoire un lot de candidatures. Aucune écriture, aucun appel IA :
 * les deux moteurs sont purs, ce qui rend le réglage d'un critère instantané et
 * gratuit — là où il fallait jusqu'ici relancer un lot d'analyses facturées.
 */
function evaluateBatch(
  rows: PendingRow[],
  criteria: unknown,
  questions: ScreeningQuestion[],
): { counters: Counters; verdicts: Array<{ id: string; verdict: 'pass' | 'flagged'; failedRules: string[] }> } {
  const clean = sanitizeCriteria(criteria ?? {})
  const ruleCounts = new Map<string, number>()
  const verdicts: Array<{ id: string; verdict: 'pass' | 'flagged'; failedRules: string[] }> = []
  let pass = 0
  let flagged = 0

  for (const row of rows) {
    const qResult = evaluateQuestions(questions, (row.screening_answers ?? {}) as Record<string, unknown>)
    // Les règles sur CV ne s'appliquent qu'à un CV réellement analysé : sinon
    // l'extraction est vide et toute règle « échouerait » à tort.
    const cvVerdict = row.ai_analyzed_at
      ? evaluateScreening(clean, toExtracted(row), row.ai_score ?? 0)
      : null
    const combined = combineVerdicts(qResult, cvVerdict)

    if (combined.verdict === 'flagged') flagged++
    else pass++
    for (const rule of combined.failedRules) {
      ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1)
    }
    verdicts.push({ id: row.id, verdict: combined.verdict, failedRules: combined.failedRules })
  }

  return {
    counters: {
      total: rows.length,
      pass,
      flagged,
      // Tous ces dossiers sont sans décision humaine : ils sont tous en attente.
      pending: rows.length,
      // Quel critère écarte le plus — l'information la plus utile pour régler un
      // pré-tri, et celle qui manquait complètement jusqu'ici.
      byRule: [...ruleCounts.entries()]
        .map(([rule, count]) => ({ rule, count }))
        .sort((a, b) => b.count - a.count),
    },
    verdicts,
  }
}

const screeningRoutes: FastifyPluginAsync = async (fastify) => {
  /** Migration paresseuse — APRÈS `authenticate`, jamais en hook d'instance. */
  async function ensureSchema(request: FastifyRequest): Promise<void> {
    await ensureRecruitmentSchemaMigrated(request.user.schemaName)
  }

  // ── Définition des questions éliminatoires ─────────────────────────────────

  fastify.get('/jobs/:id/screening-questions', {
    preHandler: [fastify.authorize(...READ_ROLES), ensureSchema],
    schema: { tags: ['recruitment'], summary: 'Lire les questions éliminatoires d\'une offre' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'Identifiant d\'offre invalide (UUID requis)')
      const repo = screeningRepo(request.user.schemaName)
      return reply.send({ data: { questions: await repo.getQuestions(id) } })
    },
  })

  fastify.put('/jobs/:id/screening-questions', {
    preHandler: [fastify.authorize(...WRITE_ROLES), ensureSchema],
    schema: { tags: ['recruitment'], summary: 'Définir les questions éliminatoires d\'une offre' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'Identifiant d\'offre invalide (UUID requis)')

      const parsed = putQuestionsSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)

      // `sanitizeQuestions` a le dernier mot : elle dégrade notamment un
      // knockout sans règle applicable en question informative, pour qu'un
      // critère inopérant ne puisse pas se croire actif.
      const questions = sanitizeQuestions(parsed.data.questions)
      const repo = screeningRepo(request.user.schemaName)
      if (!await repo.setQuestions(id, questions)) {
        return reply.status(404).send({ error: 'Offre introuvable' })
      }

      auditTenant(request.user.schemaName, {
        userId: request.user.sub,
        action: 'recruitment.screening_questions_updated',
        entity: 'recruitment_job',
        entityId: id,
        changes: { count: questions.length, knockouts: questions.filter(q => q.knockout).length },
        ip: request.ip ?? null,
      })
      return reply.send({ data: { questions } })
    },
  })

  // ── Simulation et application ──────────────────────────────────────────────

  fastify.post('/jobs/:id/screening/preview', {
    preHandler: [fastify.authorize(...READ_ROLES), ensureSchema],
    schema: { tags: ['recruitment'], summary: 'Simuler un pré-tri sans rien enregistrer' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'Identifiant d\'offre invalide (UUID requis)')

      const parsed = previewSchema.safeParse(request.body ?? {})
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)

      const repo = screeningRepo(request.user.schemaName)
      // Critères et questions « en cours d'édition » s'ils sont fournis ; sinon
      // ceux enregistrés sur l'offre.
      const criteria = parsed.data.criteria !== undefined
        ? parsed.data.criteria
        : await repo.getCriteria(id)
      const questions = parsed.data.questions !== undefined
        ? sanitizeQuestions(parsed.data.questions)
        : await repo.getQuestions(id)

      const rows = await repo.listPending(id)
      const { counters } = evaluateBatch(rows, criteria, questions)
      return reply.send({ data: counters })
    },
  })

  fastify.post('/jobs/:id/screening/apply', {
    preHandler: [fastify.authorize(...WRITE_ROLES), ensureSchema],
    schema: { tags: ['recruitment'], summary: 'Appliquer le pré-tri aux candidatures en attente' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'Identifiant d\'offre invalide (UUID requis)')

      const repo = screeningRepo(request.user.schemaName)
      const [criteria, questions, rows] = await Promise.all([
        repo.getCriteria(id), repo.getQuestions(id), repo.listPending(id),
      ])
      const { counters, verdicts } = evaluateBatch(rows, criteria, questions)

      for (const v of verdicts) {
        await repo.saveVerdict(v.id, v.verdict, v.failedRules)
      }

      auditTenant(request.user.schemaName, {
        userId: request.user.sub,
        action: 'recruitment.screening_applied',
        entity: 'recruitment_job',
        entityId: id,
        changes: { total: counters.total, pass: counters.pass, flagged: counters.flagged },
        ip: request.ip ?? null,
      })
      return reply.send({ data: counters })
    },
  })

  // ── File de revue ──────────────────────────────────────────────────────────

  fastify.get('/jobs/:id/screening/queue', {
    preHandler: [fastify.authorize(...READ_ROLES), ensureSchema],
    schema: { tags: ['recruitment'], summary: 'File des candidatures en attente de décision' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'Identifiant d\'offre invalide (UUID requis)')

      const qs = request.query as { limit?: string; offset?: string }
      const limit  = Math.min(Math.max(Number(qs.limit) || 25, 1), 100)
      const offset = Math.max(Number(qs.offset) || 0, 0)

      const repo = screeningRepo(request.user.schemaName)
      const [items, questions] = await Promise.all([
        repo.queue(id, limit, offset), repo.getQuestions(id),
      ])
      // Les libellés accompagnent les réponses : la file est lisible sans avoir
      // à recouper avec la définition de l'offre.
      return reply.send({ data: { items, questions, limit, offset } })
    },
  })

  // ── Décision humaine ───────────────────────────────────────────────────────

  fastify.patch('/applications/:id/screening-decision', {
    preHandler: [fastify.authorize(...DECIDE_ROLES), ensureSchema],
    schema: { tags: ['recruitment'], summary: 'Trancher une candidature en attente' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'Identifiant de candidature invalide (UUID requis)')

      const parsed = decisionSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const { decision } = parsed.data
      const reason = parsed.data.reason?.trim() || null

      const schema = request.user.schemaName
      const repo = screeningRepo(schema)

      const verdict = await repo.getVerdict(id)
      if (verdict === null) {
        return reply.status(404).send({ error: 'Candidature introuvable ou déjà tranchée' })
      }

      // L'humain contredit la machine — retenir un dossier signalé (dérogation)
      // ou écarter un dossier conforme. Dans les deux cas le motif est exigé :
      // c'est ce qui rend la décision auditable et l'égalité de traitement
      // démontrable. C'est aussi la seule souplesse offerte : les critères
      // eux-mêmes ne varient jamais d'un candidat à l'autre.
      const contradicts = (decision === 'kept' && verdict === 'flagged')
        || (decision === 'dismissed' && verdict === 'pass')
      if (contradicts && (!reason || reason.length < MIN_REASON_LENGTH)) {
        return badRequest(reply,
          `Un motif d'au moins ${MIN_REASON_LENGTH} caractères est requis lorsque la décision `
          + 'contredit le résultat du pré-tri.')
      }

      const done = await repo.decide(id, decision, reason, request.user.sub)
      if (!done) {
        return reply.status(404).send({ error: 'Candidature introuvable ou déjà tranchée' })
      }

      auditTenant(schema, {
        userId: request.user.sub,
        action: 'recruitment.screening_decided',
        entity: 'application',
        entityId: id,
        changes: { verdict, decision, contradicts, reason },
        ip: request.ip ?? null,
      })
      return reply.send({ data: { id, decision, verdict } })
    },
  })
}

export default screeningRoutes
