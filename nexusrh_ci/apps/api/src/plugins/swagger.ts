import fp from 'fastify-plugin'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'

export default fp(async (fastify) => {
  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'NexusRH CI — API',
        description: 'SIRH SaaS Multi-Tenant · Côte d\'Ivoire · OpenLab Consulting',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'auth',         description: 'Authentification' },
        { name: 'platform',     description: 'Portail super_admin' },
        { name: 'employees',    description: 'Gestion des employés CI' },
        { name: 'payroll',      description: 'Paie CNPS + ITS' },
        { name: 'absences',     description: 'Absences & congés CI' },
        { name: 'expenses',     description: 'Notes de frais' },
        { name: 'cnps',         description: 'Déclarations CNPS & DISA' },
        { name: 'mobile-money', description: 'Paiements Mobile Money' },
        { name: 'recruitment',  description: 'Recrutement ATS' },
        { name: 'training',     description: 'Formation FDFP' },
        { name: 'careers',      description: 'Carrières & compétences' },
        { name: 'ai',           description: 'Assistant IA CI' },
        { name: 'reporting',    description: 'Reporting & KPIs FCFA' },
      ],
    },
  })

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { deepLinking: true, displayRequestDuration: true },
  })
})
