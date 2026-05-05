import fp from 'fastify-plugin'
import fastifyCors from '@fastify/cors'
import { config } from '../config.js'

const DEV_ORIGINS = ['http://localhost:3001', 'http://localhost:3000']

function buildAllowedOrigins(): string[] {
  if (config.env === 'development') return DEV_ORIGINS
  const origins = new Set<string>()
  // APP_URL depuis l'env (peut être http ou https)
  if (config.appUrl) {
    origins.add(config.appUrl)
    // Toujours ajouter la variante https si l'URL est http
    origins.add(config.appUrl.replace(/^http:\/\//, 'https://'))
  }
  // Fallback hardcodé sur le domaine de production connu
  origins.add('https://nexusrh.openlabconsulting.com')
  // Inclure aussi localhost pour les tests en staging
  DEV_ORIGINS.forEach(o => origins.add(o))
  return [...origins]
}

export default fp(async (fastify) => {
  await fastify.register(fastifyCors, {
    origin: buildAllowedOrigins(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
})
