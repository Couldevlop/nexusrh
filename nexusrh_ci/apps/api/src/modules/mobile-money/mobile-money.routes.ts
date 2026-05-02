import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

const rawPool = new Pool({ connectionString: config.database.url })

/**
 * Simule un initiation de paiement Mobile Money CI
 * En production, remplacer par les vrais SDK Wave/MTN/Orange
 */
async function initiateMobileMoneyPayment(params: {
  provider: 'wave' | 'mtn_momo' | 'orange_money'
  phone: string
  amount: number
  reference: string
  description: string
}): Promise<{ success: boolean; transactionId?: string; error?: string }> {
  // Simulation — en production: appel API Wave/MTN/Orange
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

  // TODO: appel SDK réel
  // Wave:         await fetch('https://api.wave.com/v1/checkout/sessions', {...})
  // MTN MoMo:     await mtnMomoClient.requestToPayDeliveryNotification(...)
  // Orange Money: await fetch('https://api.orange.com/orange-money-webpay/ci/v1/webpayment', {...})

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
    handler: async (request, reply) => {
      const { month, provider } = request.body as {
        month: string
        provider?: 'wave' | 'mtn_momo' | 'orange_money' | 'all'
      }
      const schema = request.user.schemaName

      if (!month) return reply.status(400).send({ error: 'month requis (YYYY-MM)' })

      // Récupérer les bulletins du mois
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
           AND ps.payment_status IN ('pending','failed')
           ${provider && provider !== 'all' ? `AND e.mobile_money_provider = '${provider}'` : ''}
         ORDER BY e.last_name`,
        [month]
      )

      const slips = slipsRes.rows
      if (slips.length === 0) {
        // Vérifier si le mois a des bulletins mais déjà payés
        const paidRes = await rawPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${schema}".pay_slips
           WHERE month = $1 AND status IN ('generated','approved')
             AND payment_status = 'paid'`,
          [month]
        )
        const paidCount = parseInt(paidRes.rows[0]?.count ?? '0')
        if (paidCount > 0) {
          return reply.send({
            reference: null, paySlips: [], month,
            employeesCount: 0, totalAmount: 0, currency: 'XOF',
            allPaid: true,
            message: `${paidCount} bulletins de ce mois sont déjà virés.`,
          })
        }
        return reply.send({
          reference: null, paySlips: [], month,
          employeesCount: 0, totalAmount: 0, currency: 'XOF',
          allPaid: false,
          message: 'Aucun bulletin trouvé. Clôturez d\'abord la paie pour ce mois.',
        })
      }

      const totalAmount = slips.reduce((s, sl) => s + parseInt(sl.net_payable ?? '0'), 0)
      const campaignRef = `CAM_${month.replace('-', '')}_${Date.now()}`

      return reply.status(201).send({
        reference: campaignRef,
        month,
        provider: provider ?? 'all',
        employeesCount: slips.length,
        totalAmount,
        currency: 'XOF',
        paySlips: slips.map(sl => ({
          paySlipId: sl.id,
          employeeId: sl.employee_id,
          name: `${sl.first_name} ${sl.last_name}`,
          provider: sl.mobile_money_provider ?? 'wave',
          phone: sl.mobile_money_phone ?? '',
          amount: parseInt(sl.net_payable ?? '0'),
          currentStatus: sl.payment_status,
        })),
      })
    },
  })

  // POST /mobile-money/campaigns/:reference/execute — exécuter les virements
  fastify.post('/campaigns/:reference/execute', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['mobile-money'], summary: 'Exécuter les virements Mobile Money' },
    handler: async (request, reply) => {
      const { reference } = request.params as { reference: string }
      const { paySlipIds } = request.body as { paySlipIds: string[] }
      const schema = request.user.schemaName

      if (!paySlipIds || paySlipIds.length === 0) {
        return reply.status(400).send({ error: 'paySlipIds requis' })
      }

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
        // Récupérer le bulletin
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
          [paySlipId]
        )
        const slip = slipRes.rows[0]
        if (!slip) {
          results.push({ paySlipId, employeeId: '', name: '?', provider: '?', phone: '?', amount: 0, success: false, error: 'Bulletin introuvable' })
          continue
        }

        const amount = parseInt(slip.net_payable ?? '0')
        if (amount <= 0) {
          results.push({ paySlipId, employeeId: slip.employee_id, name: `${slip.first_name} ${slip.last_name}`, provider: slip.mobile_money_provider, phone: slip.mobile_money_phone, amount: 0, success: false, error: 'Montant nul' })
          continue
        }

        const payResult = await initiateMobileMoneyPayment({
          provider: slip.mobile_money_provider as 'wave' | 'mtn_momo' | 'orange_money',
          phone: slip.mobile_money_phone,
          amount,
          reference: `${reference}_${paySlipId.slice(0, 8)}`,
          description: `Salaire ${slip.month} — ${slip.first_name} ${slip.last_name}`,
        })

        // Enregistrer le paiement
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
          ]
        )

        // Mettre à jour le bulletin
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
          ]
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

      return reply.send({
        reference,
        results,
        summary: {
          total:     results.length,
          succeeded: succeeded.length,
          failed:    failed.length,
          totalPaid: succeeded.reduce((s, r) => s + r.amount, 0),
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
      const { month, status, employeeId } = request.query as Record<string, string>
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
      const { year = String(new Date().getFullYear()) } = request.query as Record<string, string>
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
        [parseInt(year)]
      )

      return reply.send({ data: res.rows, year: parseInt(year), currency: 'XOF' })
    },
  })

  // PATCH /mobile-money/payments/:id/retry — relancer un paiement échoué
  fastify.patch('/payments/:id/retry', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['mobile-money'], summary: 'Relancer un paiement échoué' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
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
        [id]
      )
      const payment = payRes.rows[0]
      if (!payment) return reply.status(404).send({ error: 'Paiement introuvable' })
      if (payment.status === 'completed') return reply.status(422).send({ error: 'Paiement déjà complété' })

      const retryResult = await initiateMobileMoneyPayment({
        provider: payment.provider as 'wave' | 'mtn_momo' | 'orange_money',
        phone: payment.phone_number,
        amount: parseInt(payment.amount),
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
        ]
      )

      if (retryResult.success) {
        await rawPool.query(
          `UPDATE "${schema}".pay_slips
           SET payment_status = 'paid', payment_reference = $1,
               paid_at = now(), updated_at = now()
           WHERE id = $2`,
          [retryResult.transactionId, payment.pay_slip_id]
        )
      }

      return reply.send({
        success: retryResult.success,
        transactionId: retryResult.transactionId,
        error: retryResult.error,
      })
    },
  })
}

export default mobileMoneyRoutes
