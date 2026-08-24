/**
 * Formulaire public « Demander une démo ».
 *
 * C'est le seul endpoint non authentifié qui accepte du texte libre et
 * déclenche un envoi de courriel. Défenses, dans l'ordre où elles agissent :
 *
 *   A07 — limitation de débit : 5 demandes/heure/IP, 30 défis/heure/IP.
 *   A07 — captcha maison : défi arithmétique dont la réponse ne circule JAMAIS
 *         en clair. Le jeton porte `nonce.exp.signature` où la signature est un
 *         HMAC de (nonce | exp | réponse). Le serveur ne peut la recalculer
 *         qu'avec la réponse soumise : un jeton volé sans la réponse est inerte,
 *         et rien n'est stocké entre les deux appels.
 *   A07 — usage unique : le nonce est consommé dans Redis (anti-rejeu).
 *   A07 — piège à robots : un champ caché qui doit rester vide. S'il est rempli,
 *         on répond comme un succès sans rien envoyer — le robot ne réessaie pas.
 *   A03 — Zod `.strict()` : longueurs bornées, aucun champ surnuméraire.
 *   A03 — le HTML du courriel est construit par le service d'email, qui échappe
 *         chaque valeur. Cette route ne concatène aucun balisage.
 *   A09 — la demande est conservée dans `platform.demo_requests`.
 *   A10 — messages d'erreur génériques : jamais de détail SMTP ou SQL au visiteur.
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { pool } from '../../db/pool.js'
import { config } from '../../config.js'
import { consumeOnce } from '../../services/redis.js'
import { sendDemoRequestEmail } from '../../services/email.js'
import { ensurePlatformSchema } from '../../utils/schema-migrations.js'

/** Destinataire des demandes commerciales. */
export const DEMO_RECIPIENT = 'waopron@openlabconsulting.com'

const CHALLENGE_TTL_MS = 10 * 60 * 1000
const WORDS_FR = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf']
const WORDS_EN = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** Séparateur de domaine : cette clé ne sert qu'au captcha, jamais aux JWT. */
function sign(payload: string): string {
  return createHmac('sha256', `demo-captcha|${config.jwt.secret}`).update(payload).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Construit un défi. La réponse n'est ni renvoyée au client, ni stockée : elle
 * n'existe que dans la signature, que le serveur recalcule à la vérification.
 */
export function buildChallenge(lang: 'fr' | 'en', now = Date.now()): { token: string; question: string } {
  const a = 1 + Math.floor(Math.random() * 9)
  const b = 1 + Math.floor(Math.random() * 9)
  const times = Math.random() < 0.5
  const answer = times ? a * b : a + b
  // Un opérande en lettres : suffisant pour écarter les robots qui lisent
  // naïvement deux nombres dans la page.
  const words = lang === 'en' ? WORDS_EN : WORDS_FR
  const question = `${a} ${times ? '×' : '+'} ${words[b]} ?`
  const nonce = randomBytes(9).toString('base64url')
  const exp = now + CHALLENGE_TTL_MS
  const token = `${nonce}.${exp}.${sign(`${nonce}|${exp}|${answer}`)}`
  return { token, question }
}

/** Vérifie la forme, la fraîcheur et la réponse. N'accède à rien. */
export function verifyChallenge(token: string, answer: string, now = Date.now()): { ok: boolean; nonce?: string } {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false }
  const [nonce, expRaw, sig] = parts as [string, string, string]
  const exp = Number(expRaw)
  if (!Number.isFinite(exp) || exp < now) return { ok: false }
  if (!/^-?\d{1,4}$/.test(answer.trim())) return { ok: false }
  if (!safeEqual(sig, sign(`${nonce}|${exp}|${Number(answer.trim())}`))) return { ok: false }
  return { ok: true, nonce }
}

/**
 * Un champ repris dans un en-tête de courriel (sujet) ne doit contenir aucun
 * saut de ligne : un CR/LF y ouvrirait l'ajout d'en-têtes arbitraires (Bcc,
 * Reply-To). On refuse aussi les autres caractères de contrôle.
 */
const headerSafe = z.string().refine(
  v => ![...v].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7F),
  { message: 'Caractere interdit' },
)

const requestSchema = z.object({
  fullName:      headerSafe.pipe(z.string().trim().min(2).max(120)),
  company:       headerSafe.pipe(z.string().trim().min(2).max(160)),
  email:         z.string().trim().email().max(254),
  phone:         z.string().trim().max(40).optional().or(z.literal('')),
  headcount:     z.enum(['1-49', '50-199', '200-999', '1000+']).optional().or(z.literal('')),
  message:       z.string().trim().max(2000).optional().or(z.literal('')),
  captchaToken:  z.string().min(10).max(300),
  captchaAnswer: z.string().min(1).max(6),
  /** Piège à robots : invisible pour un humain, donc toujours vide. */
  website:       z.string().max(200).optional(),
}).strict()

const demoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/captcha', {
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['public'], summary: 'Défi anti-robot pour le formulaire de démo' },
    handler: async (request, reply) => {
      const lang = (request.query as { lang?: string } | undefined)?.lang === 'en' ? 'en' : 'fr'
      return reply
        .header('Cache-Control', 'no-store')
        .send(buildChallenge(lang))
    },
  })

  fastify.post('/request', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: { tags: ['public'], summary: 'Envoyer une demande de démonstration' },
    handler: async (request, reply) => {
      const parsed = requestSchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Formulaire incomplet ou invalide.' })
      const d = parsed.data

      // Piège à robots : on renvoie un succès sans rien faire. Répondre 400
      // apprendrait au robot à vider le champ et à recommencer.
      if (d.website && d.website.trim() !== '') return reply.send({ ok: true })

      const check = verifyChallenge(d.captchaToken, d.captchaAnswer)
      if (!check.ok) return reply.status(400).send({ error: 'Réponse au test anti-robot incorrecte ou expirée.' })
      // Usage unique. Redis indisponible → on laisse passer : la limitation de
      // débit borne déjà les dégâts, et un formulaire de contact ne doit pas
      // tomber avec le cache.
      const fresh = await consumeOnce(`demo:captcha:${check.nonce}`, Math.ceil(CHALLENGE_TTL_MS / 1000))
      if (!fresh) return reply.status(400).send({ error: 'Ce test anti-robot a déjà été utilisé.' })

      const payload = {
        fullName: d.fullName, company: d.company, email: d.email,
        phone: d.phone || null, headcount: d.headcount || null, message: d.message || null,
      }

      try {
        await ensurePlatformSchema()
        // La politique de confidentialité annonce une conservation de 24 mois
        // au plus. Sans purge, cette phrase serait fausse : on l'applique ici,
        // au fil de l'eau, plutôt que de dépendre d'une tâche planifiée.
        await pool.query(
          `DELETE FROM platform.demo_requests WHERE created_at < now() - interval '24 months'`,
        ).catch(() => undefined)
        await pool.query(
          `INSERT INTO platform.demo_requests
             (full_name, company, email, phone, headcount, message, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [payload.fullName, payload.company, payload.email, payload.phone, payload.headcount,
            payload.message, request.ip ?? null, request.headers['user-agent']?.slice(0, 500) ?? null],
        )
      } catch (err) {
        // La conservation ne doit pas faire perdre le prospect : on continue,
        // le courriel reste le canal principal.
        fastify.log.error({ err: (err as Error).message }, '[demo] enregistrement impossible')
      }

      try {
        await sendDemoRequestEmail({ to: DEMO_RECIPIENT, ...payload })
      } catch (err) {
        fastify.log.error({ err: (err as Error).message }, '[demo] envoi du courriel impossible')
        return reply.status(502).send({
          error: 'Votre demande n\'a pas pu être transmise. Écrivez-nous directement à waopron@openlabconsulting.com.',
        })
      }

      return reply.send({ ok: true })
    },
  })
}

export default demoRoutes
