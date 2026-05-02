import type { FastifyPluginAsync } from 'fastify'
import { config } from '../../config.js'

const aiRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /ai/status — vérifie si l'IA est disponible
  fastify.get('/status', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['ai'], summary: 'Statut IA' },
    handler: async (_request, reply) => {
      return reply.send({
        available: !!config.ai.apiKey,
        model: config.ai.apiKey ? config.ai.model : null,
        message: config.ai.apiKey
          ? 'Assistant IA disponible'
          : 'Clé API Anthropic non configurée. Contactez votre administrateur.',
      })
    },
  })

  // POST /ai/chat — chat SSE avec l'assistant IA CI
  fastify.post('/chat', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager')],
    schema: { tags: ['ai'], summary: 'Chat IA RH CI (SSE streaming)' },
    handler: async (request, reply) => {
      if (!config.ai.apiKey) {
        return reply.status(503).send({
          error: 'IA non disponible',
          message: 'Clé API Anthropic non configurée. Configurez ANTHROPIC_API_KEY dans vos variables d\'environnement.',
        })
      }

      const { messages, context } = request.body as {
        messages: Array<{ role: 'user' | 'assistant'; content: string }>
        context?: { tenantName?: string; userRole?: string; currentPage?: string; convention?: string }
      }

      const schema = request.user.schemaName
      let tenantInfo = context?.tenantName ?? 'Entreprise CI'
      try {
        const { Pool } = await import('pg')
        const pool = new (Pool as typeof import('pg').Pool)({ connectionString: config.database.url })
        const t = await pool.query<{ name: string; sector: string; city: string; at_rate: string }>(
          `SELECT name, sector, city, at_rate FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
          [schema]
        )
        if (t.rows[0]) {
          tenantInfo = `${t.rows[0].name} (${t.rows[0].city}, secteur: ${t.rows[0].sector ?? 'services'}, taux AT CNPS: ${parseFloat(t.rows[0].at_rate ?? '0.020') * 100}%)`
        }
        await pool.end()
      } catch { /* non bloquant */ }

      const systemPrompt = `Tu es un expert RH et droit social ivoirien intégré dans NexusRH CI.

Entreprise : ${tenantInfo}
Utilisateur : ${context?.userRole ?? request.user.role} — Page : ${context?.currentPage ?? 'tableau de bord'}
Convention collective : ${context?.convention ?? 'applicable au secteur CI'}

INSTRUCTIONS :
- Tu réponds TOUJOURS en français
- Tu te référes au Code du Travail CI, la réglementation CNPS 2024, les barèmes ITS/DGI, le droit OHADA
- Tu cites les articles et circulaires pertinents (ex: "Art. 14 CT CI", "Circulaire CNPS n°...")
- SMIG = 75 000 FCFA/mois (revalorisation 2026) | Devise : FCFA | CNPS retraite salarié : 6,3% | ITS : barème progressif DGI
- Tu fournis des calculs précis quand demandé
- Si la question dépasse le droit ivoirien, tu le signales clairement
- Tu es concis et pratique, orienté action RH

CONTEXTE CI IMPORTANT :
- CNPS : plafond retraite 1 647 315 FCFA, plafond AT/PF 70 000 FCFA
- ITS : abattement 15% sur brut, tranches 0%→1,5%→5%→10%→15%
- Congés : 2,5 jours ouvrables/mois travaillé
- Mobile Money : Wave, MTN MoMo, Orange Money pour paiement salaires
- DISA : déclaration annuelle obligatoire (loi 99-477)`

      // Réponse SSE streaming
      reply.raw.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })

      try {
        const Anthropic = (await import('@anthropic-ai/sdk')).default
        const client = new Anthropic({ apiKey: config.ai.apiKey })

        const stream = await client.messages.stream({
          model:      config.ai.model,
          max_tokens: config.ai.maxTokens,
          system:     systemPrompt,
          messages,
        })

        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            reply.raw.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`)
          }
        }

        const finalMsg = await stream.finalMessage()
        reply.raw.write(`data: ${JSON.stringify({
          done: true,
          usage: finalMsg.usage,
          stopReason: finalMsg.stop_reason,
        })}\n\n`)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur IA'
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`)
      } finally {
        reply.raw.end()
      }
    },
  })

  // POST /ai/simulate-its — simulateur ITS/IGR avec quotient familial
  fastify.post('/simulate-its', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['ai'], summary: 'Simulateur ITS/IGR CI avec quotient familial' },
    handler: async (request, reply) => {
      const {
        baseSalary, maritalStatus = 'single', childrenCount = 0,
        atRate = 0.020, primes = 0,
      } = request.body as {
        baseSalary: number; maritalStatus?: string; childrenCount?: number
        atRate?: number; primes?: number
      }

      if (!baseSalary || baseSalary <= 0) {
        return reply.status(400).send({ error: 'baseSalary requis' })
      }

      // Calcul CNPS
      const PLAFOND_AT_PF    = 70_000
      const PLAFOND_RETRAITE = 1_647_315
      const brut = baseSalary + primes
      const baseAtPf    = Math.min(brut, PLAFOND_AT_PF)
      const baseRetraite = Math.min(brut, PLAFOND_RETRAITE)
      const cnpsSal = Math.floor(baseRetraite * 0.063)
      const cnpsPat = Math.floor(baseRetraite * 0.077) + Math.floor(baseAtPf * (0.0575 + atRate))

      // Calcul ITS avec quotient familial CI
      const salaireNetImposable = Math.floor(brut * 0.85)
      const baseImposable = Math.max(0, salaireNetImposable - cnpsSal)

      const TRANCHES = [
        { max: 75_000, taux: 0.000 },
        { max: 240_000, taux: 0.015 },
        { max: 800_000, taux: 0.050 },
        { max: 2_000_000, taux: 0.100 },
        { max: Infinity, taux: 0.150 },
      ]
      let itsBrut = 0
      let prev = 0
      for (const t of TRANCHES) {
        if (baseImposable <= prev) break
        itsBrut += Math.min(baseImposable - prev, t.max - prev) * t.taux
        prev = t.max
      }
      itsBrut = Math.floor(itsBrut)

      const creditImpot = (maritalStatus === 'married' ? 5_500 : 0)
        + (childrenCount === 1 ? 3_000 : childrenCount === 2 ? 6_000 : childrenCount >= 3 ? 9_000 : 0)
      const its = Math.max(0, itsBrut - creditImpot)

      const netPayable = brut - cnpsSal - its
      const smigOk = netPayable >= 75_000

      // Simulation enfant supplémentaire
      const creditAvecEnfantSupp = creditImpot + (childrenCount >= 3 ? 0 : childrenCount === 2 ? 3_000 : childrenCount === 1 ? 3_000 : 3_000)
      const itsAvecEnfantSupp = Math.max(0, itsBrut - creditAvecEnfantSupp)
      const gainEnfantSupp = its - itsAvecEnfantSupp

      return reply.send({
        input:       { baseSalary, primes, brut, maritalStatus, childrenCount, atRate },
        cnps:        { salarial: cnpsSal, patronal: cnpsPat },
        its:         { base: baseImposable, brut: itsBrut, credit: creditImpot, net: its },
        net:         { payable: netPayable, smigCompliant: smigOk },
        employerCost: brut + cnpsPat,
        simulation: {
          avecUnEnfantSupp: {
            its: itsAvecEnfantSupp,
            net: brut - cnpsSal - itsAvecEnfantSupp,
            gain: gainEnfantSupp,
            message: gainEnfantSupp > 0
              ? `Avec 1 enfant de plus, le net augmenterait de ${gainEnfantSupp.toLocaleString('fr-CI')} FCFA/mois`
              : `Le crédit maximum est déjà atteint (3 enfants et plus)`,
          },
        },
        currency: 'XOF',
      })
    },
  })
}

export default aiRoutes
