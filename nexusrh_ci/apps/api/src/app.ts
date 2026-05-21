import Fastify from 'fastify'
import { Pool } from 'pg'
import { config } from './config.js'
import { maintenanceCache } from './cache.js'

// Cache TTL 30s pour le flag maintenance (évite une requête DB par request)
const maintenancePool = new Pool({ connectionString: config.database.url })

async function isMaintenanceModeActive(): Promise<boolean> {
  if (Date.now() < maintenanceCache.expiresAt) return maintenanceCache.value
  try {
    const res = await maintenancePool.query<{ maintenance_mode: boolean }>(
      `SELECT maintenance_mode FROM platform.platform_settings LIMIT 1`
    )
    const value = res.rows[0]?.maintenance_mode ?? false
    maintenanceCache.value = value
    maintenanceCache.expiresAt = Date.now() + 30_000
    return value
  } catch {
    return false
  }
}

// ── Plugins ───────────────────────────────────────────────────────────────────
import authPlugin    from './plugins/auth.js'
import corsPlugin    from './plugins/cors.js'
import swaggerPlugin from './plugins/swagger.js'

// ── Routes ────────────────────────────────────────────────────────────────────
import authRoutes       from './modules/auth/auth.routes.js'
import platformRoutes   from './modules/platform/platform.routes.js'
import legalWatchRoutes from './modules/platform/legal-watch.routes.js'
import employeesRoutes  from './modules/employees/employees.routes.js'
import absencesRoutes   from './modules/absences/absences.routes.js'
import payrollRoutes    from './modules/payroll/payroll.routes.js'
import payrollWorkflowRoutes from './modules/payroll/payroll-workflow.routes.js'
import cnpsRoutes       from './modules/cnps/cnps.routes.js'
import mobileMoneyRoutes  from './modules/mobile-money/mobile-money.routes.js'
import recruitmentRoutes  from './modules/recruitment/recruitment.routes.js'
import trainingRoutes     from './modules/training/training.routes.js'
import expensesRoutes     from './modules/expenses/expenses.routes.js'
import reportingRoutes    from './modules/reporting/reporting.routes.js'
import careersRoutes      from './modules/careers/careers.routes.js'
import settingsRoutes     from './modules/settings/settings.routes.js'
import contractsRoutes    from './modules/contracts/contracts.routes.js'
import aiRoutes           from './modules/ai/ai.routes.js'
import { referentielsRoutes } from './modules/referentiels/referentiels.routes.js'

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.env === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
    trustProxy: true,
  })

  // ── Plugins globaux ──────────────────────────────────────────────────────────
  await fastify.register(corsPlugin)
  await fastify.register(swaggerPlugin)
  await fastify.register(authPlugin)

  // ── Rate limiting (OWASP A07 — Brute-force protection) ───────────────────────
  await fastify.register(import('@fastify/rate-limit'), {
    global:     true,
    max:        200,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Trop de requêtes. Veuillez patienter.',
    }),
  })

  // ── Security headers (OWASP A05 — Security Misconfiguration) ─────────────────
  // CSP strict pour l'API (JSON only) ; CSP permissive pour /docs (Swagger UI
  // qui charge HTML/JS inline). Réponses sensibles (PDF/CSV bulletins, exports
  // CNPS) : Cache-Control: no-store pour éviter la fuite via cache navigateur
  // partagé sur poste RH (multi-utilisateur).
  const API_CSP  = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  const DOCS_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  const SENSITIVE_CONTENT_TYPES = /^(application\/pdf|text\/csv|application\/xml)/i

  fastify.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options',  'nosniff')
    reply.header('X-Frame-Options',          'DENY')
    reply.header('X-XSS-Protection',         '0')
    reply.header('Strict-Transport-Security','max-age=31536000; includeSubDomains; preload')
    reply.header('Referrer-Policy',          'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy',       'geolocation=(), microphone=(), camera=()')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    reply.header('Cross-Origin-Opener-Policy',   'same-origin')

    // CSP différencié selon la route (Swagger UI a besoin d'inline scripts)
    const url = req.raw.url ?? ''
    if (url.startsWith('/docs')) {
      reply.header('Content-Security-Policy', DOCS_CSP)
    } else {
      reply.header('Content-Security-Policy', API_CSP)
    }

    // Cache-Control no-store sur réponses contenant des données RH sensibles
    // (bulletins PDF, exports DISA/CNPS CSV, déclarations XML). Évite que le
    // bulletin d'un salarié reste accessible dans le cache après logout sur
    // un poste partagé.
    const ct = String(reply.getHeader('content-type') ?? '')
    if (SENSITIVE_CONTENT_TYPES.test(ct)) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
      reply.header('Pragma',         'no-cache')
    }
  })

  // ── Multipart (upload fichiers) ──────────────────────────────────────────────
  await fastify.register(import('@fastify/multipart'), {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  })

  // ── Middleware maintenance : bloque tous les accès tenant sauf super_admin ───
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url
    // Toujours autorisés : health, auth, /platform/* (super_admin)
    if (
      url === '/health' ||
      url.startsWith('/auth/') ||
      url.startsWith('/platform/')
    ) return

    const inMaintenance = await isMaintenanceModeActive()
    if (!inMaintenance) return

    // Laisser passer les super_admin authentifiés
    try {
      await request.jwtVerify()
      if ((request.user as { role?: string })?.role === 'super_admin') return
    } catch { /* non authentifié → bloquer aussi */ }

    return reply.status(503).send({
      error: 'Service en maintenance. Veuillez réessayer ultérieurement.',
      statusCode: 503,
      maintenance: true,
    })
  })

  // ── Health check ─────────────────────────────────────────────────────────────
  fastify.get('/health', {
    schema: { hide: true },
    handler: async () => ({
      status: 'ok',
      version: '1.0.0',
      service: 'nexusrh-ci-api',
      timestamp: new Date().toISOString(),
    }),
  })

  // ── Routes applicatives ───────────────────────────────────────────────────────
  await fastify.register(authRoutes,         { prefix: '/auth' })
  await fastify.register(platformRoutes,     { prefix: '/platform' })
  await fastify.register(legalWatchRoutes,   { prefix: '/platform/legal-watch' })
  await fastify.register(employeesRoutes,    { prefix: '/employees' })
  await fastify.register(absencesRoutes,     { prefix: '/absences' })
  await fastify.register(payrollRoutes,      { prefix: '/payroll' })
  await fastify.register(payrollWorkflowRoutes, { prefix: '/payroll-workflow' })
  await fastify.register(cnpsRoutes,         { prefix: '/cnps' })
  await fastify.register(mobileMoneyRoutes,  { prefix: '/mobile-money' })
  await fastify.register(recruitmentRoutes, { prefix: '/recruitment' })
  await fastify.register(trainingRoutes,    { prefix: '/training' })
  await fastify.register(expensesRoutes,    { prefix: '/expenses' })
  await fastify.register(reportingRoutes,   { prefix: '/reporting' })
  await fastify.register(careersRoutes,     { prefix: '/careers' })
  await fastify.register(settingsRoutes,    { prefix: '/settings' })
  await fastify.register(contractsRoutes,   { prefix: '/contracts' })
  await fastify.register(aiRoutes,          { prefix: '/ai' })
  await fastify.register(referentielsRoutes, { prefix: '/referentiels' })

  // ── 404 handler ───────────────────────────────────────────────────────────────
  fastify.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: 'Route introuvable', statusCode: 404 })
  })

  // ── Error handler ─────────────────────────────────────────────────────────────
  // OWASP A05 : pas de stack trace exposée en production.
  // OWASP A09 : log complet côté serveur pour audit.
  fastify.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode ?? 500
    fastify.log.error({ err: error, statusCode }, error.message)

    // ZodError (validation body/params) → 400 avec issues exploitables
    if (error.name === 'ZodError' && 'issues' in error) {
      const issues = (error as unknown as { issues: Array<{ path: (string|number)[]; message: string }> }).issues
      return reply.status(400).send({
        error: 'Validation échouée',
        issues: issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        statusCode: 400,
      })
    }

    // Erreurs PostgreSQL fréquentes — mapping vers codes HTTP appropriés
    const pgCode = (error as unknown as { code?: string }).code
    if (pgCode === '23505') {
      // unique_violation
      return reply.status(409).send({ error: 'Conflit — ressource déjà existante', statusCode: 409 })
    }
    if (pgCode === '23503') {
      // foreign_key_violation
      return reply.status(422).send({ error: 'Référence invalide (FK)', statusCode: 422 })
    }
    if (pgCode === '23502') {
      // not_null_violation
      return reply.status(400).send({ error: 'Champ requis manquant', statusCode: 400 })
    }
    if (pgCode === '22P02') {
      // invalid_text_representation (ex: cast UUID invalide)
      return reply.status(400).send({ error: 'Format de donnée invalide', statusCode: 400 })
    }
    if (pgCode === '42P01' || pgCode === '42703') {
      // undefined_table / undefined_column — bug serveur, masquer en prod
      return reply.status(500).send({
        error: config.env === 'production' ? 'Erreur interne du serveur' : `Schema DB: ${error.message}`,
        statusCode: 500,
      })
    }

    if (statusCode === 401) {
      return reply.status(401).send({ error: 'Non authentifié', statusCode: 401 })
    }
    if (statusCode === 403) {
      return reply.status(403).send({ error: 'Accès interdit', statusCode: 403 })
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: error.message, statusCode })
    }

    return reply.status(500).send({
      error: config.env === 'production' ? 'Erreur interne du serveur' : error.message,
      statusCode: 500,
    })
  })

  return fastify
}
