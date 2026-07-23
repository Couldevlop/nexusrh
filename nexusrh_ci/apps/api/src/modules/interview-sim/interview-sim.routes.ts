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

const submitSchema = z.object({
  roleKey: z.string().min(1).max(120),
  langue: z.enum(['fr', 'en']),
  questions: z.array(z.string().min(1).max(2000)).min(1).max(30),
  categories: z.array(z.string().max(60)).max(30).optional(),  // Phase 2 — renvoyées par /start
  answers: z.array(transcriptItemSchema).min(1).max(30),
}).strict()

interface TenantCfg { default_langue: 'fr' | 'en'; questions_count: number; public_token_ttl_minutes: number; consent_text: string | null }
async function loadTenantConfig(schema: string): Promise<TenantCfg> {
  const r = await pool.query<TenantCfg>(`SELECT default_langue, questions_count, public_token_ttl_minutes, consent_text FROM "${schema}".interview_sim_config WHERE id = 1`)
  return r.rows[0] ?? { default_langue: 'fr', questions_count: 5, public_token_ttl_minutes: 60, consent_text: null }
}

function badRequest(reply: FastifyReply, msg = 'Validation échouée') { return reply.status(400).send({ error: msg }) }

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
  // ── GET /interview-sim/start : contexte poste + questions (banque + génération) ──
  fastify.get('/start', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Démarrer une simulation (poste du salarié)' },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const user = request.user
      const employeeId = user.employeeId
      if (!employeeId) return badRequest(reply, 'Votre compte n’est pas lié à un employé.')
      const schema = user.schemaName

      const emp = await pool.query<{ job_title: string | null; professional_category: string | null; interview_focus: unknown }>(
        `SELECT job_title, professional_category, interview_focus FROM "${schema}".employees WHERE id = $1 LIMIT 1`,
        [employeeId],
      )
      if (!emp.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })
      const title = emp.rows[0].job_title || emp.rows[0].professional_category || 'Poste'
      const focus = parseInterviewFocus(emp.rows[0].interview_focus)

      const sec = await pool.query<{ sector: string | null }>(
        `SELECT sector FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
      )
      const secteur = sec.rows[0]?.sector ?? null

      const cfg = await loadTenantConfig(schema)
      const langue = cfg.default_langue
      const roleKey = normalizeRoleKey(title, secteur)

      const bank = await readBank(roleKey, langue)
      const banquePassee = bank?.questions ?? []
      // Self-service : pas d'experience_level côté employé (spec §2) → profondeur standard.
      const ctx: PosteContext = { title, secteur, langue, interviewFocus: focus }
      const creds = await resolveAiCreds(schema)
      const gen = await genererQuestions(ctx, banquePassee, cfg.questions_count, creds)
      if (!gen.fromBank && gen.questions.length > 0) {
        await feedBank(roleKey, secteur, langue, gen.questions, gen.sourceModel)
      }

      return reply.send({
        data: {
          poste: { title, secteur, langue },
          roleKey, langue, nbQuestions: cfg.questions_count,
          questions: gen.questions,
          categories: gen.categories,   // Phase 2 — catégorie alignée par index
        },
      })
    },
  })

  // ── POST /interview-sim/attempts/submit : retour + enregistrement historique ──
  fastify.post('/attempts/submit', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Soumettre les réponses et recevoir le retour' },
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const user = request.user
      const employeeId = user.employeeId
      if (!employeeId) return badRequest(reply, 'Votre compte n’est pas lié à un employé.')
      const schema = user.schemaName

      const parsed = submitSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const body = parsed.data

      const emp = await pool.query<{ job_title: string | null }>(
        `SELECT job_title FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
      )
      const title = emp.rows[0]?.job_title || 'Poste'
      const ctx: PosteContext = { title, secteur: null, langue: body.langue }
      const creds = await resolveAiCreds(schema)
      const retour: InterviewFeedback = await produireRetour(
        body.questions, body.answers as TranscriptItem[], ctx, creds, body.categories ?? [],
      )

      // OWASP A03/A08 — le roleKey du body est fourni par le client (le salarié
      // choisit toujours son poste cible, comportement inchangé) mais alimente
      // ensuite une table PARTAGÉE tous tenants confondus (platform.interview_sim_usage) :
      // normalisation SERVEUR obligatoire pour n'y laisser entrer que des clés
      // canoniques (anti-pollution du compteur global).
      const roleKey = normalizeRoleKey(body.roleKey)

      const ins = await pool.query<{ id: string }>(
        `INSERT INTO "${schema}".interview_sim_attempts (employee_id, role_key, langue, questions, answers, retour)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) RETURNING id`,
        [employeeId, roleKey, body.langue,
         JSON.stringify(body.questions), JSON.stringify(body.answers), JSON.stringify(retour)],
      )
      await incrementUsage(roleKey, body.langue)
      return reply.status(201).send({ data: { id: ins.rows[0]!.id, retour } })
    },
  })

  // ── GET /interview-sim/my-attempts : historique du salarié (le sien seul) ──
  fastify.get('/my-attempts', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Mes simulations' },
    handler: async (request, reply) => {
      const user = request.user
      if (!user.employeeId) return reply.send({ data: [] })
      const r = await pool.query(
        `SELECT id, role_key, langue, created_at
           FROM "${user.schemaName}".interview_sim_attempts
          WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [user.employeeId],
      )
      return reply.send({ data: r.rows })
    },
  })

  // ── GET /interview-sim/my-attempts/:id : détail (IDOR-safe) ──
  fastify.get('/my-attempts/:id', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Détail d’une simulation' },
    handler: async (request, reply) => {
      const user = request.user
      const { id } = request.params as { id: string }
      if (!user.employeeId) return reply.status(404).send({ error: 'Introuvable' })
      const r = await pool.query(
        `SELECT id, role_key, langue, questions, answers, retour, created_at
           FROM "${user.schemaName}".interview_sim_attempts
          WHERE id = $1 AND employee_id = $2 LIMIT 1`,
        [id, user.employeeId],
      )
      if (!r.rows[0]) return reply.status(404).send({ error: 'Introuvable' })
      return reply.send({ data: r.rows[0] })
    },
  })

  // ── DELETE /interview-sim/my-attempts/:id : droit à l'effacement ──
  fastify.delete('/my-attempts/:id', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Effacer une de mes simulations' },
    handler: async (request, reply) => {
      const user = request.user
      const { id } = request.params as { id: string }
      if (!user.employeeId) return reply.status(404).send({ error: 'Introuvable' })
      const r = await pool.query(
        `DELETE FROM "${user.schemaName}".interview_sim_attempts WHERE id = $1 AND employee_id = $2`,
        [id, user.employeeId],
      )
      if (!r.rowCount) return reply.status(404).send({ error: 'Introuvable' })
      return reply.send({ data: { deleted: true } })
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
