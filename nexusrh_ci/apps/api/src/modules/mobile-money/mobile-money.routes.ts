import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '../../config.js'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

// OWASP A03 — patterns de validation stricts
const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MONTH_RE     = /^\d{4}-(0[1-9]|1[0-2])$/
const REFERENCE_RE = /^[A-Za-z0-9_-]{1,100}$/
const PROVIDERS    = ['wave', 'mtn_momo', 'orange_money'] as const
type Provider = typeof PROVIDERS[number]

// OWASP A04 — bornes anti-fraude paiements Mobile Money CI.
// Seuils calibrés sur les usages PME ivoiriennes : aucun salaire net légitime
// ne dépasse 50M FCFA/mois et un seul lot ne couvre pas plus de 1000 employés.
const MONTANT_MIN_FCFA              = 1
const MONTANT_MAX_PAR_PAIEMENT_FCFA = 50_000_000      // 50M FCFA
const MAX_PAYSLIPS_PAR_CAMPAGNE     = 1_000

// OWASP A09 — audit log non bloquant des actions financières (création campagne,
// exécution virements, retry). Permet la traçabilité même si la table audit_log
// n'existe pas encore dans un tenant ancien.
function auditLogMobileMoney(
  schema: string, userId: string, action: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'mobile_money', $3, $4, $5)`,
    [userId, action, entityId, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

// OWASP A07 — rate-limits sur actions sensibles (création campagne et exécution
// virements en masse). L'exécution est plus restrictive : un lot mal initié peut
// pousser des centaines de transactions provider en quelques secondes.
const CAMPAIGN_CREATE_RATE_LIMIT  = { rateLimit: { max: 20, timeWindow: '1 minute' } }
const CAMPAIGN_EXECUTE_RATE_LIMIT = { rateLimit: { max: 5,  timeWindow: '1 minute' } }
const RETRY_RATE_LIMIT            = { rateLimit: { max: 30, timeWindow: '1 minute' } }

// OWASP A03 — schémas Zod stricts
const createCampaignSchema = z.object({
  month:    z.string().regex(MONTH_RE, 'Format YYYY-MM requis'),
  provider: z.enum([...PROVIDERS, 'all']).optional(),
}).strict()

const executeCampaignSchema = z.object({
  paySlipIds: z.array(z.string().regex(UUID_RE, 'UUID requis'))
              .min(1, 'Au moins un paySlipId requis')
              .max(MAX_PAYSLIPS_PAR_CAMPAGNE, `Maximum ${MAX_PAYSLIPS_PAR_CAMPAGNE} virements par lot`),
}).strict()

const paymentsQuerySchema = z.object({
  month:      z.string().regex(MONTH_RE).optional(),
  status:     z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']).optional(),
  employeeId: z.string().regex(UUID_RE).optional(),
}).strict()

const statsQuerySchema = z.object({
  year: z.string().regex(/^\d{4}$/).optional(),
}).strict()

/**
 * Simule un initiation de paiement Mobile Money CI.
 * En production, remplacer par les vrais SDK Wave/MTN/Orange.
 */
async function initiateMobileMoneyPayment(params: {
  provider: Provider
  phone: string
  amount: number
  reference: string
  description: string
}): Promise<{ success: boolean; transactionId?: string; error?: string }> {
  const providers = {
    wave:         config.mobileMoney.wave.apiKey,
    mtn_momo:     config.mobileMoney.mtn.apiKey,
    orange_money: config.mobileMoney.orange.apiKey,
  }

  if (!providers[params.provider]) {
    return { success: false, error: `Provider ${params.provider} non configuré` }
  }

  // Validation format téléphone CI (+225 07 ou 05)
  const cleanPhone = params.phone.replace(/\s/g, '')
  if (!/^\+2250[57]\d{8}$/.test(cleanPhone)) {
    return { success: false, error: `Numéro invalide pour la CI: ${params.phone}` }
  }

  // Simulation: 95% success rate
  const success = Math.random() > 0.05
  return {
    success,
    transactionId: success ? `TXN_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}` : undefined,
    error: success ? undefined : 'Échec transaction (simulation)',
  }
}

const mobileMoneyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // POST /mobile-money/campaigns — créer une campagne de virement masse salariale
  fastify.post('/campaigns', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['mobile-money'], summary: 'Créer une campagne de virements Mobile Money' },
    config: CAMPAIGN_CREATE_RATE_LIMIT,
    handler: async (request, reply) => {
      // OWASP A03 — validation Zod stricte (rejette payload inconnu)
      const parsed = createCampaignSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const { month, provider } = parsed.data
      const schema = request.user.schemaName

      // OWASP A03 — provider passe par enum Zod puis par param binding
      // (jamais par interpolation directe dans la requête SQL).
      const params: unknown[] = [month]
      let providerFilter = ''
      if (provider && provider !== 'all') {
        params.push(provider)
        providerFilter = ` AND e.mobile_money_provider = $${params.length}`
      }

      const slipsRes = await rawPool.query<{
        id: string; employee_id: string; net_payable: string
        payment_method: string; payment_status: string
        first_name: string; last_name: string
        mobile_money_provider: string; mobile_money_phone: string
      }>(
        `SELECT ps.id, ps.employee_id, ps.net_payable,
                ps.payment_method, ps.payment_status,
                e.first_name, e.last_name,
                e.mobile_money_provider, e.mobile_money_phone
         FROM "${schema}".pay_slips ps
         JOIN "${schema}".employees e ON e.id = ps.employee_id
         WHERE ps.month = $1 AND ps.status IN ('generated','approved')
           AND ps.payment_status IN ('pending','failed')${providerFilter}
         ORDER BY e.last_name`,
        params,
      )

      const slips = slipsRes.rows
      if (slips.length === 0) {
        const paidRes = await rawPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${schema}".pay_slips
           WHERE month = $1 AND status IN ('generated','approved')
             AND payment_status = 'paid'`,
          [month],
        )
        const paidCount = parseInt(paidRes.rows[0]?.count ?? '0')
        if (paidCount > 0) {
          return reply.send({
            reference: `CAMP_${month}_EMPTY`,
            month,
            provider: provider ?? 'all',
            slips: [],
            summary: { total: 0, totalAmount: 0, currency: 'XOF', alreadyPaid: paidCount },
            message: 'Tous les bulletins de ce mois sont déjà payés',
          })
        }
        return reply.status(404).send({ error: 'Aucun bulletin éligible pour ce mois' })
      }

      // OWASP A04 — borne anti-fraude : refuser les lots dépassant le cap.
      if (slips.length > MAX_PAYSLIPS_PAR_CAMPAGNE) {
        return reply.status(422).send({
          error: `Lot trop volumineux (${slips.length} bulletins). Maximum ${MAX_PAYSLIPS_PAR_CAMPAGNE} par campagne.`,
        })
      }
      // OWASP A04 — chaque montant dans la borne autorisée.
      for (const sl of slips) {
        const amt = parseInt(sl.net_payable ?? '0')
        if (amt > MONTANT_MAX_PAR_PAIEMENT_FCFA) {
          return reply.status(422).send({
            error: `Montant suspect détecté (${amt} FCFA pour ${sl.first_name} ${sl.last_name}). Plafond ${MONTANT_MAX_PAR_PAIEMENT_FCFA} FCFA/paiement.`,
          })
        }
      }

      const reference   = `CAMP_${month.replace('-', '')}_${Date.now()}`
      const totalAmount = slips.reduce((s, sl) => s + parseInt(sl.net_payable ?? '0'), 0)

      auditLogMobileMoney(
        schema, request.user.sub, 'mobile_money.campaign.prepared',
        null,
        { month, provider: provider ?? 'all', reference, slipsCount: slips.length, totalAmount },
        request.ip ?? null,
      )

      return reply.send({
        reference,
        month,
        provider: provider ?? 'all',
        slips: slips.map(sl => ({
          paySlipId: sl.id,
          employeeId: sl.employee_id,
          name: `${sl.first_name} ${sl.last_name}`,
          provider: sl.mobile_money_provider,
          phone: sl.mobile_money_phone ?? '',
          amount: parseInt(sl.net_payable ?? '0'),
          currentStatus: sl.payment_status,
        })),
        summary: { total: slips.length, totalAmount, currency: 'XOF' },
      })
    },
  })

  // POST /mobile-money/campaigns/:reference/execute — exécuter les virements
  fastify.post('/campaigns/:reference/execute', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['mobile-money'], summary: 'Exécuter les virements Mobile Money' },
    config: CAMPAIGN_EXECUTE_RATE_LIMIT,
    handler: async (request, reply) => {
      // OWASP A03 — validation référence campagne (alphanumérique strict)
      const { reference } = request.params as { reference: string }
      if (!REFERENCE_RE.test(reference)) {
        return reply.status(400).send({ error: 'Référence de campagne invalide' })
      }
      // OWASP A03 — validation corps Zod (UUIDs + cardinalité)
      const parsed = executeCampaignSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const { paySlipIds } = parsed.data
      const schema = request.user.schemaName

      const results: Array<{
        paySlipId: string
        employeeId: string
        name: string
        provider: string
        phone: string
        amount: number
        success: boolean
        transactionId?: string
        error?: string
      }> = []

      for (const paySlipId of paySlipIds) {
        const slipRes = await rawPool.query<{
          id: string; employee_id: string; net_payable: string; month: string
          first_name: string; last_name: string
          mobile_money_provider: string; mobile_money_phone: string
        }>(
          `SELECT ps.id, ps.employee_id, ps.net_payable, ps.month,
                  e.first_name, e.last_name,
                  e.mobile_money_provider, e.mobile_money_phone
           FROM "${schema}".pay_slips ps
           JOIN "${schema}".employees e ON e.id = ps.employee_id
           WHERE ps.id = $1 LIMIT 1`,
          [paySlipId],
        )
        const slip = slipRes.rows[0]
        if (!slip) {
          results.push({ paySlipId, employeeId: '', name: '?', provider: '?', phone: '?', amount: 0, success: false, error: 'Bulletin introuvable' })
          continue
        }

        const amount = parseInt(slip.net_payable ?? '0')
        if (amount < MONTANT_MIN_FCFA) {
          results.push({ paySlipId, employeeId: slip.employee_id, name: `${slip.first_name} ${slip.last_name}`, provider: slip.mobile_money_provider, phone: slip.mobile_money_phone, amount: 0, success: false, error: 'Montant nul ou négatif' })
          continue
        }
        // OWASP A04 — re-vérification du plafond à l'exécution (defense in depth)
        if (amount > MONTANT_MAX_PAR_PAIEMENT_FCFA) {
          results.push({ paySlipId, employeeId: slip.employee_id, name: `${slip.first_name} ${slip.last_name}`, provider: slip.mobile_money_provider, phone: slip.mobile_money_phone, amount, success: false, error: `Plafond dépassé (max ${MONTANT_MAX_PAR_PAIEMENT_FCFA} FCFA)` })
          continue
        }

        const payResult = await initiateMobileMoneyPayment({
          provider: slip.mobile_money_provider as Provider,
          phone: slip.mobile_money_phone,
          amount,
          reference: `${reference}_${paySlipId.slice(0, 8)}`,
          description: `Salaire ${slip.month} — ${slip.first_name} ${slip.last_name}`,
        })

        await rawPool.query(
          `INSERT INTO "${schema}".mobile_money_payments
             (employee_id, pay_slip_id, provider, phone_number, amount, reference, status, external_ref, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            slip.employee_id, paySlipId, slip.mobile_money_provider ?? 'wave',
            slip.mobile_money_phone ?? '',
            amount, `${reference}_${paySlipId.slice(0, 8)}`,
            payResult.success ? 'completed' : 'failed',
            payResult.transactionId ?? null,
            payResult.error ?? null,
          ],
        )

        await rawPool.query(
          `UPDATE "${schema}".pay_slips SET
             payment_status = $1, payment_reference = $2,
             paid_at = $3, updated_at = now()
           WHERE id = $4`,
          [
            payResult.success ? 'paid' : 'failed',
            payResult.transactionId ?? null,
            payResult.success ? new Date() : null,
            paySlipId,
          ],
        )

        results.push({
          paySlipId,
          employeeId: slip.employee_id,
          name: `${slip.first_name} ${slip.last_name}`,
          provider: slip.mobile_money_provider,
          phone: slip.mobile_money_phone,
          amount,
          success: payResult.success,
          transactionId: payResult.transactionId,
          error: payResult.error,
        })
      }

      const succeeded = results.filter(r => r.success)
      const failed    = results.filter(r => !r.success)
      const totalPaid = succeeded.reduce((s, r) => s + r.amount, 0)

      auditLogMobileMoney(
        schema, request.user.sub, 'mobile_money.campaign.executed',
        null,
        { reference, total: results.length, succeeded: succeeded.length, failed: failed.length, totalPaid },
        request.ip ?? null,
      )

      return reply.send({
        reference,
        results,
        summary: {
          total:     results.length,
          succeeded: succeeded.length,
          failed:    failed.length,
          totalPaid,
          currency:  'XOF',
        },
      })
    },
  })

  // GET /mobile-money/payments — historique des paiements
  fastify.get('/payments', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['mobile-money'], summary: 'Historique des paiements Mobile Money' },
    handler: async (request, reply) => {
      // OWASP A03 — validation query (rejette filtres exotiques + injection)
      const parsed = paymentsQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const { month, status, employeeId } = parsed.data
      const schema = request.user.schemaName

      let sql = `SELECT mp.id, mp.provider, mp.phone_number AS phone,
                        mp.amount, mp.reference, mp.external_ref AS transaction_id,
                        mp.status, mp.error_message, mp.created_at,
                        e.first_name, e.last_name, ps.month
                 FROM "${schema}".mobile_money_payments mp
                 JOIN "${schema}".employees e ON e.id = mp.employee_id
                 LEFT JOIN "${schema}".pay_slips ps ON ps.id = mp.pay_slip_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1

      if (month)      { sql += ` AND ps.month = $${idx++}`; params.push(month) }
      if (status)     { sql += ` AND mp.status = $${idx++}`; params.push(status) }
      if (employeeId) { sql += ` AND mp.employee_id = $${idx++}`; params.push(employeeId) }

      sql += ` ORDER BY mp.created_at DESC LIMIT 200`
      const res = await rawPool.query(sql, params)
      return reply.send({ data: res.rows })
    },
  })

  // GET /mobile-money/payments/stats — statistiques par provider
  fastify.get('/payments/stats', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'readonly')],
    schema: { tags: ['mobile-money'], summary: 'Statistiques paiements Mobile Money' },
    handler: async (request, reply) => {
      // OWASP A03 — validation query year
      const parsedQ = statsQuerySchema.safeParse(request.query)
      if (!parsedQ.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsedQ.error.flatten() })
      }
      const yearStr = parsedQ.data.year ?? String(new Date().getFullYear())
      const year    = parseInt(yearStr, 10)
      if (year < 2000 || year > new Date().getFullYear() + 1) {
        return reply.status(400).send({ error: 'year hors plage' })
      }
      const schema = request.user.schemaName

      const res = await rawPool.query<{
        provider: string; status: string
        count: string; total_amount: string
      }>(
        `SELECT mp.provider, mp.status,
                count(*)::text AS count,
                SUM(mp.amount)::text AS total_amount
         FROM "${schema}".mobile_money_payments mp
         WHERE EXTRACT(YEAR FROM mp.created_at) = $1
         GROUP BY mp.provider, mp.status
         ORDER BY mp.provider, mp.status`,
        [year],
      )

      return reply.send({ data: res.rows, year, currency: 'XOF' })
    },
  })

  // PATCH /mobile-money/payments/:id/retry — relancer un paiement échoué
  fastify.patch('/payments/:id/retry', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['mobile-money'], summary: 'Relancer un paiement échoué' },
    config: RETRY_RATE_LIMIT,
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      // OWASP A03 — validation UUID stricte
      if (!UUID_RE.test(id)) {
        return reply.status(400).send({ error: 'ID invalide' })
      }
      const schema = request.user.schemaName

      const payRes = await rawPool.query<{
        id: string; employee_id: string; pay_slip_id: string
        provider: string; phone_number: string; amount: string; reference: string
        status: string; first_name: string; last_name: string
      }>(
        `SELECT mp.id, mp.employee_id, mp.pay_slip_id, mp.provider,
                mp.phone_number, mp.amount, mp.reference, mp.status,
                e.first_name, e.last_name
         FROM "${schema}".mobile_money_payments mp
         JOIN "${schema}".employees e ON e.id = mp.employee_id
         WHERE mp.id = $1 LIMIT 1`,
        [id],
      )
      const payment = payRes.rows[0]
      if (!payment) return reply.status(404).send({ error: 'Paiement introuvable' })
      if (payment.status === 'completed') return reply.status(422).send({ error: 'Paiement déjà complété' })

      // OWASP A04 — re-vérification du plafond avant relance
      const retryAmount = parseInt(payment.amount)
      if (retryAmount < MONTANT_MIN_FCFA || retryAmount > MONTANT_MAX_PAR_PAIEMENT_FCFA) {
        return reply.status(422).send({ error: `Montant hors borne (${retryAmount} FCFA)` })
      }
      // OWASP A03 — provider stocké en base doit toujours appartenir à la whitelist
      if (!PROVIDERS.includes(payment.provider as Provider)) {
        return reply.status(422).send({ error: 'Provider inconnu sur ce paiement' })
      }

      const retryResult = await initiateMobileMoneyPayment({
        provider: payment.provider as Provider,
        phone: payment.phone_number,
        amount: retryAmount,
        reference: `${payment.reference}_RETRY_${Date.now()}`,
        description: `Relance salaire — ${payment.first_name} ${payment.last_name}`,
      })

      await rawPool.query(
        `UPDATE "${schema}".mobile_money_payments
         SET status = $1, external_ref = $2, error_message = $3, updated_at = now()
         WHERE id = $4`,
        [
          retryResult.success ? 'completed' : 'failed',
          retryResult.transactionId ?? null,
          retryResult.error ?? null,
          id,
        ],
      )

      if (retryResult.success) {
        await rawPool.query(
          `UPDATE "${schema}".pay_slips
           SET payment_status = 'paid', payment_reference = $1,
               paid_at = now(), updated_at = now()
           WHERE id = $2`,
          [retryResult.transactionId, payment.pay_slip_id],
        )
      }

      auditLogMobileMoney(
        schema, request.user.sub, 'mobile_money.payment.retried',
        id,
        { success: retryResult.success, amount: retryAmount, provider: payment.provider },
        request.ip ?? null,
      )

      return reply.send({
        success: retryResult.success,
        transactionId: retryResult.transactionId,
        error: retryResult.error,
      })
    },
  })

  // ── POST /mobile-money/webhooks/:provider — callbacks providers ──────────────
  //
  // Endpoint PUBLIC (sans JWT) appelé par Wave/MTN/Orange pour notifier le
  // statut final d'une transaction (completed / failed / cancelled).
  //
  // Sécurité :
  //  - OWASP A02 : HMAC SHA-256 signature obligatoire (header X-Signature)
  //    comparée en timing-safe avec le secret par provider. Sans signature
  //    valide → 401, l'attaquant ne peut pas spoof un callback "completed"
  //    pour marquer un bulletin payé sans avoir effectivement transféré.
  //  - OWASP A04 (idempotence) : si la transaction est déjà "completed",
  //    le webhook retourne 200 sans rien faire (anti-replay : un provider
  //    peut retry plusieurs fois ; on doit toujours répondre 200 pour qu'il
  //    arrête, mais sans double-mettre à jour pay_slips).
  //  - OWASP A07 : rate-limit modéré (les providers retry mais pas en spam).
  //  - Tenant résolu via query param ?tenant={slug} (le slug n'est pas un
  //    secret, c'est la signature HMAC qui authentifie).
  fastify.post('/webhooks/:provider', {
    schema: { tags: ['mobile-money'], summary: 'Webhook callback provider (HMAC signé)' },
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { provider } = request.params as { provider: string }
      const { tenant: tenantSlug } = request.query as { tenant?: string }

      // OWASP A03 — provider whitelist + slug regex
      if (!PROVIDERS.includes(provider as Provider)) {
        return reply.status(404).send({ error: 'Provider inconnu' })
      }
      if (!tenantSlug || !/^[a-z][a-z0-9_-]{0,62}$/.test(tenantSlug)) {
        return reply.status(400).send({ error: 'Paramètre tenant requis (slug)' })
      }

      // Récupère le webhookSecret du provider depuis config
      const secrets: Record<Provider, string | undefined> = {
        wave:         config.mobileMoney.wave.webhookSecret,
        mtn_momo:     config.mobileMoney.mtn.webhookSecret,
        orange_money: config.mobileMoney.orange.webhookSecret,
      }
      const secret = secrets[provider as Provider]
      if (!secret) {
        // Si le secret n'est pas configuré, refuser tout webhook (fail-closed)
        fastify.log.warn({ provider }, '[webhook] secret non configuré, callback refusé')
        return reply.status(503).send({ error: 'Webhook désactivé pour ce provider' })
      }

      // OWASP A02 — vérification HMAC en timing-safe
      const sigHeader = String(request.headers['x-signature'] ?? '').trim()
      if (!sigHeader) return reply.status(401).send({ error: 'Signature manquante' })

      // Le body brut est requis pour HMAC ; on le re-sérialise (Fastify l'a
      // déjà parsé en JSON). C'est équivalent si on utilise la même
      // canonicalisation côté provider.
      const bodyRaw = JSON.stringify(request.body ?? {})
      const expected = createHmac('sha256', secret).update(bodyRaw).digest('hex')
      // Accepte les formats "sha256=hex" ou "hex" brut
      const provided = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader

      let sigOk = false
      try {
        const a = Buffer.from(expected, 'hex')
        const b = Buffer.from(provided, 'hex')
        sigOk = a.length === b.length && timingSafeEqual(a, b)
      } catch { sigOk = false }
      if (!sigOk) {
        fastify.log.warn({ provider, tenantSlug }, '[webhook] signature HMAC invalide')
        return reply.status(401).send({ error: 'Signature invalide' })
      }

      // OWASP A03 — Zod strict sur payload
      const webhookSchema = z.object({
        reference:     z.string().regex(REFERENCE_RE),
        transactionId: z.string().min(1).max(100),
        status:        z.enum(['completed', 'failed', 'cancelled']),
        message:       z.string().max(500).optional(),
      }).strict()
      const parsed = webhookSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Payload invalide', issues: parsed.error.flatten() })
      }
      const { reference, transactionId, status, message } = parsed.data

      // Résoudre le tenant (slug → schemaName) en lookup platform.tenants
      const tenantRes = await rawPool.query<{ schema_name: string; status: string }>(
        `SELECT schema_name, status FROM platform.tenants WHERE slug = $1 LIMIT 1`,
        [tenantSlug],
      )
      const tenant = tenantRes.rows[0]
      if (!tenant) return reply.status(404).send({ error: 'Tenant introuvable' })
      if (tenant.status === 'suspended') return reply.status(403).send({ error: 'Tenant suspendu' })

      const schema = tenant.schema_name
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
        return reply.status(500).send({ error: 'Configuration tenant invalide' })
      }

      await ensureTenantSchema(schema)

      // Récupérer le paiement par reference (clé naturelle du provider)
      const payRes = await rawPool.query<{
        id: string; pay_slip_id: string; status: string; external_ref: string | null
      }>(
        `SELECT id, pay_slip_id, status, external_ref
         FROM "${schema}".mobile_money_payments WHERE reference = $1 LIMIT 1`,
        [reference],
      )
      const payment = payRes.rows[0]
      if (!payment) {
        // Ne pas révéler si la référence existe ou pas (anti-enumération)
        return reply.status(202).send({ accepted: true, processed: false })
      }

      // OWASP A04 — IDEMPOTENCE : si déjà completed avec le MÊME external_ref
      // (transactionId), c'est un retry du provider → 200 OK sans rien faire.
      // Si déjà completed avec un autre external_ref, on signale conflit.
      if (payment.status === 'completed') {
        if (payment.external_ref === transactionId) {
          return reply.send({ accepted: true, processed: false, reason: 'already_completed' })
        }
        // Tentative de changer le résultat final d'un paiement déjà complété
        fastify.log.warn(
          { provider, tenantSlug, reference, oldRef: payment.external_ref, newRef: transactionId },
          '[webhook] tentative de modification d\'un paiement déjà complété',
        )
        auditLogMobileMoney(
          schema, 'webhook', 'mobile_money.webhook.conflict',
          payment.id,
          { provider, reference, oldExternalRef: payment.external_ref, newExternalRef: transactionId },
          request.ip ?? null,
        )
        return reply.status(409).send({ error: 'Paiement déjà complété avec une autre référence' })
      }

      // Update du paiement avec le statut final
      const dbStatus = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled'
      await rawPool.query(
        `UPDATE "${schema}".mobile_money_payments
         SET status = $1, external_ref = $2, error_message = $3, updated_at = now()
         WHERE id = $4`,
        [dbStatus, transactionId, message ?? null, payment.id],
      )

      // Si succès, marquer le bulletin de paie associé comme payé
      if (status === 'completed' && payment.pay_slip_id) {
        await rawPool.query(
          `UPDATE "${schema}".pay_slips
           SET payment_status = 'paid', payment_reference = $1,
               paid_at = now(), updated_at = now()
           WHERE id = $2`,
          [transactionId, payment.pay_slip_id],
        )
      }

      auditLogMobileMoney(
        schema, 'webhook', `mobile_money.webhook.${dbStatus}`,
        payment.id,
        { provider, reference, transactionId, status: dbStatus },
        request.ip ?? null,
      )

      return reply.send({ accepted: true, processed: true, status: dbStatus })
    },
  })
}

export default mobileMoneyRoutes
