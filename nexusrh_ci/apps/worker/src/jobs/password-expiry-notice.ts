import type { Job } from 'bullmq'
import { Queue } from 'bullmq'
import { Pool } from 'pg'
import { createClient } from '../redis.js'
import { logger } from '../logger.js'

/**
 * Rappels avant expiration du mot de passe — J-7, J-2, J-1.
 *
 * POURQUOI CE JOB EXISTE. La politique de sécurité impose une durée de vie
 * (30 jours par défaut) et elle expirait en SILENCE. Le 25/11/2026, 58 comptes
 * sur 60 étaient expirés, certains depuis juillet : plateforme, tenants et
 * cabinets confondus. Un compte expiré n'est pas refusé — il est dérouté vers
 * un changement obligatoire — mais combiné à l'interdiction de réutiliser les
 * cinq derniers mots de passe et au refus des mots de passe compromis, le
 * salarié se retrouve devant un formulaire qu'il n'arrive pas à satisfaire.
 * Le bandeau dans l'application ne prévient que ceux qui se connectent ; ce
 * job atteint précisément les autres.
 *
 * CE QU'IL NE FAIT PAS. Il ne change aucun mot de passe, n'accorde ni ne
 * retire aucun droit, ne prolonge aucune échéance. Il n'envoie que des
 * rappels. L'autorité reste au login, qui recalcule l'expiration à chaque
 * tentative, que ce job ait tourné ou non.
 *
 * DÉCLENCHEMENT PAR SEUIL ATTEINT, JAMAIS PAR ÉGALITÉ. Un rappel part dès que
 * les jours restants passent SOUS OU ÉGAL à un palier, et non quand ils valent
 * exactement ce palier : une exécution manquée (worker arrêté, Redis coupé)
 * sauterait sinon le rappel pour de bon. Le palier retenu est le plus proche,
 * pour qu'un compte resté inactif reçoive « demain » et non « dans 7 jours ».
 *
 * NON-REJEU. Une ligne par (compte, palier, password_changed_at) dans
 * `platform.password_expiry_notices`. Rejouer le job, ou le lancer deux fois
 * dans la journée, n'envoie rien de plus. Le `password_changed_at` dans la clé
 * fait repartir le cycle de lui-même dès que le mot de passe change : aucune
 * purge à prévoir.
 *
 * Patron repris de `habilitations-daily.ts` : fan-out sur les tenants, garde
 * `SAFE_SCHEMA` avant toute interpolation d'identifiant, isolation des pannes
 * par tenant, cap anti-storm.
 */
const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 3 })
const SAFE_SCHEMA = /^[a-z0-9_]{1,63}$/
const MAX_TENANTS = Number(process.env['PASSWORD_EXPIRY_MAX_TENANTS'] ?? 500)
/** Cap par exécution : un rappel ne doit pas se transformer en campagne. */
const MAX_EMAILS = Number(process.env['PASSWORD_EXPIRY_MAX_EMAILS'] ?? 2000)

/**
 * Paliers, du plus lointain au plus proche. Doit rester aligné sur le bandeau
 * de l'application (`paliersDAlerte`, apps/web), seul autre endroit qui les
 * connaît : l'API, elle, ne renvoie qu'un nombre de jours.
 */
export const PALIERS = [7, 2, 1] as const

/**
 * Durée de vie du mot de passe, lue comme l'API la lit (`toNonNegInt` de
 * security-policy.service) : seule une valeur entière positive est retenue,
 * tout le reste retombe sur le défaut de 30 jours. Un 0 explicite en base
 * reste « désactivé », parce que c'est ce que le login applique aussi.
 */
export const DEFAUT_MAX_AGE_JOURS = 30
export function politiqueMaxAge(brut: unknown): number {
  if (brut === null || brut === undefined) return DEFAUT_MAX_AGE_JOURS
  const n = typeof brut === 'number' ? brut : typeof brut === 'string' ? parseInt(brut, 10) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAUT_MAX_AGE_JOURS
}

const PG_UNDEFINED_TABLE = '42P01'
const PG_UNDEFINED_COLUMN = '42703'
/**
 * Seule une TABLE absente est normale : un tenant pas encore migré. Une
 * COLONNE absente, elle, est un défaut de schéma qui ferait disparaître toute
 * une population de rappels — le super_admin compris — sans laisser de trace.
 * On la laisse donc remonter jusqu'au log d'avertissement.
 */
function tableAbsente(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === PG_UNDEFINED_TABLE
}
function colonneAbsente(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === PG_UNDEFINED_COLUMN
}

export interface CompteAPrevenir {
  /** 'platform' | 'agency' | nom du schéma tenant */
  scope: string
  userId: string
  email: string
  firstName: string | null
  passwordChangedAt: string
  joursRestants: number
  palier: number
}

/**
 * Jours restants avant expiration. Même sémantique que `isPasswordExpired` de
 * l'API : zéro jour restant équivaut exactement à « expiré », et pile à
 * l'échéance le login laisse encore passer (donc 1, pas 0).
 */
export function joursAvantExpiration(
  passwordChangedAt: string | Date | null,
  maxAgeDays: number,
  maintenant: Date,
): number | null {
  if (!maxAgeDays || maxAgeDays <= 0) return null
  if (!passwordChangedAt) return null
  const change = passwordChangedAt instanceof Date ? passwordChangedAt : new Date(passwordChangedAt)
  if (Number.isNaN(change.getTime())) return null
  const reste = change.getTime() + maxAgeDays * 86_400_000 - maintenant.getTime()
  if (reste < 0) return 0
  return Math.max(1, Math.ceil(reste / 86_400_000))
}

/** Palier le plus proche atteint, ou null s'il n'y a rien à dire. */
export function palierPour(joursRestants: number | null): number | null {
  if (joursRestants === null || !Number.isFinite(joursRestants) || joursRestants <= 0) return null
  for (const p of [...PALIERS].sort((a, b) => a - b)) {
    if (joursRestants <= p) return p
  }
  return null
}

/**
 * Échappement HTML du prénom et de l'URL avant insertion dans le corps du mail.
 * Le prénom vient de la fiche utilisateur : une valeur saisie côté RH ne doit
 * pas pouvoir injecter de balise dans un email que l'on envoie nous-mêmes
 * (OWASP A03). La version texte, elle, n'a rien à échapper.
 */
function echapperHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function corpsEmail(
  c: Pick<CompteAPrevenir, 'firstName' | 'joursRestants'>,
  urlChangement: string,
): { subject: string; html: string; text: string } {
  // « dans moins de 24 heures » et non « demain » : le rappel part à 06 h 30,
  // et un compte à qui il reste moins d'une journée peut expirer le soir même.
  // Annoncer « demain » lui ferait remettre au lendemain une échéance du jour.
  const quand = c.joursRestants <= 1 ? 'dans moins de 24 heures' : 'dans ' + c.joursRestants + ' jours'
  const bonjour = c.firstName ? 'Bonjour ' + c.firstName + ',' : 'Bonjour,'
  const subject = c.joursRestants <= 1
    ? 'NexusRH — votre mot de passe expire dans moins de 24 heures'
    : 'NexusRH — votre mot de passe expire dans ' + c.joursRestants + ' jours'
  const text = [
    bonjour,
    '',
    'Votre mot de passe NexusRH expire ' + quand + '.',
    '',
    'Changez-le dès maintenant pour conserver votre accès :',
    urlChangement,
    '',
    "Un mot de passe expiré ne bloque pas votre compte, mais vous devrez le",
    'changer avant de pouvoir travailler — et les cinq derniers mots de passe',
    'utilisés sont refusés. Mieux vaut vous y prendre sans attendre.',
    '',
    'NexusRH — OpenLab Consulting',
  ].join('\n')
  const lien = echapperHtml(urlChangement)
  const html = [
    '<p>' + echapperHtml(bonjour) + '</p>',
    '<p>Votre mot de passe NexusRH expire <strong>' + echapperHtml(quand) + '</strong>.</p>',
    '<p><a href="' + lien + '">Changer mon mot de passe maintenant</a></p>',
    '<p style="color:#555;font-size:13px">Un mot de passe expiré ne bloque pas votre',
    'compte, mais vous devrez le changer avant de pouvoir travailler — et les cinq',
    'derniers mots de passe utilisés sont refusés. Mieux vaut vous y prendre sans',
    'attendre.</p>',
    '<p style="color:#888;font-size:12px">NexusRH — OpenLab Consulting</p>',
  ].join('\n')
  return { subject, html, text }
}

/** Table de non-rejeu. Créée ici pour ne dépendre d'aucun ordre de déploiement. */
async function garantirTableTraces(): Promise<void> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS platform.password_expiry_notices (' +
    '  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),' +
    '  scope               text        NOT NULL,' +
    '  user_id             uuid        NOT NULL,' +
    '  threshold           int         NOT NULL,' +
    '  password_changed_at timestamptz NOT NULL,' +
    '  sent_at             timestamptz NOT NULL DEFAULT now(),' +
    '  UNIQUE (scope, user_id, threshold, password_changed_at)' +
    ')')
}

/** Collecte tous les comptes à prévenir, sur les trois chemins de connexion. */
export async function collecterComptes(maintenant: Date): Promise<CompteAPrevenir[]> {
  // MÊME lecture que `getSecurityPolicy` côté API, défaut compris : ligne
  // absente ou valeur illisible valent 30 jours, JAMAIS « désactivé ». Avec un
  // repli à 0, le worker se serait tu pendant que le login, lui, continuait
  // d'expirer les comptes — exactement le silence que ce job doit rompre.
  // `ORDER BY created_at` comme l'API : `platform_settings` est un singleton,
  // mais un LIMIT 1 sans tri a déjà fait lire la mauvaise ligne ici.
  const pol = await pool.query<{ d: unknown }>(
    'SELECT password_max_age_days AS d FROM platform.platform_settings' +
    ' ORDER BY created_at ASC LIMIT 1')
  const maxAge = politiqueMaxAge(pol.rows[0]?.d)
  if (maxAge <= 0) {
    logger.info('password-expiry-notice: expiration désactivée — rien à annoncer')
    return []
  }

  const sources: Array<{ scope: string; table: string }> = [
    { scope: 'platform', table: 'platform.platform_users' },
    { scope: 'agency', table: 'platform.agency_users' },
  ]
  const tenants = await pool.query<{ schema_name: string }>(
    "SELECT schema_name FROM platform.tenants WHERE status IN ('active','trial')" +
    ' ORDER BY schema_name LIMIT $1', [MAX_TENANTS])
  for (const t of tenants.rows) {
    if (!SAFE_SCHEMA.test(t.schema_name)) {
      logger.warn({ schema: t.schema_name }, 'password-expiry-notice: schéma au nom inattendu — ignoré')
      continue
    }
    sources.push({ scope: t.schema_name, table: '"' + t.schema_name + '".users' })
  }

  const comptes: CompteAPrevenir[] = []
  for (const src of sources) {
    try {
      const r = await pool.query<{
        id: string; email: string; first_name: string | null; password_changed_at: string | null
      }>('SELECT id, email, first_name, password_changed_at FROM ' + src.table +
         ' WHERE is_active = true AND email IS NOT NULL AND password_changed_at IS NOT NULL')
      for (const u of r.rows) {
        const jours = joursAvantExpiration(u.password_changed_at, maxAge, maintenant)
        const palier = palierPour(jours)
        if (palier === null || jours === null || !u.password_changed_at) continue
        comptes.push({
          scope: src.scope, userId: u.id, email: u.email, firstName: u.first_name,
          passwordChangedAt: u.password_changed_at, joursRestants: jours, palier,
        })
      }
    } catch (err) {
      // Un tenant non migré ou momentanément illisible ne doit pas priver les
      // autres de leur rappel.
      if (tableAbsente(err)) continue
      if (colonneAbsente(err)) {
        logger.error({ scope: src.scope, err: (err as Error).message },
          'password-expiry-notice: colonne absente — cette population ne recevra AUCUN rappel')
        continue
      }
      logger.warn({ scope: src.scope, err: (err as Error).message },
        'password-expiry-notice: source illisible — ignorée')
    }
  }
  return comptes
}

export async function processPasswordExpiryNoticeJob(_job: Job): Promise<void> {
  const maintenant = new Date()
  await garantirTableTraces()

  const comptes = await collecterComptes(maintenant)
  if (comptes.length === 0) {
    logger.info('password-expiry-notice: aucun rappel à envoyer')
    return
  }

  // APP_URL vide en production (le cas constaté) produirait un lien nu
  // « /change-password », inutilisable depuis une boîte mail. Un rappel qui
  // ne mène nulle part vaut moins que pas de rappel : on s'abstient et on le
  // signale, plutôt que d'épuiser le non-rejeu sur des emails morts.
  const appUrl = (process.env['APP_URL'] ?? '').trim()
  if (!appUrl) {
    if (process.env['NODE_ENV'] === 'production') {
      logger.error('password-expiry-notice: APP_URL absente — aucun rappel envoyé (lien inutilisable)')
      return
    }
    logger.warn('password-expiry-notice: APP_URL absente — repli sur localhost (hors production)')
  }
  const urlChangement =
    (appUrl || 'http://localhost:3001').replace(/\/+$/, '') + '/change-password'
  const connection = createClient()
  const file = new Queue('email', { connection })

  let envoyes = 0
  let dejaFaits = 0
  let echecs = 0
  try {
    for (const c of comptes) {
      if (envoyes >= MAX_EMAILS) {
        logger.warn({ plafond: MAX_EMAILS },
          'password-expiry-notice: plafond atteint — reste reporté au lendemain')
        break
      }
      // Non-rejeu garanti par la contrainte d'unicité : si la ligne existe
      // déjà, rien n'est inséré et aucun email ne part. La trace est posée
      // AVANT l'envoi pour qu'un double départ soit impossible — deux
      // exécutions concurrentes ne peuvent pas franchir la même ligne.
      const ins = await pool.query<{ id: string }>(
        'INSERT INTO platform.password_expiry_notices (scope, user_id, threshold, password_changed_at)' +
        ' VALUES ($1, $2, $3, $4)' +
        ' ON CONFLICT (scope, user_id, threshold, password_changed_at) DO NOTHING' +
        ' RETURNING id',
        [c.scope, c.userId, c.palier, c.passwordChangedAt])
      if (ins.rowCount === 0) { dejaFaits++; continue }

      const { subject, html, text } = corpsEmail(c, urlChangement)
      try {
        await file.add('password-expiry', { to: c.email, subject, html, text })
        envoyes++
      } catch (err) {
        // L'enfilage a échoué : la trace mentirait en annonçant un rappel
        // envoyé, et le palier serait perdu pour de bon. On la retire pour
        // que la prochaine exécution réessaie, et on continue avec les
        // autres comptes — un incident Redis ne doit pas priver tout le
        // monde de son rappel.
        const id = ins.rows[0]?.id
        if (id) {
          await pool.query('DELETE FROM platform.password_expiry_notices WHERE id = $1', [id])
            .catch(() => { /* la trace restera : au pire un rappel manquant, jamais un doublon */ })
        }
        echecs++
        logger.warn({ scope: c.scope, err: (err as Error).message },
          'password-expiry-notice: enfilage impossible — rappel reporté')
      }
    }
  } finally {
    await file.close().catch(() => { /* fermeture best-effort */ })
  }

  logger.info({ candidats: comptes.length, envoyes, dejaFaits, echecs },
    'password-expiry-notice: rappels traités')
}
