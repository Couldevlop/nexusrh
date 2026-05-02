import fp from 'fastify-plugin/plugin.js'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import type { FastifyPluginAsync } from 'fastify'

const swaggerPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'NexusRH API',
        description: 'API du SIRH NexusRH — propulsé par Claude AI',
        version: '1.0.0',
        contact: {
          name: 'NexusRH Support',
          email: 'support@nexusrh.com',
        },
      },
      servers: [
        { url: 'http://localhost:4000', description: 'Développement' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'auth', description: 'Authentification et gestion des sessions' },
        { name: 'employees', description: 'Gestion des collaborateurs' },
        { name: 'payroll', description: 'Paie et rémunération' },
        { name: 'absences', description: 'Congés et absences' },
        { name: 'contracts', description: 'Contrats de travail' },
        { name: 'recruitment', description: 'Recrutement et candidatures' },
        { name: 'training', description: 'Formation et compétences' },
        { name: 'expenses', description: 'Notes de frais' },
        { name: 'careers', description: 'Carrière et évaluations' },
        { name: 'reporting', description: 'Tableaux de bord et KPIs' },
        { name: 'ai', description: 'Assistant IA et analyses' },
      ],
    },
  })

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'none',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
  })
}

export default fp(swaggerPlugin, { name: 'swagger' })
