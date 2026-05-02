import Fastify from 'fastify'
import fp from 'fastify-plugin/plugin.js'
import { config } from './config'
import { logger } from './utils/logger'
import { isAppError } from './utils/errors'
import { ensurePlatformSchema } from './db/ensure-platform'

// Plugins
import authPlugin from './plugins/auth'
import corsPlugin from './plugins/cors'
import multipartPlugin from './plugins/multipart'
import swaggerPlugin from './plugins/swagger'
import websocketPlugin from './plugins/websocket'
import tenantPlugin from './plugins/tenant'

// Routes
import authRoutes from './modules/auth/auth.routes'
import samlRoutes from './modules/auth/saml.routes'
import platformRoutes from './modules/platform/platform.routes'
import employeesRoutes from './modules/employees/employees.routes'
import payrollRoutes from './modules/payroll/payroll.routes'
import absencesRoutes from './modules/absences/absences.routes'
import recruitmentRoutes from './modules/recruitment/recruitment.routes'
import trainingRoutes from './modules/training/training.routes'
import expensesRoutes from './modules/expenses/expenses.routes'
import careersRoutes from './modules/careers/careers.routes'
import reportingRoutes from './modules/reporting/reporting.routes'
import aiRoutes from './modules/ai/ai.routes'
import contractsRoutes from './modules/contracts/contracts.routes'
import settingsRoutes from './modules/settings/settings.routes'
import webhooksRoutes from './modules/webhooks/webhooks.routes'

// ── Compteurs Prometheus in-memory ───────────────────────────────────────────
const metrics = {
  requestsTotal: new Map<string, number>(),
  requestDurationMs: new Map<string, number[]>(),
  errorsTotal: new Map<string, number>(),
  dbConnectionsActive: 0,
  startTime: Date.now(),
}

function incrementMetric(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export async function buildApp() {
  // ── Auto-migration : garantit que le schéma platform existe au démarrage ──
  try {
    await ensurePlatformSchema()
  } catch (err) {
    logger.error({ err }, 'Échec ensurePlatformSchema — arrêt')
    process.exit(1)
  }

  const app = Fastify({
    logger: {
      level: config.app.logLevel,
      transport:
        config.nodeEnv === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:dd/mm/yyyy HH:MM:ss',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
    trustProxy: true,
  })

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        message: error.message,
        details: error.details,
      })
    }

    if (error.validation) {
      return reply.status(422).send({
        statusCode: 422,
        error: 'Validation Error',
        message: 'Données invalides',
        details: error.validation,
      })
    }

    app.log.error({ err: error, url: request.url }, 'Unhandled error')
    return reply.status(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: config.nodeEnv === 'development' ? (error.message ?? 'Une erreur interne est survenue') : 'Une erreur interne est survenue',
      ...(config.nodeEnv === 'development' && { stack: error.stack }),
    })
  })

  // Register plugins
  await app.register(corsPlugin)
  await app.register(swaggerPlugin)
  await app.register(authPlugin)
  await app.register(tenantPlugin)
  await app.register(multipartPlugin)
  await app.register(websocketPlugin)

  // Register routes
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(samlRoutes, { prefix: '/auth/saml' })
  await app.register(platformRoutes, { prefix: '/platform' })
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.register(absencesRoutes, { prefix: '/absences' })
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.register(trainingRoutes, { prefix: '/training' })
  await app.register(expensesRoutes, { prefix: '/expenses' })
  await app.register(careersRoutes, { prefix: '/careers' })
  await app.register(reportingRoutes, { prefix: '/reporting' })
  await app.register(aiRoutes, { prefix: '/ai' })
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.register(webhooksRoutes, { prefix: '/webhooks' })

  // ── Hooks métriques ───────────────────────────────────────────────────────
  app.addHook('onRequest', async (request) => {
    ;(request as unknown as Record<string, number>)['_startTime'] = Date.now()
    const key = `${request.method} ${request.routerPath ?? request.url}`
    incrementMetric(metrics.requestsTotal, key)
  })

  app.addHook('onResponse', async (request, reply) => {
    const start = (request as unknown as Record<string, number>)['_startTime'] ?? Date.now()
    const duration = Date.now() - start
    const key = `${request.method} ${request.routerPath ?? request.url}`
    if (!metrics.requestDurationMs.has(key)) metrics.requestDurationMs.set(key, [])
    metrics.requestDurationMs.get(key)!.push(duration)
    if (reply.statusCode >= 400) incrementMetric(metrics.errorsTotal, key)
  })

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/health', {
    schema: { tags: ['system'], summary: 'Health check' },
    handler: async (_, reply) => {
      return reply.send({
        status: 'ok',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: Math.round((Date.now() - metrics.startTime) / 1000),
      })
    },
  })

  // ── Prometheus /metrics ────────────────────────────────────────────────────
  app.get('/metrics', {
    schema: { tags: ['system'], summary: 'Prometheus metrics' },
    handler: async (_, reply) => {
      const lines: string[] = []
      const uptimeSeconds = Math.round((Date.now() - metrics.startTime) / 1000)

      // HELP & TYPE
      lines.push('# HELP nexusrh_up Application is up (1 = up)')
      lines.push('# TYPE nexusrh_up gauge')
      lines.push('nexusrh_up 1')

      lines.push(`# HELP nexusrh_uptime_seconds Uptime in seconds`)
      lines.push('# TYPE nexusrh_uptime_seconds counter')
      lines.push(`nexusrh_uptime_seconds ${uptimeSeconds}`)

      lines.push('# HELP nexusrh_requests_total Total HTTP requests by route')
      lines.push('# TYPE nexusrh_requests_total counter')
      for (const [route, count] of metrics.requestsTotal) {
        const safeRoute = route.replace(/"/g, '\\"')
        lines.push(`nexusrh_requests_total{route="${safeRoute}"} ${count}`)
      }

      lines.push('# HELP nexusrh_request_duration_p99_ms P99 request duration by route (ms)')
      lines.push('# TYPE nexusrh_request_duration_p99_ms gauge')
      for (const [route, durations] of metrics.requestDurationMs) {
        if (durations.length === 0) continue
        const sorted = [...durations].sort((a, b) => a - b)
        const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1]!
        const safeRoute = route.replace(/"/g, '\\"')
        lines.push(`nexusrh_request_duration_p99_ms{route="${safeRoute}"} ${p99}`)
      }

      lines.push('# HELP nexusrh_errors_total Total HTTP errors (4xx + 5xx) by route')
      lines.push('# TYPE nexusrh_errors_total counter')
      for (const [route, count] of metrics.errorsTotal) {
        const safeRoute = route.replace(/"/g, '\\"')
        lines.push(`nexusrh_errors_total{route="${safeRoute}"} ${count}`)
      }

      lines.push('# HELP nexusrh_nodejs_heap_used_bytes Node.js heap used')
      lines.push('# TYPE nexusrh_nodejs_heap_used_bytes gauge')
      lines.push(`nexusrh_nodejs_heap_used_bytes ${process.memoryUsage().heapUsed}`)

      lines.push('# HELP nexusrh_nodejs_heap_total_bytes Node.js heap total')
      lines.push('# TYPE nexusrh_nodejs_heap_total_bytes gauge')
      lines.push(`nexusrh_nodejs_heap_total_bytes ${process.memoryUsage().heapTotal}`)

      reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      return reply.send(lines.join('\n') + '\n')
    },
  })

  return app
}
