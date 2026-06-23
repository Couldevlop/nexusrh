import type { FastifyPluginAsync } from 'fastify'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { config } from '../../config.js'
import { pool } from '../../db/pool.js'
import bcrypt from 'bcryptjs'
import { provisionTenantSchema } from '../../db/provisioning.js'
import { sendEmployeeWelcomeEmail, type TenantSmtp } from '../../services/email.js'
import { encrypt, decryptIfPresent, encryptIfPresent } from '../../utils/crypto.js'
import { maskKey, isEncryptionAvailable } from '../../services/ai-credentials.service.js'
import { loadAiModels } from '../../services/sourcing-config.service.js'
import { buildLegislationConfig } from '../../services/legislation-config.service.js'
import { renderPayslipPdf } from '../payroll/payslip-pdf.js'
import { isSupportedCountry } from '../../services/legislation-packs.js'

// OWASP A03 — patterns de validation stricts
const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE   = /^#[0-9A-Fa-f]{6}$/
const CNPS_NUMBER_RE = /^[A-Z0-9-]{1,40}$/
const DGI_NUMBER_RE  = /^[A-Z0-9-]{1,40}$/
const RCCM_RE        = /^[A-Z0-9-]{1,60}$/
const URL_OR_DATA_RE = /^(https?:\/\/|data:image\/)/

// OWASP A04 — bornes anti-fraude CNPS CI : le taux AT légal est entre 2% et 5%.
// Hors plage = fraude potentielle (sous-cotisation ou erreur de saisie destructrice).
const AT_RATE_MIN = 0.02
const AT_RATE_MAX = 0.05

// OWASP A04 — cap import CSV pour éviter DoS (memory spike + DB starvation).
const IMPORT_MAX_HEADERS = 50
const IMPORT_MAX_ROWS    = 10_000

// OWASP A07 — rate-limits sur les écritures de paramétrage (cibles fraude).
const SETTINGS_WRITE_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } }
const IMPORT_RATE_LIMIT         = { rateLimit: { max: 10, timeWindow: '1 hour'   } }

// OWASP A09 — audit log non bloquant des modifications de paramétrage tenant.
// Changements CNPS/AT/DGI sont des vecteurs de fraude : modif numéro CNPS =
// re-routage des cotisations vers un compte attaquant ; baisse taux AT = sous-
// cotisation. Traçabilité 100% obligatoire (loi 2013-450 CI cybercriminalité).
function auditLogSettings(
  schema: string, userId: string, action: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'settings', $3, $4, $5)`,
    [userId, action, entityId, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

// OWASP A03 — schémas Zod stricts
const patchTenantSchema = z.object({
  name:            z.string().min(1).max(200).optional(),
  primary_color:   z.string().regex(HEX_COLOR_RE, 'Format hex requis (#RRGGBB)').optional(),
  secondary_color: z.string().regex(HEX_COLOR_RE, 'Format hex requis (#RRGGBB)').optional(),
  logo_url:        z.string().regex(URL_OR_DATA_RE, 'URL http(s) ou data:image requise').max(8192).optional().nullable(),
  city:            z.string().min(1).max(100).optional(),
  cnps_number:     z.string().regex(CNPS_NUMBER_RE).optional().nullable(),
  dgi_number:      z.string().regex(DGI_NUMBER_RE).optional().nullable(),
  rccm:            z.string().regex(RCCM_RE).optional().nullable(),
  // coerce : le formulaire « Général » envoie le taux AT en chaîne ("0.03").
  at_rate:         z.coerce.number().min(AT_RATE_MIN).max(AT_RATE_MAX).optional(),
  // OWASP A07 — l'admin tenant peut DURCIR la politique MFA de son tenant.
  // L'effet ne peut qu'imposer le MFA (jamais l'assouplir sous la politique
  // globale plateforme) : cf. effectiveTenantMfaRequired côté login.
  mfa_required:    z.boolean().optional(),
  // Expéditeur email configurable par le tenant : adresse "From" des emails
  // envoyés aux membres de la société (création d'accès, réinitialisation).
  // '' / null → repli sur l'expéditeur plateforme.
  sender_email:    z.string().email('Email expéditeur invalide').max(255).optional().nullable().or(z.literal('')),
  sender_name:     z.string().max(150).optional().nullable(),
}).strict()

const createLegalEntitySchema = z.object({
  name:                  z.string().min(1).max(200),
  rccm:                  z.string().regex(RCCM_RE).optional().nullable(),
  cnps_number:           z.string().regex(CNPS_NUMBER_RE).optional().nullable(),
  dgi_number:            z.string().regex(DGI_NUMBER_RE).optional().nullable(),
  address:               z.string().max(500).optional().nullable(),
  city:                  z.string().max(100).optional(),
  // Inclut les formes proposées par l'UI (SASU/SNC/Association/ONG/Établissement
  // public) en plus des formes historiques — sinon ces choix renvoyaient un 400.
  legal_form:            z.enum(['SARL', 'SA', 'SAS', 'SASU', 'SNC', 'EURL', 'SCI', 'SCOP', 'GIE', 'EI', 'Association', 'ONG', 'Établissement public', 'AUTRE']).optional(),
  collective_agreement:  z.string().max(200).optional().nullable(),
  // coerce : le formulaire envoie le taux AT en chaîne.
  at_rate:               z.coerce.number().min(AT_RATE_MIN).max(AT_RATE_MAX).optional(),
  country_code:          z.string().regex(/^[A-Z]{2,3}$/).optional(),
  legislation_pack_code: z.string().max(50).optional().nullable(),
}).strict()

const patchLegalEntitySchema = createLegalEntitySchema.partial().extend({
  is_active: z.boolean().optional(),
}).strict()

const createPayrollRuleSchema = z.object({
  code:         z.string().min(1).max(20),
  name:         z.string().min(1).max(200),
  type:         z.enum(['earning', 'deduction', 'employee_contribution', 'employer_contribution']),
  formula:      z.string().max(500).optional().nullable(),
  rate:         z.number().min(-10).max(10).optional().nullable(),
  ceiling_type: z.string().max(50).optional().nullable(),
  is_active:    z.boolean().optional(),
  order:        z.number().int().min(0).max(9999).optional(),
  description:  z.string().max(1000).optional().nullable(),
}).strict()

const patchPayrollRuleSchema = createPayrollRuleSchema.omit({ code: true, type: true }).partial().strict()

const importBodySchema = z.object({
  headers: z.array(z.string().max(100)).min(1).max(IMPORT_MAX_HEADERS),
  rows:    z.array(z.array(z.string().max(2000))).min(1).max(IMPORT_MAX_ROWS),
}).strict()

// Liste des types d'import supportés par le handler ci-dessous. Doit rester
// synchronisée avec les templates frontend (SettingsPage.tsx — IMPORT_TEMPLATES).
const IMPORT_TYPES = [
  'employees', 'departments', 'absences',
  'pay-slips', 'mobile-money', 'contracts', 'expenses',
] as const

function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const special = '!@#$'
  const all = upper + lower + digits + special
  const rand = (s: string) => s[randomBytes(1)[0]! % s.length]!
  const chars = [rand(upper), rand(lower), rand(digits), rand(special),
    ...Array.from({ length: 8 }, () => rand(all))]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}

// Construit l'adresse "From" d'un email destiné aux membres du tenant à partir
// de l'expéditeur configuré (Paramètres → société). NULL → repli plateforme
// (config.smtp.from) géré par le service email.
function buildTenantFrom(senderName: string | null | undefined, senderEmail: string | null | undefined): string | undefined {
  if (!senderEmail) return undefined
  return senderName ? `${senderName} <${senderEmail}>` : senderEmail
}

// Charge la config email d'envoi d'un tenant (expéditeur + SMTP propre option C).
// Le mot de passe SMTP est déchiffré ici ; `smtp` est null si aucun serveur
// tenant n'est configuré (→ repli plateforme dans le service email).
async function loadTenantMail(tenantId: string): Promise<{
  name: string; primaryColor: string; from: string | undefined; smtp: TenantSmtp | null
}> {
  const r = await pool.query<{
    name: string; primary_color: string | null
    sender_email: string | null; sender_name: string | null
    smtp_host: string | null; smtp_port: number | null; smtp_secure: boolean | null
    smtp_user: string | null; smtp_pass_enc: string | null
  }>(
    `SELECT name, primary_color, sender_email, sender_name,
            smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc
     FROM platform.tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  )
  const row = r.rows[0]
  const smtp: TenantSmtp | null = row?.smtp_host
    ? {
        host: row.smtp_host,
        port: row.smtp_port ?? 587,
        secure: row.smtp_secure ?? false,
        user: row.smtp_user,
        pass: decryptIfPresent(row.smtp_pass_enc),
      }
    : null
  return {
    name: row?.name ?? 'Votre entreprise',
    primaryColor: row?.primary_color ?? '#4F46E5',
    from: buildTenantFrom(row?.sender_name, row?.sender_email),
    smtp,
  }
}

// Applique les migrations lazy (legal_entities, variable_elements.month, etc.)
async function ensureMigrated(schemaName: string) {
  try { await provisionTenantSchema(schemaName) } catch { /* ignore */ }
}

const settingsRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /settings/tenant
  fastify.get('/tenant', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      try {
        const res = await pool.query(
          `SELECT id, slug, name, plan_type, status, sector, city, cnps_number,
                  dgi_number, rccm, at_rate, max_users, max_employees,
                  primary_color, secondary_color, logo_url, trial_ends_at,
                  COALESCE(mfa_required, false) AS mfa_required,
                  sender_email, sender_name,
                  created_at, updated_at
           FROM platform.tenants WHERE id = $1`, [tenantId]
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Tenant introuvable' })
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/tenant
  fastify.patch('/tenant', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      // OWASP A03 — validation Zod stricte (refuse champs inconnus, bornes AT,
      // regex hex/CNPS/DGI/RCCM, URL logo http(s) ou data:image uniquement)
      const parsed = patchTenantSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const body = parsed.data as Record<string, unknown>
      const allowed = ['name','primary_color','secondary_color','logo_url','city','cnps_number','dgi_number','rccm','at_rate','mfa_required','sender_email','sender_name']
      const updates: string[] = []
      const values: unknown[] = []
      const changedFields: Record<string, unknown> = {}
      for (const f of allowed) {
        if (f in body) {
          updates.push(`${f} = $${values.length + 1}`)
          values.push(body[f])
          changedFields[f] = body[f]
        }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ modifiable' })
      updates.push(`updated_at = now()`)
      values.push(tenantId)
      try {
        const res = await pool.query(
          `UPDATE platform.tenants SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values
        )
        // OWASP A09 — traçabilité modifications paramétrage critique (CNPS/DGI/AT)
        auditLogSettings(
          request.user.schemaName, request.user.sub, 'settings.tenant_updated',
          tenantId,
          { modifiedFields: Object.keys(changedFields), changes: changedFields },
          request.ip ?? null,
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /settings/legislation — paramétrage légal (pays) du tenant ──────────
  // Retourne le pack législatif appliqué (SMIG, barème impôt, cotisations
  // sociales, conventions/congés) + la liste des pays sélectionnables. Choisir
  // un pays installe automatiquement toute la configuration paie/RH du pays.
  fastify.get('/legislation', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      try {
        const res = await pool.query<{ default_country_code: string | null }>(
          `SELECT default_country_code FROM platform.tenants WHERE id = $1 LIMIT 1`, [tenantId],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Tenant introuvable' })
        return reply.send({ data: buildLegislationConfig(res.rows[0].default_country_code) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── PUT /settings/legislation — applique le pays/pack législatif au tenant ──
  // 100 % automatisé : un seul choix (pays) installe SMIG + barème impôt +
  // cotisations + conventions. OWASP A03 (Zod) / A09 (audité — change de devise,
  // de barème fiscal et de cotisations : impact paie majeur).
  fastify.put('/legislation', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      const legSchema = z.object({
        countryCode: z.string().regex(/^[A-Z]{3}$/, 'Code pays ISO-3 requis'),
      }).strict()
      const parsed = legSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const countryCode = parsed.data.countryCode.toUpperCase()
      // A03 — le pays doit disposer d'un pack législatif connu (sinon paie cassée).
      if (!isSupportedCountry(countryCode)) {
        return reply.status(400).send({ error: 'Pays non pris en charge (aucun pack législatif disponible).' })
      }
      try {
        const before = await pool.query<{ default_country_code: string | null }>(
          `SELECT default_country_code FROM platform.tenants WHERE id = $1 LIMIT 1`, [tenantId],
        )
        if (!before.rows[0]) return reply.status(404).send({ error: 'Tenant introuvable' })
        await pool.query(
          `UPDATE platform.tenants SET default_country_code = $1, updated_at = now() WHERE id = $2`,
          [countryCode, tenantId],
        )
        auditLogSettings(
          request.user.schemaName, request.user.sub, 'settings.legislation_updated', tenantId,
          { before: before.rows[0].default_country_code, after: countryCode },
          request.ip ?? null,
        )
        return reply.send({ data: buildLegislationConfig(countryCode) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /settings/ai — config IA du tenant (clé JAMAIS renvoyée en clair) ──
  // OWASP A02 : on n'expose que la présence d'une clé + son masque (4 derniers).
  fastify.get('/ai', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      try {
        const res = await pool.query<{
          claude_api_key_enc: string | null; claude_model: string | null
          mistral_api_key_enc: string | null; mistral_model: string | null
          preferred_provider: string | null
        }>(
          `SELECT claude_api_key_enc, claude_model, mistral_api_key_enc, mistral_model, preferred_provider
             FROM "${schema}".ai_settings LIMIT 1`,
        )
        const r = res.rows[0]
        const claudeKey  = decryptIfPresent(r?.claude_api_key_enc)
        const mistralKey = decryptIfPresent(r?.mistral_api_key_enc)
        // Catalogue de modèles curé par le super_admin (pour les listes déroulantes).
        const models = await loadAiModels().catch(() => [])
        return reply.send({
          data: {
            claude:  { hasKey: !!claudeKey,  keyMask: maskKey(claudeKey),  model: r?.claude_model ?? null },
            mistral: { hasKey: !!mistralKey, keyMask: maskKey(mistralKey), model: r?.mistral_model ?? null },
            preferredProvider: r?.preferred_provider === 'mistral' ? 'mistral' : 'claude',
            encryptionAvailable: isEncryptionAvailable(),
            // repli plateforme actif si une clé env existe (info pour l'UI)
            platformClaude:  !!config.ai.apiKey,
            platformMistral: !!config.mistral.apiKey,
            models: models.map(m => ({ provider: m.provider, modelId: m.model_id, displayName: m.display_name })),
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── PUT /settings/ai — enregistre clé (chiffrée) + modèle par fournisseur ──
  // OWASP A02 : clés chiffrées AES-256-GCM. A03 : modèle validé contre le
  // catalogue ai_models actif. Champ absent = inchangé ; chaîne vide = effacé.
  fastify.put('/ai', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)

      const aiSchema = z.object({
        claudeApiKey:      z.string().max(300).nullable().optional(),
        mistralApiKey:     z.string().max(300).nullable().optional(),
        claudeModel:       z.string().max(100).nullable().optional(),
        mistralModel:      z.string().max(100).nullable().optional(),
        preferredProvider: z.enum(['claude', 'mistral']).optional(),
      }).strict()
      const parsed = aiSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const b = parsed.data

      // Chiffrement requis pour stocker une clé.
      const wantsKey = (b.claudeApiKey != null && b.claudeApiKey !== '') ||
                       (b.mistralApiKey != null && b.mistralApiKey !== '')
      if (wantsKey && !isEncryptionAvailable()) {
        return reply.status(400).send({
          error: 'Chiffrement non configuré côté plateforme (ENCRYPTION_KEY). Impossible de stocker une clé.',
        })
      }

      // A03 — le modèle choisi doit appartenir au catalogue actif du fournisseur.
      const models = await loadAiModels().catch(() => [])
      const validModel = (provider: 'claude' | 'mistral', model: string | null | undefined): boolean =>
        model == null || model === '' || models.some(m => m.provider === provider && m.model_id === model)
      if (!validModel('claude', b.claudeModel) || !validModel('mistral', b.mistralModel)) {
        return reply.status(400).send({ error: 'Modèle inconnu — choisissez un modèle du catalogue.' })
      }

      // Sentinelle KEEP = champ absent → inchangé. null/'' → effacé. string → posé.
      const KEEP = Symbol('keep')
      const keyVal = (v: string | null | undefined): string | null | typeof KEEP =>
        v === undefined ? KEEP : (v === '' || v === null ? null : encrypt(v))
      const colVal = (v: string | null | undefined): string | null | typeof KEEP =>
        v === undefined ? KEEP : (v === '' ? null : v)

      const fields: Array<{ col: string; val: string | null | typeof KEEP }> = [
        { col: 'claude_api_key_enc',  val: keyVal(b.claudeApiKey) },
        { col: 'mistral_api_key_enc', val: keyVal(b.mistralApiKey) },
        { col: 'claude_model',        val: colVal(b.claudeModel) },
        { col: 'mistral_model',       val: colVal(b.mistralModel) },
        { col: 'preferred_provider',  val: b.preferredProvider === undefined ? KEEP : b.preferredProvider },
      ]

      try {
        const existing = await pool.query<{ id: string }>(`SELECT id FROM "${schema}".ai_settings LIMIT 1`)
        if (!existing.rows[0]) {
          // INSERT : KEEP → valeur par défaut (null, sauf preferred_provider='claude')
          await pool.query(
            `INSERT INTO "${schema}".ai_settings
               (claude_api_key_enc, mistral_api_key_enc, claude_model, mistral_model, preferred_provider)
             VALUES ($1, $2, $3, $4, $5)`,
            fields.map(f => f.val === KEEP ? (f.col === 'preferred_provider' ? 'claude' : null) : f.val),
          )
        } else {
          const sets: string[] = []
          const vals: unknown[] = []
          for (const f of fields) {
            if (f.val === KEEP) continue
            sets.push(`${f.col} = $${vals.length + 1}`)
            vals.push(f.val)
          }
          if (sets.length) {
            sets.push('updated_at = now()')
            vals.push(existing.rows[0].id)
            await pool.query(
              `UPDATE "${schema}".ai_settings SET ${sets.join(', ')} WHERE id = $${vals.length}`,
              vals,
            )
          }
        }

        // OWASP A09 — trace SANS la valeur des clés (uniquement quels champs changés).
        auditLogSettings(
          schema, request.user.sub, 'settings.ai_updated', schema,
          {
            changed: fields.filter(f => f.val !== KEEP).map(f => f.col),
            claudeKeySet:  b.claudeApiKey != null && b.claudeApiKey !== '',
            mistralKeySet: b.mistralApiKey != null && b.mistralApiKey !== '',
          },
          request.ip ?? null,
        )
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /settings/email — config expéditeur + SMTP tenant (mdp jamais renvoyé) ──
  fastify.get('/email', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      try {
        const r = await pool.query<{
          sender_email: string | null; sender_name: string | null
          smtp_host: string | null; smtp_port: number | null; smtp_secure: boolean | null
          smtp_user: string | null; smtp_pass_enc: string | null
        }>(
          `SELECT sender_email, sender_name, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc
             FROM platform.tenants WHERE id = $1 LIMIT 1`, [tenantId],
        )
        const t = r.rows[0]
        if (!t) return reply.status(404).send({ error: 'Tenant introuvable' })
        return reply.send({
          data: {
            senderEmail: t.sender_email ?? null,
            senderName: t.sender_name ?? null,
            smtpHost: t.smtp_host ?? null,
            smtpPort: t.smtp_port ?? null,
            smtpSecure: t.smtp_secure ?? false,
            smtpUser: t.smtp_user ?? null,
            hasPassword: !!t.smtp_pass_enc,
            smtpConfigured: !!t.smtp_host,
            encryptionAvailable: isEncryptionAvailable(),
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // Schéma d'un modèle (scope groupe ou pays) pour le constructeur par blocs.
  const PAYSLIP_BLOCK = z.object({
    id: z.string().max(40), enabled: z.boolean().optional(), text: z.string().max(2000).optional(),
  })
  const PAYSLIP_SCOPE = z.object({
    accentColor:      z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur hex #RRGGBB attendue').nullable().optional(),
    logoAssetId:      z.string().uuid().nullable().optional(),
    showBaseColumn:   z.boolean().optional(),
    showCodeColumn:   z.boolean().optional(),
    showEmployerCost: z.boolean().optional(),
    showAnnualCumuls: z.boolean().optional(),
    footerText:       z.string().max(400).nullable().optional(),
    blocks:           z.array(PAYSLIP_BLOCK).max(20).optional(),
  }).strict()
  const PAYSLIP_CONFIG = PAYSLIP_SCOPE.extend({
    byCountry: z.record(z.string().min(2).max(3), PAYSLIP_SCOPE).optional(),
  }).strict()

  // ── GET /settings/payslip-template — modèle + détection auto mono/multi-pays ─
  fastify.get('/payslip-template', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      const r = await pool.query<{
        payslip_config: unknown; primary_color: string | null
        has_subsidiaries: boolean | null; default_country_code: string | null
      }>(
        `SELECT payslip_config, primary_color, has_subsidiaries, default_country_code
           FROM platform.tenants WHERE id = $1 LIMIT 1`, [tenantId],
      )
      const t = r.rows[0]
      if (!t) return reply.status(404).send({ error: 'Tenant introuvable' })
      const cfg = (t.payslip_config && typeof t.payslip_config === 'object' ? t.payslip_config as Record<string, unknown> : {})
      // Détection automatique : pays distincts des filiales actives. Le système
      // décide seul mono- vs multi-pays (pas de saisie manuelle).
      let countries: string[] = []
      if (t.has_subsidiaries) {
        const ce = await pool.query<{ country_code: string }>(
          `SELECT DISTINCT country_code FROM "${request.user.schemaName}".legal_entities
            WHERE is_active = true AND country_code IS NOT NULL ORDER BY country_code`,
        ).catch(() => ({ rows: [] as Array<{ country_code: string }> }))
        countries = ce.rows.map(x => x.country_code)
      }
      return reply.send({
        data: {
          multiCountry: !!t.has_subsidiaries && countries.length > 1,
          countries,
          defaultCountry: t.default_country_code ?? 'CIV',
          defaultAccent: t.primary_color ?? '#E85D04',
          assetBase: `${config.apiUrl}/public/brand/`,
          config: cfg,
        },
      })
    },
  })

  // ── PUT /settings/payslip-template — enregistre le modèle complet (admin) ────
  // Remplace payslip_config par la config postée (groupe + byCountry + blocs).
  fastify.put('/payslip-template', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      const parsed = PAYSLIP_CONFIG.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      await pool.query(
        `UPDATE platform.tenants SET payslip_config = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(parsed.data), tenantId],
      )
      auditLogSettings(request.user.schemaName, request.user.sub, 'settings.payslip_template_updated',
        tenantId, { byCountry: Object.keys(parsed.data.byCountry ?? {}) }, request.ip)
      return reply.send({ data: { ok: true } })
    },
  })

  // ── POST /settings/payslip-template/preview — aperçu PDF d'un modèle (live) ──
  fastify.post('/payslip-template/preview', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      const parsed = PAYSLIP_SCOPE.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      const b = parsed.data
      const tRes = await pool.query<{ name: string; cnps_number: string | null; city: string | null }>(
        `SELECT name, cnps_number, city FROM platform.tenants WHERE id = $1 LIMIT 1`, [tenantId],
      )
      const t = tRes.rows[0]
      let logo: { bytes: Uint8Array; mime: string } | null = null
      if (b.logoAssetId) {
        const a = await pool.query<{ bytes: Buffer; mime: string }>(
          `SELECT bytes, mime FROM platform.brand_assets WHERE id = $1 LIMIT 1`, [b.logoAssetId],
        ).catch(() => ({ rows: [] as Array<{ bytes: Buffer; mime: string }> }))
        if (a.rows[0] && !/svg/i.test(a.rows[0].mime)) logo = { bytes: new Uint8Array(a.rows[0].bytes), mime: a.rows[0].mime }
      }
      // Bulletin d'exemple (données fictives) rendu avec le modèle en cours d'édition.
      const pdf = await renderPayslipPdf({
        tenantName: t?.name ?? 'Votre entreprise',
        employer: { cnpsNumber: t?.cnps_number ?? 'CI-0000000-X', city: t?.city ?? 'Abidjan' },
        employee: { firstName: 'Awa', lastName: 'Koné', jobTitle: 'Exemple', cnpsNumber: 'CI-1234567', nni: 'CI000000001' },
        month: '2025-05',
        lines: [
          { code: '1000', label: 'Salaire de base', type: 'earning', base: 250000, amount: 250000 },
          { code: '1300', label: 'Prime de transport', type: 'earning', base: null, amount: 30000 },
          { code: '2000', label: 'CNPS Retraite (6,3%)', type: 'employee_contribution', base: 250000, amount: 15750 },
          { code: '2100', label: 'ITS', type: 'employee_contribution', base: null, amount: 3200 },
          { code: '3300', label: 'CNPS Accidents du travail', type: 'employer_contribution', base: 70000, amount: 2100 },
        ],
        grossSalary: 280000, totalCnpsSal: 15750, its: 3200, totalDeductions: 18950,
        netPayable: 261050, employerCost: 312000, currency: 'XOF',
        paymentMethod: 'Wave', paymentReference: 'APERCU-0001', generatedAt: '2025-05-31',
        annualCumuls: { grossSalary: 1400000, totalCnpsSal: 78750, its: 16000, netPayable: 1305250 },
        template: {
          accentColor: b.accentColor ?? null, logo,
          showBaseColumn: b.showBaseColumn !== false,
          showCodeColumn: b.showCodeColumn !== false,
          showEmployerCost: b.showEmployerCost !== false,
          showAnnualCumuls: b.showAnnualCumuls !== false,
          footerText: b.footerText ?? null,
          blocks: b.blocks,
        },
      })
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'inline; filename="apercu-bulletin.pdf"')
        .send(Buffer.from(pdf))
    },
  })

  // ── POST /settings/payslip-template/logo — logo raster du bulletin (admin) ──
  fastify.post('/payslip-template/logo', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      const file = await request.file()
      if (!file) return reply.status(400).send({ error: 'Aucun fichier reçu.' })
      // pdf-lib n'embarque que le raster : on impose PNG/JPEG (SVG refusé).
      if (!['image/png', 'image/jpeg'].includes(file.mimetype)) {
        return reply.status(400).send({ error: 'Format non supporté : logo PNG ou JPEG attendu (le SVG n\'est pas embarquable dans le PDF).' })
      }
      const buf = await file.toBuffer()
      if (buf.length > 1_000_000) return reply.status(400).send({ error: 'Logo trop volumineux (max 1 Mo).' })
      // Stocke l'image et renvoie l'id : le constructeur l'affecte au modèle
      // (groupe ou pays) puis l'enregistre via PUT — pas d'écriture config ici.
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO platform.brand_assets (mime, bytes) VALUES ($1, $2) RETURNING id`, [file.mimetype, buf],
      )
      const assetId = ins.rows[0]!.id
      auditLogSettings(request.user.schemaName, request.user.sub, 'settings.payslip_logo_uploaded', tenantId, {}, request.ip)
      return reply.send({ data: { logoAssetId: assetId, logoUrl: `${config.apiUrl}/public/brand/${assetId}` } })
    },
  })

  // ── PUT /settings/email — enregistre le SMTP tenant (mot de passe chiffré) ──
  // OWASP A02 : mot de passe SMTP chiffré AES-256-GCM. Sentinelle KEEP : champ
  // absent = inchangé ; '' / null = effacé. A09 : audité (sans le mot de passe).
  fastify.put('/email', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      const emailSchema = z.object({
        smtpHost:     z.string().max(255).nullable().optional(),
        smtpPort:     z.number().int().min(1).max(65535).nullable().optional(),
        smtpSecure:   z.boolean().optional(),
        smtpUser:     z.string().max(255).nullable().optional(),
        smtpPassword: z.string().max(300).nullable().optional(),
      }).strict()
      const parsed = emailSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const b = parsed.data
      if (b.smtpPassword != null && b.smtpPassword !== '' && !isEncryptionAvailable()) {
        return reply.status(400).send({
          error: 'Chiffrement non configuré côté plateforme (ENCRYPTION_KEY). Impossible de stocker le mot de passe SMTP.',
        })
      }

      const KEEP = Symbol('keep')
      type Val = string | number | boolean | null | typeof KEEP
      const norm = (v: string | null | undefined): Val => v === undefined ? KEEP : (v === '' ? null : v)
      const fields: Array<{ col: string; val: Val }> = [
        { col: 'smtp_host',     val: norm(b.smtpHost) },
        { col: 'smtp_port',     val: b.smtpPort === undefined ? KEEP : (b.smtpPort ?? null) },
        { col: 'smtp_secure',   val: b.smtpSecure === undefined ? KEEP : b.smtpSecure },
        { col: 'smtp_user',     val: norm(b.smtpUser) },
        { col: 'smtp_pass_enc', val: b.smtpPassword === undefined ? KEEP : (b.smtpPassword === '' || b.smtpPassword === null ? null : encrypt(b.smtpPassword)) },
      ]
      const sets: string[] = []
      const vals: unknown[] = []
      for (const f of fields) {
        if (f.val === KEEP) continue
        sets.push(`${f.col} = $${vals.length + 1}`)
        vals.push(f.val)
      }
      if (!sets.length) return reply.status(400).send({ error: 'Aucun champ' })
      sets.push('updated_at = now()')
      vals.push(tenantId)
      try {
        await pool.query(`UPDATE platform.tenants SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals)
        auditLogSettings(
          request.user.schemaName, request.user.sub, 'settings.email_smtp_updated', tenantId,
          {
            changed: fields.filter(f => f.val !== KEEP).map(f => f.col),
            passwordSet: b.smtpPassword != null && b.smtpPassword !== '',
          },
          request.ip ?? null,
        )
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/users
  fastify.get('/users', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`
          SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.is_active,
            u.last_login_at, u.created_at,
            e.id AS employee_id, e.job_title
          FROM "${schema}".users u
          LEFT JOIN "${schema}".employees e ON e.id = u.employee_id
          ORDER BY u.created_at DESC
        `)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/users
  fastify.post('/users', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as {
        email: string; first_name: string; last_name: string
        role?: string; department_id?: string; is_active?: boolean
      }
      try {
        const tempPassword = generateTempPassword()
        const hash = await bcrypt.hash(tempPassword, 12)
        const isActive = body.is_active !== false

        // Si un département est fourni, créer/lier un employé
        let employeeId: string | null = null
        if (body.department_id) {
          // Vérifier s'il existe déjà un employé avec cet email
          const existing = await pool.query(
            `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [body.email]
          )
          if (existing.rows[0]) {
            employeeId = existing.rows[0].id as string
            await pool.query(
              `UPDATE "${schema}".employees SET department_id = $1, updated_at = now() WHERE id = $2`,
              [body.department_id, employeeId]
            )
          } else {
            // Squelette d'employé aligné sur le plancher SMIG contrôlé par
            // POST/PATCH /employees (75 000 FCFA) — l'ancien 60 000 créait un
            // dossier invalide impossible à re-sauvegarder.
            const emp = await pool.query(`
              INSERT INTO "${schema}".employees
                (first_name, last_name, email, hire_date, is_active, job_title, base_salary, contract_type, department_id)
              VALUES ($1,$2,$3,NOW(),$4,'Employé',75000,'cdi',$5) RETURNING id
            `, [body.first_name, body.last_name, body.email, isActive, body.department_id])
            employeeId = emp.rows[0].id as string
          }
        }

        const res = await pool.query(`
          INSERT INTO "${schema}".users
            (email, password_hash, first_name, last_name, role, is_active, employee_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          RETURNING id, email, first_name, last_name, role, is_active, created_at
        `, [body.email, hash, body.first_name, body.last_name, body.role ?? 'employee', isActive, employeeId])

        // Lier l'employee_id si créé
        if (employeeId) {
          await pool.query(
            `UPDATE "${schema}".users SET employee_id = $1 WHERE id = $2`,
            [employeeId, res.rows[0].id]
          )
        }

        return reply.status(201).send({ data: res.rows[0], tempPassword })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur lors de la création' })
      }
    },
  })

  // PATCH /settings/users/:id
  fastify.patch('/users/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const { role, is_active } = request.body as { role?: string; is_active?: boolean }

      // OWASP A01 (escalade de privilège) — un admin de tenant ne peut attribuer
      // QUE des rôles tenant. 'super_admin' (plateforme) est interdit : sinon un
      // admin pourrait se hisser au niveau plateforme via un simple PATCH.
      const TENANT_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'raf_site', 'dg']
      if (role !== undefined && !TENANT_ROLES.includes(role)) {
        return reply.status(400).send({ error: 'Rôle invalide (rôles tenant uniquement)' })
      }

      const updates: string[] = []
      const values: unknown[] = []
      if (role !== undefined)      { updates.push(`role = $${values.length + 1}`); values.push(role) }
      if (is_active !== undefined) { updates.push(`is_active = $${values.length + 1}`); values.push(is_active) }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        // OWASP A09 — snapshot AVANT pour tracer le before/after (changement de
        // rôle = action sensible auditée).
        const before = await pool.query<{ role: string; is_active: boolean }>(
          `SELECT role, is_active FROM "${schema}".users WHERE id = $1`, [id],
        )
        if (!before.rows[0]) return reply.status(404).send({ error: 'Utilisateur introuvable' })

        const res = await pool.query(
          `UPDATE "${schema}".users SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING id, email, role, is_active`,
          values
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Utilisateur introuvable' })

        const roleChanged = role !== undefined && role !== before.rows[0].role
        auditLogSettings(
          schema, request.user.sub,
          roleChanged ? 'user.role_changed' : 'user.updated', id,
          {
            before: { role: before.rows[0].role, isActive: before.rows[0].is_active },
            after:  { role: role ?? before.rows[0].role, isActive: is_active ?? before.rows[0].is_active },
          },
          request.ip ?? null,
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/absence-types
  fastify.get('/absence-types', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`SELECT * FROM "${schema}".absence_types ORDER BY code`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/departments
  fastify.get('/departments', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`
          SELECT d.*, COUNT(e.id)::int AS employees_count
          FROM "${schema}".departments d
          LEFT JOIN "${schema}".employees e ON e.department_id = d.id AND e.is_active = true
          GROUP BY d.id ORDER BY d.name
        `)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/departments
  fastify.post('/departments', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as { name: string; code?: string; manager_id?: string }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".departments (name, code, manager_id)
          VALUES ($1,$2,$3) RETURNING *
        `, [body.name, body.code || null, body.manager_id || null])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/departments/:id
  fastify.patch('/departments/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as { name?: string; code?: string; manager_id?: string }
      const updates: string[] = []
      const values: unknown[] = []
      if (body.name !== undefined)       { updates.push(`name = $${values.length + 1}`);       values.push(body.name) }
      if (body.code !== undefined)       { updates.push(`code = $${values.length + 1}`);       values.push(body.code) }
      if (body.manager_id !== undefined) { updates.push(`manager_id = $${values.length + 1}`); values.push(body.manager_id) }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".departments SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/departments/:id
  fastify.delete('/departments/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const check = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM "${schema}".employees WHERE department_id = $1 AND is_active = true`, [id]
        )
        if ((check.rows[0]?.cnt ?? 0) > 0) {
          return reply.status(409).send({ error: 'Ce departement contient des employes actifs' })
        }
        await pool.query(`DELETE FROM "${schema}".departments WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/absence-types
  fastify.post('/absence-types', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as {
        code: string; label: string; color?: string
        requires_approval?: boolean; max_days_per_year?: number
        is_paid?: boolean; calculation_mode?: string
      }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".absence_types
            (code, label, color, requires_approval, max_days_per_year, is_paid, calculation_mode)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
        `, [body.code, body.label, body.color || '#6366F1',
            body.requires_approval ?? true, body.max_days_per_year || null,
            body.is_paid ?? true, body.calculation_mode || 'working_days'])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/absence-types/:id
  fastify.patch('/absence-types/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const allowed = ['label','color','requires_approval','max_days_per_year','is_paid','calculation_mode','is_active']
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of allowed) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(body[f]) }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".absence_types SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/absence-types/:id
  fastify.delete('/absence-types/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const check = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM "${schema}".absences WHERE absence_type_id = $1`, [id]
        )
        if ((check.rows[0]?.cnt ?? 0) > 0) {
          return reply.status(409).send({ error: 'Ce type est utilise par des absences existantes' })
        }
        await pool.query(`DELETE FROM "${schema}".absence_types WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/payroll-rules
  fastify.get('/payroll-rules', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`SELECT * FROM "${schema}".payroll_rules ORDER BY "order", code`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/payroll-rules
  fastify.post('/payroll-rules', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 — Zod stricte (type enum, rate borné -10..10, code max 20)
      const parsed = createPayrollRuleSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const body = parsed.data
      try {
        const res = await pool.query<{ id: string }>(`
          INSERT INTO "${schema}".payroll_rules
            (code, name, type, formula, rate, ceiling_type, is_active, "order", description)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
        `, [body.code, body.name, body.type, body.formula ?? null,
            body.rate ?? null, body.ceiling_type ?? null,
            body.is_active ?? true, body.order ?? 99, body.description ?? null])
        const created = res.rows[0]
        // OWASP A09 — création règle de paie = action critique (taux cotisation)
        auditLogSettings(
          schema, request.user.sub, 'settings.payroll_rule_created',
          created?.id ?? null,
          { code: body.code, type: body.type, rate: body.rate, name: body.name },
          request.ip ?? null,
        )
        return reply.status(201).send({ data: created })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/payroll-rules/:id
  fastify.patch('/payroll-rules/:id', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      // OWASP A03 — UUID validation
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      // OWASP A03 — Zod stricte (rate borné, refus champs inconnus)
      const parsed = patchPayrollRuleSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const body = parsed.data as Record<string, unknown>
      const allowed = ['name','formula','rate','ceiling_type','is_active','order','description']
      const updates: string[] = []
      const values: unknown[] = []
      const changedFields: Record<string, unknown> = {}
      for (const f of allowed) {
        if (f in body) {
          updates.push(`${f === 'order' ? '"order"' : f} = $${values.length + 1}`)
          values.push(body[f])
          changedFields[f] = body[f]
        }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".payroll_rules SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values
        )
        // OWASP A09 — traçabilité modification règle paie (modif rate = impact direct cotisations)
        auditLogSettings(
          schema, request.user.sub, 'settings.payroll_rule_updated',
          id,
          { modifiedFields: Object.keys(changedFields), changes: changedFields },
          request.ip ?? null,
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/payroll-rules/:id
  fastify.delete('/payroll-rules/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        await pool.query(`DELETE FROM "${schema}".payroll_rules WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/legal-entities
  fastify.get('/legal-entities', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      try {
        const res = await pool.query(`
          SELECT le.*, COUNT(e.id)::int AS employees_count
          FROM "${schema}".legal_entities le
          LEFT JOIN "${schema}".employees e ON e.legal_entity_id = le.id AND e.is_active = true AND e.deleted_at IS NULL
          GROUP BY le.id ORDER BY le.name
        `)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/legal-entities
  fastify.post('/legal-entities', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      // OWASP A03 + A04 — Zod (at_rate borné 0.02-0.05, name max 200, regex CNPS/DGI/RCCM)
      const parsed = createLegalEntitySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const body = parsed.data
      try {
        const res = await pool.query<{ id: string }>(`
          INSERT INTO "${schema}".legal_entities
            (name, rccm, cnps_number, dgi_number, address, city, legal_form,
             collective_agreement, at_rate, country_code, legislation_pack_code)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [body.name, body.rccm ?? null, body.cnps_number ?? null, body.dgi_number ?? null,
            body.address ?? null, body.city ?? 'Abidjan', body.legal_form ?? 'SARL',
            body.collective_agreement ?? null, body.at_rate ?? 0.02,
            body.country_code ?? 'CIV', body.legislation_pack_code ?? null])
        const created = res.rows[0]
        // Déclarer une filiale active le workflow paie multi-filiales du tenant :
        // sinon le lien « Paie multi-filiales » (qui porte l'initiation du draft)
        // reste masqué dans la sidebar (conditionné à tenantConfig.hasSubsidiaries).
        // Idempotent (ne réécrit que si false), non bloquant — un échec de cette
        // mise à jour secondaire ne doit jamais faire échouer la création.
        try {
          await pool.query(
            `UPDATE platform.tenants
                SET has_subsidiaries = true, payroll_mode = 'multi_country', updated_at = now()
              WHERE schema_name = $1 AND has_subsidiaries = false`,
            [schema],
          )
        } catch { /* non bloquant */ }
        // OWASP A09 — création d'entité légale = action critique (numéros CNPS/DGI officiels)
        auditLogSettings(
          schema, request.user.sub, 'settings.legal_entity_created',
          created?.id ?? null,
          { name: body.name, cnpsNumber: body.cnps_number, dgiNumber: body.dgi_number, atRate: body.at_rate },
          request.ip ?? null,
        )
        return reply.status(201).send({ data: created })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/legal-entities/:id
  fastify.patch('/legal-entities/:id', {
    preHandler: [fastify.authorize('admin')],
    config: SETTINGS_WRITE_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      const { id } = request.params as { id: string }
      // OWASP A03 — UUID validation
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      // OWASP A03 + A04 — Zod (at_rate borné, regex CNPS/DGI/RCCM)
      const parsed = patchLegalEntitySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const body = parsed.data as Record<string, unknown>
      const allowed = ['name','rccm','cnps_number','dgi_number','address','city',
        'legal_form','collective_agreement','at_rate','country_code','legislation_pack_code','is_active']
      const updates: string[] = []
      const values: unknown[] = []
      const changedFields: Record<string, unknown> = {}
      for (const f of allowed) {
        if (f in body) {
          updates.push(`${f} = $${values.length + 1}`)
          values.push(body[f])
          changedFields[f] = body[f]
        }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".legal_entities SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values
        )
        // OWASP A09 — traçabilité modifications entité légale
        auditLogSettings(
          schema, request.user.sub, 'settings.legal_entity_updated',
          id,
          { modifiedFields: Object.keys(changedFields), changes: changedFields },
          request.ip ?? null,
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/legal-entities/:id
  fastify.delete('/legal-entities/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const check = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM "${schema}".employees WHERE legal_entity_id = $1 AND is_active = true`, [id]
        )
        if ((check.rows[0]?.cnt ?? 0) > 0) {
          return reply.status(409).send({ error: 'Cette entite a des employes actifs' })
        }
        await pool.query(`DELETE FROM "${schema}".legal_entities WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/workflow
  fastify.get('/workflow', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`SELECT * FROM "${schema}".workflow_configs ORDER BY module`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/workflow
  fastify.patch('/workflow', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 — le corps DOIT être un tableau de configs ; sans validation un
      // corps non-itérable (objet) faisait planter le for...of → 500. → 400 propre.
      const workflowSchema = z.array(z.object({
        module:       z.string().min(1).max(50),
        levels_count: z.number().int().min(1).max(10),
      })).max(50)
      const parsed = workflowSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Configuration workflow invalide', issues: parsed.error.flatten() })
      }
      const configs = parsed.data
      try {
        for (const cfg of configs) {
          await pool.query(`
            INSERT INTO "${schema}".workflow_configs (module, levels_count)
            VALUES ($1,$2)
            ON CONFLICT (module) DO UPDATE SET levels_count = EXCLUDED.levels_count
          `, [cfg.module, cfg.levels_count])
        }
        const res = await pool.query(`SELECT * FROM "${schema}".workflow_configs ORDER BY module`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/variable-elements
  fastify.get('/variable-elements', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      const { month } = request.query as { month?: string }
      try {
        const res = await pool.query(`
          SELECT ve.*, e.first_name, e.last_name, e.employee_number AS registration_number
          FROM "${schema}".variable_elements ve
          JOIN "${schema}".employees e ON e.id = ve.employee_id
          WHERE ($1::text IS NULL OR ve.month = $1)
          ORDER BY e.last_name, e.first_name, ve.rule_code
        `, [month || null])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/variable-elements
  fastify.post('/variable-elements', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as {
        employee_id: string; rule_code: string; amount: number; month: string; description?: string
      }
      try {
        // Le moteur de paie lit les éléments variables par period_id (colonne
        // NOT NULL) : on résout la période depuis le mois. Sans période ouverte
        // pour ce mois → 400 clair (au lieu d'un 500 NOT NULL).
        const per = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".pay_periods WHERE month = $1 LIMIT 1`, [body.month],
        )
        const periodId = per.rows[0]?.id
        if (!periodId) {
          return reply.status(400).send({ error: `Aucune période de paie pour le mois ${body.month}. Créez d'abord la période.` })
        }
        const res = await pool.query(`
          INSERT INTO "${schema}".variable_elements
            (employee_id, period_id, rule_code, amount, month, description)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (employee_id, rule_code, month)
            DO UPDATE SET amount = EXCLUDED.amount, description = EXCLUDED.description, period_id = EXCLUDED.period_id
          RETURNING *
        `, [body.employee_id, periodId, body.rule_code, body.amount, body.month, body.description || null])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/variable-elements/:id
  fastify.delete('/variable-elements/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        await pool.query(`DELETE FROM "${schema}".variable_elements WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/users/:id
  fastify.delete('/users/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (id === request.user.sub) return reply.status(400).send({ error: 'Impossible de supprimer votre propre compte' })
      try {
        await pool.query(`DELETE FROM "${schema}".users WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/users/:id/reset-password — réinitialise le mot de passe et renvoie l'email
  fastify.post('/users/:id/reset-password', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const tenantId = request.user.tenantId
      try {
        const userRes = await pool.query(
          `SELECT email, first_name, last_name FROM "${schema}".users WHERE id = $1 LIMIT 1`, [id]
        )
        const user = userRes.rows[0] as { email: string; first_name: string; last_name: string } | undefined
        if (!user) return reply.status(404).send({ error: 'Utilisateur introuvable' })

        const tempPassword = generateTempPassword()
        const hash = await bcrypt.hash(tempPassword, 12)
        await pool.query(
          `UPDATE "${schema}".users SET password_hash = $1, last_login_at = NULL, updated_at = now() WHERE id = $2`,
          [hash, id]
        )

        // Essayer d'envoyer l'email (non bloquant)
        let emailSent = false
        if (tenantId) {
          try {
            const mail = await loadTenantMail(tenantId)
            await sendEmployeeWelcomeEmail({
              to: user.email,
              firstName: user.first_name,
              lastName: user.last_name,
              tenantName: mail.name,
              primaryColor: mail.primaryColor,
              loginUrl: config.appUrl ?? 'http://localhost:3001',
              tempPassword,
              from: mail.from,
              replyTo: mail.from,
              smtp: mail.smtp,
            })
            emailSent = true
          } catch (emailErr) {
            fastify.log.warn({ emailErr }, 'reset-password email failed')
          }
        }

        return reply.send({ tempPassword, emailSent })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /settings/import/users-status ──────────────────────────────────────
  fastify.get('/import/users-status', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`
          SELECT COUNT(*) AS total_employees,
            (SELECT COUNT(*) FROM "${schema}".users WHERE role = 'employee') AS total_users
          FROM "${schema}".employees WHERE is_active = true AND email IS NOT NULL AND email != ''
        `)
        const total = parseInt(res.rows[0]?.total_employees ?? '0')
        const withAccount = parseInt(res.rows[0]?.total_users ?? '0')
        return reply.send({ data: { totalEmployees: total, withAccount, withoutAccount: total - withAccount } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /settings/import/generate-users ────────────────────────────────────
  fastify.post('/import/generate-users', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })

      try {
        // Récupérer infos tenant pour l'email
        const mail = await loadTenantMail(tenantId)
        const tenantName = mail.name
        const primaryColor = mail.primaryColor
        const loginUrl = config.appUrl ?? 'http://localhost:3001'
        // Expéditeur + SMTP propre au tenant (repli plateforme si absent).
        const from = mail.from
        const tenantSmtp = mail.smtp

        // Employés actifs sans compte utilisateur
        const empRes = await pool.query(`
          SELECT e.id, e.first_name, e.last_name, e.email
          FROM "${schema}".employees e
          WHERE e.is_active = true
            AND e.email IS NOT NULL AND e.email != ''
            AND NOT EXISTS (SELECT 1 FROM "${schema}".users u WHERE u.email = e.email)
          ORDER BY e.last_name, e.first_name
        `)
        const employees = empRes.rows as Array<{ id: string; first_name: string; last_name: string; email: string }>

        if (employees.length === 0) {
          return reply.send({ created: 0, emailSent: 0, emailFailed: 0, skipped: 0,
            message: 'Tous les employés actifs ont déjà un compte.' })
        }

        let created = 0
        let emailSent = 0
        let emailFailed = 0
        let emailError: string | null = null
        const BATCH_SIZE = 20

        for (let i = 0; i < employees.length; i += BATCH_SIZE) {
          const batch = employees.slice(i, i + BATCH_SIZE)

          // Générer et insérer les comptes en une seule transaction par batch
          const emailJobs: Array<{ emp: typeof batch[0]; tempPassword: string }> = []

          for (const emp of batch) {
            const tempPassword = generateTempPassword()
            const passwordHash = await bcrypt.hash(tempPassword, 12)
            try {
              await pool.query(`
                INSERT INTO "${schema}".users (email, password_hash, first_name, last_name, role, is_active, employee_id)
                VALUES ($1,$2,$3,$4,'employee',true,$5)
                ON CONFLICT (email) DO NOTHING
              `, [emp.email, passwordHash, emp.first_name, emp.last_name, emp.id])
              created++
              emailJobs.push({ emp, tempPassword })
            } catch {
              // doublon ou erreur → skip
            }
          }

          // Envoyer les emails du batch en parallèle
          const results = await Promise.allSettled(
            emailJobs.map(({ emp, tempPassword }) =>
              sendEmployeeWelcomeEmail({
                to: emp.email,
                firstName: emp.first_name,
                lastName: emp.last_name,
                tenantName,
                primaryColor,
                loginUrl,
                tempPassword,
                from,
                replyTo: from,
                smtp: tenantSmtp,
              })
            )
          )
          emailSent += results.filter(r => r.status === 'fulfilled').length
          const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
          emailFailed += rejected.length
          if (rejected.length > 0) {
            const first = rejected[0]
            const msg = first ? ((first.reason as Error | undefined)?.message ?? 'Erreur SMTP inconnue') : 'Erreur SMTP inconnue'
            fastify.log.error({ smtpError: msg }, 'Email batch failed')
            if (!emailError) emailError = msg
          }

          // Pause courte entre batches pour ne pas saturer le SMTP
          if (i + BATCH_SIZE < employees.length) {
            await new Promise(r => setTimeout(r, 300))
          }
        }

        return reply.send({
          created,
          emailSent,
          emailFailed,
          emailError,
          skipped: employees.length - created,
          total: employees.length,
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur lors de la génération des accès' })
      }
    },
  })

  // ── POST /settings/import/:type ─────────────────────────────────────────────
  fastify.post('/import/:type', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    config: IMPORT_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { type } = request.params as { type: string }
      // OWASP A03 — whitelist du type d'import (refus de "users", "tokens", etc.)
      if (!(IMPORT_TYPES as readonly string[]).includes(type)) {
        return reply.status(400).send({ error: `Type d'import invalide (autorisés : ${IMPORT_TYPES.join(', ')})` })
      }
      // OWASP A03 + A04 — Zod (cap 50 colonnes × 10 000 lignes pour éviter
      // DoS memory + traitement O(headers × rows))
      const parsed = importBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(413).send({
          error: `Fichier vide ou trop volumineux (max ${IMPORT_MAX_HEADERS} colonnes × ${IMPORT_MAX_ROWS} lignes)`,
          issues: parsed.error.flatten(),
        })
      }
      const { headers, rows } = parsed.data

      const idx = (col: string) => headers.indexOf(col)
      const get = (row: string[], col: string) => row[idx(col)]?.trim() ?? ''
      const toDate = (v: string) => {
        if (!v) return null
        // DD/MM/YYYY → YYYY-MM-DD
        const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
        if (m) { const [, d, mo, y] = m; if (d && mo && y) return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}` }
        return v // déjà au bon format
      }

      let inserted = 0
      let skipped = 0
      const errors: string[] = []

      try {
        if (type === 'employees') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email')
            if (!email) { errors.push(`Ligne ${i + 2}: email manquant`); skipped++; continue }
            const deptName = get(row, 'departement')
            let deptId: string | null = null
            if (deptName) {
              const d = await pool.query(`SELECT id FROM "${schema}".departments WHERE name ILIKE $1 LIMIT 1`, [deptName])
              deptId = d.rows[0]?.id ?? null
            }
            try {
              await pool.query(`
                INSERT INTO "${schema}".employees
                  (first_name, last_name, email, birth_date, phone, job_title, department_id,
                   hire_date, base_salary, contract_type, is_active, gender, cnps_number, city,
                   weekly_hours, professional_category, iban, bank_name)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                ON CONFLICT (email) DO UPDATE SET
                  first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
                  birth_date=EXCLUDED.birth_date, phone=EXCLUDED.phone,
                  job_title=EXCLUDED.job_title, department_id=EXCLUDED.department_id,
                  hire_date=EXCLUDED.hire_date, base_salary=EXCLUDED.base_salary,
                  contract_type=EXCLUDED.contract_type, is_active=EXCLUDED.is_active,
                  gender=EXCLUDED.gender, cnps_number=EXCLUDED.cnps_number,
                  city=EXCLUDED.city,
                  weekly_hours=EXCLUDED.weekly_hours,
                  professional_category=COALESCE(EXCLUDED.professional_category, "${schema}".employees.professional_category),
                  iban=COALESCE(EXCLUDED.iban, "${schema}".employees.iban),
                  bank_name=COALESCE(EXCLUDED.bank_name, "${schema}".employees.bank_name),
                  updated_at=now()
              `, [
                get(row, 'prenom'), get(row, 'nom'), email,
                toDate(get(row, 'date_naissance')), get(row, 'telephone') || null,
                get(row, 'poste') || 'Employé', deptId,
                toDate(get(row, 'date_embauche')) || new Date().toISOString().slice(0, 10),
                parseInt(get(row, 'salaire_brut')) || 75000,
                (get(row, 'type_contrat') || 'cdi').toLowerCase(),
                get(row, 'statut') !== 'inactive',
                get(row, 'sexe') || null,
                get(row, 'numero_cnps') || null,
                get(row, 'ville') || 'Abidjan',
                // Temps de travail hebdo (base CI 40h) + catégorie conventionnelle
                parseFloat(get(row, 'heures_hebdo')) || 40,
                get(row, 'categorie') || null,
                // RGPD — RIB chiffré AES-256 (même traitement que le NNI)
                encryptIfPresent(get(row, 'iban') || undefined),
                get(row, 'banque') || null,
              ])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2} (${email}): ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'departments') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const name = get(row, 'nom')
            if (!name) { skipped++; continue }
            const ex = await pool.query(`SELECT id FROM "${schema}".departments WHERE name ILIKE $1 LIMIT 1`, [name])
            if (ex.rows[0]) { skipped++; continue }
            // Lookup responsable_email → manager_id (l'utilisateur doit déjà exister)
            let managerId: string | null = null
            const responsableEmail = get(row, 'responsable_email')
            if (responsableEmail) {
              const u = await pool.query(`SELECT id FROM "${schema}".users WHERE email = $1 LIMIT 1`, [responsableEmail])
              managerId = u.rows[0]?.id ?? null
              if (!managerId) {
                errors.push(`Ligne ${i + 2}: responsable ${responsableEmail} introuvable (département créé sans manager)`)
              }
            }
            try {
              await pool.query(
                `INSERT INTO "${schema}".departments (name, code, manager_id) VALUES ($1,$2,$3)`,
                [name, get(row, 'code') || null, managerId],
              )
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'absences') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email_employe')
            if (!email) { skipped++; continue }
            const emp = await pool.query(`SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email])
            if (!emp.rows[0]) { errors.push(`Ligne ${i + 2}: employé ${email} introuvable`); skipped++; continue }
            const typeLabel = get(row, 'type_absence')
            const absType = await pool.query(`SELECT id FROM "${schema}".absence_types WHERE label ILIKE $1 LIMIT 1`, [typeLabel])
            if (!absType.rows[0]) { errors.push(`Ligne ${i + 2}: type "${typeLabel}" inconnu`); skipped++; continue }
            const startDate = toDate(get(row, 'date_debut')) ?? get(row, 'date_debut')
            const endDate = toDate(get(row, 'date_fin')) ?? get(row, 'date_fin')
            const status = get(row, 'statut') || 'approved'
            const cur = new Date(startDate); const end = new Date(endDate); let days = 0
            while (cur <= end) { if (cur.getDay() !== 0) days++; cur.setDate(cur.getDate() + 1) }
            try {
              await pool.query(`
                INSERT INTO "${schema}".absences (employee_id, absence_type_id, start_date, end_date, days, status, reason)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
              `, [emp.rows[0].id, absType.rows[0].id, startDate, endDate, days, status, get(row, 'motif') || null])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'pay-slips') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email_employe')
            const month = get(row, 'periode')
            if (!email || !month) { skipped++; continue }
            const emp = await pool.query(`SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email])
            if (!emp.rows[0]) { skipped++; errors.push(`Ligne ${i + 2}: ${email} introuvable`); continue }
            const ex = await pool.query(`SELECT id FROM "${schema}".pay_slips WHERE employee_id = $1 AND month = $2`, [emp.rows[0].id, month])
            if (ex.rows[0]) { skipped++; continue }
            let periodId: string
            const per = await pool.query(`SELECT id FROM "${schema}".pay_periods WHERE month = $1 LIMIT 1`, [month])
            if (per.rows[0]) { periodId = per.rows[0].id }
            else {
              const np = await pool.query(`INSERT INTO "${schema}".pay_periods (month, status) VALUES ($1,'closed') RETURNING id`, [month])
              periodId = np.rows[0].id
            }
            try {
              await pool.query(`
                INSERT INTO "${schema}".pay_slips (employee_id, period_id, month, gross_salary, employee_contributions, net_before_tax, income_tax, net_payable, employer_cost, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated')
              `, [
                emp.rows[0].id, periodId, month,
                parseInt(get(row, 'salaire_brut')) || 0,
                parseInt(get(row, 'cotis_cnps_sal')) || 0,
                (parseInt(get(row, 'salaire_brut')) || 0) - (parseInt(get(row, 'cotis_cnps_sal')) || 0),
                parseInt(get(row, 'its')) || 0,
                parseInt(get(row, 'net_paye')) || 0,
                parseInt(get(row, 'cout_employeur')) || 0,
              ])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'mobile-money') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email_employe')
            if (!email) { skipped++; continue }
            const emp = await pool.query(`SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email])
            if (!emp.rows[0]) { skipped++; errors.push(`Ligne ${i + 2}: ${email} introuvable`); continue }
            // OWASP A03 — whitelist opérateurs (anti-injection valeur libre)
            const provider = get(row, 'operateur').toLowerCase()
            const allowedProviders = ['wave', 'mtn_momo', 'orange_money']
            if (!allowedProviders.includes(provider)) {
              errors.push(`Ligne ${i + 2}: opérateur "${provider}" invalide (autorisés : ${allowedProviders.join(', ')})`); skipped++; continue
            }
            const phone = get(row, 'numero_telephone')
            try {
              await pool.query(
                `UPDATE "${schema}".employees SET mobile_money_provider=$1, mobile_money_phone=$2 WHERE id=$3`,
                [provider, phone, emp.rows[0].id],
              )
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'contracts') {
          // Frontend template : email_employe, type_contrat, date_debut, date_fin,
          // salaire_base, periode_essai_jours, convention_collective, lieu_travail.
          // Mapping DB : employee_id, type, start_date, end_date, base_salary,
          // trial_end_date (= start_date + periode_essai_jours), convention, job_title.
          // (lieu_travail n'a pas de colonne dédiée — stocké dans job_title)
          const allowedContractTypes = ['cdi', 'cdd', 'apprentissage', 'stage', 'mission']
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email_employe')
            if (!email) { skipped++; continue }
            const emp = await pool.query(`SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email])
            if (!emp.rows[0]) { skipped++; errors.push(`Ligne ${i + 2}: ${email} introuvable`); continue }
            // OWASP A03 — type contrat dans whitelist
            const ctype = (get(row, 'type_contrat') || 'cdi').toLowerCase()
            if (!allowedContractTypes.includes(ctype)) {
              errors.push(`Ligne ${i + 2}: type "${ctype}" invalide (${allowedContractTypes.join(', ')})`); skipped++; continue
            }
            const startDate = toDate(get(row, 'date_debut')) ?? get(row, 'date_debut')
            const endDate   = toDate(get(row, 'date_fin')) || null
            // OWASP A04 — bornes salaire (FCFA entiers, max ~50M/mois en cadre CI extrême)
            const baseSalary = parseInt(get(row, 'salaire_base')) || 0
            if (baseSalary <= 0 || baseSalary > 50_000_000) {
              errors.push(`Ligne ${i + 2}: salaire ${baseSalary} hors borne (1 - 50 000 000 FCFA)`); skipped++; continue
            }
            const trialDays = parseInt(get(row, 'periode_essai_jours')) || 0
            let trialEndDate: string | null = null
            if (trialDays > 0 && startDate) {
              const sd = new Date(startDate)
              sd.setDate(sd.getDate() + trialDays)
              trialEndDate = sd.toISOString().slice(0, 10)
            }
            try {
              await pool.query(`
                INSERT INTO "${schema}".contracts
                  (employee_id, type, start_date, end_date, trial_end_date,
                   base_salary, convention, job_title, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
              `, [
                emp.rows[0].id, ctype, startDate, endDate, trialEndDate,
                baseSalary,
                get(row, 'convention_collective') || null,
                get(row, 'lieu_travail') || null,
              ])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'expenses') {
          // Frontend template : email_employe, titre, mois, montant_total, statut
          // Mapping DB expense_reports : employee_id, title, month (YYYY-MM),
          // total_amount, status (draft|submitted|approved|rejected|reimbursed|paid)
          const allowedStatuses = ['draft', 'submitted', 'approved', 'rejected', 'reimbursed', 'paid']
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email_employe')
            if (!email) { skipped++; continue }
            const emp = await pool.query(`SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email])
            if (!emp.rows[0]) { skipped++; errors.push(`Ligne ${i + 2}: ${email} introuvable`); continue }
            const title = get(row, 'titre')
            if (!title) { errors.push(`Ligne ${i + 2}: titre requis`); skipped++; continue }
            const month = get(row, 'mois')
            // OWASP A03 — format mois strict YYYY-MM (ne pas accepter "12/24" etc.)
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
              errors.push(`Ligne ${i + 2}: mois "${month}" invalide (format YYYY-MM attendu)`); skipped++; continue
            }
            // OWASP A04 — bornes montant (anti-fraude : 0 < montant <= 10M FCFA / note)
            const total = parseInt(get(row, 'montant_total')) || 0
            if (total <= 0 || total > 10_000_000) {
              errors.push(`Ligne ${i + 2}: montant ${total} hors borne (1 - 10 000 000 FCFA)`); skipped++; continue
            }
            // OWASP A03 — statut whitelist
            const status = (get(row, 'statut') || 'approved').toLowerCase()
            if (!allowedStatuses.includes(status)) {
              errors.push(`Ligne ${i + 2}: statut "${status}" invalide (${allowedStatuses.join(', ')})`); skipped++; continue
            }
            try {
              await pool.query(`
                INSERT INTO "${schema}".expense_reports
                  (employee_id, title, month, total_amount, status)
                VALUES ($1,$2,$3,$4,$5)
              `, [emp.rows[0].id, title, month, total, status])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else {
          return reply.status(400).send({ error: `Type d'import inconnu : ${type}` })
        }

        // OWASP A09 — traçabilité import en masse (action puissante : crée des
        // employés en bulk, peut être utilisée pour injecter de faux salariés).
        auditLogSettings(
          schema, request.user.sub, 'settings.import_completed',
          null,
          { type, totalRows: rows.length, inserted, skipped, errorsCount: errors.length },
          request.ip ?? null,
        )

        return reply.send({ total: rows.length, inserted, skipped, errors })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur lors de l\'import' })
      }
    },
  })
}

export default settingsRoutes
