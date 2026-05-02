import type { FastifyPluginAsync } from 'fastify'
import { streamChat, generateHRDocument, analyzeRetentionRisk } from './ai.service'

const aiRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /ai/chat/stream — Server-Sent Events streaming
  fastify.post('/chat/stream', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['ai'],
      summary: 'Chat IA en streaming (SSE)',
    },
    handler: async (request, reply) => {
      const { messages, context } = request.body as {
        messages: Array<{ role: 'user' | 'assistant'; content: string }>
        context: {
          name: string
          employeeCount: number
          collectiveAgreement?: string
          country: string
          currentUser: { name: string; role: string }
          pageContext?: Record<string, unknown>
        }
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })

      try {
        for await (const chunk of streamChat(messages, context)) {
          reply.raw.write(
            `data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`
          )
        }
        reply.raw.write('data: [DONE]\n\n')
      } catch (err) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'error', message: 'Erreur de génération' })}\n\n`
        )
      } finally {
        reply.raw.end()
      }
    },
  })

  // POST /ai/documents/generate
  fastify.post('/documents/generate', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['ai'],
      summary: 'Générer un document RH avec l\'IA',
    },
    handler: async (request, reply) => {
      const { documentType, data } = request.body as {
        documentType: string
        data: Record<string, unknown>
      }
      const content = await generateHRDocument(documentType, data)
      return reply.send({ data: { content } })
    },
  })

  // POST /ai/employees/:id/retention
  fastify.post('/employees/:id/retention', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'admin', 'super_admin')],
    schema: {
      tags: ['ai'],
      summary: 'Analyser le risque de rétention d\'un collaborateur',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { employeeData } = request.body as {
        employeeData: Record<string, unknown>
      }
      const analysis = await analyzeRetentionRisk({ ...employeeData, employeeId: id })
      return reply.send({ data: analysis })
    },
  })
}

export default aiRoutes
