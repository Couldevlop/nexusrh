/**
 * Simulations d'entretien — routes (prefix /interview-sim).
 *
 * Bloc INTERNE (authentifié) : entraînement self-service du salarié + historique
 * PRIVÉ (visible du seul salarié, scoping employee_id dérivé du JWT — jamais du
 * body/query, OWASP A01/A03).
 *
 * Bloc PUBLIC à jeton : plugin SÉPARÉ `interviewSimPublicRoutes` (exporté plus
 * bas dans ce fichier), enregistré par app.ts sous le préfixe DISTINCT
 * `/public/interview-sim` (et non `/interview-sim/public`) — voir app.ts.
 *
 * Migration lazy : preHandler de ROUTE `migrateSchemaOfAuthenticatedUser` placé
 * APRÈS fastify.authenticate (jamais un fastify.addHook d'instance — incident
 * 19/07/2026 : hook d'instance avant authenticate → request.user indéfini).
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { resolveAiCreds } from '../../services/ai-credentials.service.js'
import { normalizeRoleKey, readBank, feedBank, incrementUsage } from './interview-sim-bank.service.js'
import { parseInterviewFocus } from '../../services/interview-focus.service.js'
import {
  genererQuestions, produireRetour,
  type PosteContext, type TranscriptItem, type InterviewFeedback,
} from './interview-sim-ai.service.js'

const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/

async function migrateSchemaOfAuthenticatedUser(req: FastifyRequest): Promise<void> {
  const u = (req as FastifyRequest & { user?: { schemaName?: string } }).user
  if (u?.schemaName && SCHEMA_NAME_RE.test(u.schemaName)) await ensureTenantSchema(u.schemaName)
}

const transcriptItemSchema = z.object({
  index: z.number().int().min(0).max(100),
  question: z.string().min(1).max(2000),
  transcript: z.string().max(5000),
}).strict()

const internalJobSubmitSchema = z.object({
  langue: z.enum(['fr', 'en']),
  questions: z.array(z.string().min(1).max(2000)).min(1).max(30),
  categories: z.array(z.string().max(60)).max(30).optional(),
  answers: z.array(transcriptItemSchema).min(1).max(30),
}).strict()

interface TenantCfg { default_langue: 'fr' | 'en'; questions_count: number; public_token_ttl_minutes: number; consent_text: string | null }
async function loadTenantConfig(schema: string): Promise<TenantCfg> {
  const r = await pool.query<TenantCfg>(`SELECT default_langue, questions_count, public_token_ttl_minutes, consent_text FROM "${schema}".interview_sim_config WHERE id = 1`)
  return r.rows[0] ?? { default_langue: 'fr', questions_count: 5, public_token_ttl_minutes: 60, consent_text: null }
}

function badRequest(reply: FastifyReply, msg = 'Validation échouée') { return reply.status(400).send({ error: msg }) }

interface EligibleInternalJob { title: string; interview_focus: unknown; experience_level: string | null }

/**
 * Charge l'offre interne SI ET SEULEMENT SI elle est éligible pour cet employé :
 * visible interne, ouverte, ET dans le périmètre de ciblage (département / niveau
 * de poste / ancienneté minimale / entité juridique). Utilisé identiquement par
 * `start` et `submit` — l'un ne doit jamais être moins strict que l'autre
 * (OWASP A01 : ne jamais révéler/traiter une offre hors périmètre).
 */
async function loadEligibleInternalJob(schema: string, employeeId: string, jobId: string): Promise<EligibleInternalJob | null> {
  const empRes = await pool.query<{ id: string; department_id: string | null; job_level: string | null; hire_date: string | null; legal_entity_id: string | null }>(
    `SELECT id, department_id, job_level, hire_date, legal_entity_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`,
    [employeeId],
  )
  const emp = empRes.rows[0]
  if (!emp) return null
  const seniorityMonths = emp.hire_date
    ? Math.max(0, Math.floor((Date.now() - new Date(emp.hire_date).getTime()) / (1000 * 60 * 60 * 24 * 30.4375)))
    : 0

  const jobRes = await pool.query<EligibleInternalJob>(
    `SELECT rj.title, rj.interview_focus, rj.experience_level
       FROM "${schema}".recruitment_jobs rj
      WHERE rj.id = $1
        AND rj.visibility IN ('internal','both')
        AND rj.status = 'open'
        AND (COALESCE(cardinality(rj.target_departments), 0) = 0
             OR ($2::uuid IS NOT NULL AND $2::uuid = ANY(rj.target_departments)))
        AND (COALESCE(cardinality(rj.target_job_levels), 0) = 0
             OR ($3::varchar IS NOT NULL AND $3::varchar = ANY(rj.target_job_levels)))
        AND (rj.target_min_seniority_months IS NULL OR rj.target_min_seniority_months <= $4::int)
        AND (rj.target_legal_entity_id IS NULL OR rj.target_legal_entity_id = $5::uuid)
      LIMIT 1`,
    [jobId, emp.department_id, emp.job_level, seniorityMonths, emp.legal_entity_id],
  )
  return jobRes.rows[0] ?? null
}

const PUBLIC_AUD = 'interview-sim-public'

interface PublicTokenClaims {
  aud: string
  schema: string
  tenantSlug: string
  jobId: string
  title: string
  secteur: string | null
  langue: 'fr' | 'en'
}

/**
 * Émet un jeton PUBLIC signé (HMAC via @fastify/jwt) à forte entropie et
 * expiration (§8 A04). Il n'encode que le CONTEXTE POSTE — aucune donnée
 * personnelle — et ne persiste rien (éphémère). aud dédié : ce jeton
 * n'authentifie jamais une route applicative (rejeté par plugins/auth.ts).
 */
export function mintPublicInterviewToken(
  fastify: FastifyInstance,
  payload: { schema: string; tenantSlug: string; jobId: string; title: string; secteur: string | null; langue: 'fr' | 'en' },
  ttlMinutes: number,
): string {
  // Le jeton PUBLIC a une forme volontairement différente du payload de
  // session (JwtSignPayload, plugins/auth.ts) — aucune donnée personnelle,
  // aucun `sub`/rôle/tenant applicatif. `fastify.jwt.sign` est typé contre ce
  // seul payload de session (déclaration de module @fastify/jwt) : cast
  // explicite, borné à ce jeton dédié (aud distinct, jamais accepté comme
  // session par plugins/auth.ts).
  const claims = {
    aud: PUBLIC_AUD, schema: payload.schema, tenantSlug: payload.tenantSlug, jobId: payload.jobId,
    title: payload.title, secteur: payload.secteur, langue: payload.langue,
  } as unknown as Parameters<FastifyInstance['jwt']['sign']>[0]
  if (ttlMinutes < 0) {
    // Jeton VOLONTAIREMENT déjà expiré (simulation de test uniquement) : `exp`
    // explicite dans le passé — fast-jwt (@fastify/jwt) rejette une valeur
    // `expiresIn` négative, donc on ne peut pas passer par cette option ici.
    const exp = Math.floor(Date.now() / 1000) + Math.round(ttlMinutes * 60)
    return fastify.jwt.sign({ ...claims, exp } as unknown as Parameters<FastifyInstance['jwt']['sign']>[0])
  }
  // 0/NaN/absent → repli 60 min ; sinon plafond 24h (1440), plancher 1 min.
  const ttl = Math.max(1, Math.min(ttlMinutes || 60, 1440))
  return fastify.jwt.sign(claims, { expiresIn: `${ttl}m` })
}

function verifyPublicToken(fastify: FastifyInstance, token: string): { ok: true; claims: PublicTokenClaims } | { ok: false; expired: boolean } {
  try {
    const decoded = fastify.jwt.verify<PublicTokenClaims>(token)
    if (decoded.aud !== PUBLIC_AUD || !SCHEMA_NAME_RE.test(decoded.schema)) return { ok: false, expired: false }
    return { ok: true, claims: decoded }
  } catch (err) {
    const expired = err instanceof Error && /expired/i.test(err.message)
    return { ok: false, expired }
  }
}

const CONFIG_ROLES = ['admin', 'hr_manager'] as const
const configSchema = z.object({
  defaultLangue: z.enum(['fr', 'en']),
  questionsCount: z.number().int().min(1).max(15),
  publicTokenTtlMinutes: z.number().int().min(5).max(1440),
  consentText: z.string().max(2000),
}).strict()

const publicSubmitSchema = z.object({
  consentAccepted: z.literal(true),
  consentAt: z.string().datetime().optional(),
  questions: z.array(z.string().min(1).max(2000)).min(1).max(30),
  categories: z.array(z.string().max(60)).max(30).optional(),  // Phase 2 — renvoyées par GET /:token
  answers: z.array(transcriptItemSchema).min(1).max(30),
}).strict()

const interviewSimRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /interview-sim/internal-jobs/:jobId/start : entretien calibré sur une OFFRE INTERNE ──
  // Miroir AUTHENTIFIÉ du flux public : la source de calibrage est l'offre
  // (interview_focus + experience_level), plus jamais le poste de l'employé.
  fastify.get('/internal-jobs/:jobId/start', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Démarrer une simulation calibrée sur une offre interne' },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const user = request.user
      const employeeId = user.employeeId
      if (!employeeId) return badRequest(reply, 'Votre compte n’est pas lié à un employé.')
      const schema = user.schemaName
      const { jobId } = request.params as { jobId: string }

      // L'offre doit exister, être interne-visible, ouverte ET éligible pour cet
      // employé (mêmes filtres de ciblage que GET /recruitment/internal-jobs).
      // Sinon 404 neutre — OWASP A01 : ne jamais révéler une offre hors périmètre.
      const job = await loadEligibleInternalJob(schema, employeeId, jobId)
      if (!job) return reply.status(404).send({ error: 'Offre introuvable' })

      const sec = await pool.query<{ sector: string | null }>(`SELECT sector FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema])
      const secteur = sec.rows[0]?.sector ?? null
      const cfg = await loadTenantConfig(schema)
      const langue = cfg.default_langue
      const roleKey = normalizeRoleKey(job.title, secteur)
      const bank = await readBank(roleKey, langue)
      const ctx: PosteContext = {
        title: job.title, secteur, langue,
        interviewFocus: parseInterviewFocus(job.interview_focus),
        experienceLevel: job.experience_level ?? null,
      }
      const creds = await resolveAiCreds(schema)
      const gen = await genererQuestions(ctx, bank?.questions ?? [], cfg.questions_count, creds)
      if (!gen.fromBank && gen.questions.length > 0) {
        await feedBank(roleKey, secteur, langue, gen.questions, gen.sourceModel)
      }
      return reply.send({
        data: {
          jobId, jobTitle: job.title, langue, roleKey, nbQuestions: cfg.questions_count,
          questions: gen.questions, categories: gen.categories,
        },
      })
    },
  })

  // ── POST /interview-sim/internal-jobs/:jobId/submit : retour ÉPHÉMÈRE (rien stocké) ──
  fastify.post('/internal-jobs/:jobId/submit', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Soumettre l’entretien d’une offre interne (retour éphémère)' },
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const user = request.user
      const employeeId = user.employeeId
      if (!employeeId) return badRequest(reply, 'Votre compte n’est pas lié à un employé.')
      const schema = user.schemaName
      const { jobId } = request.params as { jobId: string }
      const parsed = internalJobSubmitSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const body = parsed.data

      // Même filtre d'éligibilité que GET .../start (OWASP A01 : ne jamais
      // traiter une offre hors périmètre — un 404 ici doit refléter le 404 de start).
      const job = await loadEligibleInternalJob(schema, employeeId, jobId)
      if (!job) return reply.status(404).send({ error: 'Offre introuvable' })
      const title = job.title
      const sec = await pool.query<{ sector: string | null }>(`SELECT sector FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema])
      const secteur = sec.rows[0]?.sector ?? null

      const ctx: PosteContext = { title, secteur, langue: body.langue }
      const creds = await resolveAiCreds(schema)
      const retour: InterviewFeedback = await produireRetour(
        body.questions, body.answers as TranscriptItem[], ctx, creds, body.categories ?? [],
      )
      // ÉPHÉMÈRE : rien de personnel écrit. Au plus le compteur ANONYME agrégé.
      await incrementUsage(normalizeRoleKey(title, secteur), body.langue)
      return reply.send({ data: { retour } })
    },
  })

  // ── GET /interview-sim/config : réglages tenant (admin/hr_manager) ──
  fastify.get('/config', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Configuration du module Simulations d’entretien' },
    handler: async (request, reply) => {
      const cfg = await loadTenantConfig(request.user.schemaName)
      return reply.send({ data: cfg })
    },
  })

  // ── PUT /interview-sim/config ──
  fastify.put('/config', {
    preHandler: [fastify.authorize(...CONFIG_ROLES), migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Mettre à jour la configuration' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = configSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      await pool.query(
        `INSERT INTO "${schema}".interview_sim_config
           (id, default_langue, questions_count, public_token_ttl_minutes, consent_text, updated_at)
         VALUES (1, $1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET
           default_langue = excluded.default_langue,
           questions_count = excluded.questions_count,
           public_token_ttl_minutes = excluded.public_token_ttl_minutes,
           consent_text = excluded.consent_text,
           updated_at = now()`,
        [b.defaultLangue, b.questionsCount, b.publicTokenTtlMinutes, b.consentText || null],
      )
      return reply.send({ data: { ok: true } })
    },
  })
}

export default interviewSimRoutes

/**
 * Bloc PUBLIC à jeton — plugin SÉPARÉ, enregistré par app.ts sous le préfixe
 * DISTINCT `/public/interview-sim` (jamais `/interview-sim/public`). Durci
 * comme l'upload CV public : rate-limit IP, jeton à forte entropie +
 * expiration. Aucune auth (route publique par construction — pas de
 * fastify.authenticate ici).
 */
export const interviewSimPublicRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /public/interview-sim/:token : poste + questions + consentement ──
  fastify.get('/:token', {
    schema: { tags: ['interview-sim'], summary: 'Entretien public (jeton) : questions + consentement' },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = request.params as { token: string }
      const v = verifyPublicToken(fastify, token)
      if (!v.ok) return reply.status(v.expired ? 410 : 401).send({ error: v.expired ? 'Lien expiré' : 'Lien invalide' })
      const { claims } = v
      await ensureTenantSchema(claims.schema)

      const cfg = await loadTenantConfig(claims.schema)
      const langue = claims.langue || cfg.default_langue
      const roleKey = normalizeRoleKey(claims.title, claims.secteur)
      const bank = await readBank(roleKey, langue)
      // Profil technique + séniorité de l'OFFRE (jobId porté par le jeton) → génération par catégorie.
      const job = await pool.query<{ interview_focus: unknown; experience_level: string | null }>(
        `SELECT interview_focus, experience_level FROM "${claims.schema}".recruitment_jobs WHERE id = $1 LIMIT 1`,
        [claims.jobId],
      ).catch(() => ({ rows: [] as { interview_focus: unknown; experience_level: string | null }[] }))
      const ctx: PosteContext = {
        title: claims.title, secteur: claims.secteur, langue,
        interviewFocus: parseInterviewFocus(job.rows[0]?.interview_focus),
        experienceLevel: job.rows[0]?.experience_level ?? null,
      }
      const creds = await resolveAiCreds(claims.schema)
      const gen = await genererQuestions(ctx, bank?.questions ?? [], cfg.questions_count, creds)
      if (!gen.fromBank && gen.questions.length > 0) {
        await feedBank(roleKey, claims.secteur, langue, gen.questions, gen.sourceModel)
      }
      return reply.send({
        data: {
          jobTitle: claims.title, langue, questions: gen.questions,
          categories: gen.categories,   // Phase 2 — catégorie alignée par index
          consentText: cfg.consent_text
            ?? 'En démarrant, vous acceptez que vos réponses soient analysées le temps de la session. Aucune donnée personnelle n’est conservée.',
        },
      })
    },
  })

  // ── POST /public/interview-sim/:token/submit : retour ÉPHÉMÈRE (rien stocké) ──
  fastify.post('/:token/submit', {
    schema: { tags: ['interview-sim'], summary: 'Entretien public : soumettre et recevoir le retour (éphémère)' },
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = request.params as { token: string }
      const v = verifyPublicToken(fastify, token)
      if (!v.ok) return reply.status(v.expired ? 410 : 401).send({ error: v.expired ? 'Lien expiré' : 'Lien invalide' })
      const parsed = publicSubmitSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply, 'Consentement et réponses requis')
      const { claims } = v
      const body = parsed.data
      const ctx: PosteContext = { title: claims.title, secteur: claims.secteur, langue: claims.langue }
      const creds = await resolveAiCreds(claims.schema)
      const retour: InterviewFeedback = await produireRetour(
        body.questions, body.answers as TranscriptItem[], ctx, creds, body.categories ?? [],
      )
      // ÉPHÉMÈRE : rien de personnel écrit. Au plus le compteur ANONYME agrégé.
      await incrementUsage(normalizeRoleKey(claims.title, claims.secteur), claims.langue)
      return reply.send({ data: { retour } })
    },
  })
}
